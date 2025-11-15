const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());
app.use(express.static('.'));

// Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Verify Paystack
app.post('/verify', async (req, res) => {
  const { reference } = req.body;
  const secretKey = 'YOUR_PAYSTACK_SECRET_KEY';
  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secretKey}` }
    });
    const data = await response.json();
    if(data.status && data.data.status==='success'){
      await db.collection('transactions').add({
        reference: reference,
        amount: data.data.amount/100,
        email: data.data.customer.email,
        createdAt: admin.firestore.Timestamp.now()
      });
      res.json({ status: 'success' });
    } else { res.json({ status:'failed' }); }
  } catch(e){ res.status(500).send(e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server running on port',PORT));