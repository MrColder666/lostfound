// src/api/report.js —— 登记：生成凭证码，绝不分配格号（§4.1-2）
import { genCode, dropExpiry } from '../lib/codes.js';
import { checkImage } from '../lib/image.js';
const HIGH = new Set(['electronics', 'card']);
export const tierOf = (category) => (HIGH.has(category) ? 'high' : 'normal');
export async function report(db, env, req) {
  const form = await req.formData();
  const get = (k) => String(form.get(k) ?? '').trim();
  const title = get('title'), desc = get('description'), category = get('category'),
        location = get('location'), sid = get('student_id'), name = get('name'),
        cls = get('class'), vq = get('verify_q'), va = get('verify_a');
  if (!/^\d{7}$/.test(sid)) return Response.json({ ok: false, error: 'BAD_STUDENT_ID' }, { status: 400 });
  if (!title || !category || !location || !vq || !va)
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
  const code = `LF-${now.getUTCFullYear()}-${String(now.getTime()).slice(-4)}${String(Math.floor(Math.random() * 10))}`;
  const drop = genCode();
  // 修正：简报 VALUES 为 14 值对 15 列（且 'registered' 会错位到 drop_code）；按列序改为 11?+'registered'+3?
  await db.prepare(`INSERT INTO items(code,title,description,category,location,photo_path,verify_q,verify_a,value_tier,drop_code,drop_expires_at,status,registered_by,registered_via,found_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'registered',?,?,?)`)
    .bind(code, title, desc, category, location, photoPath, vq, va, tierOf(category),
          drop, dropExpiry(now, Number(env.DROP_TTL_MINUTES || 15)), sid,
          get('via') === 'kiosk' ? 'kiosk' : 'phone',   // kiosk 直办（T14）复用本端点
          now.toISOString()).run();
  return Response.json({ ok: true, code, drop_code: drop, drop_expires_at: dropExpiry(now, Number(env.DROP_TTL_MINUTES || 15)) });
}
