// src/lib/webauthn.js —— Passkey（WebAuthn）注册/断言校验（ES256，无外部依赖）
import { cborDecode } from './cbor.js';
import { sha256Hex } from './hash.js';
const td = new TextDecoder();
const te = new TextEncoder();
export const b64u = {
  encode: (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const ALLOWED_HOSTS = ['lf.xiaochangblog.dpdns.org', 'lostfound.chentaoran-shanghai.workers.dev'];
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
// DER（ASN.1）→ IEEE P1363（WebCrypto ECDSA 需要 r||s 64 字节）
export function derToRaw(sig) {
  let i = 0;
  if (sig[i++] !== 0x30) throw new Error('DER: no SEQUENCE');
  if (sig[i] & 0x80) i += 1 + (sig[i] & 0x7f); else i += 1;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (sig[i++] !== 0x02) throw new Error('DER: no INTEGER');
    let len = sig[i++];
    let start = i;
    if (len > 32) { start += len - 32; len = 32; }
    out.set(sig.slice(start, start + len), part * 32 + (32 - len));
    i = start + len;
  }
  return out;
}
export function parseAuthData(ad) {
  const view = new DataView(ad.buffer, ad.byteOffset, ad.byteLength);
  if (ad.length < 37) throw new Error('authData short');
  const rpIdHash = ad.slice(0, 32), flags = ad[32], counter = view.getUint32(33);
  let credId = null, coseKey = null;
  if (flags & 0x40) {
    const credLen = view.getUint16(37);
    credId = ad.slice(39, 39 + credLen);
    coseKey = cborDecode(ad.slice(39 + credLen));
  }
  return { rpIdHash, flags, counter, credId, coseKey };
}
export const coseToJwk = (cose) => ({ kty: 'EC', crv: 'P-256', x: b64u.encode(cose['-2']), y: b64u.encode(cose['-3']), ext: true });
export async function issueChallenge(db, kind) {
  const challenge = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare(`INSERT INTO webauthn_challenges(key,challenge,expires_at,used) VALUES (?,?,?,0)
    ON CONFLICT(key) DO UPDATE SET challenge=excluded.challenge, expires_at=excluded.expires_at, used=0`)
    .bind(kind, challenge, Date.now() + 5 * 60000).run();
  return challenge;
}
async function consumeChallenge(db, kind, challenge, origin, type, wantType) {
  let host = '';
  try { const u = new URL(origin); if (u.protocol !== 'https:') throw 0; host = u.host; } catch { return { ok: false, error: 'BAD_ORIGIN' }; }
  if (!ALLOWED_HOSTS.includes(host)) return { ok: false, error: 'BAD_ORIGIN' };
  if (type !== wantType) return { ok: false, error: 'BAD_TYPE' };
  const row = await db.prepare('SELECT * FROM webauthn_challenges WHERE key=?').bind(kind).first();
  if (!row || row.used || row.expires_at < Date.now() || row.challenge !== challenge) return { ok: false, error: 'BAD_CHALLENGE' };
  await db.prepare('UPDATE webauthn_challenges SET used=1 WHERE key=?').bind(kind).run();
  return { ok: true, host };
}
export async function verifyRegistration(db, { attestationObject, clientDataJSON }) {
  const cdBytes = b64u.decode(clientDataJSON);
  const cd = JSON.parse(td.decode(cdBytes));
  const chk = await consumeChallenge(db, 'register', cd.challenge, cd.origin, cd.type, 'webauthn.create');
  if (!chk.ok) return chk;
  const att = cborDecode(b64u.decode(attestationObject));
  const parsed = parseAuthData(att.authData);
  if ((parsed.flags & 0x41) !== 0x41) return { ok: false, error: 'UP_OR_AT_MISSING' };
  if (!bytesEqual(parsed.rpIdHash, await sha256(te.encode(chk.host)))) return { ok: false, error: 'RP_MISMATCH' };
  if (!parsed.coseKey || parsed.coseKey['3'] !== -7) return { ok: false, error: 'ALG_UNSUPPORTED' };
  const id = b64u.encode(parsed.credId);
  await db.prepare(`INSERT INTO webauthn_creds(id,public_jwk,alg,sign_count,label) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET public_jwk=excluded.public_jwk, sign_count=excluded.sign_count`)
    .bind(id, JSON.stringify(coseToJwk(parsed.coseKey)), -7, parsed.counter, 'Admin device').run();
  return { ok: true, id };
}
export async function verifyAssertion(db, { id, authenticatorData, clientDataJSON, signature }) {
  const cred = await db.prepare('SELECT * FROM webauthn_creds WHERE id=?').bind(id).first();
  if (!cred) return { ok: false, error: 'CRED_NOT_FOUND' };
  const cdBytes = b64u.decode(clientDataJSON);
  const cd = JSON.parse(td.decode(cdBytes));
  const chk = await consumeChallenge(db, 'login', cd.challenge, cd.origin, cd.type, 'webauthn.get');
  if (!chk.ok) return chk;
  const ad = b64u.decode(authenticatorData);
  const parsed = parseAuthData(ad);
  if (!(parsed.flags & 0x01)) return { ok: false, error: 'UP_MISSING' };
  if (!bytesEqual(parsed.rpIdHash, await sha256(te.encode(chk.host)))) return { ok: false, error: 'RP_MISMATCH' };
  let raw;
  try { raw = derToRaw(b64u.decode(signature)); } catch { return { ok: false, error: 'BAD_SIGNATURE' }; }
  const key = await crypto.subtle.importKey('jwk', JSON.parse(cred.public_jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, concat(ad, await sha256(cdBytes)));
  if (!ok) return { ok: false, error: 'BAD_SIGNATURE' };
  await db.prepare('UPDATE webauthn_creds SET sign_count=? WHERE id=?').bind(parsed.counter, id).run();
  return { ok: true };
}
export async function createSession(db, hours = 12) {
  const token = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(Date.now()).run();
  await db.prepare('INSERT INTO admin_sessions(token_hash,created_at,expires_at) VALUES (?,?,?)').bind(await sha256Hex(token), Date.now(), Date.now() + hours * 3600000).run();
  return token;
}
