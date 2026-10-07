// public/js/kiosk.js —— 五态状态机；接口以 src/api/*.js + src/worker.js 为准；文案走共享 i18n 词典（默认 EN）
import { t, getLang } from './i18n-inline.js';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (p, opt) => fetch('/api' + p, opt).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const JSONH = { 'content-type': 'application/json' };
const NL = String.fromCharCode(10);
let lang = getLang();

/* ---------- i18n ---------- */
function applyStaticTexts() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}
/* ---------- 状态机 ---------- */
function go(state) {
  $$('.k-state').forEach((el) => el.classList.toggle('is-active', el.dataset.state === state));
  stopCam(); stopScan();
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

/* ---------- 扫码（jsQR，vendor 本地） ---------- */
let scanRAF = 0;
function startScan(sel, cb) {
  const v = $(sel);
  const tick = () => {
    if (v.readyState >= 2 && v.videoWidth && window.jsQR) {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      const hit = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      if (hit && hit.data) {
        const digits = String(hit.data).match(/[0-9]/g) || [];
        stopScan(); cb(digits.join('').slice(-6)); return;
      }
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}
function stopScan() { if (scanRAF) cancelAnimationFrame(scanRAF); scanRAF = 0; }

/* ---------- 键盘 ---------- */
function makePad(padSel, dispSel, submitSel) {
  let val = '';
  const disp = $(dispSel), submit = $(submitSel);
  const render = () => { disp.textContent = val.padEnd(6, '·'); submit.disabled = val.length !== 6; };
  const pad = $(padSel);
  pad.innerHTML = '';
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '']) {
    const b = document.createElement('button');
    b.type = 'button';
    if (d === '') { b.disabled = true; b.style.visibility = 'hidden'; }
    else {
      b.textContent = d;
      b.addEventListener('click', () => {
        val = d === '⌫' ? val.slice(0, -1) : (val + d).slice(0, 6);
        render();
      });
    }
    pad.appendChild(b);
  }
  render();
  return {
    set(v) { val = String(v).replace(/[^0-9]/g, '').slice(0, 6); render(); },
    get() { return val; },
    clear() { val = ''; render(); },
    onSubmit(fn) { submit.onclick = () => { if (val.length === 6) fn(val); }; },
  };
}

/* ---------- 流程：凭证投递确认 ---------- */
const scanPad = makePad('#scanPad', '#scanCode', '#scanSubmit');
$('#scanSubmit').addEventListener('click', () => submitVoucher(scanPad.get()));
let scanSubmitMode = 'voucher';
function openScan(mode) {
  go('scan');
  $('#scanTitle').textContent = mode === 'pickup' ? t('k_pickup_title') : t('k_drop_title');
  scanPad.clear();
  scanPad.onSubmit((code) => (mode === 'pickup' ? pickupFlow(code) : submitVoucher(code)));
  scanSubmitMode = mode;
  startCam('#scanCam').then((ok) => { $('#scanCamHint').hidden = ok; if (ok) startScan('#scanCam', (code) => (mode === 'pickup' ? pickupFlow(code) : submitVoucher(code))); });
}
function openVoucher() {
  go('scan'); $('#scanTitle').textContent = t('k_drop_title');
  scanSubmitMode = 'voucher'; scanPad.clear();
  scanPad.onSubmit(submitVoucher);
  startCam('#scanCam').then((ok) => { $('#scanCamHint').hidden = ok; if (ok) startScan('#scanCam', submitVoucher); });
}
let lastSlot = null, lastCode = '';
function setSlot(n, code) {
  lastSlot = n; lastCode = code || '';
  $('#confirmSlot').textContent = t('k_slot') + ' ' + String(n).padStart(2, '0');
  $('#confirmCode').textContent = lastCode;
}
async function submitVoucher(code) {
  const r = await api('/kiosk/confirm-drop', { method: 'POST', headers: JSONH, body: JSON.stringify({ drop_code: code }) });
  if (r.status === 200 && r.body.ok) {
    stopScan();
    setSlot(r.body.slot_no, '');
    go('confirm');
  } else if (r.status === 410) { toast(t('k_toast_expired')); scanPad.clear(); }
  else if (r.status === 507) { toast(t('k_toast_full')); scanPad.clear(); }
  else { toast(t('k_toast_bad_code')); scanPad.clear(); }
}

/* ---------- 流程：登记直办 ---------- */
const CAT_KEYS = ['electronics', 'card', 'clothing', 'book', 'other'];
const COLOR_KEYS = ['k_col_black', 'k_col_white', 'k_col_blue', 'k_col_red', 'k_col_green', 'k_col_yellow', 'k_col_pink', 'k_col_multi'];
const LOC_KEYS = ['k_loc_library', 'k_loc_cafeteria', 'k_loc_gym', 'k_loc_field', 'k_loc_hallway', 'k_loc_classroom', 'k_loc_restroom', 'k_loc_gate'];
let repPhoto = null, repCat = '', repCatLabel = '', repColorKey = '', repColor = '', repLocKey = '', repLoc = '', repPane = 1;
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
}
function buildReportChips() {
  chipRow('#repCat', CAT_KEYS.map((k) => [k, t('cat_' + k)]), (v, l) => { repCat = v; repCatLabel = l; repSummaryPaint(); checkRep2(); });
  chipRow('#repColor', COLOR_KEYS.map((k) => [k, t(k)]), (v, l) => { repColorKey = v; repColor = l; repSummaryPaint(); checkRep2(); });
  chipRow('#repLoc', LOC_KEYS.map((k) => [k, t(k)]), (v, l) => { repLocKey = v; repLoc = l; repSummaryPaint(); checkRep2(); });
  restoreChips();
}
function composeTitle() {
  return lang === 'en' ? (repColor + ' ' + repCatLabel) : (repColor + repCatLabel);
}
function repSummaryPaint() {
  $('#repSummary').textContent = [
    repPhoto ? t('k_sum_photo_yes') : t('k_sum_photo_no'),
    (repCatLabel || repColor) ? t('k_sum_cat') + composeTitle() : t('k_sum_cat') + t('k_sum_none'),
    repLoc ? t('k_sum_loc') + repLoc : t('k_sum_loc') + t('k_sum_none'),
    $('#repVerify').value ? t('k_sum_verify_yes') : t('k_sum_verify_no'),
    $('#repSid').value ? t('k_sum_sid') + $('#repSid').value : t('k_sum_sid') + t('k_sum_none'),
  ].join(NL);
}
function repPaneGo(n) {
  repPane = n;
  $$('.k-rep-pane').forEach((p) => { p.hidden = p.dataset.pane !== String(n); });
  $('#repStep').textContent = n + '/3';
  repSummaryPaint();
}
$('#repTo2').addEventListener('click', () => repPaneGo(2));
$$('[data-gopane]').forEach((b) => b.addEventListener('click', () => repPaneGo(Number(b.dataset.gopane))));
$('#repVerify').addEventListener('input', () => { repSummaryPaint(); checkRep2(); });
$('#repSid').addEventListener('input', () => { repSummaryPaint(); $('#repSubmit').disabled = !(/^[0-9]{7}$/.test($('#repSid').value) && $('#repName').value.trim() && $('#repClass').value.trim()); });
$('#repName').addEventListener('input', () => $('#repSid').dispatchEvent(new Event('input')));
$('#repClass').addEventListener('input', () => $('#repSid').dispatchEvent(new Event('input')));
$('#btnReport').addEventListener('click', async () => {
  go('report'); repPaneGo(1); buildReportChips();
  const ok = await startCam('#repCam');
  $('#repCamHint').textContent = ok ? t('k_cam_hint_ok') : t('k_cam_hint_bad');
  $('#repCamHint').hidden = ok;
});
function checkRep2() { $('#repTo3').disabled = !(repCat && repColor && repLoc && $('#repVerify').value.trim()); }
$('#repShot').addEventListener('click', async () => {
  if (camTarget !== '#repCam') { toast(t('k_toast_cam_not_ready')); return; }
  const blob = await grabBlob('#repCam');
  if (!blob) { toast(t('k_toast_capture_fail')); return; }
  repPhoto = new File([blob], 'item.jpg', { type: 'image/jpeg' });
  $('#repShot').textContent = t('k_shot_again');
  $('#repRetake').hidden = false;
  $('#repTo2').disabled = false;
  toast(t('k_toast_photo_saved'));
});
$('#repRetake').addEventListener('click', () => { repPhoto = null; $('#repTo2').disabled = true; $('#repShot').textContent = t('k_shot'); });
$('#repSubmit').addEventListener('click', async () => {
  $('#repSubmit').disabled = true;
  try {
    const fd = new FormData();
    fd.set('title', composeTitle());
    fd.set('description', t('k_kiosk_desc') + ' · ' + repLoc);
    fd.set('category', repCat);
    fd.set('location', repLoc);
    fd.set('student_id', $('#repSid').value.trim());
    fd.set('name', $('#repName').value.trim());
    fd.set('class', $('#repClass').value.trim());
    fd.set('verify_q', t('k_verify_q_std'));
    fd.set('verify_a', $('#repVerify').value.trim());
    fd.set('via', 'kiosk');
    if (repPhoto) fd.set('photo', repPhoto);
    const reg = await (await api('/report', { method: 'POST', body: fd })).body;
    if (!reg.ok) { toast(reg.error === 'BAD_STUDENT_ID' ? t('k_toast_bad_sid') : t('k_toast_reg_fail')); $('#repSubmit').disabled = false; return; }
    const drop = await api('/kiosk/confirm-drop', { method: 'POST', headers: JSONH, body: JSON.stringify({ drop_code: reg.drop_code }) });
    if (drop.status !== 200 || !drop.body.ok) { toast(drop.status === 507 ? t('k_toast_full_admin') : t('k_toast_drop_fail')); $('#repSubmit').disabled = false; return; }
    setSlot(drop.body.slot_no, 'NO. ' + reg.code);
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
    + '<button class="k-btn k-primary k-wide" id="claimGo" style="margin-top:14px" type="button">' + t('k_claim_submit') + '</button>';
  $('#claimGo').addEventListener('click', submitClaim);
}
async function submitClaim() {
  const answer = $('#claimAnswer').value.trim();
  const sid = $('#claimSid').value.trim();
  if (!answer || !/^[0-9]{7}$/.test(sid) || !$('#claimName').value.trim() || !$('#claimClass').value.trim()) { toast(t('k_toast_fill')); return; }
  const r = await api('/claims', { method: 'POST', headers: JSONH, body: JSON.stringify({
    code: findSel.code, student_id: sid, name: $('#claimName').value.trim(),
    class: $('#claimClass').value.trim(), verify_answer: answer }) });
  if (r.status === 200 && r.body.ok) {
    if (r.body.pickup_code) { toast(t('k_claim_received')); pickupEntry(r.body.pickup_code); }
    else if (r.body.status === 'pending') { $('#doneMsg').textContent = t('k_claim_received_h'); $('#doneSub').textContent = t('k_claim_freeze_sub'); go('done'); }
    else { $('#doneMsg').textContent = t('k_claim_manual_h'); $('#doneSub').textContent = t('k_claim_manual_sub'); go('done'); }
  } else { toast(r.body.error === 'ITEM_NOT_CLAIMABLE' ? t('k_toast_not_claimable') : t('k_toast_claim_fail')); }
}

/* ---------- 流程：核销出库 ---------- */
const pickPad = makePad('#pickPad', '#pickCode', '#pickVerify');
$('#pickVerify').addEventListener('click', () => pickupFlow(pickPad.get()));
function pickupEntry(code) {
  go('pickup'); pickPad.set(code);
  pickupFlow(code);
}
async function pickupFlow(code) {
  const r = await api('/kiosk/verify-pickup', { method: 'POST', headers: JSONH, body: JSON.stringify({ pickup_code: code }) });
  if (r.status !== 200 || !r.body.ok) { toast(r.status === 410 ? t('k_toast_pickup_expired') : t('k_toast_pickup_bad')); pickPad.clear(); return; }
  const c = r.body.claim;
  $('#pickInfo').innerHTML =
    '<div class="k-label">' + t('k_pick_info_h') + '</div>'
    + '<h3 style="font:900 22px var(--font-ui)">' + esc(c.title) + '</h3>'
    + '<p class="k-hint">' + esc(c.location) + ' · ' + esc(String(c.found_at).slice(5, 10)) + '</p>'
    + '<span class="slot-tag mono" style="font-size:16px">' + t('k_slot') + ' ' + String(c.slot_no ?? 0).padStart(2, '0') + '</span>'
    + '<button class="k-btn k-primary k-wide" id="pickOut" style="margin-top:auto" type="button">' + t('k_pickup_out') + '</button>'
    + '<p class="k-hint">' + t('k_pickup_out_note') + '</p>';
  $('#pickOut').addEventListener('click', () => doFulfill(code));
  $('#evidenceWrap').hidden = false;
}
async function doFulfill(code) {
  const ok = await startCam('#pickCam');
  if (!ok) { toast(t('k_toast_no_cam')); return; }
  $('#evidenceWrap').hidden = false;
  $('#pickShot').onclick = null;
  $('#pickShot').addEventListener('click', async () => {
    const blob = await grabBlob('#pickCam');
    if (!blob) { toast(t('k_toast_capture_fail')); return; }
    const fd = new FormData();
    fd.set('pickup_code', code);
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
    else { toast(r.body.error === 'TOO_LARGE' ? t('k_toast_photo_big') : t('k_toast_fulfill_fail')); }
  }, { once: true });
  $('#pickCancel').onclick = () => { $('#evidenceWrap').hidden = true; };
}

/* ---------- 启动 ---------- */
$('#btnVoucher').addEventListener('click', openVoucher);
applyStaticTexts();
netPaint();
