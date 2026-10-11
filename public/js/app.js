// public/js/app.js —— hash 路由四视图；路由/字段/错误码以 src/api/*.js + src/worker.js 为准
import { t } from './i18n-inline.js';
import { put as idbPut, all as idbAll, del as idbDel } from './idb.js';
import { sanitize } from './canvas-image.js';

const $view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 后端契约：{ok, ...} 或 {ok:false, error}；status 需要单独看（403/402/409 语义）
const api = (p, opt) => fetch('/api' + p, opt)
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const CATS = ['electronics', 'card', 'clothing', 'book', 'other'];
const STATUS_CLS = { in_stock: 'status-ok', ready: 'status-warn', claim_pending: 'status-warn', registered: 'status-warn', returned: '' };
const STATUS_KEY = { registered: 'status_registered', in_stock: 'status_in_stock', claim_pending: 'status_claim_pending', pending: 'status_pending', ready: 'status_ready', returned: 'status_returned', voided: 'status_voided', expired: 'status_expired' };
let countdownTimer = null;

// —— 路由 ——
const routes = { '#/': renderHome, '#/report': renderReport, '#/shop': renderShop };
// 导航：积分页已合并进商城；旧链接 #/points 自动跳转
const REDIRECTS = { '#/points': '#/shop' };
window.addEventListener('hashchange', router);
function router() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const h = location.hash || '#/';
  const qi = h.indexOf('?');
  const path = qi < 0 ? h : h.slice(0, qi);
  const q = new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1));
  document.querySelectorAll('.tabbar [data-route], .gnav [data-route]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.route === path)));
  if (path.startsWith('#/claim/')) return renderClaim(path.slice('#/claim/'.length));
  if (REDIRECTS[path]) {   // 合并后保留旧链接可用
    const sid = q.get('sid');
    location.hash = REDIRECTS[path] + (sid ? '?sid=' + sid : '');
    return;
  }
  (routes[path] || renderHome)(q);
}
// 导航按钮（非 <a> 的 tab/侧边栏）必须显式绑定路由——否则点击无反应
document.querySelectorAll('[data-route]').forEach((b) => {
  if (b.tagName !== 'A') b.addEventListener('click', () => { location.hash = b.dataset.route; });
});

// 微信内置浏览器提示（防封的正面做法：引导在系统浏览器打开，不做暗跳转）
(function wechatBanner() {
  try {
    if (!/MicroMessenger/i.test(navigator.userAgent)) return;
    if (sessionStorage.getItem('lf_wx_hint') === '1') return;
    const bar = document.createElement('div');
    bar.className = 'wx-banner';
    bar.innerHTML = '<span>' + t('wx_banner') + '</span><button type="button" aria-label="dismiss">✕</button>';
    bar.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem('lf_wx_hint', '1');
      bar.remove();
    });
    document.body.prepend(bar);
  } catch { /* 提示失败不影响主流程 */ }
})();

// 公告栏（后台 Settings 可开关）
(async () => {
  try {
    const r = await fetch('/api/site');
    const b = await r.json();
    if (b.ok && b.notice_on && b.notice) {
      const bar = document.createElement('div');
      bar.className = 'notice-bar';
      bar.textContent = b.notice;
      document.body.prepend(bar);
    }
  } catch { /* 公告失败不影响主流程 */ }
})();

// —— i18n ——
function applyStaticTexts() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
}

// —— 工具 ——
const fmtDate = (iso) => String(iso || '').slice(0, 10);
const statusBadge = (s) => `<span class="status ${STATUS_CLS[s] || ''}">${t(STATUS_KEY[s] || 'status_registered')}</span>`;
const errBox = (code, fallback) => `<p class="err">${esc(t('err_' + code) !== 'err_' + code ? t('err_' + code) : (fallback || t('error_generic')))}</p>`;

// —— 离线补发：启动 + 恢复联网时重放队列（IndexedDB）——
let flushNotice = 0;
function notify(text) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:99;background:rgba(32,41,49,.92);color:#fff;font:600 14px var(--font-ui);padding:10px 18px;border-radius:99px';
  d.textContent = text;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}
async function flushQueue() {
  if (!navigator.onLine) return;
  let items = [];
  try { items = await idbAll('queue'); } catch { return; }
  let sent = 0;
  for (const q of items) {
    try {
      const fd = new FormData();
      for (const [k, v] of q.body) fd.set(k, v);
      const { status, body } = await api('/report', { method: 'POST', body: fd });
      if (status === 200 && body.ok) { await idbDel('queue', q.id); sent++; }
      else if (status >= 400 && status < 500) { await idbDel('queue', q.id); }   // 永久失败（校验不通过）不再重试
      else break;                                                                 // 5xx / 网络：保留，下次再试
    } catch { break; }
  }
  if (sent > 0) {
    flushNotice = sent; notify(t('offline_flushed').replace('{n}', sent));
    const h = location.hash || '#/';
    if (h === '#/' || h.startsWith('#/?') || h === '') renderHome(new URLSearchParams());
  }
}
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); });

// ============ 公示首页 ============
const cardHtml = (i) => `
  <a class="card item-card" href="#/claim/${i.id}">
    <div class="meta"><span class="slot-tag">${t('slot_label')} ${i.slot_no ?? '—'}</span>${statusBadge(i.status)}</div>
    <div class="item-title">${esc(i.title)}</div>
    <div class="muted">${esc(i.description || '')}</div>
    <div class="meta"><span>${t('cat_' + (i.category || 'other'))}</span><span class="muted">${fmtDate(i.found_at)}</span></div>
  </a>`;

async function renderHome(q) {
  const cat = q?.get('cat') || '';
  $view.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { body } = await api('/items' + (cat ? `?category=${encodeURIComponent(cat)}` : ''));
  const items = Array.isArray(body.items) ? body.items : [];
  const high = items.filter((i) => i.value_tier === 'high').length;
  const nCats = new Set(items.map((i) => i.category)).size;
  const filters = ['', ...CATS].map((c) =>
    `<button class="chip" aria-pressed="${c === cat}" data-cat="${c}">${c ? t('cat_' + c) : t('cat_all')}</button>`).join('');
  const list = items.length
    ? `<div class="layout"><div class="grid">${items.map(cardHtml).join('')}</div>
       <aside><div class="card"><h3>${t('home_aside_title')}</h3>
         <label class="field"><span>${t('home_aside_hint')}</span>
           <input id="asideSid" inputmode="numeric" pattern="\\d{7}" maxlength="7"></label>
         <button class="btn btn-primary" id="asideGo">${t('home_aside_btn')}</button></div></aside></div>`
    : `<div class="card"><p class="empty">${t('empty_home')}</p></div>`;
  const hero = cat ? '' : '<section class="hero">'
    + '<p class="hero-kicker">' + t('hero_kicker') + '</p>'
    + '<h2 class="hero-title">' + t('hero_title') + '</h2>'
    + '<p class="hero-sub">' + t('hero_sub') + '</p>'
    + '<div class="hero-cta"><button class="btn btn-primary" id="heroBrowse" type="button">' + t('cta_browse') + '</button></div>'
    + '<p class="hero-note">' + t('hero_note_report') + '</p>'
    + '</section>';
  const how = cat ? '' : '<section class="how"><h3 class="sec-h">' + t('how_h') + '</h3><div class="how-grid">'
    + '<div class="how-card"><span class="how-n">1</span><b>' + t('how1_t') + '</b><p>' + t('how1_d') + '</p></div>'
    + '<div class="how-card"><span class="how-n">2</span><b>' + t('how2_t') + '</b><p>' + t('how2_d') + '</p></div>'
    + '<div class="how-card"><span class="how-n">3</span><b>' + t('how3_t') + '</b><p>' + t('how3_d') + '</p></div>'
    + '</div></section>';
  $view.innerHTML = (cat ? '' : hero + how)
    + '<section id="board"><h3 class="sec-h">' + t('board_h') + '</h3>'
    + '<div class="statbar"><span>' + t('stat_total') + ': ' + items.length + '</span><span>' + t('stat_high') + ': ' + high + '</span><span>' + t('stat_cats') + ': ' + nCats + '</span><span>' + t('stat_note') + '</span></div>'
    + '<div class="filters">' + filters + '</div>' + list + '</section>';
  $view.querySelectorAll('.chip[data-cat]').forEach((b) => b.addEventListener('click', () => {
    location.hash = b.dataset.cat ? `#/?cat=${b.dataset.cat}` : '#/';
  }));
  const browse = $view.querySelector('#heroBrowse');
  if (browse) browse.addEventListener('click', () => { const el = $view.querySelector('#board'); if (el) el.scrollIntoView({ behavior: 'smooth' }); });
  const go = $view.querySelector('#asideGo');
  if (go) go.addEventListener('click', () => {
    const sid = $view.querySelector('#asideSid').value.trim();
    if (/^\d{7}$/.test(sid)) location.hash = `#/shop?sid=${sid}`;   // 合并后：查积分 → 商城页
  });
}

// ============ 登记三步（全凭自觉：提交即分配格位，无凭证码；物品请自行放入对应格） ============
function renderReport() {
  $view.innerHTML = `
  <h3>${t('report_title')}</h3>
  <form id="reportForm" class="rows">
    <div class="card"><div class="step">${t('report_step1')}</div>
      <input type="file" id="r_photo" accept="image/*" capture="environment">
      <p class="muted" id="r_photo_note"></p></div>
    <div class="card"><div class="step">${t('report_step2')}</div>
      <label class="field"><span>${t('report_f_title')}</span><input id="r_title" maxlength="40" required></label>
      <label class="field"><span>${t('report_f_cat')}</span><select id="r_cat">${CATS.map((c) => `<option value="${c}">${t('cat_' + c)}</option>`).join('')}</select></label>
      <label class="field"><span>${t('report_f_loc')}</span><input id="r_loc" maxlength="30" required></label>
      <label class="field"><span>${t('report_f_desc')}</span><input id="r_desc" maxlength="80"></label>
      <label class="field"><span>${t('report_f_verify')}</span><input id="r_verify" maxlength="60"></label></div>
    <div class="card"><div class="step">${t('report_step3')}</div>
      <label class="field"><span>${t('report_f_sid')}</span><input id="r_sid" inputmode="numeric" maxlength="7" placeholder="7 digits" required></label>
      <label class="field"><span>${t('report_f_name')}</span><input id="r_name" maxlength="20" required></label>
      <label class="field"><span>${t('report_f_class')}</span><input id="r_class" maxlength="10" required></label></div>
    <button class="btn btn-primary" type="submit">${t('report_submit')}</button>
    <div id="reportMsg"></div>
  </form>`;
  document.getElementById('reportForm').addEventListener('submit', submitReport);
}
async function submitReport(ev) {
  ev.preventDefault();
  const msg = document.getElementById('reportMsg');
  const sid = document.getElementById('r_sid').value.trim();
  if (!/^\d{7}$/.test(sid)) { msg.innerHTML = `<p class="err">${t('err_bad_student_id')}</p>`; return; }
  const fd = new FormData();
  fd.set('title', document.getElementById('r_title').value.trim());
  fd.set('description', document.getElementById('r_desc').value.trim());
  fd.set('category', document.getElementById('r_cat').value);
  fd.set('location', document.getElementById('r_loc').value.trim());
  fd.set('student_id', sid);
  fd.set('name', document.getElementById('r_name').value.trim());
  fd.set('class', document.getElementById('r_class').value.trim());
  const vq = document.getElementById('r_verify').value.trim();
  if (vq) { fd.set('verify_q', 'Please describe a detail only the owner would know'); fd.set('verify_a', vq); }
  const file = document.getElementById('r_photo').files[0];
  if (file) { try { fd.set('photo', await sanitize(file)); } catch { /* 图片处理失败则不附照片 */ } }
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  if (!navigator.onLine) {   // 离线：入队，恢复后自动补发（IndexedDB，不用 localStorage）
    await idbPut('queue', undefined, { url: '/api/report', body: [...fd.entries()] });
    msg.innerHTML = `<p class="warn-note">${t('report_offline_note')}</p>`;
    return;
  }
  const { status, body } = await api('/report', { method: 'POST', body: fd });
  if (status === 200 && body.ok) { renderReportDone(body); return; }
  msg.innerHTML = `<p class="err">${errBox(body.error, t('report_failed'))}</p>`;
}
function renderReportDone(body) {
  $view.innerHTML = `
  <div class="ticket">
    <div class="ticket-head"><strong>${t('report_done_title')}</strong><span class="slot-tag">${esc(body.code)}</span></div>
    <div class="ticket-body">
      <div class="slot-big">${t('slot_label')} ${String(body.slot_no).padStart(2, '0')}</div>
      <p class="muted">${t('report_done_hint')}</p>
      <div class="ticket-perf"></div>
      <p class="muted">${t('report_done_foot')}</p>
    </div>
  </div>
  <a class="btn btn-primary" href="#/">${t('report_done_back')}</a>`;
}
async function renderClaim(id) {
  $view.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { status, body } = await api('/items/' + encodeURIComponent(id));
  if (status !== 200 || !body.ok) return renderHomeish(t('err_ITEM_NOT_CLAIMABLE'));
  const it = body.item;
  const formHtml = it.status === 'in_stock' ? `
    <div class="card"><h3>${t('claim_q_title')}</h3>
      <form id="claimForm" class="rows">
        <label class="field"><span>${t('claim_answer_label')}</span><input id="c_answer" required maxlength="80"></label>
        <label class="field"><span>${t('f_student_id')}</span><input id="c_sid" required inputmode="numeric" pattern="\\d{7}" maxlength="7"></label>
        <label class="field"><span>${t('f_name')}</span><input id="c_name" required maxlength="20"></label>
        <label class="field"><span>${t('f_class')}</span><input id="c_cls" required maxlength="20"></label>
        <label class="field"><span>${t('pin_label')}</span><input id="c_pin" required inputmode="numeric" pattern="\\d{4}" maxlength="4" placeholder="${t('pin_ph')}">
          <small class="muted">${t('pin_hint')}</small></label>
        <button class="btn btn-primary" type="submit">${t('claim_submit')}</button>
        <div id="claimMsg"></div>
      </form></div>`
    : `<p class="ok-note">${t('claim_ready_note')}</p>`;
  $view.innerHTML = `
  <h3>${t('claim_title')}</h3>
  <div class="card item-card">
    <div class="meta"><span class="slot-tag">${t('slot_label')} ${it.slot_no ?? '—'}</span>${statusBadge(it.status)}</div>
    <div class="item-title">${esc(it.title)}</div>
    <div class="muted">${esc(it.description || '')}</div>
    <dl class="detail-list">
      <dt>${t('f_category')}</dt><dd>${t('cat_' + (it.category || 'other'))}${it.value_tier === 'high' ? ' · ' + t('tier_high') : ''}</dd>
      <dt>${t('f_location')}</dt><dd>${esc(it.location)}</dd>
      <dt>${t('found_at_label')}</dt><dd>${fmtDate(it.found_at)}</dd>
      <dt>${t('finder_label')}</dt><dd>${esc(it.finder_name || '')}${it.finder_class ? ' · ' + esc(it.finder_class) : ''}</dd>
    </dl></div>
  ${formHtml}`;
  const form = document.getElementById('claimForm');
  if (form) form.addEventListener('submit', (ev) => submitClaim(ev, it));
}

async function submitClaim(ev, it) {
  ev.preventDefault();
  const $ = (id) => document.getElementById(id);
  const msg = $('#claimMsg');
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { status, body } = await api('/claims', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: it.code, student_id: $('#c_sid').value.trim(), name: $('#c_name').value.trim(),
      class: $('#c_cls').value.trim(), pin: $('#c_pin').value.trim(), verify_answer: $('#c_answer').value.trim() }),
  });
  if (status !== 200 || !body.ok) { msg.innerHTML = errBox(body.error, t('err_ITEM_NOT_CLAIMABLE')); return; }
  if (body.status === 'auto_approved')
    return renderPickupVoucher(body);
  if (body.status === 'pending') msg.innerHTML = `<p class="ok-note">${t('claim_pending_note')}</p>`;
  else msg.innerHTML = `<p class="warn-note">${t('claim_review_note')}</p>`;
}

function renderPickupVoucher({ pickup_expires_at }) {
  const end = pickup_expires_at ? new Date(pickup_expires_at).getTime() : 0;
  $view.innerHTML = `
  <div class="ticket">
    <div class="ticket-head"><strong>${t('claim_auto')}</strong><span>${t('claim_reserved_badge')}</span></div>
    <div class="ticket-body">
      <p class="muted">${t('claim_auto_hint')}</p>
      ${end ? `<div class="ticket-perf"></div><p class="muted">${t('pickup_by_label')}: ${fmtDate(new Date(end).toISOString())}</p>` : ''}
      <p class="muted"><a href="#/">${t('back_home')}</a></p>
    </div>
  </div>`;
}

// ============ 积分商城（Rewards shop） ============
let shopState = { sid: '', name: '', balance: null };
let shopCatalog = [];
async function renderShop(q) {
  const preSid = q?.get('sid') || '';
  $view.innerHTML = `
  <h3>${t('shop_title')}</h3>
  <p class="muted">${t('shop_sub')}</p>
  <div class="card">
    <label class="field"><span>${t('points_id_label')}</span>
      <input id="s_sid" inputmode="numeric" pattern="\\d{7}" maxlength="7" value="${esc(preSid)}" placeholder="7 digits"></label>
    <label class="field"><span>${t('points_name_label')}</span><input id="s_name" maxlength="20" placeholder="Name"></label>
    <div class="actions"><button class="btn btn-primary" id="s_check">${t('shop_check')}</button></div>
    <div id="s_msg"></div>
  </div>
  <div id="shopStats"></div>
  <div id="shopLedger"></div>
  <div id="shopGrid" class="shop-grid"></div>
  <div id="shopMsg"></div>
  <div id="shopOrders"></div>`;
  document.getElementById('s_check').addEventListener('click', checkShopIdentity);
  document.getElementById('s_name').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkShopIdentity(); });
  await loadShop();
  if (preSid && /^\d{7}$/.test(preSid)) checkShopIdentity();
}
async function checkShopIdentity() {
  const sid = document.getElementById('s_sid').value.trim();
  const name = document.getElementById('s_name').value.trim();
  const msg = document.getElementById('s_msg');
  if (!/^\d{7}$/.test(sid)) { msg.innerHTML = errBox('BAD_STUDENT_ID', t('err_bad_student_id')); return; }
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const pin = document.getElementById('s_pin') ? document.getElementById('s_pin').value.trim() : '';
  const qs = name ? `?name=${encodeURIComponent(name)}` : (pin ? `?pin=${encodeURIComponent(pin)}` : '');
  const { status, body } = await api(`/points/${sid}${qs}`);
  if (status === 404) { msg.innerHTML = errBox('NOT_FOUND', t('points_not_found')); return; }
  if (status === 403) { msg.innerHTML = errBox('FORBIDDEN', t('points_forbidden')); return; }
  if (!body.ok) { msg.innerHTML = errBox(body.error); return; }
  shopState = { sid, name, balance: body.total };
  msg.innerHTML = '';
  const stats = document.getElementById('shopStats');
  if (stats) stats.innerHTML = `<div class="statbar"><span>${t('shop_balance')}: <b class="mono">${body.total}</b></span><span>${t('shop_returns')}: ${body.contributions}</span></div>`;
  renderShopLedger(body);
  renderShopOrders(body.redemptions || []);
  loadShop();
}
function renderShopLedger(body) {
  const box = document.getElementById('shopLedger');
  if (!box) return;
  if (!body.ledger) {   // 未做二次校验（只输了学号）→ 提示补姓名
    box.innerHTML = `<div class="card"><h3>${t('points_ledger_title')}</h3><p class="muted">${t('points_expand')}</p></div>`;
    return;
  }
  const rows = body.ledger.length
    ? body.ledger.map((r) => `<div class="ledger-row"><span>${t('reason_' + r.reason) || r.reason} · ${fmtDate(r.created_at)}</span><span class="delta">${r.delta > 0 ? '+' : ''}${r.delta}</span></div>`).join('')
    : `<p class="muted">${t('points_ledger_empty')}</p>`;
  box.innerHTML = `<div class="card"><h3>${t('points_ledger_title')}</h3>${rows}</div>`;
}
function renderShopOrders(list) {
  const box = document.getElementById('shopOrders');
  if (!box) return;
  const rows = list.length
    ? list.map((r) => `<div class="ledger-row"><span>${esc(r.name)} · ${r.points_cost}${t('mall_cost')}</span><span class="status ${r.status === 'pending' ? 'status-warn' : 'status-ok'}">${t('redeem_status_' + r.status) || r.status}</span></div>`).join('')
    : `<p class="muted">${t('shop_no_orders')}</p>`;
  box.innerHTML = `<div class="card"><h3>${t('shop_my_orders')}</h3>${rows}</div>`;
}
async function loadShop() {
  const grid = document.getElementById('shopGrid');
  if (!grid) return;
  const { body } = await api('/rewards').catch(() => ({ body: {} }));
  shopCatalog = Array.isArray(body.rewards) ? body.rewards : [];
  if (!shopCatalog.length) { grid.innerHTML = `<p class="muted">${t('shop_empty')}</p>`; return; }
  grid.innerHTML = shopCatalog.map((r) => {
    const out = r.stock <= 0;
    const short = shopState.balance !== null && shopState.balance < r.cost;
    const need = short ? `${t('shop_need_more')} ${r.cost - shopState.balance}` : '';
    return `<div class="shop-card${out ? ' is-out' : ''}">
      <div class="shop-ico">${esc(r.icon || '🎁')}</div>
      <div class="shop-name">${esc(r.name)}</div>
      <div class="shop-meta"><span class="shop-cost">${r.cost}</span><span>${t('mall_cost')} · ${t('shop_stock_left')} ${r.stock}</span></div>
      ${need ? `<div class="shop-need">${need}</div>` : ''}
      <button class="btn btn-primary" data-rid="${r.id}" ${out || short ? 'disabled' : ''}>${out ? t('shop_sold_out') : t('shop_redeem')}</button>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', () => redeemReward(Number(b.dataset.rid))));
}
async function redeemReward(rid) {
  const msg = document.getElementById('shopMsg');
  if (!shopState.sid) { msg.innerHTML = errBox('UNAUTHORIZED', t('shop_check')); return; }
  const rw = shopCatalog.find((x) => x.id === rid);
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const pin = document.getElementById('s_pin') ? document.getElementById('s_pin').value.trim() : '';
  const { status, body } = await api('/redemptions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: shopState.sid, reward_id: rid, name: shopState.name, pin }) });
  if (status === 200 && body.ok) {
    msg.innerHTML = `
    <div class="ticket">
      <div class="ticket-head"><strong>${t('shop_order_title')}</strong><span class="slot-tag">#${body.redemption_id}</span></div>
      <div class="ticket-body">
        <div class="slot-big">${esc(rw ? rw.name : '')}</div>
        <p class="muted">${t('shop_order_pending')} · -${rw ? rw.cost : ''}${t('mall_cost')}</p>
        <div class="ticket-perf"></div>
        <p class="muted">${t('shop_order_collect')}</p>
      </div>
    </div>`;
    checkShopIdentity();
    return;
  }
  msg.innerHTML = errBox(body.error, t('error_generic'));
}

