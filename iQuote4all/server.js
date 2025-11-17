// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();

// ───────── MIDDLEWARE ─────────
app.use(bodyParser.json());
app.use(express.static('public'));

// ───────── ENV CHECKS ─────────
const FAIL = msg => console.error(`\n❌ ENV ERROR → ${msg}\n`);

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) FAIL("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
if (!process.env.PAYSTACK_SECRET_KEY) FAIL("Missing PAYSTACK_SECRET_KEY");
if (!process.env.PUBLIC_URL) FAIL("Missing PUBLIC_URL");

if (!process.env.EMAILJS_SERVICE_ID ||
    !process.env.EMAILJS_TEMPLATE_ID ||
    !process.env.EMAILJS_PUBLIC_KEY) {
    console.warn("⚠️ EmailJS not fully configured — emails will NOT send.");
}

// ───────── FIREBASE ADMIN INIT ─────────
let serviceAccount = {};
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (err) {
    console.error("❌ Firebase Admin initialization failed:", err);
    process.exit(1);
}

const db = admin.firestore();

// ───────── GLOBAL CONFIG ─────────
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";
const PUBLIC_URL = process.env.PUBLIC_URL;

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;

const PDF_FILE_PATH = process.env.PDF_FILE_PATH || "files/THE ULTIMATE QUOTE BUNDLE.pdf";
const PUBLIC_PDF_URL = `${PUBLIC_URL}/${PDF_FILE_PATH.replace(/^\/+/, "")}`;

const toSmallest = amount => Math.round(Number(amount) * 100);

// ───────── SAVE INITIAL TRANSACTION ─────────
async function saveInit(reference, email, amount, metadata = {}) {
    return db.collection("transactions").doc(reference).set({
        reference,
        email,
        amount,
        status: "initialized",
        metadata,
        createdAt: admin.firestore.Timestamp.now()
    });
}

// ───────── SAVE ORDER (AFTER SUCCESS) ─────────
async function saveOrder(data) {
    return db.collection("my order").add({
        ...data,
        createdAt: admin.firestore.Timestamp.now()
    });
}

// ───────────────────────────────────────────
// 1️⃣ INITIALIZE PAYMENT
// ───────────────────────────────────────────
app.post("/api/pay", async (req, res) => {
    try {
        const { email, amount, productId } = req.body;

        if (!email || !amount)
            return res.status(400).json({ error: "Email & amount required" });

        const kobo = toSmallest(amount);

        const payload = {
            email,
            amount: kobo,
            metadata: { productId },
            callback_url: PUBLIC_URL
        };

        const paystackRes = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const json = await paystackRes.json();
        console.log("\n🟦 Paystack Init Response:", json);

        if (!json.status)
            return res.status(400).json({ error: json.message || "Paystack init failed" });

        const { reference, authorization_url, access_code } = json.data;

        await saveInit(reference, email, amount, { productId });

        res.json({ reference, authorization_url, access_code });

    } catch (err) {
        console.error("❌ Init Payment Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ───────────────────────────────────────────
// 2️⃣ VERIFY PAYMENT
// ───────────────────────────────────────────
app.post("/api/verify", async (req, res) => {
    try {
        const { reference, purchaserEmail } = req.body;

        if (!reference)
            return res.status(400).json({ error: "Reference missing" });

        const verifyRes = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const json = await verifyRes.json();
        console.log("\n🟩 Paystack Verify Response:", json);

        if (!json.status || !json.data || json.data.status !== "success") {
            return res.json({ status: "failed", data: json });
        }

        const pay = json.data;
        const userEmail = purchaserEmail || pay.customer?.email || null;
        const amt = pay.amount / 100;

        // update transaction
        await db.collection("transactions").doc(reference).set({
            reference,
            email: userEmail,
            amount: amt,
            status: "success",
            paidAt: admin.firestore.Timestamp.now()
        }, { merge: true });

        // save order
        await saveOrder({
            reference,
            email: userEmail,
            amount: amt,
            productId: pay.metadata?.productId || "ultimate-quote-bundle",
            paidAt: admin.firestore.Timestamp.now()
        });

        // send email
        if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY) {
            try {
                const payload = {
                    service_id: EMAILJS_SERVICE_ID,
                    template_id: EMAILJS_TEMPLATE_ID,
                    user_id: EMAILJS_PUBLIC_KEY,
                    template_params: {
                        to_email: userEmail,
                        book_name: "THE ULTIMATE QUOTE BUNDLE",
                        download_link: PUBLIC_PDF_URL,
                        reference
                    }
                };

                await fetch("https://api.emailjs.com/api/v1.0/email/send", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                console.log("📧 Email sent →", userEmail);

            } catch (e) {
                console.warn("⚠️ Email send failed:", e.message);
            }
        }

        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Verify Payment Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ───────────────────────────────────────────
// 3️⃣ List last 50 transactions
// ───────────────────────────────────────────
app.get("/api/transactions", async (req, res) => {
    try {
        const snap = await db.collection("transactions")
            .orderBy("createdAt", "desc")
            .limit(50)
            .get();

        const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        res.json(arr);

    } catch (err) {
        console.error("❌ Fetch Transactions Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ───────── SERVE FRONTEND SPA ─────────
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ───────── START SERVER ─────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
    console.log(`\n🚀 Server running on port ${PORT}\nPUBLIC_URL = ${PUBLIC_URL}\n`)
);
