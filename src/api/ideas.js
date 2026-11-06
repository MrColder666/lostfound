// src/api/ideas.js —— 「加建议」提交（v2.7.0）：公开写入 + IP 限流；后台在 admin.js 里读
import { blocked, bump } from '../lib/guard.js';
import { sha256Hex } from '../lib/hash.js';

const json = (o, s = 200) => Response.json(o, { status: s });
export const IDEA_MAX = 600;
export const IDEA_MIN = 5;

export async function submitIdea(db, env, req) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'BAD_BODY' }, 400);
  const message = String(body.message ?? '').replace(/\s+/g, ' ').trim();
  const page = String(body.page ?? '').trim().slice(0, 40) || null;
  const contact = String(body.contact ?? '').trim().slice(0, 120) || null;
  if (!message) return json({ ok: false, error: 'EMPTY' }, 400);
  if (message.length < IDEA_MIN) return json({ ok: false, error: 'TOO_SHORT' }, 400);
  if (message.length > IDEA_MAX) return json({ ok: false, error: 'TOO_LONG' }, 400);
  if (contact && !/^[\p{L}\p{N}@._+\- ]{2,120}$/u.test(contact)) return json({ ok: false, error: 'BAD_CONTACT' }, 400);

  // 每个 IP 每小时最多 5 条，防刷；和 admin/PIN 共用 rate_events
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (await blocked(db, 'idea', ip, 5, 3600000)) return json({ ok: false, error: 'TOO_MANY' }, 429);
  await bump(db, 'idea', ip);

  const r = await db.prepare('INSERT INTO ideas(message,page,contact,ip_hash,created_at) VALUES (?,?,?,?,?)')
    .bind(message, page, contact, await sha256Hex(ip), new Date().toISOString()).run();
  return json({ ok: true, id: Number(r.meta.last_row_id) });
}
