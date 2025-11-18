// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ---------- Firebase Admin init ----------
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

// ---------- Config (from env) ----------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || null;
const PAYSTACK_BASE = 'https://api.paystack.co';

const USD_PRICE = Number(process.env.USD_PRICE || '15.99');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PDF_FILE_PATH = (process.env.PDF_FILE_PATH || 'files/THE ULTIMATE QUOTE BUNDLE.pdf').replace(/^\//, '');
const PUBLIC_PDF_URL = PUBLIC_URL ? `${PUBLIC_URL}/${PDF_FILE_PATH}` : `/${PDF_FILE_PATH}`;

// EmailJS public bits (these are safe to expose client-side)
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || null;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || null;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || null;

// Helper: convert to kobo
function toKobo(amount) {
  return Math.round(Number(amount) * 100);
}

// Best-effort: get fx merchant_rate from Paystack initialize response (non-fatal)
async function getExchangeRateFromPaystack() {
  if (!PAYSTACK_SECRET_KEY) return Number(process.env.FX_FALLBACK || 1500);
  try {
    const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: 'fx-check@example.com',
        amount: 100,
        currency: 'NGN'
      })
    });
    const j = await res.json();
    const rate = j?.data?.fees_breakdown?.[0]?.fx?.merchant_rate;
    if (rate && !Number.isNaN(Number(rate))) return Number(rate);
  } catch (e) {
    console.warn('FX fetch error (ignored):', e.message || e);
  }
  return Number(process.env.FX_FALLBACK || 1500);
}

// ---------- /config - public info for client ----------
app.get('/config', (req, res) => {
  res.json({
    paystackPublicKey: PAYSTACK_PUBLIC_KEY || null,
    publicPdfUrl: PUBLIC_PDF_URL || null,
    usdPrice: USD_PRICE,
    emailjs: {
      publicKey: EMAILJS_PUBLIC_KEY || null,
      serviceId: EMAILJS_SERVICE_ID || null,
      templateId: EMAILJS_TEMPLATE_ID || null
    }
  });
});

// ---------- /api/pay - initialize Paystack transaction ----------
app.post('/api/pay', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server misconfigured: missing Paystack secret key' });

    const fxRate = await getExchangeRateFromPaystack();
    const ngnAmount = Math.round(USD_PRICE * fxRate);

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

    // Save an "initialized" transaction doc (non-fatal)
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
      console.warn('Failed to write init transaction (ignored):', e.message || e);
    }

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

// ---------- /api/verify - verify Paystack payment and save to Firestore ----------
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

    // Save to "my order"
    await db.collection('my order').add(record);

    // Update transactions doc (merge)
    await db.collection('transactions').doc(tx.reference).set({
      reference: tx.reference,
      email: userEmail,
      amount: ngnAmountPaid,
      status: 'success',
      paidAt: admin.firestore.Timestamp.now()
    }, { merge: true });

    // Return full useful info to client -> client will send EmailJS
    return res.json({
      status: 'success',
      data: {
        reference: tx.reference,
        email: userEmail,
        amount: ngnAmountPaid,
        currency: tx.currency,
        download_link: PUBLIC_PDF_URL,
        book_name: 'THE ULTIMATE QUOTE BUNDLE',
        emailjs: {
          publicKey: EMAILJS_PUBLIC_KEY || null,
          serviceId: EMAILJS_SERVICE_ID || null,
          templateId: EMAILJS_TEMPLATE_ID || null
        }
      }
    });

  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- Transactions listing ----------
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

// ---------- SPA fallback + start ----------
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT} (PUBLIC_URL=${PUBLIC_URL})`));
