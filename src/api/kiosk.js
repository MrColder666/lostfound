// src/api/kiosk.js —— 所有状态跃迁：UPDATE…WHERE 旧状态 + changes==1（§10 乐观锁）
import { isExpired } from '../lib/codes.js';
import { grantWithCap, monthKey } from '../lib/points.js';
import { checkImage } from '../lib/image.js';
const json = (o, s = 200) => Response.json(o, { status: s });
const SLOT_COUNT = (env) => Number(env.SLOT_COUNT || 12);
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
async function occupiedSlots(db) {
  const r = await db.prepare("SELECT slot_no FROM items WHERE slot_no IS NOT NULL AND status IN ('in_stock','claim_pending','ready')").all();
  return new Set(r.results.map(x => x.slot_no));
}
export async function confirmDrop(db, env, req) {
  const { drop_code } = await req.json();
  const item = await db.prepare("SELECT id, drop_expires_at FROM items WHERE drop_code=? AND status='registered'").bind(drop_code).first();
  if (!item) return json({ ok: false, error: 'VOUCHER_NOT_FOUND' }, 404);
  if (isExpired(item.drop_expires_at)) return json({ ok: false, error: 'VOUCHER_EXPIRED' }, 410);
  const used = await occupiedSlots(db);
  for (let n = 1; n <= SLOT_COUNT(env); n++) {
    if (used.has(n)) continue;
    const r = await db.prepare(
      `UPDATE items SET slot_no=?, status='in_stock', drop_code=NULL, drop_expires_at=NULL, updated_at=datetime('now')
       WHERE id=? AND status='registered' AND slot_no IS NULL`).bind(n, item.id).run();
    if (r.meta.changes === 1) return json({ ok: true, slot_no: n });   // 乐观锁成功即占格
  }
  return json({ ok: false, error: 'SLOTS_FULL' }, 507);
}
// 身份查询：学号 + 姓名双匹配，返回该生待领取/审核中的认领（不含任何码）
export async function lookupClaims(db, env, req) {
  const b = await req.json();
  const sid = String(b.student_id ?? '').trim();
  const name = String(b.name ?? '').trim();
  if (!/^\d{7}$/.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
  if (!name) return json({ ok: false, error: 'BAD_NAME' }, 400);
  const idn = await db.prepare("SELECT name FROM identities WHERE student_id=?").bind(sid).first();
  if (!idn) return json({ ok: false, error: 'IDENTITY_NOT_FOUND' }, 404);
  if (normName(idn.name) !== normName(name)) return json({ ok: false, error: 'NAME_MISMATCH' }, 403);
  const rows = await db.prepare("SELECT c.id AS claim_id, c.status, c.pickup_expires_at, i.title, i.slot_no, i.location, i.found_at, i.code FROM claims c JOIN items i ON i.id=c.item_id WHERE c.claimant_id=? AND c.status IN ('approved','auto_approved','pending','in_review') ORDER BY c.created_at DESC LIMIT 20").bind(sid).all();
  const claims = rows.results.map((r) => {
    const ready = r.status === 'approved' || r.status === 'auto_approved';
    const expired = ready ? isExpired(r.pickup_expires_at) : false;
    return { claim_id: r.claim_id, status: r.status, title: r.title, slot_no: r.slot_no, location: r.location, found_at: r.found_at, code: r.code, expired, claimable: ready && !expired };
  });
  return json({ ok: true, claims });
}
export async function verifyPickup(db, env, req) {
  const { pickup_code } = await req.json();
  const row = await db.prepare(
    `SELECT c.id, c.pickup_expires_at, c.status, i.title, i.slot_no, i.location, i.found_at
     FROM claims c JOIN items i ON i.id = c.item_id
     WHERE c.pickup_code=? AND c.status IN ('approved','auto_approved')`).bind(pickup_code).first();
  if (!row) return json({ ok: false, error: 'CODE_INVALID' }, 404);
  if (isExpired(row.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
  return json({ ok: true, claim: row });
}
// 出库共享尾段：两条乐观锁 UPDATE + 积分结算（领取码通道与身份通道共用）
async function completeHandout(db, env, claim, evidencePath) {
  const now = new Date();
  const rs = await db.batch([
    db.prepare("UPDATE items SET status='returned', updated_at=datetime('now') WHERE id=? AND status IN ('in_stock','ready')")
      .bind(claim.item_id),
    db.prepare("UPDATE claims SET status='fulfilled', fulfilled_at=datetime('now'), evidence_photo_path=COALESCE(?, evidence_photo_path) WHERE id=? AND status IN ('approved','auto_approved')")
      .bind(evidencePath, claim.id),
  ]);
  if (rs.some(r => r.meta.changes !== 1)) return json({ ok: false, error: 'CONFLICT' }, 409);
  const mk = monthKey(now.toISOString());
  const agg = await db.prepare("SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger WHERE student_id=? AND month_key=?")
    .bind(claim.registered_by, mk).first();
  const { delta, capped } = grantWithCap({ monthTotal: agg.t, want: claim.value_tier === 'high' ? 25 : 10, cap: 100 });
  if (delta > 0)
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'claim_reward','claim',?,?)")
      .bind(claim.registered_by, delta, claim.id, mk).run();
  return json({ ok: true, points_granted: delta, capped });
}
export async function fulfill(db, env, req) {
  // 支持两种通道：JSON {pickup_code} 或 multipart（pickup_code + 存证照片，§5.3-4 出库留痕）
  const ct = req.headers.get('content-type') || '';
  let pickup_code = '', claim_id = '', sid = '', name = '', evidencePath = null;
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    pickup_code = String(form.get('pickup_code') ?? '').trim();
    claim_id = String(form.get('claim_id') ?? '').trim();
    sid = String(form.get('student_id') ?? '').trim();
    name = String(form.get('name') ?? '').trim();
    const file = form.get('photo');
    if (file && typeof file === 'object') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const chk = checkImage(bytes);
      if (!chk.ok) return json({ ok: false, error: chk.error }, 400);
      evidencePath = `evidence/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${chk.kind === 'png' ? 'png' : 'jpg'}`;
      await env.PHOTOS?.put(evidencePath, bytes);
    }
  } else {
    const jb = await req.json();
    pickup_code = String(jb.pickup_code ?? '').trim();
    claim_id = String(jb.claim_id ?? '').trim();
    sid = String(jb.student_id ?? '').trim();
    name = String(jb.name ?? '').trim();
  }
  // 身份通道（无码领取）：学号 + 姓名双匹配后直接出库
  if (!pickup_code) {
    if (!claim_id || !sid) return json({ ok: false, error: 'MISSING_CREDENTIAL' }, 400);
    const idn = await db.prepare("SELECT name FROM identities WHERE student_id=?").bind(sid).first();
    if (!idn || normName(idn.name) !== normName(name)) return json({ ok: false, error: 'NAME_MISMATCH' }, 403);
    const byId = await db.prepare("SELECT c.*, i.id AS item_id, i.value_tier, i.registered_by, i.created_at AS in_stock_at FROM claims c JOIN items i ON i.id=c.item_id WHERE c.id=?").bind(claim_id).first();
    if (!byId) return json({ ok: false, error: 'CODE_INVALID' }, 404);
    if (byId.claimant_id !== sid) return json({ ok: false, error: 'IDENTITY_MISMATCH' }, 403);
    if (isExpired(byId.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
    return completeHandout(db, env, byId, evidencePath);
  }
  // 修正：此处不按状态过滤——重复核销须落到 batch 乐观锁返回 409（带过滤会提前 404）
  const claim = await db.prepare(
    `SELECT c.*, i.id AS item_id, i.value_tier, i.registered_by, i.created_at AS in_stock_at
     FROM claims c JOIN items i ON i.id=c.item_id
     WHERE c.pickup_code=?`).bind(pickup_code).first();
  if (!claim) return json({ ok: false, error: 'CODE_INVALID' }, 404);
  if (isExpired(claim.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
  return completeHandout(db, env, claim, evidencePath);
}
