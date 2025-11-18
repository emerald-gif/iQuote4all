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

// -----------------------
// CLIENT-SIDE CONFIG
// -----------------------

// YOUR EmailJS client keys (placed directly in client as requested)
// NOTE: This is less secure (public key visible to user). Works fine for test mode & quick flow.
const EMAILJS_PUBLIC_KEY = "0OK3wHLwcQC2wm6MZ";
const EMAILJS_SERVICE_ID = "service_ehmelnw";
const EMAILJS_TEMPLATE_ID = "template_jyuafkt";

// runtime config (fetched from /config)
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let USD_PRICE = 15.99;
let PAYSTACK_READY = false;

// load config and ensure Paystack & EmailJS are initialized
async function initConfigAndSdks() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || null;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || null;
    USD_PRICE = cfg.usdPrice || USD_PRICE;

    // Load EmailJS SDK if not already loaded (optional - recommended to include via <script>)
    if (!window.emailjs) {
      // try dynamic inject (if you didn't include the script tag)
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.emailjs.com/sdk/3.2/email.min.js';
          s.async = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('Failed to load EmailJS SDK'));
          document.head.appendChild(s);
        });
      } catch (e) {
        console.warn('EmailJS SDK not available:', e);
      }
    }

    // Initialize EmailJS client with PUBLIC KEY
    if (window.emailjs) {
      try {
        emailjs.init(EMAILJS_PUBLIC_KEY);
        console.log('EmailJS initialized (client-side).');
      } catch (e) {
        console.warn('EmailJS init failed:', e);
      }
    } else {
      console.warn('EmailJS not loaded. Email sending will not work until SDK is included.');
    }

    // Load Paystack inline if not present (recommended to include script tag instead)
    if (!window.PaystackPop) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://js.paystack.co/v1/inline.js';
          s.async = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('Failed to load Paystack inline script'));
          document.head.appendChild(s);
        });
      } catch (e) {
        console.warn('Failed to load Paystack inline script:', e);
      }
    }

    PAYSTACK_READY = true;
    console.log('Init finished. PAYSTACK_PUBLIC_KEY present:', !!PAYSTACK_PUBLIC_KEY, 'PUBLIC_PDF_URL:', !!PUBLIC_PDF_URL);

  } catch (err) {
    console.warn('Failed to init config or SDKs:', err);
  }
}
initConfigAndSdks();

// -----------------------
// UI helpers & carousel (unchanged)
// -----------------------
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.style.left = sidebar.style.left === "0px" ? "-280px" : "0px";
}
function showReview() { window.location.href = "/review.html"; }
function followYoutube() { window.open("https://youtube.com/@iquote4all?si=pnSVWwSmgvO5VFNl"); }
function openContact() { alert("Contact: iquote4all@gmail.com"); }

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

// Transactions listing (debug)
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
  const emailEl = document.getElementById('buyerEmail');
  const nameEl = document.getElementById('buyerName');
  if (emailEl) emailEl.value = '';
  if (nameEl) nameEl.value = '';
  if (modalBackdrop) modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal() { if (modalBackdrop) modalBackdrop.style.display = 'none'; }
if (modalBackdrop) modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeCheckoutModal(); });

// ----------------- Payment flow (inline) -----------------
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
    // 1) init on server
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const init = await resp.json();
    if (!resp.ok) throw new Error(init.error || 'Failed to initialize payment.');

    const { reference, amount } = init;
    if (!reference) throw new Error('No reference returned from server.');

    // 2) ensure client SDKs loaded
    const timeoutAt = Date.now() + 5000;
    while (!PAYSTACK_READY && Date.now() < timeoutAt) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!PAYSTACK_READY) throw new Error('Client SDKs not ready. Reload the page.');

    if (!window.PaystackPop) throw new Error('Paystack inline script missing. Include https://js.paystack.co/v1/inline.js');

    // prefer server-provided public key if any; else fall back to window var
    if (!PAYSTACK_PUBLIC_KEY) PAYSTACK_PUBLIC_KEY = window.PAYSTACK_PUBLIC_KEY || PAYSTACK_PUBLIC_KEY;
    if (!PAYSTACK_PUBLIC_KEY) throw new Error('Paystack public key not configured on server (/config).');

    // 3) Setup inline
    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: Math.round(Number(amount) * 100), // NGN -> kobo
      currency: 'NGN',
      ref: reference,
      metadata: {
        custom_fields: [{ display_name: 'Buyer name', variable_name: 'buyer_name', value: name || '' }]
      },
      callback: function (response) {
        // Payment succeeded on Paystack side — now call our server to verify & record,
        // then send EmailJS from the client.
        (async () => {
          try {
            const verifyRes = await fetch('/api/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference: response.reference, purchaserEmail: email })
            });
            const verifyJson = await verifyRes.json();
            if (!verifyRes.ok) {
              console.error('Server verify returned error:', verifyJson);
              alert('Payment succeeded but server verify failed. Check console.');
              if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
              return;
            }

            if (verifyJson.status !== 'success') {
              console.warn('verify response:', verifyJson);
              alert('Payment not verified. Contact support.');
              if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
              return;
            }

            // verifyJson.data contains { reference, email, amount, currency, download_link, book_name }
            const payload = verifyJson.data;

            // 4) SEND EMAIL using EmailJS from client
            if (window.emailjs && EMAILJS_PUBLIC_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID) {
              try {
                const templateParams = {
                  to_email: payload.email,
                  book_name: payload.book_name,
                  download_link: payload.download_link,
                  reference: payload.reference
                };

                const sendResult = await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams);
                console.log('EmailJS send result:', sendResult);
                alert('Payment successful! Download link sent to your email.');
              } catch (e) {
                console.error('EmailJS send failed:', e);
                alert('Payment verified but failed to send email. Check console for details.');
              }
            } else {
              console.warn('EmailJS client not configured (SDK or keys missing).');
              alert('Payment verified. But email sending is not configured.');
            }

            if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
            window.location.href = '/';
          } catch (e) {
            console.error('Error in callback flow:', e);
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

    // open inline on same page
    handler.openIframe();

  } catch (err) {
    console.error('proceedToPayment error:', err);
    alert(err.message || 'Payment failed to start.');
    const proceedBtn = document.querySelector('.modal .buy-btn');
    if (proceedBtn) { proceedBtn.disabled = false; proceedBtn.textContent = 'Proceed to payment'; }
  }
}

// manual verify helper (if you need to call verify separately)
async function verifyPayment(reference, purchaserEmail) {
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, purchaserEmail })
    });
    return await res.json();
  } catch (err) {
    console.error('verifyPayment error:', err);
    throw err;
  }
}
