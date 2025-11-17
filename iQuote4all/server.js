// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Firebase Admin init
let serviceAccount = {};
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (err) {
  console.error("Firebase init error:", err);
  process.exit(1);
}

const db = admin.firestore();

// Paystack config
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";

// Price config
const USD_PRICE = 15.99;

// Public URLs & PDF
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PDF_FILE_PATH = process.env.PDF_FILE_PATH || "files/THE ULTIMATE QUOTE BUNDLE.pdf";
const PUBLIC_PDF_URL = `${PUBLIC_URL}/${PDF_FILE_PATH.replace(/^\//, '')}`;

// EmailJS (optional)
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;

// Helper: convert to smallest unit (kobo)
function toKobo(amount) {
  return Math.round(Number(amount) * 100);
}

// Get FX merchant_rate from Paystack init response (best-effort)
async function getExchangeRateFallback() {
  // If Paystack returns an fx rate via /transaction/initialize when currency=NGN,
  // we can reuse that response. We'll perform a small init request and try to extract.
  try {
    const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: 'fx_check@example.com',
        amount: 100, // minor amount (kobo)
        currency: 'NGN'
      })
    });
    const json = await res.json();
    // path: json.data.fees_breakdown[0].fx.merchant_rate (if available)
    const rate = json?.data?.fees_breakdown?.[0]?.fx?.merchant_rate;
    if (rate && !Number.isNaN(Number(rate))) return Number(rate);
  } catch (e) {
    console.warn('FX check failed:', e.message || e);
  }
  // fallback if not available
  return 1500; // sensible default NGN/USD rate (replace if you want a different default)
}

// 1) Initialize payment — server calculates NGN amount and returns reference + amount
app.post('/api/pay', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: 'Server misconfigured: missing Paystack secret key' });
    }

    // Get FX rate (best-effort). If this fails we use fallback.
    const fxRate = await getExchangeRateFallback(); // NGN per USD
    const ngnAmount = Math.round(USD_PRICE * fxRate); // integer NGN

    // Initialize Paystack payment (NGN)
    const initResp = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: toKobo(ngnAmount), // in kobo
        currency: 'NGN',
        metadata: {
          productId: 'ultimate-quote-bundle',
          usd_price: USD_PRICE,
          fx_rate: fxRate,
          ngn_charged: ngnAmount
        },
        // optional: callback_url: `${PUBLIC_URL}/`   // Paystack redirect (we use inline)
      })
    });

    const initJson = await initResp.json();
    if (!initJson || initJson.status === false) {
      const msg = initJson?.message || 'Failed to initialize Paystack payment';
      return res.status(400).json({ error: msg, details: initJson });
    }

    // Save initial transaction document (optional)
    try {
      await db.collection('transactions').doc(initJson.data.reference).set({
        reference: initJson.data.reference,
        email,
        amount: ngnAmount,
        status: 'initialized',
        metadata: initJson.data.metadata || {},
        createdAt: admin.firestore.Timestamp.now()
      });
    } catch (e) {
      console.warn('Failed to write initial transaction to Firestore:', e.message || e);
      // don't fail the flow if saving initial transaction fails
    }

    // Return necessary values to client
    return res.json({
      authorization_url: initJson.data.authorization_url,
      reference: initJson.data.reference,
      amount: ngnAmount // integer NGN
    });

  } catch (err) {
    console.error('Init payment error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2) Verify payment after client callback (server-side verification & record)
app.post('/api/verify', async (req, res) => {
  try {
    const { reference, purchaserEmail } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: 'Server misconfigured: missing Paystack secret key' });
    }

    const verifyResp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const verifyJson = await verifyResp.json();

    if (!verifyJson || verifyJson.status !== true) {
      return res.json({ status: 'failed', data: verifyJson });
    }

    const tx = verifyJson.data;

    if (tx.status !== 'success') {
      // Not paid
      return res.json({ status: 'failed', data: verifyJson });
    }

    const userEmail = purchaserEmail || tx.customer?.email || null;
    const ngnAmountPaid = (tx.amount || 0) / 100;

    const record = {
      reference: tx.reference,
      email: userEmail,
      status: 'success',
      usd_price: tx.metadata?.usd_price || USD_PRICE,
      ngn_amount: ngnAmountPaid,
      fx_rate: tx.metadata?.fx_rate || null,
      paystack: tx,
      paidAt: admin.firestore.Timestamp.now()
    };

    // Save to "my order"
    await db.collection('my order').add(record);

    // Update transactions doc
    await db.collection('transactions').doc(tx.reference).set({
      reference: tx.reference,
      email: userEmail,
      amount: ngnAmountPaid,
      status: 'success',
      paidAt: admin.firestore.Timestamp.now()
    }, { merge: true });

    // Send email (optional)
    if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY && userEmail) {
      try {
        await fetch('https://api.emailjs.com/api/v1.0/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_id: EMAILJS_SERVICE_ID,
            template_id: EMAILJS_TEMPLATE_ID,
            user_id: EMAILJS_PUBLIC_KEY,
            template_params: {
              to_email: userEmail,
              book_name: 'THE ULTIMATE QUOTE BUNDLE',
              download_link: PUBLIC_PDF_URL,
              reference: tx.reference
            }
          })
        });
      } catch (e) {
        console.warn('EmailJS send failed:', e.message || e);
      }
    } else {
      // EmailJS not configured or no purchaser email — skip
    }

    return res.json({ status: 'success' });

  } catch (err) {
    console.error('Verify payment error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Transactions listing (optional)
app.get('/api/transactions', async (req, res) => {
  try {
    const snap = await db.collection('transactions').orderBy('createdAt', 'desc').limit(50).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json(rows);
  } catch (e) {
    console.error('Failed fetching transactions:', e);
    return res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
