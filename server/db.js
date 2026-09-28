const { Pool, types } = require('pg');

// Колонки типа DATE (без времени) отдаём как есть — 'YYYY-MM-DD'.
// Иначе драйвер превращает дату в полночь по местному времени и в UTC+5 она «уезжает» на день назад.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Неожиданная ошибка пула PostgreSQL:', err);
});

module.exports = pool;
