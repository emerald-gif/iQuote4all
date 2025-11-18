// public/main.js
// Minimal, robust client flow: Paystack inline -> server verify -> EmailJS send (client-side)

// FIREBASE (unchanged -- keep if you use firestore from client; not required for email flow)
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
  try { firebase.initializeApp(firebaseConfig); } catch (e) { /* already initialized */ }
}
const db = (typeof firebase !== "undefined" && firebase.firestore) ? firebase.firestore() : null;

// Runtime config loaded from server (/config) or fallback to these built-ins
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let USD_PRICE = 15.99;
let PAYSTACK_READY = false;

// ---------- DEFAULT EmailJS client-side keys (you provided these) ----------
const FALLBACK_EMAILJS_PUBLIC_KEY = "0OK3wHLwcQC2wm6MZ";
const FALLBACK_EMAILJS_SERVICE_ID = "service_ehmelnw";
const FALLBACK_EMAILJS_TEMPLATE_ID = "template_jyuafkt";

let EMAILJS_PUBLIC_KEY = FALLBACK_EMAILJS_PUBLIC_KEY;
let EMAILJS_SERVICE_ID = FALLBACK_EMAILJS_SERVICE_ID;
let EMAILJS_TEMPLATE_ID = FALLBACK_EMAILJS_TEMPLATE_ID;

// Load server /config and ensure Paystack & EmailJS libs are loaded
async function initConfigSync() {
  try {
    const res = await fetch('/config');
    if (res.ok) {
      const cfg = await res.json();
      PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || PAYSTACK_PUBLIC_KEY;
      PUBLIC_PDF_URL = cfg.publicPdfUrl || PUBLIC_PDF_URL;
      USD_PRICE = Number(cfg.usdPrice || USD_PRICE);

      const emailCfg = cfg.emailjs || {};
      // server may or may not expose these; fall back to provided
      EMAILJS_PUBLIC_KEY = emailCfg.publicKey || EMAILJS_PUBLIC_KEY;
      EMAILJS_SERVICE_ID = emailCfg.serviceId || EMAILJS_SERVICE_ID;
      EMAILJS_TEMPLATE_ID = emailCfg.templateId || EMAILJS_TEMPLATE_ID;
    } else {
      console.warn('/config not found or not OK, using local defaults');
    }
  } catch (e) {
    console.warn('Failed to fetch /config, using defaults:', e);
  }

  // Ensure Paystack inline is present (we recommend adding the <script> tag in index.html)
  if (!window.PaystackPop) {
    console.warn('Paystack inline not found. You must include <script src="https://js.paystack.co/v1/inline.js"></script> in index.html before this script.');
  } else {
    // nice to know
    console.log('Paystack inline available');
  }

  // Ensure EmailJS SDK present — if present, init with public key
  if (window.emailjs) {
    try {
      emailjs.init(EMAILJS_PUBLIC_KEY);
      console.log('EmailJS initialized (public key):', EMAILJS_PUBLIC_KEY);
    } catch (e) {
      console.warn('emailjs.init failed:', e);
    }
  } else {
    console.warn('EmailJS SDK not loaded. Include <script src="https://cdn.emailjs.com/sdk/3.2.0/email.min.js"></script> in index.html before this script.');
  }

  PAYSTACK_READY = true;
}
initConfigSync();


// ---------------- UI helpers (unchanged)
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.style.left = sidebar.style.left === "0px" ? "-280px" : "0px";
}
function openCheckoutModal() {
  const e = document.getElementById('buyerEmail');
  const n = document.getElementById('buyerName');
  if (e) e.value = '';
  if (n) n.value = '';
  const modalBackdrop = document.getElementById('modalBackdrop');
  if (modalBackdrop) modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal() {
  const modalBackdrop = document.getElementById('modalBackdrop');
  if (modalBackdrop) modalBackdrop.style.display = 'none';
}


// ---------------- Payment flow (client inline + client-side EmailJS)
async function proceedToPayment() {
  const emailInput = document.getElementById('buyerEmail');
  const nameInput = document.getElementById('buyerName');
  const email = emailInput?.value?.trim();
  const name = nameInput?.value?.trim();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    alert('Please enter a valid email address.');
    return;
  }

  const proceedBtn = document.querySelector('.modal .buy-btn');
  if (proceedBtn) { proceedBtn.disabled = true; proceedBtn.textContent = 'Preparing...'; }

  try {
    // 1) Ask server to initialize Paystack (server calculates NGN amount)
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const init = await resp.json();
    if (!resp.ok) throw new Error(init.error || 'Server failed to initialize payment.');
    const { reference, amount } = init;
    if (!reference) throw new Error('No reference returned from server.');

    // 2) Wait shortly for libs (we already load SDKs via index.html, but double-check)
    const timeoutAt = Date.now() + 5000;
    while (!PAYSTACK_READY && Date.now() < timeoutAt) { await new Promise(r => setTimeout(r, 100)); }
    if (!PAYSTACK_READY) throw new Error('Client not ready. Reload the page.');

    if (!window.PaystackPop) throw new Error('Paystack inline script missing from page.');
    if (!PAYSTACK_PUBLIC_KEY) console.warn('Paystack public key not provided from /config; using PaystackPop.setup with window variable if set.');
    const pubKey = PAYSTACK_PUBLIC_KEY || window.PAYSTACK_PUBLIC_KEY;
    if (!pubKey) throw new Error('Paystack public key missing from server /config or page.');

    // 3) Setup Paystack inline (callback is plain function)
    const handler = PaystackPop.setup({
      key: pubKey,
      email: email,
      amount: Math.round(Number(amount) * 100), // kobo
      currency: 'NGN',
      ref: reference,
      metadata: {
        custom_fields: [{ display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }]
      },

      // on success from Paystack
      callback: function (response) {
        // Immediately verify with server and then send email from client
        (async () => {
          try {
            const verifyRes = await fetch('/api/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference: response.reference, purchaserEmail: email })
            });
            const verifyJson = await verifyRes.json();
            if (!verifyRes.ok || verifyJson.status !== 'success') {
              console.error('Server verify failed:', verifyJson);
              alert('Payment succeeded but server verification failed. Check the console.');
              if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
              return;
            }

            // verifyJson.data contains: reference, email, amount, currency, download_link, book_name, emailjs (maybe)
            const payload = verifyJson.data;

            // Prefer EmailJS keys from verify response or previously loaded config
            const serviceId = (payload?.emailjs?.serviceId) || EMAILJS_SERVICE_ID;
            const templateId = (payload?.emailjs?.templateId) || EMAILJS_TEMPLATE_ID;
            const publicKey = (payload?.emailjs?.publicKey) || EMAILJS_PUBLIC_KEY;

            if (window.emailjs && publicKey && serviceId && templateId) {
              try {
                // ensure emailjs is initialised with the same public key we will use
                try { emailjs.init(publicKey); } catch (e) { /* already init or harmless */ }

                const templateParams = {
                  to_email: payload.email,
                  book_name: payload.book_name,
                  download_link: payload.download_link,
                  reference: payload.reference
                };

                // send email
                const sendResult = await emailjs.send(serviceId, templateId, templateParams);
                console.log('EmailJS send OK:', sendResult);
                alert('Payment successful — check your email for your download link.');
              } catch (ee) {
                console.error('EmailJS send error:', ee);
                alert('Payment verified but email failed to send. Check console for details.');
              }
            } else {
              console.warn('EmailJS client not configured. serviceId/templateId/publicKey:', serviceId, templateId, publicKey);
              alert('Payment verified. Email not sent because EmailJS client keys are missing.');
            }

            // cleanup / redirect
            if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
            // optional: redirect or show success page
            // window.location.href = '/';
          } catch (e) {
            console.error('Post-payment callback failed:', e);
            alert('Verification or email step failed. Check console.');
            if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
          }
        })();
      },

      onClose: function () {
        if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
        alert('Payment window closed.');
      }
    });

    handler.openIframe();

  } catch (err) {
    console.error('proceedToPayment error:', err);
    alert(err.message || 'Payment failed to start.');
    if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
  }
}


// Optional small helper for manual verify
async function verifyPayment(reference, purchaserEmail) {
  const res = await fetch('/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, purchaserEmail })
  });
  return res.json();
}
