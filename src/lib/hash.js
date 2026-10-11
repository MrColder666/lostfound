// src/lib/hash.js —— SHA-256 hex（会话令牌 / 挑战哈希用）
export async function sha256Hex(str) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
