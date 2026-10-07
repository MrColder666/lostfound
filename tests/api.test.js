import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { listItems, getItem } from '../src/api/items.js';
import { report } from '../src/api/report.js';
const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { SLOT_COUNT: '12', FREEZE_MINUTES: '60', DROP_TTL_MINUTES: '15', PICKUP_TTL_HOURS: '48' };
async function seed(db) {  // 公共种子：一个身份
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','王小明','7(3)')").run();
}
test('listItems 只返回白名单字段（无学号/核验特征）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare(`INSERT INTO items(code,title,description,category,location,value_tier,status,registered_by,registered_via,found_at,slot_no,verify_q,verify_a)
    VALUES ('LF-2026-0001','黑色保温杯','有星黛露贴纸','clothing','图书馆 2F','normal','in_stock','9031622','phone','2026-10-07T01:20:00Z',3,'内侧有什么字','ABC')`).run();
  const res = await listItems(db, env, new Request('https://x/api/items'));
  const body = await res.json();
  assert.equal(body.ok, true);
  const item = body.items[0];
  assert.equal(item.finder_name, '王小明');
  assert.ok(!('verify_a' in item) && !('verify_q' in item));
  assert.equal(JSON.stringify(body.items).includes('9031622'), false);
});
test('report：合法登记 → 6 位凭证码 + 15 分钟过期，无格号', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const form = new FormData();
  form.set('title', '蓝色雨伞');
  form.set('description', '长柄，白色胶带缠手柄');
  form.set('category', 'other');
  form.set('location', '教学楼一楼');
  form.set('student_id', '9031622'); form.set('name', '王小明'); form.set('class', '7(3)');
  form.set('verify_q', '手柄上有什么？'); form.set('verify_a', '白色胶带');
  const res = await report(db, env, new Request('https://x/api/report', { method: 'POST', body: form }));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.drop_code, /^\d{6}$/);
  assert.equal(body.slot_no, undefined);          // 关键：不预分配格号
  const row = await db.prepare('SELECT status, drop_expires_at, verify_a FROM items WHERE code=?').bind(body.code).first();
  assert.equal(row.status, 'registered');
  // 偏差：简报硬编码下界 '2026-10-07T09:00:00Z'，与本机时钟（UTC 03:4x）不符；改为相对断言（15 分钟过期 → 至少距 now 10 分钟）
  assert.ok(row.drop_expires_at > new Date(Date.now() + 10 * 60000).toISOString());
});
test('report：学号格式非法 → 400', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const form = new FormData();
  form.set('title', 'x'); form.set('category', 'other'); form.set('location', 'y');
  form.set('student_id', '12345'); form.set('name', 'n'); form.set('class', 'c');
  form.set('verify_q', 'q'); form.set('verify_a', 'a');
  const res = await report(db, env, new Request('https://x/api/report', { method: 'POST', body: form }));
  assert.equal(res.status, 400);
});
