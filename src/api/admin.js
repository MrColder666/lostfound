// src/api/admin.js —— 唯一鉴权点：口令 或 2FA 会话令牌；失败计数限流（5 次/10 分钟/IP）
import { monthKey } from '../lib/points.js';
import { blocked, bump } from '../lib/guard.js';
import { sha256Hex } from '../lib/hash.js';
import { f2aEnabled, webauthnRoutes } from './admin-webauthn.js';
import { getSettings, setSettings, DEFAULTS } from '../lib/settings.js';
const json = (o, s = 200) => Response.json(o, { status: s });
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
  const audit = (action, target) => db.prepare('INSERT INTO admin_audit(action,target) VALUES (?,?)').bind(action, target).run();
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
    const rows = await db.prepare(`
      SELECT r.id, r.points_cost, r.status, r.created_at, r.fulfilled_at,
             r.student_id, i.name AS student_name, i.class AS student_class,
             w.name AS reward_name, w.icon AS reward_icon
      FROM redemptions r
        LEFT JOIN identities i ON i.student_id = r.student_id
        LEFT JOIN rewards w ON w.id = r.reward_id
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 50`).all();
    return json({ ok: true, redemptions: rows.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/redemptions/fulfill') {
    const { id } = await req.json();
    await db.prepare("UPDATE redemptions SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=? AND status='pending'").bind(id).run();
    await audit('redemption_fulfill', `redemption:${id}`);
    return json({ ok: true });
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
    const rows = await db.prepare('SELECT id, action, target, created_at FROM admin_audit ORDER BY id DESC LIMIT 100').all();
    return json({ ok: true, audit: rows.results });
  }
  return json({ ok: false, error: 'NOT_FOUND' }, 404);
}
