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
  productEditId: null, // открытое окно товара
  productDraft: null,
  productsLowOnly: false,
  showCategoryPanel: false,
  addProductContext: 'products', // 'products' | 'stock' — откуда открыто окно «Новый товар»
  addProductPrefillBarcode: '',
  // ---- Склад ----
  stockTab: 'new', // 'new' | 'history' | 'suppliers'
  stockDraft: loadStockDraft(),
  stockSearch: '',
  suppliers: [],
  stockReceipts: [],
  stockReceiptToShow: null,
  showSupplierModal: false,
  supplierEditId: null,
  supplierFormError: '',
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
function fmt(n) { return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' \u20B8'; }
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
  const candidates = barcodeCandidates(code);
  for (const c of candidates) {
    const p = state.products.find(p => p.barcode && p.barcode === c);
    if (p) return p;
  }
  return null;
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
  state.lastAddedId = productId;
  render();
  setTimeout(() => { if (state.lastAddedId === productId) state.lastAddedId = null; }, 600);
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
  if (Scanner.open) return; // камера открыта — не вызываем клавиатуру на телефоне
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
    state.justPaid = {
      id: receipt.id,
      change: paymentDetails.received_amount != null ? Math.max(0, +(Number(paymentDetails.received_amount) - Number(receipt.total)).toFixed(2)) : 0,
      received: paymentDetails.received_amount,
    };
    state.receiptToShow = receipt;
    render();
  } catch (err) {
    showToast(err.message || 'Не удалось оформить чек');
  }
}
function closeReceiptModal() { state.receiptToShow = null; state.justPaid = null; render(); focusScanInput(); }
async function openReceipt(id) {
  state.justPaid = null;
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
  const stockEl = document.getElementById('new-p-stock');
  const stock = stockEl ? Number(stockEl.value) : 0;
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
    if (state.addProductContext === 'stock') {
      addToStockDraft(created.id, 1, { cost_price: costPrice || '', price: '' });
      state.addProductContext = 'products';
      state.addProductPrefillBarcode = '';
      render();
      showToast('Товар «' + created.name + '» создан и добавлен в приход');
      return;
    }
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
function openAddProductModal(context, barcode) {
  state.addProductContext = context === 'stock' ? 'stock' : 'products';
  state.addProductPrefillBarcode = barcode || '';
  state.showAddProductModal = true;
  render();
  const el = document.getElementById('new-p-name');
  if (el) el.focus();
}
function closeAddProductModal() {
  state.showAddProductModal = false;
  state.addProductContext = 'products';
  state.addProductPrefillBarcode = '';
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
  if (v === 'stock') await loadStockData();
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
  const items = [{ id: 'pos', label: 'Касса' }, { id: 'products', label: 'Товары' }, { id: 'stock', label: 'Склад' }];
  items.push({ id: 'history', label: 'История чеков' });
  if (role === 'admin') items.push({ id: 'analytics', label: 'Показатели' });
  if (role === 'admin') items.push({ id: 'trash', label: 'Корзина' });
  if (role === 'admin') items.push({ id: 'users', label: 'Пользователи' });
  return items;
}
function renderSidebar() {
  const items = navItems().map(it => `
    <button class="nav-item ${state.view === it.id ? 'active' : ''}" onclick="setView('${it.id}')" title="${esc(it.label)}">${icon(it.id, 20)}<span class="nav-label">${esc(it.label)}</span></button>
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
        <div class="user-avatar" title="${esc(state.currentUser.name)}">${esc(state.currentUser.name.trim().charAt(0).toUpperCase())}</div>
        <div class="user-meta">
          <div class="who">${esc(state.currentUser.name)}</div>
          <span class="badge ${state.currentUser.role === 'admin' ? 'badge-admin' : 'badge-cashier'}">${state.currentUser.role === 'admin' ? 'Админ' : 'Кассир'}</span>
        </div>
        <button class="btn btn-ghost btn-sm user-logout" style="margin-left:auto;" onclick="logout()" title="Выйти">${icon('logout', 18)}<span class="nav-label">Выйти</span></button>
      </div>
    </nav>
    ${state.mobileMenuOpen ? `<div class="mobile-menu-backdrop" onclick="toggleMobileMenu()"></div>` : ''}
  </aside>`;
}

/* ============ RENDER: POS (касса для сенсорных моноблоков) ============ */
const ICONS = {
  pos: '<path d="M4 7h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M8 12h8"/>',
  products: '<path d="M9 3h6v4l2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9l2-2z"/><path d="M7 13h10"/>',
  stock: '<path d="M3 9l9-5 9 5v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M7 20v-7h10v7"/><path d="M7 16h10"/>',
  history: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  cart: '<path d="M3 4h2l2.4 11h11L21 7H6.2"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 10v4M18 10v4"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  mixed: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  back: '<path d="M21 5H9l-6 7 6 7h12z"/><path d="M17 9l-6 6M11 9l6 6"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
};
function icon(name, size = 22) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function renderPOS() {
  const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const search = state.posSearch.trim().toLowerCase();
  const filtered = state.products.filter(p => {
    const matchesCategory = state.posCategory === 'all' || p.category === state.posCategory;
    const matchesSearch = !search || p.name.toLowerCase().includes(search) || (p.barcode && p.barcode.includes(search));
    return matchesCategory && matchesSearch;
  });

  const productCards = filtered.map(p => {
    const inCart = state.cart.find(i => i.productId === p.id);
    const consumption = unitConsumption(p);
    const availableVolume = Number(p.stock) - (inCart ? inCart.qty : 0) * consumption;
    const canAddOne = availableVolume + 1e-9 >= consumption;
    const isDraft = p.unit === 'л';
    const stockText = isDraft ? availableVolume.toFixed(2).replace(/\.?0+$/, '') + ' л' : Math.round(availableVolume) + ' шт';
    const low = isDraft ? availableVolume <= Math.max(consumption * 2, 3) : availableVolume <= 5;
    return `
    <button class="pos2-card ${inCart ? 'in-cart' : ''}" ${!canAddOne ? 'disabled' : ''} onclick="addToCart(${p.id})">
      ${inCart ? `<span class="pos2-card-badge">${inCart.qty}</span>` : ''}
      <div class="pos2-card-media">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : `<span class="pos2-card-ph">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`}
      </div>
      <div class="pos2-card-name">${esc(p.name)}</div>
      <div class="pos2-card-foot">
        <span class="pos2-card-price">${fmt(p.price)}</span>
        <span class="pos2-card-stock ${!canAddOne ? 'out' : low ? 'low' : ''}">${canAddOne ? stockText : 'нет'}</span>
      </div>
    </button>`;
  }).join('');

  const chips = ['all', ...categories].map(c => {
    const count = c === 'all' ? state.products.length : state.products.filter(p => p.category === c).length;
    return `<button class="pos2-chip ${state.posCategory === c ? 'active' : ''}" onclick="setPosCategory('${esc(c).replace(/'/g, "\\'")}')">${c === 'all' ? 'Все' : esc(c)}<span>${count}</span></button>`;
  }).join('');

  const cartRows = state.cart.map((i, idx) => {
    const p = state.products.find(x => x.id === i.productId);
    return `
    <div class="pos2-line ${state.lastAddedId === i.productId ? 'just-added' : ''}">
      <div class="pos2-line-info">
        <div class="pos2-line-name">${esc(i.name)}</div>
        <div class="pos2-line-price">${fmt(i.price)}${p && p.unit === 'л' ? ' · ' + unitConsumption(p) + ' л' : ''}</div>
      </div>
      <div class="pos2-stepper">
        <button onclick="changeCartQty(${i.productId}, -1)" aria-label="Меньше">−</button>
        <span>${i.qty}</span>
        <button onclick="changeCartQty(${i.productId}, 1)" aria-label="Больше">+</button>
      </div>
      <div class="pos2-line-sum">${fmt(i.price * i.qty)}</div>
      <button class="pos2-line-del" onclick="changeCartQty(${i.productId}, -${i.qty})" aria-label="Убрать">×</button>
    </div>`;
  }).join('');

  const flashClass = state.scanFlash === 'ok' ? 'flash' : state.scanFlash === 'error' ? 'flash-error' : '';
  const itemsCount = state.cart.reduce((s, i) => s + i.qty, 0);
  const total = cartTotal();
  const empty = state.cart.length === 0;

  return `
  <div class="pos2">
    <section class="pos2-left">
      <div class="pos2-search ${flashClass}">
        <span class="pos2-search-ico">${icon('search', 22)}</span>
        <input id="scan-input" type="text" autocomplete="off"
          placeholder="Сканируйте штрихкод или ищите по названию"
          autofocus
          onkeydown="if(event.key==='Enter'){ event.preventDefault(); handleScanSubmit(this.value); } else if(event.key==='Escape'){ handlePosSearchInput(''); }"
          oninput="handlePosSearchInput(this.value)"
          value="${esc(state.posSearch)}">
        ${state.posSearch ? `<button class="pos2-search-clear" onclick="handlePosSearchInput('')" aria-label="Очистить поиск">×</button>` : ''}
        <button type="button" class="pos2-camera" onclick="openPosCamera()" title="Сканировать камерой">${CAMERA_ICON}<span>Камера</span></button>
      </div>
      ${categories.length > 0 ? `<div class="pos2-chips">${chips}</div>` : ''}
      <div class="pos2-grid-wrap">
        <div class="pos2-grid">${productCards || `<div class="empty-state">${state.products.length === 0 ? 'Нет товаров. Обратитесь к администратору.' : 'Ничего не найдено'}</div>`}</div>
      </div>
    </section>

    <aside class="pos2-right">
      <div class="pos2-check-head">
        <div>
          <div class="pos2-check-title">${icon('cart', 20)} Чек</div>
          <div class="pos2-check-meta">${esc(state.currentUser.name)} · ${new Date().toLocaleDateString('ru-RU')}</div>
        </div>
        <button class="pos2-clear" ${empty ? 'disabled' : ''} onclick="clearCart()">${icon('trash', 18)} Очистить</button>
      </div>
      <div class="pos2-lines" id="pos2-lines">
        ${empty ? `
        <div class="pos2-empty">
          <div class="pos2-empty-ico">${CAMERA_ICON}</div>
          <div class="pos2-empty-title">Чек пуст</div>
          <div class="pos2-empty-sub">Отсканируйте штрихкод или нажмите на товар слева</div>
        </div>` : cartRows}
      </div>
      <div class="pos2-summary">
        <div class="pos2-summary-row"><span>Позиций</span><span>${state.cart.length} · ${itemsCount} ед.</span></div>
        <div class="pos2-total"><span>Итого</span><span class="pos2-total-val">${fmt(total)}</span></div>
        <button class="pos2-pay" ${empty ? 'disabled' : ''} onclick="openPaymentModal()">
          <span>Оплата</span><kbd>F2</kbd>
        </button>
        <div class="pos2-fast">
          <button ${empty ? 'disabled' : ''} onclick="quickPay('cash')">${icon('cash', 20)} Наличные без сдачи</button>
          <button ${empty ? 'disabled' : ''} onclick="quickPay('qr')">${icon('qr', 20)} QR</button>
        </div>
      </div>
    </aside>
  </div>
  ${state.showPaymentModal ? renderPaymentModal() : ''}`;
}

/* ============ ОПЛАТА (экранная клавиатура, быстрые купюры, сдача) ============ */
const BANKNOTES = [500, 1000, 2000, 5000, 10000, 20000];
function quickCashAmounts(total) {
  const set = new Set();
  BANKNOTES.forEach(n => {
    const v = Math.ceil(total / n) * n;
    if (v > total + 0.001) set.add(v);
  });
  return [...set].sort((a, b) => a - b).slice(0, 5);
}
function paymentTargetValue() {
  const f = state.paymentActiveField;
  if (f === 'cash') return state.paymentCashPart;
  if (f === 'qr') return state.paymentQrPart;
  return state.paymentReceived;
}
function setPaymentTargetValue(v) {
  const f = state.paymentActiveField;
  if (f === 'cash') state.paymentCashPart = v;
  else if (f === 'qr') state.paymentQrPart = v;
  else state.paymentReceived = v;
}
function numpadPress(key) {
  if (state.paymentMethod === 'qr') return;
  let v = String(paymentTargetValue() || '');
  if (key === 'back') v = v.slice(0, -1);
  else if (key === 'clear') v = '';
  else if (key === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
  else {
    if (v === '0') v = '';
    if (v.includes('.') && v.split('.')[1].length >= 2) return;
    if (v.replace('.', '').length >= 9) return;
    v += key;
  }
  setPaymentTargetValue(v);
  render();
}
function setQuickCash(amount) {
  state.paymentActiveField = 'received';
  state.paymentReceived = String(amount);
  render();
}
function openPaymentModal() {
  if (state.cart.length === 0 || state.showPaymentModal) return;
  state.showPaymentModal = true;
  state.payAnimate = true; // анимация появления — только при открытии, не на каждое нажатие цифры
  state.paymentMethod = 'cash';
  state.paymentActiveField = 'received';
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
  state.paymentActiveField = method === 'mixed' ? 'cash' : 'received';
  render();
}
function setPaymentActiveField(f) {
  state.paymentActiveField = f;
  render();
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
  state.paymentActiveField = field;
  render();
}
function paymentCanConfirm() {
  const total = cartTotal();
  if (state.paymentMethod === 'qr') return true;
  if (state.paymentMethod === 'cash') {
    // Пустое поле = без сдачи (ровно)
    const r = state.paymentReceived === '' ? total : Number(state.paymentReceived) || 0;
    return r >= total - 0.01;
  }
  const cash = Number(state.paymentCashPart) || 0;
  const qr = Number(state.paymentQrPart) || 0;
  return Math.abs(cash + qr - total) <= 0.01;
}
function confirmPayment() {
  const total = cartTotal();
  const method = state.paymentMethod;
  if (method === 'cash') {
    const received = state.paymentReceived === '' ? total : Number(state.paymentReceived) || 0;
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
// Быстрые кнопки под «Оплатой»: один тап — чек проведён
function quickPay(method) {
  if (state.cart.length === 0) return;
  const total = cartTotal();
  if (method === 'qr') checkout({ payment_method: 'qr', cash_amount: 0, qr_amount: total, received_amount: null });
  else checkout({ payment_method: 'cash', cash_amount: total, qr_amount: 0, received_amount: total });
}

function renderPaymentModal() {
  const total = cartTotal();
  const method = state.paymentMethod;
  const active = state.paymentActiveField;
  const receivedStr = state.paymentReceived;
  const received = receivedStr === '' ? 0 : Number(receivedStr) || 0;
  const change = received - total;
  const cashPart = Number(state.paymentCashPart) || 0;
  const qrPart = Number(state.paymentQrPart) || 0;
  const mixedDiff = +(total - cashPart - qrPart).toFixed(2);
  const canConfirm = paymentCanConfirm();
  const showValue = v => (v === '' ? '' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + (String(v).endsWith('.') ? ',' : ''));

  let resultBox = '';
  if (method === 'cash') {
    if (receivedStr === '') resultBox = `<div class="pay2-change neutral"><span>Сдача</span><b>—</b><small>Введите сумму от покупателя или нажмите «Без сдачи»</small></div>`;
    else if (change >= -0.01) resultBox = `<div class="pay2-change ok"><span>Сдача</span><b>${fmt(Math.max(0, +change.toFixed(2)))}</b></div>`;
    else resultBox = `<div class="pay2-change bad"><span>Не хватает</span><b>${fmt(+(-change).toFixed(2))}</b></div>`;
  } else if (method === 'mixed') {
    resultBox = `<div class="pay2-change ${Math.abs(mixedDiff) <= 0.01 ? 'ok' : 'bad'}"><span>${mixedDiff > 0.01 ? 'Не хватает' : mixedDiff < -0.01 ? 'Лишнее' : 'Сходится'}</span><b>${fmt(Math.abs(mixedDiff))}</b></div>`;
  }

  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', 'back'];
  const numpad = `
    <div class="pay2-numpad ${method === 'qr' ? 'disabled' : ''}">
      ${keys.map(k => `<button onclick="numpadPress('${k}')" ${k === 'back' ? 'class="key-back" aria-label="Стереть"' : ''}>${k === 'back' ? icon('back', 26) : k}</button>`).join('')}
      <button class="key-clear" onclick="numpadPress('clear')">Сброс</button>
    </div>`;

  return `
  <div class="modal-overlay pay2-overlay" onclick="if(event.target===this) closePaymentModal()">
    <div class="pay2 ${state.payAnimate ? 'pay2-anim' : ''}" role="dialog" aria-label="Оплата">
      <div class="pay2-head">
        <div>
          <div class="pay2-head-label">К оплате</div>
          <div class="pay2-head-total">${fmt(total)}</div>
        </div>
        <button class="pay2-close" onclick="closePaymentModal()" aria-label="Закрыть">×</button>
      </div>

      <div class="pay2-methods">
        <button class="${method === 'cash' ? 'active' : ''}" onclick="setPaymentMethod('cash')">${icon('cash', 24)}<span>Наличные</span></button>
        <button class="${method === 'qr' ? 'active' : ''}" onclick="setPaymentMethod('qr')">${icon('qr', 24)}<span>QR / Kaspi</span></button>
        <button class="${method === 'mixed' ? 'active' : ''}" onclick="setPaymentMethod('mixed')">${icon('mixed', 24)}<span>Смешанная</span></button>
      </div>

      <div class="pay2-body">
        <div class="pay2-left">
          ${method === 'cash' ? `
            <div class="pay2-field active">
              <label>Получено от покупателя</label>
              <div class="pay2-display">${showValue(receivedStr) || '<span class="ph">0</span>'}<span class="cur">₸</span></div>
            </div>
            <div class="pay2-quick">
              <button class="exact" onclick="setQuickCash(${total})">Без сдачи</button>
              ${quickCashAmounts(total).map(a => `<button onclick="setQuickCash(${a})">${a.toLocaleString('ru-RU')}</button>`).join('')}
            </div>
            ${resultBox}` : ''}

          ${method === 'qr' ? `
            <div class="pay2-qr">
              <div class="pay2-qr-ico">${icon('qr', 64)}</div>
              <div class="pay2-qr-title">Оплата по QR</div>
              <div class="pay2-qr-sub">Покажите покупателю QR-код на терминале на сумму <b>${fmt(total)}</b> и дождитесь подтверждения оплаты.</div>
            </div>` : ''}

          ${method === 'mixed' ? `
            <button class="pay2-field ${active === 'cash' ? 'active' : ''}" onclick="setPaymentActiveField('cash')">
              <label>${icon('cash', 16)} Наличными</label>
              <div class="pay2-display small">${showValue(state.paymentCashPart) || '<span class="ph">0</span>'}<span class="cur">₸</span></div>
            </button>
            <button class="pay2-rest" onclick="fillMixedRest('cash')">Остаток наличными</button>
            <button class="pay2-field ${active === 'qr' ? 'active' : ''}" onclick="setPaymentActiveField('qr')">
              <label>${icon('qr', 16)} По QR</label>
              <div class="pay2-display small">${showValue(state.paymentQrPart) || '<span class="ph">0</span>'}<span class="cur">₸</span></div>
            </button>
            <button class="pay2-rest" onclick="fillMixedRest('qr')">Остаток по QR</button>
            ${resultBox}` : ''}
        </div>
        <div class="pay2-right">${numpad}</div>
      </div>

      <div class="pay2-actions">
        <button class="pay2-cancel" onclick="closePaymentModal()">Отмена <kbd>Esc</kbd></button>
        <button class="pay2-confirm" ${canConfirm ? '' : 'disabled'} onclick="confirmPayment()">${icon('check', 24)} ${method === 'qr' ? 'Оплачено' : 'Провести чек'} <kbd>Enter</kbd></button>
      </div>
    </div>
  </div>`;
}

/* ---- Клавиатура: F2 — оплата, цифры/Enter/Esc в окне оплаты ---- */
document.addEventListener('keydown', (e) => {
  if (!state.currentUser) return;
  if (Scanner.open) { if (e.key === 'Escape') closeCameraScanner(); return; }
  if (state.showPaymentModal) {
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); numpadPress(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); numpadPress('back'); }
    else if (e.key === 'Delete') { e.preventDefault(); numpadPress('clear'); }
    else if (e.key === '.' || e.key === ',') { e.preventDefault(); numpadPress('.'); }
    else if (e.key === 'Enter') { e.preventDefault(); if (paymentCanConfirm()) confirmPayment(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePaymentModal(); }
    else if (e.key === 'F2') e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && state.productEditId) { e.preventDefault(); closeProductSheet(); return; }
  if (state.view !== 'pos') return;
  // После продажи открыт чек: Enter/Esc — новая продажа; начали сканировать — чек закрывается сам
  if (state.receiptToShow) {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closeReceiptModal(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      closeReceiptModal();
      const el = document.getElementById('scan-input');
      if (el) { el.value += e.key; state.posSearch = el.value; }
    }
    return;
  }
  if (e.key === 'F2' || e.key === 'F9') { e.preventDefault(); openPaymentModal(); }
});

function clearCart() {
  if (state.cart.length === 0) return;
  if (!confirm('Очистить текущий чек?')) return;
  state.cart = [];
  render();
  focusScanInput();
}

/* ============ RENDER: PRODUCTS (список-карточки + окно редактирования) ============ */
function productStockInfo(p) {
  const isDraft = p.unit === 'л';
  const n = Number(p.stock) || 0;
  const text = (Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, '')) + ' ' + (isDraft ? 'л' : 'шт');
  const cls = n <= 0 ? 'out' : isLowStock(p) ? 'low' : 'ok';
  return { text: n <= 0 ? 'нет' : text, cls };
}
function productThumb(p, cls) {
  return p.image_url
    ? `<img class="${cls}" src="${esc(p.image_url)}" alt="" loading="lazy">`
    : `<div class="${cls} ph">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</div>`;
}
function setProductsCategory(c) { state.posCategoryAdmin = c; render(); }
function toggleProductsLowOnly() { state.productsLowOnly = !state.productsLowOnly; render(); }
function toggleCategoryPanel() { state.showCategoryPanel = !state.showCategoryPanel; render(); }

function renderProducts() {
  const isAdmin = state.currentUser.role === 'admin';
  const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const search = state.productsSearch.trim().toLowerCase();
  const cat = state.posCategoryAdmin || 'all';
  const filtered = state.products.filter(p => {
    if (cat !== 'all' && p.category !== cat) return false;
    if (state.productsLowOnly && !isLowStock(p)) return false;
    return !search || p.name.toLowerCase().includes(search) || (p.barcode && p.barcode.includes(search));
  });
  const lowCount = state.products.filter(isLowStock).length;
  const stockValue = state.products.reduce((s, p) => s + (Number(p.cost_price) || 0) * Math.max(0, Number(p.stock) || 0), 0);

  const rows = filtered.map(p => {
    const st = productStockInfo(p);
    const cost = Number(p.cost_price) || 0;
    const markup = cost > 0 ? Math.round((Number(p.price) - cost) / cost * 100) : null;
    return `
    <button class="pl-row ${st.cls !== 'ok' ? 'warn' : ''}" onclick="openProductSheet(${p.id})">
      ${productThumb(p, 'pl-thumb')}
      <div class="pl-main">
        <div class="pl-name">${esc(p.name)}</div>
        <div class="pl-sub">
          <span class="pl-cat">${esc(p.category || 'Без категории')}</span>
          ${p.barcode ? `<span class="mono">${esc(p.barcode)}</span>` : '<span class="pl-nobc">без штрихкода</span>'}
        </div>
        ${isAdmin ? `<div class="pl-cost">закуп ${cost > 0 ? fmt(cost) : '—'}${markup !== null ? ` · наценка ${markup}%` : ''}</div>` : ''}
      </div>
      <div class="pl-right">
        <div class="pl-price">${fmt(p.price)}${p.unit === 'л' ? `<small>/${Number(p.volume_liters || 1)} л</small>` : ''}</div>
        <span class="pl-stock ${st.cls}">${st.text}</span>
      </div>
      <span class="pl-chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');

  const chips = ['all', ...categories].map(c => {
    const count = c === 'all' ? state.products.length : state.products.filter(p => p.category === c).length;
    return `<button class="pos2-chip ${cat === c ? 'active' : ''}" onclick="setProductsCategory('${esc(c).replace(/'/g, "\\'")}')">${c === 'all' ? 'Все' : esc(c)}<span>${count}</span></button>`;
  }).join('');

  const categoryManageRows = categories.map(c => {
    const count = state.products.filter(p => p.category === c).length;
    const markup = state.categoryMarkups[c] !== undefined ? state.categoryMarkups[c] : '';
    const q = esc(c).replace(/'/g, "\\'");
    return `
    <div class="cat-manage-row">
      <div class="cat-manage-title">
        <span class="cat-manage-name">${esc(c)}</span>
        <span class="cat-manage-count">${count} шт.</span>
      </div>
      <div class="cat-manage-actions">
        <div class="cat-markup-cell">
          <input type="number" inputmode="decimal" class="num" step="0.1" min="0" placeholder="0" value="${markup}" onchange="updateCategoryMarkup('${q}', this.value)">
          <span>%</span>
          <button class="btn btn-hop btn-sm" onclick="applyCategoryMarkup('${q}')">Применить</button>
        </div>
        <div class="cat-manage-buttons">
          <button class="btn btn-ghost btn-sm" onclick="renameCategory('${q}')">Переименовать</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCategory('${q}')">Удалить</button>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="page-head">
    <div><h2>Товары</h2><div class="page-sub">${isAdmin ? 'Нажмите на товар, чтобы изменить цену, остаток, фото' : 'Просмотр ассортимента. Добавлять новые товары можно кнопкой «+»'}</div></div>
    ${isAdmin && categories.length ? `<button class="btn btn-ghost pl-cat-toggle ${state.showCategoryPanel ? 'on' : ''}" onclick="toggleCategoryPanel()">Категории и наценка ${state.showCategoryPanel ? '▴' : '▾'}</button>` : ''}
  </div>

  ${isAdmin && state.showCategoryPanel && categories.length ? `
  <div class="panel pl-cat-panel">
    <div class="page-sub" style="margin:0 0 10px;">Цена = себестоимость × (1 + наценка/100). Применяется к товарам, у которых указана себестоимость.</div>
    <div class="cat-manage-list">${categoryManageRows}</div>
  </div>` : ''}

  <div class="pl-stats">
    <div class="pl-stat"><span>Товаров</span><b>${state.products.length}</b></div>
    <button class="pl-stat ${state.productsLowOnly ? 'active' : ''} ${lowCount ? 'alert' : ''}" onclick="toggleProductsLowOnly()"><span>Заканчиваются</span><b>${lowCount}</b></button>
    ${isAdmin ? `<div class="pl-stat"><span>Склад по закупу</span><b>${fmt(Math.round(stockValue))}</b></div>` : ''}
  </div>

  <div class="pl-toolbar">
    <div class="pos2-search pl-search">
      <span class="pos2-search-ico">${icon('search', 20)}</span>
      <input id="products-search-input" type="text" autocomplete="off" placeholder="Название или штрихкод" value="${esc(state.productsSearch)}" oninput="handleProductsSearchInput(this.value)">
      ${state.productsSearch ? `<button class="pos2-search-clear" onclick="handleProductsSearchInput('')" aria-label="Очистить">×</button>` : ''}
      <button type="button" class="pos2-camera" onclick="scanIntoProductsSearch()" title="Найти по штрихкоду камерой">${CAMERA_ICON}</button>
    </div>
    ${categories.length ? `<div class="pos2-chips">${chips}</div>` : ''}
  </div>

  ${state.productsLowOnly ? `<div class="pl-filter-note">Показаны только товары, которые заканчиваются · <button class="linklike" onclick="toggleProductsLowOnly()">показать все</button></div>` : ''}

  <div class="pl-list">${rows}</div>
  ${state.products.length === 0 ? '<div class="panel"><div class="empty-state">Товаров пока нет — нажмите «+», чтобы добавить первый.</div></div>' : ''}
  ${state.products.length > 0 && filtered.length === 0 ? '<div class="panel"><div class="empty-state">Ничего не найдено.</div></div>' : ''}

  <button class="fab" onclick="openAddProductModal('products')" aria-label="Добавить товар" title="Добавить товар">+</button>
  ${state.productEditId ? renderProductSheet(categories, isAdmin) : ''}
  ${state.showAddProductModal ? renderAddProductModalAnywhere() : ''}`;
}

function scanIntoProductsSearch() {
  openCameraScanner({
    title: 'Найти товар по штрихкоду',
    continuous: false,
    onCode: (code) => {
      const p = findProductByBarcode(code);
      state.productsSearch = '';
      if (p) setTimeout(() => openProductSheet(p.id), 0);
      else setTimeout(() => { showToast('Штрихкод «' + code + '» не найден — можно создать товар'); openAddProductModal('products', preferredBarcode(code)); }, 0);
      return { ok: !!p, close: true };
    },
  });
}

/* ---- Окно товара (редактирование у админа, просмотр у кассира) ---- */
function openProductSheet(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  state.productEditId = id;
  state.productDraft = {
    name: p.name || '',
    category: p.category || 'Без категории',
    barcode: p.barcode || '',
    unit: p.unit === 'л' ? 'л' : 'шт',
    volume_liters: p.volume_liters != null ? String(Number(p.volume_liters)) : '1',
    cost_price: Number(p.cost_price) > 0 ? String(Number(p.cost_price)) : '',
    price: String(Number(p.price)),
    stock: String(Number(p.stock)),
  };
  render();
}
function closeProductSheet() {
  state.productEditId = null;
  state.productDraft = null;
  render();
}
function setProductDraft(field, value, rerender) {
  if (!state.productDraft) return;
  state.productDraft[field] = value;
  if (rerender) render(); else updateMarginHint();
}
function updateMarginHint() {
  const el = document.getElementById('pe-margin');
  if (!el || !state.productDraft) return;
  el.innerHTML = marginHintHtml(state.productDraft);
}
function marginHintHtml(d) {
  const cost = Number(String(d.cost_price).replace(',', '.')) || 0;
  const price = Number(String(d.price).replace(',', '.')) || 0;
  if (!(cost > 0 && price > 0)) return '<span>Укажите себестоимость — покажу наценку и прибыль с единицы</span>';
  const profit = price - cost;
  const markup = Math.round(profit / cost * 100);
  return `<span>Наценка <b>${markup}%</b></span><span>Прибыль с ед. <b class="${profit < 0 ? 'neg' : ''}">${fmt(+profit.toFixed(2))}</b></span>`;
}
function stepProductDraft(field, delta) {
  const d = state.productDraft;
  if (!d) return;
  const v = Math.max(0, +((Number(String(d[field]).replace(',', '.')) || 0) + delta).toFixed(2));
  d[field] = String(v);
  const el = document.getElementById('pe-' + field);
  if (el) el.value = d[field];
}
function addCategoryToSheet() {
  const val = prompt('Название новой категории:');
  if (!val || !val.trim()) return;
  setProductDraft('category', val.trim(), true);
}
async function saveProductSheet() {
  const id = state.productEditId;
  const d = state.productDraft;
  if (!id || !d) return;
  const num = v => Number(String(v).replace(',', '.'));
  if (!d.name.trim()) { showToast('Укажите название'); return; }
  if (!(num(d.price) > 0)) { showToast('Укажите цену больше нуля'); return; }
  if (d.unit !== 'л' && !Number.isInteger(num(d.stock))) { showToast('Остаток в штуках должен быть целым'); return; }
  const body = {
    name: d.name.trim(),
    category: d.category,
    barcode: d.barcode.trim(),
    unit: d.unit,
    price: num(d.price),
    stock: Math.max(0, num(d.stock) || 0),
    cost_price: Math.max(0, num(d.cost_price) || 0),
  };
  if (d.unit === 'л') body.volume_liters = num(d.volume_liters) || 1;
  try {
    const updated = await api('/products/' + id, { method: 'PUT', body });
    const idx = state.products.findIndex(p => p.id === id);
    if (idx >= 0) state.products[idx] = updated;
    state.productEditId = null;
    state.productDraft = null;
    render();
    showToast('Сохранено');
  } catch (err) { showToast(err.message); }
}
async function deleteProductFromSheet() {
  const id = state.productEditId;
  const p = state.products.find(x => x.id === id);
  if (!p || !confirm('Удалить «' + p.name + '» из учёта?')) return;
  try {
    await api('/products/' + id, { method: 'DELETE' });
    state.products = state.products.filter(x => x.id !== id);
    state.productEditId = null;
    state.productDraft = null;
    render();
    showToast('Товар удалён');
  } catch (err) { showToast(err.message); }
}

function renderProductSheet(categories, isAdmin) {
  const p = state.products.find(x => x.id === state.productEditId);
  if (!p) return '';
  const d = state.productDraft;
  const st = productStockInfo(p);
  const isDraft = d.unit === 'л';
  const cats = [...new Set([...categories, d.category].filter(Boolean))].sort();

  const photo = `
    <div class="pe-photo">
      ${productThumb(p, 'pe-photo-img')}
      ${isAdmin ? `
      <div class="pe-photo-actions">
        <input type="file" accept="image/*" id="pe-img-input" style="display:none" onchange="uploadProductImage(${p.id}, this.files[0])">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('pe-img-input').click()">${p.image_url ? 'Сменить фото' : 'Добавить фото'}</button>
        ${p.image_url ? `<button class="thumb-remove" onclick="removeProductImage(${p.id})">убрать фото</button>` : ''}
      </div>` : ''}
    </div>`;

  if (!isAdmin) {
    return `
    <div class="modal-overlay sheet-overlay" onclick="if(event.target===this) closeProductSheet()">
      <div class="sheet" role="dialog" aria-label="${esc(p.name)}">
        <div class="sheet-head"><h3>${esc(p.name)}</h3><button class="pay2-close sheet-close" onclick="closeProductSheet()" aria-label="Закрыть">×</button></div>
        <div class="sheet-body">
          ${photo}
          <div class="pvc-row"><span>Категория</span><span>${esc(p.category || '—')}</span></div>
          <div class="pvc-row"><span>Штрихкод</span><span class="mono">${esc(p.barcode || '—')}</span></div>
          <div class="pvc-row"><span>Цена</span><span class="num">${fmt(p.price)}</span></div>
          <div class="pvc-row"><span>Остаток</span><span class="pl-stock ${st.cls}">${st.text}</span></div>
          <div class="page-sub" style="margin-top:12px;">Изменять товары может только администратор.</div>
        </div>
        <div class="sheet-actions"><button class="btn btn-primary" style="flex:1;" onclick="closeProductSheet()">Закрыть</button></div>
      </div>
    </div>`;
  }

  return `
  <div class="modal-overlay sheet-overlay" onclick="if(event.target===this) closeProductSheet()">
    <div class="sheet" role="dialog" aria-label="Товар">
      <div class="sheet-head">
        <h3>Товар</h3>
        <button class="pay2-close sheet-close" onclick="closeProductSheet()" aria-label="Закрыть">×</button>
      </div>
      <div class="sheet-body">
        ${photo}
        <div class="field"><label>Название</label>
          <input id="pe-name" type="text" value="${esc(d.name)}" oninput="setProductDraft('name', this.value)">
        </div>
        <div class="pe-grid">
          <div class="field"><label>Категория</label>
            <div class="pe-inline">
              <select onchange="setProductDraft('category', this.value)">
                ${cats.map(c => `<option value="${esc(c)}" ${d.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              </select>
              <button type="button" class="icon-btn pe-icon" title="Новая категория" onclick="addCategoryToSheet()">+</button>
            </div>
          </div>
          <div class="field"><label>Штрихкод</label>
            <div class="pe-inline">
              <input id="pe-barcode" type="text" class="mono" value="${esc(d.barcode)}" placeholder="—" oninput="setProductDraft('barcode', this.value)" onchange="setProductDraft('barcode', this.value)">
              <button type="button" class="icon-btn pe-icon" title="Сканировать" onclick="scanIntoInput('pe-barcode')">${CAMERA_ICON}</button>
            </div>
          </div>
        </div>

        <div class="field"><label>Как продаётся</label>
          <div class="pe-seg">
            <button class="${!isDraft ? 'active' : ''}" onclick="setProductDraft('unit', 'шт', true)">Штучно (шт)</button>
            <button class="${isDraft ? 'active' : ''}" onclick="setProductDraft('unit', 'л', true)">Разливное (л)</button>
          </div>
        </div>
        ${isDraft ? `
        <div class="field"><label>Объём одной порции, л</label>
          <input type="number" inputmode="decimal" min="0" step="0.1" value="${esc(d.volume_liters)}" oninput="setProductDraft('volume_liters', this.value)">
        </div>` : ''}

        <div class="pe-grid">
          <div class="field"><label>Себестоимость, ₸${isDraft ? '/порция' : ''}</label>
            <input type="number" inputmode="decimal" min="0" step="0.01" value="${esc(d.cost_price)}" placeholder="0" oninput="setProductDraft('cost_price', this.value)">
          </div>
          <div class="field"><label>Цена продажи, ₸</label>
            <input type="number" inputmode="decimal" min="0" step="0.01" class="pe-price" value="${esc(d.price)}" oninput="setProductDraft('price', this.value)">
          </div>
        </div>
        <div class="pe-margin" id="pe-margin">${marginHintHtml(d)}</div>

        <div class="field"><label>Остаток${isDraft ? ', л' : ', шт'}</label>
          <div class="pe-stepper">
            <button onclick="stepProductDraft('stock', -1)" aria-label="Меньше">−</button>
            <input id="pe-stock" type="number" inputmode="decimal" min="0" step="${isDraft ? '0.1' : '1'}" value="${esc(d.stock)}" oninput="setProductDraft('stock', this.value)">
            <button onclick="stepProductDraft('stock', 1)" aria-label="Больше">+</button>
          </div>
          <div class="page-sub" style="margin-top:6px;">Поступления лучше проводить через «Склад → Приход» — так останется история.</div>
        </div>
      </div>
      <div class="sheet-actions">
        <button class="btn btn-danger pe-del" onclick="deleteProductFromSheet()">${icon('trash', 18)}<span>Удалить</span></button>
        <button class="btn btn-ghost" style="flex:1;" onclick="closeProductSheet()">Отмена</button>
        <button class="btn btn-hop pe-save" onclick="saveProductSheet()">${icon('check', 20)} Сохранить</button>
      </div>
    </div>
  </div>`;
}

function renderAddProductModalAnywhere() {
  const isAdmin = state.currentUser.role === 'admin';
  const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const options = categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') || `<option value="Пиво">Пиво</option>`;
  return renderAddProductModal(options, isAdmin);
}
function renderAddProductModal(newProductCategoryOptions, isAdmin) {
  const fromStock = state.addProductContext === 'stock';
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeAddProductModal()">
    <div class="modal-card add-product-modal">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeAddProductModal()" aria-label="Закрыть">×</button></div>
      <div class="add-product-body">
        <h3 class="add-product-title">Новый товар</h3>
        ${fromStock ? `<div class="stock-hint">Штрихкода нет в базе — заполните карточку товара. После сохранения он попадёт в «Товары» и сразу добавится в текущий приход.</div>` : ''}
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
        <div class="field">
          <label>Штрихкод</label>
          <div style="display:flex; gap:6px; align-items:center;">
            <input id="new-p-barcode" type="text" placeholder="Скан. или вручную" value="${esc(state.addProductPrefillBarcode || '')}" style="flex:1;">
            <button type="button" class="icon-btn" title="Сканировать камерой" onclick="scanIntoInput('new-p-barcode')">${CAMERA_ICON}</button>
          </div>
        </div>
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
        ${fromStock ? '' : `<div class="field"><label id="new-p-stock-label">Остаток</label><input id="new-p-stock" type="number" min="0" step="1" placeholder="20"></div>`}
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" style="flex:1;" onclick="closeAddProductModal()">Отмена</button>
        <button class="btn btn-hop" style="flex:1;" onclick="addProduct()">${fromStock ? 'Создать и добавить в приход' : 'Добавить товар'}</button>
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
  const jp = state.justPaid && state.justPaid.id === r.id ? state.justPaid : null;
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeReceiptModal()">
    <div class="modal-card ${jp ? 'paid-card' : ''}">
      ${jp ? `
      <div class="paid-banner">
        <div class="paid-check">${icon('check', 34)}</div>
        <div class="paid-title">Оплата прошла</div>
        ${jp.change > 0.009 ? `
          <div class="paid-change-label">Сдача покупателю</div>
          <div class="paid-change">${fmt(jp.change)}</div>
          <div class="paid-sub">Получено ${fmt(jp.received)} · чек ${fmt(r.total)}</div>` : `
          <div class="paid-sub">${paymentMethodLabel(r)} · ${fmt(r.total)} · без сдачи</div>`}
      </div>` : `
      <div class="modal-close-row"><button class="icon-btn" onclick="closeReceiptModal()" aria-label="Закрыть">×</button></div>`}
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
        <button class="btn btn-primary ${jp ? 'paid-next' : ''}" style="flex:${jp ? 2 : 1};" onclick="closeReceiptModal()">${jp ? 'Новая продажа <kbd>Enter</kbd>' : 'Готово'}</button>
      </div>
    </div>
  </div>`;
}

/* ============ КАМЕРА: СКАНЕР ШТРИХКОДОВ И QR ============ */
const CAMERA_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>`;

// Окно камеры живёт в отдельном контейнере вне #app — иначе render() пересоздавал бы видео.
const Scanner = {
  open: false,
  instance: null,
  continuous: false,
  onCode: null,
  lastCode: '',
  lastAt: 0,
  cameras: [],
  cameraIndex: -1,
};

// Из QR/DataMatrix маркировки (GS1: 01 + GTIN-14 + ...) достаём обычный штрихкод EAN-13,
// чтобы товар нашёлся и по коду маркировки, и по обычному штрихкоду.
function barcodeCandidates(raw) {
  const code = String(raw || '').replace(/[\u001d\u0000-\u001f]/g, '').trim();
  const list = [code];
  const gs1 = code.match(/^(?:\]d2|\]C1|\]Q3)?01(\d{14})/);
  if (gs1) {
    const gtin = gs1[1];
    list.push(gtin);
    if (gtin.startsWith('0')) list.push(gtin.slice(1)); // GTIN-14 → EAN-13
  }
  if (/^\d{14}$/.test(code) && code.startsWith('0')) list.push(code.slice(1));
  return [...new Set(list.filter(Boolean))];
}
// Какой код сохранять в карточку нового товара: для маркировки — EAN-13, иначе сам код
function preferredBarcode(raw) {
  const c = barcodeCandidates(raw);
  return (c[c.length - 1] || '').slice(0, 64);
}

function scannerBeep(ok) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    Scanner.audio = Scanner.audio || new Ctx();
    const ctx = Scanner.audio;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok ? 1250 : 380;
    gain.gain.value = 0.08;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.09 : 0.25));
  } catch (e) { /* звук необязателен */ }
  try { if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch (e) {}
}

function setScannerStatus(text, kind) {
  const el = document.getElementById('scanner-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'scanner-status' + (kind ? ' ' + kind : '');
}

async function openCameraScanner({ title, continuous, onCode }) {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Модуль камеры не загрузился — проверьте интернет и обновите страницу');
    return;
  }
  if (!window.isSecureContext) {
    showToast('Камера работает только по https:// или на localhost');
    return;
  }
  await closeCameraScanner();
  let root = document.getElementById('scanner-root');
  if (!root) { root = document.createElement('div'); root.id = 'scanner-root'; document.body.appendChild(root); }
  root.innerHTML = `
    <div class="scanner-overlay" onclick="if(event.target===this) closeCameraScanner()">
      <div class="scanner-card" role="dialog" aria-label="${esc(title)}">
        <div class="scanner-head">
          <span>${esc(title)}</span>
          <button class="icon-btn" onclick="closeCameraScanner()" aria-label="Закрыть">×</button>
        </div>
        <div class="scanner-video-wrap"><div id="scanner-video"></div></div>
        <div id="scanner-status" class="scanner-status">Запускаю камеру…</div>
        <div class="scanner-actions">
          <button id="scanner-switch" class="btn btn-ghost" onclick="switchScannerCamera()" style="display:none;">Другая камера</button>
          <button class="btn btn-hop" style="flex:1;" onclick="closeCameraScanner()">${continuous ? 'Готово' : 'Отмена'}</button>
        </div>
      </div>
    </div>`;
  Scanner.open = true;
  Scanner.continuous = !!continuous;
  Scanner.onCode = onCode;
  Scanner.lastCode = '';
  Scanner.lastAt = 0;
  document.activeElement && document.activeElement.blur && document.activeElement.blur();

  const F = window.Html5QrcodeSupportedFormats || {};
  const formats = ['QR_CODE', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'DATA_MATRIX']
    .map(k => F[k]).filter(v => v !== undefined);
  Scanner.instance = new Html5Qrcode('scanner-video', {
    verbose: false,
    formatsToSupport: formats.length ? formats : undefined,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });

  try {
    await startScannerCamera({ facingMode: 'environment' });
  } catch (err) {
    // Моноблоки/ноутбуки: задней камеры нет — берём первую доступную
    try {
      Scanner.cameras = await Html5Qrcode.getCameras();
      if (!Scanner.cameras.length) throw new Error('Камера не найдена');
      Scanner.cameraIndex = 0;
      await startScannerCamera(Scanner.cameras[0].id);
    } catch (err2) {
      const msg = String(err2 && (err2.name || err2.message || err2));
      setScannerStatus(/NotAllowed|Permission/i.test(msg)
        ? 'Нет доступа к камере. Разрешите доступ в настройках браузера (значок замка в адресной строке) и попробуйте снова.'
        : 'Камера не найдена или занята другим приложением.', 'error');
      return;
    }
  }
  setScannerStatus('Наведите камеру на штрихкод или QR-код');
  // Показываем «Другая камера», если их несколько
  try {
    if (!Scanner.cameras.length) Scanner.cameras = await Html5Qrcode.getCameras();
    const btn = document.getElementById('scanner-switch');
    if (btn && Scanner.cameras.length > 1) btn.style.display = '';
  } catch (e) {}
}

async function startScannerCamera(cameraConfig) {
  await Scanner.instance.start(
    cameraConfig,
    {
      fps: 12,
      qrbox: (w, h) => {
        const width = Math.floor(Math.min(w * 0.86, 380));
        const height = Math.floor(Math.min(h * 0.62, 240, width));
        return { width, height };
      },
      aspectRatio: 1.333,
    },
    onScannerDecoded,
    () => { /* кадр без кода — это нормально */ }
  );
}

async function switchScannerCamera() {
  if (!Scanner.instance || Scanner.cameras.length < 2) return;
  Scanner.cameraIndex = (Scanner.cameraIndex + 1) % Scanner.cameras.length;
  try {
    if (Scanner.instance.isScanning) await Scanner.instance.stop();
    await startScannerCamera(Scanner.cameras[Scanner.cameraIndex].id);
    setScannerStatus('Камера: ' + (Scanner.cameras[Scanner.cameraIndex].label || (Scanner.cameraIndex + 1)));
  } catch (e) { setScannerStatus('Не удалось переключить камеру', 'error'); }
}

function onScannerDecoded(decodedText) {
  const code = String(decodedText || '').trim();
  if (!code || !Scanner.onCode) return;
  const now = Date.now();
  // Тот же код, пока он в кадре, не считываем повторно чаще раза в 1.8 сек
  if (code === Scanner.lastCode && now - Scanner.lastAt < 1800) return;
  Scanner.lastCode = code;
  Scanner.lastAt = now;
  const result = Scanner.onCode(code) || {};
  scannerBeep(result.ok !== false);
  if (result.close || !Scanner.continuous) { closeCameraScanner(); return; }
  setScannerStatus(result.message || code, result.ok === false ? 'error' : 'ok');
}

async function closeCameraScanner() {
  const inst = Scanner.instance;
  Scanner.instance = null;
  Scanner.open = false;
  Scanner.onCode = null;
  if (inst) {
    try { if (inst.isScanning) await inst.stop(); } catch (e) {}
    try { inst.clear(); } catch (e) {}
  }
  const root = document.getElementById('scanner-root');
  if (root) root.innerHTML = '';
  if (state.view === 'pos' && !state.receiptToShow && !state.showPaymentModal) focusScanInput();
}

// Касса: камера в режиме «сканирую подряд», каждый найденный товар +1 в чек
function openPosCamera() {
  openCameraScanner({
    title: 'Сканер — касса',
    continuous: true,
    onCode: (code) => {
      const p = findProductByBarcode(code);
      if (!p) {
        showToast('Штрихкод «' + code + '» не найден в базе товаров');
        return { ok: false, message: 'Не найден: ' + code };
      }
      const before = state.cart.find(i => i.productId === p.id)?.qty || 0;
      addToCart(p.id);
      const after = state.cart.find(i => i.productId === p.id)?.qty || 0;
      if (after === before) return { ok: false, message: 'Нет в наличии: ' + p.name };
      return { ok: true, message: '✓ ' + p.name + ' — в чеке ' + after };
    },
  });
}

// Любое поле ввода: один скан → значение в поле
function scanIntoInput(inputId) {
  openCameraScanner({
    title: 'Сканировать штрихкод',
    continuous: false,
    onCode: (code) => {
      const el = document.getElementById(inputId);
      if (el) { el.value = preferredBarcode(code); el.dispatchEvent(new Event('change')); }
      return { ok: true, close: true };
    },
  });
}

/* ============ СКЛАД: ДАННЫЕ ============ */
const STOCK_DRAFT_KEY = 'beershop_stock_draft';
function emptyStockDraft() { return { supplierId: '', docNumber: '', note: '', items: [] }; }
function loadStockDraft() {
  try {
    // ключ строкой: функция вызывается при создании state, раньше объявления константы
    const d = JSON.parse(localStorage.getItem('beershop_stock_draft') || 'null');
    if (d && Array.isArray(d.items)) return { ...emptyStockDraft(), ...d };
  } catch (e) {}
  return emptyStockDraft();
}
function saveStockDraft() {
  try { localStorage.setItem(STOCK_DRAFT_KEY, JSON.stringify(state.stockDraft)); } catch (e) {}
}

async function loadStockData() {
  try {
    const [suppliers, receipts] = await Promise.all([api('/suppliers'), api('/stock/receipts')]);
    state.suppliers = suppliers;
    state.stockReceipts = receipts;
  } catch (err) { if (err.message !== 'unauthorized') showToast(err.message); }
  // Позиции черновика, чьи товары удалили, убираем
  const before = state.stockDraft.items.length;
  state.stockDraft.items = state.stockDraft.items.filter(i => state.products.some(p => p.id === i.productId));
  if (state.stockDraft.items.length !== before) saveStockDraft();
}
function setStockTab(tab) {
  state.stockTab = tab;
  render();
}

function addToStockDraft(productId, qty = 1, extra = {}) {
  const p = state.products.find(p => p.id === productId);
  if (!p) return null;
  let item = state.stockDraft.items.find(i => i.productId === productId);
  if (item) {
    item.qty = +(Number(item.qty || 0) + qty).toFixed(2);
    // поднимаем позицию наверх — видно, что только что сканировали
    state.stockDraft.items = [item, ...state.stockDraft.items.filter(i => i !== item)];
  } else {
    item = {
      productId,
      qty,
      cost_price: extra.cost_price !== undefined ? extra.cost_price : (Number(p.cost_price) > 0 ? Number(p.cost_price) : ''),
      price: extra.price !== undefined ? extra.price : '',
    };
    state.stockDraft.items.unshift(item);
  }
  saveStockDraft();
  render();
  return item;
}
function updateStockDraftItem(productId, field, value) {
  const item = state.stockDraft.items.find(i => i.productId === productId);
  if (!item) return;
  if (field === 'qty') {
    const n = Number(String(value).replace(',', '.'));
    item.qty = n > 0 ? n : item.qty;
  } else {
    const n = Number(String(value).replace(',', '.'));
    item[field] = value === '' || Number.isNaN(n) ? '' : n;
  }
  saveStockDraft();
  render();
}
function changeStockDraftQty(productId, delta) {
  const item = state.stockDraft.items.find(i => i.productId === productId);
  if (!item) return;
  const next = +(Number(item.qty) + delta).toFixed(2);
  if (next <= 0) { removeStockDraftItem(productId); return; }
  item.qty = next;
  saveStockDraft();
  render();
}
function removeStockDraftItem(productId) {
  state.stockDraft.items = state.stockDraft.items.filter(i => i.productId !== productId);
  saveStockDraft();
  render();
}
function setStockDraftField(field, value) {
  state.stockDraft[field] = value;
  saveStockDraft();
}
function clearStockDraft() {
  if (state.stockDraft.items.length && !confirm('Очистить текущий приход?')) return;
  state.stockDraft = emptyStockDraft();
  saveStockDraft();
  render();
}

// Скан (камерой, USB-сканером или ввод кода вручную) в приход
function handleStockCode(rawCode, fromCamera) {
  const code = String(rawCode || '').trim();
  if (!code) return { ok: false };
  const p = findProductByBarcode(code);
  if (p) {
    const item = addToStockDraft(p.id, 1);
    state.stockSearch = '';
    if (!fromCamera) { render(); focusStockSearch(); }
    return { ok: true, message: '✓ ' + p.name + ' — в приходе ' + formatQty(item.qty, p.unit) };
  }
  // Новый товар: открываем карточку со штрихкодом, после сохранения он добавится в приход
  state.stockSearch = '';
  if (fromCamera) {
    setTimeout(() => openAddProductModal('stock', preferredBarcode(code)), 0);
    return { ok: false, close: true };
  }
  openAddProductModal('stock', preferredBarcode(code));
  return { ok: false };
}
function openStockCamera() {
  openCameraScanner({
    title: 'Сканер — приход',
    continuous: true,
    onCode: (code) => handleStockCode(code, true),
  });
}
function handleStockSearchKey(event, value) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const v = value.trim();
  if (!v) return;
  // Похоже на код (цифры/длинная строка без пробелов) — ищем по штрихкоду
  if (/^\S{6,}$/.test(v) && (findProductByBarcode(v) || /^\d+$/.test(v))) { handleStockCode(v, false); return; }
  const matches = stockSearchMatches();
  if (matches.length === 1) { addToStockDraft(matches[0].id, 1); state.stockSearch = ''; render(); focusStockSearch(); }
}
function handleStockSearchInput(value) {
  state.stockSearch = value;
  render();
  focusStockSearch();
}
function focusStockSearch() {
  const el = document.getElementById('stock-search-input');
  if (el) { el.focus(); const l = el.value.length; try { el.setSelectionRange(l, l); } catch (e) {} }
}
function pickStockSearchResult(productId) {
  addToStockDraft(productId, 1);
  state.stockSearch = '';
  render();
  focusStockSearch();
}
function stockSearchMatches() {
  const q = state.stockSearch.trim().toLowerCase();
  if (!q) return [];
  return state.products
    .filter(p => p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q)))
    .slice(0, 8);
}
function formatQty(qty, unit) {
  const n = Number(qty || 0);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  return s + ' ' + (unit === 'л' ? 'л' : 'шт');
}

async function postStockReceipt() {
  const d = state.stockDraft;
  if (!d.items.length) { showToast('Приход пуст — отсканируйте товары'); return; }
  const isAdmin = state.currentUser.role === 'admin';
  if (!d.supplierId && !confirm('Поставщик не выбран. Провести приход без поставщика?')) return;
  for (const i of d.items) {
    const p = state.products.find(p => p.id === i.productId);
    if (p && p.unit !== 'л' && !Number.isInteger(Number(i.qty))) {
      showToast('Количество «' + p.name + '» должно быть целым'); return;
    }
  }
  const totalQty = d.items.length;
  if (!confirm('Провести приход: ' + totalQty + ' поз.' + (isAdmin ? ' на сумму ' + fmt(stockDraftTotal()) : '') + '? Остатки увеличатся.')) return;
  try {
    const result = await api('/stock/receipts', {
      method: 'POST',
      body: {
        supplier_id: d.supplierId ? Number(d.supplierId) : null,
        doc_number: d.docNumber,
        note: d.note,
        items: d.items.map(i => ({ productId: i.productId, qty: Number(i.qty), cost_price: i.cost_price === '' ? null : Number(i.cost_price), price: i.price === '' ? null : Number(i.price) })),
      },
    });
    // Обновляем товары локально (новые остатки, себестоимость, цены)
    (result.products || []).forEach(up => {
      const idx = state.products.findIndex(p => p.id === up.id);
      if (idx >= 0) state.products[idx] = up;
    });
    delete result.products;
    state.stockReceipts.unshift(result);
    const sup = state.suppliers.find(s => s.id === result.supplier_id);
    if (sup) { sup.receipts_count = (sup.receipts_count || 0) + 1; sup.last_at = result.created_at; }
    state.stockDraft = emptyStockDraft();
    saveStockDraft();
    state.stockReceiptToShow = result;
    render();
    showToast('Приход №' + result.id + ' проведён, остатки обновлены');
  } catch (err) { showToast(err.message); }
}
function stockDraftTotal() {
  return state.stockDraft.items.reduce((s, i) => s + (Number(i.cost_price) || 0) * (Number(i.qty) || 0), 0);
}

async function openStockReceipt(id) {
  try {
    state.stockReceiptToShow = await api('/stock/receipts/' + id);
    render();
  } catch (err) { showToast(err.message); }
}
function closeStockReceiptModal() { state.stockReceiptToShow = null; render(); }
async function cancelStockReceipt(id) {
  if (!confirm('Отменить приход №' + id + '? Остатки товаров уменьшатся на количество из этого прихода.')) return;
  try {
    await api('/stock/receipts/' + id, { method: 'DELETE' });
    state.stockReceiptToShow = null;
    const [products] = await Promise.all([api('/products'), loadStockData()]);
    state.products = products;
    render();
    showToast('Приход №' + id + ' отменён');
  } catch (err) { showToast(err.message); }
}

/* ---- Поставщики ---- */
function openSupplierModal(id) {
  state.supplierEditId = id || null;
  state.supplierFormError = '';
  state.showSupplierModal = true;
  render();
  const el = document.getElementById('sup-name');
  if (el) el.focus();
}
function closeSupplierModal() { state.showSupplierModal = false; state.supplierEditId = null; render(); }
async function saveSupplier() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const body = { name: val('sup-name'), phone: val('sup-phone'), bin: val('sup-bin'), contact_person: val('sup-contact'), note: val('sup-note') };
  if (!body.name) { state.supplierFormError = 'Укажите название поставщика'; render(); return; }
  if (body.bin && !/^\d{12}$/.test(body.bin)) { state.supplierFormError = 'БИН/ИИН — 12 цифр'; render(); return; }
  try {
    if (state.supplierEditId) {
      const updated = await api('/suppliers/' + state.supplierEditId, { method: 'PUT', body });
      const idx = state.suppliers.findIndex(s => s.id === updated.id);
      if (idx >= 0) state.suppliers[idx] = { ...state.suppliers[idx], ...updated };
      state.stockReceipts.forEach(r => { if (r.supplier_id === updated.id) r.supplier_name = updated.name; });
      showToast('Поставщик сохранён');
    } else {
      const created = await api('/suppliers', { method: 'POST', body });
      state.suppliers.push(created);
      state.suppliers.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      // Если добавляли из формы прихода — сразу выбираем его
      if (state.stockTab === 'new') { state.stockDraft.supplierId = String(created.id); saveStockDraft(); }
      showToast('Поставщик добавлен');
    }
    state.showSupplierModal = false;
    state.supplierEditId = null;
    render();
  } catch (err) { state.supplierFormError = err.message; render(); }
}
async function deleteSupplier(id) {
  const s = state.suppliers.find(s => s.id === id);
  if (!s || !confirm('Удалить поставщика «' + s.name + '»? Проведённые приходы останутся, в них сохранится название.')) return;
  try {
    await api('/suppliers/' + id, { method: 'DELETE' });
    state.suppliers = state.suppliers.filter(x => x.id !== id);
    if (String(state.stockDraft.supplierId) === String(id)) { state.stockDraft.supplierId = ''; saveStockDraft(); }
    render();
  } catch (err) { showToast(err.message); }
}

/* ============ RENDER: СКЛАД ============ */
function renderStock() {
  const tabs = [
    { id: 'new', label: 'Приход' + (state.stockDraft.items.length ? ' (' + state.stockDraft.items.length + ')' : '') },
    { id: 'history', label: 'История' },
    { id: 'suppliers', label: 'Поставщики' },
  ];
  let body = '';
  if (state.stockTab === 'history') body = renderStockHistory();
  else if (state.stockTab === 'suppliers') body = renderSuppliers();
  else body = renderStockNew();
  return `
  <div class="page-head">
    <div><h2>Склад</h2><div class="page-sub">Приём товара от поставщиков и остатки</div></div>
  </div>
  <div class="stock-tabs">
    ${tabs.map(t => `<button class="stock-tab ${state.stockTab === t.id ? 'active' : ''}" onclick="setStockTab('${t.id}')">${esc(t.label)}</button>`).join('')}
  </div>
  ${body}
  ${state.showSupplierModal ? renderSupplierModal() : ''}
  ${state.showAddProductModal ? renderAddProductModalAnywhere() : ''}`;
}

function renderStockNew() {
  const isAdmin = state.currentUser.role === 'admin';
  const d = state.stockDraft;
  const supplierOptions = state.suppliers.map(s => `<option value="${s.id}" ${String(d.supplierId) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const matches = stockSearchMatches();

  const itemsHtml = d.items.map((i, idx) => {
    const p = state.products.find(p => p.id === i.productId);
    if (!p) return '';
    const isDraft = p.unit === 'л';
    const sum = (Number(i.cost_price) || 0) * (Number(i.qty) || 0);
    const step = isDraft ? 1 : 1;
    return `
    <div class="sr-item">
      <div class="sr-num">${idx + 1}</div>
      <div class="sr-name">
        <div class="sr-title">${esc(p.name)}</div>
        <div class="sr-sub"><span class="mono">${esc(p.barcode || 'без штрихкода')}</span> · на складе ${formatQty(p.stock, p.unit)}</div>
      </div>
      <div class="sr-field sr-qty">
        <label>Кол-во${isDraft ? ', л' : ''}</label>
        <div class="sr-qty-ctrl">
          <button class="kassa-qty-btn" onclick="changeStockDraftQty(${p.id}, -${step})" aria-label="Меньше">−</button>
          <input type="number" inputmode="decimal" min="0" step="${isDraft ? '0.1' : '1'}" value="${i.qty}" onchange="updateStockDraftItem(${p.id}, 'qty', this.value)">
          <button class="kassa-qty-btn" onclick="changeStockDraftQty(${p.id}, ${step})" aria-label="Больше">+</button>
        </div>
      </div>
      ${isAdmin ? `
      <div class="sr-field">
        <label>Закуп, ₸/${isDraft ? 'л' : 'шт'}</label>
        <input type="number" inputmode="decimal" min="0" step="0.01" value="${i.cost_price}" placeholder="${Number(p.cost_price) || 0}" onchange="updateStockDraftItem(${p.id}, 'cost_price', this.value)">
      </div>
      <div class="sr-field">
        <label>Цена продажи, ₸</label>
        <input type="number" inputmode="decimal" min="0" step="0.01" value="${i.price}" placeholder="${Number(p.price)}" onchange="updateStockDraftItem(${p.id}, 'price', this.value)">
      </div>
      <div class="sr-sum"><label>Сумма</label><div class="mono">${fmt(sum)}</div></div>` : ''}
      <button class="kassa-row-remove sr-remove" onclick="removeStockDraftItem(${p.id})" aria-label="Убрать из прихода">×</button>
    </div>`;
  }).join('');

  return `
  <div class="panel stock-head-panel">
    <div class="stock-head-grid">
      <div class="field">
        <label>Поставщик</label>
        <div style="display:flex; gap:6px;">
          <select id="stock-supplier" style="flex:1;" onchange="setStockDraftField('supplierId', this.value)">
            <option value="">— не выбран —</option>
            ${supplierOptions}
          </select>
          <button type="button" class="icon-btn" title="Новый поставщик" onclick="openSupplierModal()">+</button>
        </div>
      </div>
      <div class="field">
        <label>№ накладной</label>
        <input type="text" value="${esc(d.docNumber)}" placeholder="например, 000123" onchange="setStockDraftField('docNumber', this.value)">
      </div>
      <div class="field">
        <label>Примечание</label>
        <input type="text" value="${esc(d.note)}" placeholder="необязательно" onchange="setStockDraftField('note', this.value)">
      </div>
    </div>
  </div>

  <div class="stock-scan-row">
    <button class="stock-camera-btn" onclick="openStockCamera()">${CAMERA_ICON}<span>Сканировать</span></button>
    <div class="stock-search-wrap">
      <input id="stock-search-input" class="kassa-search-input" type="text" autocomplete="off"
        placeholder="Штрихкод (USB-сканер) или название товара"
        value="${esc(state.stockSearch)}"
        oninput="handleStockSearchInput(this.value)"
        onkeydown="handleStockSearchKey(event, this.value)">
      ${matches.length ? `
      <div class="stock-search-results">
        ${matches.map(p => `<button onclick="pickStockSearchResult(${p.id})"><span>${esc(p.name)}</span><span class="mono">${esc(p.barcode || '')}</span></button>`).join('')}
      </div>` : (state.stockSearch.trim() && !/^\d{6,}$/.test(state.stockSearch.trim()) ? `
      <div class="stock-search-results"><div class="stock-search-empty">Не найдено. <button class="linklike" onclick="openAddProductModal('stock', '')">Создать новый товар</button></div></div>` : '')}
    </div>
  </div>

  <div class="panel stock-items-panel">
    ${d.items.length ? itemsHtml : `<div class="empty-state">Приход пуст. Нажмите «Сканировать» и наведите камеру на штрихкод или QR-код товара.<br>Если товара нет в базе — откроется карточка нового товара.</div>`}
  </div>

  <div class="stock-footer">
    <div class="kassa-total-box">
      <span class="kassa-total-label">${d.items.length} поз.${isAdmin ? ' · сумма закупа' : ''}</span>
      ${isAdmin ? `<span class="kassa-total-value">${fmt(stockDraftTotal())}</span>` : ''}
    </div>
    <div class="kassa-footer-actions">
      <button class="kassa-btn-clear" ${d.items.length === 0 ? 'disabled' : ''} onclick="clearStockDraft()">Очистить</button>
      <button class="kassa-btn-pay" ${d.items.length === 0 ? 'disabled' : ''} onclick="postStockReceipt()">Провести приход</button>
    </div>
  </div>`;
}

function renderStockHistory() {
  const isAdmin = state.currentUser.role === 'admin';
  const list = state.stockReceipts;
  const rows = list.map(r => `
    <tr>
      <td class="num">№${r.id}</td>
      <td>${fmtDate(r.created_at)}</td>
      <td>${esc(r.supplier_name || '—')}</td>
      <td class="mono">${esc(r.doc_number || '—')}</td>
      <td class="num">${r.items_count}</td>
      ${isAdmin ? `<td class="num">${fmt(r.total)}</td>` : ''}
      <td>${esc(r.user_name)}</td>
      <td class="row-actions"><button class="btn btn-ghost btn-sm" onclick="openStockReceipt(${r.id})">Открыть</button></td>
    </tr>`).join('');
  return `
  <div class="panel">
    <table>
      <thead><tr><th>Приход</th><th>Дата</th><th>Поставщик</th><th>Накладная</th><th>Поз.</th>${isAdmin ? '<th>Сумма</th>' : ''}<th>Принял</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${list.length === 0 ? '<div class="empty-state">Приходов пока нет.</div>' : ''}
  </div>`;
}

function renderSuppliers() {
  const isAdmin = state.currentUser.role === 'admin';
  const cards = state.suppliers.map(s => `
    <div class="supplier-card">
      <div class="supplier-top">
        <div>
          <div class="supplier-name">${esc(s.name)}</div>
          ${s.contact_person ? `<div class="page-sub" style="margin-top:2px;">${esc(s.contact_person)}</div>` : ''}
        </div>
        ${isAdmin ? `<div class="row-actions">
          <button class="btn btn-ghost btn-sm" onclick="openSupplierModal(${s.id})">Изменить</button>
          <button class="btn btn-danger btn-sm" onclick="deleteSupplier(${s.id})">Удалить</button>
        </div>` : ''}
      </div>
      <div class="pvc-row"><span>Телефон</span><span>${s.phone ? `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a>` : '—'}</span></div>
      <div class="pvc-row"><span>БИН/ИИН</span><span class="mono">${esc(s.bin || '—')}</span></div>
      <div class="pvc-row"><span>Приходов</span><span>${s.receipts_count || 0}${s.last_at ? ' · последний ' + new Date(s.last_at).toLocaleDateString('ru-RU') : ''}</span></div>
      ${isAdmin && s.receipts_total !== undefined ? `<div class="pvc-row"><span>Закуплено на</span><span class="num">${fmt(s.receipts_total)}</span></div>` : ''}
      ${s.note ? `<div class="pvc-row"><span>Примечание</span><span>${esc(s.note)}</span></div>` : ''}
    </div>`).join('');
  return `
  <div class="table-toolbar">
    <div class="page-sub">${state.suppliers.length} поставщик(ов)</div>
    <button class="btn btn-hop btn-sm" onclick="openSupplierModal()">+ Новый поставщик</button>
  </div>
  <div class="supplier-grid">${cards}</div>
  ${state.suppliers.length === 0 ? '<div class="panel"><div class="empty-state">Поставщиков пока нет — добавьте первого.</div></div>' : ''}`;
}

function renderSupplierModal() {
  const s = state.supplierEditId ? state.suppliers.find(x => x.id === state.supplierEditId) || {} : {};
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeSupplierModal()">
    <div class="modal-card add-product-modal">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeSupplierModal()" aria-label="Закрыть">×</button></div>
      <div class="add-product-body">
        <h3 class="add-product-title">${state.supplierEditId ? 'Поставщик' : 'Новый поставщик'}</h3>
        ${state.supplierFormError ? `<div class="login-error">${esc(state.supplierFormError)}</div>` : ''}
        <div class="field"><label>Название *</label><input id="sup-name" type="text" value="${esc(s.name || '')}" placeholder="ТОО «Пивной дом»"></div>
        <div class="field"><label>Телефон</label><input id="sup-phone" type="tel" value="${esc(s.phone || '')}" placeholder="+7 700 000 00 00"></div>
        <div class="field"><label>БИН / ИИН</label><input id="sup-bin" type="text" inputmode="numeric" maxlength="12" value="${esc(s.bin || '')}" placeholder="12 цифр"></div>
        <div class="field"><label>Контактное лицо</label><input id="sup-contact" type="text" value="${esc(s.contact_person || '')}" placeholder="Имя торгового представителя"></div>
        <div class="field"><label>Примечание</label><input id="sup-note" type="text" value="${esc(s.note || '')}" placeholder="Дни поставки, условия оплаты…"></div>
      </div>
      <div class="receipt-actions" style="padding-top:12px;">
        <button class="btn btn-ghost" style="flex:1;" onclick="closeSupplierModal()">Отмена</button>
        <button class="btn btn-hop" style="flex:1;" onclick="saveSupplier()">Сохранить</button>
      </div>
    </div>
  </div>`;
}

function renderStockReceiptModal() {
  const r = state.stockReceiptToShow;
  if (!r) return '';
  const isAdmin = state.currentUser.role === 'admin';
  const lines = (r.items || []).map(i => `
    <div class="receipt-line">
      <span>${esc(i.product_name)}</span>
      <span class="qp">${formatQty(i.qty, i.unit)}${isAdmin ? ' × ' + fmt(i.cost_price) : ''}</span>
    </div>`).join('');
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeStockReceiptModal()">
    <div class="modal-card">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeStockReceiptModal()" aria-label="Закрыть">×</button></div>
      <div class="receipt">
        <div class="receipt-head">
          <div class="shop">Приход №${r.id}</div>
          <div class="meta">${fmtDate(r.created_at)}<br>
            Поставщик: ${esc(r.supplier_name || '—')}${r.doc_number ? '<br>Накладная: ' + esc(r.doc_number) : ''}<br>
            Принял: ${esc(r.user_name)}</div>
        </div>
        ${lines}
        ${isAdmin ? `<div class="receipt-total"><span>Сумма закупа</span><span>${fmt(r.total)}</span></div>` : ''}
        ${r.note ? `<div class="receipt-foot">${esc(r.note)}</div>` : ''}
      </div>
      <div class="receipt-actions">
        ${isAdmin ? `<button class="btn btn-danger" style="flex:1;" onclick="cancelStockReceipt(${r.id})">Отменить приход</button>` : ''}
        <button class="btn btn-ghost" style="flex:1;" onclick="window.print()">Печать</button>
        <button class="btn btn-primary" style="flex:1;" onclick="closeStockReceiptModal()">Готово</button>
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
  else if (state.view === 'stock') viewHtml = renderStock();
  else if (state.view === 'trash' && state.currentUser.role === 'admin') viewHtml = renderTrash();
  else if (state.view === 'analytics' && state.currentUser.role === 'admin') viewHtml = renderAnalytics();
  else if (state.view === 'users' && state.currentUser.role === 'admin') viewHtml = renderUsers();
  else viewHtml = renderPOS();

  app.innerHTML = `
    <div class="shell ${state.view === 'pos' ? 'shell-pos' : ''}">
      ${renderSidebar()}
      <main class="content ${state.view === 'pos' ? 'content-wide' : ''}">${viewHtml}</main>
    </div>
    ${renderReceiptModal()}
    ${renderStockReceiptModal()}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}
  `;
  if (state.view === 'pos' && !state.receiptToShow && !state.showPaymentModal) focusScanInput();
  if (state.payAnimate) setTimeout(() => { state.payAnimate = false; }, 250);
  if (state.view === 'pos' && state.lastAddedId) {
    const line = document.querySelector('.pos2-line.just-added');
    if (line) line.scrollIntoView({ block: 'nearest' });
  }
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
