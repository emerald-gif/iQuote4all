// Firebase config
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

// Sidebar toggle
function toggleSidebar(){
  const sidebar = document.getElementById('sidebar');
  sidebar.style.left = sidebar.style.left === '0px' ? '-280px' : '0px';
}

// Placeholder functions
function showReview(){ alert("Reviews coming soon!"); }
function showTransaction(){ alert("Transactions coming soon!"); }

// Paystack checkout
function buyEbook(){
  const handler = PaystackPop.setup({
    key: 'YOUR_PAYSTACK_PUBLIC_KEY',
    email: prompt("Enter your email to receive eBook"),
    amount: 1599 * 100, // $15.99 in kobo
    currency: "USD",
    ref: ''+Math.floor(Math.random() * 1000000000 + 1),
    callback: function(response){
      alert('Payment successful. Ref: ' + response.reference);
      // send to backend for verification
      fetch('/verify', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({reference: response.reference})
      });
    },
    onClose: function(){ alert('Payment cancelled'); }
  });
  handler.openIframe();
}
