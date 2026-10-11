// src/lib/pin.js —— 4 位 PIN：PBKDF2-SHA256（100k 迭代）+ 16B 盐；存储 salt$hash（hex）
const enc = new TextEncoder();
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return a; };
export async function hashPin(pin, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return toHex(salt) + '$' + toHex(new Uint8Array(bits));
}
export async function verifyPin(pin, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [salt] = stored.split('$');
  const again = await hashPin(pin, salt);
  let d = again.length === stored.length ? 0 : 1;
  for (let i = 0; i < Math.min(again.length, stored.length); i++) d |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return d === 0;
}
export const validPin = (p) => /^\d{4}$/.test(String(p ?? ''));
