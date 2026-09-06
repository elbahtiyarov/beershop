const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `p${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 МБ
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения (JPG, PNG, WEBP, GIF)'));
  },
});

// Список товаров — доступен и кассиру (нужен для кассы), и админу
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY name ASC');
  res.json(rows);
});

// Поиск товара по штрихкоду — используется при сканировании на кассе
router.get('/barcode/:code', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE barcode = $1', [req.params.code]);
  if (!rows[0]) return res.status(404).json({ error: 'Товар с таким штрихкодом не найден' });
  res.json(rows[0]);
});

// Создание товара — доступно и кассиру (принять/забить новый товар), и админу.
// Редактирование и удаление — ниже, только администратор.
router.post('/', async (req, res) => {
  const { name, price, stock, barcode, category } = req.body || {};
  if (!name || price === undefined || price === null || Number(price) <= 0) {
    return res.status(400).json({ error: 'Укажите название и корректную цену' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO products (barcode, name, category, price, stock) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [barcode || null, name, category || 'Пиво', price, stock || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Товар с таким штрихкодом уже существует' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const { name, price, stock, barcode, image_url, category } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE products SET
         name = COALESCE($1, name),
         price = COALESCE($2, price),
         stock = COALESCE($3, stock),
         barcode = $4,
         image_url = COALESCE($5, image_url),
         category = COALESCE($6, category)
       WHERE id = $7 RETURNING *`,
      [name, price, stock, barcode || null, image_url === undefined ? null : image_url, category || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Товар не найден' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Товар с таким штрихкодом уже существует' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Загрузка фотографии товара — только администратор
router.post('/:id/image', requireAdmin, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить фото' });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const imageUrl = `/uploads/products/${req.file.filename}`;
    try {
      const existing = await pool.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
      if (!existing.rows[0]) return res.status(404).json({ error: 'Товар не найден' });

      const { rows } = await pool.query(
        'UPDATE products SET image_url = $1 WHERE id = $2 RETURNING *',
        [imageUrl, req.params.id]
      );

      // удаляем старый файл, если он был локальным загруженным фото
      const oldUrl = existing.rows[0].image_url;
      if (oldUrl && oldUrl.startsWith('/uploads/products/')) {
        const oldPath = path.join(__dirname, '..', '..', 'public', oldUrl);
        fs.unlink(oldPath, () => {});
      }

      res.json(rows[0]);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });
});

// Удалить фотографию товара — только администратор
router.delete('/:id/image', requireAdmin, async (req, res) => {
  const existing = await pool.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Товар не найден' });
  const oldUrl = existing.rows[0].image_url;
  const { rows } = await pool.query('UPDATE products SET image_url = NULL WHERE id = $1 RETURNING *', [req.params.id]);
  if (oldUrl && oldUrl.startsWith('/uploads/products/')) {
    fs.unlink(path.join(__dirname, '..', '..', 'public', oldUrl), () => {});
  }
  res.json(rows[0]);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const existing = await pool.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  const oldUrl = existing.rows[0]?.image_url;
  if (oldUrl && oldUrl.startsWith('/uploads/products/')) {
    fs.unlink(path.join(__dirname, '..', '..', 'public', oldUrl), () => {});
  }
  res.status(204).end();
});

// Переименовать категорию сразу у всех товаров — только администратор
router.put('/categories/rename', requireAdmin, async (req, res) => {
  const { oldName, newName } = req.body || {};
  if (!oldName || !newName || !newName.trim()) {
    return res.status(400).json({ error: 'Укажите старое и новое название категории' });
  }
  const { rowCount } = await pool.query(
    'UPDATE products SET category = $1 WHERE category = $2',
    [newName.trim(), oldName]
  );
  res.json({ renamed: rowCount, category: newName.trim() });
});

// Удалить категорию — товары переносятся в «Без категории», сами не удаляются. Только администратор
router.delete('/categories/:name', requireAdmin, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { rowCount } = await pool.query(
    "UPDATE products SET category = 'Без категории' WHERE category = $1",
    [name]
  );
  res.json({ moved: rowCount });
});

module.exports = router;
