// public/js/kiosk.js —— 五态状态机；接口以 src/api/*.js + src/worker.js 为准
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (p, opt) => fetch('/api' + p, opt).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const JSONH = { 'content-type': 'application/json' };
let lang = localStorage.getItem('lf_lang') || 'zh';

/* ---------- i18n（轻量：选择器→中英对） ---------- */
const I18N = [
  ['#btnReport b', '我捡到了东西', 'I found something'],
  ['#btnReport small', 'I found something · 拍照登记约 1 分钟', 'Found something · photo check-in, ~1 min'],
  ['#btnFind b', '我要找物品', 'I lost something'],
  ['#btnFind small', 'I lost something · 浏览公示，当场核验取走', 'Lost something · browse & verify on site'],
  ['#btnVoucher', '已有手机上的凭证码？投递确认 →', 'Have a voucher code? Confirm drop-off →'],
  ['.k-side-h', '怎么用 / How it works', 'How it works'],
  ['.k-thanks', '谢谢每一位捡到东西的同学 🙏', 'Thank you for turning things in 🙏'],
];
function applyLang() {
  for (const [sel, zh, en] of I18N) { const el = $(sel); if (el) el.textContent = lang === 'en' ? en : zh; }
}
$('#langToggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('lf_lang', lang);
  applyLang();
});

/* ---------- 状态机 ---------- */
function go(state) {
  $$('.k-state').forEach((el) => el.classList.toggle('is-active', el.dataset.state === state));
  stopCam(); stopScan();
  if (state === 'idle') { /* 空闲屏无相机 */ }
}
$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

/* toast（轻提示） */
function toast(msg, ms = 3200) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:99;background:rgba(32,41,49,.92);color:#fff;font:600 15px var(--font-ui);padding:12px 20px;border-radius:99px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms);
}

/* ---------- 时钟与离线 ---------- */
setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
function netPaint() { $('#netDot')?.classList.toggle('k-off', !navigator.onLine); $('#offlineBanner').hidden = navigator.onLine; }
addEventListener('online', netPaint); addEventListener('offline', netPaint); netPaint();

/* ---------- 相机 ---------- */
let camStream = null, camTarget = null;
async function startCam(sel) {
  const v = $(sel);
  try {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    v.srcObject = camStream; await v.play();
    camTarget = sel;
    return true;
  } catch { camTarget = null; return false; }
}
function stopCam() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null; camTarget = null;
}
function grabBlob(sel, maxSide = 1600) {
  const v = $(sel);
  if (!v.videoWidth) return null;
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

/* ---------- 扫码（jsQR，vendor 本地） ---------- */
let scanRAF = 0, scanCb = null;
function startScan(sel, cb) {
  const v = $(sel);
  scanCb = cb;
  const tick = () => {
    if (v.readyState >= 2 && v.videoWidth && window.jsQR) {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      const hit = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      if (hit && hit.data) { const d = hit.data; stopScan(); cb(String(d).replace(/\D/g, '').slice(-6)); return; }
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}
function stopScan() { if (scanRAF) cancelAnimationFrame(scanRAF); scanRAF = 0; scanCb = null; }

/* ---------- 键盘 ---------- */
function makePad(padSel, dispSel, submitSel, onSubmit) {
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
    set(v) { val = String(v).replace(/\D/g, '').slice(0, 6); render(); },
    get() { return val; },
    clear() { val = ''; render(); },
    onSubmit(fn) { submit.onclick = () => { if (val.length === 6) fn(val); }; },
  };
}

/* ---------- 流程：凭证投递确认 ---------- */
const scanPad = makePad('#scanPad', '#scanCode', '#scanSubmit', (code) => submitVoucher(code));
$('#scanSubmit').addEventListener('click', () => submitVoucher(scanPad.get()));
function openScan(mode) {
  go('scan');
  $('#scanTitle').textContent = mode === 'pickup' ? '核销出库' : '投递确认';
  scanPad.clear();
  scanPad.onSubmit((code) => (mode === 'pickup' ? pickupFlow(code) : submitVoucher(code)));
  scanSubmitMode = mode;
  startCam('#scanCam').then((ok) => { $('#scanCamHint').hidden = ok; if (ok) startScan('#scanCam', (code) => (mode === 'pickup' ? pickupFlow(code) : submitVoucher(code))); });
}
let scanSubmitMode = 'voucher';
function openVoucher() {
  go('scan'); $('#scanTitle').textContent = '投递确认';
  scanSubmitMode = 'voucher'; scanPad.clear();
  scanPad.onSubmit(submitVoucher);
  startCam('#scanCam').then((ok) => { $('#scanCamHint').hidden = ok; if (ok) startScan('#scanCam', submitVoucher); });
}
async function submitVoucher(code) {
  const r = await api('/kiosk/confirm-drop', { method: 'POST', headers: JSONH, body: JSON.stringify({ drop_code: code }) });
  if (r.status === 200 && r.body.ok) {
    stopScan();
    $('#confirmSlot').textContent = `格 ${String(r.body.slot_no).padStart(2, '0')}`;
    $('#confirmCode').textContent = '';
    go('confirm');
  } else if (r.status === 410) { toast('凭证已过期（15 分钟）—— 请重新登记'); scanPad.clear(); }
  else if (r.status === 507) { toast('投递柜已满 —— 凭证仍有效，稍后回来重扫'); scanPad.clear(); }
  else { toast('凭证码无效，请核对后重试'); scanPad.clear(); }
}

/* ---------- 流程：登记直办 ---------- */
const CATS = [['electronics', '电子数码'], ['card', '证件卡类'], ['clothing', '衣物水杯'], ['book', '书籍学习'], ['other', '其他物品']];
const COLORS = ['黑色', '白色', '蓝色', '红色', '绿色', '黄色', '粉色', '彩色'];
const LOCS = ['图书馆', '食堂', '体育馆', '操场', '走廊', '教室', '洗手间', '校门口'];
let repPhoto = null, repCat = '', repCatLabel = '', repColor = '', repLoc = '', repPane = 1;
function chipRow(sel, items, onPick) {
  const wrap = $(sel); wrap.innerHTML = '';
  for (const [val, label] of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.val = val;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      [...wrap.children].forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onPick(val, label);
    });
    wrap.appendChild(b);
  }
}
function repSummaryPaint() {
  $('#repSummary').textContent = [
    repPhoto ? `📷 照片已拍` : '📷 照片未拍',
    repCatLabel ? `类别：${repColor}${repCatLabel}` : '类别：未选',
    repLoc ? `地点：${repLoc}` : '地点：未选',
    $('#repVerify').value ? '核验细节：已填写' : '核验细节：未填',
    $('#repSid').value ? `学号：${$('#repSid').value}` : '学号：未填',
  ].join('\n');
}
function repPaneGo(n) {
  repPane = n;
  $$('.k-rep-pane').forEach((p) => { p.hidden = p.dataset.pane !== String(n); });
  $('#repStep').textContent = `${n}/3`;
  repSummaryPaint();
}
$('#repTo2').addEventListener('click', () => repPaneGo(2));
$$('[data-gopane]').forEach((b) => b.addEventListener('click', () => repPaneGo(Number(b.dataset.gopane))));
$('#repVerify').addEventListener('input', repSummaryPaint);
$('#repSid').addEventListener('input', () => { repSummaryPaint(); $('#repSubmit').disabled = !(/^\d{7}$/.test($('#repSid').value) && $('#repName').value.trim() && $('#repClass').value.trim()); });
$('#repName').addEventListener('input', () => $('#repSid').dispatchEvent(new Event('input')));
$('#repClass').addEventListener('input', () => $('#repSid').dispatchEvent(new Event('input')));
$('#btnReport').addEventListener('click', async () => {
  go('report'); repPaneGo(1);
  chipRow('#repCat', CATS, (v, l) => { repCat = v; repCatLabel = l; repSummaryPaint(); checkRep2(); });
  chipRow('#repColor', COLORS.map((c) => [c, c]), (v) => { repColor = v; repSummaryPaint(); checkRep2(); });
  chipRow('#repLoc', LOCS.map((c) => [c, c]), (v) => { repLoc = v; repSummaryPaint(); checkRep2(); });
  const ok = await startCam('#repCam');
  $('#repCamHint').textContent = ok ? '点击「拍照」留存物品照片' : '相机不可用 —— 请确认摄像头权限后重试';
});
function checkRep2() { $('#repTo3').disabled = !(repCat && repColor && repLoc && $('#repVerify').value.trim()); }
$('#repVerify').addEventListener('input', checkRep2);
$('#repShot').addEventListener('click', async () => {
  if (camTarget !== '#repCam') { toast('相机未就绪'); return; }
  const blob = await grabBlob('#repCam');
  if (!blob) { toast('取景失败，请重试'); return; }
  repPhoto = new File([blob], 'item.jpg', { type: 'image/jpeg' });
  $('#repShot').textContent = '📷 重拍';
  $('#repRetake').hidden = false;
  $('#repTo2').disabled = false;
  toast('照片已留存 ✓');
});
$('#repRetake').addEventListener('click', () => { repPhoto = null; $('#repTo2').disabled = true; });
$('#repSubmit').addEventListener('click', async () => {
  $('#repSubmit').disabled = true;
  try {
    const fd = new FormData();
    fd.set('title', `${repColor}${repCatLabel}`);
    fd.set('description', `现场直办登记 · ${repLoc}`);
    fd.set('category', repCat);
    fd.set('location', repLoc);
    fd.set('student_id', $('#repSid').value.trim());
    fd.set('name', $('#repName').value.trim());
    fd.set('class', $('#repClass').value.trim());
    fd.set('verify_q', '请描述一个只有失主才知道的细节');
    fd.set('verify_a', $('#repVerify').value.trim());
    fd.set('via', 'kiosk');
    if (repPhoto) fd.set('photo', repPhoto);
    const reg = await (await api('/report', { method: 'POST', body: fd })).body;
    if (!reg.ok) { toast(reg.error === 'BAD_STUDENT_ID' ? '学号应为 7 位数字' : '登记失败，请重试'); $('#repSubmit').disabled = false; return; }
    const drop = await api('/kiosk/confirm-drop', { method: 'POST', headers: JSONH, body: JSON.stringify({ drop_code: reg.drop_code }) });
    if (drop.status !== 200 || !drop.body.ok) { toast(drop.status === 507 ? '投递柜已满 —— 请联系管理员' : '入库失败，请重试'); $('#repSubmit').disabled = false; return; }
    $('#confirmSlot').textContent = `格 ${String(drop.body.slot_no).padStart(2, '0')}`;
    $('#confirmCode').textContent = `NO. ${reg.code}`;
    go('confirm');
  } finally { $('#repSubmit').disabled = false; }
});
$('#confirmDone').addEventListener('click', () => {
  $('#doneMsg').textContent = '已入库，谢谢您！';
  $('#doneSub').textContent = '物品已上公示列表 —— 被认领后积分将自动发放';
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
    ? findItems.map((it) => `
      <button class="k-find-card" data-id="${it.id}">
        <b>${esc(it.title)}</b>
        <span class="meta">${esc(it.location)} · ${esc(String(it.found_at).slice(5, 10))}</span>
        <span class="slot-tag mono">格 ${String(it.slot_no ?? 0).padStart(2, '0')}</span>
      </button>`).join('')
    : '<p class="k-hint">暂无在公示的失物 —— 稍后再来看看</p>';
  $$('.k-find-card').forEach((c) => c.addEventListener('click', () => selectItem(Number(c.dataset.id), c)));
}
function selectItem(id, cardEl) {
  findSel = findItems.find((x) => x.id === id);
  $$('.k-find-card').forEach((c) => c.classList.toggle('is-sel', c === cardEl));
  $('#findDetail').innerHTML = `
    <div class="k-label">你选的是</div>
    <h3 style="font:900 22px var(--font-ui)">${esc(findSel.title)}</h3>
    <p class="k-hint">${esc(findSel.location)} · 捡到者：${esc(findSel.finder_name ?? '')} ${esc(findSel.finder_class ?? '')}</p>
    <div class="k-label">核验：回答一个只有失主知道的细节</div>
    <p class="k-hint" style="margin-top:0">登记人写的核验问题是 —— 「${esc(findSel.verify_q ?? '描述物品的非公开细节')}」</p>
    <input class="k-input" id="claimAnswer" placeholder="你的答案">
    <div class="k-label">你的学号 / 姓名 / 班级</div>
    <input class="k-input mono k-biginput" id="claimSid" inputmode="numeric" maxlength="7" placeholder="7 位数字">
    <input class="k-input" id="claimName" placeholder="姓名" style="margin-top:8px">
    <input class="k-input" id="claimClass" placeholder="如 7(3)" style="margin-top:8px">
    <button class="k-btn k-primary k-wide" id="claimGo" style="margin-top:14px">提交认领</button>`;
  $('#claimGo').addEventListener('click', submitClaim);
}
async function submitClaim() {
  const answer = $('#claimAnswer').value.trim();
  const sid = $('#claimSid').value.trim();
  if (!answer || !/^\d{7}$/.test(sid) || !$('#claimName').value.trim() || !$('#claimClass').value.trim()) { toast('请把核验答案和身份信息填全'); return; }
  const r = await api('/claims', { method: 'POST', headers: JSONH, body: JSON.stringify({
    code: findSel.code, student_id: sid, name: $('#claimName').value.trim(),
    class: $('#claimClass').value.trim(), verify_answer: answer }) });
  if (r.status === 200 && r.body.ok) {
    if (r.body.pickup_code) { toast('核验通过 —— 请在出库页完成取走'); pickupEntry(r.body.pickup_code); }
    else if (r.body.status === 'pending') { $('#doneMsg').textContent = '申请已受理'; $('#doneSub').textContent = '物品处于冷冻期，到点后自动核验，请稍后再来'; go('done'); }
    else { $('#doneMsg').textContent = '已转人工复核'; $('#doneSub').textContent = '管理员会尽快处理，请留意公示状态'; go('done'); }
  } else { toast(r.body.error === 'ITEM_NOT_CLAIMABLE' ? '该物品当前不可认领' : '提交失败，请重试'); }
}

/* ---------- 流程：核销出库 ---------- */
const pickPad = makePad('#pickPad', '#pickCode', '#pickVerify', (code) => pickupFlow(code));
$('#pickVerify').addEventListener('click', () => pickupFlow(pickPad.get()));
function pickupEntry(code) {
  go('pickup'); pickPad.set(code);
  pickupFlow(code);
}
async function pickupFlow(code) {
  const r = await api('/kiosk/verify-pickup', { method: 'POST', headers: JSONH, body: JSON.stringify({ pickup_code: code }) });
  if (r.status !== 200 || !r.body.ok) { toast(r.status === 410 ? '领取码已过期，请重新申请' : '领取码无效'); pickPad.clear(); return; }
  const c = r.body.claim;
  $('#pickInfo').innerHTML = `
    <div class="k-label">认领信息 · 核验通过</div>
    <h3 style="font:900 22px var(--font-ui)">${esc(c.title)}</h3>
    <p class="k-hint">${esc(c.location)} · ${esc(String(c.found_at).slice(5, 10))} 入库</p>
    <span class="slot-tag mono" style="font-size:16px">格 ${String(c.slot_no ?? 0).padStart(2, '0')}</span>
    <button class="k-btn k-primary k-wide" id="pickOut" style="margin-top:auto">确认出库 · 拍照存证</button>
    <p class="k-hint">出库后积分自动发放给捡到者</p>`;
  $('#pickOut').addEventListener('click', () => doFulfill(code));
  $('#evidenceWrap').hidden = false;
}
async function doFulfill(code) {
  const ok = await startCam('#pickCam');
  if (!ok) { toast('相机不可用，无法存证'); return; }
  $('#evidenceWrap').hidden = false;
  $('#pickShot').onclick = null;
  $('#pickShot').addEventListener('click', async () => {
    const blob = await grabBlob('#pickCam');
    if (!blob) { toast('取景失败，请重试'); return; }
    const fd = new FormData();
    fd.set('pickup_code', code);
    fd.set('photo', new File([blob], 'evidence.jpg', { type: 'image/jpeg' }));
    const r = await api('/kiosk/fulfill', { method: 'POST', body: fd });
    if (r.status === 200 && r.body.ok) {
      $('#evidenceWrap').hidden = true;
      $('#doneMsg').textContent = '已出库，请取走物品';
      $('#doneSub').textContent = r.body.points_granted > 0
        ? `捡到者积分 +${r.body.points_granted} 已发放${r.body.capped ? '（已达本月上限，未足额）' : ''}`
        : '捡到者已达本月积分上限，本次未发放';
      go('done');
    } else if (r.status === 409) { toast('该单已被核销'); $('#evidenceWrap').hidden = true; }
    else { toast(r.body.error === 'TOO_LARGE' ? '照片过大' : '出库失败，请重试'); }
  }, { once: true });
  $('#pickCancel').onclick = () => { $('#evidenceWrap').hidden = true; };
}

/* ---------- 启动 ---------- */
applyLang();
netPaint();
