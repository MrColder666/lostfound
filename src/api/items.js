// src/api/items.js —— 公开字段白名单，唯一出口
const PUBLIC = 'id, code, title, description, category, location, photo_path, slot_no, value_tier, status, found_at, verify_q';
export async function listItems(db, env, req) {
  const url = new URL(req.url);
  const cat = url.searchParams.get('category');
  const cols = PUBLIC.split(', ').map(c => `i.${c}`).join(', ');
  const q = `SELECT ${cols}, id2.name AS finder_name, id2.class AS finder_class
     FROM items i JOIN identities id2 ON id2.student_id = i.registered_by
     WHERE i.status IN ('in_stock','ready') ${cat ? 'AND i.category = ?' : ''}
     ORDER BY i.created_at DESC LIMIT 100`;
  const rows = cat ? await db.prepare(q).bind(cat).all() : await db.prepare(q).all();
  return Response.json({ ok: true, items: rows.results });
}
export async function getItem(db, env, req, id) {
  const cols = PUBLIC.split(', ').map(c => `i.${c}`).join(', ');
  const row = await db.prepare(
    `SELECT ${cols}, id2.name AS finder_name, id2.class AS finder_class
     FROM items i JOIN identities id2 ON id2.student_id = i.registered_by
     WHERE i.id = ? AND i.status IN ('in_stock','ready')`
  ).bind(id).first();
  if (!row) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  return Response.json({ ok: true, item: row });
}
// 公开商城目录（§7）：仅在售奖品
export async function listRewards(db, env, req) {
  const rows = await db.prepare('SELECT id, name, name_en, cost, stock FROM rewards WHERE active=1 ORDER BY cost').all();
  return Response.json({ ok: true, rewards: rows.results });
}
// 照片回显：R2 绑定 env.PHOTOS（未配置时一律 404，前端回退占位块）
export async function getPhoto(db, env, req, parts) {
  const rel = parts.join('/');
  if (!env.PHOTOS || !/^[A-Za-z0-9._/-]+$/.test(rel) || rel.includes('..'))
    return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  const obj = await env.PHOTOS.get(rel);
  if (!obj) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  const type = rel.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return new Response(await obj.arrayBuffer(), { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } });
}
