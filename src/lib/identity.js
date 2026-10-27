// src/lib/identity.js —— 身份「首写为准」+ 姓名匹配 + PIN 门（claims/kiosk/points 共用唯一实现）
import { normalize } from './verify.js';
import { hashPin, verifyPin } from './pin.js';
import { blocked, bump } from './guard.js';
import { ensureInitialPoints } from './points.js';
export async function upsertIdentitySafe(db, { student_id, name, class: cls }) {
  const idn = await db.prepare('SELECT name FROM identities WHERE student_id=?').bind(student_id).first();
  if (!idn) {
    await db.prepare('INSERT INTO identities(student_id,name,class) VALUES (?,?,?)').bind(student_id, name, cls || '').run();
    await ensureInitialPoints(db, student_id);   // v2.4.0：每个学生 67 初始积分
    return { ok: true, created: true };
  }
  if (normalize(idn.name) !== normalize(name)) return { ok: false, error: 'IDENTITY_NAME_MISMATCH' };
  await ensureInitialPoints(db, student_id);     // 后台建号 / 历史账号：补齐初始分（幂等）
  return { ok: true, created: false };
}
export async function pinGate(db, sid, pin) {
  if (!/^\d{4}$/.test(String(pin ?? ''))) return { ok: false, error: 'PIN_FORMAT', status: 400 };
  if (await blocked(db, 'pin', sid, 10, 3600000)) return { ok: false, error: 'TOO_MANY_PIN', status: 429 };
  const row = await db.prepare('SELECT pin_hash FROM identities WHERE student_id=?').bind(sid).first();
  if (!row) return { ok: false, error: 'IDENTITY_NOT_FOUND', status: 404 };
  if (row.pin_hash) {
    if (!(await verifyPin(pin, row.pin_hash))) { await bump(db, 'pin', sid); return { ok: false, error: 'PIN_INCORRECT', status: 403 }; }
  } else {
    await db.prepare('UPDATE identities SET pin_hash=? WHERE student_id=?').bind(await hashPin(pin), sid).run();  // 首次使用设置（TOFU）
  }
  return { ok: true };
}
