require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // v2 compatible
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Paystack Secret Key
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

// Helper to convert to kobo/cents
function toSmallestUnit(amount) {
  return Math.round(Number(amount) * 100);
}

// 1️⃣ Initialize Payment
app.post('/api/pay', async (req, res) => {
  const { email, amount, productId } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'Email and amount required' });

  try {
    const initializeResponse = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: toSmallestUnit(amount),
        metadata: { productId },
        callback_url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/success.html`
      })
    });

    const data = await initializeResponse.json();
    if (!data.status) return res.status(500).json({ error: 'Paystack init failed', data });

    // Save initial transaction
    await db.collection('transactions').doc(data.data.reference).set({
      reference: data.data.reference,
      email,
      amount,
      status: 'initialized',
      createdAt: admin.firestore.Timestamp.now()
    });

    res.json({ authorization_url: data.data.authorization_url, reference: data.data.reference });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2️⃣ Verify Payment
app.post('/api/verify', async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Reference required' });

  try {
    const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      await db.collection('transactions').doc(reference).set({
        reference,
        email: data.data.customer.email,
        amount: data.data.amount / 100,
        status: 'success',
        paidAt: admin.firestore.Timestamp.now()
      }, { merge: true });

      res.json({ status: 'success' });
    } else {
      res.json({ status: 'failed', data });
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

// Serve fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
