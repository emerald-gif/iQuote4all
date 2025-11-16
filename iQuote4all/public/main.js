// ======= Client-side main.js =======

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
const PAYSTACK_PUBLIC_KEY = 'YOUR_PAYSTACK_PUBLIC_KEY'; // <-- replace this

// UI helpers
function toggleSidebar(){
  const sidebar = document.getElementById('sidebar');
  sidebar.style.left = sidebar.style.left === '0px' ? '-280px' : '0px';
}

function showReview(){ alert("Reviews coming soon!"); }
function followYoutube(){ window.open('https://www.youtube.com/', '_blank'); }
function openContact(){ alert("Contact: iquote4all@gmail.com"); }

// Quote carousel logic
let currentQuote = 0;
const quotes = document.querySelectorAll('.quote');

function showQuote(i){
  quotes.forEach(q => q.style.display = 'none');
  quotes[i].style.display = 'block';
  currentQuote = i;
}
function nextQuote(){ showQuote((currentQuote + 1) % quotes.length); }
function prevQuote(){ showQuote((currentQuote - 1 + quotes.length) % quotes.length); }
setInterval(nextQuote, 6000); // auto rotate

// Transactions listing (simple)
async function showTransactions(){
  try {
    const res = await fetch('/api/transactions');
    const data = await res.json();
    const list = data.map(tx => `${tx.reference} — ${tx.email || tx?.customer?.email || '—'} — ${tx.amount}`).join('\n');
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

// Proceed to payment - flow:
// 1. Read email entered (this will be used to deliver PDF).
// 2. Call /api/pay with amount and productId and email -> server initializes Paystack and returns authorization_url and reference.
// 3. Open Paystack inline using returned reference (PaystackPop.setup) OR redirect to authorization_url if necessary.
// 4. When Paystack returns successful callback, call /api/verify with reference and purchaserEmail.
// 5. On success finalizes and notifies user.
async function proceedToPayment(){
  const emailInput = document.getElementById('buyerEmail');
  const nameInput = document.getElementById('buyerName');
  const email = emailInput.value && emailInput.value.trim();
  const name = nameInput.value && nameInput.value.trim();

  if(!email || !/^\S+@\S+\.\S+$/.test(email)){
    alert('Please enter a valid email address.');
    return;
  }

  // Disable modal lightly
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
    if(!res.ok) throw new Error(data.error || 'Failed to init payment');

    // Data contains authorization_url and reference
    const { authorization_url, reference } = data;

    // Use Paystack inline if available and we have public key. Fallback to redirect to authorization_url.
    if(window.PaystackPop && PAYSTACK_PUBLIC_KEY && reference){
      // Setup inline with returned reference (Paystack will accept reference)
      const handler = PaystackPop.setup({
        key: PAYSTACK_PUBLIC_KEY,
        email,
        amount: Math.round(15.99 * 100), // in kobo/cents
        ref: reference,
        currency: 'USD',
        callback: async function(response){
          // response.reference available
          try {
            // call verify endpoint with reference and the email user typed
            await verifyPayment(response.reference, email);
          } catch (err) {
            console.error(err);
            alert('Payment verified but something went wrong on the server. Contact support.');
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
      // Fallback: open authorization_url (redirect)
      window.open(authorization_url, '_blank'); 
      // Inform user they should return to confirm - we still need to verify when they come back.
      alert('A payment window was opened. After completing payment, click OK and we will verify.');
      // Let user click OK, then call verify (we need the reference)
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
  // Call server to verify Paystack
  try {
    const res = await fetch('/api/verify', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ reference, purchaserEmail }) // include purchaserEmail so server can record user's chosen email
    });
    const data = await res.json();
    if(res.ok && data.status === 'success'){
      alert('Payment successful! The PDF will be emailed to you shortly.');
      // after success, automatically redirect main page to refresh state
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


function showReview() {
  // Redirect user to the review page
  window.location.href = "review.html";
}


// Small usability: close modal when clicking outside
modalBackdrop.addEventListener('click', (e)=>{
  if(e.target === modalBackdrop) closeCheckoutModal();
});
