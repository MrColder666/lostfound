// src/api/report.js —— 登记即入库（全凭自觉：无凭证码，直接分配格位；§4.1 简化）
import { checkImage } from '../lib/image.js';
const HIGH = new Set(['electronics', 'card']);
export const tierOf = (category) => (HIGH.has(category) ? 'high' : 'normal');
const SLOT_COUNT = (env) => Number(env.SLOT_COUNT || 12);
async function occupiedSlots(db) {
  const r = await db.prepare("SELECT slot_no FROM items WHERE slot_no IS NOT NULL AND status IN ('in_stock','claim_pending','ready')").all();
  return new Set(r.results.map(x => x.slot_no));
}
export async function report(db, env, req) {
  const form = await req.formData();
  const get = (k) => String(form.get(k) ?? '').trim();
  const title = get('title'), desc = get('description'), category = get('category'),
        location = get('location'), sid = get('student_id'), name = get('name'),
        cls = get('class'), vq = get('verify_q'), va = get('verify_a');
  if (!/^\d{7}$/.test(sid)) return Response.json({ ok: false, error: 'BAD_STUDENT_ID' }, { status: 400 });
  if (!title || !category || !location)
    return Response.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
  // 身份 upsert（轻量身份，不注册）
  await db.prepare('INSERT INTO identities(student_id,name,class) VALUES (?,?,?) ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, class=excluded.class')
    .bind(sid, name, cls).run();
  // 照片（可选）：Canvas 前端已去 Exif；后端 Magic Byte + ≤1MB 兜底
  let photoPath = null;
  const file = form.get('photo');
  if (file && typeof file === 'object') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chk = checkImage(bytes);
    if (!chk.ok) return Response.json({ ok: false, error: chk.error }, { status: 400 });
    photoPath = `photos/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${chk.kind === 'png' ? 'png' : 'jpg'}`;
    await env.PHOTOS?.put(photoPath, bytes);   // R2 可选绑定；无 R2 时仅存路径占位
  }
  const now = new Date();
  const iso = now.toISOString();
  const code = `LF-${now.getUTCFullYear()}-${String(now.getTime()).slice(-4)}${String(Math.floor(Math.random() * 10))}`;
  // created_at/updated_at 显式写 JS UTC ISO（带 T）——避免 SQLite datetime('now') 空格格式被按本地时区解析
  // verify_q/verify_a 改为可选（全凭自觉：不做强制核验门槛）
  const ins = await db.prepare(`INSERT INTO items(code,title,description,category,location,photo_path,verify_q,verify_a,value_tier,status,registered_by,registered_via,found_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'registered',?,?,?,?,?)`)
    .bind(code, title, desc, category, location, photoPath, vq || null, va || null, tierOf(category),
          sid, get('via') === 'kiosk' ? 'kiosk' : 'phone',
          iso, iso, iso).run();
  // 登记即入库：乐观锁循环分配最小空闲格（原 confirm-drop 的动态分格并入本端点）
  const itemId = ins.meta.last_row_id;
  const used = await occupiedSlots(db);
  let slot = null;
  for (let n = 1; n <= SLOT_COUNT(env); n++) {
    if (used.has(n)) continue;
    const r = await db.prepare("UPDATE items SET slot_no=?, status='in_stock', updated_at=? WHERE id=? AND status='registered' AND slot_no IS NULL")
      .bind(n, iso, itemId).run();
    if (r.meta.changes === 1) { slot = n; break; }
  }
  if (!slot) return Response.json({ ok: false, error: 'SLOTS_FULL' }, { status: 507 });
  return Response.json({ ok: true, code, slot_no: slot });
}
