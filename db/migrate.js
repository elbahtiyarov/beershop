// Применяет schema.sql и (при первом запуске) seed.sql к базе данных,
// указанной в переменной окружения DATABASE_URL.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Схема применена.');

    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if (rows[0].count === 0) {
      const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
      await pool.query(seed);
      console.log('Начальные данные загружены (admin/admin123, kassir/kassir123).');
    } else {
      console.log('В базе уже есть пользователи — сид пропущен.');
    }
  } catch (err) {
    console.error('Ошибка миграции:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
