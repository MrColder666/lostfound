// src/lib/codes.js —— 凭证/领取码全部走这里，禁止散落实现
export function genCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, n => n % 10).join('');
}
export const dropExpiry = (now = new Date(), ttlMin = 15) =>
  new Date(now.getTime() + ttlMin * 60000).toISOString();
export const pickupExpiry = (now = new Date(), ttlHours = 48) =>
  new Date(now.getTime() + ttlHours * 3600000).toISOString();
export function isExpired(iso, nowIso = new Date().toISOString()) {
  if (!iso) return true;
  return new Date(iso).getTime() <= new Date(nowIso).getTime();
}
