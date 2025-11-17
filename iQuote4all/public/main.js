// public/main.js

// ───────── FIREBASE CONFIG ─────────
const firebaseConfig = {
  apiKey: "AIzaSyB5amYVfN2M6e1uUHvNh1cIlVD_Fa5g8eQ",
  authDomain: "iquote4all.firebaseapp.com",
  projectId: "iquote4all",
  storageBucket: "iquote4all.firebasestorage.app",
  messagingSenderId: "603028789594",
  appId: "1:603028789594:web:b5b9cc5fc9b35e4512bb63",
  measurementId: "G-TPW4DTTQEF"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ───────── PAYSTACK PUBLIC KEY ─────────
const PAYSTACK_PUBLIC_KEY = window.PAYSTACK_PUBLIC_KEY || "YOUR_PAYSTACK_PUBLIC_KEY";

// ───────── UI HELPERS ─────────
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.style.left = sidebar.style.left === "0px" ? "-280px" : "0px";
}

function showReview() { window.location.href = "/review.html"; }
function followYoutube() { window.open("https://youtube.com/@iquote4all?si=pnSVWwSmgvO5VFNl"); }
function openContact() { alert("Contact: iquote4all@gmail.com"); }

// ───────── QUOTE CAROUSEL ─────────
let currentQuote = 0;
const quotes = document.querySelectorAll(".quote") || [];

function showQuote(i) {
  if (!quotes.length) return;
  quotes.forEach(q => q.style.display = "none");
  quotes[i].style.display = "block";
  currentQuote = i;
}

function nextQuote() { showQuote((currentQuote + 1) % quotes.length); }

if (quotes.length) {
  setInterval(nextQuote, 6000);
  showQuote(0);
}

// ───────── TRANSACTIONS LIST ─────────
async function showTransactions() {
  try {
    const res = await fetch("/api/transactions");
    const data = await res.json();
    const list = (data || [])
      .map(tx => `${tx.reference} — ${tx.email || "—"} — ${tx.amount}`)
      .join("\n");
    alert(list || "No transactions found");
  } catch (err) {
    console.error(err);
    alert("Failed to fetch transactions");
  }
}

// ───────── CHECKOUT MODAL ─────────
const modalBackdrop = document.getElementById("modalBackdrop");

function openCheckoutModal() {
  document.getElementById("buyerEmail").value = "";
  document.getElementById("buyerName").value = "";
  modalBackdrop.style.display = "flex";
}

function closeCheckoutModal() {
  modalBackdrop.style.display = "none";
}

// close modal on backdrop click
if (modalBackdrop) {
  modalBackdrop.addEventListener("click", e => {
    if (e.target === modalBackdrop) closeCheckoutModal();
  });
}

// ─────────────────────────────────────────────
// 🔥 START PAYMENT — NEW VERSION (NO USD CLIENT)
// ─────────────────────────────────────────────
async function proceedToPayment() {
  const email = document.getElementById("buyerEmail").value.trim();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    alert("Please enter a valid email.");
    return;
  }

  const proceedBtn = document.querySelector(".modal .buy-btn");
  proceedBtn.disabled = true;
  proceedBtn.textContent = "Preparing payment...";

  try {
    // 1️⃣ Request NGN amount + reference from server
    const res = await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unable to start payment.");

    const { authorization_url, reference } = data;
    if (!reference) throw new Error("No reference returned from server");

    // 2️⃣ Always use hosted checkout (correct for NGN)
    window.open(authorization_url, "_blank");

    alert("Complete your payment in the opened Paystack window.");

    // 3️⃣ Optional: poll verification after delay
    setTimeout(async () => {
      await verifyPayment(reference, email);
    }, 3000);

  } catch (err) {
    alert(err.message);
    console.error(err);
  }

  proceedBtn.disabled = false;
  proceedBtn.textContent = "Proceed to payment";
  closeCheckoutModal();
}

// ───────── VERIFY PAYMENT ─────────
async function verifyPayment(reference, purchaserEmail) {
  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference, purchaserEmail })
    });

    const data = await res.json();

    if (data.status === "success") {
      alert("Payment successful! Check your email for the eBook.");
      window.location.href = "/";
    } else {
      console.log(data);
      alert("Payment not completed yet. If money was deducted, contact support.");
    }

  } catch (err) {
    console.error(err);
    alert("Verification error. Contact support.");
  }
}
