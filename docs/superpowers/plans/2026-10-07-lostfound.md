# L&F 失物招领系统 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按 `docs/superpowers/specs/2026-10-07-lostfound-design.md`（v0.2.0）实现 L&F 双路径失物招领系统：Cloudflare Workers API + D1，手机网页（公示/登记/认领/积分）+ iPad kiosk PWA + 隐藏后台。

**架构：** 单仓库单 Worker：`/api/*` 走 Workers 处理（D1 持久化），其余路径回退静态资产。所有状态跃迁走乐观锁（`UPDATE … WHERE status=…` + `changes==1`）。凭证码/领取码为 6 位数字；核验靠非公开特征归一化模糊匹配 + 冷冻期（Worker Cron 每 5 分钟结算）；照片前端 Canvas 重绘去 Exif、后端 Magic Byte 校验。

**技术栈：** 原生 HTML/CSS/JS（无框架）、Cloudflare Workers + D1、jsQR（本地 vendor）、node --test（lib 纯函数单测，handler 以 `(db, env, req)` 纯函数形式注入内存假 db 测试）。**本地 iSH 不跑 wrangler**（workerd 无 musl 构建）：本地 = 单测 + 静态预览；真机验证 = 推 GitHub → Workers Builds 自动部署（与 SEC 官网同法）。

**规格映射：** §4 流程 → T7-T9；§5 规则 → T4/T6/T10；§6 核验 → T3/T9；§8 视觉 → T12；§9 界面/大屏 → T13/T14/T15；§10 架构 → T1/T7-T11；§13 边界 → 各任务测试；§14 测试 → 每任务测试步骤。

---

## 文件结构（职责即分解依据）

```
lostfound/
├── wrangler.jsonc              # Worker 配置：D1 绑定、ASSETS、Cron 触发器
├── package.json                # test 脚本（node --test）+ 依赖（仅 dev：wrangler 不装）
├── schema.sql                  # D1 全部建表（唯一 schema 来源）
├── seed.sql                    # 演示种子数据（上线清单用）
├── src/
│   ├── worker.js               # 入口：/api 路由分发 + cron(冷冻期结算) + 静态回退
│   ├── lib/
│   │   ├── codes.js            # 凭证码/领取码生成、过期判断（纯函数）
│   │   ├── verify.js           # 归一化 + 模糊匹配（纯函数）
│   │   ├── points.js           # 结算、月上限、打赏三限、兑换（纯函数）
│   │   ├── image.js            # Magic Byte + 体积校验（纯函数）
│   │   └── risk.js             # 黄标规则判定（纯函数）
│   └── api/
│       ├── items.js            # GET 公示列表/详情（字段白名单，无学号/核验特征）
│       ├── report.js           # POST 登记 → 生成凭证码（15 分钟），不分配格号
│       ├── kiosk.js            # confirm-drop（动态分格）/ verify-pickup / fulfill（乐观锁）
│       ├── claims.js           # 认领申请（核验匹配 + 冷冻期）
│       ├── points.js           # 查询分级 / 打赏 / 兑换
│       └── admin.js            # 后台 API（X-Admin-Token）
├── public/
│   ├── index.html              # 手机端（hash 路由单页）
│   ├── kiosk.html              # iPad 端状态机
│   ├── admin.html              # 隐藏后台（口令 → token）
│   ├── manifest.webmanifest    # PWA（kiosk 安装用）
│   ├── sw.js                   # 静态壳缓存（网络优先 API、缓存优先静态）
│   ├── css/tokens.css          # 设计 token（§8 全量）
│   ├── css/app.css             # 手机端 + 后台组件样式
│   ├── css/kiosk.css           # kiosk 横屏样式
│   ├── js/app.js               # 手机端逻辑（路由、登记、认领、积分）
│   ├── js/idb.js               # IndexedDB 封装（drafts/queue 两个 store）
│   ├── js/canvas-image.js      # Canvas 重绘导出（去 Exif + 压缩）
│   ├── js/kiosk.js             # kiosk 状态机逻辑
│   └── vendor/jsqr.js          # jsQR 本地拷贝（不进 CDN）
├── tests/
│   ├── schema.test.js          # schema.sql 可执行 + 表齐全
│   ├── codes.test.js  verify.test.js  points.test.js  image.test.js  risk.test.js
│   ├── fake-db.js              # 内存 D1 适配器（batch/prepare/first/all/run + meta.changes）
│   └── api.test.js             # handler 级集成（登记→确认→认领→核销→积分→打赏→兑换）
└── docs/superpowers/           # 已有 spec 与本计划
```

**约定（所有任务遵守）：** lib 与 api 模块一律 ESM 具名导出；handler 签名 `async (db, env, req) => Response`，`db` 只用 D1 形状（`prepare().bind().first()/all()/run()`、`batch()`、`meta.changes`）；错误响应统一 `JSON {ok:false, error:"CODE"}`（不泄内部细节）；成功 `JSON {ok:true, ...}`；时间一律 UTC ISO 字符串；中文提交信息。

---

### 任务 1：仓库脚手架 + 数据库 schema

**文件：** 创建 `package.json`、`wrangler.jsonc`、`schema.sql`、`seed.sql`、`tests/schema.test.js`、`tests/fake-db.js`；修改 `.gitignore`（追加 `node_modules/`、`.wrangler/`）

- [ ] **步骤 1.1：写 package.json 与 wrangler.jsonc**

```json
{
  "name": "lostfound",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test tests/" }
}
```

```jsonc
// wrangler.jsonc
{
  "name": "lostfound",
  "main": "src/worker.js",
  "compatibility_date": "2026-09-01",
  "d1_databases": [{ "binding": "DB", "database_name": "lostfound", "database_id": "TO_BE_CREATED_ON_FIRST_DEPLOY" }],
  "assets": { "directory": "public", "binding": "ASSETS" },
  "triggers": { "crons": ["*/5 * * * *"] },   // 冷冻期结算（T11 实现）
  "vars": { "SLOT_COUNT": "12", "FREEZE_MINUTES": "60", "DROP_TTL_MINUTES": "15", "PICKUP_TTL_HOURS": "48" }
}
```

- [ ] **步骤 1.2：写 schema.sql（全量，一字不改）**

```sql
CREATE TABLE IF NOT EXISTS identities (
  student_id TEXT PRIMARY KEY,            -- 7 位数字
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  pin_hash TEXT,                          -- 可选：SHA-256(salt+pin)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,              -- LF-2026-0001
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,                 -- electronics|card|clothing|book|other
  location TEXT NOT NULL,
  photo_path TEXT,
  detail_photo_path TEXT,                 -- 非公开细节照（不公开）
  verify_q TEXT,                          -- 非公开核验问题
  verify_a TEXT,                          -- 非公开核验答案
  value_tier TEXT NOT NULL DEFAULT 'normal',
  slot_no INTEGER,                        -- confirm-drop 时才写入
  drop_code TEXT,                         -- 6 位投递凭证码
  drop_expires_at TEXT,                   -- 凭证过期时刻
  status TEXT NOT NULL DEFAULT 'registered', -- registered|voided|in_stock|claim_pending|ready|returned|expired
  registered_by TEXT NOT NULL REFERENCES identities(student_id),
  registered_via TEXT NOT NULL,           -- phone|kiosk
  found_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_drop ON items(drop_code) WHERE drop_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  claimant_id TEXT NOT NULL REFERENCES identities(student_id),
  verify_answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|in_review|approved|rejected|fulfilled
  pickup_code TEXT UNIQUE,
  pickup_expires_at TEXT,
  review_reason TEXT,
  evidence_photo_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_item ON claims(item_id, status);
CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES identities(student_id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,                   -- claim_reward|tip_in|tip_out|redeem|adjust
  ref_type TEXT,                          -- claim|redemption|admin
  ref_id INTEGER,
  month_key TEXT NOT NULL,                -- '2026-10'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_month ON points_ledger(student_id, month_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tip_once ON points_ledger(ref_type, ref_id, student_id) WHERE reason='tip_in';
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, name_en TEXT NOT NULL,
  cost INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES identities(student_id),
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  points_cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|fulfilled|cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);
CREATE TABLE IF NOT EXISTS risk_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,             -- item|claim|pair
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL, target TEXT, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **步骤 1.3：写 seed.sql**（3 个 identities：9031622 王小明 7(3)、9031623 李思远 7(3)、9031624 陈乐瑶 8(1)；3 个 rewards；2 个 in_stock 物品，格号 3/5 已占；1 个 registered 带凭证码 135790、过期时间为未来 15 分钟）

- [ ] **步骤 1.4：写 tests/fake-db.js（内存 D1 适配器）**

核心形状（后续所有 handler 测试都靠它）：

```js
// 最小 D1 仿制：prepare().bind().first()/all()/run()、batch()、meta.changes
import { DatabaseSync } from 'node:sqlite';
export function fakeDb(schemaSql) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(schemaSql);
  const stmt = (q, params = []) => ({
    first: async () => sql.prepare(q).get(...params) ?? null,
    all: async () => sql.prepare(q).all(...params),
    run: async () => { const r = sql.prepare(q).run(...params);
      return { results: [], meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } }; },
  });
  return {
    prepare: (q) => ({ bind: (...params) => stmt(q, params) }),
    batch: async (ops) => {   // 顺序执行（简化：内存库无需真事务）
      const out = [];
      for (const op of ops) out.push(await op.run());
      return out;
    },
    _sql: sql,
  };
}
```

- [ ] **步骤 1.5：写 tests/schema.test.js 并运行**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
test('schema 建表齐全', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['identities','items','claims','points_ledger','rewards','redemptions','risk_flags','admin_audit'])
    assert.ok(tables.includes(t), `缺表 ${t}`);
});
```

运行：`node --test tests/schema.test.js` → 预期 PASS（若 `node:sqlite` 报 experimental 警告属正常；若不可用，改用 `apk add sqlite` 后用 `sqlite3 :memory: < schema.sql` 校验语法）。

- [ ] **步骤 1.6：Commit**

```bash
git add -A && git commit -m "搭建: 仓库脚手架 + D1 全量 schema + 内存假 db"
```

---

### 任务 2：lib/codes.js —— 凭证码 / 领取码

**文件：** 创建 `src/lib/codes.js`、`tests/codes.test.js`

- [ ] **步骤 2.1：写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { genCode, dropExpiry, pickupExpiry, isExpired } from '../src/lib/codes.js';
test('凭证码为 6 位数字字符串', () => {
  const c = genCode();
  assert.match(c, /^\d{6}$/);
});
test('dropExpiry = now + 15 分钟（可覆盖）', () => {
  const now = new Date('2026-10-07T09:00:00Z');
  assert.equal(dropExpiry(now), '2026-10-07T09:15:00.000Z');
  assert.equal(dropExpiry(now, 30), '2026-10-07T09:30:00.000Z');
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
```

- [ ] **步骤 2.2：运行确认失败** — `node --test tests/codes.test.js` → FAIL（模块不存在）

- [ ] **步骤 2.3：实现**

```js
// src/lib/codes.js —— 凭证/领取码全部走这里，禁止散落实现
export function genCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, n => n % 10).join('');
}
export const dropExpiry = (now = new Date(), ttlMin = 15) =>
  new Date(now.getTime() + ttlMin * 60000).toISOString();
export const pickupExpiry = (now = new Date(), ttlHours = 48) =>
  new Date(now.getTime() + ttlHours * 3600000).toISOString();
export function isExpired(iso, nowIso = new Date().toISOString()) {
  if (!iso) return true;
  return new Date(iso).getTime() <= new Date(nowIso).getTime();
}
```

- [ ] **步骤 2.4：运行确认通过** — `node --test tests/codes.test.js` → PASS

- [ ] **步骤 2.5：Commit** — `git add -A && git commit -m "功能: 码生成与过期判断 lib/codes"`

---

### 任务 3：lib/verify.js —— 非公开特征模糊匹配（§6）

**文件：** 创建 `src/lib/verify.js`、`tests/verify.test.js`

- [ ] **步骤 3.1：写失败的测试**

```js
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
```

- [ ] **步骤 3.2：运行确认失败** — FAIL

- [ ] **步骤 3.3：实现**

```js
// src/lib/verify.js —— 归一化 + 字符 bigram 相似度（Dice 系数），无依赖
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')                 // 全角→半角
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ''); // 空白/标点/符号
}
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}
export function similar(a, b) {
  const A = bigrams(normalize(a)), B = bigrams(normalize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
export function passes(a, b, threshold = 0.6) {
  if (!normalize(a) || !normalize(b)) return false;
  return similar(a, b) >= threshold;
}
```

- [ ] **步骤 3.4：运行确认通过** — PASS

- [ ] **步骤 3.5：Commit** — `git commit -am "功能: 非公开特征归一化模糊匹配 lib/verify"`

---

### 任务 4：lib/points.js —— 结算 / 月上限 / 打赏三限 / 兑换（§5）

**文件：** 创建 `src/lib/points.js`、`tests/points.test.js`

- [ ] **步骤 4.1：写失败的测试**

```js
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
```

- [ ] **步骤 4.2：运行确认失败** — FAIL

- [ ] **步骤 4.3：实现**

```js
// src/lib/points.js —— 纯函数；数据库写入由 api 层用乐观锁完成
export const monthKey = (iso) => String(iso).slice(0, 7);          // '2026-10'
export function grantWithCap({ monthTotal, want, cap = 100 }) {
  const room = Math.max(0, cap - monthTotal);
  const delta = Math.min(want, room);
  return { delta, capped: delta < want };
}
export function tipCheck({ claim, tipper, tipped }) {
  if (!claim || claim.status !== 'fulfilled') return { ok: false, error: 'CLAIM_NOT_FULFILLED' };
  if (claim.claimant_id !== tipper) return { ok: false, error: 'NOT_CLAIMANT' };  // 打赏者必须是认领人
  if (tipped) return { ok: false, error: 'ALREADY_TIPPED' };
  return { ok: true };
}
export function redeemCheck({ balance, cost, stock }) {
  if (balance < cost) return { ok: false, error: 'INSUFFICIENT_POINTS' };
  if (stock <= 0) return { ok: false, error: 'OUT_OF_STOCK' };
  return { ok: true };
}
```

- [ ] **步骤 4.4：运行确认通过** — PASS
- [ ] **步骤 4.5：Commit** — `git commit -am "功能: 积分结算/月上限/打赏三限/兑换校验 lib/points"`

---

### 任务 5：lib/image.js —— Magic Byte + 体积校验（§10）

**文件：** 创建 `src/lib/image.js`、`tests/image.test.js`

- [ ] **步骤 5.1：写失败的测试**

```js
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
```

- [ ] **步骤 5.2：运行确认失败** — FAIL

- [ ] **步骤 5.3：实现**

```js
// src/lib/image.js —— 服务端兜底校验；Exif 由前端 Canvas 重绘根除（public/js/canvas-image.js，T13）
export function sniffImage(u8) {
  if (u8?.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  if (u8?.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'png';
  return null;
}
export function checkImage(u8, maxBytes = 1024 * 1024) {
  const kind = sniffImage(u8);
  if (!kind) return { ok: false, error: 'NOT_IMAGE' };
  if (u8.byteLength > maxBytes) return { ok: false, error: 'TOO_LARGE' };
  return { ok: true, kind };
}
```

- [ ] **步骤 5.4：运行确认通过** — PASS
- [ ] **步骤 5.5：Commit** — `git commit -am "安全: 上传 Magic Byte 与体积校验 lib/image"`

---

### 任务 6：lib/risk.js —— 黄标规则（§5.3-5）

**文件：** 创建 `src/lib/risk.js`、`tests/risk.test.js`

- [ ] **步骤 6.1：写失败的测试**

```js
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
```

- [ ] **步骤 6.2：运行确认失败** — FAIL

- [ ] **步骤 6.3：实现**

```js
// src/lib/risk.js —— 阈值与 spec §5.3-5 一致，全部可由 env vars 覆盖
export function evaluate(f, th = {}) {
  const t = { snatchMin: 10, claimantMonth: 3, pairMonth: 2, ...th };
  const out = [];
  if (f.latencyMin < t.snatchMin) out.push('SNATCH_10MIN');
  if (f.claimantMonthCount >= t.claimantMonth) out.push('CLAIMANT_FREQUENT');
  if (f.pairMonthCount >= t.pairMonth) out.push('PAIR_FREQUENT');
  if (f.claimantPerItem >= 2) out.push('MULTI_CLAIM');
  if (f.freezeCompeting) out.push('FREEZE_COMPETING');
  if (f.dupeDesc) out.push('DUPLICATE_DESC');
  return out;
}
```

- [ ] **步骤 6.4：运行确认通过** — PASS（跑全量：`node --test tests/`）
- [ ] **步骤 6.5：Commit** — `git commit -am "安全: 黄标规则 lib/risk"`

---

### 任务 7：api/items.js + api/report.js —— 公示白名单 & 登记（§4.1 步骤1-2）

**文件：** 创建 `src/api/items.js`、`src/api/report.js`、`tests/api.test.js`

**关键约束（规格 §5.1/§6）：** 公开字段白名单 `[id, code, title, description, category, location, photo_path, slot_no, value_tier, status, found_at, finder_name, finder_class]` —— **学号、verify_q/a、detail_photo 永不出现在公开响应**；`value_tier` 由 category 派生：`electronics|card → high`，其余 `normal`。

- [ ] **步骤 7.1：写失败的测试（列表白名单 + 登记返回凭证码）**

```js
// tests/api.test.js 起始部分
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { listItems, getItem } from '../src/api/items.js';
import { report } from '../src/api/report.js';
const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { SLOT_COUNT: '12', FREEZE_MINUTES: '60', DROP_TTL_MINUTES: '15', PICKUP_TTL_HOURS: '48' };
async function seed(db) {  // 公共种子：一个身份
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','王小明','7(3)')").run();
}
test('listItems 只返回白名单字段（无学号/核验特征）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare(`INSERT INTO items(code,title,description,category,location,value_tier,status,registered_by,registered_via,found_at,slot_no,verify_q,verify_a)
    VALUES ('LF-2026-0001','黑色保温杯','有星黛露贴纸','clothing','图书馆 2F','normal','in_stock','9031622','phone','2026-10-07T01:20:00Z',3,'内侧有什么字','ABC')`).run();
  const res = await listItems(db, env, new Request('https://x/api/items'));
  const body = await res.json();
  assert.equal(body.ok, true);
  const item = body.items[0];
  assert.equal(item.finder_name, '王小明');
  assert.ok(!('verify_a' in item) && !('verify_q' in item));
  assert.equal(JSON.stringify(body.items).includes('9031622'), false);
});
test('report：合法登记 → 6 位凭证码 + 15 分钟过期，无格号', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const form = new FormData();
  form.set('title', '蓝色雨伞');
  form.set('description', '长柄，白色胶带缠手柄');
  form.set('category', 'other');
  form.set('location', '教学楼一楼');
  form.set('student_id', '9031622'); form.set('name', '王小明'); form.set('class', '7(3)');
  form.set('verify_q', '手柄上有什么？'); form.set('verify_a', '白色胶带');
  const res = await report(db, env, new Request('https://x/api/report', { method: 'POST', body: form }));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.drop_code, /^\d{6}$/);
  assert.equal(body.slot_no, undefined);          // 关键：不预分配格号
  const row = await db.prepare('SELECT status, drop_expires_at, verify_a FROM items WHERE code=?').bind(body.code).first();
  assert.equal(row.status, 'registered');
  assert.ok(row.drop_expires_at > '2026-10-07T09:00:00Z');
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
```

- [ ] **步骤 7.2：运行确认失败** — FAIL

- [ ] **步骤 7.3：实现 api/items.js**

```js
// src/api/items.js —— 公开字段白名单，唯一出口
const PUBLIC = 'id, code, title, description, category, location, photo_path, slot_no, value_tier, status, found_at';
export async function listItems(db, env, req) {
  const url = new URL(req.url);
  const cat = url.searchParams.get('category');
  const cols = PUBLIC.split(', ').map(c => `i.${c}`).join(', ');
  const q = `SELECT ${cols}, id2.name AS finder_name, id2.class AS finder_class
     FROM items i JOIN identities id2 ON id2.student_id = i.registered_by
     WHERE i.status IN ('in_stock','ready') ${cat ? 'AND i.category = ?' : ''}
     ORDER BY i.created_at DESC LIMIT 100`;
  const rows = cat ? await db.prepare(q).bind(cat).all() : await db.prepare(q).all();
  return Response.json({ ok: true, items: rows.results });
}
export async function getItem(db, env, req, id) {
  const cols = PUBLIC.split(', ').map(c => `i.${c}`).join(', ');
  const row = await db.prepare(
    `SELECT ${cols}, id2.name AS finder_name, id2.class AS finder_class
     FROM items i JOIN identities id2 ON id2.student_id = i.registered_by
     WHERE i.id = ? AND i.status IN ('in_stock','ready')`
  ).bind(id).first();
  if (!row) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  return Response.json({ ok: true, item: row });
}
```

- [ ] **步骤 7.4：实现 api/report.js**

```js
// src/api/report.js —— 登记：生成凭证码，绝不分配格号（§4.1-2）
import { genCode, dropExpiry } from '../lib/codes.js';
import { checkImage } from '../lib/image.js';
const HIGH = new Set(['electronics', 'card']);
export const tierOf = (category) => (HIGH.has(category) ? 'high' : 'normal');
export async function report(db, env, req) {
  const form = await req.formData();
  const get = (k) => String(form.get(k) ?? '').trim();
  const title = get('title'), desc = get('description'), category = get('category'),
        location = get('location'), sid = get('student_id'), name = get('name'),
        cls = get('class'), vq = get('verify_q'), va = get('verify_a');
  if (!/^\d{7}$/.test(sid)) return Response.json({ ok: false, error: 'BAD_STUDENT_ID' }, { status: 400 });
  if (!title || !category || !location || !vq || !va)
    return Response.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
  // 身份 upsert（轻量身份，不注册）
  await db.prepare('INSERT INTO identities(student_id,name,class) VALUES (?,?,?) ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, class=excluded.class')
    .bind(sid, name, cls).run();
  // 照片（可选）：Canvas 前端已去 Exif；后端 Magic Byte + ≤1MB 兜底
  let photoPath = null;
  const file = form.get('photo');
  if (file && typeof file === 'object') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chk = checkImage(bytes);
    if (!chk.ok) return Response.json({ ok: false, error: chk.error }, { status: 400 });
    photoPath = `photos/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${chk.kind === 'png' ? 'png' : 'jpg'}`;
    await env.PHOTOS?.put(photoPath, bytes);   // R2 可选绑定；无 R2 时仅存路径占位
  }
  const now = new Date();
  const code = `LF-${now.getUTCFullYear()}-${String(now.getTime()).slice(-4)}${String(Math.floor(Math.random() * 10))}`;
  const drop = genCode();
  await db.prepare(`INSERT INTO items(code,title,description,category,location,photo_path,verify_q,verify_a,value_tier,drop_code,drop_expires_at,status,registered_by,registered_via,found_at)
    VALUES (?,?,?,?,?,?,?,?,?,'registered',?,?,?,?)`)
    .bind(code, title, desc, category, location, photoPath, vq, va, tierOf(category),
          drop, dropExpiry(now, Number(env.DROP_TTL_MINUTES || 15)), sid,
          get('via') === 'kiosk' ? 'kiosk' : 'phone',   // kiosk 直办（T14）复用本端点
          now.toISOString()).run();
  return Response.json({ ok: true, code, drop_code: drop, drop_expires_at: dropExpiry(now, Number(env.DROP_TTL_MINUTES || 15)) });
}
```

- [ ] **步骤 7.5：运行确认通过** — `node --test tests/api.test.js` → PASS（若 items 查询 SQL 报错，修 `bind` 分支写法）
- [ ] **步骤 7.6：Commit** — `git commit -am "功能: 公示白名单 API + 登记发凭证码"`

---

### 任务 8：api/kiosk.js —— 确认入库(动态分格) / 校验领取码 / 出库（§4.1-3/7、§10 乐观锁）

**文件：** 创建 `src/api/kiosk.js`；修改 `tests/api.test.js`（追加）

- [ ] **步骤 8.1：追加失败的测试**

```js
import { confirmDrop, verifyPickup, fulfill } from '../src/api/kiosk.js';
test('confirmDrop：动态分配最小空闲格；15 分钟过期 → 410', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  const reg = await report(db, env, await mkReport());          // mkReport() 返回上面那种 FormData 请求
  const res = await confirmDrop(db, env, jr({ drop_code: reg.drop_code }));
  const body = await res.json();
  assert.equal(body.ok, true); assert.equal(body.slot_no, 1);   // 空柜分到 1 号格
  const item = await db.prepare("SELECT status, slot_no FROM items WHERE code=?").bind(reg.code).first();
  assert.equal(item.status, 'in_stock'); assert.equal(item.slot_no, 1);
  // 过期凭证
  const reg2 = await report(db, env, await mkReport());
  await db.prepare("UPDATE items SET drop_expires_at='2020-01-01T00:00:00Z' WHERE code=?").bind(reg2.code).run();
  const res2 = await confirmDrop(db, env, jr({ drop_code: reg2.drop_code }));
  assert.equal(res2.status, 410);
});
test('confirmDrop：已占格被跳过；格满 → 507', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  for (let n = 1; n <= 12; n++)
    await db.prepare("INSERT INTO items(code,title,category,location,value_tier,status,registered_by,registered_via,found_at,slot_no) VALUES (?,?,?,?,?,?,?,'kiosk','2026-10-01T00:00:00Z',?)")
      .bind(`LF-X-${n}`, `物${n}`, 'other', 'x', 'normal', 'in_stock', '9031622', n).run();
  const reg = await report(db, env, await mkReport());
  const res = await confirmDrop(db, env, jr({ drop_code: reg.drop_code }));
  assert.equal(res.status, 507);
});
test('fulfill 乐观锁：重复核销第二次 → 409；出库后积分入账（受月上限）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031623','李思远','7(3)')").run();
  const reg = await report(db, env, await mkReport());
  await confirmDrop(db, env, jr({ drop_code: reg.drop_code }));
  // 直接造一条已批准的 claim（claims API 属 T9，此处不依赖）
  const itemId = (await db.prepare("SELECT id FROM items WHERE status='in_stock'").first()).id;
  await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?, '9031623', '白色胶带', 'approved', '472916', '2026-12-01T00:00:00Z')`).bind(itemId).run();
  const f1 = await fulfill(db, env, jr({ pickup_code: '472916' }));
  assert.equal(f1.status, 200);
  const f2 = await fulfill(db, env, jr({ pickup_code: '472916' }));
  assert.equal(f2.status, 409);                          // 乐观锁拦截重复核销
  const led = await db.prepare("SELECT delta FROM points_ledger WHERE reason='claim_reward'").all();
  assert.equal(led.results.length, 1);
});
```

（助手区（测试文件顶部）定义两个工具：`jr = (o) => new Request('https://x/', { method: 'POST', body: JSON.stringify(o), headers: { 'content-type': 'application/json' } })`；`mkReport = () => { const f = new FormData(); f.set('title','蓝色雨伞'); f.set('description','长柄，白色胶带缠手柄'); f.set('category','other'); f.set('location','教学楼一楼'); f.set('student_id','9031622'); f.set('name','王小明'); f.set('class','7(3)'); f.set('verify_q','手柄上有什么？'); f.set('verify_a','白色胶带'); return new Request('https://x/api/report', { method: 'POST', body: f }); }`）

- [ ] **步骤 8.2：运行确认失败** — FAIL

- [ ] **步骤 8.3：实现**

```js
// src/api/kiosk.js —— 所有状态跃迁：UPDATE…WHERE 旧状态 + changes==1（§10 乐观锁）
import { isExpired } from '../lib/codes.js';
import { grantWithCap, monthKey } from '../lib/points.js';
const json = (o, s = 200) => Response.json(o, { status: s });
const SLOT_COUNT = (env) => Number(env.SLOT_COUNT || 12);
async function occupiedSlots(db) {
  const r = await db.prepare("SELECT slot_no FROM items WHERE slot_no IS NOT NULL AND status IN ('in_stock','claim_pending','ready')").all();
  return new Set(r.results.map(x => x.slot_no));
}
export async function confirmDrop(db, env, req) {
  const { drop_code } = await req.json();
  const item = await db.prepare("SELECT id, drop_expires_at FROM items WHERE drop_code=? AND status='registered'").bind(drop_code).first();
  if (!item) return json({ ok: false, error: 'VOUCHER_NOT_FOUND' }, 404);
  if (isExpired(item.drop_expires_at)) return json({ ok: false, error: 'VOUCHER_EXPIRED' }, 410);
  const used = await occupiedSlots(db);
  for (let n = 1; n <= SLOT_COUNT(env); n++) {
    if (used.has(n)) continue;
    const r = await db.prepare(
      `UPDATE items SET slot_no=?, status='in_stock', drop_code=NULL, drop_expires_at=NULL, updated_at=datetime('now')
       WHERE id=? AND status='registered' AND slot_no IS NULL`).bind(n, item.id).run();
    if (r.meta.changes === 1) return json({ ok: true, slot_no: n });   // 乐观锁成功即占格
  }
  return json({ ok: false, error: 'SLOTS_FULL' }, 507);
}
export async function verifyPickup(db, env, req) {
  const { pickup_code } = await req.json();
  const row = await db.prepare(
    `SELECT c.id, c.pickup_expires_at, c.status, i.title, i.slot_no, i.location, i.found_at
     FROM claims c JOIN items i ON i.id = c.item_id
     WHERE c.pickup_code=? AND c.status IN ('approved','auto_approved')`).bind(pickup_code).first();
  if (!row) return json({ ok: false, error: 'CODE_INVALID' }, 404);
  if (isExpired(row.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
  return json({ ok: true, claim: row });
}
export async function fulfill(db, env, req) {
  const { pickup_code } = await req.json();
  const claim = await db.prepare(
    `SELECT c.*, i.id AS item_id, i.value_tier, i.registered_by, i.created_at AS in_stock_at
     FROM claims c JOIN items i ON i.id=c.item_id
     WHERE c.pickup_code=? AND c.status IN ('approved','auto_approved')`).bind(pickup_code).first();
  if (!claim) return json({ ok: false, error: 'CODE_INVALID' }, 404);
  if (isExpired(claim.pickup_expires_at)) return json({ ok: false, error: 'CODE_EXPIRED' }, 410);
  const now = new Date();
  // 出库：两条 UPDATE 放同一 batch（同事务语义），各自乐观锁
  const rs = await db.batch([
    db.prepare("UPDATE items SET status='returned', updated_at=datetime('now') WHERE id=? AND status IN ('in_stock','ready')")
      .bind(claim.item_id),
    db.prepare("UPDATE claims SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=? AND status IN ('approved','auto_approved')")
      .bind(claim.id),
  ]);
  if (rs.some(r => r.meta.changes !== 1)) return json({ ok: false, error: 'CONFLICT' }, 409);
  // 积分结算：月上限内发放（§5.2）
  const mk = monthKey(now.toISOString());
  const agg = await db.prepare("SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger WHERE student_id=? AND month_key=?")
    .bind(claim.registered_by, mk).first();
  const { delta, capped } = grantWithCap({ monthTotal: agg.t, want: claim.value_tier === 'high' ? 25 : 10, cap: 100 });
  if (delta > 0)
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'claim_reward','claim',?,?)")
      .bind(claim.registered_by, delta, claim.id, mk).run();
  return json({ ok: true, points_granted: delta, capped });
}
```

- [ ] **步骤 8.4：运行确认通过** — PASS
- [ ] **步骤 8.5：Commit** — `git commit -am "功能: kiosk 确认入库动态分格 + 乐观锁出库与积分结算"`

---

### 任务 9：api/claims.js —— 认领申请（核验匹配 + 冷冻期 + 黄标）（§4.1-5/6、§5.3）

**文件：** 创建 `src/api/claims.js`；修改 `tests/api.test.js`（追加）

- [ ] **步骤 9.1：追加失败的测试**

```js
import { claims, settleFreeze } from '../src/api/claims.js';
async function mkInStock(db, { vq = '手柄上有什么？', va = '白色胶带', tier = 'normal', createdAt = '2026-10-07T07:00:00Z' } = {}) {
  await db.prepare(`INSERT INTO identities(student_id,name,class) VALUES ('9031624','陈乐瑶','8(1)')`).run();
  await db.prepare(`INSERT INTO items(code,title,description,category,location,value_tier,verify_q,verify_a,status,registered_by,registered_via,found_at,slot_no,created_at)
    VALUES ('LF-T-0001','蓝色雨伞','长柄','other','教学楼',?,?,'in_stock','9031624','phone','2026-10-07T06:00:00Z',2,?)`)
    .bind(tier, vq, va, createdAt).run();
  return (await db.prepare("SELECT id FROM items WHERE code='LF-T-0001'").first()).id;
}
test('答对 + 无竞争 + 已出冷冻期 → auto_approved 发领取码', async () => {
  const db = fakeDb(SCHEMA);
  const itemId = await mkInStock(db);   // created_at 已拨回 2 小时前 = 出冷冻期
  const res = await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }));
  const body = await res.json();
  assert.equal(body.status, 'auto_approved');
  assert.match(body.pickup_code, /^\d{6}$/);
});
test('答错 → in_review（不拒绝）', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db);
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '红色图案' }))).json();
  assert.equal(body.status, 'in_review');
});
test('冷冻期内首个申请 → pending；settleFreeze 结算后自动通过', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: '2026-10-07T09:30:00Z' });   // 30 分钟前，仍在 1h 冷冻期
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }))).json();
  assert.equal(body.status, 'pending');
  const settled = await (await settleFreeze(db, env)).json();
  assert.equal(settled.approved.length, 1);                     // cron 到点结算
  const row = await db.prepare("SELECT status, pickup_code FROM claims WHERE item_id=1").first();
  assert.equal(row.status, 'approved');
});
test('冷冻期内 2 人申请 → 全部 in_review', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: '2026-10-07T09:30:00Z' });
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','王小明','7(3)')").run();
  await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }));
  const body = await (await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031622', name: '王小明', class: '7(3)', verify_answer: '白色胶带' }))).json();
  assert.equal(body.status, 'in_review');
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM claims WHERE status='in_review'").first()).c, 2);
});
test('秒领黄标：入库 10 分钟内被认领 → risk_flags 记录 SNATCH_10MIN', async () => {
  const db = fakeDb(SCHEMA);
  await mkInStock(db, { createdAt: new Date(Date.now() - 5 * 60000).toISOString() });
  await claims(db, env, jr({ code: 'LF-T-0001', student_id: '9031623', name: '李思远', class: '7(3)', verify_answer: '白色胶带' }));
  const flag = await db.prepare("SELECT reason FROM risk_flags WHERE subject_type='item'").first();
  assert.equal(flag.reason, 'SNATCH_10MIN');
});
```

- [ ] **步骤 9.2：运行确认失败** — FAIL

- [ ] **步骤 9.3：实现**

```js
// src/api/claims.js —— 认领决策全部在此；settleFreeze 由 Worker Cron 每 5 分钟调用
import { passes } from '../lib/verify.js';
import { genCode, pickupExpiry } from '../lib/codes.js';
import { evaluate } from '../lib/risk.js';
const json = (o, s = 200) => Response.json(o, { status: s });
async function upsertIdentity(db, { student_id, name, class: cls }) {
  if (!/^\d{7}$/.test(student_id)) throw new Error('BAD_STUDENT_ID');
  await db.prepare('INSERT INTO identities(student_id,name,class) VALUES (?,?,?) ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, class=excluded.class')
    .bind(student_id, name, cls).run();
}
export async function claims(db, env, req) {
  const b = await req.json();
  const item = await db.prepare("SELECT * FROM items WHERE code=? AND status='in_stock'").bind(b.code).first();
  if (!item) return json({ ok: false, error: 'ITEM_NOT_CLAIMABLE' }, 404);
  await upsertIdentity(db, b);
  const freezeMin = Number(env.FREEZE_MINUTES || 60);
  const freezeOver = (Date.now() - new Date(item.created_at).getTime()) >= freezeMin * 60000;
  const verified = passes(b.verify_answer, item.verify_a);   // 归一化模糊匹配
  // 黄标：秒领 / 冷冻期竞争
  const latencyMin = (Date.now() - new Date(item.created_at).getTime()) / 60000;
  const pendingOnItem = (await db.prepare("SELECT COUNT(*) c FROM claims WHERE item_id=? AND status IN ('pending','in_review')").bind(item.id).first()).c;
  for (const reason of evaluate({ latencyMin, freezeCompeting: pendingOnItem >= 1 }))
    await db.prepare("INSERT INTO risk_flags(subject_type,subject_id,reason) VALUES ('item',?,?)").bind(String(item.id), reason).run();
  let status;
  if (!verified || !item.verify_a) status = 'in_review';               // 答错/无特征 → 人工
  else if (item.value_tier === 'high') status = 'in_review';           // 高价值 → 人工
  else if (!freezeOver) status = 'pending';                            // 冷冻期 → 到点结算
  else status = 'auto_approved';                                       // 全绿 → 自动通过
  const pickup = status === 'auto_approved' ? genCode() : null;
  const r = await db.prepare(`INSERT INTO claims(item_id,claimant_id,verify_answer,status,pickup_code,pickup_expires_at)
    VALUES (?,?,?,?,?,?)`)
    .bind(item.id, b.student_id, b.verify_answer ?? '', status, pickup,
          pickup ? pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)) : null).run();
  if (status === 'pending') {  // 锁定物品为认领中（乐观锁）
    await db.prepare("UPDATE items SET status='claim_pending' WHERE id=? AND status='in_stock'").bind(item.id).run();
  }
  const row = await db.prepare("SELECT status, pickup_code, pickup_expires_at FROM claims WHERE id=?").bind(r.meta.last_row_id ?? 1).first();
  return json({ ok: true, ...row });
}
// 冷冻期结算：pending → 若该物品仅此一份申请且核验已过 → approved 发码；≥2 份 → 全部 in_review
export async function settleFreeze(db, env) {
  const due = await db.prepare(`
    SELECT i.id AS item_id, COUNT(*) c FROM claims c JOIN items i ON i.id=c.item_id
    WHERE c.status='pending' AND i.created_at <= datetime('now', ?) GROUP BY i.id`)
    .bind(`-${Number(env.FREEZE_MINUTES || 60)} minutes`).all();
  const approved = [], reviewed = [];
  for (const g of due.results) {
    const list = await db.prepare("SELECT * FROM claims WHERE item_id=? AND status='pending'").bind(g.item_id).all();
    if (g.c >= 2) { reviewed.push(g.item_id);
      await db.prepare("UPDATE claims SET status='in_review', review_reason='FREEZE_COMPETING' WHERE item_id=? AND status='pending'").bind(g.item_id).run();
      continue;
    }
    const c = list.results[0];
    const code = genCode();
    await db.batch([
      db.prepare("UPDATE claims SET status='approved', pickup_code=?, pickup_expires_at=? WHERE id=? AND status='pending'")
        .bind(code, pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)), c.id),
      db.prepare("UPDATE items SET status='ready' WHERE id=? AND status='claim_pending'").bind(g.item_id),
    ]);
    approved.push(c.id);
  }
  return json({ ok: true, approved, reviewed });
}
```

- [ ] **步骤 9.4：运行确认通过** — PASS（fake-db 的 `meta.last_row_id` 需在 fake-db.js 的 wrap 中补：`meta: { changes: r.changes ?? 0, last_row_id: r.lastInsertRowid }`）
- [ ] **步骤 9.5：Commit** — `git commit -am "功能: 认领申请（核验+冷冻期+黄标）与 cron 结算"`

---

### 任务 10：api/points.js —— 查询分级 / 打赏 / 兑换（§5.1-2、§7）

**文件：** 创建 `src/api/points.js`；修改 `tests/api.test.js`（追加）

- [ ] **步骤 10.1：追加失败的测试**

```js
import { pointsQuery, tip, redeem } from '../src/api/points.js';
test('查询分级：仅学号 → total+contributions；带姓名 → 明细', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',10,'claim_reward','2026-10')").run();
  const basic = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622'))).json();
  assert.deepEqual(Object.keys(basic).sort(), ['contributions', 'ok', 'total']);
  const full = await (await pointsQuery(db, env, new Request('https://x/api/points/9031622?name=' + encodeURIComponent('王小明')))).json();
  assert.equal(full.total, 10); assert.equal(full.ledger.length, 1);
  const bad = await pointsQuery(db, env, new Request('https://x/api/points/9031622?name=' + encodeURIComponent('张三')));
  assert.equal(bad.status, 403);                    // 二次校验失败
});
test('打赏三限：成功一次后重复 → 409（唯一索引兜底）', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status,pickup_code) VALUES (9,1,'9031623','fulfilled','111111')").run();
  await db.prepare("INSERT INTO items(id,code,registered_by,status) VALUES (1,'LF-9','9031622','returned')").run();
  const ok1 = await tip(db, env, jr({ claim_id: 9, from: '9031623', to: '9031622', points: 5 }));
  assert.equal(ok1.status, 200);
  const ok2 = await tip(db, env, jr({ claim_id: 9, from: '9031623', to: '9031622', points: 5 }));
  assert.equal(ok2.status, 409);
});
test('兑换：余额不足 402；成功则扣分+订单 pending', async () => {
  const db = fakeDb(SCHEMA); await seed(db);
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock) VALUES (1,'文具套装','Stationery',40,3)").run();
  await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',50,'claim_reward','2026-10')").run();
  const ok = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1 }));
  assert.equal(ok.status, 200);
  const poor = await redeem(db, env, jr({ student_id: '9031622', reward_id: 1 }));  // 余额已扣 40，剩 10 < 40
  assert.equal(poor.status, 402);
});
```

- [ ] **步骤 10.2：运行确认失败** — FAIL

- [ ] **步骤 10.3：实现**

```js
// src/api/points.js —— 查询分级、打赏（唯一索引兜底）、兑换（乐观锁扣分）
import { tipCheck, redeemCheck, monthKey } from '../lib/points.js';
const json = (o, s = 200) => Response.json(o, { status: s });
export async function pointsQuery(db, env, req, sid) {
  const id = sid;
  const ident = await db.prepare('SELECT * FROM identities WHERE student_id=?').bind(id).first();
  if (!ident) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  const total = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=?').bind(id).first()).t;
  const contributions = (await db.prepare("SELECT COUNT(DISTINCT ref_id) c FROM points_ledger WHERE student_id=? AND reason='claim_reward'").bind(id).first()).c;
  const name = new URL(req.url).searchParams.get('name');
  const pin = new URL(req.url).searchParams.get('pin');
  const okFull = (name && name === ident.name) || (pin && ident.pin_hash && pin === ident.pin_hash);
  if (!okFull) return json({ ok: true, total, contributions });       // 公开级：只给总数
  const ledger = await db.prepare('SELECT delta, reason, created_at FROM points_ledger WHERE student_id=? ORDER BY id DESC LIMIT 50').bind(id).all();
  const redemptions = await db.prepare('SELECT r.points_cost, r.status, w.name FROM redemptions r JOIN rewards w ON w.id=r.reward_id WHERE r.student_id=? ORDER BY r.id DESC LIMIT 20').bind(id).all();
  return json({ ok: true, total, contributions, ledger: ledger.results, redemptions: redemptions.results });
}
export async function tip(db, env, req) {
  const { claim_id, from, to, points } = await req.json();
  if (!(Number.isInteger(points) && points >= 1 && points <= 10)) return json({ ok: false, error: 'BAD_AMOUNT' }, 400);
  const claim = await db.prepare('SELECT id, claimant_id, status FROM claims WHERE id=?').bind(claim_id).first();
  const tipped = !!(await db.prepare("SELECT id FROM points_ledger WHERE reason='tip_in' AND ref_type='claim' AND ref_id=? AND student_id=?").bind(claim_id, to).first());
  const chk = tipCheck({ claim, tipper: from, tipped });
  if (!chk.ok) return json({ ok: false, error: chk.error }, 400);
  const mk = monthKey(new Date().toISOString());
  const agg = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=? AND month_key=?').bind(to, mk).first()).t;
  const { delta } = grantWithCap({ monthTotal: agg, want: points, cap: 100 });   // 打赏计入接收者月上限
  const r = await db.batch([
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?, 'tip_in','claim',?,?)").bind(to, delta, claim_id, mk),
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'tip_out','claim',?,?)").bind(from, -delta, claim_id, mk),
  ]);
  return json({ ok: true, granted: delta, capped: rsCapped(r) });
}
const rsCapped = (rs) => false; // 打赏被 cap 截断时 delta<points，前端据 granted 提示
export async function redeem(db, env, req) {
  const { student_id, reward_id } = await req.json();
  const rw = await db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').bind(reward_id).first();
  if (!rw) return json({ ok: false, error: 'REWARD_NOT_FOUND' }, 404);
  const balance = (await db.prepare('SELECT COALESCE(SUM(delta),0) t FROM points_ledger WHERE student_id=?').bind(student_id).first()).t;
  const chk = redeemCheck({ balance, cost: rw.cost, stock: rw.stock });
  if (!chk.ok) return json({ ok: false, error: chk.error }, chk.error === 'INSUFFICIENT_POINTS' ? 402 : 409);
  const rs = await db.batch([
    db.prepare('INSERT INTO redemptions(student_id,reward_id,points_cost) VALUES (?,?,?)').bind(student_id, rw.id, rw.cost),
    db.prepare('UPDATE rewards SET stock=stock-1 WHERE id=? AND stock>0').bind(rw.id),
    db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'redeem','redemption',?,?)")
      .bind(student_id, -rw.cost, rw.id, monthKey(new Date().toISOString())),
  ]);
  const redemptionId = rs[0].meta.last_row_id;
  return json({ ok: true, redemption_id: redemptionId, note: '待发放订单已生成，管理员将定期发放实物' });
}
```

- [ ] **步骤 10.4：运行确认通过** — PASS（`pointsQuery` 的路由参数 `sid` 由 worker 路由传入）
- [ ] **步骤 10.5：Commit** — `git commit -am "功能: 积分查询分级/打赏三限/兑换乐观锁"`

---

### 任务 11：api/admin.js + src/worker.js —— 后台 API、路由装配、Cron

**文件：** 创建 `src/api/admin.js`、`src/worker.js`；修改 `tests/api.test.js`（追加）

- [ ] **步骤 11.1：追加失败的测试**

```js
import { admin } from '../src/api/admin.js';
const adminReq = (path, token = 'T0KEN') => new Request('https://x' + path, { headers: { 'X-Admin-Token': token } });
test('admin：无 token → 401；有 token → 复核队列', async () => {
  const db = fakeDb(SCHEMA);
  assert.equal((await admin(db, env, adminReq('/api/admin/queue'), '')).status, 401);
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status) VALUES (1,1,'9031623','in_review')").run();
  await db.prepare("INSERT INTO items(id,code,title,status) VALUES (1,'LF-1','保温杯','in_stock')").run();
  const res = await admin(db, env, adminReq('/api/admin/queue'), 'T0KEN');
  const body = await res.json();
  assert.equal(body.ok, true); assert.equal(body.queue[0].claim_id, 1);
});
test('admin：复核通过 → 发领取码（写审计）', async () => {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO claims(id,item_id,claimant_id,status) VALUES (1,1,'9031623','in_review')").run();
  const res = await admin(db, env, new Request('https://x/api/admin/review', { method: 'POST', headers: { 'X-Admin-Token': 'T0KEN', 'content-type': 'application/json' }, body: JSON.stringify({ claim_id: 1, decision: 'approve' }) }), 'T0KEN');
  assert.equal((await res.json()).ok, true);
  const c = await db.prepare('SELECT status, pickup_code FROM claims WHERE id=1').first();
  assert.equal(c.status, 'approved'); assert.match(c.pickup_code, /^\d{6}$/);
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM admin_audit").first()).c, 1);
});
```

- [ ] **步骤 11.2：运行确认失败** — FAIL

- [ ] **步骤 11.3：实现 src/api/admin.js**

```js
// src/api/admin.js —— 唯一鉴权点：X-Admin-Token（部署时 wrangler secret put ADMIN_TOKEN）
import { genCode, pickupExpiry } from '../lib/codes.js';
const json = (o, s = 200) => Response.json(o, { status: s });
export async function admin(db, env, req, token) {
  if (!token || token !== env.ADMIN_TOKEN) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  const url = new URL(req.url);
  const audit = (action, target) => db.prepare('INSERT INTO admin_audit(action,target) VALUES (?,?)').bind(action, target).run();
  if (req.method === 'GET' && url.pathname === '/api/admin/queue') {
    const q = await db.prepare(`SELECT c.id AS claim_id, c.status, c.verify_answer, c.created_at,
      i.title, i.code, i.value_tier, id2.name AS claimant_name, id2.class AS claimant_class
      FROM claims c JOIN items i ON i.id=c.item_id JOIN identities id2 ON id2.student_id=c.claimant_id
      WHERE c.status='in_review' ORDER BY c.created_at`).all();
    const flags = await db.prepare("SELECT * FROM risk_flags WHERE resolved=0 ORDER BY id DESC LIMIT 50").all();
    return json({ ok: true, queue: q.results, flags: flags.results });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/review') {
    const { claim_id, decision } = await req.json();   // approve | reject
    if (decision === 'approve') {
      const code = genCode();
      await db.batch([
        db.prepare("UPDATE claims SET status='approved', pickup_code=?, pickup_expires_at=? WHERE id=? AND status='in_review'")
          .bind(code, pickupExpiry(new Date(), Number(env.PICKUP_TTL_HOURS || 48)), claim_id),
        db.prepare("UPDATE items SET status='ready' WHERE id=(SELECT item_id FROM claims WHERE id=?) AND status='in_stock'").bind(claim_id),
      ]);
      await audit('review_approve', `claim:${claim_id}`);
      return json({ ok: true, pickup_code: code });
    }
    await db.prepare("UPDATE claims SET status='rejected', review_reason='ADMIN_REJECTED' WHERE id=? AND status='in_review'").bind(claim_id).run();
    await db.prepare("UPDATE items SET status='in_stock' WHERE id=(SELECT item_id FROM claims WHERE id=?) AND status='claim_pending'").bind(claim_id).run();
    await audit('review_reject', `claim:${claim_id}`);
    return json({ ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/points/adjust') {
    const { student_id, delta, reason } = await req.json();
    await db.prepare("INSERT INTO points_ledger(student_id,delta,reason,ref_type,ref_id,month_key) VALUES (?,?,'adjust','admin',NULL,?)")
      .bind(student_id, delta, monthKey(new Date().toISOString())).run();
    await audit('points_adjust', `${student_id}:${delta}`);
    return json({ ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/redemptions/fulfill') {
    const { id } = await req.json();
    await db.prepare("UPDATE redemptions SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=? AND status='pending'").bind(id).run();
    await audit('redemption_fulfill', `redemption:${id}`);
    return json({ ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
    const week = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM items WHERE status IN ('in_stock','ready','claim_pending')) AS pending,
      (SELECT COUNT(*) FROM items WHERE status='returned') AS returned,
      (SELECT COUNT(*) FROM claims WHERE status='in_review') AS reviews`).first();
    return json({ ok: true, stats: week });
  }
  return json({ ok: false, error: 'NOT_FOUND' }, 404);
}
```

- [ ] **步骤 11.4：实现 src/worker.js（路由装配 + Cron）**

```js
// src/worker.js —— /api 分发；其余回退 ASSETS；Cron 结算冷冻期
import { listItems, getItem } from './api/items.js';
import { report } from './api/report.js';
import { confirmDrop, verifyPickup, fulfill } from './api/kiosk.js';
import { claims, settleFreeze } from './api/claims.js';
import { pointsQuery, tip, redeem } from './api/points.js';
import { admin } from './api/admin.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const db = env.DB;
    try {
      const seg = url.pathname.split('/').filter(Boolean);   // ['api', ...]
      const m = request.method;
      if (m === 'GET'  && url.pathname === '/api/items') return listItems(db, env, request);
      if (m === 'GET'  && seg[1] === 'items' && seg[2]) return getItem(db, env, request, seg[2]);
      if (m === 'POST' && url.pathname === '/api/report') return report(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/confirm-drop') return confirmDrop(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/verify-pickup') return verifyPickup(db, env, request);
      if (m === 'POST' && url.pathname === '/api/kiosk/fulfill') return fulfill(db, env, request);
      if (m === 'POST' && url.pathname === '/api/claims') return claims(db, env, request);
      if (m === 'GET'  && seg[1] === 'points' && seg[2]) return pointsQuery(db, env, request, seg[2]);
      if (m === 'POST' && url.pathname === '/api/tips') return tip(db, env, request);
      if (m === 'POST' && url.pathname === '/api/redemptions') return redeem(db, env, request);
      if (seg[1] === 'admin') return admin(db, env, request, request.headers.get('X-Admin-Token'));
      return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: 'SERVER_ERROR' }, { status: 500 }); // 不回显 e（§10 安全）
    }
  },
  async scheduled(event, env) {
    await settleFreeze(env.DB, env);   // 每 5 分钟结算冷冻期
  },
};
```

- [ ] **步骤 11.5：运行全量测试** — `node --test tests/` → 全 PASS
- [ ] **步骤 11.6：Commit** — `git commit -am "功能: 后台 API + worker 路由装配 + cron 冷冻期结算"`

---

### 任务 12：设计系统 CSS —— tokens.css + app.css（§8）

**文件：** 创建 `public/css/tokens.css`、`public/css/app.css`

- [ ] **步骤 12.1：写 tokens.css（全量照抄，OKLCH 由 hex 换算后精调）**

```css
/* Hallmark · route: custom (school-anchored) · genre: modern-minimal
 * tokens: 单一来源；所有组件只允许 var(--*)，禁止内联色值
 * 偏离声明：主蓝按学校门户惯例用作导航/主按钮实底（非 3% 点缀）——用户已批准 */
:root {
  --color-accent:   #00509F;  --color-accent-hover: #004C98;
  --color-navy:     #00458A;  --color-bar: #005EBB;
  --color-ink:      #202931;  --color-muted: #5E6B76;
  --color-rule:     #D9E2EE;  --color-paper: #F2F6FB;  --color-surface: #FBFDFF;
  --color-cyan:     #CAF0FE;  --color-cyan-soft: #E8F1FB;
  --color-ok:       #1B7F3B;  --color-ok-soft: #E7F5EB;
  --color-warn:     #9A6B00;  --color-warn-soft: #FBF3DC;
  --color-danger:   #B3362B;  --color-danger-soft: #FBEAE8;
  --font-ui:   "Lato", -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px;
  --radius-card: 10px; --radius-btn: 8px; --radius-pill: 999px;
  --shadow-card: 0 6px 18px rgba(0, 40, 90, .08);
  --focus-ring: 0 0 0 3px rgba(0, 80, 159, .35);
}
@media (prefers-color-scheme: dark) { /* 手机端夜间微调：仅降低对比面，色相不变（§10 深色配方） */
  :root { --color-paper: #141B26; --color-surface: #1B2432; --color-rule: #2C3A4C;
          --color-ink: #EDF2F8; --color-muted: #9AA8B6; --color-cyan-soft: #16324A; }
}
```

- [ ] **步骤 12.2：写 app.css（核心组件，节选为骨架——卡片/chip/票据/按钮/断点全在此）**

```css
* { box-sizing: border-box; margin: 0; }
html, body { overflow-x: clip; }                 /* 防横向滚动（断点纪律） */
body { font-family: var(--font-ui); background: var(--color-paper); color: var(--color-ink);
       font-size: 15px; line-height: 1.5; padding-bottom: 76px; }  /* 底部 Tab 高度预留 */
.card { background: var(--color-surface); border: 1px solid var(--color-rule);
        border-radius: var(--radius-card); padding: var(--space-3); box-shadow: var(--shadow-card); }
.btn { font: 700 14px/1 var(--font-ui); border-radius: var(--radius-btn);
       padding: 12px 16px; border: none; cursor: pointer; text-align: center; }
.btn:is(:focus-visible) { outline: none; box-shadow: var(--focus-ring); }
.btn-primary { background: var(--color-accent); color: var(--color-surface); }
.btn-primary:hover { background: var(--color-accent-hover); }
.btn-ghost { background: transparent; color: var(--color-accent); border: 2px solid var(--color-accent); }
.chip { font: 500 12px/1 var(--font-ui); border-radius: var(--radius-pill);
        padding: 6px 12px; border: 1px solid var(--color-rule); background: var(--color-surface); }
.chip[aria-pressed="true"] { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-surface); }
.slot-tag { font: 700 12px var(--font-mono); color: var(--color-navy);
            background: var(--color-cyan-soft); border: 1px solid var(--color-rule);
            border-radius: 4px; padding: 2px 8px; }               /* 签名元素：格位牌 */
.status { font: 600 12px var(--font-ui); border-radius: var(--radius-pill); padding: 2px 8px; }
.status-ok { color: var(--color-ok); background: var(--color-ok-soft); }
.status-warn { color: var(--color-warn); background: var(--color-warn-soft); }
/* 认领券/投递凭证：撕边打孔票据（签名元素） */
.ticket { background: var(--color-surface); border: 1px solid var(--color-rule);
          border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-card); }
.ticket-head { background: var(--color-navy); color: var(--color-surface);
               padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; }
.ticket-body { padding: 14px 16px 6px; position: relative; }
.ticket-perf { position: relative; margin: 12px -16px 0; border-top: 2px dashed var(--color-rule); }
.ticket-perf::before, .ticket-perf::after { content: ''; position: absolute; top: -9px;
  width: 16px; height: 16px; border-radius: 50%; background: var(--color-paper); border: 1px solid var(--color-rule); }
.ticket-perf::before { left: -9px; } .ticket-perf::after { right: -9px; }
.code-big { font: 800 30px/1.2 var(--font-mono); letter-spacing: 9px; color: var(--color-navy);
            overflow-wrap: anywhere; min-width: 0; }
/* 底部 Tab（手机）与中央凸起登记按钮 */
.tabbar { position: fixed; bottom: 0; left: 0; right: 0; background: var(--color-surface);
          border-top: 1px solid var(--color-rule); display: flex; justify-content: space-around;
          padding: 8px 0 10px; }
.tabbar .fab { width: 48px; height: 48px; border-radius: 50%; background: var(--color-accent);
               color: var(--color-surface); margin-top: -18px; border: 3px solid var(--color-paper);
               font: 800 12px var(--font-ui); display: grid; place-items: center; }
/* 大屏适配（§9.3）：≥768 双列；≥1024 网格三列 + 侧栏 */
.grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
@media (min-width: 768px)  { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1024px) {
  .layout { display: grid; grid-template-columns: 2.4fr 1fr; gap: var(--space-4); }
  .grid  { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  body { padding-bottom: 0; } .tabbar { display: none; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
```

- [ ] **步骤 12.3：验证** — 建 `public/index.html` 临时引用两个 CSS，`python3 -m http.server --directory public 8123` 起预览，浏览器开 `http://localhost:8123`，确认 320/375/414/768/1024 五档无横向滚动（截图），完成后临时引用即成为正式 index 骨架（T13 继续）。
- [ ] **步骤 12.4：Commit** — `git commit -am "样式: 设计系统 tokens + 组件 CSS（反AI味纪律内联）"`

---

### 任务 13：手机端 —— index.html / app.js / idb.js / canvas-image.js / sw.js

**文件：** 创建 `public/index.html`、`public/js/app.js`、`public/js/idb.js`、`public/js/canvas-image.js`、`public/sw.js`、`public/manifest.webmanifest`

- [ ] **步骤 13.1：index.html 骨架（hash 路由四视图 + 双语字典挂载点）**

```html
<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>L&F 失物招领 · Lost & Found</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css">
</head><body>
<header class="topbar">…logo + <button id="langToggle">中/EN</button> + <a id="pointsChip">积分</a>…</header>
<main id="view"></main>
<nav class="tabbar">
  <button data-route="#/">公示</button>
  <button class="fab" data-route="#/report">＋登记</button>
  <button data-route="#/points">我的积分</button>
</nav>
<script src="/js/idb.js"></script><script src="/js/canvas-image.js"></script><script src="/js/app.js"></script>
</body></html>
```

- [ ] **步骤 13.2：idb.js（IndexedDB 封装——照片/草稿/队列，禁用 localStorage）**

```js
// public/js/idb.js —— stores: drafts(登记草稿+photo Blob), queue(待补发 POST)
const DB = 'lf', VER = 1;
export function open() { return new Promise((res, rej) => {
  const r = indexedDB.open(DB, VER);
  r.onupgradeneeded = () => { const d = r.result;
    if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts');
    if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });}
export async function put(store, key, val) { const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readwrite');
    t.objectStore(store).put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });}
export async function all(store) { const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readonly');
    const q = t.objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });}
export async function del(store, key) { const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readwrite');
    t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = () => rej(t.error); });}
```

- [ ] **步骤 13.3：canvas-image.js（Canvas 重绘：抹 Exif + 压缩 ≤1MB）**

```js
// public/js/canvas-image.js —— 唯一上传通道：所有照片经此处理，禁止直接 fetch 原文件
export async function sanitize(file, maxSide = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);   // 重绘 = 元数据全部丢失
  let blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  let q = 0.85;
  while (blob.size > 1024 * 1024 && q > 0.4) {                  // ≤1MB 保证
    q -= 0.15; blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); }
  return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
}
```

- [ ] **步骤 13.4：app.js 路由与三个关键流程（登记含离线队列；认领含核验答案；积分含分级）**

```js
// public/js/app.js —— 骨架；视图渲染函数按 tokens/app.css 类名拼装
const $view = document.getElementById('view');
const routes = { '#/': renderHome, '#/report': renderReport, '#/points': renderPoints };
window.addEventListener('hashchange', () => (routes[location.hash] || renderHome)());
const api = (p, opt) => fetch('/api' + p, opt).then(r => r.json());
let lang = localStorage.getItem('lf_lang') || 'zh';
import { t } from './i18n-inline.js';  // 见下：双语字典以模块内联实现
/* i18n-inline.js: export const t = (k) => (lang === 'en' ? EN[k] : ZH[k]) ?? k;
   字典键至少覆盖：tab_home/report/points, status_pending/in_stock/ready/returned,
   report_title/verify_hint/pickup_code/copy ……（实现时一次写全两列） */
function renderHome() { /* GET /api/items → .grid 卡片（.card + .slot-tag + .status）；
  顶部统计条 mono；筛选 chips aria-pressed 切换 category；桌面≥1024 由 .layout 提供右侧栏
  （我的积分/商城——见 T10 API）。空态文案：t('empty_home')='还没有失物被捡到 —— 去转转？' */ }
async function renderReport() { /* 三步表单：photo(input capture=environment → sanitize)→
  描述/类别/地点 chips → verify_q 自由问答 + 学号/姓名/班级确认。
  提交：在线 → POST /api/report 展示凭证票据(.ticket + .code-big + 15 分钟倒计时)；
  断网 → 存 idb.drafts + queue，navigator.onLine 恢复时 flushQueue() 静默补发 */ }
async function flushQueue() { for (const job of await all('queue')) { try {
    await fetch(job.url, job.opt).then(r => { if (r.ok) del('queue', job.id); }); } catch {} } }
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); }); // iOS 降级补发
function renderClaim(code) { /* GET /api/items/:code → 表单（核验答案+学号姓名）→ POST /api/claims
  → auto_approved/approved 出认领券；pending 提示冷冻期；in_review 提示人工复核 */ }
function renderPoints() { /* 学号查询 → total+contributions；展开明细需姓名/PIN（§5.1 分级）
  商城列表 → POST /api/redemptions → 待发放订单凭证 */ }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
```

- [ ] **步骤 13.5：sw.js + manifest**

```js
// public/sw.js —— 静态壳缓存优先；API 一律网络直连（不缓存个人数据）
const SHELL = ['/', '/css/tokens.css', '/css/app.css', '/js/app.js', '/js/idb.js', '/js/canvas-image.js', '/js/i18n-inline.js'];
self.addEventListener('install', e => e.waitUntil(caches.open('lf-v1').then(c => c.addAll(SHELL))));
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;  // 网络优先，失败交给 app 层队列
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
```

`manifest.webmanifest`：name "L&F 失物招领"、display "fullscreen"、orientation "landscape"（kiosk 用）、icons（用学校蓝底白 L&F 圆标 SVG 转 PNG 192/512）。

- [ ] **步骤 13.6：真机验证** — 预览服务器 + 浏览器过 320/375/414 三档截图；离线（DevTools offline）登记草稿入队、恢复网络自动补发成功。
- [ ] **步骤 13.7：Commit** — `git commit -am "功能: 手机端四视图 + IndexedDB 离线队列 + Canvas 去 Exif + SW"`

---

### 任务 14：iPad kiosk —— kiosk.html / kiosk.css / js/kiosk.js

**文件：** 创建 `public/kiosk.html`、`public/css/kiosk.css`、`public/js/kiosk.js`、`public/vendor/jsqr.js`

- [ ] **步骤 14.1：kiosk.html 五态容器**（状态机切换 `.k-state[data-state]`，横屏优先布局照 §9.2：左动作/输入、右信息确认；空闲屏深藏青只含公开信息）

```html
<section class="k-state" data-state="idle">
  <header>…logo · 现场服务台 · ● 连接 · 时钟 · 中/EN…</header>
  <div class="k-grid">
    <div class="k-actions">
      <button class="k-big" data-go="report">📦 我捡到了东西 <small>I found something</small></button>
      <button class="k-big k-outline" data-go="find">🎁 我要找物品 <small>I lost something</small></button>
    </div>
    <aside class="k-side">今日动态：GET /api/items?returned=today 摘要 + 致谢条</aside>
  </div>
</section>
<section class="k-state" data-state="scan">…摄像头取景 <video id="cam"> + jsQR 逐帧解码 + 手动 6 位输码兜底（凭证/领取共用）…</section>
<section class="k-state" data-state="confirm-drop">…凭证 → 动态分格结果：<div class="slot-huge">格 03</div>（IBM Plex Mono 88px）→ 「我已放入」→ POST /api/kiosk/confirm-drop…</section>
<section class="k-state" data-state="claim">…浏览公示（大字卡片）→ 选物品 → 答核验 → 当场出库/转复核提示…</section>
<section class="k-state" data-state="pickup">…领取码 6 格大键盘 + 扫码 → 认领信息确认卡 → 拍照存证（getUserMedia 抓帧→sanitize）→ POST /api/kiosk/fulfill…</section>
```

- [ ] **步骤 14.2：kiosk.css** — `body { overflow: hidden; }`、`.k-state { display: none } .k-state.is-active { display: block }`、834×1194 横排网格、大按钮最小触达 64px、空闲屏背景 var(--color-navy)；竖屏 media 降级单列。

- [ ] **步骤 14.3：js/kiosk.js 状态机** — `go(state)` 切换；扫码循环：`requestAnimationFrame` + `jsQR(imageData.data, w, h)`，识别后按当前流程分别调 `confirm-drop` / `verify-pickup`；所有 API 失败 → 顶部离线横幅 + 保留在当前态；成功音效省略（克制纪律）。「我捡到了东西」直办：kiosk 直接 `POST /api/report`（表单字段 `via=kiosk`，T7 已支持）→ 成功后**同屏立即**调 `confirm-drop` 拿动态格号 → 大字指引「请放入 N 号格」→「我已放入」完成入库（登记+确认同屏两步，无需凭证码往返）。

- [ ] **步骤 14.4：验证** — 预览 1194×834 视口截图五态；用测试页生成二维码扫入确认链路；断网横幅出现。
- [ ] **步骤 14.5：Commit** — `git commit -am "功能: iPad kiosk 状态机 + jsQR 扫码 + 拍照存证"`

---

### 任务 15：隐藏后台 —— admin.html

**文件：** 创建 `public/admin.html`（不进任何导航；口令 → token 保存在 sessionStorage）

- [ ] **步骤 15.1：页面结构** — 进入页：输入口令 → `POST /api/admin/login` 不存在（无此端点），直接以口令作为 `X-Admin-Token` 调 `/api/admin/queue` 验证（401 则拒绝）；主视图三个 Tab：复核队列（claim 卡：物品/认领人/核验答案/通过/拒绝按钮 → `/api/admin/review`）、黄标抽查（risk_flags 列表 + 标记已处理）、运营（兑换订单 fulfill、积分调整、周看板 `/api/admin/stats`）。桌面优先（≥1024），表格用 `.card` 行布局。
- [ ] **步骤 15.2：验证** — 无 token 401 提示；错口令 401；正确 token 全流程走通（复核通过后可用领取码在 kiosk 核销）。
- [ ] **步骤 15.3：Commit** — `git commit -am "功能: 隐藏后台 admin（队列/黄标/运营）"`

---

### 任务 16：部署与验收（§12 上线清单）

**文件：** 创建 `DEPLOY.md`；修改 `README.md`（简介 + 本地测试方法）；`CHANGELOG.md` 记 v1.0.0

- [ ] **步骤 16.1：写 DEPLOY.md**（给工程师零上下文可执行）：

```
1. 云端准备：Cloudflare Dashboard → Workers & Pages → D1 → Create（名称 lostfound）→ 把 database_id 填回 wrangler.jsonc
2. Secrets：Settings → Variables → 添加 ADMIN_TOKEN（后台口令）
3. 部署：推 GitHub → Workers Builds 连接仓库（Build command: npx wrangler deploy）→ 首次部署后远程执行 schema：
   npx wrangler d1 execute lostfound --remote --file=schema.sql
   种子演示数据（可选）：npx wrangler d1 execute lostfound --remote --file=seed.sql
4. 绑定 PHOTOS（可选 R2）：未开通时照片仅存路径占位，物品卡显示占位图（不阻塞验收）
5. 冒烟：手机完成登记→iPad 确认→网页认领→iPad 核销→积分到账→打赏→兑换
```

- [ ] **步骤 16.2：验收清单逐项打勾** — 7 断点截图（320/375/414/768/1024/1194/1366）存 `docs/qa/`；安全自测（公开 API 响应搜 `9031622`/`verify_a` 无果；伪造扩展名上传 400；重复 fulfill 409；无 token 401）；离线补发；`prefers-reduced-motion`；slop 自检（无假数据/无内联色值/无斜体标题）。
- [ ] **步骤 16.2b：现场物料（§11）** — `public/ops/labels.html`：12 格可打印 A4 格位标签（每格半张 A5，mono 88px 大号数字 01–12 + 「L&F」角标，`@media print` 精确分页）；`public/ops/signage.html`：A5 亚克力引导牌版面（大二维码指向 `/r` 短链 + 「捡到东西？扫码登记 / 我要找物品」中英双语 + 底部条「L&F · 现场服务台」）。验收：浏览器打印预览，各一页排下、无截断。
- [ ] **步骤 16.3：CHANGELOG + 版本** — v1.0.0 条目（功能列表照 §0 摘要），README 徽章
- [ ] **步骤 16.4：Commit** — `git commit -am "发布: v1.0.0 部署与验收文档"`

---

## 执行注意（给每个工作者）

1. **顺序执行 T1→T16**；T2-T6 相互独立可并行，但都依赖 T1 的 fake-db/schema。
2. 测试即验收：每任务结束 `node --test tests/` 必须全绿才能 commit。
3. 任何与 spec 的偏差：停下来，在任务报告中说明，不要自行改规格。
4. iSH 环境无 workerd：**不要**尝试 `wrangler dev`；本地只做单测与静态预览（`python3 -m http.server --directory public`）。
5. 视觉纪律：所有色/字/间距只准引用 tokens.css 变量；发现需要新值 → 先加 token 再用。
