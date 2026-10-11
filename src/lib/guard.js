// src/lib/guard.js —— 双层防刷：敏感端点计数（rate_events）+ 认领计量（claims 直查，不受 IP 影响）
export async function bump(db, kind, key) {
  await db.prepare('INSERT INTO rate_events(kind,key,ts) VALUES (?,?,?)').bind(kind, key, Date.now()).run();
}
export async function count(db, kind, key, windowMs) {
  const r = await db.prepare('SELECT COUNT(*) c FROM rate_events WHERE kind=? AND key=? AND ts>?').bind(kind, key, Date.now() - windowMs).first();
  return r?.c ?? 0;
}
export const blocked = async (db, kind, key, limit, windowMs) => (await count(db, kind, key, windowMs)) >= limit;
export async function prune(db) {
  await db.prepare('DELETE FROM rate_events WHERE ts < ?').bind(Date.now() - 86400000).run();
}
// 认领计量：活跃认领（未领取且未过期）+ 当日认领数
export async function claimAllowance(db, sid, { activeCap = 3, dailyCap = 5 } = {}) {
  const now = new Date();
  const active = (await db.prepare(
    `SELECT COUNT(*) c FROM claims WHERE claimant_id=? AND status IN ('approved','auto_approved','pending','in_review')
     AND (pickup_expires_at IS NULL OR pickup_expires_at > ?)`).bind(sid, now.toISOString()).first()).c;
  if (active >= activeCap) return { ok: false, error: 'TOO_MANY_ACTIVE' };
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const today = (await db.prepare('SELECT COUNT(*) c FROM claims WHERE claimant_id=? AND created_at >= ?').bind(sid, dayStart).first()).c;
  if (today >= dailyCap) return { ok: false, error: 'TOO_MANY_TODAY' };
  return { ok: true };
}
