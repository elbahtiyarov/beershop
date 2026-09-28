const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Учётная запись отключена. Обратитесь к администратору' });
    }
    const payload = { id: user.id, username: user.username, name: user.name, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
