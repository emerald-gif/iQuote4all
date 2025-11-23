// server.js
// Single source of truth for products + Paystack endpoints
// Install: npm i express node-fetch firebase-admin cors body-parser
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(path.join(__dirname, 'files')));

// Firebase admin init (SERVICE_ACCOUNT_JSON or ADC)
try {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('firebase-admin initialized from SERVICE_ACCOUNT_JSON');
  } else {
    admin.initializeApp();
    console.log('firebase-admin initialized from ADC/default credentials');
  }
} catch (e) {
  console.warn('firebase-admin init warning:', e.message || e);
}
const db = admin.firestore ? admin.firestore() : null;

// Paystack / email config
const PAYSTACK_BASE = 'https://api.paystack.co';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || null;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || null;
const PUBLIC_PDF_URL = process.env.PUBLIC_PDF_URL || null;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || null;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || null;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || null;

function toKobo(ngn) { return Math.round(Number(ngn) * 100); }
async function getExchangeRateFromPaystack() { return 150; }

// ----------------- PRODUCTS (single source: edit here) -----------------
// Each product includes: id, title, priceUSD, coverPath (public/images/...), pdfPath (files/...), reviewImages (public/images/reviews/...)
const PRODUCTS = {
  'mindshift-101': {
    id: 'mindshift-101',
    title: 'MindShift — Begin',
    priceUSD: 9.99,
    coverPath: '/images/mindshift-101-cover.jpg',
    pdfPath: 'files/mindshift-101.pdf',
    reviewImages: ['/images/reviews/mindshift-101-r1.jpg']
  },
  'mindshift-advanced': {
    id: 'mindshift-advanced',
    title: 'MindShift — Advanced Habits',
    priceUSD: 12.99,
    coverPath: '/images/mindshift-advanced-cover.jpg',
    pdfPath: 'files/mindshift-advanced.pdf',
    reviewImages: ['/images/reviews/mindshift-advanced-r1.jpg','/images/reviews/mindshift-advanced-r2.jpg']
  },
  'ultimate-quote-bundle': {
    id: 'ultimate-quote-bundle',
    title: 'The Ultimate Quote Bundle',
    priceUSD: 15.99,
    coverPath: '/images/quote-bundle.jpg',
    pdfPath: 'files/quote-bundle.pdf',
    reviewImages: ['/images/reviews/quote-r1.jpg']
  }
  // add more products here (only change server.js)
};
// -----------------------------------------------------------------------

function derivePublicUrl(req) {
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}`;
}

// Return minimal product info to clients (no pdfPath)
app.get('/api/products', (req, res) => {
  try {
    const out = Object.values(PRODUCTS).map(p => ({
      id: p.id,
      title: p.title,
      priceUSD: p.priceUSD,
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      hasPdf: !!p.pdfPath
    }));
    return res.json({ products: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not load products' });
  }
});

// Single product (for review page)
app.get('/api/product/:id', (req, res) => {
  try {
    const pid = req.params.id;
    const p = PRODUCTS[pid];
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const out = {
      id: p.id,
      title: p.title,
      priceUSD: p.priceUSD,
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      hasPdf: !!p.pdfPath
    };
    return res.json({ product: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// /config endpoint for client (Paystack public key + optional publicPdf fallback)
app.get('/config', (req, res) => {
  return res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY || null, publicPdfUrl: PUBLIC_PDF_URL || null });
});

// /api/pay - initialize Paystack for a product
app.post('/api/pay', async (req, res) => {
  try {
    const { email, productId } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!productId) return res.status(400).json({ error: 'productId required' });
    const product = PRODUCTS[productId];
    if (!product) return res.status(400).json({ error: 'Invalid productId' });

    const fxRate = await getExchangeRateFromPaystack();
    const ngnAmount = Math.round(Number(product.priceUSD) * Number(fxRate));

    if (!PAYSTACK_SECRET_KEY) {
      const fakeRef = `TEST_REF_${Date.now()}`;
      if (db) {
        await db.collection('transactions').doc(fakeRef).set({
          reference: fakeRef, email, amount: ngnAmount, status: 'initialized',
          metadata: { productId: product.id, usd_price: product.priceUSD, fx_rate: fxRate, ngn_charged: ngnAmount },
          createdAt: admin.firestore.Timestamp.now()
        }).catch(()=>null);
      }
      return res.json({ authorization_url: null, reference: fakeRef, amount: ngnAmount });
    }

    const initResp = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: toKobo(ngnAmount),
        currency: 'NGN',
        metadata: { productId: product.id, usd_price: product.priceUSD, fx_rate: fxRate, ngn_charged: ngnAmount }
      })
    });
    const initJson = await initResp.json().catch(()=>null);
    if (!initJson || initJson.status === false) return res.status(400).json({ error: initJson ? initJson.message : 'Paystack init failed', details: initJson });

    if (db) {
      await db.collection('transactions').doc(initJson.data.reference).set({
        reference: initJson.data.reference, email, amount: ngnAmount, status: 'initialized', metadata: initJson.data.metadata||{}, createdAt: admin.firestore.Timestamp.now()
      }).catch(()=>null);
    }
    return res.json({ authorization_url: initJson.data.authorization_url, reference: initJson.data.reference, amount: ngnAmount });
  } catch (err) {
    console.error('/api/pay error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// /api/verify - verify payment and record + email download link
app.post('/api/verify', async (req, res) => {
  try {
    const { reference, purchaserEmail } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    let verifyJson = null;
    if (!PAYSTACK_SECRET_KEY) {
      // simulate
      if (db) {
        const doc = await db.collection('transactions').doc(reference).get().catch(()=>null);
        const saved = doc && doc.exists ? doc.data() : {};
        verifyJson = { status: true, data: { reference, status: 'success', amount: saved.amount ? toKobo(saved.amount) : 0, customer: { email: purchaserEmail || saved.email || null }, metadata: saved.metadata || {} } };
      } else {
        verifyJson = { status: true, data: { reference, status: 'success', amount: 0, customer: { email: purchaserEmail || null }, metadata: {} } };
      }
    } else {
      const vresp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET', headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
      verifyJson = await vresp.json().catch(()=>null);
    }

    if (!verifyJson || verifyJson.status !== true) return res.json({ status: 'failed', data: verifyJson });
    const tx = verifyJson.data;
    if (!tx || tx.status !== 'success') return res.json({ status: 'failed', data: verifyJson });

    const userEmail = purchaserEmail || (tx.customer && tx.customer.email) || null;
    const metadata = tx.metadata || {};
    const productId = metadata.productId || null;
    const product = productId ? PRODUCTS[productId] : null;

    const publicBase = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : derivePublicUrl(req);
    const pdfUrl = product ? `${publicBase}/${product.pdfPath.replace(/^\/+/, '')}` : (PUBLIC_PDF_URL || null);
    const ngnAmountPaid = (tx.amount || 0) / 100;

    const record = { reference: tx.reference, email: userEmail, status: 'success', usd_price: metadata.usd_price || null, ngn_amount: ngnAmountPaid, fx_rate: metadata.fx_rate || null, paystack: tx, pdfUrl, paidAt: admin.firestore ? admin.firestore.Timestamp.now() : new Date(), productId: product ? product.id : null };

    if (db) {
      await db.collection('my_order').add(record).catch(()=>null);
      await db.collection('transactions').doc(tx.reference).set({ reference: tx.reference, email: userEmail, amount: ngnAmountPaid, status: 'success', paidAt: admin.firestore.Timestamp.now() }, { merge: true }).catch(()=>null);
    }

    if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY && userEmail && pdfUrl) {
      try {
        const emailPayload = { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, public_key: EMAILJS_PUBLIC_KEY, template_params: { to_email: userEmail, book_name: product ? product.title : 'MindShift Books purchase', download_link: pdfUrl, reference: tx.reference } };
        const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
        const txt = await emailRes.text().catch(()=>null);
        if (!emailRes.ok) console.error('EmailJS error', emailRes.status, txt);
      } catch (e) { console.warn('EmailJS send failed', e.message || e); }
    }

    return res.json({ status: 'success', data: record });
  } catch (err) {
    console.error('/api/verify error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// debug listing (optional)
app.get('/debug/orders', async (req, res) => {
  if (!db) return res.status(400).json({ error: 'No Firestore configured' });
  try {
    const snap = await db.collection('my_order').orderBy('paidAt','desc').limit(100).get();
    const out = [];
    snap.forEach(d => out.push({ id: d.id, ...d.data() }));
    res.json({ count: out.length, orders: out });
  } catch (e) { res.status(500).json({ error: e.message || 'Server error' }); }
});

// SPA fallback for index.html
app.get('*', (req, res, next) => {
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.indexOf('text/html') !== -1) {
    const p = req.path || '';
    if (p.startsWith('/api') || p.startsWith('/files') || p.startsWith('/images')) return next();
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return next();
});

app.listen(PORT, () => {
  console.log(`MindShift Books server running on port ${PORT}`);
  console.log(`Serving static: ${path.join(__dirname,'public')} and ${path.join(__dirname,'files')}`);
});
