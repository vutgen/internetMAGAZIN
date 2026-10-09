import express from 'express';
import { randomBytes } from 'node:crypto';
import { db, tx, hashPassword, checkPassword } from './db.js';

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CURRENCY = (process.env.CURRENCY || 'rub').toLowerCase();
const SHOP_NAME = process.env.SHOP_NAME || 'МОЙ МАГАЗИН';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_KEY ? (await import('stripe')).default(STRIPE_KEY) : null;

const DELIVERY = {
  pickup: { label: 'Самовывоз', cost: 0, address: false },
  courier: { label: 'Курьер', cost: 30000, address: true },
  post: { label: 'Почта', cost: 20000, address: true },
};
const FREE_DELIVERY_FROM = 500000; // бесплатная доставка от суммы (в копейках)
const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg, status = 400) => new HttpError(status, msg);

const app = express();
app.disable('x-powered-by');

// ---------- Stripe webhook (до json-парсера, нужен raw body) ----------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('webhook off');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Bad signature: ${e.message}`); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.client_reference_id) markPaid(Number(s.client_reference_id));
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

// ---------- заголовки безопасности ----------
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});

// ---------- сессии ----------
const SESSION_MS = 30 * 24 * 3600 * 1000;
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

app.use((req, res, next) => {
  const sid = parseCookies(req.headers.cookie).sid;
  req.user = null;
  if (sid) {
    req.user = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires > ?`).get(sid, Date.now()) || null;
  }
  next();
});
function login(res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)').run(token, userId, Date.now() + SESSION_MS);
  const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
  res.set('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}
const needUser = (req) => { if (!req.user) throw bad('Требуется вход', 401); return req.user; };
const needAdmin = (req) => { if (needUser(req).role !== 'admin') throw bad('Доступ запрещён', 403); };

// простая защита от перебора пароля
const attempts = new Map();
function throttle(key, max = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw bad('Слишком много попыток, попробуйте позже', 429);
  arr.push(now); attempts.set(key, arr);
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const imageOk = (u) => u === '' || /^(https?:\/\/|\/)/i.test(u);

// ---------- публичная конфигурация ----------
app.get('/api/config', (req, res) => {
  res.json({
    shopName: SHOP_NAME, currency: CURRENCY, demoPayments: !stripe, delivery: DELIVERY,
    freeDeliveryFrom: FREE_DELIVERY_FROM, user: req.user,
  });
});

// ---------- авторизация ----------
app.post('/api/auth/register', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase(), name = str(req.body.name, 100), pw = String(req.body.password || '');
  if (!emailOk(email)) throw bad('Некорректный email');
  if (!name) throw bad('Укажите имя');
  if (pw.length < 8) throw bad('Пароль — минимум 8 символов');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Этот email уже зарегистрирован', 409);
  const id = Number(db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)').run(email, name, hashPassword(pw)).lastInsertRowid);
  // привязать прошлые гостевые заказы с этим email
  db.prepare('UPDATE orders SET user_id = ? WHERE email = ? AND user_id IS NULL').run(id, email);
  login(res, id);
  res.json({ user: { id, email, name, role: 'customer' } });
});

app.post('/api/auth/login', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  throttle(`${req.ip}:${email}`);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !checkPassword(String(req.body.password || ''), u.password_hash)) throw bad('Неверный email или пароль', 401);
  login(res, u.id);
  res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
  res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- каталог ----------
app.get('/api/categories', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS count
    FROM categories c ORDER BY c.name`).all());
});

const PRODUCT_SELECT = `SELECT p.id, p.title, p.description, p.price, p.old_price, p.category_id, p.image, p.stock, p.active,
  c.name AS category, (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.product_id = p.id) AS rating,
  (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS reviews
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

app.get('/api/products', (req, res) => {
  const where = ['p.active = 1'], args = [];
  const q = str(req.query.q, 100);
  if (q) { where.push('(p.title LIKE ? OR p.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (req.query.category) { where.push('p.category_id = ?'); args.push(Number(req.query.category)); }
  if (req.query.min) { where.push('p.price >= ?'); args.push(Math.round(Number(req.query.min) * 100) || 0); }
  if (req.query.max) { where.push('p.price <= ?'); args.push(Math.round(Number(req.query.max) * 100) || 0); }
  if (req.query.inStock === '1') where.push('p.stock > 0');
  const order = { new: 'p.id DESC', cheap: 'p.price ASC', expensive: 'p.price DESC', rating: 'rating DESC NULLS LAST' }[req.query.sort] || 'p.id DESC';
  const limit = 12, page = Math.max(1, Number(req.query.page) || 1);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${w}`).get(...args).n;
  const items = db.prepare(`${PRODUCT_SELECT} WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
  res.json({ items, total, pages: Math.max(1, Math.ceil(total / limit)), page });
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1`).get(Number(req.params.id));
  if (!p) throw bad('Товар не найден', 404);
  const reviews = db.prepare(`SELECT r.id, r.rating, r.text, r.created_at, u.name FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ? ORDER BY r.id DESC`).all(p.id);
  res.json({ ...p, reviewList: reviews });
});

app.post('/api/products/:id/reviews', (req, res) => {
  const u = needUser(req);
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Оценка от 1 до 5');
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(Number(req.params.id))) throw bad('Товар не найден', 404);
  db.prepare(`INSERT INTO reviews (product_id, user_id, rating, text) VALUES (?,?,?,?)
    ON CONFLICT(product_id, user_id) DO UPDATE SET rating = excluded.rating, text = excluded.text`)
    .run(Number(req.params.id), u.id, rating, str(req.body.text, 2000));
  res.json({ ok: true });
});

// ---------- избранное ----------
app.get('/api/wishlist', (req, res) => {
  const u = needUser(req);
  res.json(db.prepare(`${PRODUCT_SELECT} JOIN wishlist w ON w.product_id = p.id WHERE w.user_id = ? AND p.active = 1`).all(u.id));
});
app.put('/api/wishlist/:id', (req, res) => {
  const u = needUser(req);
  db.prepare('INSERT OR IGNORE INTO wishlist (user_id, product_id) VALUES (?,?)').run(u.id, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/wishlist/:id', (req, res) => {
  db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?').run(needUser(req).id, Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/wishlist/ids', (req, res) => {
  res.json(req.user ? db.prepare('SELECT product_id FROM wishlist WHERE user_id = ?').all(req.user.id).map(r => r.product_id) : []);
});

// ---------- расчёт корзины (цены всегда берутся с сервера) ----------
function priceCart(rawItems, promoCode, deliveryKey) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw bad('Корзина пуста');
  const merged = new Map();
  for (const it of rawItems) {
    const id = Number(it.id), qty = Math.floor(Number(it.qty));
    if (!id || !(qty > 0)) continue;
    merged.set(id, Math.min(99, (merged.get(id) || 0) + qty));
  }
  const lines = [], problems = [];
  for (const [id, qty] of merged) {
    const p = db.prepare('SELECT id, title, price, image, stock, active FROM products WHERE id = ?').get(id);
    if (!p || !p.active) { problems.push(`Товар #${id} больше недоступен`); continue; }
    if (p.stock < qty) { problems.push(`«${p.title}»: в наличии только ${p.stock} шт.`); continue; }
    lines.push({ id: p.id, title: p.title, image: p.image, price: p.price, qty, sum: p.price * qty });
  }
  const subtotal = lines.reduce((s, l) => s + l.sum, 0);
  let discount = 0, promo = null, promoError = null;
  if (promoCode) {
    const pr = db.prepare('SELECT * FROM promos WHERE code = ? AND active = 1').get(str(promoCode, 40).toUpperCase());
    if (!pr) promoError = 'Промокод не найден';
    else if (subtotal < pr.min_total) promoError = `Промокод действует от ${pr.min_total / 100} ${CURRENCY.toUpperCase()}`;
    else { promo = pr.code; discount = Math.round(subtotal * pr.percent / 100); }
  }
  const d = DELIVERY[deliveryKey] || DELIVERY.pickup;
  const deliveryCost = subtotal - discount >= FREE_DELIVERY_FROM ? 0 : d.cost;
  return { lines, subtotal, discount, promo, promoError, deliveryCost, total: subtotal - discount + deliveryCost, problems };
}

app.post('/api/cart/price', (req, res) => {
  try { res.json(priceCart(req.body.items, req.body.promo, req.body.delivery)); }
  catch (e) { if (e.message === 'Корзина пуста') return res.json({ lines: [], subtotal: 0, discount: 0, deliveryCost: 0, total: 0, problems: [] }); throw e; }
});

// ---------- оформление заказа и оплата ----------
function notify(order, text) { console.log(`[email → ${order.email}] Заказ #${order.id}: ${text}`); }

function markPaid(orderId) {
  tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o || o.status !== 'pending') return;
    for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId))
      if (it.product_id) db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(it.qty, it.product_id);
    db.prepare("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
    notify(o, 'оплачен, спасибо за покупку!');
  });
}

app.post('/api/checkout', async (req, res) => {
  const b = req.body;
  const email = str(b.email, 200).toLowerCase(), name = str(b.name, 100), phone = str(b.phone, 40), address = str(b.address, 300);
  if (!emailOk(email)) throw bad('Некорректный email');
  if (!name) throw bad('Укажите имя');
  const dKey = DELIVERY[b.delivery] ? b.delivery : null;
  if (!dKey) throw bad('Выберите способ доставки');
  if (DELIVERY[dKey].address && !address) throw bad('Укажите адрес доставки');
  const c = priceCart(b.items, b.promo, dKey);
  if (c.problems.length) throw bad(c.problems.join('; '), 409);
  if (!c.lines.length) throw bad('Корзина пуста');
  if (b.promo && c.promoError) throw bad(c.promoError);

  const token = randomBytes(16).toString('hex');
  const orderId = tx(() => {
    const id = Number(db.prepare(`INSERT INTO orders (user_id, token, email, name, phone, address, delivery, delivery_cost, subtotal, discount, total, promo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user?.id ?? null, token, email, name, phone, address, dKey, c.deliveryCost, c.subtotal, c.discount, c.total, c.promo).lastInsertRowid);
    for (const l of c.lines) db.prepare('INSERT INTO order_items (order_id, product_id, title, price, qty) VALUES (?,?,?,?,?)').run(id, l.id, l.title, l.price, l.qty);
    return id;
  });
  const orderUrl = `${BASE_URL}/#/order/${orderId}?t=${token}`;

  if (!stripe) return res.json({ orderId, token, url: `${BASE_URL}/#/pay/${orderId}?t=${token}` });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment', customer_email: email, client_reference_id: String(orderId),
    line_items: [
      ...c.lines.map(l => ({ quantity: l.qty, price_data: { currency: CURRENCY, unit_amount: l.price, product_data: { name: l.title } } })),
    ].concat(c.deliveryCost ? [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: c.deliveryCost, product_data: { name: 'Доставка' } } }] : []),
    // скидка передаётся через разовый купон
    ...(c.discount ? { discounts: [{ coupon: (await stripe.coupons.create({ amount_off: c.discount, currency: CURRENCY, duration: 'once' })).id }] } : {}),
    success_url: orderUrl, cancel_url: `${BASE_URL}/#/cart`,
  });
  db.prepare('UPDATE orders SET stripe_session = ? WHERE id = ?').run(session.id, orderId);
  res.json({ orderId, token, url: session.url });
});

function loadOrder(id, token, user) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  if (!o) throw bad('Заказ не найден', 404);
  const allowed = (token && token === o.token) || (user && (user.role === 'admin' || user.id === o.user_id));
  if (!allowed) throw bad('Заказ не найден', 404);
  return o;
}
const withItems = (o) => ({ ...o, token: undefined, stripe_session: undefined,
  items: db.prepare('SELECT product_id, title, price, qty FROM order_items WHERE order_id = ?').all(o.id) });

app.get('/api/orders/:id', async (req, res) => {
  let o = loadOrder(req.params.id, req.query.t, req.user);
  // если вебхук не настроен — проверяем оплату при возврате со Stripe
  if (o.status === 'pending' && stripe && o.stripe_session) {
    const s = await stripe.checkout.sessions.retrieve(o.stripe_session);
    if (s.payment_status === 'paid') { markPaid(o.id); o = loadOrder(o.id, o.token); }
  }
  res.json(withItems(o));
});

// демо-оплата (только когда Stripe не подключён)
app.post('/api/orders/:id/demo-pay', (req, res) => {
  if (stripe) throw bad('Демо-оплата отключена', 403);
  const o = loadOrder(req.params.id, req.body.t, req.user);
  const card = String(req.body.card || '').replace(/\s/g, '');
  if (card !== '4242424242424242') throw bad('Карта отклонена. В демо-режиме используйте 4242 4242 4242 4242');
  markPaid(o.id);
  res.json({ ok: true });
});

app.get('/api/my/orders', (req, res) => {
  const u = needUser(req);
  res.json(db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(u.id).map(withItems));
});

// ---------- админка ----------
app.get('/api/admin/stats', (req, res) => {
  needAdmin(req);
  const one = (sql) => db.prepare(sql).get();
  res.json({
    revenue: one("SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE status IN ('paid','shipped','delivered')").v,
    orders: one('SELECT COUNT(*) AS v FROM orders').v,
    paid: one("SELECT COUNT(*) AS v FROM orders WHERE status IN ('paid','shipped','delivered')").v,
    customers: one("SELECT COUNT(*) AS v FROM users WHERE role = 'customer'").v,
    lowStock: db.prepare('SELECT id, title, stock FROM products WHERE active = 1 AND stock <= 5 ORDER BY stock').all(),
  });
});

app.get('/api/admin/products', (req, res) => { needAdmin(req); res.json(db.prepare(`${PRODUCT_SELECT} ORDER BY p.id DESC`).all()); });

function productFields(b) {
  const title = str(b.title, 200), price = Math.round(Number(b.price) * 100), stock = Math.floor(Number(b.stock));
  const oldPrice = b.old_price ? Math.round(Number(b.old_price) * 100) : null;
  const image = str(b.image, 500);
  if (!title) throw bad('Укажите название');
  if (!(price > 0)) throw bad('Некорректная цена');
  if (!(stock >= 0)) throw bad('Некорректный остаток');
  if (!imageOk(image)) throw bad('Ссылка на картинку должна начинаться с http(s):// или /');
  return [title, str(b.description, 5000), price, oldPrice, b.category_id ? Number(b.category_id) : null, image, stock, b.active === false || b.active === 0 ? 0 : 1];
}
app.post('/api/admin/products', (req, res) => {
  needAdmin(req);
  const r = db.prepare('INSERT INTO products (title, description, price, old_price, category_id, image, stock, active) VALUES (?,?,?,?,?,?,?,?)').run(...productFields(req.body));
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/products/:id', (req, res) => {
  needAdmin(req);
  db.prepare('UPDATE products SET title=?, description=?, price=?, old_price=?, category_id=?, image=?, stock=?, active=? WHERE id=?').run(...productFields(req.body), Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/admin/products/:id', (req, res) => {
  needAdmin(req);
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/categories', (req, res) => {
  needAdmin(req);
  const name = str(req.body.name, 60);
  if (!name) throw bad('Укажите название');
  try { db.prepare('INSERT INTO categories (name) VALUES (?)').run(name); } catch { throw bad('Такая категория уже есть', 409); }
  res.json({ ok: true });
});
app.delete('/api/admin/categories/:id', (req, res) => {
  needAdmin(req);
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/orders', (req, res) => {
  needAdmin(req);
  res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all().map(withItems));
});
app.put('/api/admin/orders/:id', (req, res) => {
  needAdmin(req);
  const status = req.body.status;
  if (!STATUSES.includes(status)) throw bad('Неверный статус');
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!o) throw bad('Заказ не найден', 404);
  tx(() => {
    // отмена оплаченного заказа возвращает товар на склад
    if (status === 'cancelled' && o.paid_at && o.status !== 'cancelled')
      for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(o.id))
        if (it.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.qty, it.product_id);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, o.id);
  });
  notify(o, `статус изменён на «${status}»`);
  res.json({ ok: true });
});

app.get('/api/admin/promos', (req, res) => { needAdmin(req); res.json(db.prepare('SELECT * FROM promos ORDER BY code').all()); });
app.post('/api/admin/promos', (req, res) => {
  needAdmin(req);
  const code = str(req.body.code, 40).toUpperCase(), percent = Math.floor(Number(req.body.percent)), min = Math.round(Number(req.body.min_total || 0) * 100);
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw bad('Код: 3–40 символов, латиница/цифры');
  if (!(percent >= 1 && percent <= 90)) throw bad('Скидка от 1 до 90%');
  db.prepare('INSERT OR REPLACE INTO promos (code, percent, min_total, active) VALUES (?,?,?,1)').run(code, percent, min >= 0 ? min : 0);
  res.json({ ok: true });
});
app.delete('/api/admin/promos/:code', (req, res) => {
  needAdmin(req);
  db.prepare('DELETE FROM promos WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ---------- ошибки ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, req, res, next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`${SHOP_NAME}: ${BASE_URL}`);
  console.log(stripe ? 'Оплата: Stripe' : 'Оплата: ДЕМО-режим (задайте STRIPE_SECRET_KEY для реальных платежей)');
});
