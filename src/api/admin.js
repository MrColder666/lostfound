// src/api/admin.js —— 唯一鉴权点：口令 或 2FA 会话令牌；失败计数限流（5 次/10 分钟/IP）
import { monthKey } from '../lib/points.js';
import { blocked, bump } from '../lib/guard.js';
import { sha256Hex } from '../lib/hash.js';
import { hashPin, validPin } from '../lib/pin.js';
import { f2aEnabled, webauthnRoutes } from './admin-webauthn.js';
import { getSettings, setSettings, DEFAULTS } from '../lib/settings.js';
import {
  STUDENT_ID_RE, STUDENT_REFS, CLASS_MAX, MAX_IMPORT_CHARS,
  validateNewStudent, validateStudentPatch, parseStudentCsv, validateImportRows, summarizeImport,
  buildStudentCsv, parseStudentQuery, studentOrderBy, pageCount, deleteDecision, describeRefs, chunkArray,
} from '../lib/student-admin.js';
import { cancellationPlan, fulfillmentPlan, stockAdjustPlan } from '../lib/order-admin.js';
const json = (o, s = 200) => Response.json(o, { status: s });

/* ---- helpers shared by the student / shop endpoints (v2.0.0) ---- */

// Counts of everything that points at a student. Table and column names come
// from a fixed list in the pure module, never from the request.
async function studentRefCounts(db, sid) {
  const refs = {};
  for (const ref of STUDENT_REFS) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`).bind(sid).first();
    refs[ref.key] = Number(row?.n || 0);
  }
  return refs;
}

async function readStudent(db, sid) {
  return db.prepare(`SELECT student_id, name, class, created_at, (pin_hash IS NOT NULL) AS has_pin
    FROM identities WHERE student_id = ?`).bind(sid).first();
}

// Single id or an array, de-duplicated, at most 100 entries.
function normalizeIdList(b) {
  const raw = Array.isArray(b?.student_ids) ? b.student_ids : (b?.student_id ? [b.student_id] : []);
  const ids = [...new Set(raw.map((v) => String(v ?? '').trim()))];
  if (!ids.length || ids.length > 100 || ids.some((id) => !STUDENT_ID_RE.test(id))) return null;
  return ids;
}

// Clears every PIN in the list. Used by the single reset and the bulk action so
// the two can never drift apart.
async function resetPins(db, ids) {
  const results = [];
  for (const sid of ids) {
    const r = await db.prepare('UPDATE identities SET pin_hash=NULL WHERE student_id=?').bind(sid).run();
    results.push({ student_id: sid, status: r.meta.changes === 1 ? 'reset' : 'not_found' });
  }
  return results;
}

// Which of these ids already exist, chunked to stay under SQLite's parameter cap.
async function existingStudentIds(db, ids) {
  const found = new Set();
  for (const chunk of chunkArray([...new Set(ids)], 90)) {
    const marks = chunk.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT student_id FROM identities WHERE student_id IN (${marks})`).bind(...chunk).all();
    for (const r of rows.results) found.add(r.student_id);
  }
  return found;
}

// Deletes a student only if a fresh reference check passes. The try/catch covers
// the race where an item or claim lands between the count and the DELETE (D1
// enforces the foreign keys, so that delete would throw).
async function deleteStudentIfClean(db, sid) {
  const decision = deleteDecision(await studentRefCounts(db, sid));
  if (decision.blocked) return { status: 'blocked', refs: decision.refs, summary: describeRefs(decision.entries) };
  try {
    await db.prepare('DELETE FROM identities WHERE student_id=?').bind(sid).run();
  } catch (e) {
    const again = deleteDecision(await studentRefCounts(db, sid));
    if (again.blocked) return { status: 'blocked', refs: again.refs, summary: describeRefs(again.entries) };
    throw e;
  }
  return { status: 'deleted' };
}

const STUDENT_LIST_SQL = `
  SELECT s.student_id, s.name, s.class, s.created_at,
    (s.pin_hash IS NOT NULL) AS has_pin,
    (SELECT COALESCE(SUM(l.delta),0) FROM points_ledger l WHERE l.student_id = s.student_id) AS points,
    (SELECT COUNT(*) FROM items it WHERE it.registered_by = s.student_id) AS handed_in,
    (SELECT COUNT(*) FROM items it WHERE it.registered_by = s.student_id AND it.status = 'returned') AS returns,
    (SELECT COUNT(*) FROM claims c WHERE c.claimant_id = s.student_id) AS claims,
    (SELECT COUNT(*) FROM claims c WHERE c.claimant_id = s.student_id
       AND c.status IN ('pending','in_review','approved','auto_approved')
       AND (c.pickup_expires_at IS NULL OR c.pickup_expires_at > ?)) AS active_claims,
    (SELECT COUNT(*) FROM redemptions r2 WHERE r2.student_id = s.student_id) AS orders
  FROM identities s
  WHERE (? = '' OR s.student_id LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR s.class LIKE ? ESCAPE '\\')`;

const STUDENT_COUNT_SQL = `SELECT COUNT(*) AS total FROM identities s
  WHERE (? = '' OR s.student_id LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR s.class LIKE ? ESCAPE '\\')`;
export async function admin(db, env, req, token) {
  token = token || req.headers.get('X-Admin-Token');
  const url = new URL(req.url);
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (!token) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  const passOk = !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
  let sessionOk = false;
  if (!passOk) {
    const sess = await db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash=?').bind(await sha256Hex(token)).first();
    sessionOk = !!(sess && sess.expires_at > Date.now());
  }
  const f2a = await f2aEnabled(db);
  const isW = url.pathname.startsWith('/api/admin/webauthn/');
  if (isW && (passOk || sessionOk)) return webauthnRoutes(db, env, req, url, { passOk, sessionOk });
  const authed = sessionOk || (passOk && !f2a);
  if (!authed) {
    if (await blocked(db, 'admin', ip, 5, 600000)) return json({ ok: false, error: 'TOO_MANY_ATTEMPTS' }, 429);
    if (!passOk) await bump(db, 'admin', ip);
    return json({ ok: false, error: passOk && f2a ? 'NEED_2FA' : 'UNAUTHORIZED' }, 401);
  }
  const audit = (action, target, detail = null) =>
    db.prepare('INSERT INTO admin_audit(action,target,detail) VALUES (?,?,?)')
      .bind(action, target ?? null, detail == null ? null : String(detail).slice(0, 500)).run();
  const readBody = async () => req.json().catch(() => ({}));
  // —— 风险黄标 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/flags') {
    const flags = await db.prepare("SELECT * FROM risk_flags WHERE resolved=0 ORDER BY id DESC LIMIT 50").all();
    return json({ ok: true, flags: flags.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/flags/resolve') {
    const { id } = await req.json();
    await db.prepare('UPDATE risk_flags SET resolved=1 WHERE id=?').bind(id).run();
    await audit('flag_resolve', `flag:${id}`);
    return json({ ok: true });
  }
  // —— 看板 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
    const week = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM items WHERE status IN ('in_stock','claim_pending')) AS on_board,
      (SELECT COUNT(*) FROM items WHERE status='ready') AS reserved,
      (SELECT COUNT(*) FROM items WHERE status='returned') AS returned,
      (SELECT COUNT(*) FROM claims WHERE status IN ('approved','auto_approved')) AS active_claims`).first();
    return json({ ok: true, stats: week });
  }
  // —— 出库记录 + 撤回 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/handouts') {
    const rows = await db.prepare(`
      SELECT c.id AS claim_id, c.fulfilled_at, c.evidence_photo_path, c.review_reason,
             i.id AS item_id, i.code, i.title, i.slot_no, i.value_tier, i.status AS item_status,
             c.claimant_id, ic.name AS claimant_name, ic.class AS claimant_class,
             f.student_id AS finder_id, f.name AS finder_name, f.class AS finder_class,
             (SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE reason='claim_reward' AND ref_type='claim' AND ref_id=c.id) AS granted,
             (SELECT COUNT(*) FROM points_ledger WHERE reason='revoke' AND ref_type='claim' AND ref_id=c.id) AS revoked_n
      FROM claims c JOIN items i ON i.id=c.item_id
        JOIN identities ic ON ic.student_id=c.claimant_id
        JOIN identities f ON f.student_id=i.registered_by
      WHERE c.fulfilled_at IS NOT NULL
      ORDER BY c.fulfilled_at DESC LIMIT 30`).all();
    return json({ ok: true, handouts: rows.results.map((r) => ({ ...r, revoked: r.revoked_n > 0 })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/points/revoke') {
    const { claim_id } = await req.json();
    const claim = await db.prepare("SELECT c.id, i.registered_by AS finder FROM claims c JOIN items i ON i.id=c.item_id WHERE c.id=?").bind(claim_id).first();
    if (!claim) return json({ ok: false, error: 'CLAIM_NOT_FOUND' }, 404);
    const already = await db.prepare("SELECT id FROM points_ledger WHERE reason='revoke' AND ref_type='claim' AND ref_id=?").bind(claim_id).first();
    if (already) return json({ ok: false, error: 'ALREADY_REVOKED' }, 409);
    const sum = await db.prepare("SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger WHERE reason='claim_reward' AND ref_type='claim' AND ref_id=?").bind(claim_id).first();
    const back = -Number(sum.t || 0);
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'revoke','claim',?,?)")
      .bind(claim.finder, back, claim_id, monthKey(new Date().toISOString())).run();
    await audit('points_revoke', `claim:${claim_id}:${back}`);
    return json({ ok: true, revoked_points: back });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/items/reopen') {
    const { item_id, reason } = await req.json();
    const rs = await db.batch([
      db.prepare("UPDATE items SET status='in_stock', updated_at=datetime('now') WHERE id=? AND status='returned'").bind(item_id),
      db.prepare("UPDATE claims SET review_reason=? WHERE item_id=? AND status='fulfilled'")
        .bind(String(reason || 'ADMIN_REOPEN').slice(0, 80), item_id),
    ]);
    if (rs[0].meta.changes !== 1) return json({ ok: false, error: 'NOT_RETURNED' }, 409);
    await audit('item_reopen', `item:${item_id}${reason ? ':' + reason : ''}`);
    return json({ ok: true });
  }
  // —— 积分调整 ——
  if (req.method === 'POST' && url.pathname === '/api/admin/points/adjust') {
    const { student_id, delta } = await req.json();
    if (!/^\d{7}$/.test(String(student_id ?? '')) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000)
      return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'adjust','admin',NULL,?)")
      .bind(student_id, delta, monthKey(new Date().toISOString())).run();
    await audit('points_adjust', `${student_id}:${delta}`);
    return json({ ok: true });
  }
  // —— 兑换订单 / 奖品目录 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/redemptions') {
    const status = (url.searchParams.get('status') || '').trim();
    const rows = await db.prepare(`
      SELECT r.id, r.points_cost, r.status, r.created_at, r.fulfilled_at,
             r.student_id, i.name AS student_name, i.class AS student_class,
             r.reward_id, w.name AS reward_name, w.icon AS reward_icon, w.stock AS reward_stock
      FROM redemptions r
        LEFT JOIN identities i ON i.student_id = r.student_id
        LEFT JOIN rewards w ON w.id = r.reward_id
      WHERE (? = '' OR r.status = ?)
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100`).bind(status, status).all();
    return json({ ok: true, redemptions: rows.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/redemptions/fulfill') {
    const { id } = await readBody();
    const orderId = Number(id);
    if (!Number.isInteger(orderId) || orderId <= 0) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const order = await db.prepare('SELECT id, status FROM redemptions WHERE id=?').bind(orderId).first();
    if (!order) return json({ ok: false, error: 'ORDER_NOT_FOUND' }, 404);
    const plan = fulfillmentPlan(order.status);
    if (!plan.ok) return json({ ok: false, error: plan.error, status: order.status }, 409);
    const done = await db.prepare("UPDATE redemptions SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=? AND status='pending'").bind(orderId).run();
    if (done.meta.changes !== 1) return json({ ok: false, error: 'NOT_PENDING' }, 409);
    await audit('redemption_fulfill', `redemption:${orderId}`);
    return json({ ok: true, id: orderId, status: 'fulfilled' });
  }
  // 取消 + 退款：库存 +1、积分退回、写 redeem_refund 流水。重复取消幂等（200 already）。
  if (req.method === 'POST' && url.pathname === '/api/admin/redemptions/cancel') {
    const { id } = await readBody();
    const orderId = Number(id);
    if (!Number.isInteger(orderId) || orderId <= 0) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const order = await db.prepare(`SELECT r.id, r.status, r.points_cost, r.student_id, r.reward_id,
        w.stock AS reward_stock, w.name AS reward_name, i.name AS student_name
      FROM redemptions r
        LEFT JOIN rewards w ON w.id = r.reward_id
        LEFT JOIN identities i ON i.student_id = r.student_id
      WHERE r.id=?`).bind(orderId).first();
    if (!order) return json({ ok: false, error: 'ORDER_NOT_FOUND' }, 404);
    const plan = cancellationPlan(order);
    if (!plan.ok) return json({ ok: false, error: plan.error, status: order.status }, 409);

    const refundRow = () => db.prepare("SELECT id FROM points_ledger WHERE reason='redeem_refund' AND ref_type='redemption' AND ref_id=?").bind(orderId).first();
    const already = await refundRow();
    if (plan.already && already) {
      return json({ ok: true, id: orderId, status: 'cancelled', already: true, refunded_points: 0, stock: order.reward_stock });
    }
    if (!plan.already) {
      const claimed = await db.prepare("UPDATE redemptions SET status='cancelled' WHERE id=? AND status='pending'").bind(orderId).run();
      if (claimed.meta.changes !== 1) {
        // Someone else moved it between the read and the update.
        const now = await db.prepare('SELECT status FROM redemptions WHERE id=?').bind(orderId).first();
        if (now?.status !== 'cancelled') return json({ ok: false, error: 'NOT_PENDING', status: now?.status }, 409);
      }
    }
    try {
      await db.batch([
        db.prepare('UPDATE rewards SET stock = stock + 1 WHERE id = ?').bind(order.reward_id),
        db.prepare(`INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key)
          VALUES (?,?,'redeem_refund','redemption',?,?)`)
          .bind(order.student_id, Number(order.points_cost || 0), orderId, monthKey(new Date().toISOString())),
        db.prepare('INSERT INTO admin_audit(action,target,detail) VALUES (?,?,?)')
          .bind('redemption_cancel', `redemption:${orderId}`, `refund:${Number(order.points_cost || 0)}:reward:${order.reward_id}`),
      ]);
    } catch (e) {
      // The unique refund index caught a racing request (or a retried one).
      if (await refundRow()) {
        const now = await db.prepare('SELECT status FROM redemptions WHERE id=?').bind(orderId).first();
        return json({ ok: true, id: orderId, status: now?.status || 'cancelled', already: true, refunded_points: 0 });
      }
      return json({ ok: false, error: 'CANCEL_FAILED' }, 500);
    }
    const after = await db.prepare('SELECT stock FROM rewards WHERE id=?').bind(order.reward_id).first();
    return json({
      ok: true, id: orderId, status: 'cancelled',
      student_id: order.student_id, student_name: order.student_name || null,
      reward_name: order.reward_name || null,
      refunded_points: Number(order.points_cost || 0), stock: after ? after.stock : null,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/rewards') {
    const rows = await db.prepare('SELECT id, name, name_en, cost, stock, active, icon FROM rewards ORDER BY active DESC, cost').all();
    return json({ ok: true, rewards: rows.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/rewards') {
    const b = await req.json();
    const name = String(b.name || '').trim();
    const cost = Number(b.cost), stock = Number(b.stock);
    if (!name || !Number.isInteger(cost) || cost <= 0 || !Number.isInteger(stock) || stock < 0)
      return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const icon = String(b.icon || '').trim().slice(0, 8) || null;
    const active = b.active === false ? 0 : 1;
    const nameEn = String(b.name_en || name).trim();
    if (b.id) {
      const r = await db.prepare('UPDATE rewards SET name=?, name_en=?, cost=?, stock=?, active=?, icon=? WHERE id=?')
        .bind(name, nameEn, cost, stock, active, icon, b.id).run();
      if (r.meta.changes !== 1) return json({ ok: false, error: 'NOT_FOUND' }, 404);
      await audit('reward_update', `reward:${b.id}`);
      return json({ ok: true, id: Number(b.id) });
    }
    const r = await db.prepare('INSERT INTO rewards(name,name_en,cost,stock,active,icon) VALUES (?,?,?,?,?,?)')
      .bind(name, nameEn, cost, stock, active, icon).run();
    await audit('reward_create', `reward:${r.meta.last_row_id}`);
    return json({ ok: true, id: r.meta.last_row_id });
  }
  // 库存 +/-（原子，永不低于 0）
  if (req.method === 'POST' && url.pathname === '/api/admin/rewards/stock') {
    const b = await readBody();
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const reward = await db.prepare('SELECT id, name, stock FROM rewards WHERE id=?').bind(id).first();
    if (!reward) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    const plan = stockAdjustPlan({ stock: reward.stock, delta: b.delta });
    if (!plan.ok) return json({ ok: false, error: plan.error, stock: reward.stock }, 400);
    const r = await db.prepare('UPDATE rewards SET stock = stock + ? WHERE id=? AND stock + ? >= 0').bind(plan.delta, id, plan.delta).run();
    if (r.meta.changes !== 1) {
      const now = await db.prepare('SELECT stock FROM rewards WHERE id=?').bind(id).first();
      return json({ ok: false, error: now ? 'NEGATIVE_STOCK' : 'NOT_FOUND', stock: now ? now.stock : null }, now ? 400 : 404);
    }
    const after = await db.prepare('SELECT stock FROM rewards WHERE id=?').bind(id).first();
    await audit('reward_stock', `reward:${id}`, `delta:${plan.delta}:stock:${after?.stock}`);
    return json({ ok: true, id, stock: after?.stock, delta: plan.delta });
  }
  // 删除奖品：只有没有任何兑换单引用时才允许
  if (req.method === 'POST' && url.pathname === '/api/admin/rewards/delete') {
    const b = await readBody();
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const reward = await db.prepare('SELECT id, name FROM rewards WHERE id=?').bind(id).first();
    if (!reward) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    const refs = await db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE reward_id=?').bind(id).first();
    const orders = Number(refs?.n || 0);
    if (orders > 0) return json({ ok: false, error: 'REWARD_IN_USE', refs: { orders } }, 409);
    await db.prepare('DELETE FROM rewards WHERE id=?').bind(id).run();
    await audit('reward_delete', `reward:${id}`, `name:${reward.name}`);
    return json({ ok: true, id });
  }
  // —— 身份管理（防劫持配套：修正姓名 / 重置 PIN）——
  if (req.method === 'GET' && url.pathname === '/api/admin/identities') {
    const q = (url.searchParams.get('q') || '').trim();
    const like = '%' + q + '%';
    const rows = await db.prepare(`SELECT student_id, name, class, created_at,
        (pin_hash IS NOT NULL) AS has_pin,
        (SELECT COUNT(*) FROM items WHERE registered_by=identities.student_id) AS items_n,
        (SELECT COUNT(*) FROM claims WHERE claimant_id=identities.student_id) AS claims_n,
        (SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE student_id=identities.student_id) AS points
      FROM identities
      WHERE (? = '' OR student_id LIKE ? OR name LIKE ?)
      ORDER BY created_at DESC LIMIT 50`).bind(q, like, like).all();
    return json({ ok: true, identities: rows.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/identities') {
    const b = await req.json();
    const sid = String(b.student_id ?? '').trim();
    if (!/^\d{7}$/.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
    const idn = await db.prepare('SELECT student_id FROM identities WHERE student_id=?').bind(sid).first();
    if (!idn) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (b.reset_pin) {
      await db.prepare('UPDATE identities SET pin_hash=NULL WHERE student_id=?').bind(sid).run();
      await audit('identity_reset_pin', sid);
    }
    if (b.name || b.class) {
      const name = String(b.name || '').trim().slice(0, 30);
      const cls = String(b.class || '').trim().slice(0, 12);
      if (!name && !cls) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
      await db.prepare(`UPDATE identities SET name=COALESCE(NULLIF(?,''),name), class=COALESCE(NULLIF(?,''),class) WHERE student_id=?`)
        .bind(name, cls, sid).run();
      await audit('identity_update', `${sid}:${name || '-'}:${cls || '-'}`);
    }
    return json({ ok: true });
  }
  // —— 学生数据库（v2.0.0）：服务端搜索 + 分页 + 排序 + 每人统计 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/students') {
    const query = parseStudentQuery(url.searchParams);
    const countRow = await db.prepare(STUDENT_COUNT_SQL).bind(query.q, query.like, query.like, query.like).first();
    const total = Number(countRow?.total || 0);
    const pages = pageCount(total, query.page_size);
    const page = Math.min(query.page, pages);
    const offset = (page - 1) * query.page_size;
    const orderBy = studentOrderBy(query.sort, query.dir);
    const rows = await db.prepare(`${STUDENT_LIST_SQL} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(new Date().toISOString(), query.q, query.like, query.like, query.like, query.page_size, offset).all();
    return json({
      ok: true, students: rows.results, total, page, page_size: query.page_size, pages,
      query: { q: query.q, sort: query.sort, dir: query.dir },
    });
  }
  // 导出全部学生（固定 6 列，Excel 直接打开不乱码）
  if (req.method === 'GET' && url.pathname === '/api/admin/students/export') {
    const rows = await db.prepare(`
      SELECT s.student_id, s.name, s.class, s.created_at,
        (SELECT COALESCE(SUM(l.delta),0) FROM points_ledger l WHERE l.student_id = s.student_id) AS points,
        (SELECT COUNT(*) FROM items it WHERE it.registered_by = s.student_id AND it.status = 'returned') AS returns
      FROM identities s ORDER BY s.student_id ASC`).all();
    const csv = buildStudentCsv(rows.results);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response('\uFEFF' + csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="lf-students-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }
  // 删除前的引用检查（前端先查再弹确认框）
  if (req.method === 'GET' && url.pathname === '/api/admin/students/refs') {
    const sid = String(url.searchParams.get('student_id') || '').trim();
    if (!STUDENT_ID_RE.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
    const found = await readStudent(db, sid);
    if (!found) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    const decision = deleteDecision(await studentRefCounts(db, sid));
    return json({ ok: true, student_id: sid, name: found.name, class: found.class, refs: decision.refs, blocked: decision.blocked, summary: describeRefs(decision.entries) });
  }
  // 新建学生（可选直设 PIN）
  if (req.method === 'POST' && url.pathname === '/api/admin/students') {
    const b = await readBody();
    const v = validateNewStudent(b);
    if (!v.ok) return json({ ok: false, error: v.error, field: v.field }, 400);
    const pin = String(b.pin ?? '').trim();
    if (pin && !validPin(pin)) return json({ ok: false, error: 'BAD_PIN', field: 'pin' }, 400);
    const exists = await readStudent(db, v.value.student_id);
    if (exists) return json({ ok: false, error: 'STUDENT_EXISTS' }, 409);
    try {
      await db.prepare('INSERT INTO identities(student_id,name,class,pin_hash) VALUES (?,?,?,?)')
        .bind(v.value.student_id, v.value.name, v.value.class, pin ? await hashPin(pin) : null).run();
    } catch (e) {
      return json({ ok: false, error: 'STUDENT_EXISTS' }, 409);
    }
    await audit('student_create', v.value.student_id, `name:${v.value.name}:class:${v.value.class}:pin:${pin ? 'set' : 'none'}`);
    return json({ ok: true, student: { ...v.value, has_pin: !!pin } });
  }
  // 改姓名 / 改班级
  if (req.method === 'POST' && url.pathname === '/api/admin/students/update') {
    const b = await readBody();
    const sid = String(b.student_id ?? '').trim();
    if (!STUDENT_ID_RE.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
    const v = validateStudentPatch(b);
    if (!v.ok) return json({ ok: false, error: v.error, field: v.field }, 400);
    const found = await readStudent(db, sid);
    if (!found) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    await db.prepare("UPDATE identities SET name=COALESCE(NULLIF(?,''),name), class=COALESCE(NULLIF(?,''),class) WHERE student_id=?")
      .bind(v.value.name, v.value.class, sid).run();
    await audit('student_update', sid, `name:${v.value.name || '-'}:class:${v.value.class || '-'}`);
    return json({ ok: true, student: await readStudent(db, sid) });
  }
  // 重置 PIN（单个或批量；重置后学生首次使用时重新设置）
  if (req.method === 'POST' && url.pathname === '/api/admin/students/reset-pin') {
    const ids = normalizeIdList(await readBody());
    if (!ids) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const results = await resetPins(db, ids);
    const reset = results.filter((r) => r.status === 'reset').length;
    await audit('student_reset_pin', ids.length === 1 ? ids[0] : `students:${reset}`,
      `ids:${ids.join(',')}:reset:${reset}`);
    return json({ ok: true, results, reset, missing: ids.length - reset });
  }
  // 受保护删除：任何引用存在就 409 并报各类条数；批量逐条返回
  if (req.method === 'POST' && url.pathname === '/api/admin/students/delete') {
    const ids = normalizeIdList(await readBody());
    if (!ids) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    if (ids.length === 1) {
      const sid = ids[0];
      if (!(await readStudent(db, sid))) return json({ ok: false, error: 'NOT_FOUND' }, 404);
      const outcome = await deleteStudentIfClean(db, sid);
      if (outcome.status === 'blocked') {
        return json({ ok: false, error: 'STUDENT_IN_USE', refs: outcome.refs, summary: outcome.summary }, 409);
      }
      await audit('student_delete', sid);
      return json({ ok: true, student_id: sid, deleted: true });
    }
    const results = [];
    for (const sid of ids) {
      if (!(await readStudent(db, sid))) { results.push({ student_id: sid, status: 'not_found' }); continue; }
      const outcome = await deleteStudentIfClean(db, sid);
      if (outcome.status === 'blocked') {
        results.push({ student_id: sid, status: 'blocked', refs: outcome.refs, summary: outcome.summary });
        continue;
      }
      results.push({ student_id: sid, status: 'deleted' });
    }
    const deleted = results.filter((r) => r.status === 'deleted').length;
    const blocked = results.filter((r) => r.status === 'blocked').length;
    await audit('student_delete_bulk', `students:${ids.length}`,
      `deleted:${deleted}:blocked:${blocked}:not_found:${ids.length - deleted - blocked}`);
    return json({ ok: true, results, deleted, blocked, not_found: ids.length - deleted - blocked });
  }
  // 批量操作：统一改班级 / 批量重置 PIN
  if (req.method === 'POST' && url.pathname === '/api/admin/students/bulk') {
    const b = await readBody();
    const ids = normalizeIdList(b);
    if (!ids) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    const action = String(b.action || '');
    if (action === 'set_class') {
      const cls = String(b.class ?? '').replace(/\s+/g, ' ').trim();
      if (!cls) return json({ ok: false, error: 'CLASS_REQUIRED', field: 'class' }, 400);
      if (cls.length > CLASS_MAX) return json({ ok: false, error: 'CLASS_TOO_LONG', field: 'class' }, 400);
      const results = [];
      for (const sid of ids) {
        const r = await db.prepare('UPDATE identities SET class=? WHERE student_id=?').bind(cls, sid).run();
        results.push({ student_id: sid, status: r.meta.changes === 1 ? 'updated' : 'not_found' });
      }
      const updated = results.filter((r) => r.status === 'updated').length;
      await audit('students_set_class', `students:${ids.length}`, `class:${cls}:updated:${updated}`);
      return json({ ok: true, class: cls, results, updated, missing: ids.length - updated });
    }
    if (action === 'reset_pin') {
      const results = await resetPins(db, ids);
      const reset = results.filter((r) => r.status === 'reset').length;
      await audit('student_reset_pin', `students:${ids.length}`, `ids:${ids.join(',')}:reset:${reset}`);
      return json({ ok: true, results, reset, missing: ids.length - reset });
    }
    return json({ ok: false, error: 'BAD_ACTION' }, 400);
  }
  // CSV 导入：confirm=false 只预览，confirm=true 才写；已存在学号更新姓名/班级
  if (req.method === 'POST' && url.pathname === '/api/admin/students/import') {
    const b = await readBody();
    const csv = typeof b.csv === 'string' ? b.csv : '';
    if (!csv.trim()) return json({ ok: false, error: 'CSV_EMPTY', message: 'Paste a CSV or choose a file first.' }, 400);
    if (csv.length > MAX_IMPORT_CHARS) return json({ ok: false, error: 'CSV_TOO_LARGE', message: 'That file is too big. Import up to 200 KB at a time.' }, 413);
    const parsed = parseStudentCsv(csv);
    if (!parsed.ok) {
      const messages = {
        CSV_EMPTY: 'No rows found in that CSV.',
        CSV_BAD_HEADER: 'The header needs student_id, name and class.',
        CSV_UNTERMINATED_QUOTE: 'A quoted field is missing its closing quote.',
        TOO_MANY_ROWS: 'That is more than 1000 rows. Split it and import in parts.',
      };
      return json({ ok: false, error: parsed.error, message: messages[parsed.error] || 'Could not read that CSV.' }, 400);
    }
    const rows = validateImportRows(parsed.records);
    const existing = await existingStudentIds(db, rows.filter((r) => !r.error).map((r) => r.student_id));
    for (const r of rows) if (!r.error) r.action = existing.has(r.student_id) ? 'update' : 'create';
    const summary = summarizeImport(rows);
    summary.create = rows.filter((r) => r.action === 'create').length;
    summary.update = rows.filter((r) => r.action === 'update').length;
    const confirm = b.confirm === true || b.confirm === '1';
    if (!confirm) {
      return json({ ok: true, mode: 'preview', summary, rows: rows.map((r) => ({
        line: r.line, student_id: r.student_id, name: r.name, class: r.class,
        action: r.error ? 'error' : r.action, error: r.error, message: r.message,
      })) });
    }
    const results = [];
    for (const chunk of chunkArray(rows.filter((r) => !r.error), 20)) {
      const statements = chunk.map((r) => db.prepare(`INSERT INTO identities(student_id,name,class) VALUES (?,?,?)
        ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, class=excluded.class`)
        .bind(r.student_id, r.name, r.class));
      try {
        await db.batch(statements);
        for (const r of chunk) results.push({ line: r.line, student_id: r.student_id, status: r.action === 'create' ? 'created' : 'updated' });
      } catch (e) {
        // One bad row should not sink the whole chunk: retry row by row.
        for (const r of chunk) {
          try {
            await db.prepare(`INSERT INTO identities(student_id,name,class) VALUES (?,?,?)
              ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, class=excluded.class`)
              .bind(r.student_id, r.name, r.class).run();
            results.push({ line: r.line, student_id: r.student_id, status: r.action === 'create' ? 'created' : 'updated' });
          } catch (e2) {
            results.push({ line: r.line, student_id: r.student_id, status: 'failed', error: 'WRITE_FAILED', message: 'This row could not be saved.' });
          }
        }
      }
    }
    for (const r of rows.filter((r) => r.error)) {
      results.push({ line: r.line, student_id: r.student_id, status: 'failed', error: r.error, message: r.message });
    }
    results.sort((a, b2) => a.line - b2.line);
    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    await audit('students_import', `rows:${rows.length}`, `created:${created}:updated:${updated}:failed:${failed}`);
    return json({ ok: true, mode: 'commit', summary: { ...summary, created, updated, failed, applied: created + updated }, results });
  }
  // —— 参数设置（v1.7.0：把「能改的」都变成「能调的」）——
  if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
    return json({ ok: true, settings: await getSettings(db), defaults: DEFAULTS });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/settings') {
    const b = await req.json();
    const LIMITS = { slots: [1, 99], pickup_ttl_hours: [1, 720], claim_active_cap: [1, 99], claim_daily_cap: [1, 99],
                     reward_normal: [0, 999], reward_high: [0, 999], month_cap: [0, 9999], snatch_min: [0, 1440] };
    const clean = {};
    for (const [k, v] of Object.entries(b || {})) {
      if (!(k in DEFAULTS)) continue;
      if (k === 'notice') { clean[k] = String(v).slice(0, 300); continue; }
      if (k === 'notice_on') { clean[k] = String(v) === '1' || v === true ? '1' : '0'; continue; }
      const n = Number(v);
      const [lo, hi] = LIMITS[k] || [0, 99999];
      if (!Number.isInteger(n) || n < lo || n > hi) return json({ ok: false, error: 'BAD_FIELDS', key: k }, 400);
      clean[k] = String(n);
    }
    await setSettings(db, clean);
    await audit('settings_update', Object.keys(clean).join(','));
    return json({ ok: true, settings: await getSettings(db) });
  }
  // —— 物品管理：全状态列表 + 编辑/下架 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/items') {
    const q = (url.searchParams.get('q') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const like = '%' + q + '%';
    const rows = await db.prepare(`SELECT i.id, i.code, i.title, i.category, i.location, i.slot_no, i.status, i.value_tier,
        i.photo_path, i.created_at, i.registered_by, id2.name AS finder_name, id2.class AS finder_class
      FROM items i LEFT JOIN identities id2 ON id2.student_id=i.registered_by
      WHERE (? = '' OR i.code LIKE ? OR i.title LIKE ?) AND (? = '' OR i.status = ?)
      ORDER BY i.id DESC LIMIT 100`).bind(q, like, like, status, status).all();
    return json({ ok: true, items: rows.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/items') {
    const b = await req.json();
    const it = await db.prepare('SELECT * FROM items WHERE id=?').bind(b.id).first();
    if (!it) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    const title = String(b.title ?? it.title).trim().slice(0, 40);
    const category = String(b.category ?? it.category).trim();
    const location = String(b.location ?? it.location).trim().slice(0, 40);
    if (!title || !category || !location) return json({ ok: false, error: 'BAD_FIELDS' }, 400);
    let slot = b.slot_no === undefined || b.slot_no === '' ? it.slot_no : Number(b.slot_no);
    if (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > 99)) return json({ ok: false, error: 'BAD_SLOT' }, 400);
    if (slot !== null && slot !== it.slot_no) {
      const clash = await db.prepare("SELECT COUNT(*) c FROM items WHERE slot_no=? AND status IN ('in_stock','claim_pending','ready') AND id<>?").bind(slot, it.id).first();
      if (clash.c > 0) return json({ ok: false, error: 'SLOT_TAKEN' }, 409);
    }
    let status = it.status;
    if (b.status && ['in_stock', 'voided'].includes(b.status) && b.status !== it.status) {
      if (b.status === 'voided' && !['registered', 'in_stock', 'claim_pending'].includes(it.status)) return json({ ok: false, error: 'BAD_TRANSITION' }, 409);
      if (b.status === 'in_stock' && !['registered', 'voided'].includes(it.status)) return json({ ok: false, error: 'BAD_TRANSITION' }, 409);
      status = b.status;
    }
    await db.prepare("UPDATE items SET title=?, category=?, location=?, slot_no=?, status=?, updated_at=datetime('now') WHERE id=?")
      .bind(title, category, location, slot, status, it.id).run();
    await audit('item_update', `item:${it.id}:${status}`);
    return json({ ok: true });
  }
  // —— 积分流水（导出用）——
  if (req.method === 'GET' && url.pathname === '/api/admin/ledger') {
    const rows = await db.prepare(`SELECT l.id, l.student_id, i.name AS student_name, l.delta, l.reason, l.ref_type, l.ref_id, l.month_key, l.created_at
      FROM points_ledger l LEFT JOIN identities i ON i.student_id=l.student_id
      ORDER BY l.id DESC LIMIT 500`).all();
    return json({ ok: true, ledger: rows.results });
  }
  // —— 审计日志 ——
  if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
    const rows = await db.prepare('SELECT id, action, target, detail, created_at FROM admin_audit ORDER BY id DESC LIMIT 100').all();
    return json({ ok: true, audit: rows.results });
  }
  return json({ ok: false, error: 'NOT_FOUND' }, 404);
}
