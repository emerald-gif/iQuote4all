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
if (typeof firebase !== "undefined" && firebase.initializeApp) {
  try { firebase.initializeApp(firebaseConfig); } catch (e) { /* already init */ }
}
const db = (typeof firebase !== "undefined" && firebase.firestore) ? firebase.firestore() : null;

// runtime config loaded from server
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let USD_PRICE = 15.99;
let CLIENT_READY = false;

// load server config and Paystack inline
async function initConfigAndLibs() {
  try {
    const r = await fetch('/config');
    const cfg = await r.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || PAYSTACK_PUBLIC_KEY;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || PUBLIC_PDF_URL;
    USD_PRICE = cfg.usdPrice || USD_PRICE;

    // load Paystack inline if not present
    if (!window.PaystackPop) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://js.paystack.co/v1/inline.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load Paystack inline'));
        document.head.appendChild(s);
      });
    }
    CLIENT_READY = true;
    console.log('Client ready: paystack loaded, config:', { PAYSTACK_PUBLIC_KEY, PUBLIC_PDF_URL, USD_PRICE });
  } catch (e) {
    console.warn('initConfigAndLibs failed:', e);
    CLIENT_READY = true; // allow user to try but it will error later
  }
}
initConfigAndLibs();

// modal helpers
const modalBackdrop = document.getElementById('modalBackdrop');
function openCheckoutModal() {
  const e = document.getElementById('buyerEmail'); if (e) e.value = '';
  const n = document.getElementById('buyerName'); if (n) n.value = '';
  if (modalBackdrop) modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal() { if (modalBackdrop) modalBackdrop.style.display = 'none'; }
if (modalBackdrop) modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeCheckoutModal(); });

// proceedToPayment: initialize server, open Paystack inline, then call server verify after success
async function proceedToPayment() {
  const emailInput = document.getElementById('buyerEmail');
  const nameInput = document.getElementById('buyerName');
  const buyBtn = document.querySelector('.modal .buy-btn');

  const email = emailInput?.value?.trim();
  const name = nameInput?.value?.trim();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) { alert('Please enter a valid email address.'); return; }
  if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = 'Preparing...'; }

  try {
    // wait briefly for libs
    const timeoutAt = Date.now() + 7000;
    while (!CLIENT_READY && Date.now() < timeoutAt) await new Promise(r => setTimeout(r, 100));
    if (!CLIENT_READY) throw new Error('Client libs not ready. Reload the page.');

    // 1) initialize on server (server returns reference and amount)
    const initRes = await fetch('/api/pay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
    });
    const initJson = await initRes.json();
    if (!initRes.ok) throw new Error(initJson.error || 'Failed to initialize payment on server.');

    const { reference, amount } = initJson;
    if (!reference) throw new Error('No payment reference from server.');

    // 2) open Paystack inline
    if (!window.PaystackPop) throw new Error('Paystack inline missing (load https://js.paystack.co/v1/inline.js).');
    if (!PAYSTACK_PUBLIC_KEY) console.warn('Paystack public key missing from /config.');

    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: Math.round(Number(amount) * 100), // convert NGN to kobo for paystack inline
      currency: 'NGN',
      ref: reference,
      metadata: {
        custom_fields: [{ display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }]
      },
      callback: function (response) {
        // Payment succeeded on Paystack side -> verify on server which will send the email
        (async () => {
          try {
            const verifyRes = await fetch('/api/verify', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference: response.reference, purchaserEmail: email })
            });
            const verifyJson = await verifyRes.json();
            if (!verifyRes.ok || verifyJson.status !== 'success') {
              console.error('Server verify failed:', verifyJson);
              alert('Payment succeeded but verification failed on server. Check server logs.');
              if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Proceed to payment'; }
              return;
            }

            // server attempted to send email. Show success to user.
            alert('Payment successful — check your email for the download link.');
            if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Proceed to payment'; }
            closeCheckoutModal();
          } catch (e) {
            console.error('Post-payment error:', e);
            alert('Verification failed. Check server logs.');
            if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Proceed to payment'; }
          }
        })();
      },
      onClose: function () {
        if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Proceed to payment'; }
        alert('Payment window closed.');
      }
    });

    handler.openIframe();
  } catch (err) {
    console.error('proceedToPayment error:', err);
    alert(err.message || 'Failed to start payment.');
    if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Proceed to payment'; }
  }
}

// expose to global if your html uses inline onClick
window.openCheckoutModal = openCheckoutModal;
window.closeCheckoutModal = closeCheckoutModal;
window.proceedToPayment = proceedToPayment;
