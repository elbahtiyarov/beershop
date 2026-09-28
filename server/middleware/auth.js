const jwt = require('jsonwebtoken');
const pool = require('../db');

// Проверяем токен и то, что сотрудник всё ещё активен.
// Роль и имя берём из базы — если админ отключил кассира или сменил роль,
// это действует сразу, а не когда истечёт токен.
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется вход в систему' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Сессия истекла, войдите снова' });
  }
  try {
    const { rows } = await pool.query('SELECT id, username, name, role, is_active FROM users WHERE id = $1', [payload.id]);
    const u = rows[0];
    if (!u || u.is_active === false) return res.status(401).json({ error: 'Учётная запись отключена администратором' });
    req.user = { id: u.id, username: u.username, name: u.name, role: u.role };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Доступно только администратору' });
  }
  next();
}

module.exports = { authenticate, requireAdmin };
