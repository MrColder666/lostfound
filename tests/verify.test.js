import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, similar, passes } from '../src/lib/verify.js';
test('归一化：小写、去空白/标点、全角转半角', () => {
  assert.equal(normalize('ＡＢＣ， 星黛露！'), 'abc星黛露');
});
test('相似度：同义重排高分，无关低分', () => {
  assert.ok(similar('蓝色贴纸 星黛露', '星黛露 蓝色贴纸') >= 0.8);
  assert.ok(similar('黑色保温杯', '一把钥匙') < 0.3);
});
test('passes 默认阈值 0.6；任一为空则 false', () => {
  assert.equal(passes('内侧有星星贴纸', '有星星贴纸'), true);
  assert.equal(passes('', '随便'), false);
  assert.equal(passes('有字', null), false);
});
