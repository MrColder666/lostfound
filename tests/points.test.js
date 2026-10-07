import test from 'node:test';
import assert from 'node:assert/strict';
import { monthKey, grantWithCap, tipCheck, redeemCheck } from '../src/lib/points.js';
test('monthKey 取 UTC 年-月', () => {
  assert.equal(monthKey('2026-10-07T09:00:00Z'), '2026-10');
});
test('grantWithCap：上限内全额，超出截断为 0 并标记', () => {
  assert.deepEqual(grantWithCap({ monthTotal: 90, want: 10, cap: 100 }), { delta: 10, capped: false });
  assert.deepEqual(grantWithCap({ monthTotal: 95, want: 10, cap: 100 }), { delta: 5, capped: true });
  assert.deepEqual(grantWithCap({ monthTotal: 100, want: 25, cap: 100 }), { delta: 0, capped: true });
});
test('tipCheck 三限：仅限已完成认领单/打赏者=认领人/每单一次', () => {
  const claim = { status: 'fulfilled', claimant_id: '9031622', id: 7 };
  assert.deepEqual(tipCheck({ claim, tipper: '9031622', tipped: false }), { ok: true });
  assert.deepEqual(tipCheck({ claim: { ...claim, status: 'ready' }, tipper: '9031622', tipped: false }),
    { ok: false, error: 'CLAIM_NOT_FULFILLED' });
  assert.deepEqual(tipCheck({ claim, tipper: '9031623', tipped: false }),
    { ok: false, error: 'NOT_CLAIMANT' });
  assert.deepEqual(tipCheck({ claim, tipper: '9031622', tipped: true }),
    { ok: false, error: 'ALREADY_TIPPED' });
});
test('redeemCheck：余额不足/库存不足拒绝', () => {
  assert.deepEqual(redeemCheck({ balance: 50, cost: 40, stock: 2 }), { ok: true });
  assert.deepEqual(redeemCheck({ balance: 30, cost: 40, stock: 2 }), { ok: false, error: 'INSUFFICIENT_POINTS' });
  assert.deepEqual(redeemCheck({ balance: 50, cost: 40, stock: 0 }), { ok: false, error: 'OUT_OF_STOCK' });
});
