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
import { fulfill } from '../src/api/kiosk.js';
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
  const claimId = (await db.prepare("SELECT id FROM claims WHERE item_id=?").bind(itemId).first()).id;
  const cred = { claim_id: String(claimId), student_id: '9031623', name: 'Leo Li', pin: '1234' };   // v1.6.0：身份通道（无码）
  const f1 = await fulfill(db, env, jr(cred));
  assert.equal(f1.status, 200);
  const f2 = await fulfill(db, env, jr(cred));
  assert.equal(f2.status, 409);                          // 乐观锁拦截重复核销
  const led = await db.prepare("SELECT delta FROM points_ledger WHERE reason='claim_reward'").all();
  assert.equal(led.results.length, 1);
});
test('fulfill：PIN 错误 → 403（计数防爆破）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  await db.prepare("INSERT INTO identities SET pin_hash='s$h' WHERE 1=0").run().catch(() => {});   // noop 防误用
  const reg = await (await report(db, env, await mkReport())).json();
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare("INSERT INTO claims(item_id,claimant_id,status,pickup_expires_at) VALUES (?, '9031623', 'auto_approved', '2099-12-01T00:00:00Z')").bind(itemId).run();
  const claimId = (await db.prepare("SELECT id FROM claims WHERE item_id=?").bind(itemId).first()).id;
  await fulfill(db, env, jr({ claim_id: String(claimId), student_id: '9031623', name: 'Leo Li', pin: '1234' }));  // 首次设置 PIN
  // 造第二件物品再验证错误 PIN 的拒绝路径
  await (await report(db, env, await mkReport())).json();
  const item2 = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare("INSERT INTO claims(item_id,claimant_id,status,pickup_expires_at) VALUES (?, '9031623', 'auto_approved', '2099-12-01T00:00:00Z')").bind(item2).run();
  const claim2 = (await db.prepare("SELECT id FROM claims WHERE item_id=?").bind(item2).first()).id;
  const bad = await fulfill(db, env, jr({ claim_id: String(claim2), student_id: '9031623', name: 'Leo Li', pin: '0000' }));
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error, 'PIN_INCORRECT');
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
test('答对 + 无竞争 + 已出冷冻期 → auto_approved（v1.6.0：无领取码，预留物品）', async () => {
  const db = fakeDb(SCHEMA);
  const itemId = await mkInStock(db);   // created_at 已拨回 2 小时前 = 出冷冻期
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1234', verify_answer: 'white tape' }));
  const body = await res.json();
  assert.equal(body.status, 'auto_approved');
  assert.equal(body.pickup_code, undefined);                              // 领取码通道已下线
  assert.match(body.pickup_expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await db.prepare('SELECT status FROM items WHERE id=?').bind(itemId).first()).status, 'ready');
});
test('答错也当场自动通过（全凭自觉），答案留档供 admin 参考', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db);
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1234', verify_answer: 'red pattern' }))).json();
  assert.equal(body.status, 'auto_approved');
  assert.equal(body.pickup_code, undefined);
  const row = await db.prepare('SELECT verify_answer FROM claims WHERE id=?').bind(body.id).first();
  assert.equal(row.verify_answer, 'red pattern');
});
test('冷冻期不再拦截：刚入库也可当场认领通过，物品转为 ready', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 5 * 60000).toISOString() });   // 5 分钟前入库
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1234', verify_answer: 'white tape' }))).json();
  assert.equal(body.status, 'auto_approved');
  const it = await db.prepare('SELECT status FROM items WHERE id=1').first();
  assert.equal(it.status, 'ready');                      // 物品预留给认领人，离开公示板
});
test('先到先得：第一人当场通过并预留物品，第二人无法再认领', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 30 * 60000).toISOString() });
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','Alex Wang','7(3)')").run();
  const first = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1111', verify_answer: 'white tape' }))).json();
  assert.equal(first.status, 'auto_approved');
  const second = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031622', name: 'Alex Wang', class: '7(3)', pin: '2222', verify_answer: 'white tape' }));
  assert.equal(second.status, 404);                       // 物品已预留给第一人
  assert.equal((await second.json()).error, 'ITEM_NOT_CLAIMABLE');
});
test('秒领黄标：入库 10 分钟内被认领 → risk_flags 记录 SNATCH_10MIN', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 5 * 60000).toISOString() });
  await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1234', verify_answer: 'white tape' }));
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
  // v1.6.0：PIN 路径（先设置 PIN，再验证 对/错）
  const { hashPin } = await import('../src/lib/pin.js');
  await db.prepare('UPDATE identities SET pin_hash=? WHERE student_id=?').bind(await hashPin('4321'), '9031622').run();
  const pinOk = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622?pin=4321'))).json();
  assert.equal(pinOk.total, 10);
  assert.equal(pinOk.ledger.length, 1);
  const pinBad = await pointsQuery(db, env, new Request('https://x/api/points/9031622?pin=0000'));
  assert.equal(pinBad.status, 403);
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
test('兑换：需身份+PIN；成功后扣分+订单；售罄 409 且不二次扣分', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock) VALUES (1,'文具套装','Stationery',40,1)").run();
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',100,'claim_reward','2026-10')").run();
  const noName = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1 }));
  assert.equal(noName.status, 403);                                  // v1.6.0：兑换必须姓名匹配
  const noPin = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1, name: 'Alex Wang' }));
  assert.equal(noPin.status, 400);                                   // PIN 缺失
  const ok = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1, name: 'alex wang', pin: '1234' }));  // 归一化姓名 + 首次设置 PIN
  assert.equal(ok.status, 200);
  assert.equal((await db.prepare('SELECT stock FROM rewards WHERE id=1').first()).stock, 0);
  const sold = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1, name: 'Alex Wang', pin: '1234' }));
  assert.equal(sold.status, 409);                                    // 售罄：库存门拦截（不产生订单、不扣分）
  assert.equal((await sold.json()).error, 'OUT_OF_STOCK');
  const bal = await db.prepare("SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id='9031622'").first();
  assert.equal(bal.t, 60);                                           // 100 - 40，只扣一次
});

// ---- 任务 11：admin + worker ----
import { admin } from '../src/api/admin.js';
const adminReq = (path, token = 'T0KEN') => new Request('https://x' + path, { headers: { 'X-Admin-Token': token } });
test('admin：无 token → 401；错误 token 计数限流 → 429', async () => {
  const db = fakeDb(SCHEMA);
  assert.equal((await admin(db, env, new Request('https://x/api/admin/stats'), '')).status, 401);
  assert.equal((await admin(db, env, adminReq('/api/admin/stats', 'WRONG'), '')).status, 401);
  for (let i = 0; i < 4; i++) await admin(db, env, adminReq('/api/admin/stats', 'WRONG'), '');
  const blockedRes = await admin(db, env, adminReq('/api/admin/stats', 'WRONG'), '');
  assert.equal(blockedRes.status, 429);          // 第 6 次起被限流（5 次/10 分钟/IP）
  const okRes = await admin(db, env, adminReq('/api/admin/stats'), 'T0KEN');
  assert.equal(okRes.status, 200);               // 正确口令不受限流影响
  assert.equal((await okRes.json()).ok, true);
});
test('admin/flags：列出/处理黄标', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('item','1','SNATCH_10MIN')").run();
  const list = await (await admin(db, env, adminReq('/api/admin/flags'))).json();
  assert.equal(list.flags.length, 1);
  await admin(db, env, new Request('https://x/api/admin/flags/resolve', { method: 'POST', headers: { 'X-Admin-Token': 'T0KEN', 'content-type': 'application/json' }, body: JSON.stringify({ id: list.flags[0].id }) }), 'T0KEN');
  assert.equal((await (await admin(db, env, adminReq('/api/admin/flags'))).json()).flags.length, 0);
});
test('admin/identities：搜索 / 改名 / 重置 PIN（写审计）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("UPDATE identities SET pin_hash='s$h' WHERE student_id='9031622'").run();
  const upd = await admin(db, env, adminCall('/api/admin/identities', 'POST', { student_id: '9031622', name: 'Alex W. Wang' }), 'T0KEN');
  assert.equal(upd.status, 200);
  assert.equal((await db.prepare("SELECT name FROM identities WHERE student_id='9031622'").first()).name, 'Alex W. Wang');
  await admin(db, env, adminCall('/api/admin/identities', 'POST', { student_id: '9031622', reset_pin: true }), 'T0KEN');
  assert.equal((await db.prepare("SELECT pin_hash FROM identities WHERE student_id='9031622'").first()).pin_hash, null);
  const search = await (await admin(db, env, adminReq('/api/admin/identities?q=9031'))).json();
  assert.equal(search.identities.length, 1);
  assert.ok((await db.prepare("SELECT COUNT(*) c FROM admin_audit").first()).c >= 2);
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
  await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_expires_at)
    VALUES (?, '9031623', 'white tape', 'auto_approved', '2026-12-01T00:00:00Z')`).bind(itemId).run();
  const claimId2 = (await db.prepare("SELECT id FROM claims WHERE item_id=?").bind(itemId).first()).id;
  let storedKey = null;
  const photos = { put: async (k) => { storedKey = k; }, get: async () => null };
  const fd = new FormData();
  fd.set('claim_id', String(claimId2));
  fd.set('student_id', '9031623');
  fd.set('name', 'Leo Li');
  fd.set('pin', '1234');
  fd.set('photo', new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])], 'ev.jpg', { type: 'image/jpeg' }));
  const f1 = await fulfill(db, { PHOTOS: photos }, new Request('https://x/api/kiosk/fulfill', { method: 'POST', body: fd }));
  assert.equal(f1.status, 200);
  const c = await db.prepare("SELECT status, evidence_photo_path FROM claims WHERE id=?").bind(claimId2).first();
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
const idForm = (claimId, nm, pin = '1234') => { const fd = new FormData(); fd.set('claim_id', String(claimId)); fd.set('student_id', '9031623'); fd.set('name', nm); fd.set('pin', pin); fd.set('photo', evPhoto()); return fd; };
const idFulfill = (db, photos, fd) => fulfill(db, { PHOTOS: photos }, new Request('https://x/api/kiosk/fulfill', { method: 'POST', body: fd }));
test('身份查询：学号 + 姓名匹配 → 返回待领取项，且响应中不含领取码', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await mkApprovedClaim(db);
  const body = await (await lookupClaims(db, env, jr({ student_id: '9031623', name: 'Leo Li', pin: '1234' }))).json();
  assert.equal(body.ok, true);
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0].claimable, true);
  assert.equal(JSON.stringify(body).includes('472916'), false);   // 关键：不泄露任何码
});
test('身份查询：学号不存在 → 404；姓名不匹配 → 403', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await mkApprovedClaim(db);
  const miss = await lookupClaims(db, env, jr({ student_id: '9999999', name: '谁', pin: '1234' }));
  assert.equal(miss.status, 404);
  const bad = await lookupClaims(db, env, jr({ student_id: '9031623', name: '张三', pin: '1234' }));
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
  await db.prepare("INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_expires_at) VALUES (?, '9031623', 'x', 'auto_approved', '2099-12-31T00:00:00Z')").bind(itemId).run();
  const claimId = (await db.prepare("SELECT id FROM claims WHERE item_id=?").bind(itemId).first()).id;
  const f = await fulfill(db, env, jr({ claim_id: String(claimId), student_id: '9031623', name: 'Leo Li', pin: '1234' }));
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

// ---- v1.6.0 安全加固回归 ----
test('身份防劫持：已存在学号用不同姓名 → 403，且原名不被覆盖', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  await mkInStock(db);
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Hacker Name', class: '9(9)', pin: '1234', verify_answer: 'x' }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'IDENTITY_NAME_MISMATCH');
  assert.equal((await db.prepare("SELECT name FROM identities WHERE student_id='9031623'").first()).name, 'Leo Li');
});
test('认领防刷：活跃上限 3 → 429 TOO_MANY_ACTIVE', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  for (let i = 0; i < 3; i++)
    await db.prepare("INSERT INTO claims(item_id,claimant_id,status,pickup_expires_at) VALUES (?, '9031623', 'auto_approved', '2099-01-01T00:00:00Z')").bind(100 + i).run();
  await mkInStock(db);
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1234', verify_answer: 'x' }));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'TOO_MANY_ACTIVE');
});
test('认领防刷：日上限 5 → 429 TOO_MANY_TODAY（已过期的不占活跃名额）', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','Leo Li','7(3)')").run();
  const iso = new Date().toISOString();
  for (let i = 0; i < 5; i++)
    await db.prepare("INSERT INTO claims(item_id,claimant_id,status,pickup_expires_at,created_at) VALUES (?, '9031623', 'expired', '2020-01-01T00:00:00Z', ?)").bind(200 + i, iso).run();
  await mkInStock(db);
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '1234', verify_answer: 'x' }));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'TOO_MANY_TODAY');
});
test('PIN：格式非 4 位 → 400；首设后必须匹配', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db);
  const fmt = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '12', verify_answer: 'x' }));
  assert.equal(fmt.status, 400);
  assert.equal((await fmt.json()).error, 'PIN_FORMAT');
  const first = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: 'Leo Li', class: '7(3)', pin: '2468', verify_answer: 'x' }))).json();
  assert.equal(first.ok, true);
  const row = await db.prepare("SELECT pin_hash FROM identities WHERE student_id='9031623'").first();
  assert.ok(row.pin_hash && row.pin_hash.includes('$'));   // 存的是 PBKDF2 盐+哈希，不是明文
});
test('身份查询：缺 PIN → 400；首设生效；之后 PIN 错 → 403', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await mkApprovedClaim(db);
  const noPin = await lookupClaims(db, env, jr({ student_id: '9031623', name: 'Leo Li' }));
  assert.equal(noPin.status, 400);
  const first = await lookupClaims(db, env, jr({ student_id: '9031623', name: 'Leo Li', pin: '1234' }));
  assert.equal(first.status, 200);                  // 首次使用：设置 PIN 并放行
  const wrong = await lookupClaims(db, env, jr({ student_id: '9031623', name: 'Leo Li', pin: '9999' }));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'PIN_INCORRECT');
});
test('过期释放：超时未领取 → 物品回公示板、认领单 expired（sweep）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO items(id,code,title,category,location,registered_by,registered_via,found_at,status,slot_no) VALUES (5,'LF-EX','x','other','y','9031622','phone','2026-10-01T00:00:00Z','ready',4)").run();
  await db.prepare("INSERT INTO claims(item_id,claimant_id,status,pickup_expires_at) VALUES (5,'9031623','auto_approved','2026-01-01T00:00:00Z')").run();
  await settleFreeze(db, env);
  assert.equal((await db.prepare('SELECT status FROM items WHERE id=5').first()).status, 'in_stock');
  assert.equal((await db.prepare('SELECT status FROM claims WHERE item_id=5').first()).status, 'expired');
});

// ---- v1.7.0：设置系统 / 站点公告 / 物品管理 / 会话与 Passkey ----
import { getSettings, setSettings } from '../src/lib/settings.js';
import { issueChallenge, verifyAssertion, derToRaw, b64u } from '../src/lib/webauthn.js';
import { siteInfo } from '../src/api/items.js';
test('settings：默认值 + 覆盖；report 格位数跟随设置', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await setSettings(db, { slots: 2 });
  const st = await getSettings(db);
  assert.equal(st.slots, '2');
  assert.equal(st.reward_normal, '10');                    // 未覆盖 → 默认
  const r1 = await (await report(db, env, await mkReport())).json();
  assert.equal(r1.slot_no, 1);
  const r2 = await (await report(db, env, await mkReport())).json();
  assert.equal(r2.slot_no, 2);
  const r3 = await report(db, env, await mkReport());
  assert.equal(r3.status, 507);                            // 2 格已满
});
test('site：公告栏开关与内容', async () => {
  const db = fakeDb(SCHEMA);
  const off = await (await siteInfo(db)).json();
  assert.equal(off.notice_on, false);
  await setSettings(db, { notice: 'Exams week!', notice_on: '1' });
  const on = await (await siteInfo(db)).json();
  assert.equal(on.notice_on, true);
  assert.equal(on.notice, 'Exams week!');
});
test('admin/settings：白名单校验 + 越界拒绝', async () => {
  const db = fakeDb(SCHEMA);
  const bad = await admin(db, env, adminCall('/api/admin/settings', 'POST', { slots: 999 }), 'T0KEN');
  assert.equal(bad.status, 400);
  const ok = await admin(db, env, adminCall('/api/admin/settings', 'POST', { slots: 8, reward_high: 30 }), 'T0KEN');
  assert.equal(ok.status, 200);
  const st = await (await admin(db, env, adminReq('/api/admin/settings'))).json();
  assert.equal(st.settings.slots, '8'); assert.equal(st.settings.reward_high, '30');
});
test('admin/items：编辑 + 下架/恢复 + 格位冲突 409', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO items(id,code,title,category,location,status,registered_by,registered_via,found_at,slot_no) VALUES (1,'LF-A','Old title','other','x','in_stock','9031622','phone','2026-10-01T00:00:00Z',1)").run();
  await db.prepare("INSERT INTO items(id,code,title,category,location,status,registered_by,registered_via,found_at,slot_no) VALUES (2,'LF-B','B','other','y','in_stock','9031622','phone','2026-10-01T00:00:00Z',2)").run();
  const clash = await admin(db, env, adminCall('/api/admin/items', 'POST', { id: 1, slot_no: 2 }), 'T0KEN');
  assert.equal(clash.status, 409);                          // 2 号格被占
  const edit = await admin(db, env, adminCall('/api/admin/items', 'POST', { id: 1, title: 'New title' }), 'T0KEN');
  assert.equal(edit.status, 200);
  assert.equal((await db.prepare('SELECT title FROM items WHERE id=1').first()).title, 'New title');
  await admin(db, env, adminCall('/api/admin/items', 'POST', { id: 2, status: 'voided' }), 'T0KEN');
  assert.equal((await db.prepare('SELECT status FROM items WHERE id=2').first()).status, 'voided');
  await admin(db, env, adminCall('/api/admin/items', 'POST', { id: 2, status: 'in_stock' }), 'T0KEN');
  assert.equal((await db.prepare('SELECT status FROM items WHERE id=2').first()).status, 'in_stock');
  const list = await (await admin(db, env, adminReq('/api/admin/items?status=in_stock'))).json();
  assert.equal(list.items.length, 2);
});
test('admin/ledger：流水导出端点', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',10,'claim_reward','2026-10')").run();
  const r = await (await admin(db, env, adminReq('/api/admin/ledger'))).json();
  assert.equal(r.ledger.length, 1);
  assert.equal(r.ledger[0].student_name, 'Alex Wang');
});
const derFromRaw = (raw) => {   // 测试辅助：P1363 → DER
  const enc = (u8) => { let i = 0; while (i < u8.length - 1 && u8[i] === 0) i++; let v = u8.slice(i); if (v[0] & 0x80) v = Uint8Array.from([0, ...v]); return [0x02, v.length, ...v]; };
  const r = enc(raw.slice(0, 32)), s = enc(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
};
test('Passkey：断言验签全链路（真签名）+ 各类拒绝路径', async () => {
  const db = fakeDb(SCHEMA);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  await db.prepare("INSERT INTO webauthn_creds(id,public_jwk,alg,sign_count) VALUES ('cred1',?,-7,0)").bind(JSON.stringify(jwk)).run();
  const mk = async (origin) => {
    const challenge = await issueChallenge(db, 'login');
    const cd = JSON.stringify({ type: 'webauthn.get', challenge, origin });
    const cdB = new TextEncoder().encode(cd);
    const ad = new Uint8Array(37);
    ad.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lf.xiaochangblog.dpdns.org'))), 0);
    ad[32] = 0x01;   // UP
    const signed = new Uint8Array([...ad, ...new Uint8Array(await crypto.subtle.digest('SHA-256', cdB))]);
    const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signed));
    return { id: 'cred1', authenticatorData: b64u.encode(ad), clientDataJSON: b64u.encode(cdB), signature: b64u.encode(derFromRaw(rawSig)) };
  };
  const good = await mk('https://lf.xiaochangblog.dpdns.org');
  assert.equal((await verifyAssertion(db, good)).ok, true);
  assert.equal((await verifyAssertion(db, good)).ok, false);              // 挑战一次性：已用
  const badOrigin = await mk('https://evil.example.com');
  assert.equal((await verifyAssertion(db, badOrigin)).error, 'BAD_ORIGIN');
  const tampered = await mk('https://lf.xiaochangblog.dpdns.org');
  tampered.signature = b64u.encode(derFromRaw(new Uint8Array(64).fill(1)));
  assert.equal((await verifyAssertion(db, tampered)).error, 'BAD_SIGNATURE');
  const noCred = { ...(await mk('https://lf.xiaochangblog.dpdns.org')), id: 'missing' };
  assert.equal((await verifyAssertion(db, noCred)).error, 'CRED_NOT_FOUND');
});
test('derToRaw：P1363 ↔ DER 往返一致', async () => {
  const raw = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
  const back = derToRaw(derFromRaw(raw));
  assert.deepEqual([...back], [...raw]);
});
test('2FA 门：有凭据后口令单独失效，会话令牌与 login-options 可用', async () => {
  const db = fakeDb(SCHEMA);
  const { createSession } = await import('../src/lib/webauthn.js');
  await db.prepare("INSERT INTO webauthn_creds(id,public_jwk,alg) VALUES ('c1','{}',-7)").run();
  const passOnly = await admin(db, env, adminReq('/api/admin/stats'), 'T0KEN');
  assert.equal(passOnly.status, 401);
  assert.equal((await passOnly.json()).error, 'NEED_2FA');
  const opts = await admin(db, env, new Request('https://x/api/admin/webauthn/login-options', { method: 'POST', headers: { 'X-Admin-Token': 'T0KEN' } }), 'T0KEN');
  assert.equal(opts.status, 200);                                        // 口令可进 2FA 端点
  assert.equal((await opts.json()).allowCredentials[0].id, 'c1');
  const sess = await createSession(db);
  const withSession = await admin(db, env, adminReq('/api/admin/stats', sess), '');
  assert.equal(withSession.status, 200);                                 // 会话令牌全量可用
});
