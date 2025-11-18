// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // v2
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ---------- Firebase Admin init (optional but kept) ----------
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('Firebase admin initialized');
} catch (err) {
  console.warn('Firebase init skipped or failed - FIREBASE_SERVICE_ACCOUNT_JSON missing/invalid. Firestore writes will be skipped. Error:', err.message || err);
}

// ---------- Config ----------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || null;
const PAYSTACK_BASE = 'https://api.paystack.co';
const USD_PRICE = Number(process.env.USD_PRICE || '15.99');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PDF_FILE_PATH = (process.env.PDF_FILE_PATH || 'files/THE ULTIMATE QUOTE BUNDLE.pdf').replace(/^\//, '');
const PUBLIC_PDF_URL = PUBLIC_URL ? `${PUBLIC_URL}/${PDF_FILE_PATH}` : `/${PDF_FILE_PATH}`;

// ---------- SMTP / nodemailer setup ----------
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = (process.env.SMTP_SECURE ?? 'true') === 'true'; // true for 465; false for 587
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // some providers need TLS/STARTTLS on port 587
    tls: { rejectUnauthorized: false }
  });
  transporter.verify().then(() => {
    console.log('SMTP transporter verified');
  }).catch(err => {
    console.warn('SMTP transporter verify failed:', err && err.message ? err.message : err);
  });
} else {
  console.warn('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT, SMTP_SECURE in env.');
}

// ---------- Helpers ----------
function toKobo(amount) { return Math.round(Number(amount) * 100); }

async function getExchangeRateFromPaystack() {
  if (!PAYSTACK_SECRET_KEY) return Number(process.env.FX_FALLBACK || 1500);
  try {
    const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fx-check@example.com', amount: 100, currency: 'NGN' })
    });
    const j = await res.json();
    const rate = j?.data?.fees_breakdown?.[0]?.fx?.merchant_rate;
    if (rate && !Number.isNaN(Number(rate))) return Number(rate);
  } catch (e) {
    console.warn('FX check failed (ignored):', e && e.message ? e.message : e);
  }
  return Number(process.env.FX_FALLBACK || 1500);
}

async function sendReceiptEmail(toEmail, reference, downloadLink, bookName = 'THE ULTIMATE QUOTE BUNDLE') {
  if (!transporter) throw new Error('SMTP transporter not configured');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111">
      <div style="max-width:680px;margin:20px auto;background:#fff;padding:20px;border-radius:8px">
        <h2 style="margin:0 0 8px">iQuote4all — Order confirmation</h2>
        <p>Thanks for purchasing <strong>${bookName}</strong>. Your payment was successful.</p>
        <p><a href="${downloadLink}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Download your eBook</a></p>
        <div style="margin-top:12px;padding:12px;background:#f1f5f9;border-radius:6px">
          <div><strong>Order Reference:</strong> ${reference}</div>
          <div style="margin-top:6px"><strong>Delivered to:</strong> ${toEmail}</div>
        </div>
        <p style="color:#666">If you have trouble, reply to this email.</p>
      </div>
    </div>
  `;
  const msg = {
    from: `"iQuote4all" <${SMTP_USER}>`,
    to: toEmail,
    subject: `Your iQuote4all order — ${reference}`,
    html
  };
  return transporter.sendMail(msg);
}

// ---------- /config endpoint ----------
app.get('/config', (req, res) => {
  res.json({
    paystackPublicKey: PAYSTACK_PUBLIC_KEY || null,
    publicPdfUrl: PUBLIC_PDF_URL || null,
    usdPrice: USD_PRICE
  });
});

// ---------- /api/pay - initialize Paystack transaction ----------
app.post('/api/pay', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server missing Paystack secret key' });

    const fxRate = await getExchangeRateFromPaystack();
    const ngnAmount = Math.round(USD_PRICE * fxRate);

    const initResp = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: toKobo(ngnAmount),
        currency: 'NGN',
        metadata: { productId: 'ultimate-quote-bundle', usd_price: USD_PRICE, fx_rate: fxRate, ngn_charged: ngnAmount }
      })
    });
    const initJson = await initResp.json();

    if (!initJson || initJson.status === false) {
      return res.status(400).json({ error: initJson?.message || 'Paystack initialize failed', details: initJson });
    }

    // Save init transaction (non-fatal)
    if (db) {
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
        console.warn('Failed to save initialized tx:', e && e.message ? e.message : e);
      }
    }

    return res.json({ authorization_url: initJson.data.authorization_url, reference: initJson.data.reference, amount: ngnAmount });
  } catch (err) {
    console.error('Init payment error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- /api/verify - verify Paystack payment, record to Firestore, then send email via SMTP ----------
app.post('/api/verify', async (req, res) => {
  try {
    const { reference, purchaserEmail } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Server missing Paystack secret key' });

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

    // prepare record for Firestore
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

    // Save to "my order" collection (non-fatal)
    if (db) {
      try { await db.collection('my order').add(record); } catch (e) { console.warn('Save order failed (ignored):', e && e.message ? e.message : e); }
      try {
        await db.collection('transactions').doc(tx.reference).set({
          reference: tx.reference,
          email: userEmail,
          amount: ngnAmountPaid,
          status: 'success',
          paidAt: admin.firestore.Timestamp.now()
        }, { merge: true });
      } catch (e) { console.warn('Update tx doc failed (ignored):', e && e.message ? e.message : e); }
    }

    // Try send email via SMTP server-side
    if (userEmail && transporter) {
      try {
        await sendReceiptEmail(userEmail, tx.reference, PUBLIC_PDF_URL);
        console.log(`Email sent to ${userEmail} for ${tx.reference}`);
      } catch (e) {
        console.error('Email send failed:', e && e.message ? e.message : e);
        // do not fail the response — return success but log the email error
      }
    } else {
      console.warn('Skipping email send — missing user email or transporter not configured', { userEmail, transporter: !!transporter });
    }

    return res.json({ status: 'success', data: { reference: tx.reference, email: userEmail, amount: ngnAmountPaid, download_link: PUBLIC_PDF_URL } });
  } catch (err) {
    console.error('Verify payment error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- small debug endpoint to list transactions ----------
app.get('/api/transactions', async (req, res) => {
  try {
    if (!db) return res.json([]);
    const snap = await db.collection('transactions').orderBy('createdAt', 'desc').limit(50).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json(rows);
  } catch (e) {
    console.error('Fetch transactions error:', e && e.message ? e.message : e);
    return res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT} (PUBLIC_URL=${PUBLIC_URL})`));
