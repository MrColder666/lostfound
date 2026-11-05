// tests/idea-entry.test.js —— 「加建议」入口（v2.6.4）回归：桌面侧栏 + 手机顶栏都要指向 GitHub issue
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync('public/index.html', 'utf8');
const CSS = fs.readFileSync('public/css/app.css', 'utf8');
const I18N = fs.readFileSync('public/js/i18n-inline.js', 'utf8');

const ISSUE = 'https://github.com/MrColder666/lostfound/issues/new';

test('桌面侧栏底部有 Idea 入口，且钉底、带气泡', () => {
  assert.match(HTML, /id="ideaLink"[^>]*class="[^"]*gnav-item[^"]*"|class="gnav-item gnav-idea"[^>]*id="ideaLink"/);
  assert.match(HTML, /id="ideaLink"[\s\S]{0,900}?data-i18n="idea_label"/);
  assert.match(CSS, /\.gnav-idea\s*\{[^}]*margin-top:\s*auto/);
  assert.match(CSS, /\.gnav-idea:hover \.idea-tip/);
});

test('手机顶栏有 Idea 圆形按钮，位于 Shop 胶囊之前', () => {
  const chip = HTML.indexOf('id="ideaChip"');
  const shop = HTML.indexOf('id="shopChip"');
  assert.ok(chip > 0 && shop > chip, 'ideaChip 应在 shopChip 之前');
  assert.match(CSS, /\.idea-chip\s*\{[^}]*width:\s*40px/);
});

test('两个入口都新标签打开 GitHub issue，预填标题模板，并带 noopener', () => {
  const links = [...HTML.matchAll(/<a[^>]*(?:id="ideaLink"|id="ideaChip")[^>]*>/g)].map((m) => m[0]);
  assert.equal(links.length, 2, '应恰有两个建议入口');
  for (const tag of links) {
    assert.ok(tag.includes(ISSUE), '入口链接应指向 issues/new');
    assert.match(tag, /title=%5BIdea%5D%20/, '应预填 [Idea] 标题');
    assert.match(tag, /body=%2A%2AWhat%20would%20you%20like%20to%20see/, '应预填正文模板');
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /aria-label="Suggest an idea on GitHub"/);
  }
});

test('建议入口文案已进 i18n 表', () => {
  assert.match(I18N, /idea_label:\s*'Idea'/);
  assert.match(I18N, /idea_tip:\s*'Suggest an idea on GitHub'/);
});
