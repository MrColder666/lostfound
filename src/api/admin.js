// src/api/admin.js —— 唯一鉴权点：X-Admin-Token（部署时 wrangler secret put ADMIN_TOKEN）
import { genCode, pickupExpiry } from '../lib/codes.js';
import { monthKey } from '../lib/points.js';   // 修正：points/adjust 分支用到，简报 import 遗漏
const json = (o, s = 200) => Response.json(o, { status: s });
export async function admin(db, env, req, token) {
  if (!token || token !== env.ADMIN_TOKEN) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  const url = new URL(req.url);
  const audit = (action, target) => db.prepare('INSERT INTO admin_audit(action,target) VALUES (?,?)').bind(action, target).run();
  if (req.method === 'GET' && url.pathname === '/api/admin/queue') {
    const q = await db.prepare(`SELECT c.id AS claim_id, c.status, c.verify_answer, c.created_at,
      i.title, i.code, i.value_tier, id2.name AS claimant_name, id2.class AS claimant_class
      FROM claims c JOIN items i ON i.id=c.item_id JOIN identities id2 ON id2.student_id=c.claimant_id
      WHERE c.status='in_review' ORDER BY c.created_at`).all();
    const flags = await db.prepare("SELECT * FROM risk_flags WHERE resolved=0 ORDER BY id DESC LIMIT 50").all();
    return json({ ok: true, queue: q.results, flags: flags.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/review') {
    const { claim_id, decision } = await req.json();   // approve | reject
    if (decision === 'approve') {
      const code = genCode();
      await db.batch([
        db.prepare("UPDATE claims SET status='approved', pickup_code=?, pickup_expires_at=? WHERE id=? AND status='in_review'")
          .bind(code, pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)), claim_id),
        db.prepare("UPDATE items SET status='ready' WHERE id=(SELECT item_id FROM claims WHERE id=?) AND status='in_stock'").bind(claim_id),
      ]);
      await audit('review_approve', `claim:${claim_id}`);
      return json({ ok: true, pickup_code: code });
    }
    await db.prepare("UPDATE claims SET status='rejected', review_reason='ADMIN_REJECTED' WHERE id=? AND status='in_review'").bind(claim_id).run();
    await db.prepare("UPDATE items SET status='in_stock' WHERE id=(SELECT item_id FROM claims WHERE id=?) AND status='claim_pending'").bind(claim_id).run();
    await audit('review_reject', `claim:${claim_id}`);
    return json({ ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/points/adjust') {
    const { student_id, delta, reason } = await req.json();
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'adjust','admin',NULL,?)")
      .bind(student_id, delta, monthKey(new Date().toISOString())).run();
    await audit('points_adjust', `${student_id}:${delta}`);
    return json({ ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/redemptions/fulfill') {
    const { id } = await req.json();
    await db.prepare("UPDATE redemptions SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=? AND status='pending'").bind(id).run();
    await audit('redemption_fulfill', `redemption:${id}`);
    return json({ ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
    const week = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM items WHERE status IN ('in_stock','ready','claim_pending')) AS pending,
      (SELECT COUNT(*) FROM items WHERE status='returned') AS returned,
      (SELECT COUNT(*) FROM claims WHERE status='in_review') AS reviews`).first();
    return json({ ok: true, stats: week });
  }
  return json({ ok: false, error: 'NOT_FOUND' }, 404);
}
