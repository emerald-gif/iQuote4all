// public/main.js

// FIREBASE (unchanged from yours)
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

// Paystack public key — set this in the page with:
// <script>window.PAYSTACK_PUBLIC_KEY = "pk_test_xxx";</script>
const PAYSTACK_PUBLIC_KEY = window.PAYSTACK_PUBLIC_KEY || "pk_live_376059b66ee3ce9af512496bd97ee3896b18f7adp";

// UI helpers
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.style.left = sidebar.style.left === "0px" ? "-280px" : "0px";
}
function showReview() { window.location.href = "/review.html"; }
function followYoutube() { window.open("https://youtube.com/@iquote4all?si=pnSVWwSmgvO5VFNl"); }
function openContact() { alert("Contact: iquote4all@gmail.com"); }

// Quote carousel (if you use .quote-slide)
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
if (slides.length) {
  setInterval(nextQuote, 5000);
  showQuote(0);
}

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

// Checkout modal
const modalBackdrop = document.getElementById('modalBackdrop');
function openCheckoutModal() {
  document.getElementById('buyerEmail').value = '';
  document.getElementById('buyerName').value = '';
  modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal() { modalBackdrop.style.display = 'none'; }
if (modalBackdrop) {
  modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeCheckoutModal(); });
}

// DROP-IN: replace your existing proceedToPayment() with this exact function
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
    // 1) Ask server to initialize the payment (server returns reference + amount (NGN integer))
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to initialize payment.');

    const { reference, amount } = data; // amount is NGN integer
    if (!reference) throw new Error('Payment reference missing from server response.');

    // 2) Guard: paystack inline script present and key set
    if (!window.PaystackPop) {
      throw new Error('Paystack inline script not loaded. Add: <script src="https://js.paystack.co/v1/inline.js"></script> before main.js');
    }
    if (!window.PAYSTACK_PUBLIC_KEY || window.PAYSTACK_PUBLIC_KEY === 'pk_live_376059b66ee3ce9af512496bd97ee3896b18f7adp) {
      throw new Error('Paystack public key not set. Add: <script>window.PAYSTACK_PUBLIC_KEY = "pk_test_xxx";</script> before the inline script.');
    }

    // 3) Set up Paystack inline. callback must be a valid function (not undefined)
    const handler = PaystackPop.setup({
      key: window.PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: Math.round(Number(amount) * 100), // NGN -> kobo
      currency: 'NGN',
      ref: reference,
      metadata: {
        custom_fields: [
          { display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }
        ]
      },

      // IMPORTANT: use a normal function here so Paystack sees a valid function value
      callback: function (response) {
        // response.reference exists
        // call async verifyPayment but don't make callback itself async (Paystack expects a function)
        verifyPayment(response.reference, email)
          .catch(err => {
            console.error('Error during verification:', err);
            alert('Payment succeeded but server verification failed. Contact support.');
          });
      },

      onClose: function () {
        // user closed the inline popup
        proceedBtn.disabled = false;
        proceedBtn.textContent = 'Proceed to payment';
        alert('Payment window closed.');
      }
    });

    // 4) open the inline iframe (same page)
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
