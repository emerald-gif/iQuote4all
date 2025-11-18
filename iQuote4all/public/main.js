// public/main.js
// FIREBASE initialization (unchanged)
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

// runtime config (fetched from /config)
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let USD_PRICE = 15.99;
let PAYSTACK_READY = false;

let EMAILJS_PUBLIC_KEY = null;
let EMAILJS_SERVICE_ID = null;
let EMAILJS_TEMPLATE_ID = null;

// load config & required libs
async function initConfig() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || null;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || null;
    USD_PRICE = cfg.usdPrice || USD_PRICE;
    EMAILJS_PUBLIC_KEY = cfg.emailjs?.publicKey || null;
    EMAILJS_SERVICE_ID = cfg.emailjs?.serviceId || null;
    EMAILJS_TEMPLATE_ID = cfg.emailjs?.templateId || null;

    // load Paystack inline script if not included
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

    // load EmailJS SDK if not included
    if (!window.emailjs) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.emailjs.com/sdk/3.2.0/email.min.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load EmailJS SDK'));
        document.head.appendChild(s);
      });
    }

    // init EmailJS client with public key
    if (EMAILJS_PUBLIC_KEY && window.emailjs) {
      try {
        emailjs.init(EMAILJS_PUBLIC_KEY);
      } catch (e) {
        console.warn('emailjs.init failed:', e);
      }
    }

    PAYSTACK_READY = true;
    console.log('Client config loaded', { PAYSTACK_PUBLIC_KEY, EMAILJS_PUBLIC_KEY });
  } catch (err) {
    console.warn('initConfig failed', err);
  }
}
initConfig();

// UI helpers (kept minimal)
function toggleSidebar(){ const s=document.getElementById('sidebar'); if(!s) return; s.style.left = s.style.left === '0px' ? '-280px' : '0px'; }
function showReview(){ window.location.href = '/review.html'; }
function followYoutube(){ window.open('https://youtube.com/@iquote4all'); }
function openContact(){ alert('Contact: iquote4all@gmail.com'); }

// Checkout modal helpers
const modalBackdrop = document.getElementById('modalBackdrop');
function openCheckoutModal(){ const e=document.getElementById('buyerEmail'); const n=document.getElementById('buyerName'); if(e) e.value=''; if(n) n.value=''; if(modalBackdrop) modalBackdrop.style.display='flex'; }
function closeCheckoutModal(){ if(modalBackdrop) modalBackdrop.style.display='none'; }
if(modalBackdrop) modalBackdrop.addEventListener('click', e => { if(e.target===modalBackdrop) closeCheckoutModal(); });

// Proceed to payment (client-side inline + EmailJS send)
async function proceedToPayment(){
  const emailInput = document.getElementById('buyerEmail');
  const nameInput = document.getElementById('buyerName');
  const email = emailInput?.value?.trim();
  const name = nameInput?.value?.trim();

  if(!email || !/^\S+@\S+\.\S+$/.test(email)){ alert('Please enter a valid email.'); return; }

  const proceedBtn = document.querySelector('.modal .buy-btn');
  if(proceedBtn){ proceedBtn.disabled = true; proceedBtn.textContent = 'Preparing...'; }

  try{
    // 1) initialize on server
    const resp = await fetch('/api/pay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
    });
    const init = await resp.json();
    if(!resp.ok) throw new Error(init.error || 'Failed to init payment.');

    const { reference, amount } = init;
    if(!reference) throw new Error('Missing reference from server.');

    // wait short for libs
    const timeoutAt = Date.now() + 5000;
    while(!PAYSTACK_READY && Date.now() < timeoutAt) await new Promise(r=>setTimeout(r,100));
    if(!PAYSTACK_READY) throw new Error('Client not ready. Reload.');

    if(!window.PaystackPop) throw new Error('Paystack inline missing.');
    if(!PAYSTACK_PUBLIC_KEY) throw new Error('Paystack public key missing from /config.');

    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: Math.round(Number(amount) * 100),
      currency: 'NGN',
      ref: reference,
      metadata: { custom_fields: [{ display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }] },

      callback: function(response){
        // Payment succeeded — call verify endpoint, then send email from client via EmailJS
        (async ()=>{
          try{
            const verifyRes = await fetch('/api/verify', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference: response.reference, purchaserEmail: email })
            });
            const verifyJson = await verifyRes.json();
            if(!verifyRes.ok || verifyJson.status !== 'success'){
              console.error('Verify failed:', verifyJson);
              alert('Payment succeeded but verify failed. Check console.');
              if(proceedBtn){ proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
              return;
            }

            const payload = verifyJson.data; // contains download_link, reference, email, book_name

            // Send email via EmailJS from client
            if(window.emailjs && EMAILJS_PUBLIC_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID){
              const templateParams = {
                to_email: payload.email,
                book_name: payload.book_name,
                download_link: payload.download_link,
                reference: payload.reference
              };
              try {
                const result = await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams);
                console.log('EmailJS send result:', result);
                alert('Payment successful — check your email for the download link.');
              } catch (e) {
                console.error('EmailJS send error:', e);
                alert('Payment verified but failed to send email (check console).');
              }
            } else {
              console.warn('EmailJS client not configured on client side.');
              alert('Payment verified. Email not sent because EmailJS not configured.');
            }

            if(proceedBtn){ proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
            window.location.href = '/';
          } catch (e){
            console.error('callback flow error:', e);
            alert('Verification or email step failed. Check console.');
            if(proceedBtn){ proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
          }
        })();
      },

      onClose: function(){
        if(proceedBtn){ proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
        alert('Payment window closed.');
      }
    });

    handler.openIframe();

  } catch(err){
    console.error('proceedToPayment error:', err);
    alert(err.message || 'Payment failed to start.');
    if(proceedBtn){ proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
  }
}
