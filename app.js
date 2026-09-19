/* ============================================================
   פנקס ההוצאות — לוגיקת האפליקציה
   ============================================================ */

// ---------- Theme (light/dark/system) ----------
const darkMediaQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function resolveEffectiveTheme(pref) {
  if (pref === "system") {
    return darkMediaQuery && darkMediaQuery.matches ? "dark" : "light";
  }
  return pref;
}

function applyTheme(pref) {
  const effective = resolveEffectiveTheme(pref);
  document.documentElement.setAttribute("data-theme", effective);
  document.getElementById("theme-icon-sun").style.display = pref === "light" ? "" : "none";
  document.getElementById("theme-icon-moon").style.display = pref === "dark" ? "" : "none";
  document.getElementById("theme-icon-system").style.display = pref === "system" ? "" : "none";
  document.getElementById("meta-theme-color").setAttribute("content", effective === "dark" ? "#1B1A17" : "#1F6F5C");
}

function initTheme() {
  const saved = localStorage.getItem("theme-preference");
  const pref = saved || "system";
  applyTheme(pref);
  if (darkMediaQuery && darkMediaQuery.addEventListener) {
    darkMediaQuery.addEventListener("change", () => {
      const current = localStorage.getItem("theme-preference") || "system";
      if (current === "system") applyTheme("system"); // live-follow OS changes, only while in system mode
    });
  }
}

document.getElementById("theme-toggle-btn").addEventListener("click", () => {
  const order = ["light", "dark", "system"];
  const current = localStorage.getItem("theme-preference") || "system";
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
  localStorage.setItem("theme-preference", next);
  // re-render the current chart so its text/border colors match the new theme
  if (state.categoriesLoaded && state.expensesLoaded && state.currentPage === "insights") renderChart();
});

function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}
function chartAxisColor() { return isDarkTheme() ? "#A79F8F" : "#6E685D"; }
function chartGridColor() { return isDarkTheme() ? "rgba(255,255,255,0.08)" : "rgba(36,34,29,0.08)"; }
function chartCardBg() { return isDarkTheme() ? "#26241D" : "#FFFFFF"; }

initTheme();

// ---------- Firebase init ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("Offline persistence not enabled:", err.code);
});

// ---------- Constants ----------
const DEFAULT_CATEGORIES = [
  { id: "food", name: "מזון", color: "#1F6F5C", budget: 1500 },
  { id: "transport", name: "תחבורה", color: "#4C7A99", budget: 500 },
  { id: "housing", name: "דיור", color: "#8B5E3C", budget: 4000 },
  { id: "fun", name: "בילויים", color: "#C97B3D", budget: 400 },
  { id: "health", name: "בריאות", color: "#A3475A", budget: 300 },
  { id: "shopping", name: "קניות", color: "#6C5B7B", budget: 400 },
  { id: "bills", name: "חשבונות", color: "#556B2F", budget: 600 },
  { id: "other", name: "אחר", color: "#7A7368", budget: 200 },
];

const COLOR_PALETTE = [
  "#1F6F5C", "#4C7A99", "#8B5E3C", "#C97B3D",
  "#A3475A", "#6C5B7B", "#556B2F", "#7A7368",
  "#3D6B8A", "#9A6A2F", "#3F7D5C", "#8A4A6E",
];

const HEBREW_MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

const PAYMENT_METHODS = [
  { id: "credit", name: "אשראי" },
  { id: "cash", name: "מזומן" },
];

// ---------- State ----------
let state = {
  user: null,
  categories: [],       // [{id, name, color, budget}]
  expenses: [],         // all expenses loaded for current user (we keep full list, filter client-side by month)
  currentMonth: new Date().getMonth(),
  currentYear: new Date().getFullYear(),
  chartMode: "pie",
  currentPage: "home",
  editingCategoryId: null,
  unsubExpenses: null,
  unsubCategories: null,
  categoriesLoaded: false,
  expensesLoaded: false,
};

let chartInstance = null;

// ---------- Helpers ----------
function fmtNum(n) {
  return Math.round(n).toLocaleString("en-US");
}
function monthKey(y, m) {
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._tm);
  showToast._tm = setTimeout(() => t.classList.remove("show"), 2200);
}
function setSyncDot(mode) {
  const dot = document.getElementById("sync-dot");
  dot.classList.remove("on", "busy");
  if (mode === "on") dot.classList.add("on");
  if (mode === "busy") dot.classList.add("busy");
}
function catById(id) {
  return state.categories.find(c => c.id === id) || { id: "other", name: "אחר", color: "#7A7368", budget: 0 };
}
function paymentName(id) {
  return (PAYMENT_METHODS.find(p => p.id === id) || PAYMENT_METHODS[0]).name;
}
function expensesForCurrentMonth() {
  const key = monthKey(state.currentYear, state.currentMonth);
  return state.expenses.filter(e => e.date && e.date.startsWith(key));
}

// ============================================================
// APP NAVIGATION
// ============================================================
const APP_PAGES = new Set(["home", "categories", "insights", "expenses"]);
const bottomNav = document.querySelector(".bottom-nav");
const navActivePill = bottomNav?.querySelector(".nav-active-pill");
let navIndicatorFrame = 0;

function syncNavActivePill(animate = true) {
  if (!bottomNav || !navActivePill) return;
  const activeBtn = bottomNav.querySelector(".nav-btn.active[data-page-target]");
  if (!activeBtn) return;

  cancelAnimationFrame(navIndicatorFrame);
  navIndicatorFrame = requestAnimationFrame(() => {
    // The app is hidden while logged out. Wait until the nav has real
    // dimensions so the indicator never animates in from a bogus 0px slot.
    if (!bottomNav.offsetWidth || !activeBtn.offsetWidth) return;

    const inset = 4;
    const shouldAnimate = animate && bottomNav.classList.contains("nav-ready");
    if (!shouldAnimate) navActivePill.classList.add("no-animate");

    navActivePill.style.width = `${Math.max(0, activeBtn.offsetWidth - inset * 2)}px`;
    navActivePill.style.transform = `translate3d(${activeBtn.offsetLeft + inset}px, 0, 0)`;
    bottomNav.classList.add("nav-ready");

    if (!shouldAnimate) {
      requestAnimationFrame(() => navActivePill.classList.remove("no-animate"));
    }
  });
}

document.querySelectorAll(".nav-btn[data-page-target]").forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.pageTarget));
});

function switchPage(page) {
  if (!APP_PAGES.has(page)) return;
  state.currentPage = page;

  document.querySelectorAll(".app-page").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
  });
  document.querySelectorAll(".nav-btn[data-page-target]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.pageTarget === page);
  });
  syncNavActivePill(true);

  // A Chart.js canvas must be measured while visible. Rebuild it only when
  // the insights page is actually on screen, avoiding zero-size charts.
  if (page === "insights" && state.categoriesLoaded && state.expensesLoaded) {
    requestAnimationFrame(() => renderChart());
  }
}

// Keep the moving selector exactly under its tab after rotations/resizes.
window.addEventListener("resize", () => syncNavActivePill(false), { passive: true });
requestAnimationFrame(() => syncNavActivePill(false));

// ============================================================
// AUTH
// ============================================================
let authMode = "login"; // or "signup"

const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const authSwitchLink = document.getElementById("auth-switch-link");
const authSwitchText = document.getElementById("auth-switch-text");
const authSubtitle = document.getElementById("auth-subtitle");

authSwitchLink.addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  updateAuthUI();
});

function updateAuthUI() {
  authError.style.display = "none";
  if (authMode === "login") {
    authSubmit.textContent = "התחברות";
    authSwitchText.textContent = "אין לכם חשבון עדיין?";
    authSwitchLink.textContent = "להרשמה";
    authSubtitle.textContent = "התחברו כדי לנהל ולסנכרן את ההוצאות שלכם בכל המכשירים";
  } else {
    authSubmit.textContent = "יצירת חשבון";
    authSwitchText.textContent = "כבר יש לכם חשבון?";
    authSwitchLink.textContent = "להתחברות";
    authSubtitle.textContent = "צרו חשבון חדש — הנתונים שלכם יסתנכרנו אוטומטית בכל מכשיר";
  }
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  authError.style.display = "none";
  authSubmit.disabled = true;
  authSubmit.textContent = "רגע...";
  try {
    if (authMode === "login") {
      await auth.signInWithEmailAndPassword(email, password);
    } else {
      await auth.createUserWithEmailAndPassword(email, password);
    }
  } catch (err) {
    authError.textContent = translateAuthError(err);
    authError.style.display = "block";
  } finally {
    authSubmit.disabled = false;
    updateAuthUI();
  }
});

function translateAuthError(err) {
  const map = {
    "auth/invalid-email": "כתובת האימייל אינה תקינה.",
    "auth/user-not-found": "לא נמצא חשבון עם אימייל זה.",
    "auth/wrong-password": "סיסמה שגויה.",
    "auth/invalid-credential": "אימייל או סיסמה שגויים.",
    "auth/email-already-in-use": "כבר קיים חשבון עם אימייל זה.",
    "auth/weak-password": "הסיסמה חייבת להכיל לפחות 6 תווים.",
    "auth/network-request-failed": "בעיית רשת - בדקו את החיבור לאינטרנט.",
  };
  return map[err.code] || "משהו השתבש. נסו שוב.";
}

document.getElementById("logout-btn").addEventListener("click", () => {
  if (confirm("להתנתק מהחשבון?")) auth.signOut();
});

let bootHidden = false;
function hideBootLoader() {
  if (bootHidden) return;
  bootHidden = true;
  document.getElementById("boot-loader").classList.add("hide");
}

auth.onAuthStateChanged((user) => {
  state.user = user;
  if (user) {
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    switchPage("home");
    attachListeners(user.uid);
    // boot loader stays up until the data listeners below report real data loaded
  } else {
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    detachListeners();
    hideBootLoader(); // nothing to wait for when logged out
  }
});

// ============================================================
// FIRESTORE LISTENERS
// ============================================================
function attachListeners(uid) {
  setSyncDot("busy");

  // Categories (single doc holding array, simplest for small personal lists)
  const catDocRef = db.collection("users").doc(uid).collection("meta").doc("categories");
  state.unsubCategories = catDocRef.onSnapshot(async (snap) => {
    if (!snap.exists) {
      await catDocRef.set({ list: DEFAULT_CATEGORIES });
      return;
    }
    state.categories = snap.data().list || [];
    state.categoriesLoaded = true;
    if (state.categoriesLoaded && state.expensesLoaded) hideBootLoader();
    renderAll();
  }, (err) => {
    console.error(err);
    showToast("שגיאת סנכרון קטגוריות");
  });

  // Expenses collection, ordered by date desc
  const expRef = db.collection("users").doc(uid).collection("expenses");
  state.unsubExpenses = expRef.orderBy("date", "desc").onSnapshot((snap) => {
    state.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.expensesLoaded = true;
    if (state.categoriesLoaded && state.expensesLoaded) hideBootLoader();
    setSyncDot("on");
    renderAll();
  }, (err) => {
    console.error(err);
    setSyncDot("busy");
    showToast("שגיאת סנכרון הוצאות");
  });
}

function detachListeners() {
  if (state.unsubExpenses) state.unsubExpenses();
  if (state.unsubCategories) state.unsubCategories();
  state.expenses = [];
  state.categories = [];
  state.categoriesLoaded = false;
  state.expensesLoaded = false;
}

function saveCategories() {
  if (!state.user) return;
  return db.collection("users").doc(state.user.uid).collection("meta").doc("categories")
    .set({ list: state.categories });
}

// ============================================================
// MONTH NAVIGATION
// ============================================================
document.getElementById("prev-month").addEventListener("click", () => shiftMonth(-1));
document.getElementById("next-month").addEventListener("click", () => shiftMonth(1));
document.getElementById("goto-today").addEventListener("click", () => {
  const now = new Date();
  state.currentMonth = now.getMonth();
  state.currentYear = now.getFullYear();
  renderAll();
});

function shiftMonth(delta) {
  // Note: UI arrows are visually mirrored for RTL reading (prev-month button on the right moves forward)
  state.currentMonth += delta;
  if (state.currentMonth > 11) { state.currentMonth = 0; state.currentYear++; }
  if (state.currentMonth < 0) { state.currentMonth = 11; state.currentYear--; }
  renderAll();
}

// ============================================================
// RENDER
// ============================================================
function renderAll() {
  if (!state.user) return;
  renderMonthLabel();
  safeRender(renderReceipt, "receipt");
  safeRender(renderCategoryList, "category-list");
  if (state.currentPage === "insights") safeRender(renderChart, "chart");
  safeRender(renderExpenseList, "expense-list");
}

function safeRender(fn, label) {
  try {
    fn();
  } catch (err) {
    console.error(`Render error in ${label}:`, err);
  }
}

function renderMonthLabel() {
  document.getElementById("month-name").textContent =
    `${HEBREW_MONTHS[state.currentMonth]} ${state.currentYear}`;
  const now = new Date();
  const isCurrent = state.currentMonth === now.getMonth() && state.currentYear === now.getFullYear();
  document.getElementById("goto-today").style.visibility = isCurrent ? "hidden" : "visible";
}

function renderReceipt() {
  const monthExpenses = expensesForCurrentMonth();
  const total = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
  const totalBudget = state.categories.reduce((s, c) => s + Number(c.budget || 0), 0);
  const remaining = totalBudget - total;
  const pct = totalBudget > 0 ? Math.min(100, (total / totalBudget) * 100) : 0;

  document.getElementById("total-spent").textContent = fmtNum(total);
  document.getElementById("total-budget").textContent = fmtNum(totalBudget);

  const bar = document.getElementById("total-bar");
  bar.style.width = pct + "%";
  bar.classList.toggle("over", remaining < 0);

  const metaWrap = document.getElementById("total-meta");
  metaWrap.classList.toggle("alert", remaining < 0);
  document.getElementById("total-remaining-wrap").innerHTML = remaining < 0
    ? `חריגה של <b class="num">${fmtNum(Math.abs(remaining))}</b> ₪`
    : `נותרו <b class="num">${fmtNum(remaining)}</b> ₪`;

  // stats
  document.getElementById("stat-count").textContent = monthExpenses.length;
  const daysSoFar = getDaysElapsedInMonth();
  document.getElementById("stat-avg").textContent = fmtNum(daysSoFar > 0 ? total / daysSoFar : 0);

  const byCat = {};
  monthExpenses.forEach(e => { byCat[e.categoryId] = (byCat[e.categoryId] || 0) + Number(e.amount); });
  const topCatId = Object.keys(byCat).sort((a,b) => byCat[b]-byCat[a])[0];
  document.getElementById("stat-top").textContent = topCatId ? catById(topCatId).name : "—";


}

function getDaysElapsedInMonth() {
  const now = new Date();
  if (state.currentYear === now.getFullYear() && state.currentMonth === now.getMonth()) {
    return now.getDate();
  }
  // past or future month -> use full days in that month for average context
  return new Date(state.currentYear, state.currentMonth + 1, 0).getDate();
}

function renderCategoryList() {
  const wrap = document.getElementById("category-list");
  const monthExpenses = expensesForCurrentMonth();
  const spentByCat = {};
  monthExpenses.forEach(e => { spentByCat[e.categoryId] = (spentByCat[e.categoryId] || 0) + Number(e.amount); });

  if (state.categories.length === 0) {
    wrap.innerHTML = `<div class="empty-hint">אין עדיין קטגוריות. הוסיפו אחת כדי להתחיל לתקצב.</div>`;
    
    return;
  }

  wrap.innerHTML = state.categories.map(cat => {
    const spent = spentByCat[cat.id] || 0;
    const budget = Number(cat.budget || 0);
    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : (spent > 0 ? 100 : 0);
    const over = budget > 0 && spent > budget;
    return `
      <div class="cat-row" data-cat-id="${cat.id}">
        <span class="cat-dot" style="background:${cat.color}"></span>
        <div class="cat-info">
          <div class="cat-top">
            <span class="cat-name">${escapeHtml(cat.name)}</span>
            <span class="cat-amounts num"><b>${fmtNum(spent)}</b> ${budget > 0 ? `/ ${fmtNum(budget)}` : ""} ₪</span>
          </div>
          <div class="cat-track"><div class="cat-fill" style="width:${pct}%; background:${over ? 'var(--alert)' : cat.color}"></div></div>
        </div>
      </div>`;
  }).join("");

  wrap.querySelectorAll(".cat-row").forEach(row => {
    row.addEventListener("click", () => openCategoryModal(row.dataset.catId));
  });

  
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Charts ----------
document.querySelectorAll(".chart-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".chart-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    state.chartMode = tab.dataset.chart;
    renderChart();
  });
});

function renderChart() {
  const ctx = document.getElementById("chart-canvas");
  ctx.style.display = "";
  const monthExpenses = expensesForCurrentMonth();

  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  const legend = document.getElementById("chart-legend");

  if (state.chartMode === "payment") {
    renderPaymentChart(ctx, legend, monthExpenses);
    
    return;
  }

  const spentByCat = {};
  monthExpenses.forEach(e => { spentByCat[e.categoryId] = (spentByCat[e.categoryId] || 0) + Number(e.amount); });

  const catsWithData = state.categories.filter(c => (spentByCat[c.id] || 0) > 0 || Number(c.budget || 0) > 0);
  const totalSpentThisMonth = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);

  if (catsWithData.length === 0 || (state.chartMode === "pie" && totalSpentThisMonth === 0)) {
    legend.innerHTML = "";
    const c2d = ctx.getContext("2d");
    c2d.clearRect(0, 0, ctx.width, ctx.height);
    legend.innerHTML = `<div class="empty-hint">אין עדיין הוצאות להצגה החודש</div>`;
    return;
  }

  if (state.chartMode === "pie") {
    const labels = catsWithData.map(c => c.name);
    const data = catsWithData.map(c => spentByCat[c.id] || 0);
    const colors = catsWithData.map(c => c.color);
    chartInstance = new Chart(ctx, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: chartCardBg() }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { rtl: true, callbacks: { label: (c) => `${c.label}: ${fmtNum(c.raw)} ₪` } } },
        cutout: "62%",
      }
    });
    legend.innerHTML = catsWithData.map(c => `
      <div class="legend-item"><span class="legend-dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</div>
    `).join("");
  } else {
    const labels = catsWithData.map(c => c.name);
    const actual = catsWithData.map(c => spentByCat[c.id] || 0);
    const budget = catsWithData.map(c => Number(c.budget || 0));
    chartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "בפועל", data: actual, backgroundColor: catsWithData.map(c => c.color), borderRadius: 6, maxBarThickness: 26 },
          { label: "תקציב", data: budget, backgroundColor: isDarkTheme() ? "#4A4638" : "#E4DFD1", borderRadius: 6, maxBarThickness: 26 },
        ]
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtNum(c.raw)} ₪` } } },
        scales: {
          y: { beginAtZero: true, ticks: { color: chartAxisColor(), callback: (v) => fmtNum(v) }, grid: { color: chartGridColor() } },
          x: { ticks: { color: chartAxisColor() }, grid: { display: false } },
        },
      }
    });
    legend.innerHTML = `
      <div class="legend-item"><span class="legend-dot" style="background:${chartAxisColor()}"></span>בפועל</div>
      <div class="legend-item"><span class="legend-dot" style="background:${isDarkTheme() ? "#4A4638" : "#E4DFD1"}"></span>תקציב</div>
    `;
  }
  
}

function renderPaymentChart(ctx, legend, monthExpenses) {
  const totals = { credit: 0, cash: 0 };
  monthExpenses.forEach(e => {
    const key = e.paymentMethod === "cash" ? "cash" : "credit";
    totals[key] += Number(e.amount);
  });
  const grandTotal = totals.credit + totals.cash;

  if (grandTotal === 0) {
    legend.innerHTML = `<div class="empty-hint">אין נתונים להצגה החודש</div>`;
    return;
  }

  const colors = { credit: "#4C7A99", cash: "#C97B3D" };
  chartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["אשראי", "מזומן"],
      datasets: [{ data: [totals.credit, totals.cash], backgroundColor: [colors.credit, colors.cash], borderWidth: 2, borderColor: chartCardBg() }],
    },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtNum(c.raw)} ₪ (${Math.round(c.raw/grandTotal*100)}%)` } } },
      cutout: "62%",
    }
  });

  legend.innerHTML = `
    <div class="legend-item"><span class="legend-dot" style="background:${colors.credit}"></span>אשראי — ${fmtNum(totals.credit)} ₪ (${Math.round(totals.credit/grandTotal*100)}%)</div>
    <div class="legend-item"><span class="legend-dot" style="background:${colors.cash}"></span>מזומן — ${fmtNum(totals.cash)} ₪ (${Math.round(totals.cash/grandTotal*100)}%)</div>
  `;
}

// ---------- Expense list ----------
function renderExpenseList() {
  const wrap = document.getElementById("expense-list");
  const monthExpenses = expensesForCurrentMonth();

  if (monthExpenses.length === 0) {
    wrap.innerHTML = `<div class="empty-hint">אין הוצאות בחודש זה עדיין. לחצו על "הוספת הוצאה" כדי להתחיל.</div>`;
    
    return;
  }

  // group by day
  const groups = {};
  monthExpenses.forEach(e => {
    groups[e.date] = groups[e.date] || [];
    groups[e.date].push(e);
  });
  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  let html = "";
  sortedDates.forEach(date => {
    html += `<div class="exp-day-label">${formatDayLabel(date)}</div>`;
    groups[date].forEach(e => {
      const cat = catById(e.categoryId);
      html += `
        <div class="exp-row">
          <div class="exp-dot" style="background:${cat.color}">${cat.name.charAt(0)}</div>
          <div class="exp-mid">
            <div class="exp-cat">${escapeHtml(cat.name)}</div>
            <div class="exp-meta-row">
              <span class="pay-tag ${e.paymentMethod === 'cash' ? 'cash' : 'credit'}">${paymentName(e.paymentMethod)}</span>
              ${e.note ? `<div class="exp-note">${escapeHtml(e.note)}</div>` : ""}
            </div>
          </div>
          <div class="exp-amount num">${fmtNum(e.amount)} ₪</div>
          <button class="exp-del" data-id="${e.id}" title="מחיקה">
            <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>`;
    });
  });
  wrap.innerHTML = html;

  wrap.querySelectorAll(".exp-del").forEach(btn => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });

  
}

function formatDayLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const days = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
  return `יום ${days[date.getDay()]}, ${d} ב${HEBREW_MONTHS[m-1]}`;
}

async function deleteExpense(id) {
  if (!state.user) return;
  await db.collection("users").doc(state.user.uid).collection("expenses").doc(id).delete();
  showToast("ההוצאה נמחקה");
}

// ============================================================
// ADD EXPENSE MODAL
// ============================================================
const expModal = document.getElementById("expense-modal");
let selectedExpCat = null;
let selectedExpPayment = "credit";

document.getElementById("nav-add-expense").addEventListener("click", () => openExpenseModal());
document.getElementById("exp-cancel").addEventListener("click", () => closeModal(expModal));
expModal.addEventListener("click", (e) => { if (e.target === expModal) closeModal(expModal); });

function openExpenseModal() {
  document.getElementById("exp-amount").value = "";
  document.getElementById("exp-note").value = "";
  document.getElementById("exp-date").value = todayISO();
  selectedExpCat = state.categories[0] ? state.categories[0].id : null;
  selectedExpPayment = "credit";
  renderExpCatChips();
  renderExpPaymentChips();
  openModal(expModal);
}

function renderExpPaymentChips() {
  const wrap = document.getElementById("exp-payment-chips");
  wrap.innerHTML = PAYMENT_METHODS.map(p => `
    <div class="chip ${p.id === selectedExpPayment ? "active" : ""}" data-id="${p.id}">${escapeHtml(p.name)}</div>
  `).join("");
  wrap.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      selectedExpPayment = chip.dataset.id;
      renderExpPaymentChips();
    });
  });
}

function renderExpCatChips() {
  const wrap = document.getElementById("exp-cat-chips");
  wrap.innerHTML = state.categories.map(c => `
    <div class="chip ${c.id === selectedExpCat ? "active" : ""}" data-id="${c.id}">
      <span class="cat-dot" style="background:${c.color}"></span>${escapeHtml(c.name)}
    </div>`).join("");
  wrap.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      selectedExpCat = chip.dataset.id;
      renderExpCatChips();
    });
  });
}

document.getElementById("exp-save").addEventListener("click", async () => {
  const amount = parseFloat(document.getElementById("exp-amount").value);
  const date = document.getElementById("exp-date").value;
  const note = document.getElementById("exp-note").value.trim();

  if (!amount || amount <= 0) { showToast("נא להזין סכום תקין"); return; }
  if (!selectedExpCat) { showToast("נא לבחור קטגוריה"); return; }
  if (!date) { showToast("נא לבחור תאריך"); return; }

  await db.collection("users").doc(state.user.uid).collection("expenses").add({
    amount, categoryId: selectedExpCat, paymentMethod: selectedExpPayment, date, note,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  closeModal(expModal);
  showToast("ההוצאה נשמרה");
});

// ============================================================
// CATEGORY MODAL
// ============================================================
const catModal = document.getElementById("cat-modal");
let selectedCatColor = COLOR_PALETTE[0];

document.getElementById("add-cat-btn").addEventListener("click", () => openCategoryModal(null));
document.getElementById("cat-cancel").addEventListener("click", () => closeModal(catModal));
catModal.addEventListener("click", (e) => { if (e.target === catModal) closeModal(catModal); });

function openCategoryModal(catId) {
  state.editingCategoryId = catId;
  const existing = catId ? state.categories.find(c => c.id === catId) : null;

  document.getElementById("cat-modal-title").textContent = existing ? "עריכת קטגוריה" : "קטגוריה חדשה";
  document.getElementById("cat-name").value = existing ? existing.name : "";
  document.getElementById("cat-budget").value = existing ? (existing.budget || "") : "";
  selectedCatColor = existing ? existing.color : COLOR_PALETTE[state.categories.length % COLOR_PALETTE.length];
  document.getElementById("cat-delete").classList.toggle("hidden", !existing);

  renderColorChips();
  openModal(catModal);
}

function renderColorChips() {
  const wrap = document.getElementById("cat-color-chips");
  wrap.innerHTML = COLOR_PALETTE.map(c => `
    <div class="chip color-chip" data-color="${c}" style="padding:0; width:34px; height:34px; border-radius:50%; background:${c}; border:${c === selectedCatColor ? "3px solid var(--ink)" : "3px solid transparent"}"></div>
  `).join("");
  wrap.querySelectorAll(".color-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      selectedCatColor = chip.dataset.color;
      renderColorChips();
    });
  });
}

document.getElementById("cat-save").addEventListener("click", async () => {
  const name = document.getElementById("cat-name").value.trim();
  const budget = parseFloat(document.getElementById("cat-budget").value) || 0;
  if (!name) { showToast("נא להזין שם קטגוריה"); return; }

  if (state.editingCategoryId) {
    const idx = state.categories.findIndex(c => c.id === state.editingCategoryId);
    if (idx > -1) state.categories[idx] = { ...state.categories[idx], name, budget, color: selectedCatColor };
  } else {
    const id = "cat_" + Date.now();
    state.categories.push({ id, name, budget, color: selectedCatColor });
  }
  await saveCategories();
  closeModal(catModal);
  showToast("הקטגוריה נשמרה");
});

document.getElementById("cat-delete").addEventListener("click", async () => {
  if (!state.editingCategoryId) return;
  const inUse = state.expenses.some(e => e.categoryId === state.editingCategoryId);
  if (inUse && !confirm("יש הוצאות המשויכות לקטגוריה זו. למחוק בכל זאת? ההוצאות עצמן יישארו אך יוצגו כ'אחר'.")) return;
  state.categories = state.categories.filter(c => c.id !== state.editingCategoryId);
  await saveCategories();
  closeModal(catModal);
  showToast("הקטגוריה נמחקה");
});

// ============================================================
// MODAL + NATIVE VIEWPORT HELPERS
// ============================================================
let activeModal = null;

function syncOpenModalViewport() {
  if (!activeModal || !activeModal.classList.contains("open")) return;
  const vv = window.visualViewport;
  if (!vv) {
    activeModal.style.setProperty("--modal-vv-top", "0px");
    activeModal.style.setProperty("--modal-vv-height", "100dvh");
    return;
  }
  activeModal.style.setProperty("--modal-vv-top", `${vv.offsetTop}px`);
  activeModal.style.setProperty("--modal-vv-height", `${vv.height}px`);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncOpenModalViewport);
  window.visualViewport.addEventListener("scroll", syncOpenModalViewport);
}

function openModal(el) {
  activeModal = el;
  el.classList.add("open");
  syncOpenModalViewport();
}

function closeModal(el) {
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  el.classList.remove("open");
  el.style.removeProperty("--modal-vv-top");
  el.style.removeProperty("--modal-vv-height");
  if (activeModal === el) activeModal = null;
}

// The document itself never scrolls or rubber-bands. Only explicit internal
// scrollers may consume vertical gestures, so the shell behaves like an app.
document.addEventListener("touchmove", (event) => {
  if (!event.target.closest(".page-scroll, .chart-legend, .modal")) {
    event.preventDefault();
  }
}, { passive: false });

// ============================================================
// EXCEL EXPORT — קובץ אחד, גיליון נפרד לכל חודש
// ============================================================
document.getElementById("export-btn").addEventListener("click", exportAllToExcel);

function exportAllToExcel() {
  if (!state.expenses.length) { showToast("אין עדיין הוצאות לייצוא"); return; }

  // group all expenses by month key (YYYY-MM)
  const byMonth = {};
  state.expenses.forEach(e => {
    if (!e.date) return;
    const key = e.date.slice(0, 7); // "YYYY-MM"
    byMonth[key] = byMonth[key] || [];
    byMonth[key].push(e);
  });
  const monthKeys = Object.keys(byMonth).sort(); // chronological, oldest first

  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };

  // ---- overview sheet (first tab): totals per month ----
  const overviewRows = [["חודש", "מס' הוצאות", "סה\"כ הוצאה (₪)", "אשראי (₪)", "מזומן (₪)"]];
  monthKeys.forEach(key => {
    const rows = byMonth[key];
    const total = rows.reduce((s, e) => s + Number(e.amount), 0);
    const credit = rows.filter(e => e.paymentMethod !== "cash").reduce((s, e) => s + Number(e.amount), 0);
    const cash = rows.filter(e => e.paymentMethod === "cash").reduce((s, e) => s + Number(e.amount), 0);
    overviewRows.push([monthKeyToLabel(key), rows.length, Math.round(total), Math.round(credit), Math.round(cash)]);
  });
  const overviewWs = XLSX.utils.aoa_to_sheet(overviewRows);
  overviewWs["!cols"] = [{ wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, overviewWs, "סיכום כללי");

  // ---- one sheet per month ----
  monthKeys.forEach(key => {
    const rows = byMonth[key].slice().sort((a, b) => a.date.localeCompare(b.date));
    const sheetRows = [["תאריך", "קטגוריה", "אמצעי תשלום", "סכום (₪)", "הערה"]];
    rows.forEach(e => {
      const payLabel = e.paymentMethod === "cash" ? "מזומן" : "אשראי";
      sheetRows.push([e.date, catById(e.categoryId).name, payLabel, Number(e.amount), e.note || ""]);
    });

    sheetRows.push([]); // spacer
    sheetRows.push(["סיכום לפי קטגוריה", "", "", "", ""]);
    sheetRows.push(["קטגוריה", "בפועל (₪)", "תקציב (₪)", "יתרה (₪)", ""]);

    const spentByCat = {};
    rows.forEach(e => { spentByCat[e.categoryId] = (spentByCat[e.categoryId] || 0) + Number(e.amount); });
    const total = rows.reduce((s, e) => s + Number(e.amount), 0);
    const totalBudget = state.categories.reduce((s, c) => s + Number(c.budget || 0), 0);

    state.categories.forEach(c => {
      const spent = spentByCat[c.id] || 0;
      if (spent === 0 && !c.budget) return;
      sheetRows.push([c.name, Math.round(spent), Math.round(c.budget || 0), Math.round((c.budget || 0) - spent), ""]);
    });
    sheetRows.push(["סה\"כ", Math.round(total), Math.round(totalBudget), Math.round(totalBudget - total), ""]);

    sheetRows.push([]); // spacer
    sheetRows.push(["סיכום לפי אמצעי תשלום", "", "", "", ""]);
    const credit = rows.filter(e => e.paymentMethod !== "cash").reduce((s, e) => s + Number(e.amount), 0);
    const cash = rows.filter(e => e.paymentMethod === "cash").reduce((s, e) => s + Number(e.amount), 0);
    sheetRows.push(["אשראי (₪)", Math.round(credit), "", "", ""]);
    sheetRows.push(["מזומן (₪)", Math.round(cash), "", "", ""]);

    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    ws["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 24 }];

    let sheetName = monthKeyToLabel(key);
    if (sheetName.length > 31) sheetName = sheetName.slice(0, 31); // Excel sheet-name limit
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  const fileName = `הוצאות ${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
  showToast("קובץ האקסל הורד");
}

function monthKeyToLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return `${HEBREW_MONTHS[m - 1]} ${y}`;
}

// ============================================================
// SERVICE WORKER
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW registration failed:", err));
  });
}

updateAuthUI();
