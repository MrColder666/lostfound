// tests/ideas.test.js —— 建议箱 API（v2.7.0）：公开提交 + 限流 + 后台读取/标记/删除
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { submitIdea } from '../src/api/ideas.js';
import { admin } from '../src/api/admin.js';

const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { ADMIN_TOKEN: 'T0KEN' };

const post = (body, ip = '1.2.3.4') => new Request('https://x/api/ideas', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify(body),
});
const adminGet = (qs = '') => new Request('https://x/api/admin/ideas' + qs, { headers: { 'X-Admin-Token': 'T0KEN' } });
const adminPost = (path, body, headers = { 'X-Admin-Token': 'T0KEN', 'Content-Type': 'application/json' }) =>
  new Request('https://x/api/admin/ideas' + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('submitIdea：合法提交 → 落库（trim、page/contact 可空）', async () => {
  const db = fakeDb(SCHEMA);
  const res = await submitIdea(db, env, post({ message: '  Please add a  lost-and-found map  ', page: 'board', contact: '9031622' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const row = await db.prepare('SELECT message, page, contact, status, ip_hash FROM ideas WHERE id=?').bind(body.id).first();
  assert.equal(row.message, 'Please add a lost-and-found map');
  assert.equal(row.page, 'board');
  assert.equal(row.contact, '9031622');
  assert.equal(row.status, 'new');
  assert.ok(row.ip_hash && row.ip_hash.length >= 32, 'IP 只存哈希');
});

test('submitIdea：空 / 太短 / 太长 / 联系方式非法 → 400 且不落库', async () => {
  const db = fakeDb(SCHEMA);
  for (const [body, code] of [
    [{ message: '   ' }, 'EMPTY'],
    [{ message: 'hi' }, 'TOO_SHORT'],
    [{ message: 'x'.repeat(601) }, 'TOO_LONG'],
    [{ message: 'Looks fine', contact: 'bad<script>' }, 'BAD_CONTACT'],
  ]) {
    const res = await submitIdea(db, env, post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, code);
  }
  const n = await db.prepare('SELECT COUNT(*) c FROM ideas').first();
  assert.equal(n.c, 0);
});

test('submitIdea：同 IP 每小时第 6 条 → 429 TOO_MANY', async () => {
  const db = fakeDb(SCHEMA);
  for (let i = 0; i < 5; i += 1) {
    const r = await submitIdea(db, env, post({ message: 'Idea number ' + i }));
    assert.equal(r.status, 200);
  }
  const blocked = await submitIdea(db, env, post({ message: 'One too many' }));
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'TOO_MANY');
});

test('后台：无 token → 401；有 token → 列表 + 计数，可按状态过滤', async () => {
  const db = fakeDb(SCHEMA);
  await submitIdea(db, env, post({ message: 'Add a QR poster in the cafeteria', page: 'other' }));
  await submitIdea(db, env, post({ message: 'Let me search by locker number', page: 'board' }, '5.6.7.8'));

  const unauthorized = await admin(db, env, new Request('https://x/api/admin/ideas'), null);
  assert.equal(unauthorized.status, 401);

  const list = await (await admin(db, env, adminGet(), 'T0KEN')).json();
  assert.equal(list.ok, true);
  assert.equal(list.ideas.length, 2);
  assert.equal(list.counts.new, 2);
  assert.equal(list.counts.seen, 0);
  assert.equal(list.ideas[0].message, 'Let me search by locker number');   // 新的在前

  const seenOnly = await (await admin(db, env, adminGet('?status=seen'), 'T0KEN')).json();
  assert.equal(seenOnly.ideas.length, 0);
});

test('后台：标记已读 / 删除 / 不存在 → 404；非法字段 → 400', async () => {
  const db = fakeDb(SCHEMA);
  const created = await (await submitIdea(db, env, post({ message: 'A dark mode would be nice' }))).json();

  const bad = await admin(db, env, adminPost('/status', { id: created.id, status: 'maybe' }), 'T0KEN');
  assert.equal(bad.status, 400);

  const seen = await admin(db, env, adminPost('/status', { id: created.id, status: 'seen' }), 'T0KEN');
  assert.equal(seen.status, 200);
  const row = await db.prepare('SELECT status FROM ideas WHERE id=?').bind(created.id).first();
  assert.equal(row.status, 'seen');

  const again = await admin(db, env, adminPost('/status', { id: 9999, status: 'seen' }), 'T0KEN');
  assert.equal(again.status, 404);

  const del = await admin(db, env, adminPost('/delete', { id: created.id }), 'T0KEN');
  assert.equal(del.status, 200);
  assert.equal(await db.prepare('SELECT COUNT(*) c FROM ideas').first().then((r) => r.c), 0);

  const missing = await admin(db, env, adminPost('/delete', { id: created.id }), 'T0KEN');
  assert.equal(missing.status, 404);
});
