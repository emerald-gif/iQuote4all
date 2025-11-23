// public/main.js
// Loads products from server (/api/products) - no local PRODUCTS array anymore

// FIREBASE CONFIG (unchanged)
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

// runtime config
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let PAYSTACK_READY = false;
let selectedProduct = null;
let PRODUCTS = []; // fetched from server

async function initConfigAndPaystack() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || null;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || null;

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
  } catch (e) { console.warn('config init failed', e); }
}
initConfigAndPaystack();

function toggleSidebar(){ const sidebar = document.getElementById('sidebar'); sidebar.style.left = sidebar.style.left === '0px' ? '-280px' : '0px'; }
function openMyOrders(){ window.location.href = '/my-order.html'; }
function openContact(){ alert('Contact: mindshiftbooks@example.com'); }
function followYoutube(){ window.open('https://youtube.com'); }

// Fetch products from server
async function fetchProducts() {
  try {
    const res = await fetch('/api/products');
    const j = await res.json();
    PRODUCTS = (j && j.products) ? j.products : [];
    renderProducts();
  } catch (e) {
    console.error('Failed to fetch products', e);
    document.getElementById('productGrid').innerHTML = '<div style="padding:20px;">Failed to load products.</div>';
  }
}

// Render product grid from PRODUCTS (from server)
function renderProducts(){
  const grid = document.getElementById('productGrid');
  grid.innerHTML = '';
  PRODUCTS.forEach(p => {
    const card = document.createElement('div'); card.className = 'product-card';
    card.innerHTML = `
      <img src="${p.cover}" class="ebook-cover" alt="${p.title}" />
      <div class="title">${p.title}</div>
      <div class="price">$${Number(p.priceUSD).toFixed(2)}</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn review-btn" onclick="openReview('${p.id}')">Read Review</button>
        <button class="btn buy-btn" onclick="openCheckoutModal('${p.id}')">Buy eBook</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

// initial load
fetchProducts();

// Review navigation
function openReview(productId){
  window.location.href = `/review.html?id=${encodeURIComponent(productId)}`;
}

// Modal and payment logic: when user clicks buy, we still send productId to /api/pay
const modalBackdrop = document.getElementById('modalBackdrop');
function openCheckoutModal(productId){
  selectedProduct = PRODUCTS.find(x=>x.id===productId);
  if(!selectedProduct) { alert('Product not found'); return; }
  document.getElementById('modalBookTitle').textContent = selectedProduct.title;
  document.getElementById('modalPrice').textContent = `Price: $${Number(selectedProduct.priceUSD).toFixed(2)}`;
  document.getElementById('buyerEmail').value = '';
  document.getElementById('buyerName').value = '';
  modalBackdrop.style.display = 'flex';
}
function closeCheckoutModal(){ modalBackdrop.style.display = 'none'; }

async function proceedToPayment(){
  const email = (document.getElementById('buyerEmail') || {value:''}).value.trim();
  const name = (document.getElementById('buyerName') || {value:''}).value.trim();
  if(!email || !/^\S+@\S+\.\S+$/.test(email)){ alert('Please enter a valid email'); return; }
  if(!selectedProduct){ alert('No product selected'); return; }

  const btn = document.getElementById('modalProceedBtn'); btn.disabled = true; btn.textContent = 'Preparing...';

  try {
    const resp = await fetch('/api/pay', {
      method: 'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, productId: selectedProduct.id })
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error || 'Payment initialization failed');

    const { reference, amount } = data;

    const timeoutAt = Date.now() + 5000;
    while(!PAYSTACK_READY && Date.now() < timeoutAt) await new Promise(r=>setTimeout(r,100));
    if(!window.PaystackPop) throw new Error('Paystack not available');
    if(!PAYSTACK_PUBLIC_KEY) throw new Error('Missing Paystack public key');

    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: Math.round(Number(amount) * 100),
      currency: 'NGN',
      ref: reference,
      metadata: { custom_fields:[{ display_name:'Buyer name', variable_name:'buyer_name', value: name||'' }], productId: selectedProduct.id },
      callback: function(response){ verifyPayment(response.reference, email); },
      onClose: function(){ btn.disabled=false; btn.textContent='Proceed to Payment'; alert('Payment closed.'); }
    });
    handler.openIframe();

  } catch(err){ console.error(err); alert(err.message || 'Payment failed'); }
  btn.disabled=false; btn.textContent='Proceed to Payment';
}

async function verifyPayment(reference, purchaserEmail){
  try{
    const res = await fetch('/api/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ reference, purchaserEmail }) });
    const data = await res.json();
    if(res.ok && data.status === 'success'){
      alert('Payment successful! The file will be emailed shortly.');
      window.location.href = '/';
    } else {
      console.warn('verify failed', data); alert('Verification failed. Contact support.');
    }
  }catch(e){ console.error(e); alert('Verification request failed.'); }
}

// expose to window
window.toggleSidebar = toggleSidebar;
window.openMyOrders = openMyOrders;
window.openContact = openContact;
window.followYoutube = followYoutube;
window.openCheckoutModal = openCheckoutModal;
window.closeCheckoutModal = closeCheckoutModal;
window.proceedToPayment = proceedToPayment;
window.openReview = openReview;
