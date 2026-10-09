// ---------- утилиты ----------
class Raw { constructor(v) { this.v = v; } }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const part = (v) => v instanceof Raw ? v.v : Array.isArray(v) ? v.map(part).join('') : esc(v);
const html = (s, ...v) => new Raw(s.reduce((a, str, i) => a + str + (i < v.length ? part(v[i]) : ''), ''));
const $ = (sel, root = document) => root.querySelector(sel);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
let cfg = { currency: 'rub', delivery: {}, user: null };
const money = (kop) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cfg.currency.toUpperCase(), maximumFractionDigits: 0 }).format(kop / 100);
const stars = (r) => '★'.repeat(Math.round(r || 0)) + '☆'.repeat(5 - Math.round(r || 0));
const fmtDate = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = { pending: 'Ожидает оплаты', paid: 'Оплачен', shipped: 'Отправлен', delivered: 'Доставлен', cancelled: 'Отменён' };
const FALLBACK = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='400' height='400' fill='%23ddd'/><text x='200' y='210' font-size='20' text-anchor='middle' fill='%23888'>Нет фото</text></svg>";
const img = (src, cls = '') => html`<img class="${cls}" src="${src || FALLBACK}" alt="" loading="lazy" onerror="this.onerror=null;this.src=this.dataset.f" data-f="${FALLBACK}">`;

// ---------- корзина (localStorage) ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
let cart = store.get('cart', []);
const cartCount = () => cart.reduce((s, i) => s + i.qty, 0);
function saveCart() { store.set('cart', cart); renderNav(); }
function addToCart(id, qty = 1) {
  const it = cart.find(i => i.id === id);
  if (it) it.qty = Math.min(99, it.qty + qty); else cart.push({ id, qty });
  saveCart(); toast('Добавлено в корзину');
}
let wish = new Set();
async function loadWish() { wish = new Set(cfg.user ? await api('/wishlist/ids') : []); }

// ---------- шапка ----------
function renderNav() {
  const u = cfg.user;
  $('#nav').innerHTML = html`
    ${u?.role === 'admin' ? html`<a href="#/admin">Админка</a>` : ''}
    ${u ? html`<a href="#/wishlist">Избранное</a><a href="#/orders">Заказы</a><button data-act="logout" title="${u.email}">Выйти</button>`
        : html`<a href="#/login">Войти</a>`}
    <a href="#/cart">Корзина${cartCount() ? html`<span class="badge">${cartCount()}</span>` : ''}</a>`.v;
}

// ---------- роутер ----------
const app = $('#app');
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
const view = (r) => { app.innerHTML = r.v; window.scrollTo(0, 0); };
const loading = () => { app.innerHTML = '<p class="muted">Загрузка…</p>'; };

async function render() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try { await fn(m, query); }
      catch (e) { view(html`<div class="empty"><h2>Ошибка</h2><p>${e.message}</p><a class="btn" href="#/">На главную</a></div>`); }
      return;
    }
  }
  view(html`<div class="empty"><h2>Страница не найдена</h2><a class="btn" href="#/">На главную</a></div>`);
}
window.addEventListener('hashchange', render);

// ---------- каталог ----------
const filter = { q: '', category: '', sort: 'new', min: '', max: '', inStock: '', page: 1 };

function productCard(p) {
  return html`<article class="pcard">
    <a href="#/product/${p.id}">${img(p.image)}</a>
    ${p.stock <= 0 ? html`<span class="tag out">Нет в наличии</span>` : p.old_price ? html`<span class="tag">−${Math.round((1 - p.price / p.old_price) * 100)}%</span>` : ''}
    <button class="heart ${wish.has(p.id) ? 'on' : ''}" data-act="wish" data-id="${p.id}" aria-label="В избранное">♥</button>
    <div class="body">
      <a class="title" href="#/product/${p.id}">${p.title}</a>
      ${p.reviews ? html`<div class="muted"><span class="stars">${stars(p.rating)}</span> ${p.rating} (${p.reviews})</div>` : ''}
      <div class="price">${money(p.price)}${p.old_price ? html`<span class="old">${money(p.old_price)}</span>` : ''}</div>
      <button class="btn sm" data-act="add" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>В корзину</button>
    </div>
  </article>`;
}

route(/^\/$/, async () => {
  loading();
  const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== '' && v !== null));
  const [cats, data] = await Promise.all([api('/categories'), api('/products?' + params)]);
  view(html`
    <h1>${filter.q ? `Поиск: «${filter.q}»` : 'Каталог'}</h1>
    <div class="layout">
      <aside class="filters"><form class="card" data-form="filters">
        <label>Категории</label>
        <div class="cats">
          <a href="#/" data-act="cat" data-id="" class="${filter.category === '' ? 'on' : ''}"><span>Все</span></a>
          ${cats.map(c => html`<a href="#/" data-act="cat" data-id="${c.id}" class="${String(filter.category) === String(c.id) ? 'on' : ''}"><span>${c.name}</span><span>${c.count}</span></a>`)}
        </div>
        <label>Цена от</label><input name="min" type="number" min="0" value="${filter.min}">
        <label>Цена до</label><input name="max" type="number" min="0" value="${filter.max}">
        <label class="row"><input type="checkbox" name="inStock" style="width:auto" ${filter.inStock ? 'checked' : ''}> Только в наличии</label>
        <button class="btn block" style="margin-top:12px">Применить</button>
      </form></aside>
      <section>
        <div class="toolbar">
          <span class="muted">Найдено: ${data.total}</span>
          <select data-act="sort" style="margin-left:auto" aria-label="Сортировка">
            ${[['new', 'Новинки'], ['cheap', 'Сначала дешёвые'], ['expensive', 'Сначала дорогие'], ['rating', 'По рейтингу']]
              .map(([v, l]) => html`<option value="${v}" ${filter.sort === v ? 'selected' : ''}>${l}</option>`)}
          </select>
        </div>
        ${data.items.length ? html`<div class="grid">${data.items.map(productCard)}</div>` : html`<div class="empty">Ничего не найдено</div>`}
        ${data.pages > 1 ? html`<div class="pager">${Array.from({ length: data.pages }, (_, i) =>
          html`<button class="btn sm ${data.page === i + 1 ? '' : 'ghost'}" data-act="page" data-id="${i + 1}">${i + 1}</button>`)}</div>` : ''}
      </section>
    </div>`);
});

// ---------- страница товара ----------
route(/^\/product\/(\d+)$/, async ([, id]) => {
  loading();
  const p = await api('/products/' + id);
  const mine = cfg.user && p.reviewList.find(r => r.name === cfg.user.name);
  view(html`
    <p><a href="#/" class="muted">← В каталог</a></p>
    <div class="product">
      ${img(p.image, 'big')}
      <div>
        <h1>${p.title}</h1>
        ${p.category ? html`<p class="muted">${p.category}</p>` : ''}
        ${p.reviews ? html`<p><span class="stars">${stars(p.rating)}</span> ${p.rating} · ${p.reviews} отзывов</p>` : ''}
        <p class="price" style="font-size:28px">${money(p.price)}${p.old_price ? html`<span class="old">${money(p.old_price)}</span>` : ''}</p>
        <p>${p.stock > 0 ? html`<span class="ok">В наличии: ${p.stock} шт.</span>` : html`<span class="err">Нет в наличии</span>`}</p>
        <p style="white-space:pre-line">${p.description}</p>
        <div class="row">
          <button class="btn" data-act="add" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>В корзину</button>
          <button class="btn ghost" data-act="buy" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>Купить сейчас</button>
          <button class="heart ${wish.has(p.id) ? 'on' : ''}" style="position:static" data-act="wish" data-id="${p.id}" aria-label="В избранное">♥</button>
        </div>
      </div>
    </div>
    <h2>Отзывы</h2>
    ${cfg.user ? html`<form class="card" data-form="review" data-id="${p.id}" style="margin-bottom:16px">
      <label style="margin-top:0">Ваша оценка</label>
      <select name="rating">${[5, 4, 3, 2, 1].map(n => html`<option value="${n}">${n} — ${'★'.repeat(n)}</option>`)}</select>
      <label>Комментарий</label><textarea name="text" rows="3" maxlength="2000"></textarea>
      <div class="err" id="formErr"></div>
      <button class="btn">${mine ? 'Обновить отзыв' : 'Оставить отзыв'}</button>
    </form>` : html`<p class="muted"><a href="#/login" style="text-decoration:underline">Войдите</a>, чтобы оставить отзыв.</p>`}
    ${p.reviewList.length ? p.reviewList.map(r => html`<div class="review">
      <b>${r.name}</b> <span class="stars">${stars(r.rating)}</span> <span class="muted">${fmtDate(r.created_at)}</span>
      <div style="white-space:pre-line">${r.text}</div></div>`) : html`<p class="muted">Пока нет отзывов.</p>`}`);
});

// ---------- корзина ----------
let promoCode = store.get('promo', '');
let deliveryKey = store.get('delivery', 'courier');

async function priceNow() {
  return api('/cart/price', { method: 'POST', body: { items: cart, promo: promoCode, delivery: deliveryKey } });
}
function summary(c) {
  return html`
    <div class="sum"><span>Товары</span><span>${money(c.subtotal)}</span></div>
    ${c.discount ? html`<div class="sum ok"><span>Скидка (${c.promo})</span><span>−${money(c.discount)}</span></div>` : ''}
    <div class="sum"><span>Доставка</span><span>${c.deliveryCost ? money(c.deliveryCost) : 'Бесплатно'}</span></div>
    <div class="sum total"><span>Итого</span><span>${money(c.total)}</span></div>`;
}

route(/^\/cart$/, async () => {
  if (!cart.length) return view(html`<div class="empty"><h2>Корзина пуста</h2><a class="btn" href="#/">Перейти в каталог</a></div>`);
  const c = await priceNow();
  // синхронизируем корзину с сервером (удалены/нет в наличии)
  const ids = new Set(c.lines.map(l => l.id));
  view(html`
    <h1>Корзина</h1>
    ${c.problems.length ? html`<div class="notice">${c.problems.join('. ')}</div>` : ''}
    <div class="two">
      <div class="card">
        ${cart.map(it => {
          const l = c.lines.find(x => x.id === it.id);
          return l ? html`<div class="cart-line">
            <a href="#/product/${l.id}">${img(l.image)}</a>
            <a href="#/product/${l.id}"><b>${l.title}</b><div class="muted">${money(l.price)}</div></a>
            <div class="qty"><button data-act="dec" data-id="${l.id}" aria-label="Меньше">−</button><span>${it.qty}</span><button data-act="inc" data-id="${l.id}" aria-label="Больше">+</button></div>
            <b>${money(l.sum)}</b>
            <button class="btn ghost sm" data-act="remove" data-id="${l.id}" aria-label="Удалить">✕</button>
          </div>` : html`<div class="cart-line"><span></span><span class="err">Товар #${it.id} недоступен или закончился</span><span></span><span></span>
            <button class="btn ghost sm" data-act="remove" data-id="${it.id}">✕</button></div>`;
        })}
      </div>
      <div class="card">
        <form data-form="promo" class="row"><input name="code" placeholder="Промокод" value="${promoCode}" style="flex:1;min-width:0"><button class="btn ghost">OK</button></form>
        ${c.promoError ? html`<div class="err">${c.promoError}</div>` : ''}
        <div style="margin-top:12px">${summary(c)}</div>
        <a class="btn block" style="margin-top:12px" href="#/checkout" ${ids.size ? '' : 'hidden'}>Оформить заказ</a>
        <p class="muted" style="font-size:13px">Бесплатная доставка от ${money(cfg.freeDeliveryFrom)}</p>
      </div>
    </div>`);
});

// ---------- оформление ----------
route(/^\/checkout$/, async () => {
  if (!cart.length) return (location.hash = '#/cart');
  const c = await priceNow();
  if (c.problems.length || !c.lines.length) return (location.hash = '#/cart');
  const u = cfg.user;
  view(html`
    <h1>Оформление заказа</h1>
    ${cfg.demoPayments ? html`<div class="notice">Демо-режим оплаты: Stripe не подключён. Тестовая карта 4242 4242 4242 4242.</div>` : ''}
    <div class="two">
      <form class="card" data-form="checkout">
        <h2 style="margin-top:0">Контакты</h2>
        <label>Имя</label><input name="name" required value="${u?.name || ''}" autocomplete="name">
        <label>Email</label><input name="email" type="email" required value="${u?.email || ''}" autocomplete="email">
        <label>Телефон</label><input name="phone" type="tel" autocomplete="tel">
        <h2>Доставка</h2>
        ${Object.entries(cfg.delivery).map(([k, d]) => html`<label class="radio ${deliveryKey === k ? 'sel' : ''}" style="color:var(--text);font-size:16px">
          <input type="radio" name="delivery" value="${k}" ${deliveryKey === k ? 'checked' : ''}>
          <span style="flex:1">${d.label}</span><span>${d.cost ? money(d.cost) : 'Бесплатно'}</span></label>`)}
        <div id="addrBox" ${cfg.delivery[deliveryKey]?.address ? '' : 'hidden'}>
          <label>Адрес доставки</label><textarea name="address" rows="2" autocomplete="street-address"></textarea>
        </div>
        <div class="err" id="formErr"></div>
        <button class="btn block" style="margin-top:16px">Перейти к оплате · ${money(c.total)}</button>
      </form>
      <div class="card"><h2 style="margin-top:0">Ваш заказ</h2>
        ${c.lines.map(l => html`<div class="sum"><span>${l.title} × ${l.qty}</span><span>${money(l.sum)}</span></div>`)}
        <div style="margin-top:8px">${summary(c)}</div></div>
    </div>`);
});

// ---------- демо-оплата ----------
route(/^\/pay\/(\d+)$/, async ([, id], q) => {
  const o = await api(`/orders/${id}?t=${encodeURIComponent(q.t || '')}`);
  if (o.status !== 'pending') return (location.hash = `#/order/${id}?t=${q.t || ''}`);
  view(html`<div class="narrow card">
    <h1>Оплата заказа №${o.id}</h1>
    <p class="price">${money(o.total)}</p>
    <div class="notice">Демо-режим. Используйте карту 4242 4242 4242 4242, любой срок и CVC.</div>
    <form data-form="pay" data-id="${o.id}" data-t="${q.t || ''}">
      <label style="margin-top:0">Номер карты</label><input name="card" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" required>
      <div class="row"><div style="flex:1"><label>Срок</label><input placeholder="12/30" autocomplete="cc-exp" required></div>
      <div style="flex:1"><label>CVC</label><input placeholder="123" autocomplete="cc-csc" required></div></div>
      <div class="err" id="formErr"></div>
      <button class="btn block" style="margin-top:16px">Оплатить ${money(o.total)}</button>
    </form></div>`);
});

function orderBlock(o) {
  return html`<div class="card" style="margin-bottom:16px">
    <div class="row between"><b>Заказ №${o.id}</b><span class="status ${o.status}">${STATUS[o.status]}</span></div>
    <div class="muted">${fmtDate(o.created_at)}</div>
    <table style="margin:10px 0"><tbody>${o.items.map(i => html`<tr><td>${i.title}</td><td>${i.qty} × ${money(i.price)}</td><td style="text-align:right">${money(i.qty * i.price)}</td></tr>`)}</tbody></table>
    ${o.discount ? html`<div class="sum"><span>Скидка (${o.promo})</span><span>−${money(o.discount)}</span></div>` : ''}
    <div class="sum"><span>Доставка (${cfg.delivery[o.delivery]?.label || o.delivery})</span><span>${money(o.delivery_cost)}</span></div>
    <div class="sum total"><span>Итого</span><span>${money(o.total)}</span></div>
    ${o.address ? html`<p class="muted">Адрес: ${o.address}</p>` : ''}</div>`;
}

route(/^\/order\/(\d+)$/, async ([, id], q) => {
  loading();
  const o = await api(`/orders/${id}?t=${encodeURIComponent(q.t || '')}`);
  if (o.status !== 'pending' && cart.length && q.t) { cart = []; saveCart(); }
  view(html`<div class="narrow" style="max-width:640px">
    ${o.status === 'paid' ? html`<h1 class="ok">✓ Оплата прошла успешно</h1><p>Спасибо за заказ! Подтверждение отправлено на ${o.email}.</p>`
      : o.status === 'pending' ? html`<h1>Заказ ожидает оплаты</h1><a class="btn" href="#/pay/${o.id}?t=${q.t || ''}">Оплатить</a>` : html`<h1>Заказ №${o.id}</h1>`}
    ${orderBlock(o)}<a class="btn ghost" href="#/">Продолжить покупки</a></div>`);
});

route(/^\/orders$/, async () => {
  if (!cfg.user) return (location.hash = '#/login');
  loading();
  const list = await api('/my/orders');
  view(html`<h1>Мои заказы</h1>${list.length ? list.map(orderBlock) : html`<div class="empty">Заказов пока нет</div>`}`);
});

route(/^\/wishlist$/, async () => {
  if (!cfg.user) return (location.hash = '#/login');
  loading();
  const list = await api('/wishlist');
  view(html`<h1>Избранное</h1>${list.length ? html`<div class="grid">${list.map(productCard)}</div>` : html`<div class="empty">Здесь пока пусто</div>`}`);
});

// ---------- вход / регистрация ----------
const authForm = (mode) => html`<div class="narrow card">
  <h1>${mode === 'login' ? 'Вход' : 'Регистрация'}</h1>
  <form data-form="${mode}">
    ${mode === 'register' ? html`<label style="margin-top:0">Имя</label><input name="name" required autocomplete="name">` : ''}
    <label ${mode === 'login' ? 'style="margin-top:0"' : ''}>Email</label><input name="email" type="email" required autocomplete="email">
    <label>Пароль${mode === 'register' ? ' (от 8 символов)' : ''}</label><input name="password" type="password" required minlength="${mode === 'register' ? 8 : 1}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
    <div class="err" id="formErr"></div>
    <button class="btn block" style="margin-top:12px">${mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
  </form>
  <p class="muted">${mode === 'login' ? html`Нет аккаунта? <a href="#/register" style="text-decoration:underline">Регистрация</a>` : html`Уже есть аккаунт? <a href="#/login" style="text-decoration:underline">Войти</a>`}</p></div>`;
route(/^\/login$/, () => view(authForm('login')));
route(/^\/register$/, () => view(authForm('register')));

// ---------- админка ----------
let adminTab = 'dashboard';
route(/^\/admin$/, async () => {
  if (cfg.user?.role !== 'admin') return (location.hash = '#/login');
  loading();
  const tabs = [['dashboard', 'Сводка'], ['orders', 'Заказы'], ['products', 'Товары'], ['promos', 'Промокоды']];
  let body;
  if (adminTab === 'dashboard') {
    const s = await api('/admin/stats');
    body = html`<div class="stats">
      <div class="card stat"><span class="muted">Выручка</span><b>${money(s.revenue)}</b></div>
      <div class="card stat"><span class="muted">Заказов</span><b>${s.orders}</b></div>
      <div class="card stat"><span class="muted">Оплачено</span><b>${s.paid}</b></div>
      <div class="card stat"><span class="muted">Покупателей</span><b>${s.customers}</b></div></div>
      <div class="card"><b>Заканчиваются на складе</b>${s.lowStock.length ? html`<table><tbody>${s.lowStock.map(p => html`<tr><td>${p.title}</td><td>${p.stock} шт.</td></tr>`)}</tbody></table>` : html`<p class="muted">Всё в порядке</p>`}</div>`;
  } else if (adminTab === 'orders') {
    const list = await api('/admin/orders');
    body = html`<div class="card table-wrap"><table><thead><tr><th>№</th><th>Дата</th><th>Клиент</th><th>Состав</th><th>Сумма</th><th>Статус</th></tr></thead><tbody>
      ${list.map(o => html`<tr><td>${o.id}</td><td>${fmtDate(o.created_at)}</td>
        <td>${o.name}<div class="muted">${o.email} ${o.phone}</div><div class="muted">${o.address}</div></td>
        <td>${o.items.map(i => html`<div>${i.title} × ${i.qty}</div>`)}</td><td>${money(o.total)}</td>
        <td><select data-act="orderStatus" data-id="${o.id}">${Object.entries(STATUS).map(([k, v]) => html`<option value="${k}" ${o.status === k ? 'selected' : ''}>${v}</option>`)}</select></td></tr>`)}
      </tbody></table></div>`;
  } else if (adminTab === 'products') {
    const [list, cats] = await Promise.all([api('/admin/products'), api('/categories')]);
    body = html`
      <form class="card" data-form="product" style="margin-bottom:16px">
        <b id="pfTitle">Новый товар</b><input type="hidden" name="id">
        <div class="two" style="grid-template-columns:1fr 1fr;gap:0 16px">
          <div><label>Название</label><input name="title" required></div>
          <div><label>Категория</label><select name="category_id"><option value="">—</option>${cats.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></div>
          <div><label>Цена</label><input name="price" type="number" min="1" step="0.01" required></div>
          <div><label>Старая цена (необяз.)</label><input name="old_price" type="number" min="0" step="0.01"></div>
          <div><label>Остаток, шт.</label><input name="stock" type="number" min="0" required value="0"></div>
          <div><label>Ссылка на фото</label><input name="image" placeholder="https://…"></div></div>
        <label>Описание</label><textarea name="description" rows="3"></textarea>
        <label class="row"><input type="checkbox" name="active" style="width:auto" checked> Показывать в каталоге</label>
        <div class="err" id="formErr"></div>
        <div class="row" style="margin-top:12px"><button class="btn">Сохранить</button><button type="reset" class="btn ghost" data-act="pfReset">Сбросить</button></div>
      </form>
      <div class="card" style="margin-bottom:16px"><form data-form="category" class="row"><input name="name" placeholder="Новая категория" required>
        <button class="btn sm">Добавить</button></form>
        <div style="margin-top:8px">${cats.map(c => html`<span class="status" style="margin:2px">${c.name} <a href="#/admin" data-act="delCat" data-id="${c.id}" aria-label="Удалить">✕</a></span>`)}</div></div>
      <div class="card table-wrap"><table><thead><tr><th></th><th>Название</th><th>Цена</th><th>Остаток</th><th></th></tr></thead><tbody>
        ${list.map(p => html`<tr><td style="width:56px">${img(p.image)}</td><td>${p.title} ${p.active ? '' : html`<span class="status">скрыт</span>`}</td>
          <td>${money(p.price)}</td><td>${p.stock}</td>
          <td style="white-space:nowrap"><button class="btn ghost sm" data-act="editProduct" data-id="${p.id}">Изменить</button>
          <button class="btn danger sm" data-act="delProduct" data-id="${p.id}">Удалить</button></td></tr>`)}</tbody></table></div>`;
    window.__adminProducts = list;
  } else {
    const list = await api('/admin/promos');
    body = html`<form class="card row" data-form="promoAdmin" style="margin-bottom:16px;flex-wrap:wrap">
        <input name="code" placeholder="КОД" required><input name="percent" type="number" min="1" max="90" placeholder="Скидка %" required>
        <input name="min_total" type="number" min="0" placeholder="Мин. сумма (необяз.)"><button class="btn">Создать</button><span class="err" id="formErr"></span></form>
      <div class="card"><table><thead><tr><th>Код</th><th>Скидка</th><th>От суммы</th><th></th></tr></thead><tbody>
        ${list.map(p => html`<tr><td><b>${p.code}</b></td><td>${p.percent}%</td><td>${p.min_total ? money(p.min_total) : '—'}</td>
          <td><button class="btn danger sm" data-act="delPromo" data-id="${p.code}">Удалить</button></td></tr>`)}</tbody></table></div>`;
  }
  view(html`<h1>Администрирование</h1><div class="tabs">${tabs.map(([k, l]) =>
    html`<button class="btn ${adminTab === k ? '' : 'ghost'}" data-act="tab" data-id="${k}">${l}</button>`)}</div>${body}`);
});

// ---------- действия (делегирование событий) ----------
const fail = (msg) => { const e = $('#formErr'); if (e) e.textContent = msg; else toast(msg); };

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  try {
    if (act === 'add') addToCart(Number(id));
    else if (act === 'buy') { addToCart(Number(id)); location.hash = '#/checkout'; }
    else if (act === 'wish') {
      if (!cfg.user) { toast('Войдите, чтобы пользоваться избранным'); return (location.hash = '#/login'); }
      const on = wish.has(Number(id));
      await api('/wishlist/' + id, { method: on ? 'DELETE' : 'PUT' });
      on ? wish.delete(Number(id)) : wish.add(Number(id));
      document.querySelectorAll(`.heart[data-id="${id}"]`).forEach(h => h.classList.toggle('on', !on));
      if (on && location.hash === '#/wishlist') render();
    }
    else if (act === 'cat') { e.preventDefault(); filter.category = id; filter.page = 1; render(); }
    else if (act === 'page') { filter.page = Number(id); render(); }
    else if (act === 'inc' || act === 'dec') {
      const it = cart.find(i => i.id === Number(id));
      it.qty = Math.max(1, Math.min(99, it.qty + (act === 'inc' ? 1 : -1))); saveCart(); render();
    }
    else if (act === 'remove') { cart = cart.filter(i => i.id !== Number(id)); saveCart(); render(); }
    else if (act === 'tab') { adminTab = id; render(); }
    else if (act === 'delProduct') { if (confirm('Удалить товар?')) { await api('/admin/products/' + id, { method: 'DELETE' }); render(); } }
    else if (act === 'delCat') { e.preventDefault(); await api('/admin/categories/' + id, { method: 'DELETE' }); render(); }
    else if (act === 'delPromo') { await api('/admin/promos/' + encodeURIComponent(id), { method: 'DELETE' }); render(); }
    else if (act === 'editProduct') {
      const p = window.__adminProducts.find(x => x.id === Number(id)), f = $('[data-form=product]').elements;
      f.id.value = p.id; f.title.value = p.title; f.category_id.value = p.category_id ?? ''; f.price.value = p.price / 100;
      f.old_price.value = p.old_price ? p.old_price / 100 : ''; f.stock.value = p.stock; f.image.value = p.image;
      f.description.value = p.description; f.active.checked = !!p.active;
      $('#pfTitle').textContent = `Редактирование: ${p.title}`; $('[data-form=product]').scrollIntoView({ behavior: 'smooth' });
    }
    else if (act === 'pfReset') setTimeout(() => { $('#pfTitle').textContent = 'Новый товар'; $('[data-form=product]').elements.id.value = ''; });
    else if (act === 'logout') {
      await api('/auth/logout', { method: 'POST' }); cfg.user = null; wish = new Set(); renderNav();
      location.hash === '#/' ? render() : (location.hash = '#/');
    }
  } catch (err) { toast(err.message); }
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.dataset.act === 'sort') { filter.sort = el.value; render(); }
    else if (el.dataset.act === 'orderStatus') { await api('/admin/orders/' + el.dataset.id, { method: 'PUT', body: { status: el.value } }); toast('Статус обновлён'); }
    else if (el.name === 'delivery') {
      deliveryKey = el.value; store.set('delivery', deliveryKey);
      document.querySelectorAll('.radio').forEach(r => r.classList.toggle('sel', r.contains(el)));
      $('#addrBox').hidden = !cfg.delivery[deliveryKey].address;
    }
  } catch (err) { toast(err.message); }
});

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]'); if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form, f = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('button:not([type=reset])'); if (btn) btn.disabled = true;
  try {
    if (kind === 'filters') {
      Object.assign(filter, { min: f.min, max: f.max, inStock: f.inStock ? '1' : '', page: 1 }); render();
    } else if (kind === 'login' || kind === 'register') {
      const r = await api('/auth/' + kind, { method: 'POST', body: f });
      cfg.user = r.user; await loadWish(); renderNav(); toast(`Здравствуйте, ${r.user.name}!`);
      location.hash = r.user.role === 'admin' ? '#/admin' : '#/';
    } else if (kind === 'review') {
      await api(`/products/${form.dataset.id}/reviews`, { method: 'POST', body: f }); toast('Спасибо за отзыв!'); render();
    } else if (kind === 'promo') {
      promoCode = f.code.trim(); store.set('promo', promoCode); render();
    } else if (kind === 'checkout') {
      const r = await api('/checkout', { method: 'POST', body: { ...f, delivery: deliveryKey, items: cart, promo: promoCode } });
      if (r.url.startsWith(location.origin + '/#')) location.hash = r.url.slice(location.origin.length + 1); else location.href = r.url;
    } else if (kind === 'pay') {
      await api(`/orders/${form.dataset.id}/demo-pay`, { method: 'POST', body: { card: f.card, t: form.dataset.t } });
      location.hash = `#/order/${form.dataset.id}?t=${form.dataset.t}`;
    } else if (kind === 'product') {
      const body = { ...f, active: !!f.active };
      f.id ? await api('/admin/products/' + f.id, { method: 'PUT', body }) : await api('/admin/products', { method: 'POST', body });
      toast('Сохранено'); render();
    } else if (kind === 'category') {
      await api('/admin/categories', { method: 'POST', body: f }); render();
    } else if (kind === 'promoAdmin') {
      await api('/admin/promos', { method: 'POST', body: f }); render();
    }
  } catch (err) { fail(err.message); if (btn) btn.disabled = false; }
});

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault(); filter.q = $('#searchInput').value.trim(); filter.page = 1;
  location.hash === '#/' ? render() : (location.hash = '#/');
});
$('#logo').addEventListener('click', () => { Object.assign(filter, { q: '', category: '', min: '', max: '', inStock: '', page: 1 }); $('#searchInput').value = ''; });

// ---------- старт ----------
(async () => {
  cfg = await api('/config');
  document.title = cfg.shopName;
  $('#logo').textContent = cfg.shopName; $('#footName').textContent = cfg.shopName; $('#year').textContent = new Date().getFullYear();
  await loadWish().catch(() => {});
  renderNav(); render();
})();
