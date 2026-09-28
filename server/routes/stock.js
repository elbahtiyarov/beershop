// Склад: приходные накладные (поступление товара от поставщика)
const express = require('express');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Список приходов. Суммы в закупочных ценах видит только администратор.
router.get('/receipts', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT COUNT(*)::int FROM stock_receipt_items i WHERE i.stock_receipt_id = r.id) AS items_count
       FROM stock_receipts r
      ORDER BY r.created_at DESC
      LIMIT 500`
  );
  if (!isAdmin) rows.forEach(r => delete r.total);
  res.json(rows);
});

router.get('/receipts/:id', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query('SELECT * FROM stock_receipts WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Приход не найден' });
  const items = await pool.query('SELECT * FROM stock_receipt_items WHERE stock_receipt_id = $1 ORDER BY id', [req.params.id]);
  const receipt = { ...rows[0], items: items.rows };
  if (!isAdmin) {
    delete receipt.total;
    receipt.items.forEach(i => { delete i.cost_price; delete i.subtotal; });
  }
  res.json(receipt);
});

// Провести приход: всё в одной транзакции — запись накладной + увеличение остатков.
// Администратор может заодно обновить себестоимость и цену продажи товара.
router.post('/receipts', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { supplier_id, doc_number, note, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Добавьте в приход хотя бы один товар' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let supplierName = null;
    let supplierId = null;
    if (supplier_id) {
      const s = await client.query('SELECT id, name FROM suppliers WHERE id = $1', [supplier_id]);
      if (!s.rows[0]) throw httpError(404, 'Поставщик не найден');
      supplierId = s.rows[0].id;
      supplierName = s.rows[0].name;
    }

    const { rows: [header] } = await client.query(
      `INSERT INTO stock_receipts (supplier_id, supplier_name, doc_number, note, user_id, user_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [supplierId, supplierName, (doc_number || '').trim().slice(0, 100) || null,
       (note || '').trim().slice(0, 1000) || null, req.user.id, req.user.name || req.user.username]
    );

    let total = 0;
    const savedItems = [];
    const updatedProducts = [];

    for (const item of items) {
      const qty = Number(item.qty);
      if (!(qty > 0)) throw httpError(400, 'Количество должно быть больше нуля');

      const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
      const product = rows[0];
      if (!product) throw httpError(404, 'Товар не найден (возможно, его удалили)');
      if (product.unit !== 'л' && !Number.isInteger(qty)) {
        throw httpError(400, `Количество «${product.name}» должно быть целым числом (шт)`);
      }

      const costInput = Number(item.cost_price);
      const cost = isAdmin && costInput > 0 ? costInput : Number(product.cost_price) || 0;
      const subtotal = +(cost * qty).toFixed(2);
      total += subtotal;

      const priceInput = Number(item.price);
      const newPrice = isAdmin && priceInput > 0 ? priceInput : null;
      const newCost = isAdmin && costInput > 0 ? costInput : null;

      const { rows: [updated] } = await client.query(
        `UPDATE products SET stock = stock + $1,
                cost_price = COALESCE($2, cost_price),
                price = COALESCE($3, price)
          WHERE id = $4 RETURNING *`,
        [qty, newCost, newPrice, product.id]
      );
      updatedProducts.push(updated);

      const { rows: [line] } = await client.query(
        `INSERT INTO stock_receipt_items (stock_receipt_id, product_id, product_name, barcode, unit, qty, cost_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [header.id, product.id, product.name, product.barcode, product.unit, qty, cost, subtotal]
      );
      savedItems.push(line);
    }

    const { rows: [final] } = await client.query(
      'UPDATE stock_receipts SET total = $1 WHERE id = $2 RETURNING *', [total, header.id]
    );
    await client.query('COMMIT');

    const result = { ...final, items: savedItems, items_count: savedItems.length, products: updatedProducts };
    if (!isAdmin) {
      delete result.total;
      result.items.forEach(i => { delete i.cost_price; delete i.subtotal; });
      result.products.forEach(p => delete p.cost_price);
    }
    res.status(201).json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

// Отменить приход (только администратор): остатки уменьшаются обратно.
// Если часть товара уже продана и остатка не хватает — отмена не выполняется.
router.delete('/receipts/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM stock_receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) throw httpError(404, 'Приход не найден');
    const items = await client.query('SELECT * FROM stock_receipt_items WHERE stock_receipt_id = $1', [req.params.id]);
    for (const it of items.rows) {
      if (!it.product_id) continue; // товар уже удалён из учёта
      const p = await client.query('SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
      if (!p.rows[0]) continue;
      if (Number(p.rows[0].stock) < Number(it.qty)) {
        throw httpError(409, `Нельзя отменить: товара «${p.rows[0].name}» на складе ${p.rows[0].stock}, а в приходе ${it.qty} — часть уже продана`);
      }
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [it.qty, it.product_id]);
    }
    await client.query('DELETE FROM stock_receipts WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

/* ================= ВОЗВРАТ ПОСТАВЩИКУ ================= */
const RETURN_REASONS = ['expired', 'appearance', 'damaged', 'other'];

router.get('/returns', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT COUNT(*)::int FROM supplier_return_items i WHERE i.supplier_return_id = r.id) AS items_count
       FROM supplier_returns r
      ORDER BY r.created_at DESC
      LIMIT 500`
  );
  if (!isAdmin) rows.forEach(r => delete r.total);
  res.json(rows);
});

router.get('/returns/:id', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(
    `SELECT r.*, s.bin AS supplier_bin, s.phone AS supplier_phone
       FROM supplier_returns r LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Возврат не найден' });
  const items = await pool.query('SELECT * FROM supplier_return_items WHERE supplier_return_id = $1 ORDER BY id', [req.params.id]);
  const ret = { ...rows[0], items: items.rows };
  if (!isAdmin) {
    delete ret.total;
    ret.items.forEach(i => { delete i.cost_price; delete i.subtotal; });
  }
  res.json(ret);
});

// Провести возврат: списываем остатки и сохраняем акт — всё в одной транзакции
router.post('/returns', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const b = req.body || {};
  const items = b.items;
  if (!b.supplier_id) return res.status(400).json({ error: 'Выберите поставщика, которому возвращаете товар' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Добавьте в возврат хотя бы один товар' });
  const repName = String(b.representative_name || '').trim().slice(0, 150);
  const poaNumber = String(b.poa_number || '').trim().slice(0, 100);
  if (!repName) return res.status(400).json({ error: 'Укажите ФИО представителя поставщика' });
  if (!poaNumber) return res.status(400).json({ error: 'Укажите номер доверенности' });
  const repIin = String(b.representative_iin || '').replace(/\D/g, '');
  if (repIin && repIin.length !== 12) return res.status(400).json({ error: 'ИИН представителя — 12 цифр' });
  const poaDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.poa_date || '')) ? b.poa_date : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query('SELECT id, name FROM suppliers WHERE id = $1', [b.supplier_id]);
    if (!s.rows[0]) throw httpError(404, 'Поставщик не найден');

    const { rows: [header] } = await client.query(
      `INSERT INTO supplier_returns (supplier_id, supplier_name, poa_number, poa_date, representative_name, representative_iin, note, user_id, user_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [s.rows[0].id, s.rows[0].name, poaNumber, poaDate, repName, repIin || null,
       String(b.note || '').trim().slice(0, 1000) || null, req.user.id, req.user.name || req.user.username]
    );

    let total = 0;
    const savedItems = [];
    const updatedProducts = [];
    for (const item of items) {
      const qty = Number(item.qty);
      if (!(qty > 0)) throw httpError(400, 'Количество должно быть больше нуля');
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
      const product = rows[0];
      if (!product) throw httpError(404, 'Товар не найден (возможно, его удалили)');
      if (product.unit !== 'л' && !Number.isInteger(qty)) throw httpError(400, `Количество «${product.name}» должно быть целым числом (шт)`);
      if (Number(product.stock) < qty) {
        throw httpError(409, `Нельзя вернуть ${qty} «${product.name}» — на складе только ${Number(product.stock)} ${product.unit === 'л' ? 'л' : 'шт'}`);
      }
      const reason = RETURN_REASONS.includes(item.reason) ? item.reason : 'other';
      const costInput = Number(item.cost_price);
      const cost = isAdmin && costInput >= 0 && item.cost_price !== null && item.cost_price !== '' && item.cost_price !== undefined
        ? costInput : Number(product.cost_price) || 0;
      const subtotal = +(cost * qty).toFixed(2);
      total += subtotal;

      const { rows: [updated] } = await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2 RETURNING *', [qty, product.id]);
      updatedProducts.push(updated);
      const { rows: [line] } = await client.query(
        `INSERT INTO supplier_return_items (supplier_return_id, product_id, product_name, barcode, unit, qty, cost_price, subtotal, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [header.id, product.id, product.name, product.barcode, product.unit, qty, cost, subtotal, reason]
      );
      savedItems.push(line);
    }
    const { rows: [final] } = await client.query('UPDATE supplier_returns SET total = $1 WHERE id = $2 RETURNING *', [total, header.id]);
    const sup = await client.query('SELECT bin, phone FROM suppliers WHERE id = $1', [s.rows[0].id]);
    await client.query('COMMIT');

    const result = { ...final, supplier_bin: sup.rows[0]?.bin || null, supplier_phone: sup.rows[0]?.phone || null,
      items: savedItems, items_count: savedItems.length, products: updatedProducts };
    if (!isAdmin) {
      delete result.total;
      result.items.forEach(i => { delete i.cost_price; delete i.subtotal; });
      result.products.forEach(p => delete p.cost_price);
    }
    res.status(201).json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

// Отменить возврат (только админ): товар возвращается на склад
router.delete('/returns/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM supplier_returns WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) throw httpError(404, 'Возврат не найден');
    const items = await client.query('SELECT product_id, qty FROM supplier_return_items WHERE supplier_return_id = $1', [req.params.id]);
    for (const it of items.rows) {
      if (it.product_id) await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [it.qty, it.product_id]);
    }
    await client.query('DELETE FROM supplier_returns WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

module.exports = router;
