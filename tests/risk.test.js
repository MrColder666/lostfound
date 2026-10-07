import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/lib/risk.js';
const base = { latencyMin: 999, claimantMonthCount: 0, pairMonthCount: 0, claimantPerItem: 0, freezeCompeting: false };
test('全部正常 → 无黄标', () => {
  assert.deepEqual(evaluate(base), []);
});
test('六条规则各自触发', () => {
  assert.deepEqual(evaluate({ ...base, latencyMin: 9 }), ['SNATCH_10MIN']);
  assert.deepEqual(evaluate({ ...base, claimantMonthCount: 3 }), ['CLAIMANT_FREQUENT']);
  assert.deepEqual(evaluate({ ...base, pairMonthCount: 2 }), ['PAIR_FREQUENT']);
  assert.deepEqual(evaluate({ ...base, claimantPerItem: 2 }), ['MULTI_CLAIM']);
  assert.deepEqual(evaluate({ ...base, freezeCompeting: true }), ['FREEZE_COMPETING']);
  assert.deepEqual(evaluate({ ...base, dupeDesc: true }), ['DUPLICATE_DESC']);
});
test('多规则叠加返回多原因', () => {
  assert.equal(evaluate({ ...base, latencyMin: 5, pairMonthCount: 3 }).length, 2);
});
