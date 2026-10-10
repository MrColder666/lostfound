import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { listItems, getItem } from '../src/api/items.js';
import { report } from '../src/api/report.js';
const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { SLOT_COUNT: '12', FREEZE_MINUTES: '60', DROP_TTL_MINUTES: '15', PICKUP_TTL_HOURS: '48', ADMIN_TOKEN: 'T0KEN' };  // T11：补 ADMIN_TOKEN（简报 env 缺失）
async function seed(db) {  // 公共种子：一个身份
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','Alex Wang','7(3)')").run();
}
test('listItems 只返回白名单字段（无学号/核验特征）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare(`INSERT INTO items(code,title,description,category,location,value_tier,status,registered_by,registered_via,found_at,slot_no,verify_q,verify_a)
    VALUES ('LF-2026-0001','Black thermos','StellaLou sticker','clothing','Library 2F','normal','in_stock','9031622','phone','2026-10-07T01:20:00Z',3,'Any text inside?','ABC')`).run();
  const res = await listItems(db, env, new Request('https://x/api/items'));
  const body = await res.json();
  assert.equal(body.ok, true);
  const item = body.items[0];
  assert.equal(item.finder_name, 'Alex Wang');
  assert.ok(('verify_q' in item) && !('verify_a' in item));  // 问题公开、答案保密
  assert.equal(JSON.stringify(body.items).includes('9031622'), false);
});
test('report：合法登记 → 登记即入库并分配格位（全凭自觉，无凭证码）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const form = new FormData();
  form.set('title', 'Blue umbrella');
  form.set('description', 'Long handle, wrapped with white tape');
  form.set('category', 'other');
  form.set('location', 'Main building 1F');
  form.set('student_id', '9031622'); form.set('name', 'Alex Wang'); form.set('class', '7(3)');
  form.set('verify_q', 'What is on the handle?'); form.set('verify_a', 'white tape');
  const res = await report(db, env, new Request('https://x/api/report', { method: 'POST', body: form }));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.slot_no, 1);                  // 全凭自觉：登记即入库，直接分配最小空闲格
  assert.equal(body.drop_code, undefined);        // 凭证码机制已删除
  const row = await db.prepare('SELECT status, slot_no, verify_a, created_at FROM items WHERE code=?').bind(body.code).first();
  assert.equal(row.status, 'in_stock');
  assert.equal(row.slot_no, 1);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);   // UTC ISO
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
import { verifyPickup, fulfill } from '../src/api/kiosk.js';
const jr = (o) => new Request('https://x/', { method: 'POST', body: JSON.stringify(o), headers: { 'content-type': 'application/json' } });
const mkReport = () => { const f = new FormData(); f.set('title','Blue umbrella'); f.set('description','Long handle, wrapped with white tape'); f.set('category','other'); f.set('location','Main building 1F'); f.set('student_id','9031622'); f.set('name','Alex Wang'); f.set('class','7(3)'); f.set('verify_q','What is on the handle?'); f.set('verify_a','white tape'); return new Request('https://x/api/report', { method: 'POST', body: f }); };
test('fulfill 乐观锁：重复核销第二次 → 409；出库后积分入账（受月上限）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  const reg = await (await report(db, env, await mkReport())).json();   // 修正：简报漏解包 Response.json()
  // 直接造一条已批准的 claim（claims API 属 T9，此处不依赖）
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?, '9031623', 'white tape', 'approved', '472916', '2026-12-01T00:00:00Z')`).bind(itemId).run();
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
async function mkInStock(db, { vq = 'What is on the handle?', va = 'white tape', tier = 'normal', createdAt = new Date(Date.now() - 2 * 3600000).toISOString() } = {}) {
  await db.prepare(`INSERT INTO items(code,title,description,category,location,value_tier,verify_q,verify_a,status,registered_by,registered_via,found_at,slot_no,created_at)
    VALUES ('LF-T-0001','Blue umbrella','长柄','other','教学楼',?,?,?,'in_stock','9031624','phone','2026-10-07T06:00:00Z',2,?)`)
    .bind(tier, vq, va, createdAt).run();
  return (await db.prepare("SELECT id FROM items WHERE code='LF-T-0001'").first()).id;
}
test('答对 + 无竞争 + 已出冷冻期 → auto_approved 发领取码', async () => {
  const db = fakeDb(SCHEMA);
  const itemId = await mkInStock(db);   // created_at 已拨回 2 小时前 = 出冷冻期
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', verify_answer: 'white tape' }));
  const body = await res.json();
  assert.equal(body.status, 'auto_approved');
  assert.match(body.pickup_code, /^\d{6}$/);
});
test('答错也当场自动通过（全凭自觉），答案留档供 admin 参考', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db);
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', verify_answer: 'red pattern' }))).json();
  assert.equal(body.status, 'auto_approved');
  assert.match(body.pickup_code, /^\d{6}$/);
  const row = await db.prepare('SELECT verify_answer FROM claims WHERE id=?').bind(body.id).first();
  assert.equal(row.verify_answer, 'red pattern');
});
test('冷冻期不再拦截：刚入库也可当场认领通过，物品转为 ready', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 5 * 60000).toISOString() });   // 5 分钟前入库
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', verify_answer: 'white tape' }))).json();
  assert.equal(body.status, 'auto_approved');
  assert.match(body.pickup_code, /^\d{6}$/);
  const it = await db.prepare('SELECT status FROM items WHERE id=1').first();
  assert.equal(it.status, 'ready');                      // 物品预留给认领人，离开公示板
});
test('先到先得：第一人当场通过并预留物品，第二人无法再认领', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 30 * 60000).toISOString() });
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','Alex Wang','7(3)')").run();
  const first = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', verify_answer: 'white tape' }))).json();
  assert.equal(first.status, 'auto_approved');
  const second = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031622', name: 'Alex Wang', class: '7(3)', verify_answer: 'white tape' }));
  assert.equal(second.status, 404);                       // 物品已预留给第一人
  assert.equal((await second.json()).error, 'ITEM_NOT_CLAIMABLE');
});
test('秒领黄标：入库 10 分钟内被认领 → risk_flags 记录 SNATCH_10MIN', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 5 * 60000).toISOString() });
  await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', verify_answer: 'white tape' }));
  const flag = await db.prepare("SELECT COUNT(*) c FROM risk_flags WHERE subject_type='item' AND reason='SNATCH_10MIN'").first();
  assert.ok(flag.c >= 1);
});

// ---- 任务 10：points ----
import { pointsQuery, tip, redeem } from '../src/api/points.js';
test('查询分级：仅学号 → total+contributions；带姓名 → 明细', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',10,'claim_reward','2026-10')").run();
  const basic = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622'))).json();
  assert.deepEqual(Object.keys(basic).sort(), ['contributions', 'ok', 'total']);
  const full = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622?name=' + encodeURIComponent('Alex Wang')))).json();
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
  assert.equal((await admin(db, env, new Request('https://x/api/admin/queue'), '')).status, 401);   // 无头无参 → 401
  assert.equal((await admin(db, env, adminReq('/api/admin/queue', 'WRONG'), '')).status, 401);     // 错误头令牌 → 401
  // 修正：queue 查询 INNER JOIN identities，认领人身份行必须存在（真实流程 claims() 会先 upsert）
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status) VALUES (1,1,'9031623','in_review')").run();
  await db.prepare("INSERT INTO items(id,code,title,category,location,registered_by,registered_via,found_at,status) VALUES (1,'LF-1','Thermos','clothing','x','9031622','phone','2026-10-07T00:00:00Z','in_stock')").run();  // 修正：补齐 items 各 NOT NULL 列
  const res = await admin(db, env, adminReq('/api/admin/queue'), 'T0KEN');
  const body = await res.json();
  assert.equal(body.ok, true); assert.equal(body.queue[0].claim_id, 1);
});
test('admin：复核通过 → 发领取码（写审计）', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status) VALUES (1,1,'9031623','in_review')").run();
  const res = await admin(db, env, new Request('https://x/api/admin/review', { method: 'POST', headers: { 'X-Admin-Token': 'T0KEN', 'content-type': 'application/json' }, body: JSON.stringify({ claim_id: 1, decision: 'approve' }) }), 'T0KEN');
  assert.equal((await res.json()).ok, true);
  const c = await db.prepare('SELECT status, pickup_code FROM claims WHERE id=1').first();
  assert.equal(c.status, 'approved'); assert.match(c.pickup_code, /^\d{6}$/);
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM admin_audit").first()).c, 1);
});

// ---- 修复回归：UTC ISO 时间 + 非法学号 400 ----
test('修复回归：report 落库 created_at/updated_at 为 UTC ISO（带 T）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const body = await (await report(db, env, await mkReport())).json();
  const row = await db.prepare('SELECT created_at, updated_at FROM items WHERE code=?').bind(body.code).first();
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});
test('修复回归：认领非法学号 → 400 BAD_STUDENT_ID（不再 500）', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db);
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: 'abc123', name: 'x', class: 'y', verify_answer: 'white tape' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'BAD_STUDENT_ID');
});

// ---- 补口：商城目录 / 照片回显 / fulfill multipart 存证 ----
import { listRewards, getPhoto } from '../src/api/items.js';
test('GET /api/rewards 公开目录：仅 active=1', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock,active) VALUES (1,'文具套装','Stationery',40,3,1),(2,'旧奖品','Old',10,5,0)").run();
  const body = await (await listRewards(db, env, new Request('https://x/api/rewards'))).json();
  assert.equal(body.ok, true);
  assert.equal(body.rewards.length, 1);
  assert.equal(body.rewards[0].name, '文具套装');
});
test('GET /api/photos/*：命中 200、未命中 404、未配置 PHOTOS 404、路径穿越 404', async () => {
  const db = fakeDb(SCHEMA);
  const photos = { get: async (k) => k === 'photos/a.jpg' ? { arrayBuffer: async () => new Uint8Array([0xFF, 0xD8, 0xFF]).buffer } : null };
  const hit = await getPhoto(db, { PHOTOS: photos }, new Request('https://x/api/photos/photos/a.jpg'), ['photos', 'a.jpg']);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-type'), 'image/jpeg');
  const miss = await getPhoto(db, { PHOTOS: photos }, new Request('https://x/api/photos/photos/z.jpg'), ['photos', 'z.jpg']);
  assert.equal(miss.status, 404);
  const nocfg = await getPhoto(db, {}, new Request('https://x/api/photos/photos/a.jpg'), ['photos', 'a.jpg']);
  assert.equal(nocfg.status, 404);
  const trav = await getPhoto(db, { PHOTOS: photos }, new Request('https://x/api/photos/photos/../x.jpg'), ['photos', '..', 'x.jpg']);
  assert.equal(trav.status, 404);
});
test('fulfill multipart：存证照片写入 PHOTOS 且 evidence_photo_path 落库', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  const reg = await (await report(db, env, await mkReport())).json();
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?, '9031623', 'white tape', 'approved', '472916', '2026-12-01T00:00:00Z')`).bind(itemId).run();
  let storedKey = null;
  const photos = { put: async (k) => { storedKey = k; }, get: async () => null };
  const fd = new FormData();
  fd.set('pickup_code', '472916');
  fd.set('photo', new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])], 'ev.jpg', { type: 'image/jpeg' }));
  const f1 = await fulfill(db, { PHOTOS: photos }, new Request('https://x/api/kiosk/fulfill', { method: 'POST', body: fd }));
  assert.equal(f1.status, 200);
  const c = await db.prepare("SELECT status, evidence_photo_path FROM claims WHERE pickup_code='472916'").first();
  assert.equal(c.status, 'fulfilled');
  assert.match(c.evidence_photo_path, /^evidence\//);
  assert.match(storedKey, /^evidence\//);
});

// ---- v1.2.0：身份领取（学号 + 姓名，无需领取码）----
import { lookupClaims } from '../src/api/kiosk.js';
async function mkApprovedClaim(db, code = '472916') {
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)') ON CONFLICT(student_id) DO NOTHING").run();
  const reg = await (await report(db, env, await mkReport())).json();
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare("INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at) VALUES (?, ?, 'white tape', 'approved', ?, '2099-12-31T00:00:00Z')").bind(itemId, '9031623', code).run();
  const claimId = (await db.prepare("SELECT id FROM claims WHERE pickup_code=?").bind(code).first()).id;
  return { itemId, claimId };
}
const evPhoto = () => new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])], 'ev.jpg', { type: 'image/jpeg' });
const idForm = (claimId, nm) => { const fd = new FormData(); fd.set('claim_id', String(claimId)); fd.set('student_id', '9031623'); fd.set('name', nm); fd.set('photo', evPhoto()); return fd; };
const idFulfill = (db, photos, fd) => fulfill(db, { PHOTOS: photos }, new Request('https://x/api/kiosk/fulfill', { method: 'POST', body: fd }));
test('身份查询：学号 + 姓名匹配 → 返回待领取项，且响应中不含领取码', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await mkApprovedClaim(db);
  const body = await (await lookupClaims(db, env, jr({ student_id: '9031623', name: 'Leo Li' }))).json();
  assert.equal(body.ok, true);
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0].claimable, true);
  assert.equal(JSON.stringify(body).includes('472916'), false);   // 关键：不泄露任何码
});
test('身份查询：学号不存在 → 404；姓名不匹配 → 403', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await mkApprovedClaim(db);
  const miss = await lookupClaims(db, env, jr({ student_id: '9999999', name: '谁' }));
  assert.equal(miss.status, 404);
  const bad = await lookupClaims(db, env, jr({ student_id: '9031623', name: '张三' }));
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error, 'NAME_MISMATCH');
});
test('身份领取：claim_id + 学号 + 姓名 → 出库 + 积分发放', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const { itemId, claimId } = await mkApprovedClaim(db);
  const photos = { put: async () => {}, get: async () => null };
  const r = await idFulfill(db, photos, idForm(claimId, 'Leo Li'));
  const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.ok, true); assert.equal(body.points_granted, 10);
  assert.equal((await db.prepare("SELECT status FROM items WHERE id=?").bind(itemId).first()).status, 'returned');
  assert.equal((await db.prepare("SELECT status FROM claims WHERE id=?").bind(claimId).first()).status, 'fulfilled');
});
test('身份领取：姓名错 → 403；重复领取 → 409（乐观锁）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const { claimId } = await mkApprovedClaim(db);
  const photos = { put: async () => {}, get: async () => null };
  const bad = await idFulfill(db, photos, idForm(claimId, '张三'));
  assert.equal(bad.status, 403);
  assert.equal((await idFulfill(db, photos, idForm(claimId, 'Leo Li'))).status, 200);
  assert.equal((await idFulfill(db, photos, idForm(claimId, 'Leo Li'))).status, 409);
});
test('身份领取：claim_id + 学号缺失 → 400 MISSING_CREDENTIAL', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const r = await fulfill(db, {}, new Request('https://x/api/kiosk/fulfill', { method: 'POST', body: JSON.stringify({ claim_id: '', student_id: '' }), headers: { 'content-type': 'application/json' } }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'MISSING_CREDENTIAL');
});

// ---- v1.3.0：登记即入库分格 + admin 撤回/干预（全凭自觉）----
test('report 分格：已占格被跳过；格满 → 507', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  // 12 格全满
  for (let n = 1; n <= 12; n++)
    await db.prepare("INSERT INTO items(code,title,category,location,value_tier,status,registered_by,registered_via,found_at,slot_no) VALUES (?,?,?,?,?,?,?,'kiosk','2026-10-01T00:00:00Z',?)")
      .bind(`LF-X-${n}`, `物${n}`, 'other', 'x', 'normal', 'in_stock', '9031622', n).run();
  const full = await report(db, env, await mkReport());
  assert.equal(full.status, 507);
  // 释放 1 格（改成 returned）→ 再登记应落回 1 号格
  await db.prepare("UPDATE items SET status='returned' WHERE slot_no=1").run();
  const reg = await (await report(db, env, await mkReport())).json();
  assert.equal(reg.ok, true);
  assert.equal(reg.slot_no, 1);
});
async function mkHandout(db) {
  await seed(db);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)') ON CONFLICT(student_id) DO NOTHING").run();
  const reg = await (await report(db, env, await mkReport())).json();
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare("INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at) VALUES (?, '9031623', 'x', 'approved', '111111', '2099-12-31T00:00:00Z')").bind(itemId).run();
  const claimId = (await db.prepare("SELECT id FROM claims WHERE pickup_code='111111'").first()).id;
  const f = await fulfill(db, env, jr({ pickup_code: '111111' }));
  assert.equal(f.status, 200);
  return { itemId, claimId };
}
const adminCall = (path, method='GET', body=null, token='T0KEN') => new Request('https://x'+path, { method, headers: { 'X-Admin-Token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
test('admin/handouts：列出出库记录（含积分与撤回状态）', async () => {
  const db = fakeDb(SCHEMA); const { claimId } = await mkHandout(db);
  const body = await (await admin(db, env, adminCall('/api/admin/handouts'))).json();
  assert.equal(body.handouts.length, 1);
  assert.equal(body.handouts[0].claim_id, claimId);
  assert.equal(body.handouts[0].granted, 10);
  assert.equal(body.handouts[0].revoked, false);
});
test('admin/points/revoke：冲销积分、余额归零、二次 409', async () => {
  const db = fakeDb(SCHEMA); const { claimId } = await mkHandout(db);
  const r1 = await admin(db, env, adminCall('/api/admin/points/revoke', 'POST', { claim_id: claimId }), 'T0KEN');
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).revoked_points, -10);
  const bal = await db.prepare("SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id='9031622'").first();
  assert.equal(bal.t, 0);
  const r2 = await admin(db, env, adminCall('/api/admin/points/revoke', 'POST', { claim_id: claimId }), 'T0KEN');
  assert.equal(r2.status, 409);
  const body = await (await admin(db, env, adminCall('/api/admin/handouts'))).json();
  assert.equal(body.handouts[0].revoked, true);
});
test('admin/items/reopen：出库物品重新上架；重复干预 409', async () => {
  const db = fakeDb(SCHEMA); const { itemId } = await mkHandout(db);
  const r1 = await admin(db, env, adminCall('/api/admin/items/reopen', 'POST', { item_id: itemId, reason: 'wrong pickup' }), 'T0KEN');
  assert.equal(r1.status, 200);
  assert.equal((await db.prepare('SELECT status FROM items WHERE id=?').bind(itemId).first()).status, 'in_stock');
  const r2 = await admin(db, env, adminCall('/api/admin/items/reopen', 'POST', { item_id: itemId }), 'T0KEN');
  assert.equal(r2.status, 409);
});

// ---- v1.4.0: rewards shop (admin orders / catalog management / icon field) ----
test('admin/redemptions: lists orders with student and reward', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock,active,icon) VALUES (7,'Campus tote bag','Campus tote bag',80,5,1,'👜')").run();
  await db.prepare("INSERT INTO redemptions(student_id,reward_id,points_cost) VALUES ('9031622',7,80)").run();
  const body = await (await admin(db, env, adminReq('/api/admin/redemptions'))).json();
  assert.equal(body.ok, true);
  assert.equal(body.redemptions[0].reward_name, 'Campus tote bag');
  assert.equal(body.redemptions[0].student_name, 'Alex Wang');
  assert.equal(body.redemptions[0].status, 'pending');
});
test('admin/rewards: create + update + validation', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const create = await admin(db, env, adminCall('/api/admin/rewards', 'POST', { name: 'Sticker pack', cost: 20, stock: 10, icon: '✨' }));
  const cb = await create.json();
  assert.equal(cb.ok, true); assert.ok(cb.id);
  const bad = await admin(db, env, adminCall('/api/admin/rewards', 'POST', { name: '', cost: 0, stock: 1 }));
  assert.equal(bad.status, 400);
  const upd = await admin(db, env, adminCall('/api/admin/rewards', 'POST', { id: cb.id, name: 'Sticker pack XL', cost: 25, stock: 3, icon: '✨', active: true }));
  assert.equal((await upd.json()).ok, true);
  const row = await db.prepare('SELECT name, cost, stock FROM rewards WHERE id=?').bind(cb.id).first();
  assert.equal(row.name, 'Sticker pack XL'); assert.equal(row.cost, 25); assert.equal(row.stock, 3);
});
test('public catalog exposes the icon field', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock,active,icon) VALUES (1,'Pencil','Pencil',10,5,1,'✏️')").run();
  const body = await (await listRewards(db, env, new Request('https://x/api/rewards'))).json();
  assert.equal(body.rewards[0].icon, '✏️');
});
