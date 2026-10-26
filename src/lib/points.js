// src/lib/points.js —— 纯函数；数据库写入由 api 层用乐观锁完成
export const monthKey = (iso) => String(iso).slice(0, 7);          // '2026-10'
export function grantWithCap({ monthTotal, want, cap = 100 }) {
  const room = Math.max(0, cap - monthTotal);
  const delta = Math.min(want, room);
  return { delta, capped: delta < want };
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
