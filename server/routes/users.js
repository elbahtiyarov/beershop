// Сотрудники (администраторы и кассиры) — только для администратора
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

const FIELDS = 'u.id, u.username, u.name, u.role, u.phone, u.is_active, u.created_at';

// Список со статистикой: открытая смена, смены и выручка за 30 дней, расхождения
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${FIELDS},
            os.id AS open_shift_id, os.opened_at AS open_shift_at,
            COALESCE(st.shifts_30d, 0)::int AS shifts_30d,
            COALESCE(st.diff_30d, 0) AS diff_30d,
            COALESCE(st.short_count_30d, 0)::int AS short_count_30d,
            COALESCE(rv.revenue_30d, 0) AS revenue_30d,
            COALESCE(rv.receipts_30d, 0)::int AS receipts_30d,
            ls.last_shift_at
       FROM users u
       LEFT JOIN shifts os ON os.user_id = u.id AND os.closed_at IS NULL
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS shifts_30d, SUM(difference) AS diff_30d,
                COUNT(*) FILTER (WHERE difference < -0.009) AS short_count_30d
           FROM shifts WHERE opened_at > now() - interval '30 days' GROUP BY user_id
       ) st ON st.user_id = u.id
       LEFT JOIN (
         SELECT cashier_id, SUM(total) AS revenue_30d, COUNT(*) AS receipts_30d
           FROM receipts WHERE deleted_at IS NULL AND created_at > now() - interval '30 days' GROUP BY cashier_id
       ) rv ON rv.cashier_id = u.id
       LEFT JOIN (SELECT user_id, MAX(opened_at) AS last_shift_at FROM shifts GROUP BY user_id) ls ON ls.user_id = u.id
      ORDER BY u.is_active DESC, u.name ASC`);
  res.json(rows);
});

async function activeAdminsExcept(id) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND is_active AND id <> $1", [id]);
  return rows[0].c;
}
function cleanPhone(v) {
  if (v === undefined) return undefined;
  const s = String(v || '').trim().slice(0, 50);
  return s || null;
}

router.post('/', async (req, res) => {
  const { username, password, name, role, phone } = req.body || {};
  const login = String(username || '').trim();
  if (!login || !password || !String(name || '').trim() || !['admin', 'cashier'].includes(role)) {
    return res.status(400).json({ error: 'Укажите имя, логин, пароль и роль' });
  }
  if (String(password).length < 4) return res.status(400).json({ error: 'Пароль — минимум 4 символа' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, name, role, phone) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, name, role, phone, is_active, created_at`,
      [login, hash, String(name).trim(), role, cleanPhone(phone) || null]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой логин уже существует' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, role, password, is_active } = req.body || {};
  const phone = cleanPhone(req.body?.phone);
  try {
    const cur = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' });
    if (is_active === false && id === req.user.id) return res.status(400).json({ error: 'Нельзя отключить собственную учётную запись' });
    const losingAdmin = cur.rows[0].role === 'admin' && ((role && role !== 'admin') || is_active === false);
    if (losingAdmin && (await activeAdminsExcept(id)) < 1) return res.status(400).json({ error: 'Должен остаться хотя бы один активный администратор' });
    if (role && !['admin', 'cashier'].includes(role)) return res.status(400).json({ error: 'Неизвестная роль' });
    if (password) {
      if (String(password).length < 4) return res.status(400).json({ error: 'Пароль — минимум 4 символа' });
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, 10), id]);
    }
    const { rows } = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), role = COALESCE($2, role),
              phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
              is_active = COALESCE($5, is_active)
        WHERE id = $6 RETURNING id, username, name, role, phone, is_active, created_at`,
      [name ? String(name).trim() : null, role || null, phone !== undefined, phone ?? null,
       typeof is_active === 'boolean' ? is_active : null, id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить можно только сотрудника без чеков и смен — иначе его нужно отключить (история сохранится)
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить собственную учётную запись' });
  const target = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
  if (!target.rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' });
  if (target.rows[0].role === 'admin' && (await activeAdminsExcept(id)) < 1) {
    return res.status(400).json({ error: 'Должен остаться хотя бы один администратор' });
  }
  const used = await pool.query(
    `SELECT (SELECT COUNT(*) FROM receipts WHERE cashier_id = $1) + (SELECT COUNT(*) FROM shifts WHERE user_id = $1) AS c`, [id]);
  if (Number(used.rows[0].c) > 0) {
    return res.status(409).json({ error: 'У сотрудника есть чеки или смены — удалить нельзя. Отключите его: войти он не сможет, а история сохранится.' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.status(204).end();
});

module.exports = router;
