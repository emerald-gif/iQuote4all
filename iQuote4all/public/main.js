// public/main.js

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

// PAYSTACK PUBLIC KEY
const PAYSTACK_PUBLIC_KEY = "pk_live_376059b66ee3ce9af512496bd97ee3896b18f7ad"; // <-- PUT YOUR TEST OR LIVE KEY

// Checkout Modal
const modalBackdrop = document.getElementById("modalBackdrop");

function openCheckoutModal() {
  document.getElementById("buyerEmail").value = "";
  modalBackdrop.style.display = "flex";
}

function closeCheckoutModal() {
  modalBackdrop.style.display = "none";
}

// Start Payment
async function proceedToPayment() {
  const email = document.getElementById("buyerEmail").value.trim();

  if (!email) {
    alert("Enter a valid email.");
    return;
  }

  const btn = document.querySelector(".modal .buy-btn");
  btn.disabled = true;
  btn.textContent = "Preparing...";

  try {
    // 1️⃣ Request payment details from server
    const res = await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error);

    const { reference, amount } = data;

    // 2️⃣ OPEN PAYSTACK POPUP — NO NEW TAB
    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: amount * 100,
      currency: "NGN",
      ref: reference,

      callback: function () {
        verifyPayment(reference, email);
      },

      onClose: function () {
        alert("Payment cancelled.");
      }
    });

    handler.openIframe();

  } catch (err) {
    alert(err.message);
  }

  btn.disabled = false;
  btn.textContent = "Proceed to payment";
  closeCheckoutModal();
}

// Verify payment
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
      alert("Payment not completed. If money was deducted, contact support.");
    }

  } catch (err) {
    alert("Verification error. Please contact support.");
  }
}
