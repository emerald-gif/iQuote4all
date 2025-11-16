// server.js
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
app.use(express.static('public'));

// Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Paystack config
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = process.env.PAYSTACK_BASE || 'https://api.paystack.co';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

// EmailJS config (we'll call EmailJS REST API server-side)
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY; // used as user_id in some flows

// PDF settings
const PDF_FILE_PATH = process.env.PDF_FILE_PATH || 'files/THE ULTIMATE QUOTE BUNDLE..pdf';
const PUBLIC_PDF_URL = `${PUBLIC_URL}/${PDF_FILE_PATH}`;

// Helper convert to kobo/cents
function toSmallestUnit(amount) {
  return Math.round(Number(amount) * 100);
}

// Utility: Save a transaction (initialized)
async function saveTransactionInit(reference, email, amount, metadata = {}) {
  await db.collection('transactions').doc(reference).set({
    reference,
    email,
    amount,
    status: 'initialized',
    metadata,
    createdAt: admin.firestore.Timestamp.now()
  });
}

// Utility: Save to 'my order' collection after success
async function saveOrder(record) {
  // record: { reference, email, amount, paidAt, paystackData, productId }
  await db.collection('my order').add({
    ...record,
    createdAt: admin.firestore.Timestamp.now()
  });
}

// 1️⃣ Initialize Payment
app.post('/api/pay', async (req, res) => {
  const { email, amount, productId } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'Email and amount required' });

  try {
    const bodyPayload = {
      email,
      amount: toSmallestUnit(amount),
      metadata: { productId },
      callback_url: `${PUBLIC_URL}/` // Paystack will redirect here after payment if redirect used
    };

    const initializeResponse = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyPayload)
    });

    const data = await initializeResponse.json();
    if (!data.status) return res.status(500).json({ error: 'Paystack init failed', data });

    // Save initial transaction
    await saveTransactionInit(data.data.reference, email, amount, { productId });

    res.json({ authorization_url: data.data.authorization_url, reference: data.data.reference, access_code: data.data.access_code });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2️⃣ Verify Payment & record to 'my order' and send email (server verifies Paystack & sends mail)
app.post('/api/verify', async (req, res) => {
  const { reference, purchaserEmail } = req.body;
  if (!reference) return res.status(400).json({ error: 'Reference required' });

  try {
    const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      const payData = data.data;
      const savedData = {
        reference,
        email: purchaserEmail || payData.customer?.email || null,
        amount: payData.amount / 100,
        status: 'success',
        paidAt: admin.firestore.Timestamp.now(),
        paystack: payData
      };

      // Update transactions doc
      await db.collection('transactions').doc(reference).set({
        reference,
        email: savedData.email,
        amount: savedData.amount,
        status: 'success',
        paidAt: admin.firestore.Timestamp.now()
      }, { merge: true });

      // Save to 'my order' collection
      await saveOrder({
        reference,
        email: savedData.email,
        amount: savedData.amount,
        paidAt: admin.firestore.Timestamp.now(),
        productId: payData.metadata?.productId || 'ultimate-quote-bundle'
      });

      // Send email via EmailJS REST API with link to the PDF (server-side)
      if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY) {
        const emailPayload = {
          service_id: EMAILJS_SERVICE_ID,
          template_id: EMAILJS_TEMPLATE_ID,
          user_id: EMAILJS_PUBLIC_KEY,
          template_params: {
            to_email: savedData.email,
            book_name: 'THE ULTIMATE QUOTE BUNDLE',
            download_link: PUBLIC_PDF_URL,
            reference: reference
          }
        };

        const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload)
        });

        // emailjs returns 200 on success
        if (!emailRes.ok) {
          console.warn('EmailJS returned non-OK', await emailRes.text());
          // don't fail the whole flow if email fails; still return success to client
        }
      } else {
        console.warn('EmailJS env vars not configured; skipping automatic email send.');
      }

      return res.json({ status: 'success' });
    } else {
      return res.json({ status: 'failed', data });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3️⃣ List Transactions (last 50)
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

// Serve fallback to index.html for SPA behavior
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
