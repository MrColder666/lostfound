import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage, checkImage } from '../src/lib/image.js';
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
const PNG  = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]);
const FAKE = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF 冒充
test('sniffImage：jpeg/png/其它', () => {
  assert.equal(sniffImage(JPEG), 'jpeg');
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(FAKE), null);
});
test('checkImage：>1MB 拒绝、非图片拒绝、通过返回 kind', () => {
  const big = new Uint8Array(1024 * 1024 + 1);
  assert.deepEqual(checkImage(JPEG), { ok: true, kind: 'jpeg' });
  assert.deepEqual(checkImage(big), { ok: false, error: 'TOO_LARGE' });
  assert.deepEqual(checkImage(FAKE), { ok: false, error: 'NOT_IMAGE' });
});
