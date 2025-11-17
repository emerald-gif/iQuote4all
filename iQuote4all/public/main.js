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

// Proceed to payment — CLIENT sends only email, server returns reference + NGN amount
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
    // request server to initialize (server will compute NGN amount)
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to initialize payment.');

    const { reference, amount } = data; // amount = NGN integer

    if (!reference) throw new Error('Payment reference missing.');

    // ensure Paystack inline script is loaded and key is present
    if (!window.PaystackPop) {
      throw new Error('Paystack inline script not loaded. Add <script src="https://js.paystack.co/v1/inline.js"></script> to your HTML.');
    }
    if (!PAYSTACK_PUBLIC_KEY || PAYSTACK_PUBLIC_KEY === 'YOUR_PAYSTACK_PUBLIC_KEY') {
      throw new Error('PAYSTACK_PUBLIC_KEY not set. Place <script>window.PAYSTACK_PUBLIC_KEY = "pk_test_xxx";</script> in your index.html with your key.');
    }

    // OPEN INLINE PAYSTACK POPUP (same page)
    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: Math.round(Number(amount) * 100), // amount is NGN; convert to kobo
      currency: 'NGN',
      ref: reference,
      metadata: {
        custom_fields: [
          { display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }
        ]
      },
      callback: async function (response) {
        // response.reference available
        try {
          await verifyPayment(response.reference, email);
        } catch (err) {
          console.error('Verify error:', err);
          alert('Payment completed but verification failed server-side. Contact support.');
        } finally {
          proceedBtn.disabled = false;
          proceedBtn.textContent = 'Proceed to payment';
          closeCheckoutModal();
        }
      },
      onClose: function () {
        proceedBtn.disabled = false;
        proceedBtn.textContent = 'Proceed to payment';
        alert('Payment cancelled by user.');
      }
    });

    handler.openIframe();

  } catch (err) {
    console.error(err);
    alert(err.message || 'Failed to start payment.');
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
