// tests/idea-entry.test.js —— 「加建议」入口（v2.7.0）回归：按钮入口 + 站内 <dialog> 表单
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync('public/index.html', 'utf8');
const CSS = fs.readFileSync('public/css/app.css', 'utf8');
const I18N = fs.readFileSync('public/js/i18n-inline.js', 'utf8');
const APP = fs.readFileSync('public/js/app.js', 'utf8');

test('桌面侧栏底部与手机顶栏各有一个按钮入口（不再外链 GitHub）', () => {
  assert.match(HTML, /<button[^>]*class="gnav-item gnav-idea"[^>]*id="ideaLink"[^>]*aria-haspopup="dialog"/);
  assert.match(HTML, /<button[^>]*id="ideaChip"[^>]*class="idea-chip"[^>]*aria-haspopup="dialog"/);
  assert.equal(HTML.includes('github.com/MrColder666/lostfound/issues'), false, 'GitHub 链接应已移除');
  const chip = HTML.indexOf('id="ideaChip"');
  const shop = HTML.indexOf('id="shopChip"');
  assert.ok(chip > 0 && shop > chip, 'ideaChip 应在 shopChip 之前');
});

test('入口钉在侧栏底部，且按钮外观已抹平', () => {
  assert.match(CSS, /\.gnav-idea\s*\{[^}]*margin-top:\s*auto/);
  assert.match(CSS, /\.gnav-idea\s*\{[^}]*border:\s*0/);
  assert.match(CSS, /\.gnav-idea:hover \.idea-tip/);
});

test('页面内有建议表单 dialog：textarea 600 字上限 + 页面下拉 + 可选联系方式', () => {
  assert.match(HTML, /<dialog[^>]*id="ideaDialog"/);
  assert.match(HTML, /<form[^>]*id="ideaForm"/);
  assert.match(HTML, /<textarea[^>]*id="ideaText"[^>]*maxlength="600"/);
  assert.match(HTML, /<select[^>]*id="ideaPage"/);
  assert.match(HTML, /<input[^>]*id="ideaContact"/);
  assert.match(HTML, /data-i18n-ph="idea_ph"/);
  assert.match(CSS, /\.idea-dialog\s*\{/);
  assert.match(CSS, /\.idea-dialog::backdrop/);
});

test('前端提交到站内 /api/ideas，并把后端错误码映射成文案', () => {
  assert.match(APP, /api\('\/ideas'/);
  assert.match(APP, /idea_err_' \+ \(res\.body && res\.body\.error/);
  assert.match(APP, /data-i18n-ph/);            // applyStaticTexts 支持 placeholder
});

test('表单文案已进 i18n 表', () => {
  for (const key of ['idea_label', 'idea_tip', 'idea_title', 'idea_sub', 'idea_q', 'idea_send',
    'idea_cancel', 'idea_thanks', 'idea_err_TOO_SHORT', 'idea_err_TOO_MANY', 'idea_err_generic']) {
    assert.match(I18N, new RegExp(key + ":\\s*'"), 'missing i18n key ' + key);
  }
});
