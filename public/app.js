/* ============ LOGO ============ */
const LOGO_SVG = `<svg width="30" height="30" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 3h10v6l3 3v20a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V12l3-3V3z" fill="#c1780f"/>
  <rect x="15" y="3" width="10" height="4" fill="#4b5d3a"/>
  <rect x="12" y="20" width="16" height="10" fill="#8c4a1f" opacity="0.35"/>
</svg>`;

/* ============ STATE ============ */
let state = {
  loading: true,
  token: localStorage.getItem('beershop_token') || null,
  currentUser: JSON.parse(localStorage.getItem('beershop_user') || 'null'),
  products: [],
  receipts: [],
  view: 'pos',
  cart: [],
  loginError: '',
  receiptToShow: null,
  historyFilterCashier: 'all',
  trash: [],
  posSearch: '',
  posCategory: 'all',
  productsSearch: '',
  posCategoryAdmin: 'all',
  mobileMenuOpen: false,
  showAddProductModal: false,
  showPaymentModal: false,
  paymentMethod: 'cash',
  paymentReceived: '',
  paymentCashPart: '',
  paymentQrPart: '',
  categoryMarkups: {},
  analyticsData: null,
  analyticsPeriodDays: 7,
  toast: null,
  userFormError: '',
  scanFlash: '', // '', 'ok', 'error'
};

/* ============ API CLIENT ============ */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    logout('Сессия истекла, войдите снова');
    throw new Error('unauthorized');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body, e.g. 204 */ }
  if (!res.ok) throw new Error(data?.error || 'Ошибка запроса');
  return data;
}

/* ============ UTIL ============ */
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('ru-RU') + ' \u20B8'; }
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { state.toast = null; render(); }, 2600);
}

/* ============ AUTH ============ */
async function login(username, password) {
  try {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    state.token = data.token;
    state.currentUser = data.user;
    localStorage.setItem('beershop_token', data.token);
    localStorage.setItem('beershop_user', JSON.stringify(data.user));
    state.loginError = '';
    state.view = 'pos';
    await loadAll();
  } catch (err) {
    state.loginError = err.message === 'unauthorized' ? '' : (err.message || 'Не удалось войти');
    render();
  }
}
function logout(message) {
  state.token = null;
  state.currentUser = null;
  state.cart = [];
  state.receiptToShow = null;
  state.view = 'pos';
  state.mobileMenuOpen = false;
  localStorage.removeItem('beershop_token');
  localStorage.removeItem('beershop_user');
  render();
  if (message) showToast(message);
}

/* ============ LOAD DATA ============ */
async function loadAll() {
  state.loading = true;
  render();
  try {
    const [products, receipts] = await Promise.all([
      api('/products'),
      api('/receipts'),
    ]);
    state.products = products;
    state.receipts = receipts;
  } catch (err) {
    if (err.message !== 'unauthorized') showToast('Не удалось загрузить данные: ' + err.message);
  }
  state.loading = false;
  render();
}

/* ============ CART / POS ============ */
function findProductByBarcode(code) {
  return state.products.find(p => p.barcode && p.barcode === code);
}
// Сколько «объёма» списывает со склада одна проданная единица товара:
// для обычных товаров — 1 штука, для разливного («л») — объём порции (1л/1.5л/2л и т.д.)
function unitConsumption(product) {
  return product.unit === 'л' ? Number(product.volume_liters || 1) : 1;
}
function isLowStock(product) {
  if (product.unit === 'л') {
    return Number(product.stock) <= Math.max(unitConsumption(product) * 2, 3);
  }
  return Number(product.stock) <= 5;
}
function addToCart(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;
  const inCart = state.cart.find(i => i.productId === productId);
  const qty = inCart ? inCart.qty : 0;
  const consumption = unitConsumption(product);
  const used = qty * consumption;
  if (used + consumption > Number(product.stock) + 1e-9) {
    flashScan('error');
    showToast('Товара «' + product.name + '» больше нет в наличии');
    return;
  }
  if (inCart) inCart.qty++;
  else state.cart.push({ productId, name: product.name, price: Number(product.price), qty: 1 });
  render();
}
function changeCartQty(productId, delta) {
  const item = state.cart.find(i => i.productId === productId);
  if (!item) return;
  const product = state.products.find(p => p.id === productId);
  const newQty = item.qty + delta;
  if (newQty <= 0) { state.cart = state.cart.filter(i => i.productId !== productId); render(); return; }
  if (product) {
    const consumption = unitConsumption(product);
    if (newQty * consumption > Number(product.stock) + 1e-9) return;
  }
  item.qty = newQty;
  render();
}
function cartTotal() { return state.cart.reduce((s, i) => s + i.price * i.qty, 0); }

function flashScan(kind) {
  state.scanFlash = kind;
  render();
  focusScanInput();
  setTimeout(() => { state.scanFlash = ''; render(); focusScanInput(); }, 450);
}
function focusScanInput() {
  const el = document.getElementById('scan-input');
  if (el) el.focus();
}
function handleScanSubmit(rawCode) {
  const code = rawCode.trim();
  if (!code) return;
  const product = findProductByBarcode(code);
  if (product) {
    state.posSearch = ''; // успешный скан — очищаем поле для следующего товара
    addToCart(product.id);
    flashScan('ok');
  } else {
    // Похоже на штрихкод (только цифры, от 6 знаков) — сообщаем, что не нашли.
    // Иначе это обычный текстовый поиск по названию — список уже отфильтрован вводом, ничего не делаем.
    if (/^\d{6,}$/.test(code)) {
      showToast('Штрихкод «' + code + '» не найден в базе товаров');
      flashScan('error');
    }
  }
}

async function checkout(paymentDetails) {
  if (state.cart.length === 0) return;
  try {
    const receipt = await api('/receipts', {
      method: 'POST',
      body: {
        items: state.cart.map(i => ({ productId: i.productId, qty: i.qty })),
        payment_method: paymentDetails.payment_method,
        cash_amount: paymentDetails.cash_amount,
        qr_amount: paymentDetails.qr_amount,
        received_amount: paymentDetails.received_amount,
      },
    });
    // обновляем локальные остатки (для разливного — списываем объём порции, а не «1 штуку»)
    receipt.items.forEach(li => {
      const p = state.products.find(p => p.id === li.productId);
      if (p) p.stock = Number(p.stock) - li.qty * unitConsumption(p);
    });
    state.receipts.unshift(receipt);
    state.cart = [];
    state.showPaymentModal = false;
    state.receiptToShow = receipt;
    render();
  } catch (err) {
    showToast(err.message || 'Не удалось оформить чек');
  }
}
function closeReceiptModal() { state.receiptToShow = null; render(); focusScanInput(); }
async function openReceipt(id) {
  let r = state.receipts.find(r => r.id === id);
  try {
    r = await api('/receipts/' + id);
  } catch (err) { /* fall back to list copy */ }
  if (r) { state.receiptToShow = r; render(); }
}
async function deleteReceipt(id) {
  const r = state.receipts.find(r => r.id === id);
  if (!confirm('Переместить чек №' + (r?.id || id) + ' в корзину? Остаток товара не будет восстановлен автоматически.')) return;
  try {
    await api('/receipts/' + id, { method: 'DELETE' });
    state.receipts = state.receipts.filter(r => r.id !== id);
    showToast('Чек №' + (r?.id || id) + ' перемещён в корзину');
    render();
  } catch (err) { showToast(err.message); }
}

async function loadTrash() {
  try { state.trash = await api('/receipts/trash'); } catch (err) { showToast(err.message); }
}
async function restoreReceipt(id) {
  try {
    await api('/receipts/' + id + '/restore', { method: 'POST' });
    state.trash = state.trash.filter(r => r.id !== id);
    showToast('Чек №' + id + ' восстановлен');
    render();
  } catch (err) { showToast(err.message); }
}
async function permanentlyDeleteReceipt(id) {
  if (!confirm('Удалить чек №' + id + ' без возможности восстановления?')) return;
  try {
    await api('/receipts/' + id + '/permanent', { method: 'DELETE' });
    state.trash = state.trash.filter(r => r.id !== id);
    render();
  } catch (err) { showToast(err.message); }
}
async function emptyTrash() {
  if (state.trash.length === 0) return;
  if (!confirm('Удалить все ' + state.trash.length + ' чек(а/ов) из корзины без возможности восстановления?')) return;
  try {
    await Promise.all(state.trash.map(r => api('/receipts/' + r.id + '/permanent', { method: 'DELETE' })));
    state.trash = [];
    render();
  } catch (err) { showToast(err.message); }
}

/* ============ PRODUCTS (admin) ============ */
async function updateProduct(id, field, rawValue) {
  const body = {};
  const textFields = ['name', 'barcode', 'category', 'unit'];
  body[field] = textFields.includes(field) ? rawValue : Number(rawValue) || 0;
  try {
    const updated = await api('/products/' + id, { method: 'PUT', body });
    const idx = state.products.findIndex(p => p.id === id);
    if (idx >= 0) state.products[idx] = updated;
    render();
  } catch (err) { showToast(err.message); render(); }
}
async function deleteProduct(id) {
  if (!confirm('Удалить товар из учёта?')) return;
  try {
    await api('/products/' + id, { method: 'DELETE' });
    state.products = state.products.filter(p => p.id !== id);
    render();
  } catch (err) { showToast(err.message); }
}
async function uploadProductImage(id, file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('image', file);
  try {
    const headers = {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch('/api/products/' + id + '/image', { method: 'POST', headers, body: formData });
    if (res.status === 401) { logout('Сессия истекла, войдите снова'); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить фото');
    const idx = state.products.findIndex(p => p.id === id);
    if (idx >= 0) state.products[idx] = data;
    render();
    showToast('Фото обновлено');
  } catch (err) { showToast(err.message); }
}
async function removeProductImage(id) {
  if (!confirm('Убрать фото товара?')) return;
  try {
    const updated = await api('/products/' + id + '/image', { method: 'DELETE' });
    const idx = state.products.findIndex(p => p.id === id);
    if (idx >= 0) state.products[idx] = updated;
    render();
  } catch (err) { showToast(err.message); }
}

async function renameCategory(oldName) {
  const newName = prompt('Новое название для категории «' + oldName + '»:', oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  try {
    await api('/products/categories/rename', { method: 'PUT', body: { oldName, newName: newName.trim() } });
    await loadAll();
    showToast('Категория переименована');
  } catch (err) { showToast(err.message); }
}
async function deleteCategory(name) {
  if (!confirm('Удалить категорию «' + name + '»? Товары этой категории переместятся в «Без категории», сами товары не удаляются.')) return;
  try {
    await api('/products/categories/' + encodeURIComponent(name), { method: 'DELETE' });
    await loadAll();
    showToast('Категория удалена');
  } catch (err) { showToast(err.message); }
}

async function addCategoryOptionForRow(id, btnEl) {
  const val = prompt('Название новой категории:');
  if (!val || !val.trim()) return;
  const select = btnEl.previousElementSibling;
  const opt = document.createElement('option');
  opt.value = val.trim();
  opt.textContent = val.trim();
  opt.selected = true;
  select.appendChild(opt);
  updateProduct(id, 'category', val.trim());
}
function addNewCategoryOption() {
  const val = prompt('Название новой категории:');
  if (!val || !val.trim()) return;
  const select = document.getElementById('new-p-category');
  const opt = document.createElement('option');
  opt.value = val.trim();
  opt.textContent = val.trim();
  opt.selected = true;
  select.appendChild(opt);
}
async function addProduct() {
  const name = document.getElementById('new-p-name').value.trim();
  const category = document.getElementById('new-p-category').value.trim();
  const price = Number(document.getElementById('new-p-price').value);
  const stock = Number(document.getElementById('new-p-stock').value);
  const barcode = document.getElementById('new-p-barcode').value.trim();
  const costPriceEl = document.getElementById('new-p-cost');
  const costPrice = costPriceEl ? Number(costPriceEl.value) || 0 : 0;
  const unitEl = document.getElementById('new-p-unit');
  const unit = unitEl && unitEl.value === 'л' ? 'л' : 'шт';
  const volumeEl = document.getElementById('new-p-volume');
  const volumeLiters = unit === 'л' ? (Number(volumeEl?.value) || 1) : null;
  if (!name || !price || price <= 0) { showToast('Укажите название и цену товара'); return; }
  try {
    const created = await api('/products', { method: 'POST', body: { name, price, stock: stock || 0, barcode: barcode || null, category: category || 'Пиво', cost_price: costPrice, unit, volume_liters: volumeLiters } });
    state.products.push(created);
    state.showAddProductModal = false;
    render();
    showToast('Товар добавлен');
  } catch (err) { showToast(err.message); }
}
function toggleDraftFieldsInModal() {
  const unitEl = document.getElementById('new-p-unit');
  const wrap = document.getElementById('new-p-volume-wrap');
  const stockLabel = document.getElementById('new-p-stock-label');
  const isDraft = unitEl && unitEl.value === 'л';
  if (wrap) wrap.style.display = isDraft ? 'block' : 'none';
  if (stockLabel) stockLabel.textContent = isDraft ? 'Остаток, л' : 'Остаток';
}
function openAddProductModal() {
  state.showAddProductModal = true;
  render();
  const el = document.getElementById('new-p-name');
  if (el) el.focus();
}
function closeAddProductModal() {
  state.showAddProductModal = false;
  render();
}

/* ============ КАТЕГОРИИ: НАЦЕНКА ============ */
async function loadCategoryMarkups() {
  try {
    const rows = await api('/products/categories/markups');
    state.categoryMarkups = {};
    rows.forEach(r => { state.categoryMarkups[r.category] = Number(r.markup_percent); });
  } catch (err) { showToast(err.message); }
}
async function updateCategoryMarkup(category, value) {
  const percent = Number(value);
  if (Number.isNaN(percent)) return;
  try {
    await api('/products/categories/' + encodeURIComponent(category) + '/markup', { method: 'PUT', body: { markup_percent: percent } });
    state.categoryMarkups[category] = percent;
    showToast('Наценка сохранена');
  } catch (err) { showToast(err.message); render(); }
}
async function applyCategoryMarkup(category) {
  if (!confirm('Пересчитать цены всех товаров категории «' + category + '» по себестоимости и наценке ' + (state.categoryMarkups[category] || 0) + '%?')) return;
  try {
    const result = await api('/products/categories/' + encodeURIComponent(category) + '/apply-markup', { method: 'POST' });
    await loadAll();
    let msg = 'Обновлено цен: ' + result.updated;
    if (result.withoutCost > 0) msg += '. Без себестоимости пропущено: ' + result.withoutCost;
    showToast(msg);
  } catch (err) { showToast(err.message); }
}

/* ============ ПОКАЗАТЕЛИ (АНАЛИТИКА) ============ */
let analyticsChartInstance = null;
async function loadAnalytics(days) {
  try {
    state.analyticsData = await api('/analytics/summary?days=' + days);
  } catch (err) { showToast(err.message); }
  render();
}
async function setAnalyticsPeriod(days) {
  state.analyticsPeriodDays = days;
  await loadAnalytics(days);
}
function renderAnalyticsChart() {
  const canvas = document.getElementById('analytics-chart');
  if (!canvas || !state.analyticsData || typeof Chart === 'undefined') return;
  if (analyticsChartInstance) { analyticsChartInstance.destroy(); analyticsChartInstance = null; }
  const labels = state.analyticsData.series.map(p => {
    const d = new Date(p.date + 'T00:00:00');
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  });
  const data = state.analyticsData.series.map(p => p.revenue);
  analyticsChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Выручка',
        data,
        borderColor: '#c1780f',
        backgroundColor: 'rgba(193,120,15,0.15)',
        tension: 0.35,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: '#c1780f',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => (v >= 1000 ? (v / 1000) + 'к' : v) } },
        x: { grid: { display: false } },
      },
    },
  });
}

/* ============ USERS (admin) ============ */
let allUsers = [];
async function loadUsers() {
  try { allUsers = await api('/users'); } catch (err) { showToast(err.message); }
}
async function addUser() {
  const username = document.getElementById('new-u-username').value.trim();
  const password = document.getElementById('new-u-password').value;
  const name = document.getElementById('new-u-name').value.trim();
  const role = document.getElementById('new-u-role').value;
  if (!username || !password || !name) { state.userFormError = 'Заполните все поля'; render(); return; }
  try {
    const created = await api('/users', { method: 'POST', body: { username, password, name, role } });
    allUsers.push(created);
    state.userFormError = '';
    render();
  } catch (err) { state.userFormError = err.message; render(); }
}
async function deleteUser(id) {
  const target = allUsers.find(u => u.id === id);
  if (!target) return;
  if (!confirm('Удалить пользователя ' + target.name + '?')) return;
  try {
    await api('/users/' + id, { method: 'DELETE' });
    allUsers = allUsers.filter(u => u.id !== id);
    render();
  } catch (err) { showToast(err.message); }
}
async function updateUserField(id, field, value) {
  const body = {}; body[field] = value;
  try {
    const updated = await api('/users/' + id, { method: 'PUT', body });
    const idx = allUsers.findIndex(u => u.id === id);
    if (idx >= 0) allUsers[idx] = updated;
    render();
  } catch (err) { showToast(err.message); render(); }
}

/* ============ NAV ============ */
async function setView(v) {
  state.view = v;
  state.mobileMenuOpen = false;
  if (v === 'users' && state.currentUser.role === 'admin') await loadUsers();
  if (v === 'trash' && state.currentUser.role === 'admin') await loadTrash();
  if (v === 'products' && state.currentUser.role === 'admin') await loadCategoryMarkups();
  if (v === 'analytics' && state.currentUser.role === 'admin') await loadAnalytics(state.analyticsPeriodDays);
  render();
  if (v === 'pos') focusScanInput();
}
function toggleMobileMenu() {
  state.mobileMenuOpen = !state.mobileMenuOpen;
  render();
}
function handlePosSearchInput(value) {
  state.posSearch = value;
  render();
  const el = document.getElementById('scan-input');
  if (el) { el.focus(); el.setSelectionRange(value.length, value.length); }
}
function setPosCategory(cat) {
  state.posCategory = cat;
  render();
}
function handleProductsSearchInput(value) {
  state.productsSearch = value;
  render();
  const el = document.getElementById('products-search-input');
  if (el) { el.focus(); el.setSelectionRange(value.length, value.length); }
}

/* ============ RENDER: LOGIN ============ */
function renderLogin() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="logo-row">${LOGO_SVG}<h1>Хмель</h1></div>
      <p class="tagline">Учёт, касса и чеки пивного магазина</p>
      ${state.loginError ? `<div class="login-error">${esc(state.loginError)}</div>` : ''}
      <form onsubmit="event.preventDefault(); login(document.getElementById('login-username').value.trim(), document.getElementById('login-password').value);">
        <div class="field">
          <label for="login-username">Логин</label>
          <input id="login-username" type="text" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="login-password">Пароль</label>
          <input id="login-password" type="password" autocomplete="current-password" required>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;">Войти</button>
      </form>
      <div class="demo-hint">
        Демо-доступ (смените после установки):<br>
        Админ — <b>admin</b> / <b>admin123</b><br>
        Кассир — <b>kassir</b> / <b>kassir123</b>
      </div>
    </div>
  </div>`;
}

/* ============ RENDER: SHELL / NAV ============ */
function navItems() {
  const role = state.currentUser.role;
  const items = [{ id: 'pos', label: 'Касса' }, { id: 'products', label: 'Товары' }];
  items.push({ id: 'history', label: 'История чеков' });
  if (role === 'admin') items.push({ id: 'analytics', label: 'Показатели' });
  if (role === 'admin') items.push({ id: 'trash', label: 'Корзина' });
  if (role === 'admin') items.push({ id: 'users', label: 'Пользователи' });
  return items;
}
function renderSidebar() {
  const items = navItems().map(it => `
    <button class="nav-item ${state.view === it.id ? 'active' : ''}" onclick="setView('${it.id}')">${esc(it.label)}</button>
  `).join('');
  return `
  <aside class="sidebar">
    <div class="sidebar-top">
      <div class="logo-row">${LOGO_SVG}<h1>Хмель</h1></div>
      <button class="burger-btn" onclick="toggleMobileMenu()" aria-label="${state.mobileMenuOpen ? 'Закрыть меню' : 'Открыть меню'}" aria-expanded="${state.mobileMenuOpen}">${state.mobileMenuOpen ? '✕' : '☰'}</button>
    </div>
    <p class="tagline">Учёт и касса</p>
    <nav class="nav-list ${state.mobileMenuOpen ? 'open' : ''}">
      ${items}
      <div class="sidebar-spacer"></div>
      <div class="user-box">
        <div>
          <div class="who">${esc(state.currentUser.name)}</div>
          <span class="badge ${state.currentUser.role === 'admin' ? 'badge-admin' : 'badge-cashier'}">${state.currentUser.role === 'admin' ? 'Админ' : 'Кассир'}</span>
        </div>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto;" onclick="logout()">Выйти</button>
      </div>
    </nav>
    ${state.mobileMenuOpen ? `<div class="mobile-menu-backdrop" onclick="toggleMobileMenu()"></div>` : ''}
  </aside>`;
}

/* ============ RENDER: POS ============ */
function renderPOS() {
  const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const search = state.posSearch.trim().toLowerCase();
  const filtered = state.products.filter(p => {
    const matchesCategory = state.posCategory === 'all' || p.category === state.posCategory;
    const matchesSearch = !search || p.name.toLowerCase().includes(search) || (p.barcode && p.barcode.includes(search));
    return matchesCategory && matchesSearch;
  });

  const products = filtered.map(p => {
    const inCart = state.cart.find(i => i.productId === p.id);
    const consumption = unitConsumption(p);
    const usedByCart = (inCart ? inCart.qty : 0) * consumption;
    const availableVolume = Number(p.stock) - usedByCart;
    const canAddOne = availableVolume + 1e-9 >= consumption;
    const isDraft = p.unit === 'л';
    const availableLabel = isDraft ? availableVolume.toFixed(2).replace(/\.?0+$/, '') + ' л' : Math.round(availableVolume) + ' шт';
    const low = isDraft ? availableVolume <= Math.max(consumption * 2, 3) : p.stock <= 5;
    return `
    <button class="kassa-pcard" ${!canAddOne ? 'disabled' : ''} onclick="addToCart(${p.id})">
      <div class="kassa-pcard-media">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">` : `<div class="placeholder">🍺</div>`}
      </div>
      <div class="kassa-pcard-name">${esc(p.name)}</div>
      <div class="kassa-pcard-price">${fmt(p.price)}</div>
      <div class="kassa-pcard-stock ${low ? 'low' : ''}">${availableLabel}</div>
    </button>`;
  }).join('');

  const chips = ['all', ...categories].map(c => `
    <button class="kassa-chip ${state.posCategory === c ? 'active' : ''}" onclick="setPosCategory('${esc(c).replace(/'/g, "\\'")}')">${c === 'all' ? 'Все' : esc(c)}</button>
  `).join('');

  const cartRows = state.cart.map((i, idx) => `
    <tr>
      <td class="kassa-col-num">${idx + 1}</td>
      <td>${esc(i.name)}</td>
      <td class="num">${fmt(i.price)}</td>
      <td class="kassa-col-qty">
        <button class="kassa-qty-btn" onclick="changeCartQty(${i.productId}, -1)" aria-label="Уменьшить">−</button>
        <span>${i.qty}</span>
        <button class="kassa-qty-btn" onclick="changeCartQty(${i.productId}, 1)" aria-label="Увеличить">+</button>
      </td>
      <td class="num kassa-col-sum">${fmt(i.price * i.qty)}</td>
      <td class="kassa-col-remove"><button class="kassa-row-remove" onclick="changeCartQty(${i.productId}, -${i.qty})" aria-label="Убрать из чека">×</button></td>
    </tr>`).join('');

  const nextReceiptNo = state.receipts.length + 1;
  const now = new Date();
  const flashClass = state.scanFlash === 'ok' ? 'flash' : state.scanFlash === 'error' ? 'flash-error' : '';

  return `
  <div class="kassa-wrap">
    <div class="kassa-topbar">
      <div class="kassa-topbar-title">Касса</div>
      <div class="kassa-topbar-meta">Чек № ${nextReceiptNo} &nbsp;·&nbsp; ${now.toLocaleDateString('ru-RU')} ${now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>

    <div class="kassa-toolbar ${flashClass}">
      <span class="kassa-search-icon">📷</span>
      <input id="scan-input" class="kassa-search-input" type="text" inputmode="numeric"
        placeholder="Поиск по товару или сканируйте штрихкод"
        autofocus
        onkeydown="if(event.key==='Enter'){ event.preventDefault(); handleScanSubmit(this.value); }"
        oninput="handlePosSearchInput(this.value)"
        value="${esc(state.posSearch)}">
    </div>
    ${categories.length > 0 ? `<div class="kassa-chips-row">${chips}</div>` : ''}

    <div class="kassa-receipt-panel">
      <table class="kassa-receipt-table">
        <thead>
          <tr><th class="kassa-col-num">#</th><th>Наименование</th><th>Цена</th><th class="kassa-col-qty">Количество</th><th class="kassa-col-sum">Сумма</th><th></th></tr>
        </thead>
        <tbody>${cartRows}</tbody>
      </table>
      ${state.cart.length === 0 ? `<div class="kassa-receipt-empty">Чек пуст — отсканируйте штрихкод или выберите товар ниже</div>` : ''}
    </div>

    <div class="kassa-products-panel">
      <div class="kassa-pcard-grid">${products || `<div class="empty-state">${state.products.length === 0 ? 'Нет товаров. Обратитесь к администратору.' : 'Ничего не найдено по заданным условиям.'}</div>`}</div>
    </div>

    <div class="kassa-footer">
      <div class="kassa-total-box">
        <span class="kassa-total-label">Итого</span>
        <span class="kassa-total-value">${fmt(cartTotal())}</span>
      </div>
      <div class="kassa-footer-actions">
        <button class="kassa-btn-clear" ${state.cart.length === 0 ? 'disabled' : ''} onclick="clearCart()">Очистить</button>
        <button class="kassa-btn-pay" ${state.cart.length === 0 ? 'disabled' : ''} onclick="openPaymentModal()">Оплата</button>
      </div>
    </div>
  </div>
  ${state.showPaymentModal ? renderPaymentModal() : ''}`;
}
function renderPaymentModal() {
  const total = cartTotal();
  const method = state.paymentMethod;
  const received = Number(state.paymentReceived) || 0;
  const change = received - total;
  const cashPart = Number(state.paymentCashPart) || 0;
  const qrPart = Number(state.paymentQrPart) || 0;
  const mixedDiff = +(total - cashPart - qrPart).toFixed(2);

  return `
  <div class="modal-overlay" onclick="if(event.target===this) closePaymentModal()">
    <div class="modal-card payment-modal">
      <div class="modal-close-row"><button class="icon-btn" onclick="closePaymentModal()" aria-label="Закрыть">×</button></div>
      <div class="payment-body">
        <h3 class="add-product-title">Оплата чека</h3>
        <div class="payment-total-row">
          <span>К оплате</span>
          <span class="payment-total-value">${fmt(total)}</span>
        </div>

        <div class="payment-method-tabs">
          <button class="payment-tab ${method === 'cash' ? 'active' : ''}" onclick="setPaymentMethod('cash')">Наличные</button>
          <button class="payment-tab ${method === 'qr' ? 'active' : ''}" onclick="setPaymentMethod('qr')">QR-код</button>
          <button class="payment-tab ${method === 'mixed' ? 'active' : ''}" onclick="setPaymentMethod('mixed')">Смешанный</button>
        </div>

        ${method === 'cash' ? `
        <div class="field">
          <label>Получено наличными, ₸</label>
          <input id="payment-received-input" type="number" min="0" step="1" placeholder="${Math.ceil(total)}" value="${state.paymentReceived}"
            oninput="setPaymentReceived(this.value)" autofocus>
        </div>
        <div class="payment-change-row ${change < 0 ? 'negative' : ''}">
          <span>Сдача</span>
          <span>${fmt(Math.max(0, change))}</span>
        </div>` : ''}

        ${method === 'qr' ? `
        <div class="payment-qr-hint">Покажите покупателю QR-код для оплаты на терминале. Сумма к оплате — ${fmt(total)}.</div>` : ''}

        ${method === 'mixed' ? `
        <div class="payment-mixed-grid">
          <div class="field">
            <label>Наличными, ₸</label>
            <input id="payment-cash-input" type="number" min="0" step="1" value="${state.paymentCashPart}" oninput="setPaymentMixedPart('cash', this.value)">
            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="fillMixedRest('cash')">Заполнить остаток</button>
          </div>
          <div class="field">
            <label>По QR, ₸</label>
            <input id="payment-qr-input" type="number" min="0" step="1" value="${state.paymentQrPart}" oninput="setPaymentMixedPart('qr', this.value)">
            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="fillMixedRest('qr')">Заполнить остаток</button>
          </div>
        </div>
        <div class="payment-change-row ${Math.abs(mixedDiff) > 0.01 ? 'negative' : ''}">
          <span>${mixedDiff > 0 ? 'Не хватает' : mixedDiff < 0 ? 'Лишнее' : 'Сходится'}</span>
          <span>${fmt(Math.abs(mixedDiff))}</span>
        </div>` : ''}
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" style="flex:1;" onclick="closePaymentModal()">Отмена</button>
        <button class="kassa-btn-pay" style="flex:1;" onclick="confirmPayment()">Подтвердить</button>
      </div>
    </div>
  </div>`;
}
function clearCart() {
  if (state.cart.length === 0) return;
  if (!confirm('Очистить текущий чек?')) return;
  state.cart = [];
  render();
  focusScanInput();
}

/* ============ ОПЛАТА ============ */
function openPaymentModal() {
  if (state.cart.length === 0) return;
  state.showPaymentModal = true;
  state.paymentMethod = 'cash';
  state.paymentReceived = '';
  state.paymentCashPart = '';
  state.paymentQrPart = '';
  render();
}
function closePaymentModal() {
  state.showPaymentModal = false;
  render();
  focusScanInput();
}
function setPaymentMethod(method) {
  state.paymentMethod = method;
  render();
}
function setPaymentReceived(value) {
  state.paymentReceived = value;
  render();
  const el = document.getElementById('payment-received-input');
  if (el) { el.focus(); el.setSelectionRange(value.length, value.length); }
}
function setPaymentMixedPart(field, value) {
  if (field === 'cash') state.paymentCashPart = value;
  else state.paymentQrPart = value;
  render();
  const el = document.getElementById(field === 'cash' ? 'payment-cash-input' : 'payment-qr-input');
  if (el) { el.focus(); el.setSelectionRange(value.length, value.length); }
}
function fillMixedRest(field) {
  const total = cartTotal();
  if (field === 'cash') {
    const qr = Number(state.paymentQrPart) || 0;
    state.paymentCashPart = String(Math.max(0, +(total - qr).toFixed(2)));
  } else {
    const cash = Number(state.paymentCashPart) || 0;
    state.paymentQrPart = String(Math.max(0, +(total - cash).toFixed(2)));
  }
  render();
}
function confirmPayment() {
  const total = cartTotal();
  const method = state.paymentMethod;
  if (method === 'cash') {
    const received = Number(state.paymentReceived) || 0;
    if (received < total - 0.01) { showToast('Получено меньше суммы чека'); return; }
    checkout({ payment_method: 'cash', cash_amount: total, qr_amount: 0, received_amount: received });
  } else if (method === 'qr') {
    checkout({ payment_method: 'qr', cash_amount: 0, qr_amount: total, received_amount: null });
  } else {
    const cash = Number(state.paymentCashPart) || 0;
    const qr = Number(state.paymentQrPart) || 0;
    if (Math.abs(cash + qr - total) > 0.01) { showToast('Сумма наличными и по QR должна совпадать с итогом'); return; }
    checkout({ payment_method: 'mixed', cash_amount: cash, qr_amount: qr, received_amount: cash });
  }
}

/* ============ RENDER: PRODUCTS ============ */
function renderProducts() {
  const isAdmin = state.currentUser.role === 'admin';
  const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const search = state.productsSearch.trim().toLowerCase();
  const filtered = state.products.filter(p => {
    const matchesCategory = state.posCategoryAdmin === undefined || state.posCategoryAdmin === 'all' || p.category === state.posCategoryAdmin;
    const matchesSearch = !search || p.name.toLowerCase().includes(search) || (p.barcode && p.barcode.includes(search));
    return matchesCategory && matchesSearch;
  });

  const rows = filtered.map(p => {
    if (!isAdmin) {
      // Кассиру доступен только просмотр — без редактирования и удаления
      return `
      <tr class="${isLowStock(p) ? 'low-row' : ''}">
        <td style="width:60px;">${p.image_url ? `<img src="${esc(p.image_url)}" class="thumb-img" alt="">` : `<div class="thumb-placeholder">🍺</div>`}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.category || '—')}</td>
        <td class="mono">${esc(p.barcode || '—')}</td>
        <td class="num">${fmt(p.price)}</td>
        <td class="num">${p.stock} ${p.unit === 'л' ? 'л' : ''}</td>
      </tr>`;
    }
    return `
    <tr class="${isLowStock(p) ? 'low-row' : ''}">
      <td style="width:120px;">
        <div class="thumb-cell">
          ${p.image_url ? `<img src="${esc(p.image_url)}" class="thumb-img" alt="">` : `<div class="thumb-placeholder">🍺</div>`}
          <div style="display:flex; flex-direction:column; gap:2px;">
            <input type="file" accept="image/*" id="img-input-${p.id}" style="display:none" onchange="uploadProductImage(${p.id}, this.files[0])">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('img-input-${p.id}').click()">Фото</button>
            ${p.image_url ? `<button class="thumb-remove" onclick="removeProductImage(${p.id})">убрать</button>` : ''}
          </div>
        </div>
      </td>
      <td><input type="text" value="${esc(p.name)}" onchange="updateProduct(${p.id},'name', this.value)"></td>
      <td style="width:170px;">
        <div style="display:flex; gap:4px; align-items:center;">
          <select style="flex:1;" onchange="updateProduct(${p.id},'category', this.value)">
            ${categories.map(c => `<option value="${esc(c)}" ${p.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <button type="button" class="icon-btn" title="Новая категория" onclick="addCategoryOptionForRow(${p.id}, this)">+</button>
        </div>
      </td>
      <td style="width:150px;"><input type="text" class="mono" value="${esc(p.barcode || '')}" placeholder="—" onchange="updateProduct(${p.id},'barcode', this.value)"></td>
      <td style="width:110px;"><input class="num" type="number" min="0" step="0.01" value="${p.cost_price || 0}" onchange="updateProduct(${p.id},'cost_price', this.value)"></td>
      <td style="width:90px;">
        <select onchange="updateProduct(${p.id},'unit', this.value)">
          <option value="шт" ${p.unit !== 'л' ? 'selected' : ''}>шт</option>
          <option value="л" ${p.unit === 'л' ? 'selected' : ''}>л</option>
        </select>
      </td>
      <td style="width:110px;">${p.unit === 'л' ? `<input class="num" type="number" min="0" step="0.1" value="${p.volume_liters || 1}" onchange="updateProduct(${p.id},'volume_liters', this.value)">` : '<span class="pec-label" style="margin:0;">—</span>'}</td>
      <td style="width:120px;"><input class="num" type="number" min="0" step="0.01" value="${p.price}" onchange="updateProduct(${p.id},'price', this.value)"></td>
      <td style="width:100px;"><input class="num" type="number" min="0" step="0.01" value="${p.stock}" onchange="updateProduct(${p.id},'stock', this.value)"> ${p.unit === 'л' ? '<span class="pec-label" style="margin:0;">л</span>' : ''}</td>
      <td style="width:60px;"><button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id})">Удалить</button></td>
    </tr>`;
  }).join('');

  /* Карточный вид для планшетов, моноблоков и телефонов — вместо тесной таблицы */
  const cards = filtered.map(p => {
    const photoBlock = p.image_url
      ? `<img src="${esc(p.image_url)}" class="thumb-img" alt="">`
      : `<div class="thumb-placeholder">🍺</div>`;
    const isDraft = p.unit === 'л';
    if (!isAdmin) {
      return `
      <div class="product-view-card ${isLowStock(p) ? 'low' : ''}">
        <div class="pvc-top">
          ${photoBlock}
          <div class="pvc-name">${esc(p.name)}</div>
        </div>
        <div class="pvc-row"><span>Категория</span><span>${esc(p.category || '—')}</span></div>
        <div class="pvc-row"><span>Штрихкод</span><span class="mono">${esc(p.barcode || '—')}</span></div>
        <div class="pvc-row"><span>Цена</span><span class="num">${fmt(p.price)}</span></div>
        <div class="pvc-row"><span>Остаток</span><span class="num">${p.stock} ${isDraft ? 'л' : 'шт'}</span></div>
      </div>`;
    }
    return `
    <div class="product-edit-card ${isLowStock(p) ? 'low' : ''}">
      <div class="pec-head">
        <div class="thumb-cell">
          ${photoBlock}
          <div style="display:flex; flex-direction:column; gap:2px;">
            <input type="file" accept="image/*" id="img-input-card-${p.id}" style="display:none" onchange="uploadProductImage(${p.id}, this.files[0])">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('img-input-card-${p.id}').click()">Фото</button>
            ${p.image_url ? `<button class="thumb-remove" onclick="removeProductImage(${p.id})">убрать</button>` : ''}
          </div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id})">Удалить</button>
      </div>
      <label class="pec-label">Название</label>
      <input type="text" value="${esc(p.name)}" onchange="updateProduct(${p.id},'name', this.value)">
      <label class="pec-label">Категория</label>
      <div class="pec-inline">
        <select onchange="updateProduct(${p.id},'category', this.value)">
          ${categories.map(c => `<option value="${esc(c)}" ${p.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <button type="button" class="icon-btn" title="Новая категория" onclick="addCategoryOptionForRow(${p.id}, this)">+</button>
      </div>
      <div class="pec-grid-2">
        <div><label class="pec-label">Штрихкод</label><input type="text" class="mono" value="${esc(p.barcode || '')}" placeholder="—" onchange="updateProduct(${p.id},'barcode', this.value)"></div>
        <div><label class="pec-label">Себестоимость, ₸</label><input class="num" type="number" min="0" step="0.01" value="${p.cost_price || 0}" onchange="updateProduct(${p.id},'cost_price', this.value)"></div>
      </div>
      <label class="pec-label">Единица товара</label>
      <div class="pec-grid-2">
        <select onchange="updateProduct(${p.id},'unit', this.value)">
          <option value="шт" ${!isDraft ? 'selected' : ''}>Штуки (шт)</option>
          <option value="л" ${isDraft ? 'selected' : ''}>Разливное (л)</option>
        </select>
        ${isDraft ? `<input class="num" type="number" min="0" step="0.1" value="${p.volume_liters || 1}" placeholder="Объём порции, л" onchange="updateProduct(${p.id},'volume_liters', this.value)">` : ''}
      </div>
      <div class="pec-grid-2">
        <div><label class="pec-label">Цена, ₸</label><input class="num" type="number" min="0" step="0.01" value="${p.price}" onchange="updateProduct(${p.id},'price', this.value)"></div>
        <div><label class="pec-label">Остаток${isDraft ? ', л' : ''}</label><input class="num" type="number" min="0" step="${isDraft ? '0.1' : '1'}" value="${p.stock}" onchange="updateProduct(${p.id},'stock', this.value)"></div>
      </div>
    </div>`;
  }).join('');

  const categoryFilterOptions = categories.map(c => `<option value="${esc(c)}" ${state.posCategoryAdmin === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const newProductCategoryOptions = categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') || `<option value="Пиво">Пиво</option>`;

  const categoryManageRows = categories.map(c => {
    const count = state.products.filter(p => p.category === c).length;
    const markup = state.categoryMarkups[c] !== undefined ? state.categoryMarkups[c] : '';
    return `
    <div class="cat-manage-row">
      <div class="cat-manage-title">
        <span class="cat-manage-name">${esc(c)}</span>
        <span class="cat-manage-count">${count} шт.</span>
      </div>
      <div class="cat-manage-actions">
        ${isAdmin ? `
        <div class="cat-markup-cell">
          <input type="number" class="num" step="0.1" min="0" placeholder="0" value="${markup}"
            onchange="updateCategoryMarkup('${esc(c).replace(/'/g, "\\'")}', this.value)">
          <span>%</span>
          <button class="btn btn-hop btn-sm" onclick="applyCategoryMarkup('${esc(c).replace(/'/g, "\\'")}')">Применить</button>
        </div>` : ''}
        <div class="cat-manage-buttons">
          <button class="btn btn-ghost btn-sm" onclick="renameCategory('${esc(c).replace(/'/g, "\\'")}')">Переименовать</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCategory('${esc(c).replace(/'/g, "\\'")}')">Удалить</button>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="page-head">
    <div><h2>Товары</h2><div class="page-sub">${isAdmin ? 'Учёт ассортимента, фото, категорий, себестоимости и остатков' : 'Можно добавлять новые товары. Изменение и удаление — только у администратора'} (${state.products.length} шт.)</div></div>
  </div>
  ${isAdmin && categories.length > 0 ? `
  <div class="panel" style="margin-bottom:16px;">
    <h3 style="font-size:0.95rem; margin-bottom:4px;">Категории и наценка</h3>
    <div class="page-sub" style="margin-bottom:10px;">Наценка применяется к товарам с указанной себестоимостью: цена = себестоимость × (1 + наценка/100)</div>
    <div class="cat-manage-list">${categoryManageRows}</div>
  </div>` : ''}
  <div class="panel">
    <div class="table-toolbar">
      <input id="products-search-input" class="pos-search" style="max-width:280px;" type="text" placeholder="Поиск по названию или штрихкоду…" value="${esc(state.productsSearch)}" oninput="handleProductsSearchInput(this.value)">
      <div class="filters">
        <select onchange="state.posCategoryAdmin=this.value; render();">
          <option value="all">Все категории</option>
          ${categoryFilterOptions}
        </select>
      </div>
    </div>
    <table class="products-table">
      <thead><tr><th>Фото</th><th>Название</th><th>Категория</th><th>Штрихкод</th>${isAdmin ? '<th>Себестоимость</th><th>Ед.</th><th>Объём порции</th>' : ''}<th>Цена, ₸</th><th>Остаток</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows || ''}</tbody>
    </table>
    <div class="products-cards">${cards || ''}</div>
    ${state.products.length === 0 ? '<div class="empty-state">Товаров пока нет — нажмите «+», чтобы добавить первый.</div>' : ''}
    ${state.products.length > 0 && filtered.length === 0 ? '<div class="empty-state">Ничего не найдено по заданным условиям.</div>' : ''}
  </div>
  <button class="fab" onclick="openAddProductModal()" aria-label="Добавить товар" title="Добавить товар">+</button>
  ${state.showAddProductModal ? renderAddProductModal(newProductCategoryOptions, isAdmin) : ''}`;
}

function renderAddProductModal(newProductCategoryOptions, isAdmin) {
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeAddProductModal()">
    <div class="modal-card add-product-modal">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeAddProductModal()" aria-label="Закрыть">×</button></div>
      <div class="add-product-body">
        <h3 class="add-product-title">Новый товар</h3>
        <div class="field">
          <label>Название</label>
          <input id="new-p-name" type="text" placeholder="Крафтовый эль 0.5л">
        </div>
        <div class="field">
          <label>Категория</label>
          <div style="display:flex; gap:6px; align-items:center;">
            <select id="new-p-category" style="flex:1;">${newProductCategoryOptions}</select>
            <button type="button" class="icon-btn" title="Новая категория" onclick="addNewCategoryOption()">+</button>
          </div>
        </div>
        <div class="field"><label>Штрихкод</label><input id="new-p-barcode" type="text" placeholder="Скан. или вручную"></div>
        ${isAdmin ? `<div class="field"><label>Себестоимость, ₸</label><input id="new-p-cost" type="number" min="0" placeholder="300"></div>` : ''}
        <div class="field">
          <label>Единица товара</label>
          <select id="new-p-unit" onchange="toggleDraftFieldsInModal()">
            <option value="шт" selected>Штуки (шт)</option>
            <option value="л">Разливное (л)</option>
          </select>
        </div>
        <div class="field" id="new-p-volume-wrap" style="display:none;">
          <label>Объём порции, л</label>
          <input id="new-p-volume" type="number" min="0" step="0.1" placeholder="1.5">
        </div>
        <div class="field"><label>Цена, ₸</label><input id="new-p-price" type="number" min="0" placeholder="500"></div>
        <div class="field"><label id="new-p-stock-label">Остаток</label><input id="new-p-stock" type="number" min="0" step="1" placeholder="20"></div>
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" style="flex:1;" onclick="closeAddProductModal()">Отмена</button>
        <button class="btn btn-hop" style="flex:1;" onclick="addProduct()">Добавить товар</button>
      </div>
    </div>
  </div>`;
}

/* ============ RENDER: HISTORY ============ */
function renderHistory() {
  const isAdmin = state.currentUser.role === 'admin';
  const cashiers = [...new Set(state.receipts.map(r => r.cashier_name))];
  let list = state.receipts.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (isAdmin && state.historyFilterCashier !== 'all') {
    list = list.filter(r => r.cashier_name === state.historyFilterCashier);
  }
  const dayTotal = list
    .filter(r => new Date(r.created_at).toDateString() === new Date().toDateString())
    .reduce((s, r) => s + Number(r.total), 0);

  const rows = list.map(r => `
    <tr>
      <td class="num">№${r.id}</td>
      <td>${fmtDate(r.created_at)}</td>
      <td>${esc(r.cashier_name)}</td>
      <td>${paymentMethodLabelShort(r)}</td>
      <td class="num">${fmt(r.total)}</td>
      <td class="row-actions">
        <button class="btn btn-ghost btn-sm" onclick="openReceipt(${r.id})">Открыть</button>
        ${isAdmin ? `<button class="btn btn-danger btn-sm" onclick="deleteReceipt(${r.id})">Удалить</button>` : ''}
      </td>
    </tr>`).join('');

  const filterOptions = cashiers.map(c => `<option value="${esc(c)}" ${state.historyFilterCashier === c ? 'selected' : ''}>${esc(c)}</option>`).join('');

  return `
  <div class="page-head">
    <div><h2>История чеков</h2><div class="page-sub">Продаж сегодня${isAdmin ? '' : ' (ваши чеки)'}: ${fmt(dayTotal)}</div></div>
  </div>
  <div class="panel">
    ${isAdmin ? `
    <div class="table-toolbar">
      <div class="filters">
        <select onchange="state.historyFilterCashier=this.value; render();">
          <option value="all" ${state.historyFilterCashier === 'all' ? 'selected' : ''}>Все кассиры</option>
          ${filterOptions}
        </select>
      </div>
    </div>` : ''}
    <table>
      <thead><tr><th>Чек</th><th>Дата</th><th>Кассир</th><th>Оплата</th><th>Сумма</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${list.length === 0 ? '<div class="empty-state">Чеков пока нет.</div>' : ''}
  </div>`;
}

/* ============ RENDER: ANALYTICS (admin only) ============ */
function renderAnalytics() {
  const d = state.analyticsData;
  const periodLabels = { 7: 'За неделю', 30: 'За месяц', 90: 'За квартал' };
  const periodOptions = [7, 30, 90].map(p => `<option value="${p}" ${state.analyticsPeriodDays === p ? 'selected' : ''}>${periodLabels[p]}</option>`).join('');

  if (!d) {
    return `
    <div class="page-head"><div><h2>Показатели</h2></div></div>
    <div class="panel"><div class="empty-state">Загрузка…</div></div>`;
  }

  return `
  <div class="page-head">
    <div><h2>Показатели</h2><div class="page-sub">Сегодня, ${new Date().toLocaleDateString('ru-RU')}</div></div>
  </div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Выручка</div>
      <div class="stat-value">${fmt(d.today.revenue)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Средний чек</div>
      <div class="stat-value">${fmt(d.today.avgCheck)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Количество продаж</div>
      <div class="stat-value">${d.today.salesCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Себестоимость</div>
      <div class="stat-value">${fmt(d.today.cost)}</div>
    </div>
    <div class="stat-card highlight">
      <div class="stat-label">Валовая прибыль</div>
      <div class="stat-value">${fmt(d.today.grossProfit)}</div>
    </div>
  </div>
  <div class="panel" style="margin-top:16px;">
    <div class="table-toolbar">
      <h3 style="font-size:0.95rem;">Динамика выручки</h3>
      <select onchange="setAnalyticsPeriod(Number(this.value))">${periodOptions}</select>
    </div>
    <div class="chart-wrap"><canvas id="analytics-chart"></canvas></div>
  </div>`;
}

/* ============ RENDER: TRASH (admin only) ============ */
function renderTrash() {
  const list = state.trash.slice().sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
  const rows = list.map(r => `
    <tr>
      <td class="num">№${r.id}</td>
      <td>${fmtDate(r.created_at)}</td>
      <td>${esc(r.cashier_name)}</td>
      <td class="num">${fmt(r.total)}</td>
      <td>${fmtDate(r.deleted_at)}</td>
      <td class="row-actions">
        <button class="btn btn-hop btn-sm" onclick="restoreReceipt(${r.id})">Восстановить</button>
        <button class="btn btn-danger btn-sm" onclick="permanentlyDeleteReceipt(${r.id})">Удалить навсегда</button>
      </td>
    </tr>`).join('');

  return `
  <div class="page-head">
    <div><h2>Корзина</h2><div class="page-sub">Удалённые чеки — можно восстановить или стереть окончательно</div></div>
    ${list.length > 0 ? `<button class="btn btn-danger btn-sm" onclick="emptyTrash()">Очистить корзину</button>` : ''}
  </div>
  <div class="panel">
    <table>
      <thead><tr><th>Чек</th><th>Дата продажи</th><th>Кассир</th><th>Сумма</th><th>Удалён</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${list.length === 0 ? '<div class="empty-state">Корзина пуста.</div>' : ''}
  </div>`;
}

/* ============ RENDER: USERS (admin only) ============ */
function renderUsers() {
  const rows = allUsers.map(u => `
    <tr>
      <td><input type="text" value="${esc(u.name)}" onchange="updateUserField(${u.id},'name', this.value)"></td>
      <td class="mono">${esc(u.username)}</td>
      <td>
        <select onchange="updateUserField(${u.id},'role', this.value)">
          <option value="cashier" ${u.role === 'cashier' ? 'selected' : ''}>Кассир</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Админ</option>
        </select>
      </td>
      <td><input type="text" placeholder="Новый пароль" onchange="if(this.value) updateUserField(${u.id},'password', this.value)"></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Удалить</button></td>
    </tr>`).join('');

  return `
  <div class="page-head">
    <div><h2>Пользователи</h2><div class="page-sub">Доступ для администраторов и кассиров</div></div>
  </div>
  <div class="panel">
    <table>
      <thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Пароль</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="add-form">
      <div class="field"><label>Имя</label><input id="new-u-name" type="text" placeholder="Айгуль"></div>
      <div class="field"><label>Логин</label><input id="new-u-username" type="text" placeholder="aigul"></div>
      <div class="field"><label>Пароль</label><input id="new-u-password" type="text" placeholder="••••••"></div>
      <div class="field">
        <label>Роль</label>
        <select id="new-u-role"><option value="cashier">Кассир</option><option value="admin">Админ</option></select>
      </div>
      <button class="btn btn-hop" onclick="addUser()">Добавить</button>
    </div>
    ${state.userFormError ? `<div class="login-error" style="margin-top:12px;">${esc(state.userFormError)}</div>` : ''}
  </div>`;
}

/* ============ RENDER: RECEIPT MODAL ============ */
function paymentMethodLabel(r) {
  if (r.payment_method === 'qr') return 'QR-код';
  if (r.payment_method === 'mixed') return `Смешанный (нал. ${fmt(r.cash_amount)} + QR ${fmt(r.qr_amount)})`;
  return 'Наличные';
}
function paymentMethodLabelShort(r) {
  if (r.payment_method === 'qr') return 'QR';
  if (r.payment_method === 'mixed') return 'Смеш.';
  return 'Нал.';
}
function renderReceiptModal() {
  const r = state.receiptToShow;
  if (!r) return '';
  const items = r.items || [];
  const lines = items.map(i => `
    <div class="receipt-line">
      <span>${esc(i.product_name || i.name)}</span>
      <span class="qp">${i.qty} × ${fmt(i.price)}</span>
    </div>`).join('');
  const changeDue = r.payment_method !== 'qr' && r.received_amount != null ? Number(r.received_amount) - Number(r.total) : 0;
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeReceiptModal()">
    <div class="modal-card">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeReceiptModal()" aria-label="Закрыть">×</button></div>
      <div class="receipt">
        <div class="receipt-head">
          <div class="shop">Хмель</div>
          <div class="meta">Чек №${r.id} · ${fmtDate(r.created_at)}<br>Кассир: ${esc(r.cashier_name)}</div>
        </div>
        ${lines}
        <div class="receipt-total"><span>Итого</span><span>${fmt(r.total)}</span></div>
        <div class="receipt-line"><span>Оплата</span><span class="qp">${paymentMethodLabel(r)}</span></div>
        ${changeDue > 0.01 ? `<div class="receipt-line"><span>Сдача</span><span class="qp">${fmt(changeDue)}</span></div>` : ''}
        <div class="receipt-foot">Спасибо за покупку!</div>
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" style="flex:1;" onclick="window.print()">Печать</button>
        <button class="btn btn-primary" style="flex:1;" onclick="closeReceiptModal()">Готово</button>
      </div>
    </div>
  </div>`;
}

/* ============ MASTER RENDER ============ */
function render() {
  const app = document.getElementById('app');
  if (!state.currentUser) { app.innerHTML = renderLogin(); return; }
  if (state.loading) { app.innerHTML = '<div class="login-wrap"><p class="mono">Загрузка…</p></div>'; return; }

  let viewHtml = '';
  if (state.view === 'pos') viewHtml = renderPOS();
  else if (state.view === 'products') viewHtml = renderProducts();
  else if (state.view === 'history') viewHtml = renderHistory();
  else if (state.view === 'trash' && state.currentUser.role === 'admin') viewHtml = renderTrash();
  else if (state.view === 'analytics' && state.currentUser.role === 'admin') viewHtml = renderAnalytics();
  else if (state.view === 'users' && state.currentUser.role === 'admin') viewHtml = renderUsers();
  else viewHtml = renderPOS();

  app.innerHTML = `
    <div class="shell">
      ${renderSidebar()}
      <main class="content ${state.view === 'pos' ? 'content-wide' : ''}">${viewHtml}</main>
    </div>
    ${renderReceiptModal()}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}
  `;
  if (state.view === 'pos' && !state.receiptToShow && !state.showPaymentModal) focusScanInput();
  if (state.view === 'analytics') renderAnalyticsChart();
}

/* ============ INIT ============ */
(async function init() {
  render();
  if (state.currentUser && state.token) {
    await loadAll();
  } else {
    state.loading = false;
    render();
  }
})();
