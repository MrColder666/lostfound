// src/api/admin-webauthn.js —— Passkey（指纹/面容）第二因子：v1.7.0 实现，当前为占位
export async function f2aEnabled(db) {
  const r = await db.prepare('SELECT COUNT(*) c FROM webauthn_creds').first();
  return (r?.c ?? 0) > 0;
}
export async function webauthnRoutes(db, env, req, url, ctx) {
  return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
}
