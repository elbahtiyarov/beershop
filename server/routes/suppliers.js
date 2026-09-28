const express = require('express');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function clean(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// Список поставщиков — нужен и кассиру (при оформлении прихода), и админу
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*,
            COALESCE(r.cnt, 0)::int AS receipts_count,
            COALESCE(r.sum, 0) AS receipts_total,
            r.last_at
       FROM suppliers s
       LEFT JOIN (
         SELECT supplier_id, COUNT(*) AS cnt, SUM(total) AS sum, MAX(created_at) AS last_at
           FROM stock_receipts GROUP BY supplier_id
       ) r ON r.supplier_id = s.id
      ORDER BY s.name ASC`
  );
  if (req.user.role !== 'admin') rows.forEach(s => delete s.receipts_total);
  res.json(rows);
});

// Товары, которые привозил этот поставщик (для быстрого выбора при возврате)
router.get('/:id/products', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.product_id, MAX(r.created_at) AS last_at, SUM(i.qty) AS total_qty
       FROM stock_receipt_items i JOIN stock_receipts r ON r.id = i.stock_receipt_id
      WHERE r.supplier_id = $1 AND i.product_id IS NOT NULL
      GROUP BY i.product_id ORDER BY MAX(r.created_at) DESC LIMIT 60`, [req.params.id]);
  res.json(rows.map(r => r.product_id));
});

// Добавить поставщика — кассир тоже может (принимает товар от нового поставщика)
router.post('/', async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 200);
  if (!name) return res.status(400).json({ error: 'Укажите название поставщика' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, phone, bin, contact_person, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, clean(b.phone, 50), clean(b.bin, 20), clean(b.contact_person, 100), clean(b.note, 1000)]
    );
    res.status(201).json({ ...rows[0], receipts_count: 0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Поставщик с таким названием уже есть' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Изменить поставщика — только администратор
router.put('/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = b.name === undefined ? undefined : clean(b.name, 200);
  if (name === null) return res.status(400).json({ error: 'Название не может быть пустым' });
  try {
    const { rows } = await pool.query(
      `UPDATE suppliers SET
         name = COALESCE($1, name),
         phone = CASE WHEN $2::boolean THEN $3 ELSE phone END,
         bin = CASE WHEN $4::boolean THEN $5 ELSE bin END,
         contact_person = CASE WHEN $6::boolean THEN $7 ELSE contact_person END,
         note = CASE WHEN $8::boolean THEN $9 ELSE note END
       WHERE id = $10 RETURNING *`,
      [
        name ?? null,
        b.phone !== undefined, clean(b.phone, 50),
        b.bin !== undefined, clean(b.bin, 20),
        b.contact_person !== undefined, clean(b.contact_person, 100),
        b.note !== undefined, clean(b.note, 1000),
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Поставщик не найден' });
    // Название в уже проведённых приходах тоже обновляем, чтобы история не расходилась
    if (name) await pool.query('UPDATE stock_receipts SET supplier_name = $1 WHERE supplier_id = $2', [name, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Поставщик с таким названием уже есть' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить поставщика — только администратор. Приходы остаются, в них сохраняется название.
router.delete('/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
