-- Схема базы данных для учёта пивного магазина

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'cashier')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  barcode VARCHAR(64) UNIQUE,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Пиво',
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  cost_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  stock NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  unit VARCHAR(10) NOT NULL DEFAULT 'шт',
  volume_liters NUMERIC(6,2),
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- На случай, если таблица создавалась раньше без этих колонок
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'Пиво';
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(10) NOT NULL DEFAULT 'шт';
ALTER TABLE products ADD COLUMN IF NOT EXISTS volume_liters NUMERIC(6,2);
-- Остаток разливного считается в литрах (дробное число) — расширяем тип столбца
ALTER TABLE products ALTER COLUMN stock TYPE NUMERIC(10,2) USING stock::numeric;
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- Наценка по категориям (в процентах). Цена = себестоимость * (1 + наценка/100)
CREATE TABLE IF NOT EXISTS category_markups (
  category VARCHAR(100) PRIMARY KEY,
  markup_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  cashier_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cashier_name VARCHAR(100) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
  cash_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  qr_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  received_amount NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
-- На случай, если таблица создавалась раньше без этих колонок
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS cash_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qr_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS received_amount NUMERIC(10,2);
CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_cashier ON receipts(cashier_id);
CREATE INDEX IF NOT EXISTS idx_receipts_deleted_at ON receipts(deleted_at);

CREATE TABLE IF NOT EXISTS receipt_items (
  id SERIAL PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(200) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL CHECK (qty > 0),
  subtotal NUMERIC(10,2) NOT NULL
);
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON receipt_items(receipt_id);

-- ================= СКЛАД =================
-- Поставщики
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(50),
  bin VARCHAR(20),
  contact_person VARCHAR(100),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Таблица могла остаться от старой версии — добавляем недостающие колонки
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS name VARCHAR(200);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bin VARCHAR(20);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_person VARCHAR(100);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(LOWER(name));

-- Приходные накладные (поступление товара на склад)
CREATE TABLE IF NOT EXISTS stock_receipts (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name VARCHAR(200),
  doc_number VARCHAR(100),
  note TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(200);
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS doc_number VARCHAR(100);
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS user_name VARCHAR(100);
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_stock_receipts_created_at ON stock_receipts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_supplier ON stock_receipts(supplier_id);

CREATE TABLE IF NOT EXISTS stock_receipt_items (
  id SERIAL PRIMARY KEY,
  stock_receipt_id INTEGER NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(200) NOT NULL,
  barcode VARCHAR(64),
  unit VARCHAR(10) NOT NULL DEFAULT 'шт',
  qty NUMERIC(10,2) NOT NULL CHECK (qty > 0),
  cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0
);
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS stock_receipt_id INTEGER REFERENCES stock_receipts(id) ON DELETE CASCADE;
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS product_name VARCHAR(200);
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(64);
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS unit VARCHAR(10) NOT NULL DEFAULT 'шт';
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS qty NUMERIC(10,2);
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) NOT NULL DEFAULT 0;
-- Дробное количество для разливного
ALTER TABLE stock_receipt_items ALTER COLUMN qty TYPE NUMERIC(10,2) USING qty::numeric;
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_receipt ON stock_receipt_items(stock_receipt_id);

-- Возвраты поставщику (истёк срок, потерял вид, брак). Забирает представитель поставщика по доверенности.
CREATE TABLE IF NOT EXISTS supplier_returns (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name VARCHAR(200),
  poa_number VARCHAR(100),
  poa_date DATE,
  representative_name VARCHAR(150),
  representative_iin VARCHAR(20),
  note TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Таблица могла остаться от старой версии — добавляем недостающие колонки
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(200);
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS poa_number VARCHAR(100);
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS poa_date DATE;
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS representative_name VARCHAR(150);
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS representative_iin VARCHAR(20);
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS user_name VARCHAR(100);
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_supplier_returns_created_at ON supplier_returns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_supplier ON supplier_returns(supplier_id);

CREATE TABLE IF NOT EXISTS supplier_return_items (
  id SERIAL PRIMARY KEY,
  supplier_return_id INTEGER REFERENCES supplier_returns(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(200),
  barcode VARCHAR(64),
  unit VARCHAR(10) NOT NULL DEFAULT 'шт',
  qty NUMERIC(10,2),
  cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason VARCHAR(30) NOT NULL DEFAULT 'expired'
);
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS supplier_return_id INTEGER REFERENCES supplier_returns(id) ON DELETE CASCADE;
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS product_name VARCHAR(200);
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(64);
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS unit VARCHAR(10) NOT NULL DEFAULT 'шт';
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS qty NUMERIC(10,2);
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS reason VARCHAR(30) NOT NULL DEFAULT 'expired';
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return ON supplier_return_items(supplier_return_id);

-- Старые версии таблиц склада могли содержать свои обязательные колонки,
-- которые новый код не заполняет, — снимаем с них NOT NULL, чтобы приход проводился.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND is_nullable = 'NO' AND column_default IS NULL
       AND (table_name, column_name) NOT IN (
         ('suppliers','id'), ('stock_receipts','id'), ('stock_receipt_items','id'),
         ('suppliers','name'), ('stock_receipts','user_name'),
         ('stock_receipt_items','stock_receipt_id'), ('stock_receipt_items','product_name'), ('stock_receipt_items','qty'))
       AND table_name IN ('suppliers', 'stock_receipts', 'stock_receipt_items', 'supplier_returns', 'supplier_return_items')
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', r.table_name, r.column_name);
  END LOOP;
END $$;

-- Триггер для updated_at у товаров
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
