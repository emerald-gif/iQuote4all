// public/main.js

// FIREBASE (unchanged)
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

// runtime config (will be filled by fetch /config)
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let PAYSTACK_READY = false;

// load config and Paystack inline script
async function initConfigAndPaystack() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || null;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || null;

    if (!PAYSTACK_PUBLIC_KEY) {
      console.warn('Paystack public key not provided by server (/config). Set env PAYSTACK_PUBLIC_KEY.');
    }

    // inject Paystack inline script if not already present
    if (!window.PaystackPop) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://js.paystack.co/v1/inline.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load Paystack inline script'));
        document.head.appendChild(s);
      });
    }

    PAYSTACK_READY = true;
    console.log('Paystack ready, public key loaded:', PAYSTACK_PUBLIC_KEY ? 'YES' : 'NO');
  } catch (err) {
    console.warn('Failed to init config or Paystack script:', err);
  }
}

// immediately start config init
initConfigAndPaystack();

// UI helpers
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.style.left = sidebar.style.left === "0px" ? "-280px" : "0px";
}
function showReview() { window.location.href = "/review.html"; }
function followYoutube() { window.open("https://youtube.com/@iquote4all?si=pnSVWwSmgvO5VFNl"); }
function openContact() { alert("Contact: iquote4all@gmail.com"); }

// Quote carousel (optional)
let quoteIndex = 0;
const slides = document.querySelectorAll(".quote-slide");
const dots = document.querySelectorAll(".dot");
function showQuote(index) {
  if (!slides.length) return;
  slides.forEach((slide, i) => slide.classList.toggle("active", i === index));
  dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
}
function nextQuote() { if (!slides.length) return; quoteIndex = (quoteIndex + 1) % slides.length; showQuote(quoteIndex); }
function prevQuote() { if (!slides.length) return; quoteIndex = (quoteIndex - 1 + slides.length) % slides.length; showQuote(quoteIndex); }
if (slides.length) { setInterval(nextQuote, 5000); showQuote(0); }

// Transactions listing
async function showTransactions() {
  try {
    const res = await fetch('/api/transactions');
    const data = await res.json();
    const list = (data || []).map(tx => `${tx.reference} — ${tx.email || '—'} — ${tx.amount}`).join('\n');
    alert(list || 'No transactions found');
  } catch (err) {
    console.error(err);
    alert('Failed to fetch transactions');
  }
}

// Checkout modal helpers
const modalBackdrop = document.getElementById('modalBackdrop');
function openCheckoutModal() {
  document.getElementById('buyerEmail').value = '';
  document.getElementById('buyerName').value = '';
  modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal() { modalBackdrop.style.display = 'none'; }
if (modalBackdrop) { modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeCheckoutModal(); }); }

// Proceed to payment (DROP-IN fixed & uses server-side public key)
async function proceedToPayment() {
  const emailInput = document.getElementById('buyerEmail');
  const nameInput = document.getElementById('buyerName');
  const email = emailInput.value && emailInput.value.trim();
  const name = nameInput.value && nameInput.value.trim();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    alert('Please enter a valid email address.');
    return;
  }

  const proceedBtn = document.querySelector('.modal .buy-btn');
  proceedBtn.disabled = true;
  proceedBtn.textContent = 'Preparing...';

  try {
    // 1) initialize on server
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to initialize payment.');

    const { reference, amount } = data; // amount = NGN integer returned by server
    if (!reference) throw new Error('Payment reference missing from server response.');

    // wait for Paystack script + config to be ready (max ~5s)
    const timeoutAt = Date.now() + 5000;
    while (!PAYSTACK_READY && Date.now() < timeoutAt) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (!PAYSTACK_READY) throw new Error('Paystack script not ready. Try again.');

    if (!window.PaystackPop) throw new Error('Paystack inline script not loaded.');
    if (!PAYSTACK_PUBLIC_KEY) {
      // also accept window.PAYSTACK_PUBLIC_KEY if someone set it in page
      PAYSTACK_PUBLIC_KEY = window.PAYSTACK_PUBLIC_KEY || PAYSTACK_PUBLIC_KEY;
    }
    if (!PAYSTACK_PUBLIC_KEY) throw new Error('Paystack public key not set on server (check /config).');

    // Setup inline with a regular function for callback
    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: Math.round(Number(amount) * 100), // NGN -> kobo
      currency: 'NGN',
      ref: reference,
      metadata: {
        custom_fields: [
          { display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }
        ]
      },
      callback: function (response) {
        // call verifyPayment (async) from here
        verifyPayment(response.reference, email)
          .catch(err => {
            console.error('Verification error:', err);
            alert('Payment succeeded but verification failed. Contact support.');
          });
      },
      onClose: function () {
        proceedBtn.disabled = false;
        proceedBtn.textContent = 'Proceed to payment';
        alert('Payment window closed.');
      }
    });

    handler.openIframe();
  } catch (err) {
    console.error('proceedToPayment error:', err);
    alert(err.message || 'Payment failed to start.');
    proceedBtn.disabled = false;
    proceedBtn.textContent = 'Proceed to payment';
  }
}

// Verify payment (calls your server)
async function verifyPayment(reference, purchaserEmail) {
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, purchaserEmail })
    });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      alert('Payment successful! The PDF will be emailed shortly.');
      window.location.href = '/';
    } else {
      console.warn('Verify response:', data);
      alert('Payment not verified. If money was deducted contact support.');
    }
  } catch (err) {
    console.error(err);
    alert('Verification failed. Contact support.');
  }
}
