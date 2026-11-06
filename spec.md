# L&F 校园失物招领系统 · 规格说明书（spec.md）

> **版本基线**：本文描述的是 `v2.4.0`（2026-10-27，commit `8a20362`）的完整系统。
> **用途**：任何开发者/Agent 只读本文档，即可从零重建一个行为等价、视觉同源的网站。
> **原则**：功能与规则必须**精确复刻**（数值、状态机、接口契约、错误码）；视觉部分给出**基调、色板、字体气质与组件语言**——版式细节允许按实现者审美微调，但色板、票据/格位牌这两个签名元素、动效纪律与无障碍底线必须遵守。
> **代码规模参考**：`src/` ≈ 1,700 行；`public/` ≈ 3,900 行；测试 106 例。

---

## 0. 怎么用这份文档重建

1. 读 §1–§3，理解产品与部署形态；
2. 按 §4 建库（schema 可直接照抄成 `schema.sql`），按 §13.1 初始化；
3. 按 §5 实现业务层（所有数值、公式、状态迁移都写死了）；
4. 按 §6 实现 HTTP API（每个端点的请求/响应/错误码/副作用都列出）；
5. 按 §7–§9 实现三个前端（手机 PWA / Kiosk / 后台）；
6. 按 §10 落地视觉（色板表 + 组件语言 + 动效参数）；
7. 按 §14 验收（测试基线 + 手工清单）。

---

## 1. 产品概述

### 1.1 一句话定位

一套在校园里真实运行的失物招领闭环：**任何被捡到的东西，都在几秒内获得一个格位号并出现在公示板上；失主用手机查板、在线认领、到服务台凭「学号 + 姓名 + PIN」把东西取走；拾获者获得积分，可在积分商城兑换奖品。**

### 1.2 用户与角色

| 角色 | 谁 | 能做什么 |
|---|---|---|
| 学生（失主） | 有手机（G9+） | 手机端浏览公示板、搜索、认领、签收后查看积分与兑换 |
| 学生（拾获者） | 任何年级 | 手机端或服务台一体机登记物品；出库后获得积分 |
| 服务台使用者 | 任何人（自助） | 用锁定的 iPad 一体机：登记、查询认领、核验出库（拍照存证） |
| 管理员/教师 | 1–3 人 | 后台：出库记录与积分撤回、风险黄标、订单核销/退款、奖品与库存、学生数据库、参数设置、审计 |
| 系统 | Cloudflare Worker + Cron | 过期认领自动释放、限流表清理、历史数据自愈 |

### 1.3 三个端（同一套代码、同一个 Worker、同一个 D1）

| 端 | 入口 | 形态 |
|---|---|---|
| 手机网页（PWA） | `/` | 响应式 320–1366px；底部 Tab（Board / ＋Report / Shop）；≥1024px 显示左侧全局导航 |
| 服务台一体机 | `/kiosk` | iPad 横屏锁定全屏；大按钮、无键盘输入负担；六态状态机 |
| 后台 | `/admin` | 桌面优先、手机可用的单页控制台；口令 + 可选 Passkey 2FA；七个 Tab |

> 补充：`/kiosk.html`、`/admin.html` 会被 307 重定向到无扩展名路径（Cloudflare 静态资源行为，浏览器无感）。

### 1.4 核心闭环

```
拾获 ──▶ 登记（手机 or 一体机）──▶ 系统分配格位号 ──▶ 物品上板（in_stock）
                                                            │
                       失主手机：浏览/搜索 ──▶ 认领（学号+姓名+PIN）──▶ 当场通过（auto_approved）
                                                            │
                                        物品离开公示板，预留给认领人（ready，48h）
                                                            │
                       服务台：学号+姓名+PIN 查询 ──▶ 确认 ──▶ 拍存证照出库（returned / fulfilled）
                                                            │
                                        拾获者 +10 或 +25 积分（无照片 −2；月额度 100 封顶）
                                                            │
                       失主：积分商城兑换（学号+姓名+PIN）──▶ 订单 pending ──▶ 后台核销/取消退款
```

---

## 2. 术语表

| 术语 | 含义 |
|---|---|
| 格位 / slot | 实体储物柜的编号格（1–99），登记时由系统分配最小空闲号 |
| 公示板 / board | 公开展示的 `in_stock` 物品列表 |
| 认领 / claim | 学生声明某物品归属，需要填「仅失主知道的细节」；系统**当场自动通过** |
| 预留 / ready | 物品已分配给某认领人，离开公示板，等待现场领取（默认 48 小时） |
| 出库 / handout / fulfill | 现场核验身份后交付物品，拍摄存证照片，触发积分结算 |
| 积分流水 / ledger | `points_ledger` 表，所有积分变动的唯一事实来源；余额 = `SUM(delta)` |
| 月额度 | **每月最多「获得」100 分**的限额（只算归还奖励 + 打赏收入），**不是**余额，余额永不清零 |
| 初始分 | 每个学生第一次出现时自动获得的 67 分（`reason='initial'`），不占月额度 |
| 黄标 / risk flag | 被动风控信号（秒领、多人抢等），**只记录不拦截**，由管理员抽查处理 |
| PIN | 4 位数字，学生首次使用（认领/查询/出库/兑换任一）时设置，之后每次身份操作都要校验 |
| 领取码 | **已下线**。旧版有 6 位领取码，v1.6.0 起废除；现在是「学号 + 姓名 + PIN」 |
| 存证照 | 出库时现场拍摄的照片，与认领单关联，供事后追责 |

---

## 3. 架构与部署

### 3.1 技术栈（硬约束）

- **运行时**：Cloudflare Workers（ES Modules）。单入口 `src/worker.js`：`/api/*` 走 API 路由，其余全部回退 `env.ASSETS.fetch()`。
- **数据库**：Cloudflare D1（SQLite）。所有业务表见 §4。
- **静态资源**：`public/` 目录以 Workers Assets 方式发布（`assets.directory = "public"`, `binding = "ASSETS"`）。
- **前端**：原生 HTML/CSS/JS，**无框架、无构建步骤、无 npm 运行时依赖**。ES Module 直接 `<script type="module">`。
- **PWA**：`manifest.webmanifest` + Service Worker（网络优先 + 缓存兜底）。
- **可选对象存储**：R2 绑定 `env.PHOTOS`。**未绑定也不影响功能**——照片自动落 D1 的 `photos` 表（见 §5.7）。
- **定时任务**：Cron `*/5 * * * *`（每 5 分钟）跑 `settleFreeze()`：释放过期认领、清限流表、历史 pending 自愈。
- **字体**：自托管 woff2（Lato + IBM Plex Mono），不依赖 CDN。

### 3.2 部署拓扑

```
浏览器 ──▶ Cloudflare 边缘 ──▶ Worker（lostfound）
                                ├─ /api/*  ──▶ 路由 + D1 查询
                                ├─ 其它     ──▶ ASSETS（public/ 静态文件）
                                └─ cron */5 ──▶ settleFreeze()
                              D1: lostfound（13 张表）
                              R2: PHOTOS（可选）
```

- 域名：主域 `https://lostnfound.ominx.dpdns.org`；另一个自定义域 `lf.xiaochangblog.dpdns.org` 指向同一 Worker（等价可用）。`workers.dev` 域名在国内不可达，不作为交付地址。
- 短链：`GET /r` → 302 到 `/?from=qr`（用于引导牌二维码，落地页参数无实际副作用）。

### 3.3 配置（wrangler.jsonc）

```jsonc
{
  "name": "lostfound",
  "main": "src/worker.js",
  "compatibility_date": "2026-09-01",
  "d1_databases": [{ "binding": "DB", "database_name": "lostfound", "database_id": "<你的 D1 id>" }],
  // "r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "lostfound-photos" }],  // 启用 R2 后再打开
  "assets": { "directory": "public", "binding": "ASSETS" },
  "triggers": { "crons": ["*/5 * * * *"] },
  "vars": {
    "SLOT_COUNT": "12",          // 旧兜底；实际格位数以 settings.slots 为准（出厂 seed = 24）
    "FREEZE_MINUTES": "60",      // 仅历史 pending 自愈分支使用
    "PICKUP_TTL_HOURS": "48",    // 仅历史分支使用；新流程读 settings.pickup_ttl_hours
    "CLAIM_ACTIVE_CAP": "3",     // 旧兜底；新流程读 settings.claim_active_cap
    "CLAIM_DAILY_CAP": "5"       // 旧兜底；新流程读 settings.claim_daily_cap
  }
}
```

### 3.4 Secrets 与环境

| 名称 | 类型 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | Secret | 后台口令。示例值 `admin2026`。登录 `/admin` 用；**必须设置**否则后台全 401 |
| `DB` / `ASSETS` / `PHOTOS` | 绑定 | D1 / 静态资产 / 可选 R2 |

本地开发：仓库根建 `.dev.vars`，内容 `ADMIN_TOKEN=admin2026`。**wrangler dev 不监听 `.dev.vars`，改完必须重启**；不在仓库根启动就读不到它（表现为后台 401）。

### 3.5 初始化步骤（从零 → 可用）

```bash
npm install                                  # 只为拿本地 wrangler
npx wrangler d1 create lostfound             # 记下 database_id 填进 wrangler.jsonc
npx wrangler d1 execute lostfound --local --file=./schema.sql
npx wrangler d1 execute lostfound --local --file=./seed.sql
npx wrangler dev --port 8787 --local          # 本地起服务（必须仓库根目录）
npx wrangler secret put ADMIN_TOKEN           # 线上口令
npx wrangler deploy                            # 发布
# 线上数据库：
npx wrangler d1 execute lostfound --remote --file=./schema.sql
npx wrangler d1 execute lostfound --remote --file=./seed.sql          # 可选演示数据
# 增量迁移（已有线上库时按版本依次执行 migrations/ 下的文件）
npx wrangler d1 execute lostfound --remote --file=migrations/2026-10-24-v2.0.0.sql
npx wrangler d1 execute lostfound --remote --file=migrations/2026-10-26-v2.2.0-photos.sql
npx wrangler d1 execute lostfound --remote --file=migrations/2026-10-27-v2.4.0-initial-points.sql
npx wrangler d1 execute lostfound --remote --file=migrations/2026-11-06-v2.7.0-ideas.sql
```

**迁移文件（幂等，可重复执行）**

| 文件 | 内容 |
|---|---|
| `migrations/2026-10-24-v2.0.0.sql` | 8 个索引：identities(name/class/created_at)、items(registered_by,status)、claims(claimant_id,status)、redemptions(student_id,status)、redemptions(reward_id)、`idx_refund_once` 唯一索引 |
| `migrations/2026-10-26-v2.2.0-photos.sql` | `photos` 表（BLOB 兜底） |
| `migrations/2026-10-27-v2.4.0-initial-points.sql` | 给存量学生补 67 初始分（`reason='initial'`，幂等） |
| `migrations/2026-11-06-v2.7.0-ideas.sql` | `ideas` 表 + `idx_ideas_status`（建议箱，v2.7.0） |
| `migrations/demo-data-v2.0.0.sql` | 线上演示数据（可重复跑；会先删 `LF-2026-00xx/01xx` 的演示物品与 `ref_type='demo_seed'` 的流水） |

### 3.6 目录结构（重建时按此组织）

```
src/
  worker.js                 路由分发 + cron
  api/items.js              公开列表/详情/商城目录/照片/公告/统计/最近归还
  api/report.js             登记（一步分格）
  api/ideas.js              建议箱提交（公开写 + IP 限流）
  api/claims.js             认领 + settleFreeze
  api/kiosk.js              身份查询、出库核销、积分结算
  api/points.js             积分查询、打赏、兑换（redeemCore 共用）
  api/admin.js              后台全部端点（鉴权 + 学生/订单/奖品/设置/物品/审计）
  api/admin-webauthn.js     Passkey 2FA 路由
  lib/settings.js           settings 表读取/写入 + DEFAULTS
  lib/points.js             monthKey / grantWithCap / monthlyEarned / ensureInitialPoints(Batch) / tipCheck / redeemCheck / finalReward / PHOTO_PENALTY
  lib/guard.js              限流计数（rate_events）+ claimAllowance
  lib/identity.js           upsertIdentitySafe（首写为准）+ pinGate
  lib/pin.js                PBKDF2-SHA256(100k) 4 位 PIN
  lib/hash.js               SHA-256 hex（会话令牌）
  lib/verify.js             normalize（姓名归一化）
  lib/risk.js               evaluate() 风控规则
  lib/codes.js              pickupExpiry / isExpired
  lib/image.js              checkImage（magic byte + 1MB）
  lib/photo.js              putPhoto / readPhoto（R2 或 D1）
  lib/student-admin.js      学生库纯规则（CSV/排序/分页/删除判定）
  lib/order-admin.js        订单纯规则（核销/取消/库存调整）
  lib/webauthn.js           Passkey 验签（CBOR/COSE/P-256/DER→P1363）
  lib/cbor.js               极简 CBOR 解码
public/
  index.html                手机端外壳
  kiosk.html                Kiosk 六态
  admin.html                后台单页（7 Tab，内联样式与脚本）
  css/tokens.css            设计 token 唯一来源
  css/app.css               主站样式（含动效层）
  css/kiosk.css             Kiosk 样式（不加动效）
  css/fonts.css             字体声明
  js/app.js                 主站路由 + 三视图 + 动效 initMotion + 离线队列
  js/kiosk.js               一体机状态机
  js/i18n-inline.js         全站英文文案唯一来源
  js/idb.js                 IndexedDB（drafts/queue）
  js/canvas-image.js        照片重绘去 Exif + 压到 ≤1MB
  js/vendor/qrcode.js       二维码生成（Kiosk/物料）
  img/items/                演示物品照片（Pexels 授权）
  icons/                    全尺寸 App Icon / maskable / monochrome / favicon
  ops/labels.html           A4 格位标签打印页
  ops/signage.html          A5 引导牌打印页（二维码指向 /r）
  sw.js                     Service Worker（lf-v16）
  manifest.webmanifest      PWA 清单
schema.sql / seed.sql       初始化
migrations/                 线上增量迁移
tests/                      106 个 node:test 用例
AGENTS.md                   给后续开发者的约定与已知坑
```

---

## 4. 数据模型（D1 / SQLite）

> 约定：所有时间列存 **UTC ISO 字符串**（`2026-10-27T09:30:00.000Z`）或 SQLite `datetime('now')`（空格格式，仅默认值场景）。业务代码里显式写入的时间一律用 JS `toISOString()`。**新增/修改数据时不要再依赖默认值写时间**——历史上有混格式导致的时区解析隐患。

### 4.1 identities（学生身份，学号即账号）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| student_id | TEXT | PK | 7 位数字，如 `9031622` |
| name | TEXT | NOT NULL | 姓名（首写为准，改名只能走后台） |
| class | TEXT | NOT NULL | 班级，如 `7B` / `8C` |
| pin_hash | TEXT | 可空 | 4 位 PIN 的 PBKDF2-SHA256 哈希，格式 `saltHex$hashHex`（16B 盐、100k 迭代） |
| created_at | TEXT | 默认 now | 建号时间 |

**规则**：
- 首次出现（手机登记/认领、Kiosk、后台建号、CSV 导入）→ 插入身份行，并**幂等**补 67 初始分。
- 已存在 → 姓名必须归一化匹配（NFKC → 小写 → 去除空白/标点/符号），否则 `IDENTITY_NAME_MISMATCH`（403）。**任何入口都不得覆盖已存在的姓名**（防冒领劫持）。
- `pin_hash` 为空 = 尚未设置 PIN；下一次身份操作带着合法 4 位数字即被写入（TOFU）。后台可重置为空。

### 4.2 items（物品）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| code | TEXT | UNIQUE NOT NULL | 物品码：`LF-<UTC年>-<4位crypto随机base36>`，如 `LF-2026-mpq9`；插入冲突自动重试 ≤4 次 |
| title | TEXT | NOT NULL | ≤40 字符（后台编辑限制同） |
| description | TEXT | 默认 '' | 简描述（前端 ≤80） |
| category | TEXT | NOT NULL | 枚举：`electronics` `card` `clothing` `book` `other` |
| location | TEXT | NOT NULL | 拾获地点（手机 ≤30；Kiosk 用 chip 或 Other 输入 ≤40） |
| photo_path | TEXT | 可空 | 相对路径 `photos/xxx.jpg`，或静态 `/img/items/xxx.jpg`（演示数据） |
| detail_photo_path | TEXT | 可空 | 预留，未使用（保列） |
| verify_q | TEXT | 可空 | 核验问题（会公开在物品详情里，供认领人作答） |
| verify_a | TEXT | 可空 | 核验答案（**永不公开**；当前仅存档，不做自动判定） |
| value_tier | TEXT | NOT NULL 默认 normal | `high`（electronics/card）或 `normal`，决定归还积分 25/10 |
| slot_no | INTEGER | 可空 | 1–99；登记时分配最小空闲格 |
| drop_code / drop_expires_at | TEXT | 可空 | **已废弃**（v1.3.0 起不再使用，保列不删） |
| status | TEXT | NOT NULL 默认 registered | 见状态机 §5.1 |
| registered_by | TEXT | NOT NULL → identities | 拾获者学号（积分归属） |
| registered_via | TEXT | NOT NULL | `phone` 或 `kiosk` |
| found_at | TEXT | NOT NULL | 拾获时间（= 登记时间） |
| created_at / updated_at | TEXT | | `updated_at` 在每次状态迁移时刷新（出库时用 `datetime('now')`） |

**索引**：`idx_items_status(status, created_at DESC)`、`idx_items_drop(drop_code)`（遗留）、`idx_items_finder(registered_by, status)`。

### 4.3 claims（认领单）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK | |
| item_id | INTEGER | NOT NULL → items | |
| claimant_id | TEXT | NOT NULL → identities | 认领人学号 |
| verify_answer | TEXT | 可空 | 认领人对核验问题的作答（≤200 字符，仅存档供后台参考） |
| status | TEXT | 默认 pending | 见 §5.2；**当前流程只会写 `auto_approved`**，其余状态用于历史数据/自愈 |
| pickup_code | TEXT | UNIQUE 可空 | **已废弃**（v1.6.0 起不再生成，保列） |
| pickup_expires_at | TEXT | 可空 | 预留截止时间（= 通过时间 + `settings.pickup_ttl_hours`，默认 48h） |
| review_reason | TEXT | 可空 | `PICKUP_EXPIRED` / `ADMIN_REOPEN` / `ADMIN_REJECTED`（历史）等 |
| evidence_photo_path | TEXT | 可空 | 出库存证照相对路径 `evidence/xxx.jpg` |
| created_at | TEXT | 默认 now | 认领时间（新代码显式写 ISO） |
| fulfilled_at | TEXT | 可空 | 出库时间（`datetime('now')`） |

**索引**：`idx_claims_item(item_id, status)`、`idx_claims_claimant(claimant_id, status)`。

### 4.4 points_ledger（积分流水，唯一事实来源）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| student_id | TEXT NOT NULL | 学号 |
| delta | INTEGER NOT NULL | + 获得 / − 消耗 |
| reason | TEXT NOT NULL | `claim_reward` `tip_in` `tip_out` `redeem` `redeem_refund` `adjust` `revoke` `initial` |
| ref_type | TEXT | `claim` / `redemption` / `admin` / `identity` / `demo_seed` |
| ref_id | INTEGER | 关联对象 id（admin 调整为 NULL） |
| month_key | TEXT NOT NULL | `YYYY-MM`（UTC），用于月额度 |
| created_at | TEXT 默认 now | |

**索引与唯一约束**：
- `idx_ledger_month(student_id, month_key)`
- `idx_tip_once(ref_type, ref_id, student_id) WHERE reason='tip_in'` —— 同一认领单对同一人只能打赏一次（并发兜底）
- `idx_refund_once(ref_type, ref_id) WHERE reason='redeem_refund'` —— 同一订单只能退一次分

**余额定义**：`SUM(delta)`，**永不清零、永不按月重置**。

### 4.5 rewards（奖品目录）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| name / name_en | TEXT NOT NULL | 展示名（name_en 供英文界面；两者通常相同） |
| cost | INTEGER NOT NULL | 积分价，> 0 |
| stock | INTEGER NOT NULL 默认 0 | 库存，≥ 0（永不为负） |
| active | INTEGER 默认 1 | 1 上架 / 0 下架（下架不在公开目录显示，不可兑换） |
| icon | TEXT | 卡片图标（emoji，≤8 字符；空则前端用 🎁 占位） |

### 4.6 redemptions（兑换订单）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| student_id | TEXT NOT NULL | |
| reward_id | INTEGER NOT NULL → rewards | |
| points_cost | INTEGER NOT NULL | 下单时的价格快照 |
| status | TEXT 默认 pending | `pending` → `fulfilled`（核销）/ `cancelled`（取消退款） |
| created_at | TEXT 默认 now | |
| fulfilled_at | TEXT | 核销时间 |

**索引**：`idx_redemptions_student(student_id, status)`、`idx_redemptions_reward(reward_id)`。

### 4.7 risk_flags（风险黄标）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| subject_type | TEXT | `item`（当前只会写这个）/ `claim` / `pair`（预留） |
| subject_id | TEXT | 物品 id 字符串 |
| reason | TEXT | `SNATCH_10MIN` `FREEZE_COMPETING`（当前触发）；`CLAIMANT_FREQUENT` `PAIR_FREQUENT` `MULTI_CLAIM` `DUPLICATE_DESC`（规则已实现、当前未喂数据） |
| resolved | INTEGER 默认 0 | 0 未处理 / 1 已忽略 |
| created_at | TEXT 默认 now | |

### 4.8 admin_audit（审计日志）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| action | TEXT NOT NULL | 见 §9.5 的动作清单 |
| target | TEXT | 如 `claim:12`、`student:9031622`、`reward:7` |
| detail | TEXT | 附加信息（≤500 字符，如 `name:...:class:...:pin:set`） |
| created_at | TEXT 默认 now | |

### 4.9 rate_events（限流计数）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| kind | TEXT | `admin`（登录失败，key=IP）/ `pin`（PIN 错误，key=学号） |
| key | TEXT | 见上 |
| ts | INTEGER | 毫秒时间戳 |

**索引**：`idx_rate_kind(kind, key, ts)`。超过 24h 的记录由 Cron 清理。

### 4.10 settings（可调参数）

| key | 出厂值（seed） | 含义 | 允许范围（后台校验） |
|---|---|---|---|
| `slots` | `24` | 格位总数 | 1–99 |
| `pickup_ttl_hours` | `48` | 认领预留时长 | 1–720 |
| `claim_active_cap` | `3` | 每人「活跃认领」上限 | 1–99 |
| `claim_daily_cap` | `5` | 每人每日认领上限 | 1–99 |
| `reward_normal` | `10` | 普通物品归还积分 | 0–999 |
| `reward_high` | `25` | 高价值物品归还积分 | 0–999 |
| `month_cap` | `100` | 每月最多「获得」积分 | 0–9999 |
| `snatch_min` | `10` | 秒领黄标阈值（分钟） | 0–1440 |
| `notice` | 空 | 全站公告文案（≤300 字符） | 任意字符串 |
| `notice_on` | `0` | 公告开关 | `0`/`1` |

> 代码内 DEFAULTS 的 `slots` 兜底是 `12`，而 `publicStats` 与格位墙的兜底是 `24`；**初始化时必须写入 settings（seed 已写 24）**，否则这两处兜底不一致。

### 4.11 admin_sessions（2FA 会话）

| 列 | 类型 | 说明 |
|---|---|---|
| token_hash | TEXT PK | 会话令牌的 SHA-256 hex（令牌本身只存在于浏览器 sessionStorage） |
| created_at | INTEGER | 毫秒 |
| expires_at | INTEGER | 毫秒；默认 12 小时；过期记录在发新会话时顺带清理 |

### 4.12 webauthn_creds（Passkey 凭据）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | base64url 的 credentialId |
| public_jwk | TEXT | COSE → JWK 的 JSON（P-256 公钥） |
| alg | INTEGER | 固定 `-7`（ES256） |
| sign_count | INTEGER | 认证器签名计数（记录用） |
| label | TEXT | 设备标签（当前写 `Admin device`） |
| created_at | TEXT 默认 now | |

### 4.13 webauthn_challenges（一次性挑战）

| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | `register` / `login`（同一时刻各保留一条） |
| challenge | TEXT | base64url，32 字节随机 |
| expires_at | INTEGER | 毫秒，有效期 5 分钟 |
| used | INTEGER | 0/1；验证成功即置 1（**一次性**） |

### 4.14 photos（照片兜底存储）

| 列 | 类型 | 说明 |
|---|---|---|
| path | TEXT PK | 与 `items.photo_path` / `claims.evidence_photo_path` 相同的相对路径 |
| mime | TEXT | `image/jpeg` 或 `image/png` |
| size | INTEGER | 字节数 |
| bytes | BLOB | 原始字节（服务端上限 1.1MB） |
| created_at | TEXT 默认 now | |

### 4.15 ideas（建议箱，v2.7.0）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| message | TEXT NOT NULL | 学生留言，服务端 trim 后 5–600 字符 |
| page | TEXT 可空 | `board` / `report` / `rewards` / `kiosk` / `other` |
| contact | TEXT 可空 | 学号或邮箱，2–120 字；仅后台可见 |
| status | TEXT 默认 new | `new` / `seen` |
| ip_hash | TEXT 可空 | 提交 IP 的 SHA-256，仅用于溯源，不展示 |
| created_at | TEXT 默认 now | |

### 4.16 状态枚举速查

**items.status**：`registered`（刚插入、未分配格位，瞬时态）→ `in_stock`（在板上）→ `claim_pending`（历史态，当前不写）→ `ready`（预留给认领人）→ `returned`（已出库）；另有 `voided`（后台下架）、`expired`（历史态）。

**claims.status**：`pending`（历史）→ `in_review`（历史）/ `approved`（历史）/ `auto_approved`（**当前唯一入口**）→ `fulfilled`；另有 `rejected`（历史）、`expired`（超时释放）。

---

## 5. 业务规则（精确行为）

### 5.1 物品状态机

```
                登记(/api/report)
                       │
                 [registered] ──分配格位──▶ [in_stock] ──认领──▶ [ready] ──出库──▶ [returned]
                       │                        │                  │
                       │(格满则删除该行)          │(后台 void)        │(超时未取，Cron)
                       ▼                        ▼                  ▼
                     (无)                    [voided]           [in_stock]（回到板上，claim 置 expired）
```

- **登记**：先插入 `registered`（无格位），随后从 1 到 `settings.slots` 找最小空闲格（占用定义为 `status IN ('in_stock','claim_pending','ready') AND slot_no IS NOT NULL`），用乐观锁 `UPDATE … WHERE status='registered' AND slot_no IS NULL` + `changes===1` 抢占；抢不到继续下一个号。全部失败 → **删除该行**并返回 507 `SLOTS_FULL`。
- **认领**：`UPDATE items SET status='ready' WHERE id=? AND status IN ('in_stock','claim_pending')`（失败也不影响主流程判定——认领单已建；但正常情况下必然成功）。
- **出库**：由 `completeHandout` 原子完成两件事（`db.batch`）：
  1. `UPDATE items SET status='returned', updated_at=datetime('now') WHERE id=? AND status IN ('in_stock','ready')`
  2. `UPDATE claims SET status='fulfilled', fulfilled_at=datetime('now'), evidence_photo_path=COALESCE(?, evidence_photo_path) WHERE id=? AND status IN ('approved','auto_approved')`
  任一语句 `changes!==1` → 整体返回 **409 CONFLICT**（重复核销、并发竞态都在这里挡住）。
- **后台干预**：`items/reopen` 仅对 `returned` 生效 → 回 `in_stock`（并给该物品的 fulfilled 认领单写 `review_reason`）；`items` 编辑接口只允许把 `registered/voided ↔ in_stock` 互转，其它迁移 409。
- **格位唯一性**：同一格位在 `in_stock/claim_pending/ready` 中最多一个物品（后台改格位时检查冲突 → 409 `SLOT_TAKEN`）。

### 5.2 认领生命周期（全凭自觉）

1. **入口校验**（顺序固定）：学号格式（7 位）→ 物品存在且 `in_stock/claim_pending`（否则 404 `ITEM_NOT_CLAIMABLE`）→ 身份首写/姓名匹配（否则 403 `IDENTITY_NAME_MISMATCH`）→ PIN 门（格式/限流/校验或首设）→ 防刷计量（活跃 ≤ `claim_active_cap`、当日 ≤ `claim_daily_cap`，超限 429）→ **立即 `auto_approved`**。
2. **写入**：`claims(item_id, claimant_id, verify_answer ≤200, status='auto_approved', pickup_expires_at=now+ttl, created_at=ISO)`；随后物品转 `ready`。
3. **响应**：`{ ok, id, status:'auto_approved', pickup_expires_at }`（**不含任何领取码**）。
4. **风控黄标**（在写入前判定，只记录不拦截）：
   - `latencyMin = (now − item.created_at)/60000 < settings.snatch_min` → `SNATCH_10MIN`
   - 该物品已有 ≥1 条 approved/auto_approved 认领 → `FREEZE_COMPETING`
5. **过期释放**（Cron 每 5 分钟）：`claims.status IN ('approved','auto_approved') AND items.status='ready' AND pickup_expires_at < now` → 认领单置 `expired`（`review_reason='PICKUP_EXPIRED'`），物品回 `in_stock`（**无通知、无积分变动**）。
6. **历史自愈**：`claims.status='pending'` 且物品创建超过 `FREEZE_MINUTES`（默认 60）→ 单人则置 `approved` 并发 `pickup_expires_at`；≥2 人则置 `in_review`。新代码不会产生 pending，此分支只为老数据兜底。

### 5.3 身份与防冒领

- **首写为准**：`identities` 的姓名与班级只在**首次出现**时写入；之后任何入口的姓名都必须归一化匹配（`normalize`：NFKC → 小写 → 去 `\s\p{P}\p{S}`），否则 403。**不存在任何“覆盖姓名”的路径**（后台改名校验后属受控例外）。
- **PIN 门**（`pinGate`，所有身份操作共用）：
  1. 必须匹配 `^\d{4}$`，否则 400 `PIN_FORMAT`；
  2. 该学号最近 1 小时 PIN 失败 ≥10 次 → 429 `TOO_MANY_PIN`；
  3. 有 `pin_hash` → 校验失败 403 `PIN_INCORRECT` 且失败计数 +1；
  4. 无 `pin_hash` → 把本次输入写入（**首次使用即设置**，TOFU），放行。
- **使用 PIN 门的场景**：认领（`/api/claims`）、Kiosk 身份查询（`lookup-claims`）、出库（`fulfill`）、商城兑换（`redeemCore`）。
- **只读查询**（`/api/points/:sid?pin=`）不写 PIN，只校验（无 hash 时视为失败）。
- **恢复路径**：后台 `students/reset-pin`（单个或批量）把 `pin_hash` 置空 → 学生下次使用重新设置。
- **学号泄露面**：公开接口只输出 `finder_name / finder_class`（拾获者姓名+班级），**绝不输出学号**；`verify_a`（答案）永不公开；`verify_q`（问题）会公开。

### 5.4 积分体系（v2.4.0 口径，必须逐条实现）

**余额**：`SUM(points_ledger.delta)`，**永不清零、不按月重置**。

**月额度（每月最多“获得” 100 分）**：
- 只有两类收入计入额度：`claim_reward`（归还奖励）与 `tip_in`（打赏收入），且只算 `delta > 0` 的记录（`monthlyEarned()`）。
- **不计入额度**：`initial`（初始分）、`adjust`（管理员调整）、兑换扣分（负值本来就不计）、退款（`redeem_refund` 是退回，不是获得）。
- 兑换扣分**不会返还**本月的“已获得”额度 —— 额度是单向累计，不是净流水。

**归还奖励**（出库时结算给拾获者）：
```
base = tier==='high' ? settings.reward_high : settings.reward_normal     // 默认 25 / 10
want = hasPhoto ? base : base - 2                                        // PHOTO_PENALTY = 2，最低 0
delta = min(want, max(0, settings.month_cap - monthlyEarned(finder, 当月)))  // 默认 cap=100
若 delta > 0 → 写 points_ledger(reason='claim_reward', ref_type='claim', ref_id=claim.id)
响应 { points_granted: delta, capped: delta<want, has_photo, photo_penalty: hasPhoto?0:2 }
```
> `hasPhoto` 取 `items.photo_path` 是否为空 —— 即“登记时有没有照片”，不是出库存证照。

**初始分**：每个学生第一次出现时自动写入 `points_ledger(student_id, +67, reason='initial', ref_type='identity', ref_id=student_id, month_key=当月的YYYY-MM)`，**幂等**（同一学生只会有一条 `initial`）。触发点：`upsertIdentitySafe`（手机登记/认领、Kiosk 全流程）、后台建号、CSV 导入（批量）。**不占当月额度**；删除学生时随身份一起删除。

**打赏（tip）**：认领人给出库后的拾获者打赏 1–10 分，绑定该认领单：
- 前置：认领单存在且 `status='fulfilled'`；打赏者必须是该单认领人；同一单同一人只能打赏一次（唯一索引兜底 → 并发冲突返回 409 `ALREADY_TIPPED`）。
- 上限：按对方当月的 `monthlyEarned` 截断（`cap` 当前代码硬编码 100，**不受 settings.month_cap 影响**——这是已知小不一致）。
- 记账：`tip_in`（+delta，接收者）与 `tip_out`（−delta，打赏者）成对写入，同一事务。

**兑换（redeem）**：
- 必填：学号 + 姓名 + PIN；身份不存在 404、姓名不匹配 403、PIN 门失败按状态码返回。
- 校验：奖品存在且 `active=1`（否则 404）；余额 ≥ cost（否则 **402** `INSUFFICIENT_POINTS`）；库存 > 0（否则 409 `OUT_OF_STOCK`）。
- 扣库存：单语句乐观锁 `UPDATE rewards SET stock=stock-1 WHERE id=? AND stock>0 AND active=1`，`changes!==1` → 409（**防超卖**）。
- 落单：`INSERT redemptions(status='pending', points_cost=cost)` + `INSERT points_ledger(−cost, reason='redeem', ref_type='redemption', ref_id=reward_id)`（同一批）。
- 响应：`{ ok, redemption_id, note }`。

**订单核销（fulfill）**：仅 `pending` → `fulfilled`（幂等：重复核销 409 `ALREADY_FULFILLED`；已取消 409 `ORDER_CANCELLED`）。

**订单取消退款（cancel）**：
- `pending` → `cancelled`：库存 +1、写 `redeem_refund(+points_cost)`、审计，**同一事务**；唯一索引保证一单只能退一次（重复请求幂等返回 200 `already:true, refunded_points:0`）。
- `fulfilled` → 409 `ALREADY_FULFILLED`。

**撤回积分（revoke）**：管理员按认领单冲销：读取该单所有 `claim_reward` 之和 S，写 `revoke(−S)` 给拾获者；**每单只能撤一次**（有 revoke 记录即 409 `ALREADY_REVOKED`）。物品状态不变。

**手动调整（adjust）**：±1–10000 的整数，写 `reason='adjust', ref_type='admin'`，审计必留。

### 5.5 库存与并发（通用纪律）

- 一切状态迁移用「`UPDATE … WHERE 旧状态` + `changes===1`」，否则 409。
- D1 的 `db.batch` 是单事务：会一起成功或一起回滚。
- 任何“先读后写”的关键路径（改格位、取消退款、导入）都要在写前重新检查或依赖唯一索引兜底。

### 5.6 防刷与限流（数值表）

| 对象 | 规则 | 超限返回 |
|---|---|---|
| 认领（按学号） | 活跃认领 ≤ 3（`settings.claim_active_cap`）；“活跃”= `approved/auto_approved/pending/in_review` 且未过期 | 429 `TOO_MANY_ACTIVE` |
| 认领（按学号） | 当日认领 ≤ 5（`settings.claim_daily_cap`；按 UTC 日界） | 429 `TOO_MANY_TODAY` |
| PIN 尝试（按学号） | 1 小时 10 次错误 | 429 `TOO_MANY_PIN` |
| 后台登录失败（按 IP） | 10 分钟 5 次 | 429 `TOO_MANY_ATTEMPTS` |
| 临时表清理 | `rate_events` 超 24h 由 Cron 删除 | — |

> 后台登录限流只拦“失败尝试”，**正确口令/有效会话永远放行**（避免把管理员自己锁在门外）。

### 5.7 照片管道

1. **客户端**（手机端）：`sanitize(file)` — `createImageBitmap` → Canvas 重绘（清除全部 Exif/元数据）→ 最长边 1600px → JPEG 质量 0.85，若 >1MB 则按 0.15 递减（最低 0.4）→ 返回 `File`。Kiosk 用 `grabBlob()` 直接从相机视频帧画布导出 JPEG 0.85。
2. **服务端校验**（`checkImage`）：字节 ≤1MB；magic byte 判定 JPEG（`FF D8 FF`）或 PNG（`89 50 4E 47`）；不合法 400 `TOO_LARGE` / `NOT_IMAGE`。
3. **落盘**（`putPhoto(db, env, path, bytes, mime)`）：
   - 路径：物品 `photos/<毫秒时间戳>-<6位随机>.<jpg|png>`；存证 `evidence/<同样>`。
   - 若绑定 R2（`env.PHOTOS`）→ 写 R2；
   - 否则写 D1 `photos` 表（BLOB，上限 1.1MB）。
4. **读取**（`GET /api/photos/<path>`）：路径必须匹配 `^[A-Za-z0-9._/-]+$` 且不含 `..`；先 R2 后 D1；命中返回字节 + `content-type` + `cache-control: public, max-age=86400`；未命中 404。
5. **前端展示**：有 `photo_path` → `<img>`；404/解码失败 → 就地降级为“分类字形占位”（不出现破图）。**任何照片展示口都必须接 `wireThumbs()` 或等价的降级逻辑。**

### 5.8 定时任务（`scheduled` → `settleFreeze`）

1. **过期释放**：见 §5.2-5。
2. **限流表清理**：删 24h 前的 `rate_events`。
3. **历史 pending 自愈**：见 §5.2-6。
返回 `{ ok, released, approved, reviewed }`（供日志/调试）。

### 5.9 审计（admin_audit）

**所有会改动数据或权限的后台操作都必须写审计**，动作名与 target 约定：

| action | target 示例 | 触发点 |
|---|---|---|
| `flag_resolve` | `flag:12` | 忽略黄标 |
| `points_revoke` | `claim:12:-10` | 撤回积分 |
| `item_reopen` | `item:5:wrong pickup` | 物品回板 |
| `points_adjust` | `9031622:50` | 手动调分 |
| `redemption_fulfill` / `redemption_cancel` | `redemption:7` | 订单核销/退款 |
| `reward_create` / `reward_update` / `reward_stock` / `reward_delete` | `reward:4` | 奖品管理 |
| `identity_update` / `identity_reset_pin` | `9031622:name:class` | 旧身份接口 |
| `student_create` / `student_update` / `student_reset_pin` / `student_delete` / `student_delete_bulk` / `students_set_class` / `students_import` | `9031622` 或 `students:3` | 学生库 |
| `settings_update` | `slots,reward_high` | 参数设置 |
| `item_update` | `item:5:in_stock` | 物品编辑 |
| `admin_login_2fa` | `passkey` | 2FA 登录成功 |

---

## 6. API 参考

通用约定：
- 所有 `/api/*` 响应都是 JSON（照片与 CSV 导出除外），成功 `{ "ok": true, ... }`，失败 `{ "ok": false, "error": "<CODE>" }`。
- 未捕获异常统一 **500 `SERVER_ERROR`**（不回显错误细节）。
- 未知路由 **404 `NOT_FOUND`**。
- 除标注「公开」外，`/api/admin/*` 全部需要 `X-Admin-Token` 头。
- 请求体：JSON（`content-type: application/json`）或 `multipart/form-data`（登记、出库照片）。

### 6.1 公开接口（无需鉴权）

#### `GET /api/items`
查询参数：`category`（可选，白名单 `electronics|card|clothing|book|other`）、`q`（可选，≤40 字符，LIKE 匹配 title/description/location，`%_` 被剥离）。
响应：`{ ok, items: [{ id, code, title, description, category, location, photo_path, slot_no, value_tier, status, found_at, verify_q, finder_name, finder_class }] }`（`status='in_stock'`，按 created_at DESC，上限 100）。
说明：`verify_a` 不出现；学号不出现。

#### `GET /api/items/:id`
响应：`{ ok, item }`（同上字段，单条，仅 `in_stock`）。不存在或已下板 → 404 `NOT_FOUND`。

#### `GET /api/rewards`
响应：`{ ok, rewards: [{ id, name, name_en, cost, stock, icon }] }`（仅 `active=1`，按 cost 升序）。不含 active 字段。

#### `GET /api/site`
响应：`{ ok, notice: string, notice_on: boolean }`。

#### `GET /api/stats`
响应：
```json
{ "ok": true, "on_board": 14, "returned_total": 4, "returned_30d": 4,
  "avg_return_hours": 25, "points_awarded": 70, "students": 7,
  "slots": 24, "occupied": 16 }
```
- `avg_return_hours`：`returned` 物品 `updated_at - found_at` 的平均小时数，一位小数；无数据时 `null`。
- `points_awarded`：全站 `claim_reward` 的 `SUM(delta)`。
- `occupied`：`in_stock/claim_pending/ready` 的物品数。

#### `GET /api/reunited`
响应：`{ ok, items: [{ title, category, photo_path, hours }] }`（最近 6 件 `returned`，按 updated_at DESC；`hours` 为整数小时，四舍五入）。

#### `GET /api/photos/<path>`
返回图片字节（见 §5.7-4）。非图片路径/穿越/未命中 → 404。

#### `GET /r`
302 → `/?from=qr`（短链，供引导牌二维码）。

### 6.2 登记

#### `POST /api/report`（multipart/form-data）

| 字段 | 必填 | 规则 |
|---|---|---|
| title | 是 | ≤40 |
| description | 否 | ≤80 |
| category | 是 | 五类之一 |
| location | 是 | ≤30（Kiosk 可到 40） |
| student_id | 是 | 7 位数字 |
| name / class | 是 | 姓名 ≤20，班级 ≤10 |
| verify_q / verify_a | 否 | 核验问题/答案（手机端问题固定为一句英文，答案 ≤60） |
| photo | 否 | image/jpeg 或 png，≤1MB |
| via | 否 | `kiosk` 或 `phone`（默认 phone） |

成功：`200 { ok: true, code: "LF-2026-ab12", slot_no: 7 }`。
失败：`400 BAD_STUDENT_ID | MISSING_FIELDS | TOO_LARGE | NOT_IMAGE`；`403 IDENTITY_NAME_MISMATCH`；`503 CODE_RETRY`；**`507 SLOTS_FULL`**（格位满，事务回滚已删除刚插入的行）。

### 6.3 认领

#### `POST /api/claims`（JSON）
请求：`{ code, student_id, name, class, pin, verify_answer }`
成功：`200 { ok: true, id, status: "auto_approved", pickup_expires_at }`
失败：`400 BAD_STUDENT_ID | PIN_FORMAT`；`403 IDENTITY_NAME_MISMATCH | PIN_INCORRECT`；`404 ITEM_NOT_CLAIMABLE`；`429 TOO_MANY_PIN | TOO_MANY_ACTIVE | TOO_MANY_TODAY`。

### 6.4 Kiosk / 现场流程

#### `POST /api/kiosk/lookup-claims`（JSON）
请求：`{ student_id, name, pin }`
成功：
```json
{ "ok": true, "claims": [
  { "claim_id": 12, "status": "auto_approved", "title": "Blue hoodie",
    "slot_no": 7, "location": "Gym", "found_at": "...", "code": "LF-2026-...",
    "expired": false, "claimable": true } ] }
```
（只返回该学号 `approved/auto_approved/pending/in_review` 的认领，最多 20 条；**不返回任何领取码**）
失败：`400 BAD_STUDENT_ID | BAD_NAME | PIN_FORMAT`；`403 NAME_MISMATCH | PIN_INCORRECT`；`404 IDENTITY_NOT_FOUND`；`429 TOO_MANY_PIN`。

#### `POST /api/kiosk/fulfill`
Content-Type 两种：`multipart/form-data`（`claim_id, student_id, name, pin, photo`）或 JSON（同字段无 photo）。
成功：`200 { ok: true, points_granted, capped, has_photo, photo_penalty }`
失败：`400 MISSING_CREDENTIAL | PIN_FORMAT | TOO_LARGE | NOT_IMAGE`；`403 NAME_MISMATCH | PIN_INCORRECT`；`404 IDENTITY_NOT_FOUND | CLAIM_NOT_FOUND`；`409 CONFLICT`（重复核销/竞态）；`410 CLAIM_EXPIRED`。

### 6.5 积分与商城

#### `GET /api/points/:sid`
查询参数：`name`、`pin`（二选一或都给，`name` 优先）。
- 无参数（公开级）：`{ ok, total, contributions }`（`contributions` = 不同的 `claim_reward.ref_id` 数量）
- 带参数且校验通过：`{ ok, total, contributions, ledger: [{delta, reason, created_at}] (≤50), redemptions: [{points_cost, status, name}] (≤20) }`
- 学号不存在 404 `NOT_FOUND`；校验失败 403 `FORBIDDEN`；PIN 错误过多 429 `TOO_MANY_PIN`。

#### `POST /api/tips`（JSON）
请求：`{ claim_id, from, to, points }`（`points` 为 1–10 整数）
成功：`200 { ok, granted, capped }`
失败：`400 BAD_AMOUNT | CLAIM_NOT_FULFILLED | NOT_CLAIMANT`；`409 ALREADY_TIPPED`。

#### `POST /api/redemptions`（JSON）
请求：`{ student_id, reward_id, name, pin }`
成功：`200 { ok, redemption_id, note }`
失败：`400 BAD_STUDENT_ID | PIN_FORMAT`；`402 INSUFFICIENT_POINTS`；`403 NAME_MISMATCH | PIN_INCORRECT`；`404 IDENTITY_NOT_FOUND | REWARD_NOT_FOUND`；`409 OUT_OF_STOCK`；`429 TOO_MANY_PIN`。

#### `POST /api/ideas`（JSON，公开）

请求：`{ message, page?, contact? }`
成功：`200 { ok, id }`
失败：`400 BAD_BODY | EMPTY | TOO_SHORT | TOO_LONG | BAD_CONTACT`；`429 TOO_MANY`（同 IP 每小时 5 条）。
说明：`message` 服务端折叠空白后长度 5–600；`page` ≤40 字符；`contact` 2–120 字（字母/数字/空格/`@._+-`）；`ip_hash` 只存 SHA-256。

### 6.6 后台接口（全部需要 `X-Admin-Token`）

**鉴权模型**
- `X-Admin-Token` 可以是：① 后台口令 `ADMIN_TOKEN`；② 2FA 登录后签发的会话令牌（32 字节随机，base64url；库里只存 SHA-256，有效期 12 小时）。
- 若已注册 Passkey（`webauthn_creds` 非空），**口令单独不再通用**：只能用会话令牌访问普通端点；口令只放行 `/api/admin/webauthn/*` 登录/注册端点。此时口令访问普通端点 → `401 NEED_2FA`。
- 失败限流：10 分钟 5 次/ IP（`CF-Connecting-IP`）→ 429。**校验成功不计数、不受限**。
- 无 token → 401 `UNAUTHORIZED`。

#### 风险黄标
- `GET /api/admin/flags` → `{ ok, flags: [risk_flags 行] }`（未处理，≤50）
- `POST /api/admin/flags/resolve` `{ id }` → `{ ok }`（置 resolved=1）

#### 建议箱（v2.7.0）
- `GET /api/admin/ideas?status=`（可选 `new|seen`，默认全部）→ `{ ok, ideas: [ {id, message, page, contact, status, created_at} ], counts: {new, seen} }`（新的在前，≤300）
- `POST /api/admin/ideas/status` `{ id, status }` → `{ ok }`；`status` ∈ {`new`,`seen`}，否则 400 `BAD_FIELDS`；不存在 404 `NOT_FOUND`
- `POST /api/admin/ideas/delete` `{ id }` → `{ ok }`；不存在 404 `NOT_FOUND`
- 以上写操作均写 `admin_audit`（`idea_status` / `idea_delete`）

#### 看板
- `GET /api/admin/stats` → `{ ok, stats: { on_board, reserved, returned, active_claims } }`

#### 出库与积分干预
- `GET /api/admin/handouts` → `{ ok, handouts: [ … ] }`（最近 30 条 `fulfilled_at IS NOT NULL`，含 claimant/finder 姓名、`granted`、`revoked` 布尔）
- `POST /api/admin/points/revoke` `{ claim_id }` → `{ ok, revoked_points }`；404 `CLAIM_NOT_FOUND`；409 `ALREADY_REVOKED`
- `POST /api/admin/items/reopen` `{ item_id, reason? }` → `{ ok }`；仅 `returned` 可回板，否则 409 `NOT_RETURNED`
- `POST /api/admin/points/adjust` `{ student_id, delta }` → `{ ok }`；学号 7 位、`delta` 非零整数且 |delta|≤10000，否则 400 `BAD_FIELDS`

#### 订单
- `GET /api/admin/redemptions?status=`（可选 `pending|fulfilled|cancelled`）→ `{ ok, redemptions: [ {id, points_cost, status, created_at, fulfilled_at, student_id, student_name, student_class, reward_id, reward_name, reward_icon, reward_stock} ] }`（pending 优先，≤100）
- `POST /api/admin/redemptions/fulfill` `{ id }` → `{ ok, id, status:'fulfilled' }`；409 `ALREADY_FULFILLED | ORDER_CANCELLED | NOT_PENDING`；404 `ORDER_NOT_FOUND`
- `POST /api/admin/redemptions/cancel` `{ id }` → `{ ok, id, status:'cancelled', student_id, student_name, reward_name, refunded_points, stock }`；重复取消 → 200 `{ already:true, refunded_points:0 }`；`fulfilled` → 409

#### 奖品
- `GET /api/admin/rewards` → `{ ok, rewards: [ {id, name, name_en, cost, stock, active, icon} ] }`（含下架，active DESC, cost）
- `POST /api/admin/rewards` `{ id?, name, cost, stock, active?, icon?, name_en? }` → `{ ok, id }`；`name` 非空、`cost` 正整数、`stock` ≥0 否则 400 `BAD_FIELDS`；带 `id` 则更新（不存在 404）
- `POST /api/admin/rewards/stock` `{ id, delta }` → `{ ok, id, stock, delta }`；`delta` 非零整数 |delta|≤999 且结果 ≥0，否则 400 `BAD_DELTA | NEGATIVE_STOCK`
- `POST /api/admin/rewards/delete` `{ id }` → `{ ok, id }`；有兑换单引用 → 409 `REWARD_IN_USE` + `refs.orders`

#### 身份（旧接口，仍可用）
- `GET /api/admin/identities?q=` → `{ ok, identities: [ {student_id, name, class, created_at, has_pin, items_n, claims_n, points} ] }`（≤50）
- `POST /api/admin/identities` `{ student_id, name?, class?, reset_pin? }` → `{ ok }`

#### 学生数据库（v2.0，主用）
- `GET /api/admin/students?q=&page=&page_size=&sort=&dir=`
  - `q` ≤50；`page` ≥1；`page_size` ∈ {20,50}（默认 20）；`sort` ∈ {student_id,name,class,points,created_at}（默认 student_id）；`dir` ∈ {asc,desc}
  - 响应：`{ ok, students:[ {student_id,name,class,created_at,has_pin,points,handed_in,returns,claims,active_claims,orders} ], total, page, page_size, pages, query:{q,sort,dir} }`
  - 搜索匹配 学号/姓名/班级（LIKE，`\ % _` 已转义）；`active_claims` 只算未过期
- `GET /api/admin/students/export` → `text/csv; charset=utf-8` + BOM，附件名 `lf-students-YYYY-MM-DD.csv`；固定列 `student_id,name,class,points,returns,created_at`
- `GET /api/admin/students/refs?student_id=` → `{ ok, student_id, name, class, refs:{items,claims,ledger,redemptions}, blocked, summary }`
  - **引用计数里 `ledger` 排除 `reason='initial'`**（初始分不算“使用记录”）
- `POST /api/admin/students` `{ student_id, name, class, pin? }` → 201？**实际返回 200** `{ ok, student:{...} }`；重复学号 409 `STUDENT_EXISTS`；PIN 非法 400 `BAD_PIN`
- `POST /api/admin/students/update` `{ student_id, name?, class? }` → `{ ok, student }`
- `POST /api/admin/students/reset-pin` `{ student_id }` 或 `{ student_ids: [..≤100] }` → `{ ok, results:[{student_id,status:'reset'|'not_found'}], reset, missing }`
- `POST /api/admin/students/delete` `{ student_id }` 或 `{ student_ids }` →
  - 单个：`{ ok:true, student_id, deleted:true }`；有引用 → **409 `STUDENT_IN_USE` + `refs` + `summary`**（如 “3 items they reported, 2 claims”）
  - 批量：`{ ok:true, results:[{student_id,status:'deleted'|'blocked'|'not_found'}], deleted, blocked, not_found }`（逐条执行）
  - 删除是事务：先删该学生的 `initial` 流水，再删身份行
- `POST /api/admin/students/bulk` `{ student_ids, action: 'set_class'|'reset_pin', class? }` →
  - `set_class`：`{ ok, class, results, updated, missing }`（class 去空白、≤24，否则 400 `CLASS_REQUIRED|CLASS_TOO_LONG`）
  - `reset_pin`：同 reset-pin
  - 其它 action → 400 `BAD_ACTION`
- `POST /api/admin/students/import` `{ csv, confirm?: boolean }`
  - 限制：CSV ≤200,000 字符（否则 413 `CSV_TOO_LARGE`），≤1000 行（否则 400 `TOO_MANY_ROWS`）
  - 解析：容忍 BOM/CRLF/引号转义/引号内换行；有表头（含 student_id/name/class 任一）按表头取列；否则若是「首列已是 7 位学号」的 3 列文件按无表头处理；否则 400 `CSV_BAD_HEADER`
  - 预览（`confirm` 非 true）：`{ ok, mode:'preview', summary:{total,valid,invalid,create,update}, rows:[{line,student_id,name,class,action:'create'|'update'|'error',error,message}] }`
  - 提交：20 行一批 `INSERT … ON CONFLICT(student_id) DO UPDATE SET name, class`；整批失败则逐行重试；`ensureInitialPointsBatch` 补初始分；响应 `{ ok, mode:'commit', summary:{...,created,updated,failed,applied}, results }`

#### 设置
- `GET /api/admin/settings` → `{ ok, settings:{…}, defaults:{…} }`
- `POST /api/admin/settings` `{ …patch }` → `{ ok, settings }`；逐键校验范围（§4.10），非法 400 `BAD_FIELDS` + `key`

#### 物品
- `GET /api/admin/items?q=&status=` → `{ ok, items:[ {id,code,title,category,location,slot_no,status,value_tier,photo_path,created_at,registered_by,finder_name,finder_class} ] }`（≤100，id DESC）
- `POST /api/admin/items` `{ id, title?, category?, location?, slot_no?, status? }`
  - 编辑字段；改格位时检查冲突 → 409 `SLOT_TAKEN`
  - `status` 只允许 `in_stock`/`voided` 且目标状态受迁移限制（§5.1），否则 409 `BAD_TRANSITION`

#### 流水与审计
- `GET /api/admin/ledger` → `{ ok, ledger:[{id, student_id, student_name, delta, reason, ref_type, ref_id, month_key, created_at}] }`（≤500）
- `GET /api/admin/audit` → `{ ok, audit:[{id, action, target, detail, created_at}] }`（≤100）

### 6.7 Passkey 2FA（`/api/admin/webauthn/*`）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/state` | GET | **无需 token**：`{ ok, enabled, count }` |
| `/register-options` | POST | 需**口令**：`{ ok, challenge, rpId(当前站点 host), rpName:'L&F Admin', userId, excludeCredentials }` |
| `/register` | POST | 需口令：`{ attestationObject, clientDataJSON }` → `{ ok, id }` 或 400（`BAD_CHALLENGE/BAD_ORIGIN/UP_OR_AT_MISSING/RP_MISMATCH/ALG_UNSUPPORTED`） |
| `/login-options` | POST | 需口令：`{ ok, challenge, rpId, allowCredentials }` |
| `/login` | POST | 需口令：`{ id, authenticatorData, clientDataJSON, signature }` → `{ ok, token }`（12h 会话）；失败 403 |

技术细节（重建时必须照做，否则浏览器拒绝或验签失败）：
- RP ID = 当前页面 host（`lf.xiaochangblog.dpdns.org` 或 `lostnfound.ominx.dpdns.org`，两者都在白名单）；origin 协议必须 https 且 host 在白名单内。
- 挑战 32 字节随机，5 分钟过期，**一次性**。
- `clientDataJSON.type` 注册必须 `webauthn.create`、登录 `webauthn.get`。
- authData：rpIdHash = SHA-256(host)；注册要求 flags 同时具备 UP+AT（0x41），登录要求 UP（0x01）。
- COSE 公钥：alg 必须 `-7`（ES256）；转 JWK（P-256, x/y）。
- 断言签名是 **DER（ASN.1）**，而 WebCrypto `verify` 要 **P1363（r||s 64 字节）**——必须做 DER→Raw 转换；签名数据 = `authenticatorData || SHA-256(clientDataJSON)`。
- 注册与登录都要求 `ctx.passOk`（口令即第一因子）；会话令牌不能注册新设备。

### 6.8 错误码总表（用于前端映射文案）

| HTTP | 错误码 | 含义 | 用户可见文案（英文，参考实现） |
|---|---|---|---|
| 400 | `BAD_STUDENT_ID` | 学号非 7 位 | Student ID must be 7 digits |
| 400 | `MISSING_FIELDS` | 必填缺失 | Some required fields are missing |
| 400 | `BAD_NAME` / `NAME_REQUIRED` / `CLASS_REQUIRED` | 姓名/班级缺失 | — |
| 400 | `NAME_TOO_LONG` / `CLASS_TOO_LONG` | 超长 | — |
| 400 | `PIN_FORMAT` | PIN 非 4 位 | The PIN has to be four digits. |
| 400 | `NOT_IMAGE` / `TOO_LARGE` | 照片非法/超限 | That file is not a valid image / Photo is over 1MB. |
| 400 | `BAD_FIELDS` | 字段非法（后台） | — |
| 402 | `INSUFFICIENT_POINTS` | 积分不足 | Not enough points |
| 403 | `IDENTITY_NAME_MISMATCH` | 该学号已登记为其他姓名 | This student ID is registered under a different name. Ask the desk to fix it. |
| 403 | `NAME_MISMATCH` | 姓名不匹配 | That name does not match our records. |
| 403 | `PIN_INCORRECT` | PIN 错误 | Wrong PIN. Try again, or ask the desk to reset it. |
| 403 | `FORBIDDEN` | 积分明细校验失败 | Name does not match. Details are hidden. |
| 404 | `NOT_FOUND` / `IDENTITY_NOT_FOUND` / `ITEM_NOT_CLAIMABLE` / `CLAIM_NOT_FOUND` / `REWARD_NOT_FOUND` / `ORDER_NOT_FOUND` | 不存在/不可认领 | — |
| 409 | `CONFLICT` | 出库竞态/重复核销 | This claim was already handed out |
| 409 | `ALREADY_FULFILLED` / `ORDER_CANCELLED` / `NOT_PENDING` | 订单状态不允许 | — |
| 409 | `ALREADY_TIPPED` | 已打赏过 | — |
| 409 | `ALREADY_REVOKED` | 已撤回过积分 | — |
| 409 | `STUDENT_EXISTS` | 学号已存在 | — |
| 409 | `STUDENT_IN_USE` | 学生有引用记录，禁止删除 | This removes … and their PIN. It cannot be undone.（弹层另述） |
| 409 | `REWARD_IN_USE` | 奖品有订单引用 | — |
| 409 | `SLOT_TAKEN` | 格位被占 | That slot is taken |
| 409 | `OUT_OF_STOCK` | 售罄 | Out of stock |
| 410 | `CLAIM_EXPIRED` | 认领过期 | This claim has expired. Please apply again. |
| 413 | `CSV_TOO_LARGE` | CSV 过大 | That file is too big. Import up to 200 KB at a time. |
| 429 | `TOO_MANY_PIN` | PIN 错误过多 | Too many wrong PINs. Wait a few minutes. |
| 429 | `TOO_MANY_ACTIVE` | 活跃认领过多 | You already have three items reserved. Collect them first. |
| 429 | `TOO_MANY_TODAY` | 当日认领超限 | You have reached the daily claim limit. Try again tomorrow. |
| 429 | `TOO_MANY_ATTEMPTS` | 后台失败过多 | Too many attempts. Try again later. |
| 401 | `UNAUTHORIZED` / `NEED_2FA` | 未登录 / 需要 2FA | — |
| 503 | `CODE_RETRY` | 物品码生成冲突（极罕见） | — |
| 507 | `SLOTS_FULL` | 格位全满 | All lockers are full. Please tell the staff. |

---

## 7. 手机网页（PWA，`/`）

### 7.1 外壳结构（`index.html`）

```
<body>
  <nav class="gnav">            ← 仅 ≥1024px 显示：左侧固定 84px 竖栏
    校徽 / Board / Report / Rewards / Idea（内联 SVG 线性图标；Idea 钉在最底部）
  </nav>
  <div class="shell">           ← ≥1024px 时 margin-left:84px
    <header class="topbar">     ← <1024px 显示：L&F 小标 + 右侧 Idea 圆钮 + Shop 胶囊
    <main id="view"></main>     ← 所有路由内容渲染在这里
    <footer class="site-foot">  ← 校名署名 + 三个页脚链接
  </div>
  <nav class="tabbar">          ← <1024px 显示：Board / ＋Report（中央凸起）/ Shop
  <script type="module" src="/js/app.js">
```

- head 必须包含：`theme-color #005EBB`、`description`、manifest、favicon 全套（16/32/48 + apple-touch-icon 180）、`apple-mobile-web-app-title`。
- 品牌位：gnav 顶部与 topbar 左侧显示**校徽**（`/icons/smic-logo.png`，白底圆形衬底）。
- **校徽即回家入口（v2.6.0）**：桌面 `a.gnav-logo[href="#/"]`、手机 `a.logo`。点击时若不在首页 → 回 `#/`；已在首页 → 平滑滚回顶部。
- 底部 tabbar 中央 Report 按钮（v2.6.0）：**只显示「＋」**（54px 圆形），文案 `Report` 放在 `.fab-tip` 气泡里，默认隐形；`@media (hover:hover) and (pointer:fine)` 下悬停 **1 秒**淡入于按钮上方，移开即消失；`hover:none` 设备不显示气泡，无障碍靠 `aria-label="Report"`。
- 正文使用 `<h1>` 语义：首页 hero、登记/商城/详情页各自有 page-title，后台标题。
- **「加建议」入口（v2.7.0）**：桌面 `.gnav-idea`（侧栏最底部，`margin-top:auto` 钉底，悬停/`focus-visible` 浮出 `.idea-tip` 气泡）；手机 `.idea-chip`（顶栏 `#shopChip` 左侧 40px 圆钮）。两者都是 `<button aria-haspopup="dialog">`，点击打开原生 `<dialog id="ideaDialog">` 表单（留言 textarea ≤600、页面下拉、可选联系方式），提交到站内 `POST /api/ideas`；成功显示「Thanks — we have it.」并在 1.2s 后自动关闭，Esc/✕/Cancel 关闭且焦点回到触发按钮。后台 Ideas 标签可查看、按 new/seen 过滤、标记已读、删除（二次确认）。

### 7.2 路由（hash 路由，无需服务端支持）

| hash | 视图 |
|---|---|
| `#/` | 首页（可带 `?cat=` / `?q=` 过滤与搜索） |
| `#/report` | 登记 |
| `#/claim/:id` | 物品详情 + 认领 |
| `#/shop` | 商城（可带 `?sid=` 自动查询） |
| `#/points` | **重定向**到 `#/shop`（保留旧链接） |

**启动顺序（关键）**：`applyStaticTexts()` → `router()` → `flushQueue()`。router 解析 `location.hash || '#/'`，更新 tabbar/gnav 的 `aria-pressed`，然后渲染对应视图。任何 hash 变化都重新渲染（会先清掉倒数计时器）。

### 7.3 首页（`#/`）

渲染顺序与数据来源：

1. **Hero**（`?cat=`/`?q=` 过滤时不显示）
   - 左：kicker（`CAMPUS LOST AND FOUND`）、`<h1>` 主标题、副标题、两个按钮（主按钮「Browse the board」滚动到公示板；次按钮链接 `#/report`）、底部一行小字提示。
   - 右：**格位墙（rack）**——3×2 网格，展示前 6 件在板物品的真实照片（无照片显示分类占位字）；每格右下角显示两位格位号；空格显示「Empty」；头部有「Locker B」标题与「Live」指示；底部一行「more」计数（`slots - 6`）。
   - 格位墙数据来自 `/api/items`（前 6 条）与 `/api/stats`（slots/occupied）。
2. **Impact（Since launch）**——4 个数字块：Items returned / Still on the board / Average return time / Points earned；数据来自 `/api/stats`；数字进入视口时从 0 滚动到目标值（见 §7.8）；平均时长按小时/天自适应（<1h 显示 “under 1h”，<48h 显示 “Nh”，否则 “Nd”）。
3. **How it works**——3 张卡（Report it / It goes on the board / Pick it up and earn points）。
4. **公示板**
   - 标题「On the board」+ 计数（“{n} items”）+ **搜索框**（form 提交，写入 `?q=`，最多 40 字符；有 q 时显示 Clear 链接）+ 分类 chips（All + 五类）。
   - 网格：手机单列 / ≥768 双列 / ≥1024 三列；每张卡 = 图片窗（有照片用照片，无照片用分类字形）+ 格位牌（两位格位号，压在图片右下）+ 分类 + 时间（“Nh ago” 相对时间）+ 标题（clamp 2 行）+ 描述（clamp 2 行）+ 地点 + 状态徽章。
   - 卡片链接到 `#/claim/:id`。
   - ≥1024px 时右侧有 aside 卡：「My points」+ 学号输入 + Look up 按钮（跳 `#/shop?sid=`）。
   - 空态：无物品时显示 `empty_home`；搜索无结果显示 “Nothing matches “{q}”…”。
5. **Recently returned（成果墙）**——数据来自 `/api/reunited`：每行 = 分类字形 + 标题 + “back in Nh/Nd”；无数据显示空态。
6. 载入中先渲染**骨架屏**（6 张卡占位 + shimmer），数据到达后替换。

### 7.4 登记（`#/report`）

- 标题 + 副标题（“Anything you hand in gets a locker number and goes on the board right away.”）。
- **Step 1 · Photo（可选）**：
  - 自定义文件按钮（真实 `<input type=file>` 用 `.visually-hidden` 隐藏，`<label class="btn btn-ghost">Add a photo</label>` 触发；选中后变 “Change photo” 并显示缩略图预览）。
  - **No photo 开关**：点击切换 `aria-pressed`，文案变 “No photo chosen (−2 pts on return)”，同时禁用文件输入；再点取消。下方说明「可以不上传照片，该件归还时少 2 分」。
  - 图片处理失败（`sanitize` 抛错）→ 明确报错（“That photo could not be read…”），**不得静默丢图**。
- **Step 2 · Item details**：Item name（≤40）、Category（下拉）、Where you found it（≤30，placeholder “e.g. 7B” 只用于班级字段——地点无固定示例）、Short description（≤80）、A detail only the owner would know（≤60，可选）。
- **Step 3 · Your details**：学号（7 位）、姓名（≤20）、班级（≤10，placeholder `e.g. 7B`）。
- 提交按钮 “Report item”。成功 → **完成票券**：票据头（“Registered. Put it in the slot.” + 物品码）、大号格位号（两位补零）、说明 + 穿孔线 + 脚注、底部「Back to the board」按钮。
- **离线**：`navigator.onLine === false` 时不发请求，把 `FormData` 条目写入 IndexedDB `queue`，显示 “You are offline. The report is saved and will be sent when you are back online.”。联网后（启动/`online` 事件/页面回前台）自动重放；成功提示 “Sent {n} saved report(s). Thanks.”。

### 7.5 物品详情与认领（`#/claim/:id`）

- 顶部「← Back to the board」返回链接。
- **两栏布局**（手机纵向、≥768 横排）：左列大图（或分类字形占位 + “Item photo” 说明），右列：
  - 元信息行：格位牌（Slot NN）+ 状态徽章 + 相对时间
  - `<h1>` 标题 + 描述
  - 详情列表：Category（高价值标注 “High value”）/ Found at / Intake date / Registered by（拾获者姓名 + 班级）
- 若 `status === 'in_stock'` → 下方认领卡：
  - 提示语（“The item is reserved for you. Collect it at the desk with your student ID and name.”）
  - 表单：Answer the verification question（必填 ≤80）、学号（必填 7 位）、姓名、班级、**PIN（必填 4 位，附“第一次？设置一个四位 PIN，以后每次认领/兑换都要用”提示）**
  - 提交 “Submit claim”。
  - **实现注意**：选择器助手必须 `String(sel).replace(/^#/,'')`（曾因把 `#claimMsg` 直接传给 getElementById 导致提交永远 null）。
- 提交成功且 `status==='auto_approved'` → **预留票券**：票据头（“Claim approved” + “RESERVED” 徽章）、正文提示（凭学号+姓名到服务台领取）、穿孔线、**“Pick up by: YYYY-MM-DD”**、返回链接。
- 物品不可认领（404/已下板）→ 错误卡（“Item not found, or not available to claim”）+ 返回按钮（按钮与卡片间距 16px，不得贴着）。

### 7.6 商城（`#/shop`）

- 标题 + 副标题。
- **身份卡**：学号（可预填 `?sid=`）、姓名（“Name used at registration”）、**PIN**（4 位，附提示）、Check balance 按钮；三个输入框均支持 Enter 提交。
- 校验规则（`checkShopIdentity`）：学号必须 7 位；姓名与 PIN **至少要填一个**（否则提示 “Enter your student ID, plus your name or PIN, then check your balance.”）。
- 查询接口：`/api/points/:sid?name=&pin=`（姓名优先，只填 PIN 走 PIN 校验）。
- 校验通过后渲染：
  1. **余额卡**：Balance 大数字 + Returns 次数（两列）。
  2. **积分明细**：最近 50 条，`reason` 映射文案（Return reward / Tip received / Tip sent / Redemption / Admin adjust / Reversed / **Starting balance**）+ 日期 + 带符号分值。
  3. **我的兑换**：最近 20 条（奖品名 + 消耗 + 状态 Pending/Fulfilled/Cancelled）。
  4. **奖品网格**：手机 2 列 / ≥768 3 列 / ≥1024 4 列；每卡 = 图标块（emoji，无则 🎁）、名称、价格、剩余库存、可选 “Need N” 提示、兑换按钮。
- **兑换解锁逻辑**：未校验身份时按钮全部禁用并显示 “Check your balance first to unlock redeeming.”；校验后按库存/余额启用；售罄显示 “Sold out”。
- **兑换**（`redeemReward`）：本地先校验 PIN 4 位（否则报 “Enter your 4-digit PIN to redeem. First time? It becomes your PIN.” 并聚焦 PIN 框）；POST 后成功渲染订单票券（票据头 “Redemption order #id”、奖品名、Pending、穿孔线、“Show this at the desk to collect your reward.”），并刷新身份/余额/明细。
- 失败：402 余额不足、409 售罄、403 姓名/PIN 错误、404 奖品下架。

### 7.7 离线队列（IndexedDB）

库名 `lf`，版本 1，两个 store：
- `drafts`（预留，未使用）
- `queue`（keyPath `id` autoIncrement）——元素形状 `{ id, url:'/api/report', body: [[key,value],…] }`（`value` 可能是 `File`，IndexedDB 原生支持）

重放策略（`flushQueue`）：
1. 仅在线时执行；启动时、`online` 事件、`visibilitychange`（变为可见）时触发。
2. 逐条重建 `FormData` 并 POST；`200 ok` → 删除该条并计数；`4xx` → 视为永久失败删除（避免卡死队列）；`5xx`/网络异常 → 中断本轮，保留剩余条目。
3. 有成功发送 → toast 提示并在首页时自动刷新。

### 7.8 动效规范（v2.1，主站专用；Kiosk 不加）

**Token**：
```css
--ease-out: cubic-bezier(.22,.72,.2,1);
--ease-in-out: cubic-bezier(.5,0,.3,1);
--dur-fast: 150ms; --dur-base: 220ms; --dur-slow: 420ms;
```

**规则**
1. 只动 `transform` / `opacity` / 颜色；**禁止**动 `padding/width/top`（会造成布局抖动）。
2. 按压反馈：`button:active { transform: scale(.975) }`，且特异性必须压过 hover。
3. 悬停位移 ≤3px；触屏必须门控：`@media (hover: none) { …hover 位移回退… }`（保留颜色反馈），否则点按后卡片会一直“浮着”。
4. 滚动进场：JS 给元素加 `.will-reveal` + `--reveal-delay`（阶梯 ≤8×55ms），IntersectionObserver（threshold 0.08，rootMargin 底部 -6%）触发 `.is-in`；**动画结束后必须移除 `.will-reveal/.is-in`**（否则压住 hover 位移）；兜底：1.6s 后强制 reveal。
5. 数字 count-up：`[data-count]`，easeOutCubic 900ms；`prefers-reduced-motion` 直接显示终值；`dataset.counted=1` 防重复。
6. 路由淡入：`#view.view-enter` 动画 420ms（remove → reflow → add）。
6.1 count-up **不要在启动时先把数字清成 0**：若 rAF 被节流（后台页/低电量/内嵌浏览器），数字会永久停在 0；应由第一帧 tick 自行从 0 开始，rAF 不跑时保留服务端渲染的真实值。
7. **入场 keyframes 只做位移，不做透明度**（`lf-rise` 从 `translateY(10px)` 开始）。原因：页面在 hidden/预渲染时 WebKit 暂停动画，`opacity:0` 起点会导致内容永久不可见。
8. `prefers-reduced-motion: reduce` → 全部动画/过渡关闭，内容直接可见。
9. Kiosk 一律不动效（性能与稳定性优先）。

### 7.9 PWA 与 Service Worker

- **manifest**：`id:"/"`、name/short_name、description、`start_url:"/"`、`scope:"/"`、`display:"standalone"` + `display_override:["standalone","minimal-ui"]`、背景 `#F2F6FB`、主题 `#005EBB`、`lang:"en"`、`orientation:"any"`、categories、icons（16–512 + maskable192/512 + monochrome）、shortcuts（Report / Shop 两个，带 96px 图标）。
- **SW**：缓存名 `lf-v16`；安装时 `skipWaiting()` + 尽力预缓存 SHELL（任一失败不阻断，`c.add(u).catch(()=>null)`）；激活时删旧缓存 + `clients.claim()`；fetch 策略：
  - `/api/*` 直接放行（不缓存个人数据）；
  - `woff2/png/jpg/jpeg/svg/ico` → 缓存优先；
  - 其它（HTML/JS/CSS）→ **网络优先，成功则回写缓存，失败回退缓存**。
- **改任何 `public/` 静态资源后必须 bump `CACHE` 版本**（否则老用户可能长期用旧文件；虽然现在是网络优先，但离线场景仍靠缓存）。

### 7.10 响应式与无障碍基线

- 断点：320 / 375 / 414 / 768 / 1024 / 1194 / 1366；**任何宽度不得出现横向滚动**（`.shell` 上 `overflow-x: clip`）。
- ≥1024：隐藏 bottom tabbar，显示左侧 gnav；`#view` 最大宽 1160 居中。
- 触控目标 ≥44px；页脚链接在移动/桌面都要放大点击区。
- 每个视图一个 `<h1>`；状态用 `aria-pressed`、弹层用原生 `<dialog>`；focus-visible 有 3px 焦点环。
- 表单错误必须就近显示（`.err` 红底卡片），不能只在 console。

---

### 7.11 首次使用引导（v2.6.0）

**目标**：新设备第一次打开主站时，用 4 步聚光介绍关键位置；**同一设备只出现一次**。

- **触发**：仅 `#/` 首页渲染完成后（延迟 700ms）；若 `localStorage['lf_tour_v1'] === 'done'` 直接跳过。深链接（`#/claim/*`、`#/report`、`#/shop`）不打断，之后回到首页再触发。
- **步骤**（动态收集，缺省则跳过该步）：
  1. 公告栏 `.notice-bar`（`notice_on=false` 时不显示此步）
  2. 物品板头部 `#board .board-head`
  3. ＋ 按钮 `.tabbar .fab`
  4. Rewards 标签 `.tabbar [data-route="#/shop"]`
- **视觉**：全屏 `z-index:90` 遮罩层，`box-shadow: 0 0 0 9999px rgba(9,14,20,.58)` 在目标处挖洞（14px 圆角 + 2px 白色描边）；卡片 `z-index:91`，白底圆角 18，含进度条点、标题、一句话说明、`Skip` / `Next`（最后一步文案 `Got it`）。
- **交互**：卡片聚焦（`role=dialog`、`aria-modal=true`）；`Esc` 关闭；`Tab` 焦点锁在卡片按钮间；滚动/缩放实时重算高亮位置；`html.tour-open` 锁定页面滚动；`prefers-reduced-motion` 关闭过渡。
- **记忆**：`Skip` / `Got it` / `Esc` 任一方式关闭 → 写 `localStorage['lf_tour_v1']='done'`，该设备此后永不弹出。清站点数据/换浏览器才会重新出现。
- **隔离**：`kiosk.html` 只加载 `kiosk.js`，不含本模块 → 现场端零影响；`admin.html` 同样不加载。

## 8. Kiosk 现场端（`/kiosk`）

### 8.1 形态

- 目标设备：锁定的 iPad（横屏优先，834×1194 为基准），PWA 全屏（`apple-mobile-web-app-capable`）。
- 竖屏/窄屏（≤820px 或 portrait）自动降级为单列纵向滚动。
- ≥1280px 与 ≥1920px 有两级“大屏增幅”：字号、按钮内边距、格位数字（88px → 128px → 150px）整体放大。
- **不使用动效**，不做 hover 依赖；所有按钮必须有显式点击监听。

### 8.2 六态状态机

```
[idle] ──I found something──▶ [report 1/3] ──Next──▶ 2/3 ──Next──▶ 3/3 ──Submit──▶ [confirm] ──Done──▶ [done]
   │                                                                  
   ├──I lost something──▶ [find] ──选物品+填表──▶ 提交认领 ──▶ [pickup]（当场核销）
   ├──Already approved?──▶ [pickup] ──查询──▶ 选认领──▶ 核销（存证照）──▶ [done]
   └── 任意态的「← Back」/「Back to start」回 [idle]
```

状态切换 = 给对应 `<section class="k-state">` 加 `.is-active`；切换时停止摄像头。

### 8.3 空闲屏（idle）

- 深藏青底（`--color-navy`），白字。
- 顶部：圆形 L&F 徽标 + 标题 “Lost and Found · Service Desk”；右侧网络点（绿/红）+ 实时时钟（HH:MM）。
- 左侧三个 CTA：
  1. 大按钮「I found something / Report it here. Takes about a minute.」（bar 蓝底、白色大图标 📦、箭头）
  2. 大按钮「I lost something / Search the board and claim your item.」（描边款，青色边框）
  3. 小文字按钮「Already approved? Collect it with your student ID and PIN →」
- 右侧 aside：「How it works」三步列表、致谢一行、**二维码块**（`location.origin + '/r'`，本地 `qrcode.js` 生成 SVG；失败静默留空）。

### 8.4 登记三步（report）

**第 1 步（照片）**
- 摄像头实时预览（`getUserMedia` environment、理想 1280 宽）。
- 按钮：Take photo / Retake / **No photo**；下方一行说明「Without a photo the return is worth 2 points less.」
- 未拍照点 Next → 先显示警示条「No photo selected. The return is worth 2 points less.」+ 按钮「Continue without photo」；再点一次才进入第 2 步（**Next 永远可点**，不置灰）。
- 选 No photo → 记 `repNoPhoto=true`，可继续。

**第 2 步（物品信息）**
- Item name（≤40，可空；填了就用，不填用「颜色 + 分类」自动拼标题）；分类 chips（五类）；颜色 chips（Black/White/Blue/Red/Green/Yellow/Pink/Multicolour）；地点 chips（Library/Cafeteria/Gym/Playground/Hallway/Classroom/Restrooms/Main Gate/**Other**）；选 Other 显示输入框（Room / floor / place，≤40）。
- 核验细节输入（可选，≤60，“A detail only the owner would know (optional, never shown publicly)”）。
- 右侧摘要面板实时显示：照片状态 / 标题 / 地点 / 核验细节 / 学号。
- 校验：分类 + 地点（Other 时用输入值）非空才启用 Next。

**第 3 步（身份）**
- 学号（7 位）、姓名、班级（placeholder `e.g. 7B`）；三项齐备才启用 Submit。
- 提交 `POST /api/report`（`via=kiosk`，标题=合成标题，描述=`Reported at the service desk · {地点}`，有照片则附 photo）。
- 成功 → confirm 态：绿色对勾 + “Registered. Place the item in this slot.” + **超大格位号（两位）** + 物品码（`NO. LF-…`）+「Done, the item is in」与「Back to start」。

### 8.5 查询与认领（find → pickup）

- find 态：左列公示板列表（每张卡 = 缩略图/分类字形 + 标题 + 地点 + 日期 + 格位号），选中后右列详情：核验问题（若有）+ 回答输入 + 学号/姓名/班级/**PIN** 输入 + Submit claim。
- 提交 `POST /api/claims` → 成功（auto_approved）后**直接进入 pickup 态**（`handoutEntry`：预填学号/姓名/PIN，展示物品与「Confirm handout and take photo」按钮）。

### 8.6 领取核销（pickup）

- 左列：学号 + 姓名 + PIN + Find my item。
- 查询 `POST /api/kiosk/lookup-claims` → 右列列出该学生的待领认领（可领/待审核/已过期三种标签；不可领的置灰禁用）。
- 选中 → 详情卡（标题、地点、格位号、确认按钮）。
- 点确认 → 启动摄像头浮层（占满屏、深色遮罩）→“Take evidence photo” → 拍摄并 POST multipart 到 `/api/kiosk/fulfill`（带 claim_id/学号/姓名/PIN/照片）。
- 成功 → done 态：文案 “Handed over. Enjoy.”；副文案显示 `+N points`（含 “monthly cap reached…” 提示）或 “finder reached the monthly cap…”；失败按错误码 toast（已出库/已过期/照片过大/PIN 错误等）。
- Cancel 关闭浮层。

### 8.7 错误提示

所有失败以 toast（底部胶囊、深色）展示；错误码 → 文案映射见 §6.8 与 §11。Kiosk 特有：
- 相机不可用 → “No camera. Allow camera access, then try again.”
- 拍不到 → “Could not capture. Try again.”
- 柜满 → “All lockers are full. Please tell the staff.”


---

## 9. 后台（`/admin`）

### 9.1 登录

- 门屏：标题 “Enter admin passphrase”，说明“口令 +（开启 2FA 后）设备生物识别”，密码框，Enter 按钮，错误行。
- 未开启 2FA：填口令 → 校验 `/api/admin/stats` → 进入；口令错误提示 “Wrong passphrase”。
- 已开启 2FA：填口令 → 调 `/api/admin/webauthn/login-options` → 浏览器 `navigator.credentials.get`（Touch ID / Face ID）→ `/login` 换会话令牌（12h）→ 进入；失败提示 “Passkey check failed: …”。
- 会话存放 `sessionStorage('lf_admin')`；任意请求返回 401 `NEED_2FA` 时自动登出（回到门屏并提示“Session expired — sign in again.”）。
- 顶部栏：L&F Admin / STAFF CONSOLE / Sign out。

### 9.2 七个 Tab 的功能矩阵

#### Handouts（出库记录）
| 操作 | 端点 | 说明 |
|---|---|---|
| 列表 | `GET /admin/handouts` | 最近 30 条：物品标题/码/格位、认领人姓名+班级、拾获者、时间、`+N pts`（或 “Points revoked” 徽章）、evidence photo 链接 |
| Revoke points | `POST /admin/points/revoke` | **二次确认弹层**：正文写明“会从拾获者扣回 N 分、物品状态不变、无法撤销”，按钮文案 “Revoke points” |
| Put back on board | `POST /admin/items/reopen` | 仅 `returned` 物品；成功后刷新 |
| Export CSV | 前端生成 | 导出当前列表 |

#### Risk Flags（风险黄标）
| 操作 | 端点 |
|---|---|
| 列表 | `GET /admin/flags`（item 黄标显示 Dismiss + Put back 两个动作） |
| Dismiss | `POST /admin/flags/resolve` |
| Put back | `POST /admin/items/reopen`（非 returned 会 toast 失败原因） |

#### Ideas（建议箱，v2.7.0）
| 操作 | 端点 | 说明 |
|---|---|---|
| 列表 + 计数 | `GET /admin/ideas?status=` | 按 id 倒序；All / New / Seen 三个过滤按钮；行 = 留言、页面、联系方式、时间、`new` 徽章 |
| Mark seen | `POST /admin/ideas/status` | 不可逆但无副作用，**不弹确认**，直接 toast |
| Delete | `POST /admin/ideas/delete` | **二次确认弹层**：正文写明“留言将被移除、无法撤销”，按钮文案 `Delete idea` |

#### Operations（运营）
- **Dashboard**：On display / Reserved / Returned / Active claims 四个数字。
- **Redemption orders**：列表（#id、奖品图标+名、学生名+班级、积分、时间、Pending/Given 徽章）；`pending` 显示 **Mark as given**（`POST /admin/redemptions/fulfill`）与 **Cancel & refund**（`POST /admin/redemptions/cancel`，二次确认，说明退回积分与库存）。
- **Rewards catalog**：每行图标+名、价格、库存、下架徽章；操作 **Edit**（回填表单）、**Hide/Show**（`POST /admin/rewards` 带 active）、**Stock +/−**（`POST /admin/rewards/stock`，弹小输入）、**Delete**（`POST /admin/rewards/delete`，二次确认，有订单引用时 409 并提示条数）；底部表单 Add/Save（Name / Icon / Cost / Stock）。
- **Points adjustment**：学号 + ±points + Apply（`POST /admin/points/adjust`），审计留痕。

#### Students（学生库）
| 区域 | 内容 / 操作 |
|---|---|
| 搜索 | 输入学号/姓名/班级（≤50），提交 `GET /admin/students?q=…` |
| 表格 | 列：勾选、学号、姓名、班级、积分、报失/归还、认领（含活跃）、订单、PIN 状态、创建时间；点击表头排序（`sort`+`dir`） |
| 分页 | 页码 + 每页 20/50（`page`/`page_size`），显示总数与页数 |
| 行操作 | Edit（姓名/班级，`POST /admin/students/update`）、Reset PIN（`POST /admin/students/reset-pin`）、Delete（`POST /admin/students/delete`；有引用 → 弹层列出 “N items they reported, M claims…” 并阻止） |
| 批量栏 | 勾选 ≥1 行出现：Set class（输入班级 → `POST /admin/students/bulk {action:'set_class'}`）、Reset PIN（bulk action `reset_pin`）、Delete selected（二次确认，“Students who still have records are skipped…”） |
| 新增 | 学号 + 姓名 + 班级（+ 可选 PIN）→ `POST /admin/students` |
| 导入 | **Import CSV** 展开面板：说明“表头需要 student_id, name, class；已存在的学号会更新姓名/班级”；可粘贴文本或选 `.csv` 文件；点 Preview → 展示每行 `line / student_id / name / class / action(create|update|error) / message` 与汇总（total/valid/invalid/create/update）；再点 Import 提交 `{confirm:true}`，结果逐行显示 created/updated/failed |
| 导出 | `GET /admin/students/export`（下载 lf-students-YYYY-MM-DD.csv） |

#### Settings（设置）
- **Rules & points**：Locker slots / Pickup TTL (hours) / Active claims per student / Claims per student per day / Points · normal item / Points · high-value item / Monthly points cap / “Snatch” flag (minutes)，Save settings（一次性 POST 全部数值，后端逐键校验）。
- **Announcement banner**：开关 checkbox + 文案 textarea（≤300）+ Save banner。
- **Security · Two-factor（Passkey）**：状态行（开启/关闭 + 已注册数量）；按钮 **Register this device (Touch ID / Face ID)**；说明“开启后光口令进不来；设备丢失需 Cloudflare 层重置”。

#### Manage（管理）
- **Items**：搜索（码/标题）+ 状态筛选（All/in_stock/ready/registered/returned/voided）；每行 = 标题、码、格位、分类、地点、状态徽章、拾获者；操作 Edit（标题/分类/地点/格位，保存时格位冲突 409 “That slot is taken”）、Void（回 `voided`，可从板上撤下）、Restore（`voided → in_stock`）；**Void/Restore 不弹确认**（可逆）。
- **Audit log**：最近 30 条（#id / action / target / detail / 时间）；提供 **Export ledger CSV**（`GET /admin/ledger`）。

### 9.3 弹层与危险操作规范（v2.4）

- 一律用原生 `<dialog>`；**不允许点击遮罩关闭**；Esc 可关。
- 按钮文案必须**说明动作**而不是“是/否”：`Revoke points` / `Delete reward` / `Delete student` / `Delete students` / `Move them` / `Cancel & refund` / `Import`。
- 可逆操作（Void/恢复、黄标 Dismiss）**不弹确认**；不可逆或花钱的（撤回积分、删除、取消退款）**必须弹**，正文写清后果（对象、数量、能否撤销）。
- 成功反馈用 toast（`role="status"`），3 秒自动消失。
- 出错信息必须落在弹层/行内，不允许静默。

### 9.4 CSV 导入（后台最复杂的一块）

- 表头：`student_id,name,class`（大小写/空格/连字符会被归一化）；无表头时仅接受“3 列且首列是 7 位学号”。
- 容错：BOM、CRLF、引号内逗号/换行、`""` 转义、空行/trailing commas。
- 校验错误码：`BAD_STUDENT_ID` / `NAME_REQUIRED` / `NAME_TOO_LONG(40)` / `CLASS_REQUIRED` / `CLASS_TOO_LONG(24)` / `DUPLICATE_IN_CSV`（同一文件重复学号，首次出现为准）。
- 限制：≤1000 行、≤200KB；超限 400/413 并在界面提示。
- 提交：20 行/事务批；某批失败 → 逐行重试；每行结果 status ∈ created/updated/failed。
- 导入的学生**都会补 67 初始分**（幂等）。

---

## 10. 视觉系统

> 基调：**学校在线门户同源的“纸感浅色 + 单一深蓝”**。干净、克制、有印刷物气质；靠排版、留白、票据/格位牌两个签名元素建立识别度。**不要**用多套强调色、渐变滥用、玻璃拟态、emoji 装饰墙。深色模式是“夜间微调”，不是另做一套主题。

### 10.1 色板（唯一来源：`css/tokens.css`）

**浅色（默认）**

| Token | 值 | 用途 |
|---|---|---|
| `--color-accent` | `#00509F` | 主强调：主按钮、选中态、公告条、链接强调 |
| `--color-accent-hover` | `#004C98` | 主按钮 hover |
| `--color-navy` | `#00458A` | 深蓝：票据头、kiosk 空闲底、logo、格位数字 |
| `--color-bar` | `#005EBB` | 中蓝：kiosk 大按钮、gnav 底、主题色（theme-color） |
| `--color-ink` | `#202931` | 正文 |
| `--color-muted` | `#5E6B76` | 次要文字 |
| `--color-rule` | `#D9E2EE` | 分隔线、卡片描边 |
| `--color-paper` | `#F2F6FB` | 页面底色（带蓝的纸感） |
| `--color-surface` | `#FBFDFF` | 卡片/输入框底色（近白） |
| `--color-cyan` | `#CAF0FE` | 亮青点缀（kicker、深底描边、格位墙高光） |
| `--color-cyan-soft` | `#E8F1FB` | 极浅蓝：格位牌底、标签底 |
| `--color-on-brand` | `#FBFDFF` | **品牌色实底上的文字/图标（双模式恒定）** |
| `--color-ok` / `--color-ok-soft` | `#1B7F3B` / `#E7F5EB` | 成功 |
| `--color-warn` / `--color-warn-soft` | `#9A6B00` / `#FBF3DC` | 警示（黄标、无照片提示） |
| `--color-danger` / `--color-danger-soft` | `#B3362B` / `#FBEAE8` | 危险（删除、错误） |

**深色（`@media (prefers-color-scheme: dark)`，仅覆盖 6 个）**

| Token | 值 |
|---|---|
| `--color-paper` | `#141B26` |
| `--color-surface` | `#1B2432` |
| `--color-rule` | `#2C3A4C` |
| `--color-ink` | `#EDF2F8` |
| `--color-muted` | `#9AA8B6` |
| `--color-cyan-soft` | `#16324A` |

**铁律**：`--color-surface` 只用于“卡片/输入框底色”（会翻转）；**任何品牌色实底上的文字/图标必须用 `--color-on-brand`**（不会翻转）。这套双 token 是因为历史上 `surface` 一值两用，导致深色模式 17 处“白字”变隐形。

### 10.2 字体

| 用途 | 字体栈 | 字重 |
|---|---|---|
| UI | `"Lato", -apple-system, "PingFang SC", "Noto Sans SC", sans-serif` | 400 / 700 / 900 |
| 数字/编码/票据 | `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace` | 400 / 600 / 700 |

字号阶梯（参考）：
- Hero H1：`clamp(26px, 4.5vw, 44px)` / 900 / 1.15
- 页面标题 H1：26–30px / 900
- 章节标题 H2（`.sec-h`）：17–19px / 800
- 卡片标题：15px / 700–800
- 正文：15px / 400 / 1.5–1.6
- 次要：13px；微字：11–12.5px（mono 用于编号/统计）
- Kiosk：基础 16–18px，大屏递增到 20px；格位数字 88→150px，按钮文字 16→21px

### 10.3 间距 / 圆角 / 阴影 / 焦点

```css
--space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-6:24px; --space-8:32px;
--radius-card:10px; --radius-btn:8px; --radius-pill:999px;
--shadow-card: 0 6px 18px rgba(0,40,90,.08);
--focus-ring: 0 0 0 3px rgba(0,80,159,.35);
```

### 10.4 组件语言（外观要点，非逐像素）

- **按钮**：`.btn` 基础 `font:700 14px/1; padding:12px 16px; radius:8px; border:none;`；主按钮 = accent 实底 + on-brand 文字；幽灵按钮 = 透明底 + 2px accent 描边 + accent 文字；`.btn` 必须 `inline-flex`（inline 会让 padding 压住上方卡片）。禁用态 opacity .5。
- **卡片**：surface 底 + 1px rule 描边 + 10px 圆角 + 卡片阴影；内边距 12–16px。
- **签名元素 1 · 格位牌（slot plate）**：mono 700 12px、藏青字、`cyan-soft` 底、1px rule 描边、4px 圆角、`2px 8px` 内边距；在卡片图片右下角以“压在图上”的小牌出现。
- **签名元素 2 · 票据（ticket）**：12px 圆角、overflow hidden、顶部深藏青票据头（白字、左右两端信息）、正文区、**穿孔线**（2px 虚线 + 两侧各一个“打孔圆”缺口，用 `::before/::after` 画在 paper 色上）、底部说明。用于：登记完成、认领预留、兑换订单。
- **状态徽章**：pill、600 12px；ok/warn/中性三态。
- **chip**：pill、500 12px、1px 描边；`aria-pressed=true` 时 accent 实底 + on-brand 字。
- **输入框**：100% 宽、10px 12px 内边距、1px rule 描边、8px 圆角、surface 底；focus 时 accent 描边 + 3px 焦点环；`input, textarea, select` 统一。
- **图片窗（thumb）**：3:2 或 1:1 圆角容器；有图 `object-fit:cover`；无图 = 分类色底 + 分类字形（🎧 🪪 🧥 📘 📦，属于功能性占位，允许保留）+ 同名格位牌。
- **格位墙（rack）**：3×2 网格、每格 1:1、白色 10% 覆膜底 + 18% 描边、7px 圆角、格内照片 cover、右下角 mono 格位号；空格显示 “Empty”；整体在 hero 深蓝底上，标题行带一个绿色“Live”圆点。
- **Kiosk 大按钮**：bar 蓝底、白字、14px 圆角、20–26px 内边距、40px 图标、24px 标题、13px 副标题（85% 透明）；描边款透明底 + 3px cyan 边框 + cyan 标题。
- **后台**：更紧凑的 14–15px 字号、表格行 8px 垂直内边距、`.tag` 小徽章、按钮 9px 14px；六个 Tab 按钮用 `aria-pressed` 高亮。

### 10.5 深色模式配方

- 只降“对比面”（纸/卡/描边/青软色 + 正文/次要文字），**色相不变**、品牌蓝原样保留。
- 检查清单（重建时必须自查）：Hero 文本、主按钮文字、票据头、kiosk 空闲屏与 k-big 按钮、gnav 图标、chip 选中态、格位牌文字、公告条 —— 全部在深色下可读。

### 10.6 动效（详见 §7.8）

- 150/220/420ms 三档；ease-out 主用；只动 transform/opacity/颜色；按压 scale(.975)；触屏 hover 门控；reduced-motion 全关；kiosk 零动效；入场 keyframes 不做透明度。

### 10.7 图标与物料

- 导航图标：**内联 SVG 线性图标**（24px 网格、1.8 描边、圆角端点、`currentColor`）：2×2 板格 / 加号方框 / 礼盒。不要用 Unicode 字符（渲染不稳定）。
- 站点标志：**使用学校校徽（SMIC crest）**。母本 `public/icons/smic-logo.png`（160×160，源 `https://www.smicschool.com/wp-content/uploads/2021/12/logo-dark@1x.png`），由它生成 `icons/` 内 16–512 全套 PNG、maskable 192/512、monochrome、`apple-touch-icon-180` 与多尺寸 `favicon.ico`；手机端 gnav/topbar、Kiosk 圆标、后台标题均使用该校徽。功能导航图标（Board/Report/Rewards 线性 SVG）保持独立，不随品牌标志替换。
- 打印物料：
  - `ops/labels.html`：A4 竖版，2 列 × 6 行 = 12 张格位标签（**这是 12 格柜的旧物料；当前格位数 24 时需调整行数/复制两张**）。每张：L&F 小标、超大两位编号、`LOST & FOUND SLOT`、底部一行使用说明；虚线裁切线。
  - `ops/signage.html`：A5 竖版亚克力立牌。深蓝渐变底、圆形白标、`Found something?` 主标题 + `Scan to register · 30 seconds · earn points`、白底二维码（指向 `/r`，可现场改 URL 重新生成）、三步说明、底部“Place next to the L&F drop-off cabinet”。

---

## 11. 文案规范（tone of voice）

**必须**：人工口吻英文、短句、具体名词、动词开头；像学校服务台工作人员说话。
**禁止**：营销形容词（seamless / robust / leverage / unlock）、堆叠破折号、emoji 当装饰（功能性分类字形除外）、感叹号连用、模板腔（“Get started today!”）。

**关键文案表（英文原文）**

| 位置 | 文案 |
|---|---|
| 首页 kicker | `Campus lost and found` |
| 首页 H1 | `Lost something? It may already be at the desk.` |
| 首页副标题 | `Anything handed in on campus gets a locker number and shows up here. Find your item, claim it, and pick it up at the desk.` |
| Hero 主按钮 / 次按钮 | `Browse the board` / `Report` |
| Hero 小字 | `Found something? Report it here, or at the desk kiosk.` |
| Impact 标题 | `Since launch`（块标题：Items returned / Still on the board / Average return time / Points earned；副文案：back with their owner / waiting for a claim / from intake to pickup / by students who handed things in） |
| How it works | `How it works`；三步：`Report it` / `It goes on the board` / `Pick it up and earn points` |
| 公示板 | `On the board` / `{n} items` / `Search an item or a place` / `Search` / `Clear` / `Nothing matches “{q}”. Try a broader word.` |
| 侧栏查询 | `My points` / `Enter your 7-digit student ID` / `Look up` |
| 最近归还 | `Recently returned` / `Each line is an item that went back to its owner.` / `Nothing has been returned yet.` / `back in {n} h` |
| 登记页 | `Report a found item` / `Anything you hand in gets a locker number and goes on the board right away.` / `Step 1. Photo (optional)` / `Add a photo` / `Change photo` / `No photo` / `You can report without a photo. The return is then worth 2 points less.` / `Report item` |
| 登记完成 | `Registered. Put it in the slot.` / `Place the item in the numbered slot above. It is already on the board.` / `Points go to your student ID once someone claims and picks it up.` |
| 认领 | `Verification` / `Answer the verification question *` / `Submit claim` / `Claim approved` / `The item is reserved for you. Collect it at the desk with your student ID and name.` / `Pick up by` |
| PIN 提示 | `PIN (4 digits)` / `First time? Pick four digits you will remember. You enter this PIN whenever you claim or redeem something.` |
| 商城 | `Rewards` / `Points you earn from returned items are spent here. Orders wait at the desk until staff hand the item over.` / `Balance` / `Returns` / `Check balance` / `Redeem` / `Sold out` / `left` / `Check your balance first to unlock redeeming.` / `Enter your 4-digit PIN to redeem. First time? It becomes your PIN.` / `My orders` / `Order created` 票券 |
| 页脚 | `Campus Lost and Found`（**技术署名行已移除，正式使用不暴露实现细节**） |
| Kiosk 空闲 | `Lost and Found · Service Desk` / `I found something` / `Report it here. Takes about a minute.` / `I lost something` / `Search the board and claim your item.` / `Already approved? Collect it with your student ID and PIN →` / `Open the board on your phone` / `Scan the code. No app needed.` |
| Kiosk 完成 | `Checked in. Thank you.` / `The item is on the board now. Points are credited once it is claimed and picked up.` / `Handed over. Enjoy.` |
| 后台门屏 | `Enter admin passphrase` / `STAFF CONSOLE` / `Sign out` |

> 完整词表见 `public/js/i18n-inline.js`（单一来源，200+ 键，按“身份与 PIN / 商城 / 状态与分类 / 登记 / 认领 / 积分 / Kiosk / 首页 / 数据与检索 / 时间与隔行”分组，键名前缀：`err_` 错误、`k_` Kiosk、`status_`/`cat_`/`reason_`/`redeem_status_` 动态拼接）。新增 UI 文案必须进字典，不得硬编码。

---

## 12. 内容红线与公告

- **产品交付物（PPT / 文档 / 截图）中不得出现竞选 / StuCo / election / campaign 字眼**（这是学校官方产品）。
- **唯一例外（业主明确指示）**：线上公告条 `settings.notice` 由业主本人放置竞选动员文案（当前 `Welcome to the STUCO election! Vote Charles Chen and Loic Ding!`，`notice_on=1`）。**不要擅自关闭或清空**；需要修改先问业主。
- 真实学生姓名/学号/PIN 不得出现在截图、文档、演示物料；演示一律用本地 `seed.sql` 数据。

---

## 13. 运维手册

### 13.1 首次部署（线上）

1. `npx wrangler d1 create lostfound` → 把 `database_id` 填进 `wrangler.jsonc`。
2. `npx wrangler deploy`（首发布也可用 Workers Builds 连接 GitHub 自动构建）。
3. 建表：`npx wrangler d1 execute lostfound --remote --file=./schema.sql`；演示数据可选 `--file=./seed.sql`。
4. `npx wrangler secret put ADMIN_TOKEN`（口令，示例 `admin2026`）。
5. 验收：`curl https://<域名>/api/stats` 返回 `{"ok":true,...}`；`/admin` 能登录；`/kiosk` 能起摄像头。
6. 绑定域名（可选）：Workers → Custom Domains 添加；短链 `/r` 无需额外配置。

### 13.2 日常操作（后台）

| 场景 | 操作 |
|---|---|
| 调整格位数 / 时限 / 上限 / 积分值 | Settings → Rules & points → Save（实时生效） |
| 发公告 | Settings → Announcement banner（≤300 字）→ Save |
| 学生忘 PIN | Students → Reset PIN（单个/批量）；或 Manage 旧接口 |
| 学生改名/班级 | Students → Edit；CSV 导入也会更新姓名/班级 |
| 批量建号 | Students → Import CSV（先 Preview 再 Import） |
| 学生毕业/离开 | Students → Delete（有引用会被拦并列出条数；先处理物品/认领/订单） |
| 商品补货 | Operations → Rewards → Stock +/−（不会低于 0） |
| 订单退款 | Operations → Redemption orders → Cancel & refund（库存+1、积分退回、幂等） |
| 物品下架 | Manage → Items → Void（可 Restore） |
| 抽查冒领 | Handouts → 查看存证照 → Revoke points / Put back on board |
| 看异常 | Risk Flags（秒领/抢领信号）→ Dismiss 或 Put back |
| 审计追溯 | Manage → Audit log（最近 30 条），需要更全用 `/api/admin/ledger` 导出 |

### 13.3 备份

- D1 导出：`npx wrangler d1 export lostfound --remote --output=backup-$(date +%F).sql`（定期执行；大表含照片 BLOB，注意体积）。
- 照片若落 D1（未启用 R2）：备份必须包含 `photos` 表字节。
- 部署前打 git tag；回滚 = `wrangler rollback` 或重新部署旧 tag。

### 13.4 故障排查（从 AGENTS.md 提炼的 18 条坑，重建/维护必读）

1. `getElementById` **不能带 `#`** —— 页面内选择器助手必须 `String(s).replace(/^#/, '')`；否则提交按钮永远 null。
2. `.btn` 必须 `inline-flex`，否则链接型按钮 padding 会压住上方卡片。
3. `#view` 里独立按钮要有 `margin-top:16px`，否则错误态按钮贴住卡片像重叠。
4. 入场动画禁用 `animation-fill-mode: both` 的“尾帧 transform:none”写法会压住 hover；用 `backwards`（或做完把类摘掉）。
5. `.will-reveal` 必须在动画结束后移除，否则同样压住 hover；兜底定时器也要走 `reveal()`。
6. Kiosk 每个按钮都要显式绑事件（`#repTo3` 曾是从未绑定的死按钮）。
7. 改 `public/` 静态资源必须 bump SW `CACHE`（当前 `lf-v16`）；虽然 fetch 是网络优先，但离线/旧客户端仍靠缓存。
8. 照片一律走 `putPhoto/readPhoto`，**不要再直接 `env.PHOTOS.put`**（R2 未启用时会静默丢图）。
9. 删大段 JS 前先 grep 区间内的函数调用（曾把 `paintQr()` 一起删掉 → 控制台报 `paintQr is not defined`）。
10. 「代码里引用了 id」≠「页面上有这个元素」——商城曾从 `#s_pin` 取值但模板从未渲染它。
11. 原生 `input[type=file]` 不要裸奔（系统语言会显示“选择文件/未选择文件”），用 `.visually-hidden` + label 自定义按钮 + 缩略图。
12. 截图/演示数据不要用生产库（曾把真实学生姓名截进 PPT）。
13. 不要用 PowerShell `-replace` 改源码（曾把中文注释写成乱码并删掉 `SHELL` 常量）。
14. 改 `.dev.vars` 必须重启 `wrangler dev`；后台 401 多半是 `ADMIN_TOKEN` 没加载。
15. `/admin.html`、`/kiosk.html` 会 307 到 `/admin`、`/kiosk`（wrangler 静态资源行为，无感）。
16. `secret put` 的非交互提示（“There doesn’t seem to be a Worker…”）不是报错。
17. 月额度别用净流水算（兑换一次就能“赚回”额度）；必须走 `monthlyEarned()`（只算 `claim_reward + tip_in > 0`）。
18. 新增“每人一笔”的系统流水会牵连删除判定：要么在引用计数里排除（如 `reason <> 'initial'`），要么随主体一起删除。

其余常见问题：
- **部署偶发 `fetch failed` / `D1_RESET_DO`**：网络抖动，**重试 2–5 次**。
- **改了 JS 但手机没变化**：确认 SW 缓存版本已升；iOS 可“移除网站数据”后重开。
- **kiosk 摄像头黑屏**：Safari 需用户手势触发 `getUserMedia`；确认 iPad 设置里允许相机、页面通过 https 打开。
- **后台 2FA 设备丢失**：只能走 Cloudflare 层清理 `webauthn_creds`（或先重置 `ADMIN_TOKEN` 之外的手段都不行——口令+2FA 设计如此）。

---

## 14. 验收清单（重建完成的标准）

### 14.1 自动化

```bash
node --test --experimental-test-isolation=none tests/*.test.js
# 期望：106 pass / 0 fail（本版本基线）
```
覆盖域：公开接口字段白名单、登记/分格/507、认领全链路（含劫持防护/PIN/防刷）、出库乐观锁与积分结算（含无照片扣分与月额度）、兑换（身份/库存/超卖）、打赏三限、学生库（CSV 解析/排序/删除判定/导入预览）、订单（核销/退款幂等/库存）、照片（D1 兜底/非法路径）、Passkey（真签名验签+拒绝路径）、DOM 选择器回归、schema 表清单。

### 14.2 手工（逐页）

1. 首页：直接打开根地址即渲染（无需点导航）；Hero 格位墙有真实照片；Impact 数字与 `/api/stats` 一致；搜索 + 分类过滤正常；「Recently returned」有数据。
2. 登记：选照片出预览；选 No photo 按钮变文案并能提交；成功后票据显示格位号；断网提交 → 入队提示，恢复网络自动补发并 toast。
3. 认领：从卡片进入详情 → 填表（含 PIN）→ 提交 → 出预留票券（不含任何码）→ 物品从板上消失。
4. 商城：不查余额时兑换按钮禁用；查余额（姓名或 PIN）→ 余额/明细/订单显示；兑换需 PIN，成功出订单票券。
5. Kiosk：idle → 登记三步（无照片警示、物品名、地点 Other）→ confirm 大格位号 → done；find → 认领 → pickup → 存证照 → done 显示积分；二维码可扫。
6. 后台：口令登录；六 Tab 切换；撤回积分弹二次确认；学生 CSV 导入先 Preview 后 Import；订单取消退款后库存与积分核对；Settings 改格位数后新登记用新格位数。
7. 照片：带图登记后详情页能显示；`curl -I /api/photos/<path>` 返回 200 + image/*。
8. 断点：320/375/414/768/1024/1194/1366 无横向滚动；深色模式下 Hero/按钮/票据/Kiosk 均可读；控制台零报错。

---

## 15. 已知取舍与后续可做

**已知取舍**
- 领取是“自助 + 学号姓名 PIN”，不做人工审批（全凭自觉）；风险靠黄标 + 出库存证 + 后台干预兜底。
- `verify_answer` 只存档不自动比对（历史遗留的“核验”UI 文案仍有轻微残留）。
- 打赏月额度上限硬编码 100（不随 Settings 的 month_cap 变）。
- `settings.DEFAULTS.slots=12` 与 `publicStats` 默认 24 不一致，靠 seed 写 24 规避。
- 照片存在 D1 BLOB（未启用 R2 时），查询成本高于 R2；启用 R2 后自动切换。
- 后台无“多管理员/角色”体系：一个口令（+可选 2FA），审计只记录动作不记录操作者身份（可扩展）。
- 旧身份接口 `/api/admin/identities` 与新的 `/students` 并存（前者保留兼容）。

**后续可做**
- 将 `redeemCore` 的姓名要求与“只填 PIN 查询”的体验统一（或明确提示“兑换需姓名+PIN”）。
- 把 `tip` 的上限改为读 `settings.month_cap`。
- 学生库分页/搜索加索引优化；照片迁 R2 + 清理策略。
- Kiosk 加“已放入”的自动确认（如 NFC/重量），减少一步点击。
- 运营报表（按周导出）与管理员账号体系。

---

## 附录 A：API 速查（按路径字母序）

```
GET  /r
GET  /api/items
GET  /api/items/:id
POST /api/report
POST /api/claims
POST /api/kiosk/lookup-claims
POST /api/kiosk/fulfill
GET  /api/points/:sid
POST /api/tips
POST /api/redemptions
POST /api/ideas
GET  /api/rewards
GET  /api/site
GET  /api/stats
GET  /api/reunited
GET  /api/photos/*
GET  /api/admin/flags                POST /api/admin/flags/resolve
GET  /api/admin/ideas                POST /api/admin/ideas/status        POST /api/admin/ideas/delete
GET  /api/admin/stats
GET  /api/admin/handouts             POST /api/admin/points/revoke
POST /api/admin/items/reopen         GET  /api/admin/items            POST /api/admin/items
POST /api/admin/points/adjust
GET  /api/admin/redemptions          POST /api/admin/redemptions/fulfill   POST /api/admin/redemptions/cancel
GET  /api/admin/rewards              POST /api/admin/rewards          POST /api/admin/rewards/stock   POST /api/admin/rewards/delete
GET  /api/admin/identities           POST /api/admin/identities
GET  /api/admin/students             POST /api/admin/students
GET  /api/admin/students/export
GET  /api/admin/students/refs
POST /api/admin/students/update      POST /api/admin/students/reset-pin
POST /api/admin/students/delete      POST /api/admin/students/bulk
POST /api/admin/students/import
GET  /api/admin/settings             POST /api/admin/settings
GET  /api/admin/ledger
GET  /api/admin/audit
GET  /api/admin/webauthn/state
POST /api/admin/webauthn/register-options   POST /api/admin/webauthn/register
POST /api/admin/webauthn/login-options      POST /api/admin/webauthn/login
```

## 附录 B：重建自检（文件级）

- [ ] `schema.sql` 能一次建出 13 张表 + 全部索引（含两个唯一索引）
- [ ] `seed.sql` 写入 3 个 demo 身份、6 个奖品、14 件在板 + 4 件已归还物品、settings（slots=24 等）
- [ ] `src/worker.js` 路由表与附录 A 完全一致，未匹配 → 404 JSON，异常 → 500 JSON
- [ ] `cron */5` 触发 `settleFreeze`（返回 released/approved/reviewed）
- [ ] 手机端三视图 + 商城 + 票据 + 骨架屏 + 动效层 + 离线队列
- [ ] Kiosk 六态 + 无照片路径 + 物品名/地点 Other + 二维码 + 无动效
- [ ] 后台六 Tab + 学生库（导入/导出/批量/受保护删除）+ 订单闭环 + 2FA + 审计
- [ ] 深色模式 6 个 token 覆盖、品牌实底文字用 `--color-on-brand`
- [ ] SW `lf-v16` 策略正确（API 直通、图片缓存优先、其余网络优先）
- [ ] `node --test --experimental-test-isolation=none tests/*.test.js` → 106 pass
