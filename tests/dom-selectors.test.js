// tests/dom-selectors.test.js —— 防止「把 '#id' 传给 getElementById」这类低级错误回归
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FILES = ['public/js/app.js', 'public/js/kiosk.js'];

test('前端代码不得把带 # 的选择器直接传给 getElementById', () => {
  const bad = [];
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/getElementById\(\s*(?:'#|"#)[^'"]*['"]\s*\)/g)) {
      bad.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], 'found getElementById("#...") calls: ' + bad.join(' | '));
});

test('认领提交用的是去掉井号的选择器助手', () => {
  const src = fs.readFileSync('public/js/app.js', 'utf8');
  assert.match(src, /replace\(\/\^#\//, 'submitClaim 的 $ 助手应剥掉开头的 #');
  assert.match(src, /const msg = \$\('#claimMsg'\)/, 'submitClaim 仍以 #claimMsg 取提示容器');
});
