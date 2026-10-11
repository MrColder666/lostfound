import test from 'node:test';
import assert from 'node:assert/strict';
import { genCode, pickupExpiry, isExpired } from '../src/lib/codes.js';
test('凭证码为 6 位数字字符串', () => {
  const c = genCode();
  assert.match(c, /^\d{6}$/);
});
test('pickupExpiry = now + 48 小时（可覆盖）', () => {
  const now = new Date('2026-10-07T09:00:00Z');
  assert.equal(pickupExpiry(now), '2026-10-09T09:00:00.000Z');
});
test('isExpired 边界：过期 true、未过期 false、缺值 true', () => {
  const now = '2026-10-07T09:00:00.000Z';
  assert.equal(isExpired('2026-10-07T08:59:59.999Z', now), true);
  assert.equal(isExpired('2026-10-07T09:00:00.001Z', now), false);
  assert.equal(isExpired(null, now), true);
});
