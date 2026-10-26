// public/js/kiosk.js —— 五态状态机；接口以 src/api/*.js + src/worker.js 为准；文案走共享 i18n 词典（默认 EN）
import { t } from './i18n-inline.js';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (p, opt) => fetch('/api' + p, opt).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const JSONH = { 'content-type': 'application/json' };
const NL = String.fromCharCode(10);
const CAT_GLYPH = { electronics: '🎧', card: '🪪', clothing: '🧥', book: '📘', other: '📦' };
const photoSrc = (p) => !p ? '' : (p.startsWith('/') || p.startsWith('http') ? p : '/api/photos/' + p);
const thumbBlock = (it) => {
  const src = photoSrc(it.photo_path);
  return '<span class="k-thumb">'
    + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">'
      : '<span class="k-thumb-glyph" aria-hidden="true">' + (CAT_GLYPH[it.category] || CAT_GLYPH.other) + '</span>')
    + '</span>';
};

/* ---------- i18n ---------- */
function applyStaticTexts() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}
/* ---------- 状态机 ---------- */
function go(state) {
  $$('.k-state').forEach((el) => el.classList.toggle('is-active', el.dataset.state === state));
  stopCam();
}
$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

/* toast（轻提示） */
function toast(msg, ms) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:99;background:rgba(32,41,49,.92);color:#fff;font:600 15px var(--font-ui);padding:12px 20px;border-radius:99px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms || 3200);
}

function errToast(code) {
  return ({
    ITEM_NOT_CLAIMABLE: t('k_toast_not_claimable'),
    PIN_FORMAT: t('k_toast_pin_format'), PIN_INCORRECT: t('k_toast_pin_wrong'), TOO_MANY_PIN: t('k_toast_pin_many'),
    TOO_MANY_ACTIVE: t('k_toast_claim_many'), TOO_MANY_TODAY: t('k_toast_claim_today'),
    NAME_MISMATCH: t('k_toast_name_mismatch'), IDENTITY_NAME_MISMATCH: t('k_toast_name_mismatch'), IDENTITY_NOT_FOUND: t('k_toast_name_mismatch'),
    CLAIM_NOT_FOUND: t('k_toast_already'), CLAIM_EXPIRED: t('k_toast_pickup_expired'),
  })[code];
}

/* ---------- 时钟与离线 ---------- */
setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
function netPaint() { const dot = $('#netDot'); if (dot) dot.classList.toggle('k-off', !navigator.onLine); const ob = $('#offlineBanner'); if (ob) ob.hidden = navigator.onLine; }
addEventListener('online', netPaint); addEventListener('offline', netPaint);

/* ---------- 相机 ---------- */
let camStream = null, camTarget = null;
async function startCam(sel) {
  const v = $(sel);
  try {
    if (camStream) camStream.getTracks().forEach((tr) => tr.stop());
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    v.srcObject = camStream; await v.play();
    camTarget = sel;
    return true;
  } catch { camTarget = null; return false; }
}
function stopCam() {
  if (camStream) camStream.getTracks().forEach((tr) => tr.stop());
  camStream = null; camTarget = null;
}
function grabBlob(sel, maxSide) {
  const v = $(sel);
  if (!v.videoWidth) return null;
  const cap = maxSide || 1600;
  const scale = Math.min(1, cap / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

let lastSlot = null, lastCode = '';
function setSlot(n, code) {
  lastSlot = n; lastCode = code || '';
  $('#confirmSlot').textContent = t('k_slot') + ' ' + String(n).padStart(2, '0');
  $('#confirmCode').textContent = lastCode;
}
/* ---------- 流程：登记直办 ---------- */
const CAT_KEYS = ['electronics', 'card', 'clothing', 'book', 'other'];
const COLOR_KEYS = ['k_col_black', 'k_col_white', 'k_col_blue', 'k_col_red', 'k_col_green', 'k_col_yellow', 'k_col_pink', 'k_col_multi'];
const LOC_KEYS = ['k_loc_library', 'k_loc_cafeteria', 'k_loc_gym', 'k_loc_field', 'k_loc_hallway', 'k_loc_classroom', 'k_loc_restroom', 'k_loc_gate'];
let repPhoto = null, repNoPhoto = false, repCat = '', repCatLabel = '', repColorKey = '', repColor = '',
    repLocKey = '', repLoc = '', repLocOther = '', repItemName = '', repPane = 1;

// 地点文本：选 Other 时用输入框内容
function repLocationText() {
  return repLocKey === 'other' ? repLocOther.trim() : repLoc;
}
function chipRow(sel, items, onPick) {
  const wrap = $(sel); wrap.innerHTML = '';
  for (const [val, label] of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.val = val;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      const kids = Array.from(wrap.children);
      kids.forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onPick(val, label);
    });
    wrap.appendChild(b);
  }
}
function restoreChips() {
  const marks = [['#repCat', repCat], ['#repColor', repColorKey], ['#repLoc', repLocKey]];
  for (const [sel, val] of marks) {
    if (!val) continue;
    const b = $(sel).querySelector('[data-val="' + val + '"]');
    if (b) b.setAttribute('aria-pressed', 'true');
  }
  if (repLocKey === 'other') $('#repLocOther').hidden = false;
}
function buildReportChips() {
  chipRow('#repCat', CAT_KEYS.map((k) => [k, t('cat_' + k)]), (v, l) => { repCat = v; repCatLabel = l; repSummaryPaint(); checkRep2(); });
  chipRow('#repColor', COLOR_KEYS.map((k) => [k, t(k)]), (v, l) => { repColorKey = v; repColor = l; repSummaryPaint(); });
  chipRow('#repLoc', [...LOC_KEYS.map((k) => [k, t(k)]), ['other', t('k_loc_other')]], (v, l) => {
    repLocKey = v; repLoc = l;
    const isOther = v === 'other';
    $('#repLocOther').hidden = !isOther;
    if (isOther) { repLocOther = $('#repLocOther').value; $('#repLocOther').focus(); }
    repSummaryPaint(); checkRep2();
  });
  restoreChips();
}
function composeTitle() {
  const typed = repItemName.trim();
  if (typed) return typed;
  const parts = [repColor, repCatLabel].filter(Boolean);
  return parts.join(' ') || repCatLabel || 'Found item';
}
function repSummaryPaint() {
  const loc = repLocationText();
  const title = composeTitle();
  $('#repSummary').textContent = [
    repPhoto ? t('k_sum_photo_yes') : (repNoPhoto ? t('k_no_photo_selected') : t('k_sum_photo_no')),
    title ? t('k_sum_item') + title : t('k_sum_item') + t('k_sum_none'),
    loc ? t('k_sum_loc') + loc : t('k_sum_loc') + t('k_sum_none'),
    $('#repVerify').value ? t('k_sum_verify_yes') : t('k_sum_verify_no'),
    $('#repSid').value ? t('k_sum_sid') + $('#repSid').value : t('k_sum_sid') + t('k_sum_none'),
  ].join(NL);
}
function resetReportState() {
  repPhoto = null; repNoPhoto = false; repCat = ''; repCatLabel = ''; repColorKey = ''; repColor = '';
  repLocKey = ''; repLoc = ''; repLocOther = ''; repItemName = '';
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('#repVerify', ''); set('#repSid', ''); set('#repName', ''); set('#repClass', '');
  set('#repItemName', ''); set('#repLocOther', '');
  $('#repLocOther').hidden = true;
  $('#repPhotoWarn').hidden = true;
  $('#repShot').textContent = t('k_shot'); $('#repRetake').hidden = true;
  $('#repNoPhoto').setAttribute('aria-pressed', 'false');
  $('#repTo3').disabled = true; $('#repSubmit').disabled = true;
  repSummaryPaint();
}
function repPaneGo(n) {
  repPane = n;
  $$('.k-rep-pane').forEach((p) => { p.hidden = p.dataset.pane !== String(n); });
  $('#repStep').textContent = n + '/3';
  if (n !== 1) $('#repPhotoWarn').hidden = true;
  repSummaryPaint();
}
// 第 1 步的 Next 不再置灰：没选照片时先提示「无照片少 2 分」，再点一次继续
$('#repTo2').addEventListener('click', () => {
  if (repPhoto || repNoPhoto) { repPaneGo(2); return; }
  $('#repPhotoWarn').hidden = false;
  toast(t('k_photo_warn'));
});
$('#repNoPhotoGo').addEventListener('click', () => {
  repNoPhoto = true; repPhoto = null;
  $('#repNoPhoto').setAttribute('aria-pressed', 'true');
  $('#repPhotoWarn').hidden = true;
  repSummaryPaint();
  repPaneGo(2);
});
$$('[data-gopane]').forEach((b) => b.addEventListener('click', () => repPaneGo(Number(b.dataset.gopane))));
// v2.1.1 修复：第 2 步的 Next 之前从未绑定点击事件（继承自 v1.7.x 的死按钮）
$('#repTo3').addEventListener('click', () => repPaneGo(3));
$('#repVerify').addEventListener('input', () => { repSummaryPaint(); checkRep2(); });
$('#repItemName').addEventListener('input', () => { repItemName = $('#repItemName').value; repSummaryPaint(); checkRep2(); });
$('#repLocOther').addEventListener('input', () => { repLocOther = $('#repLocOther').value; repSummaryPaint(); checkRep2(); });
$('#repSid').addEventListener('input', () => { repSummaryPaint(); $('#repSubmit').disabled = !(/^[0-9]{7}$/.test($('#repSid').value) && $('#repName').value.trim() && $('#repClass').value.trim()); });
$('#repName').addEventListener('input', () => $('#repSid').dispatchEvent(new Event('input')));
$('#repClass').addEventListener('input', () => $('#repSid').dispatchEvent(new Event('input')));
$('#btnReport').addEventListener('click', async () => {
  resetReportState();
  go('report'); repPaneGo(1); buildReportChips();
  const ok = await startCam('#repCam');
  $('#repCamHint').textContent = ok ? t('k_cam_hint_ok') : t('k_cam_hint_bad');
  $('#repCamHint').hidden = ok;
});
// 第 2 步只要求「物品类型 + 地点」，物品名/颜色可留空（自动拼标题）
function checkRep2() { $('#repTo3').disabled = !(repCat && repLocationText()); }
$('#repShot').addEventListener('click', async () => {
  if (camTarget !== '#repCam') { toast(t('k_toast_cam_not_ready')); return; }
  const blob = await grabBlob('#repCam');
  if (!blob) { toast(t('k_toast_capture_fail')); return; }
  repPhoto = new File([blob], 'item.jpg', { type: 'image/jpeg' });
  repNoPhoto = false; $('#repNoPhoto').setAttribute('aria-pressed', 'false');
  $('#repPhotoWarn').hidden = true;
  $('#repShot').textContent = t('k_shot_again');
  $('#repRetake').hidden = false;
  repSummaryPaint();
  toast(t('k_toast_photo_saved'));
});
$('#repRetake').addEventListener('click', () => {
  repPhoto = null; repNoPhoto = false;
  $('#repNoPhoto').setAttribute('aria-pressed', 'false');
  $('#repShot').textContent = t('k_shot'); repSummaryPaint();
});
// 允许「暂无图片」：归还结算时该件少 2 分（照片是核验与找回效率的一部分）
$('#repNoPhoto').addEventListener('click', () => {
  repNoPhoto = true; repPhoto = null;
  $('#repNoPhoto').setAttribute('aria-pressed', 'true');
  $('#repPhotoWarn').hidden = true;
  $('#repRetake').hidden = true;
  $('#repShot').textContent = t('k_shot');
  repSummaryPaint();
});
$('#repSubmit').addEventListener('click', async () => {
  $('#repSubmit').disabled = true;
  try {
    const loc = repLocationText();
    const fd = new FormData();
    fd.set('title', composeTitle());
    fd.set('description', t('k_kiosk_desc') + ' · ' + loc + (repItemName.trim() ? ' · ' + [repColor, repCatLabel].filter(Boolean).join(' ') : ''));
    fd.set('category', repCat);
    fd.set('location', loc);
    fd.set('student_id', $('#repSid').value.trim());
    fd.set('name', $('#repName').value.trim());
    fd.set('class', $('#repClass').value.trim());
    fd.set('verify_q', t('k_verify_q_std'));
    fd.set('verify_a', $('#repVerify').value.trim());
    fd.set('via', 'kiosk');
    if (repPhoto) fd.set('photo', repPhoto);
    const reg = await (await api('/report', { method: 'POST', body: fd })).body;
    if (!reg.ok) { toast(reg.error === 'BAD_STUDENT_ID' ? t('k_toast_bad_sid') : reg.error === 'SLOTS_FULL' ? t('k_toast_full_admin') : t('k_toast_reg_fail')); $('#repSubmit').disabled = false; return; }
    setSlot(reg.slot_no, 'NO. ' + reg.code);
    go('confirm');
  } finally { $('#repSubmit').disabled = false; }
});
$('#confirmDone').addEventListener('click', () => {
  $('#doneMsg').textContent = t('k_done_stored');
  $('#doneSub').textContent = t('k_done_stored_sub');
  go('done');
});

/* ---------- 流程：认领（浏览 → 核验 → 当场取走） ---------- */
let findItems = [], findSel = null;
$('#btnFind').addEventListener('click', () => { go('find'); loadFind(); });
async function loadFind() {
  const r = await api('/items');
  findItems = r.body.items || [];
  const list = $('#findList');
  list.innerHTML = findItems.length
    ? findItems.map((it) =>
      '<button class="k-find-card" data-id="' + it.id + '">'
      + thumbBlock(it)
      + '<b>' + esc(it.title) + '</b>'
      + '<span class="meta">' + esc(it.location) + ' · ' + esc(String(it.found_at).slice(5, 10)) + '</span>'
      + '<span class="slot-tag mono">' + t('k_slot') + ' ' + String(it.slot_no ?? 0).padStart(2, '0') + '</span>'
      + '</button>').join('')
    : '<p class="k-hint">' + t('k_find_empty') + '</p>';
  $$('.k-find-card').forEach((c) => c.addEventListener('click', () => selectItem(Number(c.dataset.id), c)));
}
function selectItem(id, cardEl) {
  findSel = findItems.find((x) => x.id === id);
  $$('.k-find-card').forEach((c) => c.classList.toggle('is-sel', c === cardEl));
  $('#findDetail').innerHTML =
    '<div class="k-label">' + t('k_find_chosen') + '</div>'
    + '<h3 style="font:900 22px var(--font-ui)">' + esc(findSel.title) + '</h3>'
    + '<p class="k-hint">' + esc(findSel.location) + ' · ' + t('finder_label') + ': ' + esc(findSel.finder_name ?? '') + ' ' + esc(findSel.finder_class ?? '') + '</p>'
    + '<div class="k-label">' + t('k_find_verify_h') + '</div>'
    + '<p class="k-hint" style="margin-top:0">' + t('k_find_verify_q') + esc(findSel.verify_q ?? t('k_find_q_default')) + t('k_find_verify_q_end') + '</p>'
    + '<input class="k-input" id="claimAnswer" placeholder="' + t('k_answer_ph') + '">'
    + '<div class="k-label">' + t('k_identity') + '</div>'
    + '<input class="k-input mono k-biginput" id="claimSid" inputmode="numeric" maxlength="7" placeholder="' + t('k_sid_ph') + '">'
    + '<input class="k-input" id="claimName" placeholder="' + t('k_name_ph') + '" style="margin-top:8px">'
    + '<input class="k-input" id="claimClass" placeholder="' + t('k_class_ph') + '" style="margin-top:8px">'
    + '<input class="k-input mono" id="claimPin" inputmode="numeric" maxlength="4" placeholder="' + t('k_pin_label') + '" style="margin-top:8px">'
    + '<p class="k-hint" style="margin-top:4px">' + t('k_pin_hint') + '</p>'
    + '<button class="k-btn k-primary k-wide" id="claimGo" style="margin-top:14px" type="button">' + t('k_claim_submit') + '</button>';
  $('#claimGo').addEventListener('click', submitClaim);
}
async function submitClaim() {
  const answer = $('#claimAnswer').value.trim();
  const sid = $('#claimSid').value.trim();
  const nm = $('#claimName').value.trim();
  const pin = $('#claimPin').value.trim();
  if (!answer || !/^[0-9]{7}$/.test(sid) || !$('#claimName').value.trim() || !$('#claimClass').value.trim()) { toast(t('k_toast_fill')); return; }
  if (!/^[0-9]{4}$/.test(pin)) { toast(t('k_toast_pin_format')); return; }
  const r = await api('/claims', { method: 'POST', headers: JSONH, body: JSON.stringify({
    code: findSel.code, student_id: sid, name: nm,
    class: $('#claimClass').value.trim(), pin, verify_answer: answer }) });
  if (r.status === 200 && r.body.ok) {
    toast(t('k_claim_received'));
    handoutEntry(r.body.id, sid, nm, pin, findSel);
  } else { toast(errToast(r.body.error) || t('k_toast_claim_fail')); }
}

/* ---------- 流程：身份领取（学号 + 姓名，无需领取码） ---------- */
let pickClaims = [], pickCtx = null;
function openPickup() {
  go('pickup');
  pickClaims = []; pickCtx = null;
  $('#pickSid').value = ''; $('#pickName').value = ''; $('#pickPin').value = '';
  $('#pickInfo').innerHTML = '<p class="k-hint">' + t('k_pick_start') + '</p>';
}
$('#pickLookup').addEventListener('click', () => lookupClaimList());
$('#pickName').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupClaimList(); });
async function lookupClaimList() {
  const sid = $('#pickSid').value.trim();
  const name = $('#pickName').value.trim();
  const pin = $('#pickPin').value.trim();
  if (!/^[0-9]{7}$/.test(sid)) { toast(t('k_toast_bad_sid')); return; }
  if (!name) { toast(t('k_toast_need_name')); return; }
  if (!/^[0-9]{4}$/.test(pin)) { toast(t('k_toast_pin_format')); return; }
  const r = await api('/kiosk/lookup-claims', { method: 'POST', headers: JSONH, body: JSON.stringify({ student_id: sid, name, pin }) });
  if (!r.body.ok) { toast(errToast(r.body.error) || t('k_toast_lookup_fail')); return; }
  pickClaims = r.body.claims || [];
  pickCtx = null;
  if (!pickClaims.length) { $('#pickInfo').innerHTML = '<p class="k-hint">' + t('k_pick_none') + '</p>'; return; }
  $('#pickInfo').innerHTML = '<div class="k-label">' + t('k_pick_found') + '</div>' + pickClaims.map((c) => {
    const label = c.claimable ? t('k_pick_ready') : (c.expired ? t('k_pick_expired') : t('k_pick_wait'));
    return '<button class="k-find-card' + (c.claimable ? '' : ' is-dim') + '" data-cid="' + c.claim_id + '" type="button"' + (c.claimable ? '' : ' disabled') + '>'
      + '<b>' + esc(c.title) + '</b>'
      + '<span class="meta">' + t('k_slot') + ' ' + String(c.slot_no ?? 0).padStart(2, '0') + ' · ' + esc(label) + '</span>'
      + '</button>';
  }).join('');
  $$('#pickInfo .k-find-card:not([disabled])').forEach((b) => b.addEventListener('click', () => selectClaim(Number(b.dataset.cid), sid, name, pin)));
}
function selectClaim(cid, sid, name, pin) {
  const c = pickClaims.find((x) => x.claim_id === cid);
  if (!c) return;
  pickCtx = { claim_id: cid, student_id: sid, name, pin };
  renderHandout(c);
}
function renderHandout(c) {
  $('#pickInfo').innerHTML =
    '<div class="k-label">' + t('k_pick_info_h') + '</div>'
    + '<h3 style="font:900 22px var(--font-ui)">' + esc(c.title) + '</h3>'
    + '<p class="k-hint">' + esc(c.location ?? '') + '</p>'
    + '<span class="slot-tag mono" style="font-size:16px">' + t('k_slot') + ' ' + String(c.slot_no ?? 0).padStart(2, '0') + '</span>'
    + '<button class="k-btn k-primary k-wide" id="pickOut" style="margin-top:auto" type="button">' + t('k_pickup_out') + '</button>'
    + '<p class="k-hint">' + t('k_pickup_out_note') + '</p>';
  $('#pickOut').addEventListener('click', () => doFulfill());
}
function handoutEntry(claimId, sid, name, pin, item) {
  go('pickup');
  pickClaims = []; pickCtx = { claim_id: claimId, student_id: sid, name, pin };
  $('#pickSid').value = sid; $('#pickName').value = name; $('#pickPin').value = pin;
  renderHandout({ title: item.title, location: item.location, slot_no: item.slot_no });
}
async function doFulfill() {
  if (!pickCtx) return;
  const ok = await startCam('#pickCam');
  if (!ok) { toast(t('k_toast_no_cam')); return; }
  $('#evidenceWrap').hidden = false;
  $('#pickShot').onclick = async () => {
    const blob = await grabBlob('#pickCam');
    if (!blob) { toast(t('k_toast_capture_fail')); return; }
    const fd = new FormData();
    fd.set('claim_id', String(pickCtx.claim_id));
    fd.set('student_id', pickCtx.student_id);
    fd.set('name', pickCtx.name);
    fd.set('pin', pickCtx.pin);
    fd.set('photo', new File([blob], 'evidence.jpg', { type: 'image/jpeg' }));
    const r = await api('/kiosk/fulfill', { method: 'POST', body: fd });
    if (r.status === 200 && r.body.ok) {
      $('#evidenceWrap').hidden = true;
      $('#doneMsg').textContent = t('k_done_handed');
      $('#doneSub').textContent = r.body.points_granted > 0
        ? t('k_pts_awarded') + r.body.points_granted + t('k_pts_awarded_suf') + (r.body.capped ? t('k_points_capped') : '')
        : t('k_points_capped_note');
      go('done');
    } else if (r.status === 409) { toast(t('k_toast_already')); $('#evidenceWrap').hidden = true; }
    else if (r.status === 410) { toast(t('k_toast_pickup_expired')); $('#evidenceWrap').hidden = true; }
    else { toast(r.body.error === 'TOO_LARGE' ? t('k_toast_photo_big') : (errToast(r.body.error) || t('k_toast_fulfill_fail'))); }
  };
  $('#pickCancel').onclick = () => { $('#evidenceWrap').hidden = true; };
}

/* ---------- 空闲屏右下角：扫码打开手机版（/r 短链）---------- */
function paintQr() {
  const box = $('#kQr');
  if (!box || typeof qrcode !== 'function') return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(location.origin + '/r');
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch { /* 生成失败就留空，不影响主流程 */ }
}

/* ---------- 启动 ---------- */
$('#btnPickup').addEventListener('click', openPickup);
applyStaticTexts();
netPaint();
paintQr();
