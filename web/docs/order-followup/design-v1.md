# 前端技术方案：AI 外贸跟单助理（order-followup）design-v1

- 日期：2026-09-04
- 对应 PRD：prod/order-followup/prd.md v1；后端方案：server/docs/order-followup/design-v1.md
- 基线：沿用一期（Vue3 + TS + Element Plus + pinia + vue-router + api/client.ts 统一封装），不引入新框架

## 1. 信息架构与路由

```text
顶栏导航（App.vue 在原 ①②③ 后追加「跟单助理」组）：
④ 异常看板  /anomalies      Anomalies.vue   —— 每日工作入口
⑤ 订单台账  /orders         Orders.vue      —— 列表 + 导入 + 手动录入
   └ 订单详情 /orders/:id    OrderDetail.vue —— 概要/产品行/时间线/单证/邮件
⑥ 设置      /settings       Settings.vue    —— SMTP + 提醒规则
```

router.ts 追加 4 条路由；`document.title` 机制沿用。

## 2. api/client.ts 追加

- 类型：`Order`、`OrderItem`、`OrderEvent`、`OrderDoc`、`OrderMail`、`Anomaly`、`ParsedOrder`（含 per-field confidence）、`MailKind/Knob`。
- 方法：`importOrder(file→base64)`、`createOrder`、`listOrders`、`getOrder`、`updateOrder`、`updateOrderStatus`、`addEvent`、`generateDoc`、`getDocHtmlUrl`、`listAnomalies`、`generateMailDraft`、`updateMail`、`sendMail`、`getSettings`、`saveSettings`、`testSmtp`。
- 沿用统一拦截器（code!==0 弹错）；导入/生成等慢操作依赖 180s 超时。

## 3. 页面设计

### Anomalies.vue（异常看板）
- 顶部 4 张 KPI 卡（按类型计数，红/橙/黄）；下方按类型分组的表格：客户、订单号、金额、交期、异常说明、操作（去处理→详情）。
- 打开页面即实时拉取 /api/anomalies；空态显示「今日无待办异常」。

### Orders.vue（订单台账）
- KPI 卡（总订单/进行中/本周交期/异常数）+ 表格：订单号、客户、金额(币种)、交期+剩余天数徽章、当前节点、异常标记。
- 「导入订单」对话框：el-upload 手动读取文件→base64→api.importOrder→展示解析结果表单（低置信度字段标黄 warning，空字段留白待补）→用户核对修正→「确认入库」调 createOrder(importId)；解析失败提示转手动录入。
- 「手动录入」对话框：同一表单组件（复用 OrderForm 逻辑）。
- 节点标签映射（中文）。

### OrderDetail.vue（订单详情）
- 概要卡：客户/订单号/日期/交期/术语/付款/币种金额/状态 + 编辑按钮（弹窗复用 OrderForm）。
- 产品行 el-table（可编辑行：名称/型号/数量/单位/单价/金额自动算）。
- 时间线 el-timeline：事件节点+日期+备注；顶部「更新进度」按钮（节点下拉+日期+备注）。
- 单证 Tab：生成按钮（PI/Invoice/PL，可展开 overrides 编辑与备注）→ 生成后校验问题若存在则红色列出且不入库（后端 400）；成功列出单证版本列表，点击预览（新窗口打开 /api/docs/:id/html，A4 打印样式，浏览器打印成 PDF）。
- 邮件 Tab：「生成进度邮件/催货函」（选择收件人、语气档）→ 草稿可编辑（subject+textarea）→ 确认发送（二次确认弹窗，PRD 红线）→ 状态徽章（草稿/已发送/失败+错误信息+重发）。
- AI 防重复点击：所有生成按钮 loading 态。

### Settings.vue
- SMTP 表单（host/port/secure/user/授权码 write-only/发件人显示名）+「测试连接」；提示授权码而非登录密码。
- 提醒规则表单（days_before 多选、deposit_days、stalled_days、scan_interval_min）。

## 4. 交互红线落地

- 解析结果必须经「确认入库」才进订单库（前端强制走两步对话框）。
- 邮件发送前必有 elMessageBox.confirm 二次确认。
- 单证校验失败时后端阻断，前端展示 issues 清单并引导修正订单数据。
- SMTP 密码仅写入不回显（后端不下发）。
