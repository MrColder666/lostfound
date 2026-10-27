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
const CAT_GLYPH = { electronics: '🎧', card: '🪪', clothing: '🧥', book: '📘', other: '📦' };
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
const photoSrc = (p) => !p ? '' : (p.startsWith('/') || p.startsWith('http') ? p : '/api/photos/' + p);
const catGlyph = (c) => CAT_GLYPH[c] || CAT_GLYPH.other;
function timeAgo(iso) {
  const t0 = Date.parse(iso);
  if (!t0) return '';
  const m = Math.max(0, Math.round((Date.now() - t0) / 60000));
  if (m < 1) return t('ago_now');
  if (m < 60) return t('ago_m').replace('{n}', m);
  const h = Math.round(m / 60);
  if (h < 48) return t('ago_h').replace('{n}', h);
  return t('ago_d').replace('{n}', Math.round(h / 24));
}
const statusBadge = (s) => `<span class="status ${STATUS_CLS[s] || ''}">${t(STATUS_KEY[s] || 'status_registered')}</span>`;
const errBox = (code, fallback) => `<p class="err">${esc(t('err_' + code) !== 'err_' + code ? t('err_' + code) : (fallback || t('error_generic')))}</p>`;

// 缩略图：有照片用照片，没有照片用分类 glyph 占位（永不空白）
function thumbHtml(item, cls = '') {
  const src = photoSrc(item.photo_path);
  const cat = esc(item.category || 'other');
  return src
    ? `<div class="thumb ${cls}" data-cat="${cat}"><img src="${esc(src)}" alt="${esc(item.title)}" loading="lazy" decoding="async">`
      + `<span class="slot-plate">${String(item.slot_no ?? '—').padStart(2, '0')}</span></div>`
    : `<div class="thumb thumb-empty cat-${cat} ${cls}" data-cat="${cat}"><span class="thumb-glyph" aria-hidden="true">${catGlyph(item.category)}</span>`
      + `<span class="slot-plate">${String(item.slot_no ?? '—').padStart(2, '0')}</span></div>`;
}

// 图片 404 / 解码失败 → 就地降级成分类占位，绝不出现破图图标
function wireThumbs(root) {
  root.querySelectorAll('.thumb img, .rack-cell img').forEach((img) => {
    if (img.dataset.wired) return;
    img.dataset.wired = '1';
    img.addEventListener('error', () => {
      const box = img.parentElement;
      if (!box) return;
      const glyph = catGlyph(box.dataset.cat);
      img.remove();
      box.classList.add('thumb-empty');
      if (!box.querySelector('.thumb-glyph, .rack-glyph')) {
        const s = document.createElement('span');
        s.className = box.classList.contains('rack-cell') ? 'rack-glyph' : 'thumb-glyph';
        s.setAttribute('aria-hidden', 'true');
        s.textContent = glyph;
        box.prepend(s);
      }
    });
  });
}

// —— v2.1.0 动效层：滚动进场 + 数字滚动 + 路由淡入 + 顶栏阴影 ——
const REDUCE_MOTION = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function runCount(el) {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target)) return;
  if (el.dataset.counted === '1' || REDUCE_MOTION()) return;
  el.dataset.counted = '1';
  const suffix = el.dataset.suffix || '';
  const dur = 900;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);          // easeOutCubic
    el.textContent = Math.round(target * eased) + suffix;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target + suffix;
  };
  el.textContent = '0' + suffix;
  requestAnimationFrame(tick);
}

function initMotion(root = $view) {
  if (!root) return;
  // 路由淡入
  root.classList.remove('view-enter');
  void root.offsetWidth;
  root.classList.add('view-enter');

  const reduce = REDUCE_MOTION();
  const revealSel = '.impact-tile, .how-card, .item-card, .shop-card, .reunited, .claim-media, .claim-main, .board-head, .report-rows > .card, .ticket';
  const nodes = [...root.querySelectorAll(revealSel)];
  const counts = [...root.querySelectorAll('[data-count]')];

  // 进场动画结束后把 .will-reveal 摘掉，避免它的 transform 压过 :hover 位移
  const delayMs = (el) => {
    const raw = getComputedStyle(el).transitionDelay || '0s';
    return raw.split(',').map((v) => v.trim()).filter(Boolean)
      .map((v) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000))
      .reduce((a, b) => Math.max(a, b), 0) || 0;
  };
  const reveal = (el) => {
    el.classList.add('is-in');
    setTimeout(() => {
      el.classList.remove('will-reveal', 'is-in');
      el.style.removeProperty('--reveal-delay');
    }, 480 + delayMs(el));
  };

  if (reduce || !('IntersectionObserver' in window)) {
    nodes.forEach((el) => el.classList.add('is-in'));
    counts.forEach(runCount);
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      reveal(e.target);
      if (e.target.dataset && e.target.dataset.count) runCount(e.target);
      e.target.querySelectorAll?.('[data-count]').forEach(runCount);
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });

  nodes.forEach((el, i) => {
    el.classList.add('will-reveal');
    el.style.setProperty('--reveal-delay', `${Math.min(i, 8) * 55}ms`);
    io.observe(el);
  });
  counts.forEach((el) => io.observe(el));
  // 兜底：动画/观察器异常时 1.6s 内全部可见
  setTimeout(() => {
    nodes.forEach((el) => { if (!el.classList.contains('is-in')) reveal(el); });
    counts.forEach((el) => { if (el.dataset.counted !== '1') runCount(el); });
  }, 1600);
}

// 顶栏滚动阴影
(function topbarShadow() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const onScroll = () => bar.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

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
    ${thumbHtml(i)}
    <div class="item-body">
      <div class="meta"><span>${t('cat_' + (i.category || 'other'))}</span><span class="muted">${timeAgo(i.found_at)}</span></div>
      <div class="item-title">${esc(i.title)}</div>
      <div class="muted clamp2">${esc(i.description || '')}</div>
      <div class="item-foot">
        <span class="loc">${esc(i.location || '')}</span>
        ${statusBadge(i.status)}
      </div>
    </div>
  </a>`;

// 橱柜可视化：右侧「Locker B」实时格位墙（用真实照片，空位留白）
function rackHtml(items, stats) {
  const cells = [];
  const show = items.slice(0, 6);
  for (const i of show) {
    const src = photoSrc(i.photo_path);
    cells.push(`<a class="rack-cell" href="#/claim/${i.id}" data-cat="${esc(i.category || 'other')}" title="${esc(i.title)}">
      ${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`
        : `<span class="rack-glyph" aria-hidden="true">${catGlyph(i.category)}</span>`}
      <span class="rack-no">${String(i.slot_no ?? '—').padStart(2, '0')}</span></a>`);
  }
  for (let k = show.length; k < 6; k++) cells.push(`<div class="rack-cell is-empty"><span class="rack-empty-txt">${t('rack_empty')}</span></div>`);
  const occupied = stats?.occupied ?? show.length;
  const slots = stats?.slots ?? 24;
  const more = Math.max(0, occupied - show.length);
  return `<div class="rack" aria-label="${t('rack_title')}">
    <div class="rack-head"><span class="rack-title">${t('rack_title')}</span><span class="rack-live"><i></i>${t('rack_live')}</span></div>
    <div class="rack-grid">${cells.join('')}</div>
    <div class="rack-foot">${t('rack_more').replace('{n}', Math.max(0, slots - show.length))}</div>
  </div>`;
}

function unitHtml(hours) {
  if (hours == null) return t('impact_none');
  if (hours < 1) return t('unit_less_hour');
  if (hours < 48) return `${Math.round(hours)}${t('unit_hours')}`;
  return `${Math.round(hours / 24)}${t('unit_days')}`;
}

// count-up 需要把「25h」拆成 数值 + 后缀
function countParts(hours) {
  if (hours == null) return { text: t('impact_none'), count: null };
  if (hours < 1) return { text: t('unit_less_hour'), count: null };
  if (hours < 48) return { text: `${Math.round(hours)}${t('unit_hours')}`, count: Math.round(hours), suffix: t('unit_hours') };
  return { text: `${Math.round(hours / 24)}${t('unit_days')}`, count: Math.round(hours / 24), suffix: t('unit_days') };
}

function impactHtml(s) {
  const avg = countParts(s.avg_return_hours);
  const tiles = [
    { k: 'impact_returned', text: s.returned_total, count: s.returned_total, sub: 'impact_returned_sub' },
    { k: 'impact_board', text: s.on_board, count: s.on_board, sub: 'impact_board_sub' },
    { k: 'impact_avg', text: avg.text, count: avg.count, suffix: avg.suffix || '', sub: 'impact_avg_sub' },
    { k: 'impact_points', text: s.points_awarded, count: s.points_awarded, sub: 'impact_points_sub' },
  ];
  return `<section class="impact"><h2 class="sec-h">${t('impact_h')}</h2><div class="impact-grid">
    ${tiles.map((tile) => `<div class="impact-tile">
      <div class="impact-num mono"${tile.count != null ? ` data-count="${tile.count}" data-suffix="${esc(tile.suffix || '')}"` : ''}>${esc(tile.text)}</div>
      <div class="impact-label">${t(tile.k)}</div>
      <div class="impact-sub">${t(tile.sub)}</div></div>`).join('')}
  </div></section>`;
}

function reunitedHtml(list) {
  const rows = list.length
    ? list.map((r) => {
      const h = Number(r.hours || 0);
      const dur = h < 48 ? t('reunited_in_hours').replace('{n}', Math.max(1, Math.round(h)))
        : t('reunited_in_days').replace('{n}', Math.round(h / 24));
      return `<div class="re-row">
        <span class="re-glyph" aria-hidden="true">${catGlyph(r.category)}</span>
        <span class="re-title">${esc(r.title)}</span>
        <span class="re-dur mono">${dur}</span></div>`;
    }).join('')
    : `<p class="muted">${t('reunited_empty')}</p>`;
  return `<section class="reunited"><div class="reunited-copy">
    <h2 class="sec-h">${t('reunited_h')}</h2><p class="muted">${t('reunited_sub')}</p></div>
    <div class="reunited-list">${rows}</div></section>`;
}

// 首屏骨架屏
function skeletonHtml(n = 6) {
  return `<div class="skeleton-grid" aria-busy="true" aria-label="${esc(t('loading'))}">
    ${Array.from({ length: n }).map(() => `<div class="skel-card"><div class="skel-thumb"></div><div class="skel-line"></div><div class="skel-line short"></div></div>`).join('')}
  </div>`;
}

async function renderHome(q) {
  const cat = q?.get('cat') || '';
  const query = (q?.get('q') || '').trim();
  const params = new URLSearchParams();
  if (cat) params.set('category', cat);
  if (query) params.set('q', query);
  const qs = params.toString();
  $view.innerHTML = skeletonHtml(6);
  const [listRes, statsRes, reunitedRes] = await Promise.all([
    api('/items' + (qs ? '?' + qs : '')),
    api('/stats').catch(() => ({ body: {} })),
    api('/reunited').catch(() => ({ body: {} })),
  ]);
  const items = Array.isArray(listRes.body.items) ? listRes.body.items : [];
  const stats = statsRes.body && statsRes.body.ok ? statsRes.body : {};
  const reunited = Array.isArray(reunitedRes.body.items) ? reunitedRes.body.items : [];
  const filtered = Boolean(cat || query);

  const filters = ['', ...CATS].map((c) =>
    `<button class="chip" aria-pressed="${c === cat}" data-cat="${c}">${c ? t('cat_' + c) : t('cat_all')}</button>`).join('');

  const list = items.length
    ? `<div class="layout"><div class="grid">${items.map(cardHtml).join('')}</div>
       <aside><div class="card aside-card"><h3>${t('home_aside_title')}</h3>
         <label class="field"><span>${t('home_aside_hint')}</span>
           <input id="asideSid" inputmode="numeric" pattern="\\d{7}" maxlength="7"></label>
         <button class="btn btn-primary" id="asideGo">${t('home_aside_btn')}</button>
         <p class="aside-hint muted">${t('shop_sub')}</p></div></aside></div>`
    : `<div class="card"><p class="empty">${query ? esc(t('search_none').replace('{q}', query)) : t('empty_home')}</p></div>`;

  const hero = filtered ? '' : `<section class="hero">
      <div class="hero-copy">
        <p class="hero-kicker">${t('hero_kicker')}</p>
        <h1 class="hero-title">${t('hero_title')}</h1>
        <p class="hero-sub">${t('hero_sub')}</p>
        <div class="hero-cta">
          <button class="btn btn-primary" id="heroBrowse" type="button">${t('cta_browse')}</button>
          <a class="btn btn-ghost" href="#/report">${t('gnav_report')}</a>
        </div>
        <p class="hero-note">${t('hero_note_report')}</p>
      </div>
      <div class="hero-visual">${rackHtml(items, stats)}</div>
    </section>`;

  const how = filtered ? '' : `<section class="how"><h2 class="sec-h">${t('how_h')}</h2><div class="how-grid">
      <div class="how-card"><span class="how-n">1</span><b>${t('how1_t')}</b><p>${t('how1_d')}</p></div>
      <div class="how-card"><span class="how-n">2</span><b>${t('how2_t')}</b><p>${t('how2_d')}</p></div>
      <div class="how-card"><span class="how-n">3</span><b>${t('how3_t')}</b><p>${t('how3_d')}</p></div>
    </div></section>`;

  $view.innerHTML = hero
    + (filtered ? '' : impactHtml(stats))
    + how
    + `<section id="board">
        <div class="board-head">
          <div><h2 class="sec-h">${t('board_h')}</h2>
            <p class="muted board-count">${t('board_count').replace('{n}', items.length)}</p></div>
          <form class="search" role="search" id="boardSearchForm">
            <input id="boardSearch" name="q" type="search" maxlength="40" value="${esc(query)}"
                   placeholder="${t('search_ph')}" aria-label="${t('search_ph')}">
            <button class="btn btn-primary" type="submit">${t('search_btn')}</button>
            ${query ? `<a class="btn btn-ghost search-clear" href="#/${cat ? '?cat=' + cat : ''}">${t('search_clear')}</a>` : ''}
          </form>
        </div>
        <div class="filters">${filters}</div>
        ${list}</section>`
    + (filtered ? '' : reunitedHtml(reunited));
  wireThumbs($view);

  const form = $view.querySelector('#boardSearchForm');
  if (form) form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = $view.querySelector('#boardSearch').value.trim();
    const p = new URLSearchParams();
    if (cat) p.set('cat', cat);
    if (v) p.set('q', v);
    const s = p.toString();
    location.hash = '#/' + (s ? '?' + s : '');
  });
  $view.querySelectorAll('.chip[data-cat]').forEach((b) => b.addEventListener('click', () => {
    const p = new URLSearchParams();
    if (b.dataset.cat) p.set('cat', b.dataset.cat);
    if (query) p.set('q', query);
    const s = p.toString();
    location.hash = '#/' + (s ? '?' + s : '');
  }));
  const browse = $view.querySelector('#heroBrowse');
  if (browse) browse.addEventListener('click', () => {
    const el = $view.querySelector('#board');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  });
  const go = $view.querySelector('#asideGo');
  if (go) go.addEventListener('click', () => {
    const sid = $view.querySelector('#asideSid').value.trim();
    if (/^\d{7}$/.test(sid)) location.hash = `#/shop?sid=${sid}`;   // 合并后：查积分 → 商城页
  });
  initMotion($view);
}

// ============ 登记三步（全凭自觉：提交即分配格位，无凭证码；物品请自行放入对应格） ============
function renderReport() {
  $view.innerHTML = `
  <h1 class="page-title">${t('report_title')}</h1>
  <p class="muted page-sub">${t('report_sub')}</p>
  <form id="reportForm" class="rows report-rows">
    <div class="card"><div class="step">${t('report_step1')}</div>
      <div class="photo-pick">
        <div class="photo-thumb" id="photoThumb" hidden></div>
        <div class="photo-actions">
          <label class="btn btn-ghost" for="r_photo" id="photoAddLabel">${t('photo_add')}</label>
          <input class="visually-hidden" type="file" id="r_photo" accept="image/*" capture="environment" aria-label="${t('photo_add')}">
          <button type="button" class="no-photo-btn" id="r_no_photo" aria-pressed="false">${t('no_photo_btn')}</button>
        </div>
      </div>
      <p class="muted" id="r_photo_note">${t('no_photo_note')}</p></div>
    <div class="card"><div class="step">${t('report_step2')}</div>
      <label class="field"><span>${t('report_f_title')}</span><input id="r_title" maxlength="40" required></label>
      <label class="field"><span>${t('report_f_cat')}</span><select id="r_cat">${CATS.map((c) => `<option value="${c}">${t('cat_' + c)}</option>`).join('')}</select></label>
      <label class="field"><span>${t('report_f_loc')}</span><input id="r_loc" maxlength="30" required></label>
      <label class="field"><span>${t('report_f_desc')}</span><input id="r_desc" maxlength="80"></label>
      <label class="field"><span>${t('report_f_verify')}</span><input id="r_verify" maxlength="60"></label></div>
    <div class="card"><div class="step">${t('report_step3')}</div>
      <label class="field"><span>${t('report_f_sid')}</span><input id="r_sid" inputmode="numeric" maxlength="7" placeholder="7 digits" required></label>
      <label class="field"><span>${t('report_f_name')}</span><input id="r_name" maxlength="20" required></label>
      <label class="field"><span>${t('report_f_class')}</span><input id="r_class" maxlength="10" required placeholder="e.g. 7B"></label></div>
    <button class="btn btn-primary" type="submit">${t('report_submit')}</button>
    <div id="reportMsg"></div>
  </form>`;
  document.getElementById('reportForm').addEventListener('submit', submitReport);

  // 照片：自定义按钮 + 缩略图预览；「暂无图片」是明确的二选一（该件归还少 2 分）
  const noBtn = document.getElementById('r_no_photo');
  const fileInput = document.getElementById('r_photo');
  const thumb = document.getElementById('photoThumb');
  const addLabel = document.getElementById('photoAddLabel');
  let previewUrl = '';
  const paintPhoto = (file) => {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
    if (file) {
      previewUrl = URL.createObjectURL(file);
      thumb.hidden = false;
      thumb.innerHTML = `<img src="${previewUrl}" alt="${esc(t('photo_attached'))}">`;
      addLabel.textContent = t('photo_change');
    } else {
      thumb.hidden = true;
      thumb.innerHTML = '';
      addLabel.textContent = t('photo_add');
    }
  };
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0] || null;
    if (file) {
      noBtn.setAttribute('aria-pressed', 'false');
      noBtn.textContent = t('no_photo_btn');
    }
    paintPhoto(file);
  });
  noBtn.addEventListener('click', () => {
    const on = noBtn.getAttribute('aria-pressed') !== 'true';
    noBtn.setAttribute('aria-pressed', String(on));
    noBtn.textContent = on ? t('no_photo_selected') : t('no_photo_btn');
    fileInput.disabled = on;
    if (on) { fileInput.value = ''; paintPhoto(null); }
  });
  initMotion($view);
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
  if (file) {
    try { fd.set('photo', await sanitize(file)); }
    catch {
      // 之前是静默丢掉照片：用户以为附上了，其实没有。明确告知并让他重选。
      msg.innerHTML = `<p class="err">${t('err_photo_unreadable')}</p>`;
      return;
    }
  }
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
  initMotion($view);
}

async function renderClaim(id) {
  $view.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { status, body } = await api('/items/' + encodeURIComponent(id));
  if (status !== 200 || !body.ok) return renderHomeish(t('err_ITEM_NOT_CLAIMABLE'));
  const it = body.item;
  const formHtml = it.status === 'in_stock' ? `
    <div class="card claim-card"><h3>${t('claim_q_title')}</h3>
      <p class="muted claim-intro">${t('claim_auto_hint')}</p>
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
  <a class="back-link" href="#/"><span>← ${t('back_home')}</span></a>
  <div class="claim-grid">
    <div class="claim-media">${thumbHtml(it, 'is-large')}
      <div class="claim-caption muted">${t('photo_alt')}</div>
    </div>
    <div class="claim-main">
      <div class="meta claim-meta"><span class="slot-tag">${t('slot_label')} ${String(it.slot_no ?? '—').padStart(2, '0')}</span>${statusBadge(it.status)}
        <span class="muted">${timeAgo(it.found_at)}</span></div>
      <h1 class="page-title">${esc(it.title)}</h1>
      <p class="claim-desc">${esc(it.description || '')}</p>
      <dl class="detail-list">
        <dt>${t('detail_category')}</dt><dd>${t('cat_' + (it.category || 'other'))}${it.value_tier === 'high' ? ' · ' + t('tier_high') : ''}</dd>
        <dt>${t('venue_label')}</dt><dd>${esc(it.location)}</dd>
        <dt>${t('found_at_label')}</dt><dd>${fmtDate(it.found_at)}</dd>
        <dt>${t('finder_label')}</dt><dd>${esc(it.finder_name || '')}${it.finder_class ? ' · ' + esc(it.finder_class) : ''}</dd>
      </dl>
    </div>
  </div>
  ${formHtml}`;
  wireThumbs($view);
  const form = document.getElementById('claimForm');
  if (form) form.addEventListener('submit', (ev) => submitClaim(ev, it));
  initMotion($view);
}
function renderHomeish(msg) {
  $view.innerHTML = `<div class="card"><p class="empty">${esc(msg)}</p></div>
    <a class="btn btn-primary" href="#/">${t('back_home')}</a>`;
}

async function submitClaim(ev, it) {
  ev.preventDefault();
  // 注意：这个助手接收 '#id'，必须剥掉井号再交给 getElementById
  const $ = (sel) => document.getElementById(String(sel).replace(/^#/, ''));
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
  shopState = { sid: '', name: '', balance: null };
  $view.innerHTML = `
  <h1 class="page-title">${t('shop_title')}</h1>
  <p class="muted page-sub">${t('shop_sub')}</p>
  <div class="card">
    <label class="field"><span>${t('points_id_label')}</span>
      <input id="s_sid" inputmode="numeric" pattern="\\d{7}" maxlength="7" value="${esc(preSid)}" placeholder="7 digits"></label>
    <label class="field"><span>${t('points_name_label')}</span><input id="s_name" maxlength="20" placeholder="Name"></label>
    <label class="field"><span>${t('pin_label')}</span>
      <input id="s_pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" placeholder="${t('pin_ph')}">
      <small class="muted">${t('pin_hint')}</small></label>
    <div class="actions"><button class="btn btn-primary" id="s_check">${t('shop_check')}</button></div>
    <div id="s_msg"></div>
  </div>
  <div id="shopStats"></div>
  <div id="shopLedger"></div>
  <div id="shopGrid" class="shop-grid"></div>
  <div id="shopMsg"></div>
  <div id="shopOrders"></div>`;
  document.getElementById('s_check').addEventListener('click', checkShopIdentity);
  ['s_name', 's_sid', 's_pin'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') checkShopIdentity(); });
  });
  await loadShop();
  if (preSid && /^\d{7}$/.test(preSid)) checkShopIdentity();
  initMotion($view);
}
async function checkShopIdentity() {
  const sid = document.getElementById('s_sid').value.trim();
  const name = document.getElementById('s_name').value.trim();
  const pin = document.getElementById('s_pin').value.trim();
  const msg = document.getElementById('s_msg');
  if (!/^\d{7}$/.test(sid)) { msg.innerHTML = errBox('BAD_STUDENT_ID', t('err_bad_student_id')); return; }
  if (!name && !pin) { msg.innerHTML = errBox('FORBIDDEN', t('shop_need_check')); return; }
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
  // 姓名优先（弱校验，看余额/明细）；只填 PIN 时走 PIN 校验
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (pin) params.set('pin', pin);
  const { status, body } = await api(`/points/${sid}?${params.toString()}`);
  if (status === 404) { msg.innerHTML = errBox('NOT_FOUND', t('points_not_found')); return; }
  if (status === 403) { msg.innerHTML = errBox('FORBIDDEN', t('points_forbidden')); return; }
  if (!body.ok) { msg.innerHTML = errBox(body.error); return; }
  shopState = { sid, name, balance: body.total };
  msg.innerHTML = '';
  const stats = document.getElementById('shopStats');
  if (stats) stats.innerHTML = `<div class="balance-card"><div><div class="balance-label muted">${t('shop_balance')}</div>
      <div class="balance-num mono">${body.total}</div></div>
      <div class="balance-side"><div class="balance-label muted">${t('shop_returns')}</div>
      <div class="balance-num mono">${body.contributions}</div></div></div>`;
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
  const known = shopState.balance !== null;   // 先校验身份才解锁兑换，避免点了才发现没登录
  grid.innerHTML = `${known ? '' : `<p class="muted shop-lock">${t('shop_locked')}</p>`}` + shopCatalog.map((r) => {
    const out = r.stock <= 0;
    const short = known && shopState.balance < r.cost;
    const need = short ? `${t('shop_need_more')} ${r.cost - shopState.balance}` : '';
    return `<div class="shop-card${out ? ' is-out' : ''}">
      <div class="shop-ico">${esc(r.icon || '🎁')}</div>
      <div class="shop-name">${esc(r.name)}</div>
      <div class="shop-meta"><span class="shop-cost">${r.cost}</span><span>${t('mall_cost')} · ${t('shop_stock_left')} ${r.stock}</span></div>
      ${need ? `<div class="shop-need">${need}</div>` : ''}
      <button class="btn btn-primary" data-rid="${r.id}" ${out || short || !known ? 'disabled' : ''}>${out ? t('shop_sold_out') : t('shop_redeem')}</button>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', () => redeemReward(Number(b.dataset.rid))));
}
async function redeemReward(rid) {
  const msg = document.getElementById('shopMsg');
  if (!shopState.sid) { msg.innerHTML = errBox('UNAUTHORIZED', t('shop_check')); return; }
  const rw = shopCatalog.find((x) => x.id === rid);
  const pin = document.getElementById('s_pin') ? document.getElementById('s_pin').value.trim() : '';
  if (!/^\d{4}$/.test(pin)) {
    // 兑换必须带 PIN（服务端也是硬门）——先本地拦住并明确告知
    msg.innerHTML = errBox('PIN_FORMAT', t('shop_need_pin'));
    document.getElementById('s_pin')?.focus();
    return;
  }
  msg.innerHTML = `<p class="muted">${t('loading')}</p>`;
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


// —— 启动 ——（修复：此前缺初始路由，首次打开无 # 的 URL 时空白，只能点导航触发 hashchange）
applyStaticTexts();
router();
flushQueue();
