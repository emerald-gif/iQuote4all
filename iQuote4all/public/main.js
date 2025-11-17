// public/main.js

// Firebase client config (as you gave)
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

// Config - replace with your Paystack public key
const PAYSTACK_PUBLIC_KEY = (window.PAYSTACK_PUBLIC_KEY || 'pk_live_8490c2179be3d6cb47b027152bdc2e04b774d22d'); // set this in HTML or replace

// UI helpers
function toggleSidebar(){
  const sidebar = document.getElementById('sidebar');
  sidebar.style.left = sidebar.style.left === '0px' ? '-280px' : '0px';
}

function showReview(){ window.location.href = '/review.html'; }
function followYoutube(){ window.open('https://www.youtube.com/', '_blank'); }
function openContact(){ alert("Contact: iquote4all@gmail.com"); }

// Quote carousel logic
let currentQuote = 0;
const quotes = document.querySelectorAll('.quote') || [];

function showQuote(i){
  if (!quotes.length) return;
  quotes.forEach(q => q.style.display = 'none');
  quotes[i].style.display = 'block';
  currentQuote = i;
}
function nextQuote(){ showQuote((currentQuote + 1) % quotes.length); }
function prevQuote(){ showQuote((currentQuote - 1 + quotes.length) % quotes.length); }
if (quotes.length) {
  setInterval(nextQuote, 6000); // auto rotate
  showQuote(0);
}

// Transactions listing (simple)
async function showTransactions(){
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
function openCheckoutModal(){
  document.getElementById('buyerEmail').value = '';
  document.getElementById('buyerName').value = '';
  modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal(){ modalBackdrop.style.display = 'none'; }

// Proceed to payment
async function proceedToPayment(){
  const emailInput = document.getElementById('buyerEmail');
  const nameInput = document.getElementById('buyerName');
  const email = emailInput.value && emailInput.value.trim();
  const name = nameInput.value && nameInput.value.trim();

  if(!email || !/^\S+@\S+\.\S+$/.test(email)){
    alert('Please enter a valid email address.');
    return;
  }

  const proceedBtn = document.querySelector('.modal .buy-btn');
  proceedBtn.disabled = true;
  proceedBtn.textContent = 'Preparing...';

  try {
    const payload = { email, amount: 15.99, productId: 'ultimate-quote-bundle' };
    const res = await fetch('/api/pay', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      const errMsg = data && (data.message || data.error) ? (data.message || data.error) : 'Failed to init payment';
      throw new Error(errMsg);
    }

    const { authorization_url, reference } = data;
    if (!reference) throw new Error('No reference returned from server');

    // Prefer inline Paystack if public key set
    if (window.PaystackPop && PAYSTACK_PUBLIC_KEY && PAYSTACK_PUBLIC_KEY !== 'YOUR_PAYSTACK_PUBLIC_KEY') {
      const handler = PaystackPop.setup({
        key: PAYSTACK_PUBLIC_KEY,
        email,
        amount: Math.round(15.99 * 100),
        ref: reference,
        currency: 'USD',
        callback: async function(response){
          try {
            await verifyPayment(response.reference, email);
          } catch (err) {
            console.error(err);
            alert('Payment processed but verification failed. Contact support.');
          } finally {
            proceedBtn.disabled = false;
            proceedBtn.textContent = 'Proceed to payment';
            closeCheckoutModal();
          }
        },
        onClose: function(){
          proceedBtn.disabled = false;
          proceedBtn.textContent = 'Proceed to payment';
          alert('Payment cancelled');
        }
      });
      handler.openIframe();
    } else {
      // fallback: open authorization_url in new tab
      window.open(authorization_url, '_blank');
      alert('A payment window was opened. Complete payment there, then click OK to verify.');
      await verifyPayment(reference, email);
      proceedBtn.disabled = false;
      proceedBtn.textContent = 'Proceed to payment';
      closeCheckoutModal();
    }

  } catch (err) {
    console.error(err);
    alert(err.message || 'Failed to start payment.');
    proceedBtn.disabled = false;
    proceedBtn.textContent = 'Proceed to payment';
  }
}

async function verifyPayment(reference, purchaserEmail){
  try {
    const res = await fetch('/api/verify', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ reference, purchaserEmail })
    });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      alert('Payment successful! The PDF will be emailed to you shortly.');
      window.location.href = '/';
    } else {
      console.warn('verify response', data);
      alert('Payment verification failed. Please contact support if money was deducted.');
    }
  } catch (err) {
    console.error(err);
    alert('Verification request failed. Contact support.');
  }
}

// close modal when clicking outside
if (modalBackdrop) {
  modalBackdrop.addEventListener('click', (e)=>{
    if(e.target === modalBackdrop) closeCheckoutModal();
  });
}
