// src/api/report.js —— 登记即入库（全凭自觉：无凭证码，直接分配格位）
// v1.6.0：身份首写为准 + 姓名匹配；物品码 crypto 随机；507 清理悬空行
import { checkImage } from '../lib/image.js';
import { upsertIdentitySafe } from '../lib/identity.js';
const HIGH = new Set(['electronics', 'card']);
export const tierOf = (category) => (HIGH.has(category) ? 'high' : 'normal');
const SLOT_COUNT = (env) => Number(env.SLOT_COUNT || 12);
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const itemCode = () => 'LF-' + new Date().getUTCFullYear() + '-' + [...crypto.getRandomValues(new Uint8Array(4))].map((n) => B36[n % 36]).join('');
async function occupiedSlots(db) {
  const r = await db.prepare("SELECT slot_no FROM items WHERE slot_no IS NOT NULL AND status IN ('in_stock','claim_pending','ready')").all();
  return new Set(r.results.map((x) => x.slot_no));
}
export async function report(db, env, req) {
  const form = await req.formData();
  const get = (k) => String(form.get(k) ?? '').trim();
  const title = get('title'), desc = get('description'), category = get('category'),
        location = get('location'), sid = get('student_id'), name = get('name'),
        cls = get('class'), vq = get('verify_q'), va = get('verify_a');
  if (!/^\d{7}$/.test(sid)) return Response.json({ ok: false, error: 'BAD_STUDENT_ID' }, { status: 400 });
  if (!title || !category || !location) return Response.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
  // 照片（可选）先校验，避免副作用
  let photoPath = null;
  const file = form.get('photo');
  if (file && typeof file === 'object') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chk = checkImage(bytes);
    if (!chk.ok) return Response.json({ ok: false, error: chk.error }, { status: 400 });
    photoPath = `photos/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${chk.kind === 'png' ? 'png' : 'jpg'}`;
    await env.PHOTOS?.put(photoPath, bytes, { httpMetadata: { contentType: chk.kind === 'png' ? 'image/png' : 'image/jpeg' } });
  }
  // 身份：首写为准；已存在须姓名匹配（防劫持）
  const idn = await upsertIdentitySafe(db, { student_id: sid, name, class: cls });
  if (!idn.ok) return Response.json({ ok: false, error: idn.error }, { status: 403 });
  const iso = new Date().toISOString();
  // 物品码：crypto 随机 base36×4，UNIQUE 冲突重试
  let ins = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      ins = await db.prepare(`INSERT INTO items(code,title,description,category,location,photo_path,verify_q,verify_a,value_tier,status,registered_by,registered_via,found_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'registered',?,?,?,?,?)`)
        .bind(itemCode(), title, desc, category, location, photoPath, vq || null, va || null, tierOf(category),
              sid, get('via') === 'kiosk' ? 'kiosk' : 'phone', iso, iso, iso).run();
      break;
    } catch (e) {
      if (!String(e && e.message || e).includes('UNIQUE')) throw e;
    }
  }
  if (!ins) return Response.json({ ok: false, error: 'CODE_RETRY' }, { status: 503 });
  const itemId = ins.meta.last_row_id;
  const used = await occupiedSlots(db);
  let slot = null;
  for (let n = 1; n <= SLOT_COUNT(env); n++) {
    if (used.has(n)) continue;
    const r = await db.prepare("UPDATE items SET slot_no=?, status='in_stock', updated_at=? WHERE id=? AND status='registered' AND slot_no IS NULL")
      .bind(n, iso, itemId).run();
    if (r.meta.changes === 1) { slot = n; break; }
  }
  if (!slot) {   // 格满：清理刚插入的悬空行
    await db.prepare("DELETE FROM items WHERE id=? AND status='registered'").bind(itemId).run();
    return Response.json({ ok: false, error: 'SLOTS_FULL' }, { status: 507 });
  }
  return Response.json({ ok: true, code: (await db.prepare('SELECT code FROM items WHERE id=?').bind(itemId).first()).code, slot_no: slot });
}
