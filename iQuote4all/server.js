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

// Paystack Keys
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";

// USD PRICE
const USD_PRICE = 15.99;

// PDF Download Link
const PUBLIC_URL = process.env.PUBLIC_URL;
const PDF_FILE_PATH = process.env.PDF_FILE_PATH || "files/THE ULTIMATE QUOTE BUNDLE.pdf";
const PUBLIC_PDF_URL = `${PUBLIC_URL}/${PDF_FILE_PATH}`;

// EmailJS
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;


// ============================
// 🔥 GET LIVE USD → NGN RATE
// ============================
async function getExchangeRate() {
  try {
    const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: "fx_test@example.com",
        amount: 100,
        currency: "NGN"
      })
    });

    const data = await res.json();

    if (data?.data?.fees_breakdown?.[0]?.fx?.merchant_rate) {
      return data.data.fees_breakdown[0].fx.merchant_rate;
    }

    return 1500;

  } catch (e) {
    console.error("FX fetch error:", e);
    return 1500;
  }
}


// ============================
// 1️⃣ Initialize Payment
// ============================
app.post("/api/pay", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    // Get FX rate
    const rate = await getExchangeRate();
    const ngnAmount = Math.round(USD_PRICE * rate);

    // Initialize Paystack
    const paystackRes = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: ngnAmount * 100,
        currency: "NGN",
        metadata: {
          productId: "ultimate-quote-bundle",
          usd_price: USD_PRICE,
          fx_rate: rate,
          ngn_charged: ngnAmount
        }
      }),
    });

    const data = await paystackRes.json();

    if (!data.status) {
      return res.status(400).json({ error: data.message });
    }

    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
      amount: ngnAmount
    });

  } catch (err) {
    console.error("Init error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// ============================
// 2️⃣ Verify Payment
// ============================
app.post("/api/verify", async (req, res) => {
  const { reference, purchaserEmail } = req.body;

  try {
    const verifyRes = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const data = await verifyRes.json();

    if (data.status && data.data.status === "success") {
      const payData = data.data;

      const record = {
        reference,
        email: purchaserEmail,
        status: "success",
        usd_price: payData.metadata?.usd_price || USD_PRICE,
        ngn_amount: payData.amount / 100,
        fx_rate: payData.metadata?.fx_rate,
        paidAt: admin.firestore.Timestamp.now()
      };

      await db.collection("my order").add(record);

      // Send email with PDF
      if (EMAILJS_SERVICE_ID) {
        await fetch("https://api.emailjs.com/api/v1.0/email/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_id: EMAILJS_SERVICE_ID,
            template_id: EMAILJS_TEMPLATE_ID,
            user_id: EMAILJS_PUBLIC_KEY,
            template_params: {
              to_email: purchaserEmail,
              book_name: "THE ULTIMATE QUOTE BUNDLE",
              download_link: PUBLIC_PDF_URL,
              reference
            }
          })
        });
      }

      return res.json({ status: "success" });
    }

    return res.json({ status: "failed", data });

  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.resolve(__dirname, "public", "index.html"));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
