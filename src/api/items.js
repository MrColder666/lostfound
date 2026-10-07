// src/api/items.js —— 公开字段白名单，唯一出口
const PUBLIC = 'id, code, title, description, category, location, photo_path, slot_no, value_tier, status, found_at';
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
