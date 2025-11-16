require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // v2 compatible
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // serves index.html, book.jpg, and public/pdf/...
app.use('/pdf', express.static(path.join(__dirname, 'public', 'pdf'))); // serve pdfs from public/pdf

// ---------- Firebase Admin ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Paystack config
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

// EmailJS config (server will call EmailJS REST API)
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_USER_ID = process.env.EMAILJS_USER_ID; // public/user id

// PDF file config (ensure this file exists at public/pdf/THE_ULTIMATE_QUOTE_BUNDLE.pdf)
const PDF_FILENAME = 'THE_ULTIMATE_QUOTE_BUNDLE.pdf';
const PDF_PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`) + `/pdf/${encodeURIComponent(PDF_FILENAME)}`;

// Helper to convert to kobo/cents
function toSmallestUnit(amount) {
  // amount is in USD => Paystack expects *100 (kobo) when currency is NGN; for USD Paystack expects amount in cents but Paystack may require account to accept USD.
  // We'll just multiply by 100 to send cents.
  return Math.round(Number(amount) * 100);
}

// ---------- 1) Initialize Payment ----------
app.post('/api/pay', async (req, res) => {
  const { email, amount, productId } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'Email and amount required' });
  if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server misconfiguration: missing Paystack secret key' });

  try {
    // initialize with Paystack
    const initializeResponse = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: toSmallestUnit(amount),
        metadata: { productId, emailEntered: email },
        // callback_url optional; leave to Paystack dashboard/webhook if you use webhooks
        callback_url: `${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/`
      })
    });

    const data = await initializeResponse.json();
    if (!data || !data.status) {
      console.error('Paystack init failed', data);
      return res.status(500).json({ error: 'Paystack init failed', data });
    }

    // Save initial transaction in 'transactions' (as before)
    const ref = data.data.reference;
    await db.collection('transactions').doc(ref).set({
      reference: ref,
      email,
      amount,
      status: 'initialized',
      productId: productId || null,
      createdAt: admin.firestore.Timestamp.now()
    });

    // Also create a record in 'my_order' collection to track the order lifecycle (important per your request)
    await db.collection('my_order').doc(ref).set({
      reference: ref,
      emailEntered: email,
      productId: productId || null,
      amount,
      status: 'initialized',
      createdAt: admin.firestore.Timestamp.now()
    });

    res.json({ authorization_url: data.data.authorization_url, reference: ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 2) Verify Payment ----------
app.post('/api/verify', async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Reference required' });
  if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server misconfiguration: missing Paystack secret key' });

  try {
    const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const data = await response.json();

    if (data && data.status && data.data && data.data.status === 'success') {
      const customerEmail = (data.data.customer && data.data.customer.email) || null;
      const amount = (data.data.amount || 0) / 100;

      // Update transactions collection
      await db.collection('transactions').doc(reference).set({
        reference,
        email: customerEmail,
        amount,
        status: 'success',
        paidAt: admin.firestore.Timestamp.now(),
        paystack: {
          gateway_response: data.data.gateway_response,
          channel: data.data.channel,
          authorization: data.data.authorization || null
        }
      }, { merge: true });

      // Update my_order collection (merge)
      const myOrderRef = db.collection('my_order').doc(reference);
      const myOrderSnap = await myOrderRef.get();
      let orderDoc = {};
      if (myOrderSnap.exists) {
        orderDoc = myOrderSnap.data();
      }
      // prefer the originally-entered email stored in my_order (emailEntered). If missing, use Paystack customer email
      const emailToSend = orderDoc.emailEntered || customerEmail;

      await myOrderRef.set({
        reference,
        emailEntered: emailToSend,
        amount,
        status: 'success',
        paidAt: admin.firestore.Timestamp.now(),
        paystack: {
          id: data.data.id,
          reference: data.data.reference,
        }
      }, { merge: true });

      // ---------- Send PDF via EmailJS (server-side) ----------
      // EmailJS REST endpoint expects service_id, template_id, user_id and template_params
      // The template should be configured to accept parameters like to_email and pdf_link (or similar).
      if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_USER_ID) {
        console.warn('EmailJS not configured; skipping email send. Set EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID and EMAILJS_USER_ID in env to enable.');
      } else {
        try {
          const emailPayload = {
            service_id: EMAILJS_SERVICE_ID,
            template_id: EMAILJS_TEMPLATE_ID,
            user_id: EMAILJS_USER_ID,
            template_params: {
              to_email: emailToSend,
              to_name: emailToSend.split('@')[0] || 'Customer',
              product_name: 'The Ultimate Quote Bundle',
              pdf_link: PDF_PUBLIC_URL
            }
          };

          const emailResp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailPayload)
          });

          if (!emailResp.ok) {
            const txt = await emailResp.text();
            console.error('EmailJS send failed:', emailResp.status, txt);
            // we don't fail the whole verification because of email send failure; but update my_order with a flag
            await myOrderRef.set({ emailSent: false, emailSendError: txt }, { merge: true });
          } else {
            await myOrderRef.set({ emailSent: true, emailSentAt: admin.firestore.Timestamp.now() }, { merge: true });
          }
        } catch (emErr) {
          console.error('Error sending email via EmailJS:', emErr);
          await myOrderRef.set({ emailSent: false, emailSendError: String(emErr) }, { merge: true });
        }
      }

      // Respond success to client
      res.json({ status: 'success' });
    } else {
      console.warn('Payment not successful or not verified', data);
      res.status(400).json({ status: 'failed', data });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 3) Transactions listing ----------
app.get('/api/transactions', async (req, res) => {
  try {
    const snap = await db.collection('transactions').orderBy('createdAt', 'desc').limit(50).get();
    const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(transactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
