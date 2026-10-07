// src/lib/risk.js —— 阈值与 spec §5.3-5 一致，全部可由 env vars 覆盖
export function evaluate(f, th = {}) {
  const t = { snatchMin: 10, claimantMonth: 3, pairMonth: 2, ...th };
  const out = [];
  if (f.latencyMin < t.snatchMin) out.push('SNATCH_10MIN');
  if (f.claimantMonthCount >= t.claimantMonth) out.push('CLAIMANT_FREQUENT');
  if (f.pairMonthCount >= t.pairMonth) out.push('PAIR_FREQUENT');
  if (f.claimantPerItem >= 2) out.push('MULTI_CLAIM');
  if (f.freezeCompeting) out.push('FREEZE_COMPETING');
  if (f.dupeDesc) out.push('DUPLICATE_DESC');
  return out;
}
