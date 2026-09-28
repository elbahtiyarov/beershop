const express = require('express');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sendWhatsApp } = require('../notify');

const router = express.Router();
router.use(authenticate);

// История чеков (без удалённых): админ видит все, кассир — только свои
router.get('/', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(
    isAdmin
      ? 'SELECT * FROM receipts WHERE deleted_at IS NULL ORDER BY created_at DESC'
      : 'SELECT * FROM receipts WHERE cashier_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
    isAdmin ? [] : [req.user.id]
  );
  res.json(rows);
});

// Корзина — только администратор
router.get('/trash', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM receipts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM receipts WHERE id = $1', [req.params.id]);
  const receipt = rows[0];
  if (!receipt) return res.status(404).json({ error: 'Чек не найден' });
  if (req.user.role !== 'admin' && receipt.cashier_id !== req.user.id) {
    return res.status(403).json({ error: 'Нет доступа к этому чеку' });
  }
  const items = await pool.query('SELECT * FROM receipt_items WHERE receipt_id = $1', [req.params.id]);
  res.json({ ...receipt, items: items.rows });
});

// Оформление чека — доступно и кассиру, и админу.
// Пересчёт остатков и запись чека выполняются в одной транзакции,
// чтобы нельзя было продать больше, чем есть на складе.
router.post('/', async (req, res) => {
  const { items, payment_method, cash_amount, qr_amount, received_amount } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Чек не может быть пустым' });
  }
  const validMethods = ['cash', 'qr', 'mixed'];
  const method = validMethods.includes(payment_method) ? payment_method : 'cash';

  const client = await pool.connect();
  const outOfStockAlerts = [];
  // Продавать можно только в открытой смене магазина (её открывает администратор)
  const shiftRes = await client.query('SELECT id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1');
  if (!shiftRes.rows[0]) {
    client.release();
    return res.status(409).json({ error: 'Смена не открыта. Попросите администратора открыть смену', code: 'NO_SHIFT' });
  }
  const shiftId = shiftRes.rows[0].id; // товары, у которых остаток обнулился именно этой продажей
  try {
    await client.query('BEGIN');

    let total = 0;
    const lineItems = [];

    for (const item of items) {
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
      const product = rows[0];
      if (!product) throw Object.assign(new Error(`Товар не найден`), { status: 404 });
      const qty = Number(item.qty) || 0;
      if (qty <= 0) throw Object.assign(new Error('Некорректное количество'), { status: 400 });

      // Для разливного (единица «л») одна продажа списывает объём порции (volume_liters),
      // а не «1 штуку». Для обычных товаров — как раньше, qty штук.
      const isDraft = product.unit === 'л';
      const consumption = isDraft ? qty * Number(product.volume_liters || 1) : qty;

      if (Number(product.stock) < consumption) {
        const unitLabel = isDraft ? 'л' : 'шт';
        throw Object.assign(new Error(`Недостаточно товара «${product.name}» на складе (осталось ${product.stock} ${unitLabel})`), { status: 409 });
      }

      const newStock = Number(product.stock) - consumption;
      await client.query('UPDATE products SET stock = $1 WHERE id = $2', [newStock, product.id]);

      // Уведомление в WhatsApp срабатывает один раз — именно в момент, когда разливное закончилось
      if (isDraft && Number(product.stock) > 0 && newStock <= 0) {
        outOfStockAlerts.push(product.name);
      }

      const subtotal = Number(product.price) * qty;
      total += subtotal;
      lineItems.push({ productId: product.id, name: product.name, price: product.price, costPrice: product.cost_price || 0, qty, subtotal });
    }

    // Проверяем способ оплаты уже зная точный итог (нельзя доверять сумме, присланной с фронта, без сверки)
    let cashAmount = 0;
    let qrAmount = 0;
    let receivedAmount = null;
    if (method === 'cash') {
      cashAmount = total;
      receivedAmount = Number(received_amount) || total;
      if (receivedAmount < total - 0.01) {
        throw Object.assign(new Error('Сумма наличных меньше итога чека'), { status: 400 });
      }
    } else if (method === 'qr') {
      qrAmount = total;
    } else {
      cashAmount = Number(cash_amount) || 0;
      qrAmount = Number(qr_amount) || 0;
      if (Math.abs(cashAmount + qrAmount - total) > 0.01) {
        throw Object.assign(new Error('Сумма наличными и по QR должна совпадать с итогом чека'), { status: 400 });
      }
      receivedAmount = cashAmount;
    }

    const receiptResult = await client.query(
      'INSERT INTO receipts (cashier_id, cashier_name, total, payment_method, cash_amount, qr_amount, received_amount, shift_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [req.user.id, req.user.name, total, method, cashAmount, qrAmount, receivedAmount, shiftId]
    );
    const receipt = receiptResult.rows[0];

    for (const li of lineItems) {
      await client.query(
        'INSERT INTO receipt_items (receipt_id, product_id, product_name, price, cost_price, qty, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [receipt.id, li.productId, li.name, li.price, li.costPrice, li.qty, li.subtotal]
      );
    }

    await client.query('COMMIT');

    for (const name of outOfStockAlerts) {
      sendWhatsApp(`🍺 Закончилось разливное: «${name}». Остаток — 0 л.`);
    }

    res.status(201).json({ ...receipt, items: lineItems });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

// Переместить чек в корзину — только администратор.
// Остатки автоматически не восстанавливаются (решение принимает админ отдельно).
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE receipts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Чек не найден' });
  res.status(204).end();
});

// Восстановить чек из корзины — только администратор.
router.post('/:id/restore', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE receipts SET deleted_at = NULL WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Чек не найден' });
  res.json(rows[0]);
});

// Удалить безвозвратно из корзины — только администратор.
router.delete('/:id/permanent', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM receipts WHERE id = $1 AND deleted_at IS NOT NULL', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
