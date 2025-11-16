// =============================
// Firebase Config
// =============================
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

// =============================
// Sidebar toggle
// =============================
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.style.left = sidebar.style.left === "0px" ? "-280px" : "0px";
}

// =============================
// Show Review / Transactions (Temp)
// =============================
function showReview() {
  alert("Reviews coming soon!");
}

function showTransaction() {
  window.location.href = "/orders.html";
}

// =============================
// Open Checkout Modal
// =============================
function buyEbook() {
  document.getElementById("checkoutModal").style.display = "flex";
}

function closeCheckout() {
  document.getElementById("checkoutModal").style.display = "none";
}

// =============================
// Proceed To Payment
// =============================
async function proceedToPayment() {
  const emailInput = document.getElementById("checkoutEmail");
  const email = emailInput.value.trim();

  if (!email) {
    alert("Please enter your email.");
    return;
  }

  try {
    const response = await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        amount: 15.99,
        productId: "ultimate_quote_bundle"
      })
    });

    const data = await response.json();

    if (!data.authorization_url) {
      alert("Payment initialization failed.");
      return;
    }

    window.location.href = data.authorization_url;
  } catch (err) {
    console.error(err);
    alert("Error starting payment.");
  }
}

// =============================
// Load Past Orders
// =============================
async function loadOrders() {
  const container = document.getElementById("ordersContainer");
  container.innerHTML = "Loading...";

  try {
    const response = await fetch("/api/transactions");
    const orders = await response.json();

    if (!orders.length) {
      container.innerHTML = "<p>No orders found.</p>";
      return;
    }

    container.innerHTML = orders
      .map(order => `
        <div class="order-card">
          <h3>Ultimate Quote Bundle</h3>
          <p><strong>Email:</strong> ${order.email}</p>
          <p><strong>Amount:</strong> $${order.amount}</p>
          <p><strong>Status:</strong> ${order.status}</p>
          <p><strong>Reference:</strong> ${order.reference}</p>
        </div>
      `)
      .join("");
  } catch (err) {
    console.error(err);
    container.innerHTML = "Error loading orders.";
  }
}
