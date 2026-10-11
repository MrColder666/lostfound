// src/api/points.js —— 查询分级、打赏、兑换（v1.6.0：兑换需身份+PIN；v1.6.1：库存门防超卖）
import { tipCheck, redeemCheck, monthKey, grantWithCap } from '../lib/points.js';
import { normalize } from '../lib/verify.js';
import { verifyPin } from '../lib/pin.js';
import { pinGate } from '../lib/identity.js';
import { blocked, bump } from '../lib/guard.js';
const json = (o, s = 200) => Response.json(o, { status: s });
export async function pointsQuery(db, env, req, sid) {
  const id = sid || new URL(req.url).pathname.split('/').filter(Boolean).pop();
  const ident = await db.prepare('SELECT * FROM identities WHERE student_id=?').bind(id).first();
  if (!ident) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  const total = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=?').bind(id).first()).t;
  const contributions = (await db.prepare("SELECT COUNT(DISTINCT ref_id) c FROM points_ledger WHERE student_id=? AND reason='claim_reward'").bind(id).first()).c;
  const q = new URL(req.url).searchParams;
  const name = q.get('name');
  const pin = q.get('pin');
  if (name || pin) {
    let ok = !!(name && normalize(name) === normalize(ident.name));   // 归一化：与 kiosk 同规则
    if (!ok && pin) {   // 只读校验（不产生副作用）；失败计数防爆破
      if (await blocked(db, 'pin', id, 10, 3600000)) return json({ ok: false, error: 'TOO_MANY_PIN' }, 429);
      if (ident.pin_hash ? await verifyPin(pin, ident.pin_hash) : false) ok = true;
      else await bump(db, 'pin', id);
    }
    if (!ok) return json({ ok: false, error: 'FORBIDDEN' }, 403);
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
  if (!chk.ok) return json({ ok: false, error: chk.error }, chk.error === 'ALREADY_TIPPED' ? 409 : 400);
  const mk = monthKey(new Date().toISOString());
  const agg = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=? AND month_key=?').bind(to, mk).first()).t;
  const { delta, capped } = grantWithCap({ monthTotal: agg, want: points, cap: 100 });   // 打赏计入接收者月上限
  try {
    await db.batch([
      db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?, 'tip_in','claim',?,?)").bind(to, delta, claim_id, mk),
      db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'tip_out','claim',?,?)").bind(from, -delta, claim_id, mk),
    ]);
  } catch (e) {   // 并发双请求：唯一索引兜底 → 干净 409
    if (String(e && e.message || e).toUpperCase().includes('UNIQUE')) return json({ ok: false, error: 'ALREADY_TIPPED' }, 409);
    throw e;
  }
  return json({ ok: true, granted: delta, capped });
}
export async function redeem(db, env, req) {
  const { student_id, reward_id, name, pin } = await req.json();
  const sid = String(student_id ?? '');
  if (!/^\d{7}$/.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
  // 身份门：必须已登记 + 姓名匹配 + PIN（v1.6.0：兑换零鉴权漏洞修复）
  const idn = await db.prepare('SELECT name FROM identities WHERE student_id=?').bind(sid).first();
  if (!idn) return json({ ok: false, error: 'IDENTITY_NOT_FOUND' }, 404);
  if (normalize(name ?? '') !== normalize(idn.name)) return json({ ok: false, error: 'NAME_MISMATCH' }, 403);
  const gate = await pinGate(db, sid, pin);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  const rw = await db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').bind(reward_id).first();
  if (!rw) return json({ ok: false, error: 'REWARD_NOT_FOUND' }, 404);
  const balance = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=?').bind(sid).first()).t;
  const chk = redeemCheck({ balance, cost: rw.cost, stock: rw.stock });
  if (!chk.ok) return json({ ok: false, error: chk.error }, chk.error === 'INSUFFICIENT_POINTS' ? 402 : 409);
  // 库存门：单语句乐观锁，抢占成功才落单（v1.6.1：修复超卖）
  const upd = await db.prepare('UPDATE rewards SET stock=stock-1 WHERE id=? AND stock>0 AND active=1').bind(rw.id).run();
  if (upd.meta.changes !== 1) return json({ ok: false, error: 'OUT_OF_STOCK' }, 409);
  const rs = await db.batch([
    db.prepare('INSERT INTO redemptions(student_id,reward_id,points_cost) VALUES (?,?,?)').bind(sid, rw.id, rw.cost),
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'redeem','redemption',?,?)")
      .bind(sid, -rw.cost, rw.id, monthKey(new Date().toISOString())),
  ]);
  return json({ ok: true, redemption_id: rs[0].meta.last_row_id, note: 'Order created — staff will hand over the item' });
}
