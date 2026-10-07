// src/worker.js —— /api 分发；其余回退 ASSETS；Cron 结算冷冻期
import { listItems, getItem, listRewards, getPhoto } from './api/items.js';
import { report } from './api/report.js';
import { confirmDrop, verifyPickup, fulfill, lookupClaims } from './api/kiosk.js';
import { claims, settleFreeze } from './api/claims.js';
import { pointsQuery, tip, redeem } from './api/points.js';
import { admin } from './api/admin.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/r') return Response.redirect(new URL('/?from=qr', url).toString(), 302);  // 引导牌短链
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const db = env.DB;
    try {
      const seg = url.pathname.split('/').filter(Boolean);   // ['api', ...]
      const m = request.method;
      if (m === 'GET'  && url.pathname === '/api/items') return listItems(db, env, request);
      if (m === 'GET'  && seg[1] === 'items' && seg[2]) return getItem(db, env, request, seg[2]);
      if (m === 'POST' && url.pathname === '/api/report') return report(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/confirm-drop') return confirmDrop(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/verify-pickup') return verifyPickup(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/lookup-claims') return lookupClaims(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/fulfill') return fulfill(db, env, request);
      if (m === 'POST' && url.pathname === '/api/claims') return claims(db, env, request);
      if (m === 'GET'  && seg[1] === 'points' && seg[2]) return pointsQuery(db, env, request, seg[2]);
      if (m === 'GET'  && url.pathname === '/api/rewards') return listRewards(db, env, request);
      if (m === 'GET'  && seg[1] === 'photos' && seg.length > 2) return getPhoto(db, env, request, seg.slice(2));
      if (m === 'POST' && url.pathname === '/api/tips') return tip(db, env, request);
      if (m === 'POST' && url.pathname === '/api/redemptions') return redeem(db, env, request);
      if (seg[1] === 'admin') return admin(db, env, request, request.headers.get('X-Admin-Token'));
      return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: 'SERVER_ERROR' }, { status: 500 }); // 不回显 e（§10 安全）
    }
  },
  async scheduled(event, env) {
    await settleFreeze(env.DB, env);   // 每 5 分钟结算冷冻期
  },
};
