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
  shift: null,          // текущая открытая смена (X-отчёт) или null
  shiftModal: null,     // окно смены: open | panel | in | out | close | report
  shiftsList: [],
  shiftsFilterUser: 'all',
  userSheet: null,      // окно сотрудника
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
  returnDraft: loadReturnDraft(),
  returnSearch: '',
  stockReturns: [],
  stockReturnToShow: null,
  supplierProducts: {}, // id поставщика → товары, которые он привозил
  stockHistoryFilter: 'all', // all | in | out
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
  state.shift = null;
  state.shiftModal = null;
  state.userSheet = null;
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
    const [products, receipts, shift] = await Promise.all([
      api('/products'),
      api('/receipts'),
      api('/shifts/current'),
    ]);
    state.products = products;
    state.receipts = receipts;
    state.shift = shift;
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
  if (Scanner.open || state.shiftModal) return; // камера или окно смены открыты — фокус не забираем
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
    if (/Смена не открыта/.test(err.message || '')) {
      state.showPaymentModal = false;
      await loadCurrentShift();
      render();
    }
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
  if (v === 'shifts' && state.currentUser.role === 'admin') await loadShiftsList();
  if (v === 'pos') await loadCurrentShift();
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
  if (role === 'admin') items.push({ id: 'shifts', label: 'Смены' });
  if (role === 'admin') items.push({ id: 'users', label: 'Сотрудники' });
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
  shifts: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
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
  if (!state.shift) return renderShiftGate();
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
          <div class="pos2-check-meta">${esc(state.currentUser.name)} · смена №${state.shift.id} с ${fmtTime(state.shift.opened_at)}</div>
        </div>
        <div class="pos2-head-btns">
          ${state.currentUser.role === 'admin' ? `<button class="pos2-shift-btn" onclick="openShiftPanel()" title="Смена: X-отчёт, внесение, изъятие, закрытие">${icon('shifts', 18)} Смена</button>` : ''}
          <button class="pos2-clear" ${empty ? 'disabled' : ''} onclick="clearCart()" title="Очистить чек">${icon('trash', 18)}</button>
        </div>
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
  ${state.showPaymentModal ? renderPaymentModal() : ''}
  ${state.shiftModal ? renderShiftModal() : ''}`;
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
  if (state.shiftModal) {
    const mode = state.shiftModal.mode;
    // Печатаем в поле комментария — цифры и Enter не перехватываем
    const typing = !!(e.target && e.target.classList && e.target.classList.contains('sh-note'));
    if (!typing && e.target && e.target.tagName === 'INPUT' && e.target.blur) e.target.blur();
    if (!typing && ['open', 'in', 'out', 'close'].includes(mode)) {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); shiftNumpad(e.key); return; }
      if (e.key === 'Backspace') { e.preventDefault(); shiftNumpad('back'); return; }
      if (e.key === '.' || e.key === ',') { e.preventDefault(); shiftNumpad('.'); return; }
    }
    if (e.key === 'Enter' && !typing) {
      e.preventDefault();
      if (mode === 'report') closeShiftModal(); else confirmShiftModal();
    } else if (e.key === 'Escape') { e.preventDefault(); closeShiftModal(); }
    return;
  }
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

/* ============ КАССОВАЯ СМЕНА ============ */
const CASH_IN_REASONS = ['Размен', 'Возврат с инкассации', 'Другое'];
const CASH_OUT_REASONS = ['Инкассация', 'Расходы магазина', 'Оплата поставщику', 'Другое'];
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

async function loadCurrentShift() {
  try { state.shift = await api('/shifts/current'); } catch (err) { if (err.message !== 'unauthorized') showToast(err.message); }
}
function openShiftModal(mode, extra = {}) {
  state.shiftModal = { mode, value: '', reason: '', note: '', ...extra };
  render();
}
function closeShiftModal() {
  state.shiftModal = null;
  render();
  focusScanInput();
}
async function openShiftPanel() {
  await loadCurrentShift();
  if (!state.shift) { render(); return; }
  openShiftModal('panel');
}
function shiftNumpad(key) {
  const m = state.shiftModal;
  if (!m || !['open', 'in', 'out', 'close'].includes(m.mode)) return;
  let v = String(m.value || '');
  if (key === 'back') v = v.slice(0, -1);
  else if (key === 'clear') v = '';
  else if (key === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
  else {
    if (v === '0') v = '';
    if (v.includes('.') && v.split('.')[1].length >= 2) return;
    if (v.replace('.', '').length >= 9) return;
    v += key;
  }
  m.value = v;
  render();
}
function setShiftModalField(field, value, rerender) {
  if (!state.shiftModal) return;
  state.shiftModal[field] = value;
  if (rerender) render();
}
function shiftModalCanConfirm() {
  const m = state.shiftModal;
  if (!m) return false;
  if (m.mode === 'open' || m.mode === 'close') return m.value !== '';
  if (m.mode === 'in' || m.mode === 'out') return Number(m.value) > 0 && !!m.reason;
  return false;
}
async function confirmShiftModal() {
  const m = state.shiftModal;
  if (!m || !shiftModalCanConfirm()) return;
  try {
    if (m.mode === 'open') {
      state.shift = await api('/shifts/open', { method: 'POST', body: { opening_cash: Number(m.value) || 0 } });
      state.shiftModal = null;
      render();
      showToast('Смена №' + state.shift.id + ' открыта. Хороших продаж!');
      focusScanInput();
    } else if (m.mode === 'in' || m.mode === 'out') {
      state.shift = await api('/shifts/current/cash', { method: 'POST', body: { type: m.mode, amount: Number(m.value), reason: m.reason } });
      showToast((m.mode === 'in' ? 'Внесено ' : 'Изъято ') + fmt(Number(m.value)));
      openShiftModal('panel');
    } else if (m.mode === 'close') {
      const body = { counted_cash: Number(m.value) || 0, note: m.note };
      const own = !m.target || (state.shift && m.target.id === state.shift.id);
      const report = own
        ? await api('/shifts/current/close', { method: 'POST', body })
        : await api('/shifts/' + m.target.id + '/close', { method: 'POST', body });
      if (state.shift && report.id === state.shift.id) { state.shift = null; state.cart = []; }
      if (state.view === 'shifts') await loadShiftsList();
      openShiftModal('report', { report });
      showToast('Смена №' + report.id + ' закрыта');
    }
  } catch (err) { showToast(err.message); }
}
// Закрыть смену из отчёта: берём свежие итоги и открываем пересчёт кассы
async function startCloseShift(id) {
  try {
    const target = await api('/shifts/' + id);
    if (!target.is_open) { showToast('Смена уже закрыта'); openShiftModal('report', { report: target }); return; }
    openShiftModal('close', { target });
  } catch (err) { showToast(err.message); }
}
async function openShiftReport(id) {
  try { openShiftModal('report', { report: await api('/shifts/' + id) }); } catch (err) { showToast(err.message); }
}

function numpadHtml(fn) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', 'back'];
  return `
    <div class="pay2-numpad">
      ${keys.map(k => `<button onclick="${fn}('${k}')" ${k === 'back' ? 'class="key-back" aria-label="Стереть"' : ''}>${k === 'back' ? icon('back', 26) : k}</button>`).join('')}
      <button class="key-clear" onclick="${fn}('clear')">Сброс</button>
    </div>`;
}
function moneyDisplay(v) {
  return v === '' ? '<span class="ph">0</span>' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + (String(v).endsWith('.') ? ',' : '');
}

// Экран вместо кассы, пока смена не открыта
function renderShiftGate() {
  const isAdmin = state.currentUser.role === 'admin';
  if (!isAdmin) scheduleShiftCheck();
  return `
  <div class="shift-gate">
    <div class="shift-gate-card">
      <div class="shift-gate-ico">${icon('cash', 40)}</div>
      <h2>Смена закрыта</h2>
      ${isAdmin ? `
      <p>Откройте смену магазина и укажите, сколько наличных сейчас в кассе. После этого кассиры смогут продавать.</p>
      <button class="pos2-pay shift-gate-btn" onclick="openShiftModal('open')">Открыть смену</button>` : `
      <p>Продажи пока недоступны. Попросите администратора открыть смену — касса включится автоматически.</p>
      <button class="btn btn-ghost shift-gate-check" onclick="checkShiftNow()">Проверить ещё раз</button>`}
      <div class="shift-gate-user">${esc(state.currentUser.name)} · ${new Date().toLocaleDateString('ru-RU')}</div>
    </div>
  </div>
  ${state.shiftModal ? renderShiftModal() : ''}`;
}
// Кассир ждёт открытия смены: проверяем раз в 15 секунд, пока открыт экран кассы
let shiftCheckTimer = null;
function scheduleShiftCheck() {
  if (shiftCheckTimer) return;
  shiftCheckTimer = setTimeout(async () => {
    shiftCheckTimer = null;
    if (!state.currentUser || state.view !== 'pos' || state.shift) return;
    await loadCurrentShift();
    if (state.shift) { render(); showToast('Смена открыта — можно продавать'); } else if (state.view === 'pos') render();
  }, 15000);
}
async function checkShiftNow() {
  await loadCurrentShift();
  render();
  if (!state.shift) showToast('Смена ещё не открыта');
}

function shiftStatRows(r) {
  const row = (label, value, cls = '') => `<div class="sh-row ${cls}"><span>${label}</span><b>${value}</b></div>`;
  return `
    <div class="sh-grid">
      <div class="sh-tile"><span>Чеков</span><b>${r.receipts_count}</b></div>
      <div class="sh-tile"><span>Выручка</span><b>${fmt(r.total_sales)}</b></div>
      <div class="sh-tile"><span>Наличными</span><b>${fmt(r.cash_sales)}</b></div>
      <div class="sh-tile"><span>По QR</span><b>${fmt(r.qr_sales)}</b></div>
    </div>
    <div class="sh-cash">
      ${row('Наличные на начало', fmt(r.opening_cash))}
      ${row('+ продажи наличными', fmt(r.cash_sales))}
      ${row('+ внесения', fmt(r.cash_in))}
      ${row('− изъятия', fmt(r.cash_out))}
      ${row('Должно быть в кассе', fmt(r.expected_cash), 'total')}
    </div>`;
}

function renderShiftModal() {
  const m = state.shiftModal;
  if (!m) return '';
  const sh = m.mode === 'close' && m.target ? m.target : state.shift;
  const otherCashier = m.mode === 'close' && m.target && m.target.user_id !== state.currentUser.id;
  let title = '', body = '', actions = '';

  if (m.mode === 'open') {
    title = 'Открытие смены';
    body = `
      <div class="pay2-body">
        <div class="pay2-left">
          <div class="pay2-field active"><label>Наличные в кассе на начало смены</label>
            <div class="pay2-display">${moneyDisplay(m.value)}<span class="cur">₸</span></div></div>
          <div class="pay2-quick"><button class="exact" onclick="setShiftModalField('value', '0', true)">Касса пустая (0 ₸)</button></div>
          <div class="sh-hint">Пересчитайте размен в ящике и введите сумму. В конце смены система сравнит её с фактом.</div>
        </div>
        <div class="pay2-right">${numpadHtml('shiftNumpad')}</div>
      </div>`;
    actions = `<button class="pay2-cancel" onclick="closeShiftModal()">Отмена</button>
      <button class="pay2-confirm" ${shiftModalCanConfirm() ? '' : 'disabled'} onclick="confirmShiftModal()">${icon('check', 24)} Открыть смену</button>`;
  } else if (m.mode === 'panel' && sh) {
    title = `Смена №${sh.id} · с ${fmtTime(sh.opened_at)}`;
    const moves = (sh.movements || []).map(mv => `
      <div class="sh-move ${mv.type}"><span>${fmtTime(mv.created_at)} · ${esc(mv.reason || '')}</span><b>${mv.type === 'in' ? '+' : '−'}${fmt(mv.amount)}</b></div>`).join('');
    body = `
      <div class="pay2-body sh-panel">
        <div class="pay2-left">
          <div class="sh-caption">X-отчёт — текущие итоги смены</div>
          ${shiftStatRows(sh)}
          ${(sh.by_cashier || []).length ? `<div class="sh-caption" style="margin-top:6px;">Продажи по кассирам</div><div class="sh-moves">${sh.by_cashier.map(c => `<div class="sh-move"><span>${esc(c.cashier_name)} · ${c.receipts_count} чек.</span><b>${fmt(c.total)}</b></div>`).join('')}</div>` : ''}
          ${moves ? `<div class="sh-caption" style="margin-top:6px;">Внесения и изъятия</div><div class="sh-moves">${moves}</div>` : ''}
        </div>
        <div class="pay2-right sh-actions">
          <button class="sh-act in" onclick="openShiftModal('in')">${icon('cash', 26)}<span>Внесение<small>размен в кассу</small></span></button>
          <button class="sh-act out" onclick="openShiftModal('out')">${icon('logout', 26)}<span>Изъятие<small>инкассация, расходы</small></span></button>
          <button class="sh-act close" onclick="openShiftModal('close')">${icon('check', 26)}<span>Закрыть смену<small>пересчёт и Z-отчёт</small></span></button>
        </div>
      </div>`;
    actions = `<button class="pay2-cancel" style="grid-column:1/-1;" onclick="closeShiftModal()">Вернуться к кассе <kbd>Esc</kbd></button>`;
  } else if (m.mode === 'in' || m.mode === 'out') {
    const isIn = m.mode === 'in';
    title = isIn ? 'Внесение наличных' : 'Изъятие наличных';
    const reasons = isIn ? CASH_IN_REASONS : CASH_OUT_REASONS;
    body = `
      <div class="pay2-body">
        <div class="pay2-left">
          <div class="pay2-field active"><label>Сумма</label>
            <div class="pay2-display">${moneyDisplay(m.value)}<span class="cur">₸</span></div></div>
          <div class="sh-caption">Причина</div>
          <div class="sh-reasons">${reasons.map(r => `<button class="${m.reason === r ? 'active' : ''}" onclick="setShiftModalField('reason', '${r}', true)">${r}</button>`).join('')}</div>
          ${!isIn && sh ? `<div class="sh-hint">В кассе по расчёту: <b>${fmt(sh.expected_cash)}</b></div>` : ''}
        </div>
        <div class="pay2-right">${numpadHtml('shiftNumpad')}</div>
      </div>`;
    actions = `<button class="pay2-cancel" onclick="openShiftModal('panel')">Назад</button>
      <button class="pay2-confirm" ${shiftModalCanConfirm() ? '' : 'disabled'} onclick="confirmShiftModal()">${icon('check', 24)} ${isIn ? 'Внести' : 'Изъять'}</button>`;
  } else if (m.mode === 'close' && sh) {
    title = `Закрытие смены №${sh.id}` + (otherCashier ? ` · ${sh.user_name}` : '');
    const counted = Number(m.value) || 0;
    const diff = +(counted - Number(sh.expected_cash)).toFixed(2);
    const box = m.value === ''
      ? `<div class="pay2-change neutral"><span>Расхождение</span><b>—</b><small>Пересчитайте наличные в ящике и введите сумму</small></div>`
      : Math.abs(diff) < 0.01 ? `<div class="pay2-change ok"><span>Касса сошлась</span><b>0 ₸</b></div>`
      : diff < 0 ? `<div class="pay2-change bad"><span>Недостача</span><b>${fmt(-diff)}</b></div>`
      : `<div class="pay2-change over"><span>Излишек</span><b>${fmt(diff)}</b></div>`;
    body = `
      <div class="pay2-body">
        <div class="pay2-left">
          <div class="sh-row total big"><span>Должно быть в кассе</span><b>${fmt(sh.expected_cash)}</b></div>
          <div class="pay2-field active"><label>Фактически в кассе (пересчитали)</label>
            <div class="pay2-display">${moneyDisplay(m.value)}<span class="cur">₸</span></div></div>
          ${box}
          ${m.value !== '' && Math.abs(diff) >= 0.01 ? `<input class="sh-note" type="text" placeholder="Комментарий к расхождению (необязательно)" value="${esc(m.note)}" oninput="setShiftModalField('note', this.value)">` : ''}
        </div>
        <div class="pay2-right">${numpadHtml('shiftNumpad')}</div>
      </div>`;
    actions = `<button class="pay2-cancel" onclick="${m.target ? `openShiftReport(${sh.id})` : `openShiftModal('panel')`}">Назад</button>
      <button class="pay2-confirm sh-close-btn" ${shiftModalCanConfirm() ? '' : 'disabled'} onclick="confirmShiftModal()">${icon('check', 24)} Закрыть смену</button>`;
  } else if (m.mode === 'report' && m.report) {
    return renderShiftReportModal(m.report);
  } else {
    return '';
  }

  return `
  <div class="modal-overlay pay2-overlay" onclick="if(event.target===this) closeShiftModal()">
    <div class="pay2 sh-modal" role="dialog" aria-label="${esc(title)}">
      <div class="pay2-head">
        <div><div class="pay2-head-label">Касса · ${esc(state.currentUser.name)}</div><div class="sh-head-title">${esc(title)}</div></div>
        <button class="pay2-close" onclick="closeShiftModal()" aria-label="Закрыть">×</button>
      </div>
      ${body}
      <div class="pay2-actions">${actions}</div>
    </div>
  </div>`;
}

function renderShiftReportModal(r) {
  const d = Number(r.difference);
  const line = (label, value, cls = '') => `<div class="receipt-line ${cls}"><span>${label}</span><span class="qp">${value}</span></div>`;
  const moves = (r.movements || []).map(mv => line(`${fmtTime(mv.created_at)} ${mv.type === 'in' ? 'внесение' : 'изъятие'}${mv.reason ? ' · ' + esc(mv.reason) : ''}`, (mv.type === 'in' ? '+' : '−') + fmt(mv.amount))).join('');
  const isMine = state.view === 'pos';
  const canClose = r.is_open && (state.currentUser.role === 'admin' || r.user_id === state.currentUser.id);
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeShiftModal()">
    <div class="modal-card">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeShiftModal()" aria-label="Закрыть">×</button></div>
      <div class="receipt">
        <div class="receipt-head">
          <div class="shop">Хмель</div>
          <div class="z-title">${r.is_open ? 'X-отчёт (смена открыта)' : 'Z-отчёт · смена закрыта'}</div>
          <div class="meta">Смена №${r.id} · открыл ${esc(r.user_name)}<br>
            Открыта: ${fmtDate(r.opened_at)}${r.closed_at ? '<br>Закрыта: ' + fmtDate(r.closed_at) : ''}${r.closed_by && r.closed_by !== r.user_name ? '<br>Закрыл: ' + esc(r.closed_by) : ''}</div>
        </div>
        ${line('Чеков', `${r.receipts_count}`)}
        ${line('&nbsp;&nbsp;наличные / QR / смеш.', `${r.cash_count ?? '—'} / ${r.qr_count ?? '—'} / ${r.mixed_count ?? '—'}`)}
        <div class="receipt-total"><span>Выручка</span><span>${fmt(r.total_sales)}</span></div>
        ${line('&nbsp;&nbsp;наличными', fmt(r.cash_sales))}
        ${line('&nbsp;&nbsp;по QR', fmt(r.qr_sales))}
        <div class="z-sep"></div>
        ${line('Наличные на начало', fmt(r.opening_cash))}
        ${line('+ продажи наличными', fmt(r.cash_sales))}
        ${line('+ внесения', fmt(r.cash_in))}
        ${line('− изъятия', fmt(r.cash_out))}
        <div class="receipt-total"><span>Ожидалось в кассе</span><span>${fmt(r.expected_cash)}</span></div>
        ${r.is_open ? '' : `
        ${line('Фактически в кассе', fmt(r.counted_cash))}
        <div class="z-diff ${Math.abs(d) < 0.01 ? 'ok' : d < 0 ? 'bad' : 'over'}"><span>${Math.abs(d) < 0.01 ? 'Касса сошлась' : d < 0 ? 'Недостача' : 'Излишек'}</span><span>${fmt(Math.abs(d))}</span></div>
        ${r.close_note ? `<div class="receipt-line"><span>Комментарий: ${esc(r.close_note)}</span></div>` : ''}`}
        ${(r.by_cashier || []).length ? `<div class="z-sep"></div><div class="receipt-line"><span>Продажи по кассирам:</span></div>
        ${r.by_cashier.map(c => line(`&nbsp;&nbsp;${esc(c.cashier_name)} (${c.receipts_count} чек.)`, fmt(c.total))).join('')}` : ''}
        ${moves ? `<div class="z-sep"></div><div class="receipt-line"><span>Движение наличных:</span></div>${moves}` : ''}
        <div class="z-sign">Подпись ответственного ____________</div>
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" style="flex:1;" onclick="window.print()">Печать</button>
        ${canClose ? `<button class="btn btn-primary z-close-shift" style="flex:1.6;" onclick="startCloseShift(${r.id})">${icon('check', 18)} Закрыть смену</button>` : ''}
        <button class="btn ${canClose ? 'btn-ghost' : 'btn-primary'}" style="flex:1;" onclick="closeShiftModal()">${isMine && !r.is_open ? 'Готово' : 'Назад'}</button>
      </div>
    </div>
  </div>`;
}

/* ============ АДМИН: СПИСОК СМЕН ============ */
async function loadShiftsList() {
  try {
    const q = state.shiftsFilterUser !== 'all' ? '?user_id=' + state.shiftsFilterUser : '';
    state.shiftsList = await api('/shifts' + q);
    if (!allUsers.length) await loadUsers();
  } catch (err) { showToast(err.message); }
}
async function setShiftsFilterUser(id) {
  state.shiftsFilterUser = id;
  await loadShiftsList();
  render();
}
function renderShifts() {
  const list = state.shiftsList || [];
  const openCount = list.filter(s => s.is_open).length;
  const closed = list.filter(s => !s.is_open);
  const shortSum = closed.filter(s => Number(s.difference) < -0.009).reduce((a, s) => a + Number(s.difference), 0);
  const chips = [['all', 'Все']].concat(allUsers.map(u => [String(u.id), u.name]))
    .map(([id, label]) => `<button class="pos2-chip ${String(state.shiftsFilterUser) === id ? 'active' : ''}" onclick="setShiftsFilterUser('${id}')">${esc(label)}</button>`).join('');
  const rows = list.map(s => {
    const d = Number(s.difference);
    const badge = s.is_open ? '<span class="pl-stock ok">идёт</span>'
      : Math.abs(d) < 0.01 ? '<span class="pl-stock ok">сошлась</span>'
      : d < 0 ? `<span class="pl-stock out">недостача ${fmt(-d)}</span>` : `<span class="pl-stock low">излишек ${fmt(d)}</span>`;
    return `
    <button class="pl-row doc-row ${s.is_open ? 'doc-in' : ''}" onclick="openShiftReport(${s.id})">
      <div class="doc-badge sh-badge ${s.is_open ? 'open' : ''}">${s.is_open ? icon('cash', 22) : '№' + s.id}</div>
      <div class="pl-main">
        <div class="pl-name">Смена №${s.id} · открыл ${esc(s.user_name)}</div>
        <div class="pl-sub"><span>${fmtDate(s.opened_at)}${s.closed_at ? ' — ' + fmtTime(s.closed_at) : ' — сейчас'}</span></div>
        <div class="pl-cost">${s.receipts_count} чек. · нал. ${fmt(s.cash_sales)} · QR ${fmt(s.qr_sales)}</div>
      </div>
      <div class="pl-right">
        <div class="pl-price">${fmt(s.total_sales)}</div>
        ${badge}
      </div>
      <span class="pl-chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');
  return `
  <div class="page-head"><div><h2>Смены</h2><div class="page-sub">Открытие и закрытие касс, выручка и расхождения по сменам</div></div></div>
  <div class="pl-stats">
    <div class="pl-stat"><span>Сейчас на смене</span><b>${openCount}</b></div>
    <div class="pl-stat"><span>Смен в списке</span><b>${list.length}</b></div>
    <div class="pl-stat ${shortSum < 0 ? 'alert' : ''}"><span>Недостачи</span><b>${fmt(-shortSum)}</b></div>
  </div>
  <div class="pos2-chips" style="margin-bottom:12px;">${chips}</div>
  <div class="pl-list doc-list">${rows}</div>
  ${list.length === 0 ? '<div class="panel"><div class="empty-state">Смен пока нет.</div></div>' : ''}
  ${state.shiftModal ? renderShiftModal() : ''}`;
}

/* ============ АДМИН: СОТРУДНИКИ ============ */
function openUserSheet(id) {
  const u = id ? allUsers.find(x => x.id === id) : null;
  state.userSheet = {
    id: u ? u.id : null,
    name: u ? u.name : '', username: u ? u.username : '', phone: u ? (u.phone || '') : '',
    role: u ? u.role : 'cashier', is_active: u ? u.is_active !== false : true, password: '',
  };
  state.userFormError = '';
  render();
  setTimeout(() => document.getElementById('us-name')?.focus(), 0);
}
function closeUserSheet() { state.userSheet = null; render(); }
function setUserSheet(field, value, rerender) { if (state.userSheet) { state.userSheet[field] = value; if (rerender) render(); } }
async function saveUserSheet() {
  const d = state.userSheet;
  if (!d) return;
  if (!d.name.trim()) { state.userFormError = 'Укажите имя'; render(); return; }
  try {
    if (d.id) {
      const body = { name: d.name.trim(), phone: d.phone, role: d.role, is_active: d.is_active };
      if (d.password) body.password = d.password;
      await api('/users/' + d.id, { method: 'PUT', body });
      showToast('Сохранено');
    } else {
      if (!d.username.trim() || !d.password) { state.userFormError = 'Укажите логин и пароль для входа'; render(); return; }
      await api('/users', { method: 'POST', body: { name: d.name.trim(), username: d.username.trim(), password: d.password, role: d.role, phone: d.phone } });
      showToast('Сотрудник добавлен');
    }
    state.userSheet = null;
    await loadUsers();
    render();
  } catch (err) { state.userFormError = err.message; render(); }
}
async function deleteUserFromSheet() {
  const d = state.userSheet;
  if (!d || !d.id || !confirm('Удалить сотрудника «' + d.name + '»?')) return;
  try {
    await api('/users/' + d.id, { method: 'DELETE' });
    state.userSheet = null;
    await loadUsers();
    render();
    showToast('Сотрудник удалён');
  } catch (err) { state.userFormError = err.message; render(); }
}

function renderUsers() {
  const active = allUsers.filter(u => u.is_active !== false).length;
  const onShift = allUsers.filter(u => u.open_shift_id).length;
  const cards = allUsers.map(u => {
    const diff = Number(u.diff_30d) || 0;
    return `
    <button class="pl-row emp-row ${u.is_active === false ? 'off' : ''}" onclick="openUserSheet(${u.id})">
      <div class="emp-avatar ${u.role}">${esc(u.name.trim().charAt(0).toUpperCase())}</div>
      <div class="pl-main">
        <div class="pl-name">${esc(u.name)} <span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-cashier'}">${u.role === 'admin' ? 'Админ' : 'Кассир'}</span></div>
        <div class="pl-sub"><span class="mono">${esc(u.username)}</span>${u.phone ? `<span>${esc(u.phone)}</span>` : ''}</div>
        <div class="pl-cost">за 30 дн.: ${u.shifts_30d} смен · ${u.receipts_30d} чек. · ${fmt(u.revenue_30d)}${diff < -0.009 ? ` · <span class="emp-short">недостачи ${fmt(-diff)}</span>` : ''}</div>
      </div>
      <div class="pl-right">
        ${u.is_active === false ? '<span class="pl-stock out">отключён</span>'
          : u.open_shift_id ? `<span class="pl-stock ok">на смене с ${fmtTime(u.open_shift_at)}</span>`
          : `<span class="pl-stock idle">${u.last_shift_at ? 'смена ' + new Date(u.last_shift_at).toLocaleDateString('ru-RU') : 'смен не было'}</span>`}
      </div>
      <span class="pl-chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');
  return `
  <div class="page-head">
    <div><h2>Сотрудники</h2><div class="page-sub">Кассиры и администраторы: доступ, телефоны, смены и выручка</div></div>
    <button class="btn btn-hop" onclick="openUserSheet(null)">+ Сотрудник</button>
  </div>
  <div class="pl-stats">
    <div class="pl-stat"><span>Активных</span><b>${active}</b></div>
    <div class="pl-stat"><span>Сейчас на смене</span><b>${onShift}</b></div>
  </div>
  <div class="pl-list">${cards}</div>
  ${state.userSheet ? renderUserSheet() : ''}`;
}

function renderUserSheet() {
  const d = state.userSheet;
  const isNew = !d.id;
  const isSelf = d.id === state.currentUser.id;
  return `
  <div class="modal-overlay sheet-overlay" onclick="if(event.target===this) closeUserSheet()">
    <div class="sheet" role="dialog" aria-label="Сотрудник">
      <div class="sheet-head"><h3>${isNew ? 'Новый сотрудник' : 'Сотрудник'}</h3><button class="pay2-close sheet-close" onclick="closeUserSheet()" aria-label="Закрыть">×</button></div>
      <div class="sheet-body">
        ${state.userFormError ? `<div class="login-error">${esc(state.userFormError)}</div>` : ''}
        <div class="field"><label>Имя и фамилия</label><input id="us-name" type="text" value="${esc(d.name)}" placeholder="Айгуль Сапарова" oninput="setUserSheet('name', this.value)"></div>
        <div class="pe-grid">
          <div class="field"><label>Логин для входа</label><input type="text" autocomplete="off" value="${esc(d.username)}" ${isNew ? '' : 'disabled'} placeholder="aigul" oninput="setUserSheet('username', this.value)"></div>
          <div class="field"><label>Телефон</label><input type="tel" value="${esc(d.phone)}" placeholder="+7 700 000 00 00" oninput="setUserSheet('phone', this.value)"></div>
        </div>
        <div class="field"><label>${isNew ? 'Пароль' : 'Новый пароль (если нужно сменить)'}</label><input type="text" autocomplete="new-password" value="${esc(d.password)}" placeholder="${isNew ? 'минимум 4 символа' : 'оставьте пустым'}" oninput="setUserSheet('password', this.value)"></div>
        <div class="field"><label>Роль</label>
          <div class="pe-seg">
            <button class="${d.role === 'cashier' ? 'active' : ''}" onclick="setUserSheet('role', 'cashier', true)">Кассир</button>
            <button class="${d.role === 'admin' ? 'active' : ''}" onclick="setUserSheet('role', 'admin', true)">Администратор</button>
          </div>
          <div class="page-sub" style="margin-top:6px;">${d.role === 'admin' ? 'Полный доступ: открытие и закрытие смен, товары, цены, склад, отчёты, сотрудники.' : 'Касса (в смене, которую открыл администратор), приём и возврат товара, свои чеки. Цены закупа и отчёты смен не видит.'}</div>
        </div>
        ${isNew || isSelf ? '' : `
        <div class="field"><label>Доступ</label>
          <div class="pe-seg">
            <button class="${d.is_active ? 'active' : ''}" onclick="setUserSheet('is_active', true, true)">Работает</button>
            <button class="${!d.is_active ? 'active off' : ''}" onclick="setUserSheet('is_active', false, true)">Отключён</button>
          </div>
          <div class="page-sub" style="margin-top:6px;">Отключённый сотрудник не сможет войти. Его чеки и смены останутся в истории.</div>
        </div>`}
      </div>
      <div class="sheet-actions">
        ${isNew || isSelf ? '' : `<button class="btn btn-danger pe-del" onclick="deleteUserFromSheet()" title="Удалить можно только сотрудника без чеков и смен">${icon('trash', 18)}<span>Удалить</span></button>`}
        <button class="btn btn-ghost" style="flex:1;" onclick="closeUserSheet()">Отмена</button>
        <button class="btn btn-hop pe-save" onclick="saveUserSheet()">${icon('check', 20)} ${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </div>
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
  session: 0,        // номер открытия окна — защищает от «догоняющих» старых кадров
  continuous: false,
  onCode: null,
  lastCode: '',
  lastAt: 0,
  stream: null,
  track: null,
  deviceId: '',
  cameras: [],
  torch: false,
  worker: null,       // фоновый поток распознавания (scan-worker.js)
  engineReady: false,
  busy: false,        // кадр сейчас распознаётся — следующий не шлём
  frameId: 0,
  sessionFirstFrame: 0,
  timer: null,
};

// Из QR/DataMatrix маркировки (GS1: 01 + GTIN-14 + ...) достаём обычный штрихкод EAN-13,
// чтобы товар нашёлся и по коду маркировки, и по обычному штрихкоду.
function barcodeCandidates(raw) {
  const code = String(raw || '').replace(/[\u001d\u0000-\u001f]/g, '').trim();
  const list = [code];
  const gs1 = code.match(/^(?:\]d2|\]C1|\]Q3)?(?:01|\(01\))(\d{14})/);
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
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Камера работает только по https:// или на localhost');
    return;
  }
  closeCameraScanner();
  const session = ++Scanner.session;
  let root = document.getElementById('scanner-root');
  if (!root) { root = document.createElement('div'); root.id = 'scanner-root'; document.body.appendChild(root); }
  root.innerHTML = `
    <div class="scanner-overlay" onclick="if(event.target===this) closeCameraScanner()">
      <div class="scanner-card" role="dialog" aria-label="${esc(title)}">
        <div class="scanner-head">
          <span>${esc(title)}</span>
          <button class="icon-btn" onclick="closeCameraScanner()" aria-label="Закрыть">×</button>
        </div>
        <div class="scanner-video-wrap">
          <video id="scanner-video" playsinline muted autoplay></video>
          <div class="scanner-aim"><span class="scanner-line"></span></div>
        </div>
        <div id="scanner-status" class="scanner-status">Запускаю камеру…</div>
        <div class="scanner-actions">
          <button id="scanner-torch" class="btn btn-ghost" onclick="toggleScannerTorch()" style="display:none;">Фонарик</button>
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
  Scanner.sessionFirstFrame = Scanner.frameId;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

  ensureScanWorker(); // WASM грузится параллельно с запуском камеры
  const ok = await startScannerStream(session);
  if (!ok || session !== Scanner.session) return;
  setScannerStatus(Scanner.engineReady ? 'Наведите камеру на штрихкод или QR-код' : 'Загружаю распознавание…');
  scanLoop(session);
  // Кнопки «Другая камера» и «Фонарик» — только если это возможно
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    Scanner.cameras = devices.filter(d => d.kind === 'videoinput');
    const btn = document.getElementById('scanner-switch');
    if (btn && Scanner.cameras.length > 1) btn.style.display = '';
  } catch (e) {}
}

// Запуск камеры с таймаутом: если камера занята или «молчит», не висим бесконечно
async function startScannerStream(session) {
  const saved = (() => { try { return localStorage.getItem('beershop_camera') || ''; } catch (e) { return ''; } })();
  const deviceId = Scanner.deviceId || saved;
  const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  const attempts = deviceId
    ? [{ ...base, deviceId: { exact: deviceId } }, { ...base, facingMode: { ideal: 'environment' } }]
    : [{ ...base, facingMode: { ideal: 'environment' } }, {}];
  let lastErr = null;
  for (const video of attempts) {
    try {
      const stream = await withTimeout(navigator.mediaDevices.getUserMedia({ video, audio: false }), 10000);
      if (session !== Scanner.session) { stream.getTracks().forEach(t => t.stop()); return false; }
      Scanner.stream = stream;
      const v = document.getElementById('scanner-video');
      v.srcObject = stream;
      await withTimeout(v.play(), 5000).catch(() => {});
      const track = stream.getVideoTracks()[0];
      Scanner.track = track;
      Scanner.deviceId = track.getSettings ? track.getSettings().deviceId || '' : '';
      try { const caps = track.getCapabilities ? track.getCapabilities() : {}; if (caps.torch) document.getElementById('scanner-torch').style.display = ''; } catch (e) {}
      return true;
    } catch (err) { lastErr = err; }
  }
  const name = String(lastErr && (lastErr.name || lastErr.message) || lastErr);
  setScannerStatus(
    /NotAllowed|Permission|Security/i.test(name) ? 'Нет доступа к камере. Разрешите камеру в браузере (значок замка в адресной строке) и откройте сканер снова.'
      : /timeout/i.test(name) ? 'Камера не отвечает. Закройте другие программы, которые её используют (Zoom, WhatsApp, другая вкладка), и попробуйте снова.'
      : /NotReadable|TrackStart|Abort/i.test(name) ? 'Камера занята другой программой или вкладкой. Закройте её и попробуйте снова.'
      : 'Камера не найдена. Проверьте, что она подключена.', 'error');
  return false;
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function ensureScanWorker() {
  if (Scanner.worker) return;
  try {
    const w = new Worker('/scan-worker.js?v=1');
    Scanner.worker = w;
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready') {
        Scanner.engineReady = true;
        if (Scanner.open && /Загружаю/.test(document.getElementById('scanner-status')?.textContent || '')) setScannerStatus('Наведите камеру на штрихкод или QR-код');
      } else if (m.type === 'result') {
        Scanner.busy = false;
        if (m.text && m.id > Scanner.sessionFirstFrame) onScannerDecoded(m.text);
      } else if (m.type === 'error') {
        setScannerStatus('Не удалось загрузить распознавание: ' + m.error, 'error');
      }
    };
    w.onerror = () => { Scanner.busy = false; };
  } catch (e) {
    setScannerStatus('Браузер не поддерживает фоновое распознавание — обновите браузер', 'error');
  }
}

// Цикл: берём кадр, только когда фоновый поток освободился (не копим очередь),
// вырезаем центральную зону прицела и уменьшаем до ~720px — этого хватает для штрихкода.
function scanLoop(session) {
  if (session !== Scanner.session || !Scanner.open) return;
  const v = document.getElementById('scanner-video');
  const next = () => { Scanner.timer = setTimeout(() => scanLoop(session), 90); };
  if (!v || !v.videoWidth || !Scanner.engineReady || Scanner.busy || document.hidden) { next(); return; }
  const vw = v.videoWidth, vh = v.videoHeight;
  const sw = Math.round(vw * 0.86), sh = Math.round(vh * 0.7);
  const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
  const scale = Math.min(1, 720 / sw);
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  Scanner.busy = true;
  const id = ++Scanner.frameId;
  const send = (frame, transfer) => { try { Scanner.worker.postMessage({ type: 'frame', id, frame }, transfer); } catch (e) { Scanner.busy = false; } };
  if (window.createImageBitmap && typeof OffscreenCanvas !== 'undefined') {
    createImageBitmap(v, sx, sy, sw, sh, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
      .then(bmp => { if (session === Scanner.session) send(bmp, [bmp]); else { bmp.close(); Scanner.busy = false; } })
      .catch(() => { Scanner.busy = false; });
  } else {
    // Старые браузеры: кадр в ImageData на основном потоке (дёшево — картинка маленькая)
    Scanner.canvas = Scanner.canvas || document.createElement('canvas');
    const c = Scanner.canvas; c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    const img = cx.getImageData(0, 0, w, h);
    send(img, [img.data.buffer]);
  }
  next();
}

async function switchScannerCamera() {
  if (!Scanner.cameras || Scanner.cameras.length < 2) return;
  const idx = Scanner.cameras.findIndex(c => c.deviceId === Scanner.deviceId);
  const nextCam = Scanner.cameras[(idx + 1) % Scanner.cameras.length];
  stopScannerStream();
  Scanner.deviceId = nextCam.deviceId;
  try { localStorage.setItem('beershop_camera', nextCam.deviceId); } catch (e) {}
  setScannerStatus('Переключаю камеру…');
  const session = Scanner.session;
  if (await startScannerStream(session)) setScannerStatus('Камера: ' + (nextCam.label || 'другая'));
}

async function toggleScannerTorch() {
  if (!Scanner.track) return;
  Scanner.torch = !Scanner.torch;
  try { await Scanner.track.applyConstraints({ advanced: [{ torch: Scanner.torch }] }); } catch (e) { Scanner.torch = false; }
}

function onScannerDecoded(decodedText) {
  const code = String(decodedText || '').trim();
  if (!code || !Scanner.onCode || !Scanner.open) return;
  const now = Date.now();
  // Тот же код, пока он в кадре, не считываем повторно чаще раза в 1.8 сек
  if (code === Scanner.lastCode && now - Scanner.lastAt < 1800) return;
  Scanner.lastCode = code;
  Scanner.lastAt = now;
  const result = Scanner.onCode(code) || {};
  scannerBeep(result.ok !== false);
  if (result.close || !Scanner.continuous) { closeCameraScanner(); return; }
  setScannerStatus(result.message || code, result.ok === false ? 'error' : 'ok');
  const aim = document.querySelector('.scanner-aim');
  if (aim) { aim.classList.remove('hit', 'miss'); void aim.offsetWidth; aim.classList.add(result.ok === false ? 'miss' : 'hit'); }
}

function stopScannerStream() {
  if (Scanner.stream) { Scanner.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); }
  Scanner.stream = null;
  Scanner.track = null;
  Scanner.torch = false;
  const v = document.getElementById('scanner-video');
  if (v) v.srcObject = null;
}

// Закрытие мгновенное и синхронное: ничего не ждём, поэтому окно не может «зависнуть»
function closeCameraScanner() {
  Scanner.session++;
  clearTimeout(Scanner.timer);
  stopScannerStream();
  Scanner.open = false;
  Scanner.onCode = null;
  Scanner.busy = false;
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
    const [suppliers, receipts, returns] = await Promise.all([api('/suppliers'), api('/stock/receipts'), api('/stock/returns')]);
    state.suppliers = suppliers;
    state.stockReceipts = receipts;
    state.stockReturns = returns;
    if (state.returnDraft.supplierId) await loadSupplierProducts(state.returnDraft.supplierId);
  } catch (err) { if (err.message !== 'unauthorized') showToast(err.message); }
  // Позиции черновика, чьи товары удалили, убираем
  const before = state.stockDraft.items.length;
  state.stockDraft.items = state.stockDraft.items.filter(i => state.products.some(p => p.id === i.productId));
  if (state.stockDraft.items.length !== before) saveStockDraft();
  const beforeRet = state.returnDraft.items.length;
  state.returnDraft.items = state.returnDraft.items.filter(i => state.products.some(p => p.id === i.productId));
  if (state.returnDraft.items.length !== beforeRet) saveReturnDraft();
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
      if (state.stockTab === 'return') { state.returnDraft.supplierId = String(created.id); saveReturnDraft(); }
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
    { id: 'return', label: 'Возврат' + (state.returnDraft.items.length ? ' (' + state.returnDraft.items.length + ')' : '') },
    { id: 'history', label: 'История' },
    { id: 'suppliers', label: 'Поставщики' },
  ];
  let body = '';
  if (state.stockTab === 'history') body = renderStockHistory();
  else if (state.stockTab === 'return') body = renderStockReturn();
  else if (state.stockTab === 'suppliers') body = renderSuppliers();
  else body = renderStockNew();
  return `
  <div class="page-head">
    <div><h2>Склад</h2><div class="page-sub">Приём товара от поставщиков, возвраты и остатки</div></div>
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

function setStockHistoryFilter(f) { state.stockHistoryFilter = f; render(); }
function renderStockHistory() {
  const isAdmin = state.currentUser.role === 'admin';
  const f = state.stockHistoryFilter;
  const docs = [
    ...(f === 'out' ? [] : state.stockReceipts.map(r => ({ ...r, kind: 'in' }))),
    ...(f === 'in' ? [] : state.stockReturns.map(r => ({ ...r, kind: 'out' }))),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const chips = [['all', 'Все', state.stockReceipts.length + state.stockReturns.length], ['in', 'Приходы', state.stockReceipts.length], ['out', 'Возвраты', state.stockReturns.length]]
    .map(([id, label, n]) => `<button class="pos2-chip ${f === id ? 'active' : ''}" onclick="setStockHistoryFilter('${id}')">${label}<span>${n}</span></button>`).join('');
  const rows = docs.map(r => {
    const isIn = r.kind === 'in';
    const docLine = isIn ? (r.doc_number ? 'Накладная ' + esc(r.doc_number) : 'без накладной')
      : 'Доверенность № ' + esc(r.poa_number || '—') + (r.representative_name ? ' · ' + esc(r.representative_name) : '');
    return `
    <button class="pl-row doc-row ${isIn ? 'doc-in' : 'doc-out'}" onclick="${isIn ? 'openStockReceipt' : 'openSupplierReturn'}(${r.id})">
      <div class="doc-badge">${isIn ? '+' : '−'}</div>
      <div class="pl-main">
        <div class="pl-name">${isIn ? 'Приход' : 'Возврат поставщику'} №${r.id} · ${esc(r.supplier_name || 'без поставщика')}</div>
        <div class="pl-sub"><span>${fmtDate(r.created_at)}</span><span>${docLine}</span></div>
        <div class="pl-cost">${r.items_count} поз. · ${isIn ? 'принял' : 'оформил'} ${esc(r.user_name || '—')}</div>
      </div>
      <div class="pl-right">
        ${isAdmin ? `<div class="pl-price ${isIn ? '' : 'neg'}">${isIn ? '' : '−'}${fmt(r.total)}</div>` : ''}
        <span class="pl-stock ${isIn ? 'ok' : 'low'}">${isIn ? 'приход' : 'возврат'}</span>
      </div>
      <span class="pl-chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');
  return `
  <div class="pos2-chips" style="margin-bottom:12px;">${chips}</div>
  <div class="pl-list doc-list">${rows}</div>
  ${docs.length === 0 ? '<div class="panel"><div class="empty-state">Документов пока нет.</div></div>' : ''}`;
}

/* ============ СКЛАД: ВОЗВРАТ ПОСТАВЩИКУ ============ */
const RETURN_REASONS = [
  { id: 'expired', label: 'Истёк срок годности' },
  { id: 'appearance', label: 'Потерял товарный вид' },
  { id: 'damaged', label: 'Брак / повреждение' },
  { id: 'other', label: 'Другое' },
];
function reasonLabel(id) { return (RETURN_REASONS.find(r => r.id === id) || RETURN_REASONS[3]).label; }
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDay(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10).split('-');
  return s.length === 3 ? `${s[2]}.${s[1]}.${s[0]}` : String(iso);
}
function emptyReturnDraft() {
  return { supplierId: '', poaNumber: '', poaDate: todayISO(), repName: '', repIin: '', note: '', defaultReason: 'expired', items: [] };
}
function loadReturnDraft() {
  try {
    const d = JSON.parse(localStorage.getItem('beershop_return_draft') || 'null');
    if (d && Array.isArray(d.items)) return { ...emptyReturnDraft(), ...d };
  } catch (e) {}
  return emptyReturnDraft();
}
function saveReturnDraft() {
  try { localStorage.setItem('beershop_return_draft', JSON.stringify(state.returnDraft)); } catch (e) {}
}

async function setReturnDraftField(field, value, rerender) {
  state.returnDraft[field] = value;
  saveReturnDraft();
  if (field === 'supplierId') await loadSupplierProducts(value);
  if (rerender || field === 'supplierId') render();
}
async function loadSupplierProducts(supplierId) {
  if (!supplierId || state.supplierProducts[supplierId]) return;
  try { state.supplierProducts[supplierId] = await api('/suppliers/' + supplierId + '/products'); }
  catch (e) { state.supplierProducts[supplierId] = []; }
}

function returnQtyInDraft(productId) {
  const it = state.returnDraft.items.find(i => i.productId === productId);
  return it ? Number(it.qty) || 0 : 0;
}
// Добавить товар в возврат (+1). Больше, чем лежит на складе, вернуть нельзя.
function addToReturnDraft(productId, qty = 1) {
  const p = state.products.find(x => x.id === productId);
  if (!p) return { ok: false, message: 'Товар не найден' };
  const have = Number(p.stock) || 0;
  const cur = returnQtyInDraft(productId);
  if (cur + qty > have + 1e-9) {
    const msg = have <= 0 ? `«${p.name}» нет на складе` : `На складе только ${formatQty(have, p.unit)} «${p.name}»`;
    showToast(msg);
    return { ok: false, message: msg };
  }
  let item = state.returnDraft.items.find(i => i.productId === productId);
  if (item) {
    item.qty = +(cur + qty).toFixed(2);
    state.returnDraft.items = [item, ...state.returnDraft.items.filter(i => i !== item)];
  } else {
    item = { productId, qty, reason: state.returnDraft.defaultReason || 'expired', cost_price: Number(p.cost_price) > 0 ? Number(p.cost_price) : '' };
    state.returnDraft.items.unshift(item);
  }
  saveReturnDraft();
  render();
  return { ok: true, message: '✓ ' + p.name + ' — к возврату ' + formatQty(item.qty, p.unit) };
}
function updateReturnItem(productId, field, value) {
  const item = state.returnDraft.items.find(i => i.productId === productId);
  if (!item) return;
  if (field === 'reason') item.reason = value;
  else if (field === 'qty') {
    const p = state.products.find(x => x.id === productId);
    const n = Number(String(value).replace(',', '.'));
    if (n > 0) item.qty = p ? Math.min(n, Number(p.stock) || 0) : n;
    if (p && n > Number(p.stock)) showToast('На складе только ' + formatQty(p.stock, p.unit));
  } else {
    const n = Number(String(value).replace(',', '.'));
    item[field] = value === '' || Number.isNaN(n) ? '' : n;
  }
  saveReturnDraft();
  render();
}
function changeReturnQty(productId, delta) {
  const item = state.returnDraft.items.find(i => i.productId === productId);
  if (!item) return;
  if (delta > 0) { addToReturnDraft(productId, delta); return; }
  const next = +(Number(item.qty) + delta).toFixed(2);
  if (next <= 0) { removeReturnItem(productId); return; }
  item.qty = next;
  saveReturnDraft();
  render();
}
function removeReturnItem(productId) {
  state.returnDraft.items = state.returnDraft.items.filter(i => i.productId !== productId);
  saveReturnDraft();
  render();
}
function setAllReturnReasons(reason) {
  state.returnDraft.defaultReason = reason;
  state.returnDraft.items.forEach(i => { i.reason = reason; });
  saveReturnDraft();
  render();
}
function clearReturnDraft() {
  if ((state.returnDraft.items.length || state.returnDraft.repName) && !confirm('Очистить текущий возврат?')) return;
  const keepSupplier = '';
  state.returnDraft = { ...emptyReturnDraft(), supplierId: keepSupplier };
  saveReturnDraft();
  render();
}
function returnDraftTotal() {
  return state.returnDraft.items.reduce((s, i) => s + (Number(i.cost_price) || 0) * (Number(i.qty) || 0), 0);
}

function handleReturnCode(rawCode, fromCamera) {
  const code = String(rawCode || '').trim();
  if (!code) return { ok: false };
  const p = findProductByBarcode(code);
  state.returnSearch = '';
  if (!p) {
    const msg = 'Штрихкод «' + code + '» не найден в товарах';
    if (!fromCamera) { showToast(msg); render(); }
    return { ok: false, message: 'Не найден: ' + code };
  }
  const r = addToReturnDraft(p.id, 1);
  if (!fromCamera) focusReturnSearch();
  return r;
}
function openReturnCamera() {
  openCameraScanner({ title: 'Сканер — возврат поставщику', continuous: true, onCode: (code) => handleReturnCode(code, true) });
}
function returnSearchMatches() {
  const q = state.returnSearch.trim().toLowerCase();
  if (!q) return [];
  return state.products.filter(p => p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q))).slice(0, 8);
}
function handleReturnSearchInput(value) { state.returnSearch = value; render(); focusReturnSearch(); }
function handleReturnSearchKey(event, value) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const v = value.trim();
  if (!v) return;
  if (/^\S{6,}$/.test(v) && (findProductByBarcode(v) || /^\d+$/.test(v))) { handleReturnCode(v, false); return; }
  const m = returnSearchMatches();
  if (m.length === 1) pickReturnSearchResult(m[0].id);
}
function pickReturnSearchResult(id) { state.returnSearch = ''; addToReturnDraft(id, 1); focusReturnSearch(); }
function focusReturnSearch() {
  const el = document.getElementById('return-search-input');
  if (el) { el.focus(); const l = el.value.length; try { el.setSelectionRange(l, l); } catch (e) {} }
}

async function postSupplierReturn() {
  const d = state.returnDraft;
  const isAdmin = state.currentUser.role === 'admin';
  if (!d.supplierId) { showToast('Выберите поставщика'); return; }
  if (!d.poaNumber.trim()) { showToast('Укажите номер доверенности'); document.getElementById('ret-poa')?.focus(); return; }
  if (!d.repName.trim()) { showToast('Укажите ФИО представителя поставщика'); document.getElementById('ret-rep')?.focus(); return; }
  if (d.repIin && d.repIin.replace(/\D/g, '').length !== 12) { showToast('ИИН представителя — 12 цифр'); return; }
  if (!d.items.length) { showToast('Добавьте товары в возврат'); return; }
  const sup = state.suppliers.find(s => String(s.id) === String(d.supplierId));
  if (!confirm(`Провести возврат поставщику «${sup ? sup.name : ''}»: ${d.items.length} поз.${isAdmin ? ' на сумму ' + fmt(returnDraftTotal()) : ''}? Товар спишется со склада.`)) return;
  try {
    const result = await api('/stock/returns', {
      method: 'POST',
      body: {
        supplier_id: Number(d.supplierId),
        poa_number: d.poaNumber, poa_date: d.poaDate, representative_name: d.repName,
        representative_iin: d.repIin, note: d.note,
        items: d.items.map(i => ({ productId: i.productId, qty: Number(i.qty), reason: i.reason, cost_price: i.cost_price === '' ? null : Number(i.cost_price) })),
      },
    });
    (result.products || []).forEach(up => {
      const idx = state.products.findIndex(p => p.id === up.id);
      if (idx >= 0) state.products[idx] = up;
    });
    delete result.products;
    state.stockReturns.unshift(result);
    state.returnDraft = emptyReturnDraft();
    saveReturnDraft();
    state.stockReturnToShow = result;
    render();
    showToast('Возврат №' + result.id + ' проведён — товар списан со склада');
  } catch (err) { showToast(err.message); }
}

async function openSupplierReturn(id) {
  try { state.stockReturnToShow = await api('/stock/returns/' + id); render(); } catch (err) { showToast(err.message); }
}
function closeSupplierReturnModal() { state.stockReturnToShow = null; render(); }
async function cancelSupplierReturn(id) {
  if (!confirm('Отменить возврат №' + id + '? Товар вернётся на склад.')) return;
  try {
    await api('/stock/returns/' + id, { method: 'DELETE' });
    state.stockReturnToShow = null;
    const [products] = await Promise.all([api('/products'), loadStockData()]);
    state.products = products;
    render();
    showToast('Возврат №' + id + ' отменён, товар снова на складе');
  } catch (err) { showToast(err.message); }
}

function renderStockReturn() {
  const isAdmin = state.currentUser.role === 'admin';
  const d = state.returnDraft;
  const supplierOptions = state.suppliers.map(s => `<option value="${s.id}" ${String(d.supplierId) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const matches = returnSearchMatches();
  const supIds = d.supplierId ? (state.supplierProducts[d.supplierId] || []) : [];
  const supProducts = supIds.map(id => state.products.find(p => p.id === id)).filter(p => p && Number(p.stock) > 0);
  const reasonOptions = (sel) => RETURN_REASONS.map(r => `<option value="${r.id}" ${sel === r.id ? 'selected' : ''}>${r.label}</option>`).join('');

  const itemsHtml = d.items.map((i, idx) => {
    const p = state.products.find(x => x.id === i.productId);
    if (!p) return '';
    const isDraft = p.unit === 'л';
    const sum = (Number(i.cost_price) || 0) * (Number(i.qty) || 0);
    return `
    <div class="sr-item ret-item">
      <div class="sr-num">${idx + 1}</div>
      <div class="sr-name">
        <div class="sr-title">${esc(p.name)}</div>
        <div class="sr-sub"><span class="mono">${esc(p.barcode || 'без штрихкода')}</span> · на складе ${formatQty(p.stock, p.unit)}</div>
      </div>
      <div class="sr-field sr-qty">
        <label>Кол-во${isDraft ? ', л' : ''}</label>
        <div class="sr-qty-ctrl">
          <button class="kassa-qty-btn" onclick="changeReturnQty(${p.id}, -1)" aria-label="Меньше">−</button>
          <input type="number" inputmode="decimal" min="0" step="${isDraft ? '0.1' : '1'}" value="${i.qty}" onchange="updateReturnItem(${p.id}, 'qty', this.value)">
          <button class="kassa-qty-btn" onclick="changeReturnQty(${p.id}, 1)" aria-label="Больше">+</button>
        </div>
      </div>
      <div class="sr-field ret-reason">
        <label>Причина</label>
        <select onchange="updateReturnItem(${p.id}, 'reason', this.value)">${reasonOptions(i.reason)}</select>
      </div>
      ${isAdmin ? `
      <div class="sr-field">
        <label>Цена, ₸/${isDraft ? 'л' : 'шт'}</label>
        <input type="number" inputmode="decimal" min="0" step="0.01" value="${i.cost_price}" placeholder="${Number(p.cost_price) || 0}" onchange="updateReturnItem(${p.id}, 'cost_price', this.value)">
      </div>
      <div class="sr-sum"><label>Сумма</label><div class="mono">${fmt(sum)}</div></div>` : ''}
      <button class="kassa-row-remove sr-remove" onclick="removeReturnItem(${p.id})" aria-label="Убрать из возврата">×</button>
    </div>`;
  }).join('');

  return `
  <div class="ret-banner">${icon('mixed', 20)}<span>Возврат товара поставщику: просроченный, потерявший вид или бракованный товар забирает представитель поставщика по доверенности. Товар спишется со склада, будет сформирован акт для подписи.</span></div>

  <div class="panel stock-head-panel">
    <div class="ret-section-title">Поставщик и доверенность</div>
    <div class="ret-head-grid">
      <div class="field ret-span2">
        <label>Поставщик *</label>
        <div style="display:flex; gap:6px;">
          <select style="flex:1;" onchange="setReturnDraftField('supplierId', this.value)">
            <option value="">— выберите —</option>
            ${supplierOptions}
          </select>
          <button type="button" class="icon-btn" title="Новый поставщик" onclick="openSupplierModal()">+</button>
        </div>
      </div>
      <div class="field">
        <label>№ доверенности *</label>
        <input id="ret-poa" type="text" value="${esc(d.poaNumber)}" placeholder="например, 125" onchange="setReturnDraftField('poaNumber', this.value)">
      </div>
      <div class="field">
        <label>Дата доверенности</label>
        <input type="date" value="${esc(d.poaDate)}" onchange="setReturnDraftField('poaDate', this.value)">
      </div>
      <div class="field ret-span2">
        <label>ФИО представителя *</label>
        <input id="ret-rep" type="text" value="${esc(d.repName)}" placeholder="кто забирает товар" onchange="setReturnDraftField('repName', this.value)">
      </div>
      <div class="field">
        <label>ИИН представителя</label>
        <input type="text" inputmode="numeric" maxlength="12" value="${esc(d.repIin)}" placeholder="12 цифр" onchange="setReturnDraftField('repIin', this.value.replace(/\\D/g, ''))">
      </div>
      <div class="field">
        <label>Примечание</label>
        <input type="text" value="${esc(d.note)}" placeholder="необязательно" onchange="setReturnDraftField('note', this.value)">
      </div>
    </div>
  </div>

  <div class="stock-scan-row">
    <button class="stock-camera-btn ret-camera" onclick="openReturnCamera()">${CAMERA_ICON}<span>Сканировать</span></button>
    <div class="stock-search-wrap">
      <input id="return-search-input" class="kassa-search-input" type="text" autocomplete="off"
        placeholder="Штрихкод (USB-сканер) или название товара"
        value="${esc(state.returnSearch)}"
        oninput="handleReturnSearchInput(this.value)"
        onkeydown="handleReturnSearchKey(event, this.value)">
      ${matches.length ? `
      <div class="stock-search-results">
        ${matches.map(p => `<button onclick="pickReturnSearchResult(${p.id})"><span>${esc(p.name)}</span><span class="mono">${formatQty(p.stock, p.unit)}</span></button>`).join('')}
      </div>` : ''}
    </div>
  </div>

  ${supProducts.length ? `
  <div class="ret-quick">
    <div class="ret-quick-title">Товары от этого поставщика — нажмите, чтобы добавить</div>
    <div class="ret-quick-list">
      ${supProducts.map(p => `<button onclick="addToReturnDraft(${p.id}, 1)"><span>${esc(p.name)}</span><small>${formatQty(Number(p.stock) - returnQtyInDraft(p.id), p.unit)}</small></button>`).join('')}
    </div>
  </div>` : ''}

  <div class="panel stock-items-panel">
    ${d.items.length ? `
    <div class="ret-items-head">
      <span>Причина для всех:</span>
      ${RETURN_REASONS.map(r => `<button class="${d.defaultReason === r.id ? 'active' : ''}" onclick="setAllReturnReasons('${r.id}')">${r.label}</button>`).join('')}
    </div>
    ${itemsHtml}` : `<div class="empty-state">Отсканируйте товар, который забирает поставщик, или найдите его по названию.</div>`}
  </div>

  <div class="stock-footer">
    <div class="kassa-total-box">
      <span class="kassa-total-label">${d.items.length} поз. к возврату${isAdmin ? ' · сумма' : ''}</span>
      ${isAdmin ? `<span class="kassa-total-value">${fmt(returnDraftTotal())}</span>` : ''}
    </div>
    <div class="kassa-footer-actions">
      <button class="kassa-btn-clear" ${d.items.length === 0 && !d.repName ? 'disabled' : ''} onclick="clearReturnDraft()">Очистить</button>
      <button class="kassa-btn-pay ret-post" ${d.items.length === 0 ? 'disabled' : ''} onclick="postSupplierReturn()">Провести возврат</button>
    </div>
  </div>`;
}

function renderSupplierReturnModal() {
  const r = state.stockReturnToShow;
  if (!r) return '';
  const isAdmin = state.currentUser.role === 'admin';
  const items = r.items || [];
  const reasons = [...new Set(items.map(i => reasonLabel(i.reason)))].join(', ');
  const rows = items.map((i, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${esc(i.product_name)}${i.barcode ? `<div class="act-bc">${esc(i.barcode)}</div>` : ''}</td>
      <td class="act-num">${formatQty(i.qty, i.unit)}</td>
      ${isAdmin ? `<td class="act-num">${fmt(i.cost_price)}</td><td class="act-num">${fmt(i.subtotal)}</td>` : ''}
      <td>${esc(reasonLabel(i.reason))}</td>
    </tr>`).join('');
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeSupplierReturnModal()">
    <div class="modal-card act-card">
      <div class="modal-close-row"><button class="icon-btn" onclick="closeSupplierReturnModal()" aria-label="Закрыть">×</button></div>
      <div class="receipt act">
        <div class="act-title">Акт возврата товара поставщику № ${r.id}</div>
        <div class="act-date">от ${r.created_at ? new Date(r.created_at).toLocaleDateString('ru-RU') : ''} г.</div>
        <table class="act-meta">
          <tr><td>Поставщик (получатель)</td><td><b>${esc(r.supplier_name || '—')}</b>${r.supplier_bin ? `, БИН/ИИН ${esc(r.supplier_bin)}` : ''}</td></tr>
          <tr><td>Покупатель (возвращает)</td><td>Магазин «Хмель»</td></tr>
          <tr><td>Доверенность</td><td>№ ${esc(r.poa_number || '—')}${r.poa_date ? ` от ${fmtDay(r.poa_date)}` : ''}</td></tr>
          <tr><td>Представитель поставщика</td><td>${esc(r.representative_name || '—')}${r.representative_iin ? `, ИИН ${esc(r.representative_iin)}` : ''}</td></tr>
          <tr><td>Причина возврата</td><td>${esc(reasons || '—')}</td></tr>
        </table>
        <table class="act-table">
          <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th>${isAdmin ? '<th>Цена</th><th>Сумма</th>' : ''}<th>Причина</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="act-total">Всего наименований: ${items.length}${isAdmin ? `, на сумму <b>${fmt(r.total)}</b>` : ''}</div>
        ${r.note ? `<div class="act-note">Примечание: ${esc(r.note)}</div>` : ''}
        <div class="act-text">Товар передан представителю поставщика. Претензий по количеству стороны не имеют.</div>
        <div class="act-signs">
          <div><div class="act-sign-role">Сдал (магазин)</div><div class="act-sign-line"></div><div class="act-sign-name">${esc(r.user_name || '')}</div></div>
          <div><div class="act-sign-role">Принял по доверенности № ${esc(r.poa_number || '')}</div><div class="act-sign-line"></div><div class="act-sign-name">${esc(r.representative_name || '')}</div></div>
        </div>
      </div>
      <div class="receipt-actions">
        ${isAdmin ? `<button class="btn btn-danger" style="flex:1;" onclick="cancelSupplierReturn(${r.id})">Отменить возврат</button>` : ''}
        <button class="btn btn-ghost" style="flex:1;" onclick="window.print()">Печать акта</button>
        <button class="btn btn-primary" style="flex:1;" onclick="closeSupplierReturnModal()">Готово</button>
      </div>
    </div>
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
            Принял: ${esc(r.user_name || '—')}</div>
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
  else if (state.view === 'shifts' && state.currentUser.role === 'admin') viewHtml = renderShifts();
  else viewHtml = renderPOS();

  app.innerHTML = `
    <div class="shell ${state.view === 'pos' ? 'shell-pos' : ''}">
      ${renderSidebar()}
      <main class="content ${state.view === 'pos' ? 'content-wide' : ''}">${viewHtml}</main>
    </div>
    ${renderReceiptModal()}
    ${renderStockReceiptModal()}
    ${renderSupplierReturnModal()}
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
