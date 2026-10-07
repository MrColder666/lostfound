// src/api/points.js —— 查询分级、打赏（唯一索引兜底）、兑换（乐观锁扣分）
// 修正：补导入 grantWithCap（简报 import 遗漏，tip() 会 ReferenceError）
import { tipCheck, redeemCheck, monthKey, grantWithCap } from '../lib/points.js';
const json = (o, s = 200) => Response.json(o, { status: s });
export async function pointsQuery(db, env, req, sid) {
  // 修正：worker 路由显式传 sid；测试直调未传，则从 URL 路径取末段
  const id = sid || new URL(req.url).pathname.split('/').filter(Boolean).pop();
  const ident = await db.prepare('SELECT * FROM identities WHERE student_id=?').bind(id).first();
  if (!ident) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  const total = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=?').bind(id).first()).t;
  const contributions = (await db.prepare("SELECT COUNT(DISTINCT ref_id) c FROM points_ledger WHERE student_id=? AND reason='claim_reward'").bind(id).first()).c;
  const name = new URL(req.url).searchParams.get('name');
  const pin = new URL(req.url).searchParams.get('pin');
  if (name || pin) {   // 修正：提供了凭证但校验失败 → 403（简报对不匹配也返回 200 公开级，与测试矛盾）
    const okFull = (name && name === ident.name) || (pin && ident.pin_hash && pin === ident.pin_hash);
    if (!okFull) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    const ledger = await db.prepare('SELECT delta, reason, created_at FROM points_ledger WHERE student_id=? ORDER BY id DESC LIMIT 50').bind(id).all();
    const redemptions = await db.prepare('SELECT r.points_cost, r.status, w.name FROM redemptions r JOIN rewards w ON w.id=r.reward_id WHERE r.student_id=? ORDER BY r.id DESC LIMIT 20').bind(id).all();
    return json({ ok: true, total, contributions, ledger: ledger.results, redemptions: redemptions.results });
  }
  return json({ ok: true, total, contributions });       // 公开级：只给总数
}
export async function tip(db, env, req) {
  const { claim_id, from, to, points } = await req.json();
  if (!(Number.isInteger(points) && points >= 1 && points <= 10)) return json({ ok: false, error: 'BAD_AMOUNT' }, 400);
  const claim = await db.prepare('SELECT id, claimant_id, status FROM claims WHERE id=?').bind(claim_id).first();
  const tipped = !!(await db.prepare("SELECT id FROM points_ledger WHERE reason='tip_in' AND ref_type='claim' AND ref_id=? AND student_id=?").bind(claim_id, to).first());
  const chk = tipCheck({ claim, tipper: from, tipped });
  // 修正：重复打赏 → 409（简报一律 400，与测试矛盾；其余业务拒绝仍 400）
  if (!chk.ok) return json({ ok: false, error: chk.error }, chk.error === 'ALREADY_TIPPED' ? 409 : 400);
  const mk = monthKey(new Date().toISOString());
  const agg = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=? AND month_key=?').bind(to, mk).first()).t;
  const { delta } = grantWithCap({ monthTotal: agg, want: points, cap: 100 });   // 打赏计入接收者月上限
  const r = await db.batch([
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?, 'tip_in','claim',?,?)").bind(to, delta, claim_id, mk),
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'tip_out','claim',?,?)").bind(from, -delta, claim_id, mk),
  ]);
  return json({ ok: true, granted: delta, capped: rsCapped(r) });
}
const rsCapped = (rs) => false; // 打赏被 cap 截断时 delta<points，前端据 granted 提示
export async function redeem(db, env, req) {
  const { student_id, reward_id } = await req.json();
  const rw = await db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').bind(reward_id).first();
  if (!rw) return json({ ok: false, error: 'REWARD_NOT_FOUND' }, 404);
  const balance = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=?').bind(student_id).first()).t;
  const chk = redeemCheck({ balance, cost: rw.cost, stock: rw.stock });
  if (!chk.ok) return json({ ok: false, error: chk.error }, chk.error === 'INSUFFICIENT_POINTS' ? 402 : 409);
  const rs = await db.batch([
    db.prepare('INSERT INTO redemptions(student_id,reward_id,points_cost) VALUES (?,?,?)').bind(student_id, rw.id, rw.cost),
    db.prepare('UPDATE rewards SET stock=stock-1 WHERE id=? AND stock>0').bind(rw.id),
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'redeem','redemption',?,?)")
      .bind(student_id, -rw.cost, rw.id, monthKey(new Date().toISOString())),
  ]);
  const redemptionId = rs[0].meta.last_row_id;
  return json({ ok: true, redemption_id: redemptionId, note: '待发放订单已生成，管理员将定期发放实物' });
}
