// src/api/kiosk.js —— 所有状态跃迁：UPDATE…WHERE 旧状态 + changes==1（§10 乐观锁）
// v1.6.0：领取代码通道已下线 —— 现场凭「学号 + 姓名 + PIN」；verifyPickup 已删除
import { isExpired } from '../lib/codes.js';
import { grantWithCap, monthKey, monthlyEarned, finalReward, PHOTO_PENALTY } from '../lib/points.js';
import { checkImage } from '../lib/image.js';
import { normalize } from '../lib/verify.js';
import { pinGate } from '../lib/identity.js';
import { getSettings } from '../lib/settings.js';
import { putPhoto } from '../lib/photo.js';
const json = (o, s = 200) => Response.json(o, { status: s });
// 身份查询：学号 + 姓名 + PIN → 返回该生待领取的认领（不含任何码）
export async function lookupClaims(db, env, req) {
  const b = await req.json();
  const sid = String(b.student_id ?? '').trim();
  const name = String(b.name ?? '').trim();
  if (!/^\d{7}$/.test(sid)) return json({ ok: false, error: 'BAD_STUDENT_ID' }, 400);
  if (!name) return json({ ok: false, error: 'BAD_NAME' }, 400);
  const idn = await db.prepare("SELECT name FROM identities WHERE student_id=?").bind(sid).first();
  if (!idn) return json({ ok: false, error: 'IDENTITY_NOT_FOUND' }, 404);
  if (normalize(idn.name) !== normalize(name)) return json({ ok: false, error: 'NAME_MISMATCH' }, 403);
  const gate = await pinGate(db, sid, b.pin);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  const rows = await db.prepare("SELECT c.id AS claim_id, c.status, c.pickup_expires_at, i.title, i.slot_no, i.location, i.found_at, i.code FROM claims c JOIN items i ON i.id=c.item_id WHERE c.claimant_id=? AND c.status IN ('approved','auto_approved','pending','in_review') ORDER BY c.created_at DESC LIMIT 20").bind(sid).all();
  const claims = rows.results.map((r) => {
    const ready = r.status === 'approved' || r.status === 'auto_approved';
    const expired = ready ? isExpired(r.pickup_expires_at) : false;
    return { claim_id: r.claim_id, status: r.status, title: r.title, slot_no: r.slot_no, location: r.location, found_at: r.found_at, code: r.code, expired, claimable: ready && !expired };
  });
  return json({ ok: true, claims });
}
// 出库共享尾段：两条乐观锁 UPDATE + 积分结算（无照片登记 → 扣 PHOTO_PENALTY）
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
  const st = await getSettings(db);
  // v2.4.0：本月已「获得」只算归还奖励 + 打赏收入（兑换扣分、初始分不占额度）
  const earned = await monthlyEarned(db, claim.registered_by, mk);
  // v2.0.0：登记时选了「暂无图片」→ 结算扣 2 分
  const hasPhoto = !!claim.photo_path;
  const want = finalReward({ tier: claim.value_tier, hasPhoto,
    rewardNormal: st.reward_normal || 10, rewardHigh: st.reward_high || 25 });
  const { delta, capped } = grantWithCap({ monthTotal: earned, want, cap: Number(st.month_cap || 100) });
  if (delta > 0)
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'claim_reward','claim',?,?)")
      .bind(claim.registered_by, delta, claim.id, mk).run();
  return json({ ok: true, points_granted: delta, capped, has_photo: hasPhoto, photo_penalty: hasPhoto ? 0 : PHOTO_PENALTY });
}
// 出库：multipart（claim_id + student_id + name + pin + 存证照片）或 JSON 同字段
export async function fulfill(db, env, req) {
  const ct = req.headers.get('content-type') || '';
  let claim_id = '', sid = '', name = '', pin = '', evidencePath = null;
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    claim_id = String(form.get('claim_id') ?? '').trim();
    sid = String(form.get('student_id') ?? '').trim();
    name = String(form.get('name') ?? '').trim();
    pin = String(form.get('pin') ?? '').trim();
    const file = form.get('photo');
    if (file && typeof file === 'object') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const chk = checkImage(bytes);
      if (!chk.ok) return json({ ok: false, error: chk.error }, 400);
      evidencePath = `evidence/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${chk.kind === 'png' ? 'png' : 'jpg'}`;
      await putPhoto(db, env, evidencePath, bytes, chk.kind === 'png' ? 'image/png' : 'image/jpeg');
    }
  } else {
    const jb = await req.json();
    claim_id = String(jb.claim_id ?? '').trim();
    sid = String(jb.student_id ?? '').trim();
    name = String(jb.name ?? '').trim();
    pin = String(jb.pin ?? '').trim();
  }
  if (!claim_id || !sid) return json({ ok: false, error: 'MISSING_CREDENTIAL' }, 400);
  const idn = await db.prepare("SELECT name FROM identities WHERE student_id=?").bind(sid).first();
  if (!idn) return json({ ok: false, error: 'IDENTITY_NOT_FOUND' }, 404);
  if (normalize(idn.name) !== normalize(name)) return json({ ok: false, error: 'NAME_MISMATCH' }, 403);
  const gate = await pinGate(db, sid, pin);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  const claim = await db.prepare(
    `SELECT c.*, i.id AS item_id, i.value_tier, i.registered_by, i.photo_path, i.created_at AS in_stock_at
     FROM claims c JOIN items i ON i.id=c.item_id
     WHERE c.id=? AND c.claimant_id=?`).bind(claim_id, sid).first();
  if (!claim) return json({ ok: false, error: 'CLAIM_NOT_FOUND' }, 404);
  if (isExpired(claim.pickup_expires_at)) return json({ ok: false, error: 'CLAIM_EXPIRED' }, 410);
  return completeHandout(db, env, claim, evidencePath);
}
