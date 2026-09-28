require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const receiptRoutes = require('./routes/receipts');
const userRoutes = require('./routes/users');
const analyticsRoutes = require('./routes/analytics');
const supplierRoutes = require('./routes/suppliers');
const stockRoutes = require('./routes/stock');
const shiftRoutes = require('./routes/shifts');

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error('Не заданы DATABASE_URL и/или JWT_SECRET. Скопируйте .env.example в .env и заполните значения.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/users', userRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/shifts', shiftRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Хмель — сервер запущен на http://localhost:${PORT}`);
});
