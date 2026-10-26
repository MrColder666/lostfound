// tests/admin-orders.test.js
// Reward shop back office: order state machine, cancel + refund, stock
// adjustment and the "in use" guard on deleting a reward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { admin } from '../src/api/admin.js';
import { fulfillmentPlan, cancellationPlan, stockAdjustPlan, canFulfill } from '../src/lib/order-admin.js';

const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { ADMIN_TOKEN: 'T0KEN' };

const req = (path, method = 'GET', body = null) => new Request('https://x' + path, {
  method,
  headers: { 'X-Admin-Token': 'T0KEN', ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const call = (db, path, method = 'GET', body = null) => admin(db, env, req(path, method, body), 'T0KEN');
const json = async (res) => ({ status: res.status, body: await res.json() });

// One student, one reward with 5 in stock, and a pending order that already
// took 40 points and one unit of stock, exactly like a real purchase.
async function orderFixture({ status = 'pending' } = {}) {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','Alex Wang','7(3)')").run();
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock,active) VALUES (7,'Campus tote bag','Campus tote bag',40,5,1)").run();
  await db.prepare("INSERT INTO redemptions(id,student_id,reward_id,points_cost,status) VALUES (1,'9031622',7,40,?)").bind(status).run();
  if (status === 'pending') {
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES ('9031622',-40,'redeem','redemption',1,'2026-10')").run();
    await db.prepare("UPDATE rewards SET stock = stock - 1 WHERE id = 7").run();
  }
  return db;
}
const balance = async (db) => (await db.prepare("SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger WHERE student_id='9031622'").first()).t;
const stockOf = async (db) => (await db.prepare('SELECT stock FROM rewards WHERE id=7').first()).stock;

/* ------------------------------------------------------------------ *
 * Pure state machine
 * ------------------------------------------------------------------ */

test('fulfillment: only pending can be marked as given', () => {
  assert.deepEqual(fulfillmentPlan('pending'), { ok: true, next: 'fulfilled' });
  assert.equal(fulfillmentPlan('fulfilled').error, 'ALREADY_FULFILLED');
  assert.equal(fulfillmentPlan('cancelled').error, 'ORDER_CANCELLED');
  assert.equal(fulfillmentPlan('mystery').error, 'UNKNOWN_STATUS');
  assert.equal(canFulfill('pending'), true);
  assert.equal(canFulfill('fulfilled'), false);
});

test('cancellation: pending refunds cost and puts a unit back', () => {
  assert.deepEqual(cancellationPlan({ status: 'pending', points_cost: 40, stock: 4 }), { ok: true, already: false, refund: 40, stock_after: 5, next: 'cancelled' });
  assert.deepEqual(cancellationPlan({ status: 'cancelled', points_cost: 40, stock: 5 }), { ok: true, already: true, refund: 0, stock_after: 5, next: 'cancelled' });
  assert.equal(cancellationPlan({ status: 'fulfilled', points_cost: 40, stock: 4 }).error, 'ALREADY_FULFILLED');
  assert.equal(cancellationPlan({}).error, 'UNKNOWN_STATUS');
});

test('stock adjustment: integers only, never below zero', () => {
  assert.deepEqual(stockAdjustPlan({ stock: 5, delta: 3 }), { ok: true, stock_after: 8, delta: 3 });
  assert.deepEqual(stockAdjustPlan({ stock: 1, delta: -1 }), { ok: true, stock_after: 0, delta: -1 });
  assert.equal(stockAdjustPlan({ stock: 0, delta: -1 }).error, 'NEGATIVE_STOCK');
  assert.equal(stockAdjustPlan({ stock: 5, delta: 0 }).error, 'BAD_DELTA');
  assert.equal(stockAdjustPlan({ stock: 5, delta: 2.5 }).error, 'BAD_DELTA');
  assert.equal(stockAdjustPlan({ stock: 5, delta: 1000 }).error, 'BAD_DELTA');
});

/* ------------------------------------------------------------------ *
 * API: fulfill
 * ------------------------------------------------------------------ */

test('POST /redemptions/fulfill: pending becomes fulfilled, second call 409', async () => {
  const db = await orderFixture();
  const first = await json(await call(db, '/api/admin/redemptions/fulfill', 'POST', { id: 1 }));
  assert.equal(first.status, 200);
  const row = await db.prepare('SELECT status, fulfilled_at FROM redemptions WHERE id=1').first();
  assert.equal(row.status, 'fulfilled');
  assert.match(row.fulfilled_at, /^\d{4}-\d{2}-\d{2}/);
  assert.equal((await call(db, '/api/admin/redemptions/fulfill', 'POST', { id: 1 })).status, 409);
  assert.equal((await call(db, '/api/admin/redemptions/fulfill', 'POST', { id: 404 })).status, 404);
  assert.ok(await db.prepare("SELECT 1 FROM admin_audit WHERE action='redemption_fulfill'").first());
});

/* ------------------------------------------------------------------ *
 * API: cancel + refund
 * ------------------------------------------------------------------ */

test('POST /redemptions/cancel: stock +1, points refunded, ledger and audit written', async () => {
  const db = await orderFixture();
  assert.equal(await balance(db), -40);
  assert.equal(await stockOf(db), 4);

  const res = await json(await call(db, '/api/admin/redemptions/cancel', 'POST', { id: 1 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.refunded_points, 40);
  assert.equal(res.body.stock, 5);
  assert.equal((await db.prepare('SELECT status FROM redemptions WHERE id=1').first()).status, 'cancelled');
  assert.equal(await stockOf(db), 5);
  assert.equal(await balance(db), 0);
  const refund = await db.prepare("SELECT delta, reason, ref_type, ref_id FROM points_ledger WHERE reason='redeem_refund'").all();
  assert.equal(refund.results.length, 1);
  assert.deepEqual({ ...refund.results[0] }, { delta: 40, reason: 'redeem_refund', ref_type: 'redemption', ref_id: 1 });
  const audit = await db.prepare("SELECT target, detail FROM admin_audit WHERE action='redemption_cancel'").first();
  assert.equal(audit.target, 'redemption:1');
  assert.match(audit.detail, /refund:40/);
});

test('POST /redemptions/cancel: idempotent, a second cancel does not refund twice or add stock twice', async () => {
  const db = await orderFixture();
  await call(db, '/api/admin/redemptions/cancel', 'POST', { id: 1 });
  const again = await json(await call(db, '/api/admin/redemptions/cancel', 'POST', { id: 1 }));
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(again.body.refunded_points, 0);
  assert.equal(await stockOf(db), 5);
  assert.equal(await balance(db), 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM points_ledger WHERE reason='redeem_refund'").first()).c, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM admin_audit WHERE action='redemption_cancel'").first()).c, 1);
});

test('POST /redemptions/cancel: a fulfilled order cannot be cancelled', async () => {
  const db = await orderFixture({ status: 'fulfilled' });
  const res = await json(await call(db, '/api/admin/redemptions/cancel', 'POST', { id: 1 }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'ALREADY_FULFILLED');
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM points_ledger WHERE reason='redeem_refund'").first()).c, 0);
});

test('POST /redemptions/cancel: heals an order that was cancelled without its refund', async () => {
  const db = await orderFixture();
  // Simulate a crash after the status flip but before the refund batch.
  await db.prepare("UPDATE redemptions SET status='cancelled' WHERE id=1").run();
  const res = await json(await call(db, '/api/admin/redemptions/cancel', 'POST', { id: 1 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.refunded_points, 40);
  assert.equal(await stockOf(db), 5);
  assert.equal(await balance(db), 0);
  assert.equal((await call(db, '/api/admin/redemptions/cancel', 'POST', { id: 999 })).status, 404);
});

test('GET /redemptions: lists pending, fulfilled and cancelled orders with student and reward', async () => {
  const db = await orderFixture();
  await db.prepare("INSERT INTO redemptions(id,student_id,reward_id,points_cost,status) VALUES (2,'9031622',7,40,'cancelled')").run();
  const body = await json(await call(db, '/api/admin/redemptions'));
  assert.equal(body.status, 200);
  assert.equal(body.body.redemptions.length, 2);
  assert.equal(body.body.redemptions[0].status, 'pending');            // pending sorts first
  assert.equal(body.body.redemptions[0].student_name, 'Alex Wang');
  assert.equal(body.body.redemptions[0].reward_name, 'Campus tote bag');
  const cancelled = await json(await call(db, '/api/admin/redemptions?status=cancelled'));
  assert.equal(cancelled.body.redemptions.length, 1);
});

/* ------------------------------------------------------------------ *
 * API: reward stock and delete
 * ------------------------------------------------------------------ */

test('POST /rewards/stock: plus and minus are atomic and audited', async () => {
  const db = await orderFixture();
  const up = await json(await call(db, '/api/admin/rewards/stock', 'POST', { id: 7, delta: 5 }));
  assert.equal(up.status, 200);
  assert.equal(up.body.stock, 9);
  const down = await json(await call(db, '/api/admin/rewards/stock', 'POST', { id: 7, delta: -2 }));
  assert.equal(down.body.stock, 7);
  const tooFar = await json(await call(db, '/api/admin/rewards/stock', 'POST', { id: 7, delta: -999 }));
  assert.equal(tooFar.status, 400);
  assert.equal(tooFar.body.error, 'NEGATIVE_STOCK');
  assert.equal(await stockOf(db), 7);
  assert.equal((await call(db, '/api/admin/rewards/stock', 'POST', { id: 7, delta: 0 })).status, 400);
  assert.equal((await call(db, '/api/admin/rewards/stock', 'POST', { id: 404, delta: 1 })).status, 404);
  const audit = await db.prepare("SELECT detail FROM admin_audit WHERE action='reward_stock' ORDER BY id DESC").all();
  assert.equal(audit.results.length, 2);
  assert.match(audit.results[1].detail, /delta:5/);
});

test('POST /rewards/delete: refuses when orders reference it, deletes when clean', async () => {
  const db = await orderFixture();
  const refused = await json(await call(db, '/api/admin/rewards/delete', 'POST', { id: 7 }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'REWARD_IN_USE');
  assert.deepEqual(refused.body.refs, { orders: 1 });
  assert.ok(await db.prepare('SELECT 1 FROM rewards WHERE id=7').first());

  await db.prepare('DELETE FROM redemptions').run();
  const ok = await json(await call(db, '/api/admin/rewards/delete', 'POST', { id: 7 }));
  assert.equal(ok.status, 200);
  assert.equal(await db.prepare('SELECT 1 FROM rewards WHERE id=7').first(), null);
  assert.equal((await call(db, '/api/admin/rewards/delete', 'POST', { id: 7 })).status, 404);
  assert.ok(await db.prepare("SELECT 1 FROM admin_audit WHERE action='reward_delete'").first());
});
