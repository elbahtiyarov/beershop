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

// Список товаров — доступен и кассиру (нужен для кассы), и админу.
// Себестоимость видна только администратору.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY name ASC');
  if (req.user.role !== 'admin') rows.forEach(p => delete p.cost_price);
  res.json(rows);
});

// Поиск товара по штрихкоду — используется при сканировании на кассе
router.get('/barcode/:code', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE barcode = $1', [req.params.code]);
  if (!rows[0]) return res.status(404).json({ error: 'Товар с таким штрихкодом не найден' });
  if (req.user.role !== 'admin') delete rows[0].cost_price;
  res.json(rows[0]);
});

// Создание товара — доступно и кассиру (принять/забить новый товар), и админу.
// Себестоимость может указать только администратор.
// Редактирование и удаление — ниже, только администратор.
router.post('/', async (req, res) => {
  const { name, price, stock, barcode, category, cost_price } = req.body || {};
  if (!name || price === undefined || price === null || Number(price) <= 0) {
    return res.status(400).json({ error: 'Укажите название и корректную цену' });
  }
  try {
    const costPrice = req.user.role === 'admin' ? Number(cost_price) || 0 : 0;
    const { rows } = await pool.query(
      'INSERT INTO products (barcode, name, category, price, cost_price, stock) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [barcode || null, name, category || 'Пиво', price, costPrice, stock || 0]
    );
    const product = rows[0];
    if (req.user.role !== 'admin') delete product.cost_price;
    res.status(201).json(product);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Товар с таким штрихкодом уже существует' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const { name, price, stock, barcode, image_url, category, cost_price } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE products SET
         name = COALESCE($1, name),
         price = COALESCE($2, price),
         stock = COALESCE($3, stock),
         barcode = $4,
         image_url = COALESCE($5, image_url),
         category = COALESCE($6, category),
         cost_price = COALESCE($7, cost_price)
       WHERE id = $8 RETURNING *`,
      [name, price, stock, barcode || null, image_url === undefined ? null : image_url, category || null, cost_price, req.params.id]
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

// Список наценок по категориям — только администратор
router.get('/categories/markups', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT category, markup_percent FROM category_markups');
  res.json(rows);
});

// Задать/изменить наценку для категории (в процентах) — только администратор
router.put('/categories/:name/markup', requireAdmin, async (req, res) => {
  const category = decodeURIComponent(req.params.name);
  const { markup_percent } = req.body || {};
  if (markup_percent === undefined || markup_percent === null || Number.isNaN(Number(markup_percent))) {
    return res.status(400).json({ error: 'Укажите процент наценки' });
  }
  const { rows } = await pool.query(
    `INSERT INTO category_markups (category, markup_percent) VALUES ($1, $2)
     ON CONFLICT (category) DO UPDATE SET markup_percent = $2, updated_at = now()
     RETURNING category, markup_percent`,
    [category, markup_percent]
  );
  res.json(rows[0]);
});

// Применить наценку категории ко всем её товарам: цена = себестоимость * (1 + наценка/100).
// Товары без указанной себестоимости пропускаются. Только администратор
router.post('/categories/:name/apply-markup', requireAdmin, async (req, res) => {
  const category = decodeURIComponent(req.params.name);
  const markupRow = await pool.query('SELECT markup_percent FROM category_markups WHERE category = $1', [category]);
  if (!markupRow.rows[0]) return res.status(400).json({ error: 'Сначала укажите наценку для этой категории' });
  const markup = markupRow.rows[0].markup_percent;
  const { rows } = await pool.query(
    `UPDATE products SET price = ROUND(cost_price * (1 + $2::numeric / 100), 2)
     WHERE category = $1 AND cost_price > 0 RETURNING id`,
    [category, markup]
  );
  const totalRes = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE category = $1', [category]);
  const withoutCost = totalRes.rows[0].c - rows.length;
  res.json({ updated: rows.length, withoutCost, markup_percent: markup });
});

module.exports = router;
