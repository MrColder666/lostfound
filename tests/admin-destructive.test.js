// tests/admin-destructive.test.js
// v2.8.0：物品归档 / 恢复 / 永久删除 + 学生强删（保留物品）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { admin } from '../src/api/admin.js';

const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { ADMIN_TOKEN: 'T0KEN' };

const req = (path, method = 'GET', body = null) => new Request('https://x' + path, {
  method,
  headers: { 'X-Admin-Token': 'T0KEN', ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const call = (db, path, method = 'GET', body = null) => admin(db, env, req(path, method, body), 'T0KEN');
const json = async (res) => ({ status: res.status, body: await res.json() });

async function seed() {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class,created_at) VALUES ('9031700','Test Owner','7(1)','2026-11-01 08:00:00')").run();
  await db.prepare("INSERT INTO items(code,title,description,category,location,slot_no,status,registered_by,registered_via,found_at,photo_path) VALUES ('LF-2026-9001','Blue bottle','','other','Library',5,'in_stock','9031700','phone','2026-11-01 09:00:00','/photos/a.jpg')").run();
  const itemId = 1;
  await db.prepare("INSERT INTO claims(item_id,claimant_id,status,evidence_photo_path) VALUES (?, '9031700','auto_approved','/photos/c.jpg')").bind(itemId).run();
  await db.prepare("INSERT INTO photos(path,mime,size,bytes) VALUES ('/photos/a.jpg','image/jpeg',3,x'0102')").run();
  await db.prepare("INSERT INTO photos(path,mime,size,bytes) VALUES ('/photos/c.jpg','image/jpeg',3,x'0304')").run();
  await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('item','1','test flag')").run();
  await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('claim','1','claim flag')").run();
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031700',67,'initial','2026-11')").run();
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES ('9031700',10,'claim_reward','claim',1,'2026-11')").run();
  return { db, itemId };
}

test('归档：状态变 archived 且记住原状态，默认列表不再出现', async () => {
  const { db, itemId } = await seed();
  const r = await json(await call(db, '/api/admin/items/archive', 'POST', { id: itemId }));
  assert.equal(r.status, 200);
  const row = await db.prepare('SELECT status, prev_status FROM items WHERE id=?').bind(itemId).first();
  assert.equal(row.status, 'archived');
  assert.equal(row.prev_status, 'in_stock');

  const def = await json(await call(db, '/api/admin/items'));
  assert.equal(def.body.items.length, 0, '默认列表应排除已归档');
  const arch = await json(await call(db, '/api/admin/items?status=archived'));
  assert.equal(arch.body.items.length, 1, '归档筛选应能看到');
});

test('恢复：还原归档前的状态', async () => {
  const { db, itemId } = await seed();
  await call(db, '/api/admin/items/archive', 'POST', { id: itemId });
  const r = await json(await call(db, '/api/admin/items/unarchive', 'POST', { id: itemId }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'in_stock');
  const row = await db.prepare('SELECT status, prev_status FROM items WHERE id=?').bind(itemId).first();
  assert.equal(row.status, 'in_stock');
  assert.equal(row.prev_status, null);
});

test('永久删除：在架物品拒绝，归档后才允许，并级联清理关联记录', async () => {
  const { db, itemId } = await seed();
  const nope = await json(await call(db, '/api/admin/items/delete', 'POST', { id: itemId }));
  assert.equal(nope.status, 409);
  assert.equal(nope.body.error, 'NOT_ARCHIVED');

  await call(db, '/api/admin/items/archive', 'POST', { id: itemId });
  const ok = await json(await call(db, '/api/admin/items/delete', 'POST', { id: itemId }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.deleted, { item: 1, claims: 1, photos: 2 });

  assert.equal((await db.prepare('SELECT COUNT(*) n FROM items').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM claims').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM photos').first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM risk_flags WHERE subject_type IN ('item','claim')").first()).n, 0);
  // 积分流水不受影响（账本没有指向物品的外键）
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM points_ledger').first()).n, 2);
});

test('学生强删：物品保留并转给匿名身份，认领/积分/身份清掉', async () => {
  const { db, itemId } = await seed();
  const r = await json(await call(db, '/api/admin/students/delete', 'POST', { student_id: '9031700', force: true }));
  assert.equal(r.status, 200);
  assert.equal(r.body.kept_items, 1);

  const item = await db.prepare('SELECT registered_by FROM items WHERE id=?').bind(itemId).first();
  assert.equal(item.registered_by, '0000000', '物品应转给 Former student');
  const anon = await db.prepare("SELECT name FROM identities WHERE student_id='0000000'").first();
  assert.equal(anon.name, 'Former student');

  assert.equal((await db.prepare("SELECT COUNT(*) n FROM identities WHERE student_id='9031700'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM claims WHERE claimant_id='9031700'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM points_ledger WHERE student_id='9031700'").first()).n, 0);
});

test('学生普通删除仍受引用保护（不 force 时 409）', async () => {
  const { db } = await seed();
  const r = await json(await call(db, '/api/admin/students/delete', 'POST', { student_id: '9031700' }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'STUDENT_IN_USE');
  assert.equal(r.body.can_force, true);
});
