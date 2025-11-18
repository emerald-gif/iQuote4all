// public/main.js
// Minimal client: Firebase kept, Paystack inline, calls server to init & verify

const firebaseConfig = {
  apiKey: "AIzaSyB5amYVfN2M6e1uUHvNh1cIlVD_Fa5g8eQ",
  authDomain: "iquote4all.firebaseapp.com",
  projectId: "iquote4all",
  storageBucket: "iquote4all.firebasestorage.app",
  messagingSenderId: "603028789594",
  appId: "1:603028789594:web:b5b9cc5fc9b35e4512bb63",
  measurementId: "G-TPW4DTTQEF"
};
if (typeof firebase !== "undefined" && firebase?.initializeApp) {
  try { firebase.initializeApp(firebaseConfig); } catch (e) { /* already init */ }
}
const db = (typeof firebase !== "undefined" && firebase.firestore) ? firebase.firestore() : null;

let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let USD_PRICE = 15.99;
let CLIENT_READY = false;

// load server config
async function initConfig() {
  try {
    const res = await fetch('/config');
    if (!res.ok) throw new Error('Failed to fetch /config');
    const cfg = await res.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || PAYSTACK_PUBLIC_KEY;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || PUBLIC_PDF_URL;
    USD_PRICE = Number(cfg.usdPrice || USD_PRICE);

    // load paystack inline automatically
    if (!window.PaystackPop) {
      const s = document.createElement('script');
      s.src = 'https://js.paystack.co/v1/inline.js';
      s.async = true;
      s.onload = () => { console.log('Paystack loaded'); CLIENT_READY = true; };
      s.onerror = () => { console.warn('Failed loading Paystack'); CLIENT_READY = true; };
      document.head.appendChild(s);
    } else {
      CLIENT_READY = true;
    }
    console.log('Client config:', { PAYSTACK_PUBLIC_KEY, PUBLIC_PDF_URL, USD_PRICE });
  } catch (e) {
    console.warn('initConfig error:', e);
    CLIENT_READY = true; // let user see errors later
  }
}
initConfig();

// modal helpers (same as server expectations)
const modalBackdrop = document.getElementById('modalBackdrop');
function openCheckoutModal() { const e=document.getElementById('buyerEmail'); const n=document.getElementById('buyerName'); if(e)e.value=''; if(n)n.value=''; if(modalBackdrop) modalBackdrop.style.display='flex'; }
function closeCheckoutModal(){ if(modalBackdrop) modalBackdrop.style.display='none'; }
if(modalBackdrop) modalBackdrop.addEventListener('click', (ev)=> { if(ev.target===modalBackdrop) closeCheckoutModal(); });

// proceedToPayment function (exposed to window)
async function proceedToPayment() {
  const emailEl = document.getElementById('buyerEmail');
  const nameEl = document.getElementById('buyerName');
  const btn = document.querySelector('.modal .buy-btn');
  const email = emailEl?.value?.trim();
  const name = nameEl?.value?.trim();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) { alert('Enter a valid email'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing...'; }

  try {
    const timeoutAt = Date.now() + 7000;
    while (!CLIENT_READY && Date.now() < timeoutAt) await new Promise(r=>setTimeout(r,100));
    if (!CLIENT_READY) throw new Error('Client not ready (reload).');

    // initialize payment on server
    const initResp = await fetch('/api/pay', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email })
    });
    const initJson = await initResp.json();
    if (!initResp.ok) throw new Error(initJson.error || 'Server init failed');

    const { reference, amount } = initJson;
    if (!reference) throw new Error('Missing reference from server');

    if (!window.PaystackPop) throw new Error('Paystack inline missing. Ensure https://js.paystack.co/v1/inline.js is loaded');
    if (!PAYSTACK_PUBLIC_KEY) console.warn('Paystack public key missing from /config');

    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: Math.round(Number(amount) * 100),
      currency: 'NGN',
      ref: reference,
      metadata: { custom_fields: [{ display_name:'Buyer name', variable_name:'buyer_name', value: name || '' }] },
      callback: function(response) {
        (async ()=>{
          try {
            const verifyRes = await fetch('/api/verify', {
              method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ reference: response.reference, purchaserEmail: email })
            });
            const verifyJson = await verifyRes.json();
            if (!verifyRes.ok || verifyJson.status !== 'success') {
              console.error('Verify failed:', verifyJson);
              alert('Payment succeeded but server verify failed. Check server logs.');
              if (btn) { btn.disabled = false; btn.textContent = 'Proceed to payment'; }
              return;
            }
            // on success server has attempted to send email via SMTP
            alert('Payment successful — check your inbox for the download link.');
            if (btn) { btn.disabled = false; btn.textContent = 'Proceed to payment'; }
            closeCheckoutModal();
          } catch (e) {
            console.error('Post-payment error:', e);
            alert('Verification failed. Check server logs.');
            if (btn) { btn.disabled = false; btn.textContent = 'Proceed to payment'; }
          }
        })();
      },
      onClose: function() {
        if (btn) { btn.disabled = false; btn.textContent = 'Proceed to payment'; }
        alert('Payment window closed.');
      }
    });

    handler.openIframe();
  } catch (err) {
    console.error('proceedToPayment error:', err);
    alert(err.message || 'Payment failed to start.');
    if (btn) { btn.disabled = false; btn.textContent = 'Proceed to payment'; }
  }
}

window.openCheckoutModal = openCheckoutModal;
window.closeCheckoutModal = closeCheckoutModal;
window.proceedToPayment = proceedToPayment;
