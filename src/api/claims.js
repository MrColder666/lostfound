// src/api/claims.js —— 全凭自觉：认领当场自动通过，不设人工门槛
// 风险（秒领 / 多人在抢）只记为被动黄标 → admin 后台抽查；必要时用 points/revoke 或 items/reopen 干预
import { genCode, pickupExpiry } from '../lib/codes.js';
import { evaluate } from '../lib/risk.js';
const json = (o, s = 200) => Response.json(o, { status: s });
async function upsertIdentity(db, { student_id, name, class: cls }) {
  if (!/^\d{7}$/.test(student_id)) throw new Error('BAD_STUDENT_ID');
  await db.prepare('INSERT INTO identities(student_id,name,class) VALUES (?,?,?) ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, class=excluded.class')
    .bind(student_id, name, cls).run();
}
export async function claims(db, env, req) {
  const b = await req.json();
  if (!/^\d{7}$/.test(String(b.student_id ?? ''))) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
  const item = await db.prepare("SELECT * FROM items WHERE code=? AND status IN ('in_stock','claim_pending')").bind(b.code).first();
  if (!item) return json({ ok: false, error: 'ITEM_NOT_CLAIMABLE' }, 404);
  await upsertIdentity(db, b);
  // 被动风控：只记黄标，不再拦截（admin 事后干预）
  const latencyMin = (Date.now() - new Date(item.created_at).getTime()) / 60000;
  const othersOnItem = (await db.prepare("SELECT COUNT(*) c FROM claims WHERE item_id=? AND status IN ('approved','auto_approved')").bind(item.id).first()).c;
  for (const reason of evaluate({ latencyMin, freezeCompeting: othersOnItem >= 1 }))
    await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('item',?,?)").bind(String(item.id), reason).run();
  // 全凭自觉：立即自动通过并发放领取码（保留认领人填写的核验答案，供 admin 参考）
  const code = genCode();
  const r = await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?,?,?,'auto_approved',?,?)`)
    .bind(item.id, b.student_id, String(b.verify_answer ?? ''), code,
          pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48))).run();
  // 物品预留给认领人（乐观锁）——离开公示板，避免他人重复认领；admin 可 items/reopen 放回
  await db.prepare("UPDATE items SET status='ready' WHERE id=? AND status IN ('in_stock','claim_pending')").bind(item.id).run();
  const row = await db.prepare("SELECT id, status, pickup_code, pickup_expires_at FROM claims WHERE id=?").bind(r.meta.last_row_id ?? 1).first();
  return json({ ok: true, ...row });
}
// 冷冻期结算：全凭自觉后新认领不再落入 pending；此处仅兼容历史遗留的 pending 数据（自愈）
export async function settleFreeze(db, env) {
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
    const code = genCode();
    await db.batch([
      db.prepare("UPDATE claims SET status='approved', pickup_code=?, pickup_expires_at=? WHERE id=? AND status='pending'")
        .bind(code, pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)), c.id),
      db.prepare("UPDATE items SET status='ready' WHERE id=? AND status='claim_pending'").bind(g.item_id),
    ]);
    approved.push(c.id);
  }
  return json({ ok: true, approved, reviewed });
}
