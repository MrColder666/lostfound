// src/lib/points.js —— 纯函数；数据库写入由 api 层用乐观锁完成
export const monthKey = (iso) => String(iso).slice(0, 7);          // '2026-10'
// v2.4.0：每月最多「获得」100 分（余额永不清零，只有当月额度按月刷新）。
// 计入上限的只有主动获得的积分：归还奖励 + 打赏收入；初始分 / 兑换扣分 / 管理员调整都不占当月额度。
export const EARN_REASONS = ['claim_reward', 'tip_in'];
export const INITIAL_POINTS = 67;                                  // 每个学生第一次出现时的初始积分
export function grantWithCap({ monthTotal, want, cap = 100 }) {
  const room = Math.max(0, cap - monthTotal);
  const delta = Math.min(want, room);
  return { delta, capped: delta < want };
}
// 本月「已获得」积分（只算 earning reasons，倒扣不返还额度）
export async function monthlyEarned(db, sid, mk) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger
      WHERE student_id=? AND month_key=? AND reason IN ('claim_reward','tip_in') AND delta > 0`
  ).bind(sid, mk).first();
  return Number(row?.t) || 0;
}
// 幂等：确保这个学生有初始 67 分（自注册与后台建号都会走这里）
export async function ensureInitialPoints(db, sid) {
  const mk = monthKey(new Date().toISOString());
  await db.prepare(
    `INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key)
     SELECT ?,?,'initial','identity',?,?
      WHERE NOT EXISTS (SELECT 1 FROM points_ledger WHERE student_id=? AND reason='initial')`
  ).bind(sid, INITIAL_POINTS, sid, mk, sid).run();
}
export async function ensureInitialPointsBatch(db, sids) {
  const list = [...new Set(sids || [])];
  if (!list.length) return;
  const mk = monthKey(new Date().toISOString());
  await db.batch(list.map((sid) => db.prepare(
    `INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key)
     SELECT ?,?,'initial','identity',?,?
      WHERE NOT EXISTS (SELECT 1 FROM points_ledger WHERE student_id=? AND reason='initial')`
  ).bind(sid, INITIAL_POINTS, sid, mk, sid)));
}
export function tipCheck({ claim, tipper, tipped }) {
  if (!claim || claim.status !== 'fulfilled') return { ok: false, error: 'CLAIM_NOT_FULFILLED' };
  if (claim.claimant_id !== tipper) return { ok: false, error: 'NOT_CLAIMANT' };  // 打赏者必须是认领人
  if (tipped) return { ok: false, error: 'ALREADY_TIPPED' };
  return { ok: true };
}
export function redeemCheck({ balance, cost, stock }) {
  if (balance < cost) return { ok: false, error: 'INSUFFICIENT_POINTS' };
  if (stock <= 0) return { ok: false, error: 'OUT_OF_STOCK' };
  return { ok: true };
}
// v2.0.0：登记时选了「暂无图片」的物品，归还结算时扣 2 分（照片是核验与找回效率的一部分）
export const PHOTO_PENALTY = 2;
export function finalReward({ tier, rewardNormal = 10, rewardHigh = 25, hasPhoto = true }) {
  const base = tier === 'high' ? Number(rewardHigh) : Number(rewardNormal);
  const want = hasPhoto ? base : base - PHOTO_PENALTY;
  return Math.max(0, want);
}
