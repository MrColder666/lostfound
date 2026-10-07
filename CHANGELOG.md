# 更新日志

所有对 L&F 项目的变更都会记录在此。格式参考「Keep a Changelog」，版本号递增遵循项目版本管理协议。

## [v1.2.0] - 2026-10-07

### 新增
- **身份领取（免领取码）**：Kiosk 领取改为「输 7 位学号 + 姓名」→ 列出该生可领取 / 审核中的物品 → 确认 → 拍照存证出库，全程无需输入 6 位码
- 新增接口 POST /api/kiosk/lookup-claims：学号 + 姓名双匹配，返回待领取项与状态（**响应中不含任何码**）
- Kiosk 空闲屏新增入口「Already approved? Collect it with your student ID」

### 变更
- POST /api/kiosk/fulfill 支持身份通道（claim_id + student_id + name，服务端双重校验）；**原领取码通道保留**，双通道并存
- 出库尾段抽为 completeHandout()，两条通道共用乐观锁 + 积分结算，避免逻辑分叉
- 认领当场自动通过后**直接进入出库确认**（不再跳输码页）；冷冻期 / 转人工的提示改为「届时凭学号与姓名到服务台领取」
- 手机端认领券文案同步：领取码标签改为「参考编号」，引导语改为到服务台报学号与姓名

### 修复
- src/api/claims.js 认领响应补回 id 字段（身份领取需据其定位认领单）
- Kiosk 拍照存证浮层 .k-evidence 的 display:flex 覆盖了 hidden 属性，导致浮层从进入领取页起就常驻遮屏（补 .k-evidence[hidden]{display:none}，与 .k-rep-pane 同类问题）

## [v1.1.0] - 2026-10-07

### 修复
- 后台 /admin.html：脚本缺失 $$ 选择器定义导致 ReferenceError——「异常黄标 / 运营」标签页与复核「通过 / 拒绝」按钮全部失效（补一行定义即愈）
- Kiosk 注册向导：.k-rep-pane 的 display:flex 覆盖了 hidden 属性，三步内容同时渲染、互相叠压、按钮无法点击（补 .k-rep-pane[hidden]{display:none} + 左栏滚动兜底）
- Service Worker 缓存升级 lf-v1 → lf-v2，激活时清理旧缓存，避免老用户看到过期壳

### 变更
- **全站纯英文**：移除中 / EN 切换按钮，i18n 固定英文（不再读取历史语言偏好）；中文字典保留在代码中备用
- Kiosk 演示种子数据英文化（物品标题/描述/地点、身份姓名、奖品名）
- Kiosk 全部文案重写为英文（静态文案 data-i18n 化 + 动态提示/类别/颜色/地点全部走共享词典），与主站共用 i18n-inline.js 单一来源
- 后台界面英文化（Review Queue / Risk Flags / Operations）

### 新增
- Kiosk 大屏增幅：≥1280px 与 ≥1920px 两档媒体查询，字号/触控目标/间距随视口放大；注册向导与右栏改为弹性铺满（相机 flex:1、按钮与备注沉底），消除大屏底部与右侧空白
- 主站落地页（学校 Canvas 门户同源风格）：左侧 #005EBB 全局导航（Lato，logo 块 #00458A）、hero 区、三步 How it works、错峰入场动画；≤1024px 回退原移动端布局

## [v1.0.1] - 2026-10-07

### 修复
- wrangler.jsonc 填入真实 D1 database_id（此前占位符导致 wrangler deploy 校验失败 10021，Worker 一直未被真正创建）

## [v1.0.0] - 2026-10-07

### 新增
- **完整实现**（对照设计文档 v0.2.0 全部 15 节）：
  - 手机网页：公示列表（筛选/搜索/统计）、登记拾获三步（拍照去 Exif + 非公开特征）、认领申请（核验+冷冻期）、我的积分（学号分级查询）与积分商城
  - iPad PWA：五态 kiosk（空闲/扫码输码/登记直办/认领核验/核销出库），动态分格大字指引，jsQR 本地扫码，出库拍照存证
  - 隐藏后台 /admin.html：复核队列、异常黄标、积分调整、周看板
  - API：/api/items·report·kiosk/*·claims·points·tips·rewards·photos/*·admin/*，全状态乐观锁，Cron 冷冻期结算
  - 设计系统：学校门户同源 tokens（OKLCH hex 基准），Lato + PingFang SC + IBM Plex Mono 自托管，「格位牌 & 认领券」签名元素
- **运维物料**：DEPLOY.md 部署指南、可打印 12 格位标签（ops/labels.html）、A5 引导牌（ops/signage.html）、/r 短链路由

### 修复
- 测试命令改为 `--experimental-test-isolation=none`（iSH 默认派生模式假绿灯）
- 时间字段统一 UTC ISO（冷冻期跨时区解析偏差）
- 认领非法学号返回 400 而非 500

## [v0.2.0] - 2026-10-07

### 新增
- **动态格位分配**：登记只发投递凭证码（不预分配格号）；iPad 确认时才原子分配空闲格号；凭证 15 分钟未确认自动作废，防占格与错放
- **非公开特征核验**：登记强制采集 1 个不公开特征（模板问答 + 可选细节照），认领须答对（归一化模糊匹配）才触发自动通过
- **冷冻期**：入库公示后 1 小时（后台可调 1–2h），期间多人申请自动转人工复核，防秒抢冒领
- **积分查询分级**：学号仅可查总积分 + 贡献次数；明细/历史/兑换需学号+姓名（或预留 PIN）二次校验
- **图片安全**：前端 Canvas 重绘导出抹除 Exif（GPS/设备型号）+ 后端 Magic Byte 校验与 ≤1MB 体积限制
- **离线高可用**：照片 Blob/草稿/队列全面改用 IndexedDB（弃用 5MB 限额的 localStorage）；Background Sync 补发，iOS 降级为 online/visibilitychange 触发
- **并发控制**：全部状态跃迁使用乐观锁（`UPDATE … WHERE status=…` + `changes == 1` 校验，失败返回 409）
- **打赏风控**：打赏绑定已完成的真实出库认领单、每单限一次、计入接收者每人每月 100 分上限

### 变更
- 公示内容排除「非公开核验特征」（其余细节仍全公开）
- 认领人（失主）不在任何公开位置显示，仅管理员可见
- API 表与数据模型同步更新（items 增加 drop_code / detail_photo / verify_* 等字段）
- 物品状态机新增 voided（凭证超时作废）态

## [v0.1.0] - 2026-10-07

### 新增
- 初版设计文档（头脑风暴定稿：双路径闭环 / 积分与防作弊 / 视觉设计系统 / 技术架构 / 硬件部署与运营）
