import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/shop.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL, old_price INTEGER, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  image TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, user_id)
);
CREATE TABLE IF NOT EXISTS wishlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS promos (
  code TEXT PRIMARY KEY, percent INTEGER NOT NULL, min_total INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  token TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', delivery TEXT NOT NULL, delivery_cost INTEGER NOT NULL,
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  promo TEXT, status TEXT NOT NULL DEFAULT 'pending', stripe_session TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL
);
`);

// ---- пароли ----
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 64).toString('hex');
}
export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

// ---- транзакции ----
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- начальные данные ----
const adminEmail = (process.env.ADMIN_EMAIL || 'admin@shop.local').toLowerCase();
if (!db.prepare('SELECT 1 FROM users WHERE role = ?').get('admin')) {
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
    .run(adminEmail, 'Администратор', hashPassword(process.env.ADMIN_PASSWORD || 'admin12345'), 'admin');
  console.log(`Создан администратор: ${adminEmail}`);
}

if (!db.prepare('SELECT 1 FROM products LIMIT 1').get()) {
  const cats = ['Электроника', 'Одежда', 'Дом', 'Спорт'];
  const catId = {};
  for (const c of cats) catId[c] = Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(c).lastInsertRowid);
  const demo = [
    ['Беспроводные наушники', 'Электроника', 7990, 9990, 25, 'Bluetooth 5.3, шумоподавление, до 30 часов работы.'],
    ['Умные часы Pro', 'Электроника', 12990, null, 12, 'AMOLED-экран, пульсометр, GPS, защита от воды.'],
    ['Портативная колонка', 'Электроника', 3490, 4290, 40, 'Мощный звук, защита IP67, 12 часов музыки.'],
    ['Механическая клавиатура', 'Электроника', 5890, null, 18, 'Hot-swap переключатели, RGB-подсветка.'],
    ['Худи оверсайз', 'Одежда', 3290, 3990, 30, 'Плотный хлопок, свободный крой, капюшон.'],
    ['Джинсы прямые', 'Одежда', 4190, null, 22, 'Классический синий деним, пять карманов.'],
    ['Куртка демисезонная', 'Одежда', 8990, 11990, 9, 'Лёгкая водоотталкивающая куртка с капюшоном.'],
    ['Настольная лампа', 'Дом', 2190, null, 35, 'Регулировка яркости и температуры света, USB-порт.'],
    ['Плед шерстяной', 'Дом', 2890, 3490, 20, 'Мягкий плед 150×200 см из мериносовой шерсти.'],
    ['Набор кастрюль', 'Дом', 6490, null, 14, 'Нержавеющая сталь, 5 предметов, подходит для индукции.'],
    ['Коврик для йоги', 'Спорт', 1590, null, 50, 'Нескользящий TPE-коврик 6 мм с чехлом.'],
    ['Гантели 2×5 кг', 'Спорт', 2490, 2990, 0, 'Неопреновое покрытие, не скользят в руках.'],
  ];
  const ins = db.prepare('INSERT INTO products (title, description, price, old_price, category_id, image, stock) VALUES (?,?,?,?,?,?,?)');
  demo.forEach(([t, c, p, op, s, d], i) =>
    ins.run(t, d, p * 100, op ? op * 100 : null, catId[c], `https://picsum.photos/seed/shop${i + 1}/700/700`, s));
  const promo = db.prepare('INSERT INTO promos (code, percent, min_total) VALUES (?,?,?)');
  promo.run('WELCOME10', 10, 0);
  promo.run('SALE20', 20, 1000000);
}
