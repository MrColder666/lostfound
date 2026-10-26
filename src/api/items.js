// src/api/items.js —— 公开字段白名单，唯一出口
import { getSettings } from '../lib/settings.js';
import { readPhoto } from '../lib/photo.js';
const PUBLIC = 'id, code, title, description, category, location, photo_path, slot_no, value_tier, status, found_at, verify_q';
const COLS = () => PUBLIC.split(', ').map(c => `i.${c}`).join(', ');

export async function listItems(db, env, req) {
  const url = new URL(req.url);
  const cat = url.searchParams.get('category');
  const rawQ = (url.searchParams.get('q') || '').trim().slice(0, 40);
  const where = ["i.status = 'in_stock'"];
  const binds = [];
  if (cat && /^[a-z]{2,20}$/.test(cat)) { where.push('i.category = ?'); binds.push(cat); }
  if (rawQ) {
    where.push('(i.title LIKE ? OR i.description LIKE ? OR i.location LIKE ?)');
    const like = '%' + rawQ.replace(/[%_]/g, '') + '%';
    binds.push(like, like, like);
  }
  const q = `SELECT ${COLS()}, id2.name AS finder_name, id2.class AS finder_class
     FROM items i JOIN identities id2 ON id2.student_id = i.registered_by
     WHERE ${where.join(' AND ')}
     ORDER BY i.created_at DESC LIMIT 100`;
  const rows = await db.prepare(q).bind(...binds).all();
  return Response.json({ ok: true, items: rows.results });
}

export async function getItem(db, env, req, id) {
  const row = await db.prepare(
    `SELECT ${COLS()}, id2.name AS finder_name, id2.class AS finder_class
     FROM items i JOIN identities id2 ON id2.student_id = i.registered_by
     WHERE i.id = ? AND i.status = 'in_stock'`
  ).bind(id).first();
  if (!row) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  return Response.json({ ok: true, item: row });
}

// 公开商城目录（§7）：仅在售奖品
export async function listRewards(db, env, req) {
  const rows = await db.prepare('SELECT id, name, name_en, cost, stock, icon FROM rewards WHERE active=1 ORDER BY cost').all();
  return Response.json({ ok: true, rewards: rows.results });
}

// 照片回显：优先 R2（env.PHOTOS），未启用时从 D1 的 photos 表读（v2.2.0）
export async function getPhoto(db, env, req, parts) {
  const rel = parts.join('/');
  if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.includes('..'))
    return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  const got = await readPhoto(db, env, rel);
  if (!got) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  return new Response(got.bytes, {
    headers: {
      'content-type': got.mime,
      'content-length': String(got.bytes.byteLength ?? 0),
      'cache-control': 'public, max-age=86400',
    },
  });
}

// 公开站点信息：公告栏（v1.7.0）
export async function siteInfo(db) {
  const st = await getSettings(db);
  return Response.json({ ok: true, notice: st.notice || '', notice_on: st.notice_on === '1' });
}

// —— v1.8.0 公开成果指标（首页 Impact 条 / 橱柜可视化）——
// 只暴露聚合数字，不含任何学生身份；返回时长取 item 状态跃迁到 returned 的 updated_at。
export async function publicStats(db) {
  const one = async (sql) => (await db.prepare(sql).first()) || {};
  const board = await one("SELECT COUNT(*) n FROM items WHERE status='in_stock'");
  const returned = await one("SELECT COUNT(*) n FROM items WHERE status='returned'");
  const returned30 = await one("SELECT COUNT(*) n FROM items WHERE status='returned' AND updated_at >= datetime('now','-30 days')");
  const avg = await one("SELECT AVG((julianday(updated_at) - julianday(found_at)) * 24) h FROM items WHERE status='returned' AND updated_at IS NOT NULL");
  const points = await one("SELECT COALESCE(SUM(delta),0) s FROM points_ledger WHERE reason='claim_reward'");
  const students = await one("SELECT COUNT(*) n FROM identities");
  const holds = await one("SELECT COUNT(*) n FROM items WHERE status IN ('in_stock','claim_pending','ready')");
  const st = await getSettings(db).catch(() => ({}));
  return Response.json({
    ok: true,
    on_board: board.n || 0,
    returned_total: returned.n || 0,
    returned_30d: returned30.n || 0,
    avg_return_hours: avg.h == null ? null : Math.round(Number(avg.h) * 10) / 10,
    points_awarded: points.s || 0,
    students: students.n || 0,
    slots: Number(st.slots || 24),
    occupied: holds.n || 0,
  });
}

// —— v1.8.0 最近归还（成果墙）：仅标题/类别/照片/耗时，无认领人与出库单 ——
export async function recentReturns(db) {
  const rows = await db.prepare(
    `SELECT title, category, photo_path,
            CAST(ROUND((julianday(updated_at) - julianday(found_at)) * 24) AS INTEGER) AS hours
       FROM items
      WHERE status='returned' AND updated_at IS NOT NULL
      ORDER BY updated_at DESC LIMIT 6`
  ).all();
  return Response.json({ ok: true, items: rows.results });
}
