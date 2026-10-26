# AGENTS.md — L&F 校园失物招领系统

> 面向后续接手这个仓库的 AI agent / 开发者。**改任何东西前先读完 §6 已知坑。**
> 最后更新：2026-10-26 · 版本 v2.2.0

---

## 1. 这是什么

一套校园失物招领闭环系统，三个端共用一个 Cloudflare Worker + D1 数据库：

| 端 | 入口 | 用途 |
|---|---|---|
| 手机网页（PWA） | `/` | 公示板、登记拾获、认领、积分商城 |
| 服务台一体机 | `/kiosk` | 现场登记 / 查询认领 / 核销出库（锁定 iPad 横屏） |
| 后台 | `/admin` | 出库记录、风险黄标、订单、参数设置、物品与学生管理 |

- **线上**：https://lostnfound.ominx.dpdns.org （旧域名 `lf.xiaochangblog.dpdns.org` 仍可用；`workers.dev` 国内不可达）
- **仓库**：本地 `D:\lostfound-work`，git 分支 `main`，远端 `MrColder666/lostfound`
- **技术栈**：Cloudflare Workers + D1(SQLite) + 静态资产（`public/`）；原生 HTML/CSS/JS，**无构建步骤、无框架、无 npm 运行时依赖**
- **PWA**：manifest + Service Worker（`lf-v7`）+ IndexedDB 离线队列

---

## 2. 一分钟上手

```bash
cd D:\lostfound-work
npm install                                            # 只为拿到本地 wrangler
npx wrangler d1 execute lostfound --local --file=./schema.sql
npx wrangler d1 execute lostfound --local --file=./seed.sql
npx wrangler dev --port 8787 --local                   # 必须在本目录启动
node --test --experimental-test-isolation=none tests/*.test.js
npx wrangler deploy                                    # 部署到线上
```

- **`.dev.vars` 必须存在**，内容 `ADMIN_TOKEN=admin2026`（本地后台登录用）。wrangler dev **不监听**该文件，改完必须重启 dev server；不从仓库根目录启动就读不到它。
- 部署偶发 `fetch failed` / `D1_RESET_DO`：**重试 2–5 次**即可通过（网络抖动，不是代码问题）。
- 远程数据库：`npx wrangler d1 execute lostfound --remote --command "..."`；迁移文件放 `migrations/`。

---

## 3. 目录结构与职责

```
src/
  worker.js              路由分发：/api/* → api/*；其余 → ASSETS；Cron 结算冷冻期
  api/
    items.js             公开列表/详情/商城目录/照片/站点公告 + 统计(stats)+最近归还(reunited)
    report.js            登记（一步分配格位，登记即入库）
    claims.js            认领 + 冷冻期结算 settleFreeze
    kiosk.js             身份查询、出库核销、积分结算（completeHandout）
    points.js            积分查询、打赏、兑换（redeemCore 被手机端与后台共用）
    admin.js             后台全部端点（鉴权：X-Admin-Token 或 2FA 会话令牌）
    admin-webauthn.js    Passkey 2FA
  lib/                   纯函数层：points/guard/identity/pin/hash/verify/risk/codes/image/**photo**/settings/student-admin/order-admin
public/
  index.html             手机端外壳（侧边栏 + 底部 tab）
  kiosk.html             一体机六态：idle/report/confirm/find/pickup/done
  admin.html             后台单页（6 Tab，内联样式与脚本）
  css/tokens.css         设计 token 唯一来源（颜色/字体/间距/圆角/阴影）
  css/app.css            主站样式（含 v2.1 动效层）
  css/kiosk.css          Kiosk 样式（**不要在 kiosk 上加动效**）
  js/app.js              主站 hash 路由三视图 + 动效层 initMotion
  js/kiosk.js            一体机状态机
  js/i18n-inline.js      全站英文文案唯一来源
  img/items/             演示物品照片（Pexels 授权，见 LICENSES.md）
  icons/                 全尺寸 App Icon / maskable / maskable / favicon
  sw.js                  Service Worker（网络优先 + 缓存兜底）
schema.sql / seed.sql    本地初始化；migrations/ 放线上迁移
tests/                   node:test 用例（101 个）
```

---

## 4. 数据模型与关键规则

**items 状态机**：`registered → in_stock → claim_pending → ready → returned`（另有 `voided` / `expired`）
**claims 状态**：`pending → in_review / approved / auto_approved → fulfilled / rejected / expired`

- **乐观锁**：所有状态跃迁都是 `UPDATE … WHERE status=旧值` + `changes===1`，否则 409
- **身份**：`identities` 学号首写为准（姓名不匹配 → 403），姓名归一化匹配
- **PIN**：4 位，PBKDF2-SHA256(100k) + 盐；首次使用时设置；错误 10 次/小时限流
- **积分**：普通 10 / 高价值 25（Settings 可调）；**每人每月上限 100**；打赏三限（绑定出库单 / 每单一次 / 计入上限）
- **无照片扣分**：登记时选「暂无图片」的物品，出库结算少 2 分（`PHOTO_PENALTY`，`src/lib/points.js:finalReward`）
- **认领防刷**：活跃 ≤3 / 每日 ≤5（`CLAIM_ACTIVE_CAP` / `CLAIM_DAILY_CAP`）
- **settings 表**：slots / pickup_ttl_hours / claim_active_cap / claim_daily_cap / reward_normal / reward_high / month_cap / snatch_min / notice / notice_on
- **照片**：`photos` 表（BLOB 兜底，见 §6.8）。`items.photo_path` / `claims.evidence_photo_path` 存相对路径（`photos/…`、`evidence/…`），公开端点 `/api/photos/<path>` 回图

---

## 5. 前端约定

- **路由**：hash 路由 `#/` / `#/report` / `#/claim/:id` / `#/shop`；`#/points` 自动跳 `#/shop`
- **文案**：一律走 `t('key')`，词典在 `public/js/i18n-inline.js`；**禁止硬编码中文**，新增 key 必须同时用于 `data-i18n`
- **颜色/字体**：只允许 `var(--*)`，禁止内联 hex（token 在 `tokens.css`）
- **动效纪律**（v2.1 起）：
  - 只动 `transform` / `opacity`，时长 150–420ms，用 `--ease-out`
  - 按压反馈用 `:active` 缩放（`.btn:active { scale(.97) }`）
  - `prefers-reduced-motion: reduce` 下必须整体降级
  - 页面进场用 `.will-reveal` + IntersectionObserver（`initMotion()`），动画结束后自动摘类
  - **Kiosk 不加动效**（硬件性能与稳定性优先，`kiosk.css` 不要引入动效层）

---

## 6. 已知坑（全部踩过，别重复踩）

1. **`getElementById` 不能带 `#`** —— 曾导致认领页 Submit 永远 `null`、请求发不出去。选择器助手必须写成
   `const $ = (s) => document.getElementById(String(s).replace(/^#/, ''))`。`tests/dom-selectors.test.js` 会拦截这类回归。
2. **`.btn` 必须是 `inline-flex`**（`<a class="btn">` 若为 inline，padding 会让盒子向上溢出压住上方卡片）。
3. **`#view` 里独立按钮必须有上边距**：`#view > .btn { margin-top: 16px }` —— 否则错误态/完成态按钮会贴住卡片，视觉上像重叠。
4. **入场动画禁用 `animation-fill-mode: both`**：尾帧 `transform:none` 会永久压住 `:hover` 位移（v2.1 已改成 `backwards`）。
5. **`.will-reveal` 类必须在动画结束后摘除**，否则它同样压住 hover；兜底定时器也要走 `reveal()` 而不是只加 `is-in`。
6. **Kiosk 的每个按钮都要有显式监听**：`#repTo3`（登记第 2 步 Next）从 v1.7.x 起就没绑事件，一直是死按钮。
7. **Service Worker**：改了 `public/` 下的静态资源要升 `sw.js` 的 `CACHE` 版本号（当前 `lf-v7`），否则老用户拿缓存。
8. **照片链路（v2.2.0 已修）**：账户**没有启用 R2**，`env.PHOTOS` 一直是 `undefined`，所以历史上 `env.PHOTOS?.put()` 静默跳过 → 上传 200 但照片 404（用户说的「图片上传不了」）。现在统一走 `src/lib/photo.js`：`putPhoto()` 优先写 R2，未启用就落 D1 的 `photos` 表（BLOB，单张 ≤1.1MB）；`getPhoto()` 两条路都读。**新增照片写入/读取不要再直接碰 `env.PHOTOS`。** 迁移：`migrations/2026-10-26-v2.2.0-photos.sql`。演示图仍是静态 `/img/items/*.jpg`，`photoSrc()` 区分 `/` 开头与相对路径。
9. **删大段 JS 时先 grep 区间内的函数调用**：清理 Kiosk 空闲屏时把 `paintQr()`（扫码进手机版）一起删了 → 控制台 `paintQr is not defined`、二维码空白。删完必须跑一遍页面控制台检查。
10. **截图/演示数据**：不要用生产库截图——曾把真实学生姓名（Jonas Cao）截进 PPT。演示截图一律用本地 `seed.sql` 数据。
11. **不要用 PowerShell `-replace` 改源码文件**：曾把 `sw.js` 的中文注释写成乱码并删掉 `SHELL` 常量。改文件用编辑器/写文件工具。
12. **改 `.dev.vars` 后必须重启 `wrangler dev`**；后台接口 401 多半是 `ADMIN_TOKEN` 没加载。
13. **后台路径**：`/admin.html`、`/kiosk.html` 会被 307 到 `/admin`、`/kiosk`（wrangler 静态资源行为，浏览器无感）。
14. **`secret put` 的非交互提示**（"There doesn't seem to be a Worker…"）不是报错。

---

## 7. 测试与验收

```bash
node --test --experimental-test-isolation=none tests/*.test.js   # 基线：101 pass / 0 fail
```

必须带 `--experimental-test-isolation=none`：默认派生模式在部分环境会「假绿灯」。

改动后的最小验收清单：

1. 上述测试全绿
2. `wrangler dev` 起来后逐页点：首页（分类/搜索/详情/返回）→ 登记（含无照片）→ 认领（提交要真的发 POST）→ 商城（查余额）
3. Kiosk：idle → 登记三步（第 1 步无照片提示、第 2 步物品名/地点 Other、第 3 步提交）→ 完成页无重叠；查询领取页可进；控制台不得出现 `paintQr is not defined` 之类报错
4. 照片：登记时带一张照片 → 详情页应能看到图；`curl -I /api/photos/<path>` 返回 200 + `content-type: image/jpeg`
5. 后台：口令 `admin2026` → 6 个 Tab 可切换 → 学生搜索
6. 移动端 390px：底部 tab 可点、页面无横向滚动

---

## 8. 版本与文档协议

- **每次改动必须 bump 版本**：`package.json` 的 `version` + `CHANGELOG.md` 追加条目（Keep a Changelog 风格，中文）
- 当前版本 **2.2.0**；语义：修复 → patch，新增 → minor，架构/数据迁移 → major
- 线上验证：`curl https://lostnfound.ominx.dpdns.org/api/stats` 应返回 `{"ok":true,...}`
- 有 DB 变更时记得两处：本地 `--local --file=schema.sql`，线上 `--remote --file=migrations/<日期>-v<版本>-<主题>.sql`

---

## 9. 内容红线

- **产品与一切交付物中不得出现竞选 / StuCo / election / campaign 字眼**（这是学校官方产品）
- 文案必须是人工口吻英文：不堆破折号、不用 `seamless / robust / leverage / unlock` 这类词、不用 emoji 当装饰
- 真实学生数据（姓名/学号/PIN）不得出现在截图、文档、演示物料里

---

## 10. 相关资产（不在仓库内）

| 资产 | 位置 |
|---|---|
| 主题演讲 PPT | `D:\OneDrive - Shanghai SMIC Private School\STUCO\StuCo_VP_Keynote_v3.0.pptx`（**已冻结，不要再改**） |
| 演示 GIF / 站点截图 | `D:\OneDrive - Shanghai SMIC Private School\STUCO\L&F_KeynoteAssets\` |
| 截图/GIF/审计工具脚本 | `D:\lf-tools\`（Playwright + Edge，非生产代码，可复用/重跑） |
| 部署交接文档 | `D:\Downloads\HANDOVER (1).md`（历史背景，部分信息已过时） |
