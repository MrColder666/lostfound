// public/js/app.js —— hash 路由四视图；路由/字段/错误码以 src/api/*.js + src/worker.js 为准
import { t, getLang } from './i18n-inline.js';
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
let lang = getLang();
let countdownTimer = null;

// —— 路由 ——
const routes = { '#/': renderHome, '#/report': renderReport, '#/points': renderPoints };   // 登记：手机登记即分配格位（全凭自觉）
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

// —— i18n ——
function applyStaticTexts() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
}

// —— 工具 ——
const fmtDate = (iso) => String(iso || '').slice(0, 10);
const statusBadge = (s) => `<span class="status ${STATUS_CLS[s] || ''}">${t(STATUS_KEY[s] || 'status_registered')}</span>`;
const errBox = (code, fallback) => `<p class="err">${esc(t('err_' + code) !== 'err_' + code ? t('err_' + code) : (fallback || t('error_generic')))}</p>`;

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
    if (/^\d{7}$/.test(sid)) location.hash = `#/points?sid=${sid}`;
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
      class: $('#c_cls').value.trim(), verify_answer: $('#c_answer').value.trim() }),
  });
  if (status !== 200 || !body.ok) { msg.innerHTML = errBox(body.error, t('err_ITEM_NOT_CLAIMABLE')); return; }
  if (body.status === 'auto_approved')
    return renderPickupVoucher(body);
  if (body.status === 'pending') msg.innerHTML = `<p class="ok-note">${t('claim_pending_note')}</p>`;
  else msg.innerHTML = `<p class="warn-note">${t('claim_review_note')}</p>`;
}

function renderPickupVoucher({ pickup_code, pickup_expires_at }) {
  const end = pickup_expires_at ? new Date(pickup_expires_at).getTime() : 0;
  $view.innerHTML = `
  <div class="ticket">
    <div class="ticket-head"><strong>${t('claim_auto')}</strong><span>${t('pickup_code')}</span></div>
    <div class="ticket-body">
      <div class="code-big">${esc(pickup_code)}</div>
      <p class="muted">${t('claim_auto_hint')}</p>
      ${end ? `<div class="ticket-perf"></div><p class="muted">${t('found_at_label')}: ${fmtDate(new Date(end).toISOString())}</p>` : ''}
      <p class="muted"><a href="#/">${t('back_home')}</a></p>
    </div>
  </div>`;
}

// ============ 我的积分 ============
async function renderPoints(q) {
  const preSid = q?.get('sid') || '';
  $view.innerHTML = `
  <h3>${t('points_title')}</h3>
  <div class="card">
    <label class="field"><span>${t('points_id_label')}</span>
      <input id="p_sid" inputmode="numeric" pattern="\\d{7}" maxlength="7" value="${esc(preSid)}"></label>
    <div class="actions"><button class="btn btn-primary" id="p_query">${t('points_query')}</button></div>
    <div id="p_msg"></div>
  </div>
  <div id="p_detail"></div>`;
  document.getElementById('p_query').addEventListener('click', () => {
    const sid = document.getElementById('p_sid').value.trim();
    if (/^\d{7}$/.test(sid)) queryPoints(sid, '');
  });
  document.getElementById('p_sid').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('p_query').click(); });
  if (preSid && /^\d{7}$/.test(preSid)) queryPoints(preSid, '');
}

async function queryPoints(sid, name) {
  const msg = document.getElementById('p_msg'); const detail = document.getElementById('p_detail');
  if (!msg) return;
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { status, body } = await api(`/points/${sid}${name ? `?name=${encodeURIComponent(name)}` : ''}`);
  if (status === 404) { msg.innerHTML = errBox('NOT_FOUND', t('points_not_found')); detail.innerHTML = ''; return; }
  if (status === 403) { msg.innerHTML = errBox('FORBIDDEN', t('points_forbidden')); detail.innerHTML = ''; return; }
  if (!body.ok) { msg.innerHTML = errBox(body.error); return; }
  msg.innerHTML = `
    <div class="statbar"><span>${t('points_total')}: ${body.total}</span><span>${t('points_contrib')}: ${body.contributions}</span></div>`;
  if (body.ledger) return renderPointsFull(sid, body);
  detail.innerHTML = `
    <div class="card"><h3>${t('points_expand')}</h3>
      <label class="field"><span>${t('points_name_label')}</span><input id="p_name" maxlength="20"></label>
      <button class="btn btn-ghost" id="p_expand">${t('points_query')}</button>
      <div id="p_expandMsg"></div></div>`;
  document.getElementById('p_expand').addEventListener('click', () => {
    const nm = document.getElementById('p_name').value.trim();
    if (!nm) return;
    queryPoints(sid, nm).then(() => {});   // 403 时在 msg 区提示姓名不匹配
  });
}

function renderPointsFull(sid, body) {
  const ledger = body.ledger.length
    ? body.ledger.map((r) => `<div class="ledger-row"><span>${t('reason_' + r.reason) || r.reason} · ${fmtDate(r.created_at)}</span><span class="delta">${r.delta > 0 ? '+' : ''}${r.delta}</span></div>`).join('')
    : `<p class="muted">${t('points_ledger_empty')}</p>`;
  const redemptions = (body.redemptions || []).map((r) =>
    `<div class="ledger-row"><span>${esc(r.name)} · ${r.points_cost}${t('mall_cost')}</span><span>${t('redeem_status_' + r.status) || r.status}</span></div>`).join('');
  document.getElementById('p_detail').innerHTML = `
    <div class="card"><h3>${t('points_ledger_title')}</h3>${ledger}</div>
    ${redemptions ? `<div class="card"><h3>${t('redeem_ok')}</h3>${redemptions}</div>` : ''}
    <div class="card" id="mall"></div>`;
  loadMall(sid);
}

async function loadMall(sid) {
  const box = document.getElementById('mall');
  if (!box) return;
  const { body } = await api('/rewards').catch(() => ({ status: 404, body: {} }));
  if (body.ok && Array.isArray(body.rewards) && body.rewards.length) {
    box.innerHTML = `<h3>${t('points_redeem_title')}</h3>` + body.rewards.map((r) =>
      `<div class="ledger-row"><span>${esc(r.name)} · ${r.cost}${t('mall_cost')} · ${t('mall_stock')} ${r.stock}</span>
       <button class="btn btn-ghost" data-rid="${r.id}">${t('mall_redeem')}</button></div>`).join('') + `<div id="mallMsg"></div>`;
  } else {   // 契约现实：worker 未提供公开目录接口 → 退化为按编号兑换
    box.innerHTML = `<h3>${t('points_redeem_title')}</h3><p class="muted">${t('mall_fallback')}</p>
      <label class="field"><span>${t('mall_reward_id')}</span><input id="m_rid" inputmode="numeric"></label>
      <div class="actions"><button class="btn btn-ghost" id="m_go">${t('mall_redeem')}</button></div><div id="mallMsg"></div>`;
    box.querySelector('#m_go').addEventListener('click', () => {
      const rid = Number(box.querySelector('#m_rid').value);
      if (rid) doRedeem(sid, rid);
    });
    return;
  }
  box.querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', () => doRedeem(sid, Number(b.dataset.rid))));
}

async function doRedeem(sid, rewardId) {
  const msg = document.getElementById('mallMsg');
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { status, body } = await api('/redemptions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: sid, reward_id: rewardId }),
  });
  if (status === 200 && body.ok) msg.innerHTML = `<p class="ok-note">${t('redeem_ok')} · ${t('redeem_id_label')} #${body.redemption_id}</p>`;
  else msg.innerHTML = errBox(body.error, t('error_generic'));
}

// —— 公示入口错误态（保留统计条/筛选，顶部提示）——
function renderHomeish(message) {
  $view.innerHTML = `<div class="card"><p class="empty">${esc(message)}</p><p class="muted" style="text-align:center"><a href="#/">${t('back_home')}</a></p></div>`;
}

// —— Service Worker ——
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

applyStaticTexts();
router();
