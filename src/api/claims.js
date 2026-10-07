// src/api/claims.js —— 认领决策全部在此；settleFreeze 由 Worker Cron 每 5 分钟调用
import { passes } from '../lib/verify.js';
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
  // 修复：非法学号直接 400（原 upsertIdentity 内 throw 会被 worker 兜底成 500）
  if (!/^\d{7}$/.test(String(b.student_id ?? ''))) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
  // 修正：冷冻期内物品已是 claim_pending，仍可被他人申请（竞争场景），查询须含两种状态
  const item = await db.prepare("SELECT * FROM items WHERE code=? AND status IN ('in_stock','claim_pending')").bind(b.code).first();
  if (!item) return json({ ok: false, error: 'ITEM_NOT_CLAIMABLE' }, 404);
  await upsertIdentity(db, b);
  const freezeMin = Number(env.FREEZE_MINUTES || 60);
  const freezeOver = (Date.now() - new Date(item.created_at).getTime()) >= freezeMin * 60000;
  const verified = passes(b.verify_answer, item.verify_a);   // 归一化模糊匹配
  // 黄标：秒领 / 冷冻期竞争
  const latencyMin = (Date.now() - new Date(item.created_at).getTime()) / 60000;
  const pendingOnItem = (await db.prepare("SELECT COUNT(*) c FROM claims WHERE item_id=? AND status IN ('pending','in_review')").bind(item.id).first()).c;
  const freezeCompeting = pendingOnItem >= 1;
  for (const reason of evaluate({ latencyMin, freezeCompeting }))
    await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('item',?,?)").bind(String(item.id), reason).run();
  let status;
  if (!verified || !item.verify_a) status = 'in_review';               // 答错/无特征 → 人工
  else if (item.value_tier === 'high') status = 'in_review';           // 高价值 → 人工
  else if (freezeCompeting) status = 'in_review';                      // 修正：冷冻期竞争 → 全部转人工
  else if (!freezeOver) status = 'pending';                            // 冷冻期 → 到点结算
  else status = 'auto_approved';                                       // 全绿 → 自动通过
  const pickup = status === 'auto_approved' ? genCode() : null;
  const r = await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?,?,?,?,?,?)`)
    .bind(item.id, b.student_id, b.verify_answer ?? '', status, pickup,
          pickup ? pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)) : null).run();
  if (freezeCompeting) {  // 修正：竞争出现时，该物品既有 pending 一并转人工（测试要求「全部 in_review」）
    await db.prepare("UPDATE claims SET status='in_review', review_reason='FREEZE_COMPETING' WHERE item_id=? AND status='pending'").bind(item.id).run();
  }
  if (status === 'pending') {  // 锁定物品为认领中（乐观锁）
    await db.prepare("UPDATE items SET status='claim_pending' WHERE id=? AND status='in_stock'").bind(item.id).run();
  }
  const row = await db.prepare("SELECT id, status, pickup_code, pickup_expires_at FROM claims WHERE id=?").bind(r.meta.last_row_id ?? 1).first();
  return json({ ok: true, ...row });
}
// 冷冻期结算：pending → 若该物品仅此一份申请且核验已过 → approved 发码；≥2 份 → 全部 in_review
export async function settleFreeze(db, env) {
  // 修正：datetime() 包裹统一格式——items.created_at 可能是 ISO 'T' 格式，与 datetime('now') 的空格格式裸比较恒为假
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
