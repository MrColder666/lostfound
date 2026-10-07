// src/lib/verify.js —— 归一化 + 字符 bigram 相似度（Dice 系数），无依赖
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')                 // 全角→半角
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ''); // 空白/标点/符号
}
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}
export function similar(a, b) {
  const A = bigrams(normalize(a)), B = bigrams(normalize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
export function passes(a, b, threshold = 0.6) {
  if (!normalize(a) || !normalize(b)) return false;
  return similar(a, b) >= threshold;
}
