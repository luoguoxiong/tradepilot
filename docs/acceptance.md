# TradePilot AI 最终验收留档（12 条场景）

依据 `docs/PRD.md` §4 的 12 条最终验收场景逐条执行留档。
执行环境：本机开发部署（macOS / Node 22.19.0 / docker postgres+redis / API :3020 / Web :5173），演示账号 `demo@tradepilot.dev`，第三方 Key 全部未配置（Mock 降级主路径）。
执行日期：2026-11-10。浏览器截图见 `docs/screenshots/`。

**结论：12/12 全部通过。**

---

## 场景 1：用户登录系统

- **操作**：未登录直接访问业务接口；再用演示账号在登录页登录。
- **预期**：未登录返回 401；注册/登录成功。
- **实测**：
  - `curl /api/products`（无 Authorization）→ `401`，错误结构 `{error:{code:"UNAUTHENTICATED",...}}`
  - `POST /api/auth/login`（demo@tradepilot.dev）→ `200`，返回 JWT，前端跳转 Dashboard
- **证据**：`docs/screenshots/01-login.png`；阶段 5 集成测试（伪造 token/错误密码/注册重复等 401/403 用例）常驻回归（`npm test` 69/69）。

## 场景 2：创建产品：碳纤维鞋垫

- **操作**：Settings 页添加产品「Carbon Fiber Insoles」，关键词 `carbon fiber insoles, arch support insoles`。
- **预期**：产品出现在产品列表，可被搜索任务引用。
- **实测**：Settings「我的产品」显示该产品；Lead Discovery 表单「关联产品」下拉可选中 `Carbon Fiber Insoles`。
- **证据**：`docs/screenshots/03-settings.png`；seed 预置 `seed-product-carbon-insole`。

## 场景 3：选择美国作为目标市场

- **操作**：Lead Discovery 表单目标国家选 `United States`，提交任务。
- **预期**：搜索任务参数含 country=US。
- **实测**：`GET /api/search-tasks` 最新任务 `params.country = "US"`。
- **证据**：API 响应摘录（2026-11-10）：
  ```json
  {"params":{"limit":10,"country":"US","companyTypes":["Importer","Distributor"],
   "productKeywords":["carbon fiber insoles","arch support insoles"]},"status":"DONE","totalCompanies":10}
  ```

## 场景 4：输入 Importer、Distributor 客户类型

- **操作**：表单企业类型多选 `Importer` + `Distributor`。
- **预期**：搜索任务参数含企业类型。
- **实测**：同上响应 `params.companyTypes = ["Importer","Distributor"]`。
- **证据**：同场景 3。

## 场景 5：系统搜索潜在海外企业

- **操作**：点击「开始自动寻找客户」，观察任务进度轮询。
- **预期**：任务异步执行，进度实时可见，产出企业列表。
- **实测**：任务四步流水线全 DONE（searching/enriching/scoring/emailing），`totalCompanies=10, processedCompanies=10, failedCount=0`；未配置 Serper Key 时前端明示「搜索结果为确定性生成的演示数据」。
- **证据**：`docs/screenshots/04-lead-discovery-task-done.png`；步骤日志落库（task_step_logs）。

## 场景 6：展示企业基本资料

- **操作**：Companies 列表点开任一企业（Pacific Rim Sourcing Group）。
- **预期**：详情字段齐全（名称/官网/国家/简介/主营产品等）。
- **实测**：详情页含官网、企业邮箱、LinkedIn、主营产品、简介（`... [DEMO data]`）、搜索时间。
- **证据**：`docs/screenshots/05-companies.png`（列表）、`docs/screenshots/06-company-detail-score-email.png`（详情）。

## 场景 7：获取采购联系人

- **操作**：查看详情页「采购联系人」；也可点挖掘触发 Apollo（无 Key → Mock）。
- **预期**：联系人列表展示；无真实 API 时明确显示 DEMO 标记。
- **实测**：任务 enrich 步自动产出联系人（Jessica Reed/Purchasing Manager、Sarah Thompson/Sourcing Manager），每条带 `Demo` 徽章与邮箱验证状态。
- **证据**：`docs/screenshots/06-company-detail-score-email.png`。

## 场景 8：分析企业是否有采购需求

- **操作**：查看有海关记录的种子企业（Summit Sports Gear LLC）海关数据与 AI 分析。
- **预期**：海关记录展示 + AI 分析给出采购需求判断。
- **实测**：海关记录 `Carbon fiber arch support insoles / HS 6406.99 / 12,000 pairs / supplier CN / source=demo`；评分 `matchReasons` 含 "7 import record(s) found, indicating real purchasing activity"，`purchaseNeeds` 基于进口记录描述生成。无记录企业则输出 "No import records found yet"，且开发信禁止提及采购历史。
- **证据**：API 响应摘录（customs-records / lead-scores，2026-11-10）。

## 场景 9：给出 0–100 匹配评分

- **操作**：详情页查看 AI 匹配度分析卡（或点「重新评分」）。
- **预期**：评分 + A/B/C/D 等级 + 全部 6 项解释性输出。
- **实测**：搜索企业 65 分/B 级（mock-rules-v1）；种子企业 76 分/B 级；六项输出齐全。总分由代码按 30/25/25/10/10 权重计算，同输入波动=0（单测锁定 `computeWeightedScore`/`gradeOf` 边界 80/79/60/59/40/39）。
- **证据**：`docs/screenshots/06-company-detail-score-email.png`；`server/test/unit.spec.ts`。

## 场景 10：AI 生成英文开发信

- **操作**：详情页邮件卡选择收件人 Jessica Reed，点「生成开发信」。
- **预期**：Subject + Body + Follow-up 1/2，内容含客户企业名与产品关联。
- **实测**（mock-template-v1）：Subject `Carbon Fiber Insoles supply for Pacific Rim Sourcing Group — samples available`；Body 含企业名、产品关键词、卖点与 CTA；Follow-up 1/2 齐全；界面常驻提示「仅草稿，不自动发送」。无采购记录企业版本不含 shipment/import record/purchasing history 等表述（ai.spec 断言）。
- **证据**：`docs/screenshots/06-company-detail-score-email.png`。

## 场景 11：客户与邮件草稿保存到 CRM

- **操作**：任务流水线 emailing 步自动将企业入 CRM（NEW）；也可在列表批量导入。
- **预期**：CRM 列表可见该客户，详情含邮件草稿。
- **实测**：CRM 列表出现搜索产出的企业（状态 NEW，DEMO 徽章）；企业详情页 CRM 面板与草稿卡同页可见；`GET /api/crm/customers` 返回 31 家。
- **证据**：`docs/screenshots/08-crm-list.png`。

## 场景 12：记录跟进并设下次跟进时间

- **操作**：详情页 CRM 面板流转 NEW→QUALIFIED，填写跟进内容「已发送碳纤维鞋垫样品目录与报价单，等待回复」与下次跟进日期 2026-11-17，提交。
- **预期**：跟进时间线更新，Dashboard 待跟进卡片变化。
- **实测**：时间线新增「状态流转 NEW → QUALIFIED」与跟进记录；面板显示「下次跟进：2026/11/17」；`GET /api/crm/summary` 的 `dueFollowUps` 含该客户（Summit Sports Gear LLC，nextFollowUpAt=2026-11-13）；Dashboard 待跟进卡片读取同一汇总接口。
- **证据**：`docs/screenshots/07-crm-panel-followup.png`、`docs/screenshots/02-dashboard.png`。

---

## 回归保障

- `cd server && npm test`：69 用例 / 7 套件全通过（unit 38 + auth/products/companies/tasks/ai/crm 集成 31），测试环境强制确定性 Mock（`test/setup-env.cjs` 置空第三方 Key），不消耗真实配额。
- 双端 `npm run typecheck` 零错误。
- 浏览器全程 console 0 error（favicon 修复后；仅 React Router v7 future flag warning）。

## 范围外（P2，明确不做）

自动邮件发送、邮件回复分析、自动跟进、多 Agent 协作、订阅付费。Email Studio 页面为「待实现」占位（P1+ 增强；MVP 邮件草稿已在企业详情页完成）。
