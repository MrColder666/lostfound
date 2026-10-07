# L&F 失物招领系统 · 部署指南

> 目标架构：Cloudflare Workers + D1（+ 可选 R2 照片存储）。与 SEC 官网同一套部署思路：**推 GitHub → Workers Builds 自动构建上线**。

## 0. 前置

- GitHub 仓库已推送（`main` 分支）
- Cloudflare 账号

## 1. 创建 D1 数据库

Dashboard → Storage & Databases → **D1** → Create（名称 `lostfound`）→ 复制 `database_id`。

```bash
# 或用 API/wrangler（在任何有 node 的机器上）：
npx wrangler d1 create lostfound
```

把 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`（替换 `TO_BE_CREATED_ON_FIRST_DEPLOY`），提交推送。

## 2. 连接 Workers Builds

Dashboard → Workers & Pages → **Create** → 选择「连接 Git 仓库」→ 选本仓库 `main` 分支：

- **Build command**：`npx wrangler deploy`
- 其余默认（wrangler.jsonc 已声明 main/绑定/ASSETS/Cron）

保存后每次 push `main` 自动上线。

## 3. 初始化数据库表 + 种子数据

部署成功后执行一次（本地任一机器，需要 `CLOUDFLARE_API_TOKEN`）：

```bash
npx wrangler d1 execute lostfound --remote --file=schema.sql
npx wrangler d1 execute lostfound --remote --file=seed.sql   # 可选：演示数据
```

（或在 Dashboard → D1 → lostfound → Console 里粘贴两个文件的内容执行。）

## 4. Secrets

Dashboard → 对应 Worker → Settings → Variables and Secrets：

- `ADMIN_TOKEN`：后台口令（自定强口令）—— /admin 登录用
- 可选覆盖默认参数：`SLOT_COUNT`(12) / `FREEZE_MINUTES`(60) / `DROP_TTL_MINUTES`(15) / `PICKUP_TTL_HOURS`(48)

## 5. 照片存储（推荐，可选）

照片走 `env.PHOTOS`（R2 绑定）。未绑定时：上传被拒（登记可选照片会失败）或照片不可回显。

```bash
npx wrangler r2 bucket create lostfound-photos
```

然后在 wrangler.jsonc 追加并推送：

```jsonc
"r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "lostfound-photos" }]
```

## 6. 部署后验收清单（§14）

- [ ] `GET /api/items` 返回 `{ok:true}`；响应中搜不到任何学号 / `verify_a`
- [ ] 手机端：登记（拍照+核验细节）→ 拿到凭证码 → iPad 确认入库 → 大字格号
- [ ] 手机端：认领（答核验）→ 冷冻期提示 / 认领券领取码 → iPad 核销出库（拍照存证）→ 积分到账
- [ ] iPad 直办：登记→格号→已放入 全程 ≤2 分钟
- [ ] 后台 /admin：口令登录 → 复核队列通过一条 → 领取码可核销
- [ ] 重复核销 → 409；伪造图片上传 → 400；错误口令 → 401
- [ ] 7 断点截图（320/375/414/768/1024/1194/1366）无横向滚动
- [ ] Cron：`*/5 * * * *` 已在 Worker 的 Triggers 里生效（冷冻期结算）

## 7. 运营

- 管理团队每周看一次 /admin（复核队列 / 黄标 / 兑换订单）
- 物品 30 天未认领 → 列表标记「即将过期」；学期末统一捐赠并归档
- 现场物料：`public/ops/labels.html`（12 格位标签）、`public/ops/signage.html`（A5 引导牌）——浏览器打开后直接打印
