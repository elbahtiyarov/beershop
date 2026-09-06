const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin); // весь раздел — только для администратора

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, name, role, created_at FROM users ORDER BY name ASC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name || !['admin', 'cashier'].includes(role)) {
    return res.status(400).json({ error: 'Заполните все поля корректно' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role, created_at',
      [username, hash, name, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой логин уже существует' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.put('/:id', async (req, res) => {
  const { name, role, password } = req.body || {};
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    }
    const { rows } = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), role = COALESCE($2, role)
       WHERE id = $3 RETURNING id, username, name, role, created_at`,
      [name, role, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.delete('/:id', async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить собственную учётную запись' });
  }
  const admins = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
  const target = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.id]);
  if (target.rows[0]?.role === 'admin' && admins.rows[0].count <= 1) {
    return res.status(400).json({ error: 'Должен остаться хотя бы один администратор' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
