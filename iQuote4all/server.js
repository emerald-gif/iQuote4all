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
  console.error('Firebase init error:', err);
  process.exit(1);
}
const db = admin.firestore();

// Config (from env)
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || null; // safe to expose
const PAYSTACK_BASE = 'https://api.paystack.co';

const USD_PRICE = Number(process.env.USD_PRICE || '15.99');

const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PDF_FILE_PATH = process.env.PDF_FILE_PATH || 'files/THE ULTIMATE QUOTE BUNDLE.pdf';
const PUBLIC_PDF_URL = `${PUBLIC_URL.replace(/\/$/, '')}/${PDF_FILE_PATH.replace(/^\//, '')}`;

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || null;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || null;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || null;

// Helper: convert to kobo
function toKobo(amount) {
  return Math.round(Number(amount) * 100);
}

// Best-effort: try extracting merchant FX rate from a tiny Paystack initialize call
async function getExchangeRateFromPaystack() {
  if (!PAYSTACK_SECRET_KEY) return Number(process.env.FX_FALLBACK || 1500);
  try {
    // small init to get fx info — harmless and quick
    const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: 'fx-check@example.com',
        amount: 100, // kobo
        currency: 'NGN'
      })
    });
    const j = await res.json();
    const rate = j?.data?.fees_breakdown?.[0]?.fx?.merchant_rate;
    if (rate && !Number.isNaN(Number(rate))) return Number(rate);
  } catch (e) {
    console.warn('FX fetch error:', e.message || e);
  }
  return Number(process.env.FX_FALLBACK || 1500);
}

// Public config route for client to fetch public key & pdf url
app.get('/config', (req, res) => {
  return res.json({
    paystackPublicKey: PAYSTACK_PUBLIC_KEY || null,
    publicPdfUrl: PUBLIC_PDF_URL || null,
    usdPrice: USD_PRICE
  });
});

// 1) Initialize payment: server calculates NGN amount (from USD_PRICE) and initializes Paystack
app.post('/api/pay', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server misconfigured: missing Paystack secret key' });

    // get FX rate and compute NGN amount (integer)
    const fxRate = await getExchangeRateFromPaystack();
    const ngnAmount = Math.round(USD_PRICE * fxRate); // integer NGN

    // Initialize Paystack transaction
    const initResp = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: toKobo(ngnAmount), // kobo
        currency: 'NGN',
        metadata: {
          productId: 'ultimate-quote-bundle',
          usd_price: USD_PRICE,
          fx_rate: fxRate,
          ngn_charged: ngnAmount
        }
      })
    });

    const initJson = await initResp.json();

    if (!initJson || initJson.status === false) {
      const msg = initJson?.message || 'Paystack initialize failed';
      return res.status(400).json({ error: msg, details: initJson });
    }

    // Save initial transaction doc (non-fatal)
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
      console.warn('Failed to write init transaction:', e.message || e);
    }

    return res.json({
      authorization_url: initJson.data.authorization_url,
      reference: initJson.data.reference,
      amount: ngnAmount // integer NGN (client can use)
    });
  } catch (err) {
    console.error('Init payment error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2) Verify payment: server verifies with Paystack and saves to Firestore + sends email via EmailJS (if configured)
app.post('/api/verify', async (req, res) => {
  try {
    const { reference, purchaserEmail } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server misconfigured: missing Paystack secret key' });

    const verifyResp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const verifyJson = await verifyResp.json();

    if (!verifyJson || verifyJson.status !== true) {
      return res.json({ status: 'failed', data: verifyJson });
    }

    const tx = verifyJson.data;
    if (tx.status !== 'success') return res.json({ status: 'failed', data: verifyJson });

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

    // Save order
    await db.collection('my order').add(record);

    // Update transactions document (merge)
    await db.collection('transactions').doc(tx.reference).set({
      reference: tx.reference,
      email: userEmail,
      amount: ngnAmountPaid,
      status: 'success',
      paidAt: admin.firestore.Timestamp.now()
    }, { merge: true });

    // Send email via EmailJS REST (if configured)
// ---------- REPLACE existing EmailJS send block with this (paste into /api/verify) ----------
if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY && userEmail) {
  try {
    const emailPayload = {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      public_key: EMAILJS_PUBLIC_KEY,          // correct field name for REST call
      template_params: {
        to_email: userEmail,
        book_name: 'THE ULTIMATE QUOTE BUNDLE',
        download_link: PUBLIC_PDF_URL,
        reference: tx.reference
      }
    };

    // DEBUG: log the payload before sending (safe — it does not include your secret)
    console.log('📨 EmailJS payload:', JSON.stringify(emailPayload, null, 2));

    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });

    const text = await emailRes.text().catch(() => null);
    console.log('📬 EmailJS status:', emailRes.status, 'body:', text);

    if (!emailRes.ok) {
      // EmailJS returned non-200: log and include their response for debugging
      console.error('❌ EmailJS error response:', {
        status: emailRes.status,
        body: text
      });
      // Optional: forward the EmailJS error to the client (for testing only)
      // return res.status(502).json({ error: 'EmailJS error', details: text });
    } else {
      console.log('✅ EmailJS send OK ->', userEmail);
    }
  } catch (e) {
    console.error('❌ EmailJS send failed (exception):', e && e.message ? e.message : e);
  }
} else {
  console.warn('⚠️ EmailJS not configured or no purchaser email; skipping email send. Values:',
    { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, userEmail });
}

// Transactions listing
app.get('/api/transactions', async (req, res) => {
  try {
    const snap = await db.collection('transactions').orderBy('createdAt', 'desc').limit(50).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json(rows);
  } catch (e) {
    console.error('Fetch transactions error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT} (PUBLIC_URL=${PUBLIC_URL})`));
