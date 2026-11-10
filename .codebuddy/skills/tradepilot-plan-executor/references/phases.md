# TradePilot 开发计划：九阶段执行指南

每个阶段包含：目标、交付物、加载的子技能、验收门。执行某阶段前先完整读完该阶段章节。所有阶段都必须遵守 SKILL.md 中的 Hard Rules。

## 阶段总览与子技能映射

| # | 阶段 | 子技能 |
|---|---|---|
| 1 | PRD + 核心业务流程 | spec-driven-development, planning-and-task-breakdown |
| 2 | 系统架构 + 模块划分 | api-and-interface-design, doubt-driven-development |
| 3 | PostgreSQL Schema | api-and-interface-design |
| 4 | 前后端工程 + Docker 环境 | incremental-implementation, context-engineering, ci-cd-and-automation |
| 5 | 核心 API + 前端页面 | frontend-ui-engineering, security-and-hardening, incremental-implementation |
| 6 | AI 客户分析 + 开发信生成 | source-driven-development, performance-optimization |
| 7 | CRM 完整业务闭环 | incremental-implementation, api-and-interface-design |
| 8 | 测试验证 | test-driven-development, browser-testing-with-devtools, debugging-and-error-recovery |
| 9 | README + 部署说明 | documentation-and-adrs, shipping-and-launch |

贯穿全程：git-workflow-and-versioning（阶段提交）、code-review-and-quality（每阶段自查）、observability-and-instrumentation（任务日志与执行记录，从阶段 4 起接入）。

---

## 阶段 1：产品 PRD + 核心业务流程

**目标**：把 `plan.md` 的需求固化为结构化 PRD 文档，拆出 P0/P1/P2 任务清单。

**交付物**：
- `docs/PRD.md` — 含产品定位、用户角色、核心闭环流程图（文字版即可）、六大功能模块的验收标准（从 plan.md 第九节的 12 条演示场景推导）、P0/P1/P2 范围边界
- `docs/tasks.md` — 按 P0 优先级拆出的可执行任务列表，每个任务一行（编号、描述、所属阶段、预估切片数）

**执行要点**：
- 核心闭环只有一条：输入产品 → 搜索企业 → 获取联系人 → 分析匹配度 → 生成开发信 → 保存 CRM。PRD 中所有非闭环功能明确标为 P1/P2，防止范围蔓延。
- 12 条最终验收场景逐条编号写入 PRD，作为阶段 8/9 的验收依据。

**验收门**：
- PRD 覆盖 plan.md 全部六大模块与 AI Agent 设计章节，无遗漏
- 每条验收场景可测试（有明确可观察结果）
- 用户确认 PRD 后才进入阶段 2（此阶段需用户点头）

## 阶段 2：系统架构 + 模块划分

**目标**：输出架构文档，确定技术选型与模块边界。

**交付物**：
- `docs/architecture.md` — 分层图（前端 / API / 服务层 / Adapter 层 / 数据层 / 队列）、模块划分（auth、companies、contacts、customs、ai、crm、tasks、integrations）、Lead Discovery Agent 的任务编排流程（状态机：pending → searching → enriching → scoring → emailing → done/failed，每步可重试可恢复）
- Adapter 接口定义（TypeScript interface）：CompanySearchAdapter、ContactDiscoveryAdapter、CustomsDataAdapter，每个都有 Real 与 Mock 两个实现类的约定
- 选型决策记录（ADR 风格）：NestJS vs Fastify、Prisma vs Drizzle，各一条含理由

**执行要点**：
- MVP 单体优先、模块化分包，不上微服务
- 多租户只做预留（数据表加 tenant_id 列 + 代码注释），不实现租户隔离逻辑
- 异步任务用 BullMQ，任务状态与执行日志表在架构文档中定义

**验收门**：
- Adapter 接口能表达 plan.md 中全部三个第三方数据源的查询需求
- 任务编排状态机覆盖"单个步骤失败后恢复"（plan.md 第三节要求）
- 用户确认架构后进入阶段 3

## 阶段 3：PostgreSQL Schema

**目标**：产出完整、可迁移执行的数据库 Schema。

**交付物**：
- 选定 ORM 后的 schema 文件（Prisma schema 或 Drizzle 定义），覆盖 plan.md 第五节全部 11 张表
- `docker-compose.yml` 中 postgres + redis 服务定义（本阶段即可运行）
- 首次迁移可成功执行（`migrate` 命令跑通）

**执行要点**：
- companies 去重靠域名唯一约束；contacts 靠 (company_id, email) 唯一
- search_tasks / enrichment_tasks 设计为通用任务表 + 步骤日志表，支撑状态机
- 全表 created_at/updated_at；高频查询路径（companies 列表筛选、crm 按状态筛选）建索引
- 预留 tenant_id

**验收门**：
- `docker compose up -d postgres` 后执行迁移成功
- 用脚本插入少量种子数据验证约束（重复插入应报唯一冲突）

## 阶段 4：前后端工程 + Docker 开发环境

**目标**：可启动的空壳应用：前端能打开、后端能响应、数据库已连接、队列已就绪。

**交付物**：
- `server/` — 后端工程（选定的框架）、健康检查接口 `GET /health`、配置加载（.env + zod/joi 校验）、全局错误处理、结构化日志
- `web/` — 前端工程（Vite + React 18 + TS + Tailwind + shadcn/ui 初始化）、基础布局（侧边栏导航：Dashboard/Lead Discovery/Companies/CRM/Email Studio/Settings）、路由骨架
- `docker-compose.yml` 完整版（postgres/redis/server/web 或本地跑 server/web + compose 起基础设施）
- `.env.example` — 全部环境变量及注释（数据库、Redis、LLM、Google/Apollo/海关 API Key 均列出，标注"无 Key 时自动走 Mock"）

**验收门**：
- `docker compose up`（或等价命令）后：前端页面可访问且导航可点击，`GET /health` 返回 200 且包含数据库连通状态
- `tsc --noEmit` 前后端均零错误

## 阶段 5：核心 API + 前端页面（P0 主体）

**目标**：用户登录 + 产品配置 + 企业搜索 + 企业展示跑通（Mock Adapter 优先）。

**交付物**：
- 认证：注册/登录（JWT），密码哈希
- 我方产品 CRUD（products）
- 企业搜索：POST /search-tasks 创建任务 → BullMQ 异步执行 CompanySearchAdapter（Mock）→ 前端实时轮询任务进度 → 企业列表分页展示、去重、收藏、批量导入 CRM
- Companies 列表页 + Company Detail 基础版
- Settings 页：各 Adapter 的 API Key 配置读写（integrations 表）

**执行要点**：
- 按 incremental-implementation 每次只做一个纵向切片（如"创建任务→列表可见"先于"进度实时刷新"）
- 登录相关输入全部走 security-and-hardening 的校验与防注入检查
- Mock 数据必须带 `source: 'demo'` 标记并在前端显示 DEMO 徽章

**验收门**：
- 未登录访问业务接口返回 401
- 演示流程：登录 → 配置产品（碳纤维鞋垫）→ 发起搜索（US + Importer）→ 列表看到企业且带 DEMO 标记
- tsc 零错误；本阶段新增接口的集成测试通过

## 阶段 6：AI 客户匹配分析 + 英文开发信

**目标**：两个 LLM 功能上线：可解释的匹配度评分、个性化开发信生成。

**交付物**：
- LeadScoringTool：输入我方产品 + 企业信息 + 采购记录 + 联系人职位，输出 plan.md 第四节全部 6 项（评分、匹配原因、采购需求、合作机会、开发建议、不确定性说明）；结构化 JSON 输出（zod schema 校验）；A/B/C/D 分级落库
- EmailGenerationTool：生成 Subject + Body + Follow-up 1 + 2；prompt 模板集中管理（`server/src/ai/prompts/`）；支持重新生成
- Company Detail 页集成：AI 分析结果展示、开发信生成/编辑/复制/保存
- LLM 调用层：OpenAI 兼容客户端、超时控制、失败重试、调用成本/Token 用量日志

**执行要点**：
- 评分权重（30/25/25/10/10）在 prompt 与代码中一致；LLM 输出过 zod 校验，校验失败重试一次再降级报错
- 开发信 prompt 中注入"禁止编造客户采购记录、禁止 AI 套话"约束
- 采购记录缺失时评分照常输出，但"不确定性说明"必须注明数据缺失

**验收门**：
- 对同一家企业连续两次评分，分数波动 ≤ 10 且等级一致（稳定性）
- 生成邮件包含客户企业名与产品关联点，无采购记录的企业生成邮件不含伪造采购内容
- 异常注入测试：LLM 返回非法 JSON 时接口不 500，返回结构化错误

## 阶段 7：CRM 完整业务闭环

**目标**：客户从 New 到 Won/Lost 的全生命周期管理 + 跟进时间线 + 导入导出。

**交付物**：
- CRM 客户列表：状态筛选、搜索、分页
- 客户详情：企业信息 + 联系人 + 采购记录 + AI 分析 + 邮件草稿 + 跟进时间线（crm_activities）整合展示
- 状态流转、跟进记录添加、下次跟进时间设置（Dashboard 待跟进卡片）
- CSV 导入导出（companies/contacts）
- P1 项：Apollo 联系人挖掘（ContactDiscoveryAdapter Mock/Real + 手动补充 + 邮箱验证状态）、海关数据查询（CustomsDataAdapter Mock 标注 DEMO）集成进 Company Detail

**验收门**：
- plan.md 第九节 12 条演示场景中 1–7、11、12 全部可现场演示通过
- CSV 导出再导入，数据无损往返

## 阶段 8：测试验证

**目标**：核心闭环有自动化测试兜底，前端关键路径浏览器实测。

**交付物**：
- 后端集成测试：认证、搜索任务流转（含 Mock Adapter）、AI 评分（LLM 走录制桩/固定桩）、CRM 状态机、CSV 导入导出
- 关键纯函数单测：评分分级、去重逻辑、Adapter 响应映射
- 浏览器实测（browser-testing-with-devtools）：登录 → 搜索 → 查看详情 → 评分 → 生成邮件 → 存 CRM 全链路，截图留档 `docs/screenshots/`
- `npm test`（或等价）一键运行全部测试

**验收门**：
- 全部测试通过；对失败项用 debugging-and-error-recovery 流程定位修复后重跑
- 浏览器全链路无 console error，核心按钮全部有真实响应

## 阶段 9：README + 部署说明 + 最终验收

**目标**：交付可复现的运行文档，完成 12 条验收场景。

**交付物**：
- `README.md`：项目简介、架构图、快速开始（含 docker compose 一键启动）、环境变量表、API 概览、目录结构
- `docs/deployment.md`：生产部署要点、迁移执行、备份建议
- `docs/acceptance.md`：12 条验收场景逐条执行记录（含截图/命令输出）
- 更新 `.env.example` 与实际代码一致

**验收门**：
- 按 README 从零 clone → 启动 → 演示成功（用新目录实测一遍）
- 12 条场景全部通过并留档，最终向用户汇报验收结果

---

## `.codebuddy/progress.md` 模板

初始化或每次更新时严格沿用此结构：

```markdown
# TradePilot AI 开发进度

> 本文件是开发进度的唯一事实来源，由 tradepilot-plan-executor 技能维护。

## 当前状态

- 当前阶段：阶段 1/9（产品 PRD）
- 状态：in_progress
- 最后更新：2026-11-10

## 阶段清单

| # | 阶段 | 状态 | 完成日期 | 验收证据 | 提交 |
|---|---|---|---|---|---|
| 1 | PRD + 核心业务流程 | in_progress | - | - | - |
| 2 | 系统架构 + 模块划分 | pending | - | - | - |
| 3 | PostgreSQL Schema | pending | - | - | - |
| 4 | 前后端工程 + Docker | pending | - | - | - |
| 5 | 核心 API + 前端页面 | pending | - | - | - |
| 6 | AI 分析 + 开发信生成 | pending | - | - | - |
| 7 | CRM 业务闭环 | pending | - | - | - |
| 8 | 测试验证 | pending | - | - | - |
| 9 | README + 部署 + 验收 | pending | - | - | - |

## 各阶段记录

### 阶段 1：PRD + 核心业务流程

- 交付物：docs/PRD.md、docs/tasks.md
- 决策与备注：（记录选型、变更、用户确认等）
- 遗留问题：（无则写"无"）
```

状态取值：`pending` / `in_progress` / `done`。每完成一个阶段：在表格中填日期、证据（如"迁移执行成功输出"、"测试 34/34 通过"）、提交哈希；在「各阶段记录」追加该阶段详情；把下一阶段改为 `in_progress` 并更新「当前状态」。
