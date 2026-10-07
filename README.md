# L&F 失物招领 · Lost & Found

校园失物招领的完整落地系统：一台锁定的 iPad 跑 PWA 作为现场操作台 + 编号投递柜 + 手机扫码网页。闭环为「捡到 → 登记 → 现场确认入库（动态分配格位）→ 公示 → 冷冻期与核验 → 认领 → 核销出库 → 积分发放」。

- **设计文档**：`docs/superpowers/specs/2026-10-07-lostfound-design.md`（v0.2.0）
- **实现计划**：`docs/superpowers/plans/2026-10-07-lostfound.md`
- **部署指南**：`DEPLOY.md`
- **更新日志**：`CHANGELOG.md`

## 组成

| 端 | 入口 | 说明 |
|---|---|---|
| 手机网页 | `/` | 公示列表 / 登记拾获 / 认领 / 积分与商城（中英双语，响应式 320–1366） |
| iPad PWA | `/kiosk.html` | 现场直办（免打字）、投递确认、核销出库（拍照存证）、兑换 |
| 隐藏后台 | `/admin.html` | 口令进入：复核队列、异常黄标、积分调整、看板 |

## 技术栈

- Cloudflare Workers（API + 静态资产）+ D1 SQLite；可选 R2 存照片
- 原生 HTML/CSS/JS，PWA（manifest + Service Worker），IndexedDB 离线队列
- jsQR（本地 vendor，不依赖 CDN）；照片上传前端 Canvas 重绘去 Exif、后端 Magic Byte 校验
- 核心安全：动态格位分配（15 分钟凭证）· 非公开特征核验 + 1 小时冷冻期 · 全状态乐观锁 · 积分月上限 · 打赏三限

## 本地开发 / 测试

```bash
node --test --experimental-test-isolation=none tests/*.test.js   # 全量测试（iSH/macOS/Linux 通用）
python3 -m http.server --directory public 8123                    # 静态预览（API 需部署或 mock）
```

> 注意：本地 `node --test tests/`（默认派生模式）在 iSH 上会假绿灯，务必带 `--experimental-test-isolation=none`。
