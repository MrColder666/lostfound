// src/api/claims.js —— 全凭自觉：认领当场自动通过，不设人工门槛
// v1.6.0：领取代码通道下线（凭学号+姓名+PIN 现场领取）；身份首写为准；认领防刷；PIN 门
// v1.6.1：过期未领取自动释放回公示板；限流表定期清理
import { pickupExpiry } from '../lib/codes.js';
import { evaluate } from '../lib/risk.js';
import { upsertIdentitySafe, pinGate } from '../lib/identity.js';
import { claimAllowance, prune } from '../lib/guard.js';
const json = (o, s = 200) => Response.json(o, { status: s });
export async function claims(db, env, req) {
  const b = await req.json();
  const sid = String(b.student_id ?? '');
  if (!/^\d{7}$/.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
  const item = await db.prepare("SELECT * FROM items WHERE code=? AND status IN ('in_stock','claim_pending')").bind(b.code).first();
  if (!item) return json({ ok: false, error: 'ITEM_NOT_CLAIMABLE' }, 404);
  const idn = await upsertIdentitySafe(db, { student_id: sid, name: b.name, class: b.class });
  if (!idn.ok) return json({ ok: false, error: idn.error }, 403);
  const gate = await pinGate(db, sid, b.pin);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  const allow = await claimAllowance(db, sid, { activeCap: Number(env.CLAIM_ACTIVE_CAP || 3), dailyCap: Number(env.CLAIM_DAILY_CAP || 5) });
  if (!allow.ok) return json({ ok: false, error: allow.error }, 429);
  // 被动风控：只记黄标，不再拦截（admin 事后干预）
  const latencyMin = (Date.now() - new Date(item.created_at).getTime()) / 60000;
  const othersOnItem = (await db.prepare("SELECT COUNT(*) c FROM claims WHERE item_id=? AND status IN ('approved','auto_approved')").bind(item.id).first()).c;
  for (const reason of evaluate({ latencyMin, freezeCompeting: othersOnItem >= 1 }))
    await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('item',?,?)").bind(String(item.id), reason).run();
  // 当场自动通过；不再发领取码（到服务台凭学号+姓名+PIN 领取）
  const iso = new Date().toISOString();
  const r = await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_expires_at,created_at)
    VALUES (?,?,?,'auto_approved',?,?)`)
    .bind(item.id, sid, String(b.verify_answer ?? '').slice(0, 200), pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)), iso).run();
  await db.prepare("UPDATE items SET status='ready' WHERE id=? AND status IN ('in_stock','claim_pending')").bind(item.id).run();
  const row = await db.prepare("SELECT id, status, pickup_expires_at FROM claims WHERE id=?").bind(r.meta.last_row_id ?? 1).first();
  return json({ ok: true, ...row });
}
// 定时任务：① 兼容历史 pending 自愈 ② 过期未领取释放物品 ③ 限流表清理
export async function settleFreeze(db, env) {
  const nowIso = new Date().toISOString();
  // ② 过期释放：已预留但超时未取 → 物品回公示板，认领单置 expired
  const stale = await db.prepare(`SELECT c.id AS claim_id, c.item_id FROM claims c JOIN items i ON i.id=c.item_id
    WHERE c.status IN ('approved','auto_approved') AND i.status='ready'
      AND c.pickup_expires_at IS NOT NULL AND c.pickup_expires_at < ?`).bind(nowIso).all();
  for (const g of stale.results) {
    await db.batch([
      db.prepare("UPDATE claims SET status='expired', review_reason='PICKUP_EXPIRED' WHERE id=? AND status IN ('approved','auto_approved')").bind(g.claim_id),
      db.prepare("UPDATE items SET status='in_stock', updated_at=? WHERE id=? AND status='ready'").bind(nowIso, g.item_id),
    ]);
  }
  // ③ 限流表清理（24h）
  await prune(db);
  // ① 历史 pending 自愈（新流程不再产生 pending）
  const due = await db.prepare(`
    SELECT i.id AS item_id, COUNT(*) c FROM claims c JOIN items i ON i.id=c.item_id
    WHERE c.status='pending' AND datetime(i.created_at) <= datetime('now', ?) GROUP BY i.id`)
    .bind(`-${Number(env.FREEZE_MINUTES || 60)} minutes`).all();
  const approved = [], reviewed = [];
  for (const g of due.results) {
    const list = await db.prepare("SELECT * FROM claims WHERE item_id=? AND status='pending'").bind(g.item_id).all();
    if (g.c >= 2) { reviewed.push(g.item_id);
      await db.prepare("UPDATE claims SET status='in_review', review_reason='FREEZE_COMPETING' WHERE item_id=? AND status='pending'").bind(g.item_id).run();
      continue;
    }
    const c = list.results[0];
    await db.batch([
      db.prepare("UPDATE claims SET status='approved', pickup_expires_at=? WHERE id=? AND status='pending'")
        .bind(pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)), c.id),
      db.prepare("UPDATE items SET status='ready' WHERE id=? AND status='claim_pending'").bind(g.item_id),
    ]);
    approved.push(c.id);
  }
  return json({ ok: true, released: stale.results.length, approved, reviewed });
}
