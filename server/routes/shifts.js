// Кассовые смены: открытие, внесение/изъятие наличных, X-отчёт, закрытие (Z-отчёт).
// Смена общая на магазин: открывает и закрывает её только администратор,
// кассиры продают в открытой смене (их продажи видны в Z-отчёте по каждому кассиру).
const express = require('express');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sendWhatsApp } = require('../notify');

const router = express.Router();
router.use(authenticate);

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Текущие итоги смены (для X-отчёта и при закрытии). Удалённые в корзину чеки не считаются.
async function computeTotals(db, shift) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS receipts_count,
            COALESCE(SUM(total), 0) AS total_sales,
            COALESCE(SUM(cash_amount), 0) AS cash_sales,
            COALESCE(SUM(qr_amount), 0) AS qr_sales,
            COUNT(*) FILTER (WHERE payment_method = 'cash')::int AS cash_count,
            COUNT(*) FILTER (WHERE payment_method = 'qr')::int AS qr_count,
            COUNT(*) FILTER (WHERE payment_method = 'mixed')::int AS mixed_count
       FROM receipts WHERE shift_id = $1 AND deleted_at IS NULL`, [shift.id]);
  const m = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'in'), 0) AS cash_in,
            COALESCE(SUM(amount) FILTER (WHERE type = 'out'), 0) AS cash_out
       FROM cash_movements WHERE shift_id = $1`, [shift.id]);
  const moves = await db.query('SELECT * FROM cash_movements WHERE shift_id = $1 ORDER BY created_at', [shift.id]);
  const byCashier = await db.query(
    `SELECT cashier_name, COUNT(*)::int AS receipts_count, COALESCE(SUM(total), 0) AS total,
            COALESCE(SUM(cash_amount), 0) AS cash, COALESCE(SUM(qr_amount), 0) AS qr
       FROM receipts WHERE shift_id = $1 AND deleted_at IS NULL
      GROUP BY cashier_name ORDER BY SUM(total) DESC`, [shift.id]);
  const t = r.rows[0];
  const cashIn = money(m.rows[0].cash_in);
  const cashOut = money(m.rows[0].cash_out);
  const expected = money(Number(shift.opening_cash) + Number(t.cash_sales) + cashIn - cashOut);
  return {
    receipts_count: t.receipts_count,
    total_sales: money(t.total_sales),
    cash_sales: money(t.cash_sales),
    qr_sales: money(t.qr_sales),
    cash_count: t.cash_count, qr_count: t.qr_count, mixed_count: t.mixed_count,
    cash_in: cashIn,
    cash_out: cashOut,
    expected_cash: expected,
    movements: moves.rows,
    by_cashier: byCashier.rows.map(c => ({ ...c, total: money(c.total), cash: money(c.cash), qr: money(c.qr) })),
  };
}

// Отчёт по смене: у открытой — живые итоги, у закрытой — зафиксированные при закрытии
async function shiftReport(db, shift) {
  const live = await computeTotals(db, shift);
  if (!shift.closed_at) return { ...shift, ...live, is_open: true };
  return {
    ...shift, is_open: false,
    cash_count: live.cash_count, qr_count: live.qr_count, mixed_count: live.mixed_count,
    movements: live.movements,
    by_cashier: live.by_cashier,
  };
}

// Открытая смена магазина (если по старой версии открыто несколько — берём последнюю)
async function openStoreShift(db, lock) {
  const { rows } = await db.query(
    `SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`);
  return rows[0] || null;
}

// Текущая смена магазина. Кассиру — только факт, что смена открыта (без сумм), админу — X-отчёт.
router.get('/current', async (req, res) => {
  const shift = await openStoreShift(pool);
  if (!shift) return res.json(null);
  if (req.user.role !== 'admin') {
    return res.json({ id: shift.id, opened_at: shift.opened_at, user_name: shift.user_name, is_open: true });
  }
  res.json(await shiftReport(pool, shift));
});

router.post('/open', requireAdmin, async (req, res) => {
  const opening = money(req.body?.opening_cash);
  if (opening < 0) return res.status(400).json({ error: 'Сумма не может быть отрицательной' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(424242)'); // две смены одновременно открыть нельзя
    const existing = await openStoreShift(client);
    if (existing) throw httpError(409, `Смена уже открыта (№${existing.id}, открыл ${existing.user_name})`);
    const { rows } = await client.query(
      'INSERT INTO shifts (user_id, user_name, opening_cash) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, req.user.name, opening]);
    const report = await shiftReport(client, rows[0]);
    await client.query('COMMIT');
    res.status(201).json(report);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally { client.release(); }
});

// Внесение / изъятие наличных
router.post('/current/cash', requireAdmin, async (req, res) => {
  const type = req.body?.type === 'out' ? 'out' : req.body?.type === 'in' ? 'in' : null;
  const amount = money(req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  if (!type) return res.status(400).json({ error: 'Укажите тип операции' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Укажите сумму больше нуля' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shift = await openStoreShift(client, true);
    if (!shift) throw httpError(409, 'Смена не открыта');
    if (type === 'out') {
      const t = await computeTotals(client, shift);
      if (amount > t.expected_cash + 0.001) throw httpError(409, `В кассе по расчёту только ${t.expected_cash} ₸ — нельзя изъять ${amount} ₸`);
    }
    await client.query('INSERT INTO cash_movements (shift_id, type, amount, reason, user_name) VALUES ($1, $2, $3, $4, $5)',
      [shift.id, type, amount, reason, req.user.name]);
    const report = await shiftReport(client, shift);
    await client.query('COMMIT');
    res.status(201).json(report);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally { client.release(); }
});

// Закрытие смены: пересчитанные наличные → расхождение → Z-отчёт.
// Общая логика для кассира (своя смена) и администратора (любая открытая смена).
async function closeShift(req, res, findShift) {
  const counted = money(req.body?.counted_cash);
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  if (req.body?.counted_cash === undefined || req.body?.counted_cash === null || req.body?.counted_cash === '' || counted < 0) {
    return res.status(400).json({ error: 'Пересчитайте наличные в кассе и введите сумму' });
  }
  const client = await pool.connect();
  let closed;
  try {
    await client.query('BEGIN');
    const shift = await findShift(client);
    if (!shift) throw httpError(409, 'Смена уже закрыта');
    const t = await computeTotals(client, shift);
    const diff = money(counted - t.expected_cash);
    const { rows } = await client.query(
      `UPDATE shifts SET closed_at = now(), receipts_count = $1, total_sales = $2, cash_sales = $3, qr_sales = $4,
              cash_in = $5, cash_out = $6, expected_cash = $7, counted_cash = $8, difference = $9, close_note = $10,
              closed_by = $11
        WHERE id = $12 RETURNING *`,
      [t.receipts_count, t.total_sales, t.cash_sales, t.qr_sales, t.cash_in, t.cash_out, t.expected_cash, counted, diff, note,
       req.user.name, shift.id]);
    closed = await shiftReport(client, rows[0]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  client.release();

  const f = (v) => Number(v).toLocaleString('ru-RU') + ' ₸';
  const d = Number(closed.difference);
  sendWhatsApp(
    `🧾 Смена №${closed.id} закрыта (${closed.user_name}${closed.closed_by && closed.closed_by !== closed.user_name ? ', закрыл ' + closed.closed_by : ''})\n` +
    `Чеков: ${closed.receipts_count}, выручка: ${f(closed.total_sales)}\n` +
    `Наличные: ${f(closed.cash_sales)}, QR: ${f(closed.qr_sales)}\n` +
    `В кассе: ${f(closed.counted_cash)} (ожидалось ${f(closed.expected_cash)})` +
    (Math.abs(d) >= 0.01 ? `\n⚠️ ${d < 0 ? 'Недостача' : 'Излишек'}: ${f(Math.abs(d))}` : '\n✅ Касса сошлась')
  );
  res.json(closed);
}

// Администратор закрывает текущую смену магазина
router.post('/current/close', requireAdmin, (req, res) => closeShift(req, res, (db) => openStoreShift(db, true)));

// Администратор закрывает конкретную открытую смену (в т.ч. оставшиеся от старой версии)
router.post('/:id/close', requireAdmin, (req, res) => closeShift(req, res, async (db) => {
  const { rows } = await db.query('SELECT * FROM shifts WHERE id = $1 AND closed_at IS NULL FOR UPDATE', [req.params.id]);
  return rows[0] || null;
}));

// Список смен — только администратор. Для открытых смен считаем живые итоги.
router.get('/', requireAdmin, async (req, res) => {
  const userId = Number(req.query.user_id) || null;
  const { rows } = await pool.query(
    `SELECT * FROM shifts ${userId ? 'WHERE user_id = $1' : ''} ORDER BY opened_at DESC LIMIT 300`,
    userId ? [userId] : []);
  const out = [];
  for (const s of rows) {
    if (s.closed_at) out.push({ ...s, is_open: false });
    else { const t = await computeTotals(pool, s); delete t.movements; out.push({ ...s, ...t, is_open: true }); }
  }
  res.json(out);
});

// Отчёт по смене — только администратор
router.get('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shifts WHERE id = $1', [req.params.id]);
  const s = rows[0];
  if (!s) return res.status(404).json({ error: 'Смена не найдена' });
  res.json(await shiftReport(pool, s));
});

module.exports = router;
