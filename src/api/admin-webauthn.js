// src/api/admin-webauthn.js —— Passkey（指纹/面容）第二因子
import { issueChallenge, verifyRegistration, verifyAssertion, createSession, b64u } from '../lib/webauthn.js';
const json = (o, s = 200) => Response.json(o, { status: s });
export async function f2aEnabled(db) {
  const r = await db.prepare('SELECT COUNT(*) c FROM webauthn_creds').first();
  return (r?.c ?? 0) > 0;
}
export async function webauthnRoutes(db, env, req, url, ctx) {
  if (req.method === 'GET' && url.pathname === '/api/admin/webauthn/state') {
    const r = await db.prepare('SELECT COUNT(*) c FROM webauthn_creds').first();
    return json({ ok: true, enabled: (r?.c ?? 0) > 0, count: r?.c ?? 0 });
  }
  if (!ctx.passOk) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);   // 口令即第一因子
  const host = (() => { try { return new URL(req.headers.get('Origin') || '').host; } catch { return 'lf.xiaochangblog.dpdns.org'; } })();
  if (req.method === 'POST' && url.pathname === '/api/admin/webauthn/register-options') {
    const challenge = await issueChallenge(db, 'register');
    const creds = await db.prepare('SELECT id FROM webauthn_creds').all();
    return json({ ok: true, challenge, rpId: host, rpName: 'L&F Admin',
      userId: b64u.encode(crypto.getRandomValues(new Uint8Array(8))),
      excludeCredentials: creds.results.map((c) => ({ type: 'public-key', id: c.id })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/webauthn/register') {
    const b = await req.json();
    const r = await verifyRegistration(db, b);
    return r.ok ? json({ ok: true, id: r.id }) : json({ ok: false, error: r.error }, 400);
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/webauthn/login-options') {
    const challenge = await issueChallenge(db, 'login');
    const creds = await db.prepare('SELECT id FROM webauthn_creds').all();
    return json({ ok: true, challenge, rpId: host, allowCredentials: creds.results.map((c) => ({ type: 'public-key', id: c.id })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/webauthn/login') {
    const b = await req.json();
    const r = await verifyAssertion(db, b);
    if (!r.ok) return json({ ok: false, error: r.error }, 403);
    const token = await createSession(db);
    await db.prepare('INSERT INTO admin_audit(action,target) VALUES (?,?)').bind('admin_login_2fa', 'passkey').run();
    return json({ ok: true, token });
  }
  return json({ ok: false, error: 'NOT_FOUND' }, 404);
}
