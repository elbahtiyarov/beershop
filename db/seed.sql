-- Начальные данные. Пароли уже захешированы (bcrypt).
-- admin / admin123
-- kassir / kassir123
-- ОБЯЗАТЕЛЬНО смените эти пароли после первого входа (раздел «Пользователи»).

INSERT INTO users (username, password_hash, name, role) VALUES
  ('admin',  '$2b$10$2fxCZMtFkznuDneFjhEfROYxnMrYJF.dXgyH7X/2eOOQn5ClRmfS2', 'Администратор', 'admin'),
  ('kassir', '$2b$10$imcA54oyxRU8l.pEI5LayO7ZvM9xmjINIYEOjBjicOE4nR3uDHpvC', 'Кассир', 'cashier')
ON CONFLICT (username) DO NOTHING;

INSERT INTO products (barcode, name, category, price, stock) VALUES
  ('4870000001011', 'Жигулёвское, 0.5л',      'Светлое',        450,  48),
  ('4870000001028', 'Балтика 7, 0.5л',        'Светлое',        520,  36),
  ('4870000001035', 'Крафтовый IPA, 0.5л',    'Крафтовое',      1200, 20),
  ('4870000001042', 'Тёмный портер, 0.5л',    'Тёмное',         980,  15),
  ('4870000001059', 'Разливное светлое, 1л',  'Разливное',      1500, 10),
  ('4870000001066', 'Безалкогольное, 0.5л',   'Безалкогольное', 400,  24)
ON CONFLICT (barcode) DO NOTHING;
