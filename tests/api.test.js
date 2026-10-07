import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { listItems, getItem } from '../src/api/items.js';
import { report } from '../src/api/report.js';
const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { SLOT_COUNT: '12', FREEZE_MINUTES: '60', DROP_TTL_MINUTES: '15', PICKUP_TTL_HOURS: '48', ADMIN_TOKEN: 'T0KEN' };  // T11：补 ADMIN_TOKEN（简报 env 缺失）
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

// ---- 任务 8：kiosk ----
import { confirmDrop, verifyPickup, fulfill } from '../src/api/kiosk.js';
const jr = (o) => new Request('https://x/', { method: 'POST', body: JSON.stringify(o), headers: { 'content-type': 'application/json' } });
const mkReport = () => { const f = new FormData(); f.set('title','蓝色雨伞'); f.set('description','长柄，白色胶带缠手柄'); f.set('category','other'); f.set('location','教学楼一楼'); f.set('student_id','9031622'); f.set('name','王小明'); f.set('class','7(3)'); f.set('verify_q','手柄上有什么？'); f.set('verify_a','白色胶带'); return new Request('https://x/api/report', { method: 'POST', body: f }); };
test('confirmDrop：动态分配最小空闲格；15 分钟过期 → 410', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const reg = await (await report(db, env, await mkReport())).json();   // 修正：简报漏解包 Response.json()          // mkReport() 返回上面那种 FormData 请求
  const res = await confirmDrop(db, env, jr({ drop_code: reg.drop_code }));
  const body = await res.json();
  assert.equal(body.ok, true); assert.equal(body.slot_no, 1);   // 空柜分到 1 号格
  const item = await db.prepare("SELECT status, slot_no FROM items WHERE code=?").bind(reg.code).first();
  assert.equal(item.status, 'in_stock'); assert.equal(item.slot_no, 1);
  // 过期凭证
  const reg2 = await (await report(db, env, await mkReport())).json();
  await db.prepare("UPDATE items SET drop_expires_at='2020-01-01T00:00:00Z' WHERE code=?").bind(reg2.code).run();
  const res2 = await confirmDrop(db, env, jr({ drop_code: reg2.drop_code }));
  assert.equal(res2.status, 410);
});
test('confirmDrop：已占格被跳过；格满 → 507', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  for (let n = 1; n <= 12; n++)
    await db.prepare("INSERT INTO items(code,title,category,location,value_tier,status,registered_by,registered_via,found_at,slot_no) VALUES (?,?,?,?,?,?,?,'kiosk','2026-10-01T00:00:00Z',?)")
      .bind(`LF-X-${n}`, `物${n}`, 'other', 'x', 'normal', 'in_stock', '9031622', n).run();
  const reg = await (await report(db, env, await mkReport())).json();   // 修正：简报漏解包 Response.json()
  const res = await confirmDrop(db, env, jr({ drop_code: reg.drop_code }));
  assert.equal(res.status, 507);
});
test('fulfill 乐观锁：重复核销第二次 → 409；出库后积分入账（受月上限）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','李思远','7(3)')").run();
  const reg = await (await report(db, env, await mkReport())).json();   // 修正：简报漏解包 Response.json()
  await confirmDrop(db, env, jr({ drop_code: reg.drop_code }));
  // 直接造一条已批准的 claim（claims API 属 T9，此处不依赖）
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?, '9031623', '白色胶带', 'approved', '472916', '2026-12-01T00:00:00Z')`).bind(itemId).run();
  const f1 = await fulfill(db, env, jr({ pickup_code: '472916' }));
  assert.equal(f1.status, 200);
  const f2 = await fulfill(db, env, jr({ pickup_code: '472916' }));
  assert.equal(f2.status, 409);                          // 乐观锁拦截重复核销
  const led = await db.prepare("SELECT delta FROM points_ledger WHERE reason='claim_reward'").all();
  assert.equal(led.results.length, 1);
});

// ---- 任务 9：claims ----
import { claims, settleFreeze } from '../src/api/claims.js';
// 修正①：简报 VALUES 为 13 值对 14 列，补一个 ?（value_tier/verify_q/verify_a 三连 ?）
// 修正②：默认 createdAt 简报硬编码 '2026-10-07T07:00:00Z'（假设 now≈09:00Z），本机时钟为 UTC 03:4x，改为相对 now 拨回 2 小时
async function mkInStock(db, { vq = '手柄上有什么？', va = '白色胶带', tier = 'normal', createdAt = new Date(Date.now() - 2 * 3600000).toISOString() } = {}) {
  await db.prepare(`INSERT INTO items(code,title,description,category,location,value_tier,verify_q,verify_a,status,registered_by,registered_via,found_at,slot_no,created_at)
    VALUES ('LF-T-0001','蓝色雨伞','长柄','other','教学楼',?,?,?,'in_stock','9031624','phone','2026-10-07T06:00:00Z',2,?)`)
    .bind(tier, vq, va, createdAt).run();
  return (await db.prepare("SELECT id FROM items WHERE code='LF-T-0001'").first()).id;
}
test('答对 + 无竞争 + 已出冷冻期 → auto_approved 发领取码', async () => {
  const db = fakeDb(SCHEMA);
  const itemId = await mkInStock(db);   // created_at 已拨回 2 小时前 = 出冷冻期
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }));
  const body = await res.json();
  assert.equal(body.status, 'auto_approved');
  assert.match(body.pickup_code, /^\d{6}$/);
});
test('答错 → in_review（不拒绝）', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db);
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '红色图案' }))).json();
  assert.equal(body.status, 'in_review');
});
test('冷冻期内首个申请 → pending；settleFreeze 结算后自动通过', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 30 * 60000).toISOString() });   // 30 分钟前，仍在 1h 冷冻期
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }))).json();
  assert.equal(body.status, 'pending');
  // 修正③：测试无法真实等待冷冻期流逝，结算前把 created_at 拨回 61 分钟前模拟「到点」
  await db.prepare("UPDATE items SET created_at=? WHERE code='LF-T-0001'").bind(new Date(Date.now() - 61 * 60000).toISOString()).run();
  const settled = await (await settleFreeze(db, env)).json();
  assert.equal(settled.approved.length, 1);                     // cron 到点结算
  const row = await db.prepare("SELECT status, pickup_code FROM claims WHERE item_id=1").first();
  assert.equal(row.status, 'approved');
});
test('冷冻期内 2 人申请 → 全部 in_review', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 30 * 60000).toISOString() });
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','王小明','7(3)')").run();
  await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }));
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031622', name: '王小明', class: '7(3)', verify_answer: '白色胶带' }))).json();
  assert.equal(body.status, 'in_review');
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM claims WHERE status='in_review'").first()).c, 2);
});
test('秒领黄标：入库 10 分钟内被认领 → risk_flags 记录 SNATCH_10MIN', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 5 * 60000).toISOString() });
  await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }));
  const flag = await db.prepare("SELECT reason FROM risk_flags WHERE subject_type='item'").first();
  assert.equal(flag.reason, 'SNATCH_10MIN');
});

// ---- 任务 10：points ----
import { pointsQuery, tip, redeem } from '../src/api/points.js';
test('查询分级：仅学号 → total+contributions；带姓名 → 明细', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',10,'claim_reward','2026-10')").run();
  const basic = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622'))).json();
  assert.deepEqual(Object.keys(basic).sort(), ['contributions', 'ok', 'total']);
  const full = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622?name=' + encodeURIComponent('王小明')))).json();
  assert.equal(full.total, 10); assert.equal(full.ledger.length, 1);
  const bad = await pointsQuery(db, env, new Request('https://x/api/points/9031622?name=' + encodeURIComponent('张三')));
  assert.equal(bad.status, 403);                    // 二次校验失败
});
test('打赏三限：成功一次后重复 → 409（唯一索引兜底）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status,pickup_code) VALUES (9,1,'9031623','fulfilled','111111')").run();
  await db.prepare("INSERT INTO items(id,code,title,category,location,registered_by,registered_via,found_at,status) VALUES (1,'LF-9','雨伞','other','x','9031622','phone','2026-10-01T00:00:00Z','returned')").run();  // 修正：补齐 items 各 NOT NULL 列
  const ok1 = await tip(db, env, jr({ claim_id: 9, from: '9031623', to: '9031622', points: 5 }));
  assert.equal(ok1.status, 200);
  const ok2 = await tip(db, env, jr({ claim_id: 9, from: '9031623', to: '9031622', points: 5 }));
  assert.equal(ok2.status, 409);
});
test('兑换：余额不足 402；成功则扣分+订单 pending', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock) VALUES (1,'文具套装','Stationery',40,3)").run();
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',50,'claim_reward','2026-10')").run();
  const ok = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1 }));
  assert.equal(ok.status, 200);
  const poor = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1 }));  // 余额已扣 40，剩 10 < 40
  assert.equal(poor.status, 402);
});

// ---- 任务 11：admin + worker ----
import { admin } from '../src/api/admin.js';
const adminReq = (path, token = 'T0KEN') => new Request('https://x' + path, { headers: { 'X-Admin-Token': token } });
test('admin：无 token → 401；有 token → 复核队列', async () => {
  const db = fakeDb(SCHEMA);
  assert.equal((await admin(db, env, adminReq('/api/admin/queue'), '')).status, 401);
  // 修正：queue 查询 INNER JOIN identities，认领人身份行必须存在（真实流程 claims() 会先 upsert）
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','李思远','7(3)')").run();
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status) VALUES (1,1,'9031623','in_review')").run();
  await db.prepare("INSERT INTO items(id,code,title,category,location,registered_by,registered_via,found_at,status) VALUES (1,'LF-1','保温杯','clothing','x','9031622','phone','2026-10-07T00:00:00Z','in_stock')").run();  // 修正：补齐 items 各 NOT NULL 列
  const res = await admin(db, env, adminReq('/api/admin/queue'), 'T0KEN');
  const body = await res.json();
  assert.equal(body.ok, true); assert.equal(body.queue[0].claim_id, 1);
});
test('admin：复核通过 → 发领取码（写审计）', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','李思远','7(3)')").run();
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status) VALUES (1,1,'9031623','in_review')").run();
  const res = await admin(db, env, new Request('https://x/api/admin/review', { method: 'POST', headers: { 'X-Admin-Token': 'T0KEN', 'content-type': 'application/json' }, body: JSON.stringify({ claim_id: 1, decision: 'approve' }) }), 'T0KEN');
  assert.equal((await res.json()).ok, true);
  const c = await db.prepare('SELECT status, pickup_code FROM claims WHERE id=1').first();
  assert.equal(c.status, 'approved'); assert.match(c.pickup_code, /^\d{6}$/);
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM admin_audit").first()).c, 1);
});
