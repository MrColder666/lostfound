// src/api/kiosk.js —— 所有状态跃迁：UPDATE…WHERE 旧状态 + changes==1（§10 乐观锁）
import { isExpired } from '../lib/codes.js';
import { grantWithCap, monthKey } from '../lib/points.js';
const json = (o, s = 200) => Response.json(o, { status: s });
const SLOT_COUNT = (env) => Number(env.SLOT_COUNT || 12);
async function occupiedSlots(db) {
  const r = await db.prepare("SELECT slot_no FROM items WHERE slot_no IS NOT NULL AND status IN ('in_stock','claim_pending','ready')").all();
  return new Set(r.results.map(x => x.slot_no));
}
export async function confirmDrop(db, env, req) {
  const { drop_code } = await req.json();
  const item = await db.prepare("SELECT id, drop_expires_at FROM items WHERE drop_code=? AND status='registered'").bind(drop_code).first();
  if (!item) return json({ ok: false, error: 'VOUCHER_NOT_FOUND' }, 404);
  if (isExpired(item.drop_expires_at)) return json({ ok: false, error: 'VOUCHER_EXPIRED' }, 410);
  const used = await occupiedSlots(db);
  for (let n = 1; n <= SLOT_COUNT(env); n++) {
    if (used.has(n)) continue;
    const r = await db.prepare(
      `UPDATE items SET slot_no=?, status='in_stock', drop_code=NULL, drop_expires_at=NULL, updated_at=datetime('now')
       WHERE id=? AND status='registered' AND slot_no IS NULL`).bind(n, item.id).run();
    if (r.meta.changes === 1) return json({ ok: true, slot_no: n });   // 乐观锁成功即占格
  }
  return json({ ok: false, error: 'SLOTS_FULL' }, 507);
}
export async function verifyPickup(db, env, req) {
  const { pickup_code } = await req.json();
  const row = await db.prepare(
    `SELECT c.id, c.pickup_expires_at, c.status, i.title, i.slot_no, i.location, i.found_at
     FROM claims c JOIN items i ON i.id = c.item_id
     WHERE c.pickup_code=? AND c.status IN ('approved','auto_approved')`).bind(pickup_code).first();
  if (!row) return json({ ok: false, error: 'CODE_INVALID' }, 404);
  if (isExpired(row.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
  return json({ ok: true, claim: row });
}
export async function fulfill(db, env, req) {
  const { pickup_code } = await req.json();
  // 修正：此处不按状态过滤——重复核销须落到 batch 乐观锁返回 409（带过滤会提前 404）
  const claim = await db.prepare(
    `SELECT c.*, i.id AS item_id, i.value_tier, i.registered_by, i.created_at AS in_stock_at
     FROM claims c JOIN items i ON i.id=c.item_id
     WHERE c.pickup_code=?`).bind(pickup_code).first();
  if (!claim) return json({ ok: false, error: 'CODE_INVALID' }, 404);
  if (isExpired(claim.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
  const now = new Date();
  // 出库：两条 UPDATE 放同一 batch（同事务语义），各自乐观锁
  const rs = await db.batch([
    db.prepare("UPDATE items SET status='returned', updated_at=datetime('now') WHERE id=? AND status IN ('in_stock','ready')")
      .bind(claim.item_id),
    db.prepare("UPDATE claims SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=? AND status IN ('approved','auto_approved')")
      .bind(claim.id),
  ]);
  if (rs.some(r => r.meta.changes !== 1)) return json({ ok: false, error: 'CONFLICT' }, 409);
  // 积分结算：月上限内发放（§5.2）
  const mk = monthKey(now.toISOString());
  const agg = await db.prepare("SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger WHERE student_id=? AND month_key=?")
    .bind(claim.registered_by, mk).first();
  const { delta, capped } = grantWithCap({ monthTotal: agg.t, want: claim.value_tier === 'high' ? 25 : 10, cap: 100 });
  if (delta > 0)
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'claim_reward','claim',?,?)")
      .bind(claim.registered_by, delta, claim.id, mk).run();
  return json({ ok: true, points_granted: delta, capped });
}
