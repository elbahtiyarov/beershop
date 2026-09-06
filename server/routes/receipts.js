const express = require('express');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

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
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Чек не может быть пустым' });
  }

  const client = await pool.connect();
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
      if (product.stock < qty) {
        throw Object.assign(new Error(`Недостаточно товара «${product.name}» на складе (осталось ${product.stock})`), { status: 409 });
      }
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [qty, product.id]);
      const subtotal = Number(product.price) * qty;
      total += subtotal;
      lineItems.push({ productId: product.id, name: product.name, price: product.price, costPrice: product.cost_price || 0, qty, subtotal });
    }

    const receiptResult = await client.query(
      'INSERT INTO receipts (cashier_id, cashier_name, total) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, req.user.name, total]
    );
    const receipt = receiptResult.rows[0];

    for (const li of lineItems) {
      await client.query(
        'INSERT INTO receipt_items (receipt_id, product_id, product_name, price, cost_price, qty, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [receipt.id, li.productId, li.name, li.price, li.costPrice, li.qty, li.subtotal]
      );
    }

    await client.query('COMMIT');
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
