# 简历 · Forward Deployed Engineer / AI 应用方向

> 使用说明：`[ ]` 为待填项，请替换为真实信息。项目经历部分已按 TradePilot AI 真实实现写好，可直接用。
> 建议投递前按目标 JD 微调关键词（见文末「关键词对齐表」）。

---

# 中文版

## [你的姓名]

**求职意向**：AI 应用 / 全栈工程师（Agent 方向）· Forward Deployed Engineer
**经验**：8 年前端与全栈工程经验 + 近半年生产级 Agent 系统交付

📞 [手机号]　✉️ [邮箱]　📍 [城市]　🔗 GitHub：[链接]　🌐 个人主页/作品集：[链接]

---

## 个人摘要

8 年前端与全栈工程经验，近半年独立交付面向真实外贸企业的 AI 数字员工系统（TradePilot AI）。**核心能力是把工程成熟度注入 AI 系统**——权限边界、人在回路、幂等与降级、成本治理，让 Agent 从 demo 变成可交付、可审计、可量化的生产系统。具备从业务调研、Agent 架构设计、前后端实现到真实环境集成的端到端交付能力；8 年前端背景使快速产出高质量可交互原型成为常态，这是 AI 落地场景中稀缺的生产力。

---

## 核心能力

**工程深度（8 年积累）**
- 前端架构：Vue 3 / React 技术选型与架构设计、组件库与 Design Token 体系、复杂状态管理、微前端与模块化
- 性能工程：首屏与渲染优化、N+1 与聚合查询治理、虚拟滚动、分包与缓存策略（实战：Dashboard 6.0s → 0.06s）
- 工程化：Monorepo（pnpm + Turborepo）、TypeScript strict 全链路类型、CI/CD 与测试门禁（Vitest 单测/集成/契约）
- 交付素质：需求拆解与方案设计、跨端跨系统集成、线上问题定位与技术债治理

**AI / Agent 工程**
- Agent 编排：LangGraph.js、SOP → 有向图编译、Checkpointer 长任务与断点续跑、多轮工具调用
- 可靠性工程：结构化输出（Zod）+ 重试、证据链（`confidence / reasons / citations`）、幻觉降级、不可信数据隔离注入
- 人在回路：风险分级审批闸门、新鲜度校验、三态处置（批准 / 编辑后批准 / 拒绝）、转人工交接
- 安全边界：工具入参 schema 即权限边界、AI 身份与权限模型、敏感字段脱敏、操作幂等
- LLM 网关：多 provider 路由与降级、Token/成本全量记账、预算告警
- RAG：pgvector + pg_trgm 混合检索、分块嵌入、引用溯源、降级路径设计

**全栈工程**
- 后端：Node.js / TypeScript（strict）、NestJS、BullMQ + Redis、PostgreSQL（RLS 多租户 / pgvector）、Drizzle ORM、SSE 实时推送
- 前端：Vue 3 + TypeScript + Vite、Pinia、TanStack Query、Element Plus、ECharts、Tiptap
- 工程化：pnpm workspace + Turborepo、Vitest（集成 / 契约测试）、ESLint / Prettier、CI 门禁

**交付与业务**
- 业务调研与 SOP 抽象、MVP 范围裁剪与分期交付、跨系统对接（邮箱 / CRM / Webhook / 开放 API）
- 指标口径定义与效果归因，用可复算的数字向业务方证明价值

---

## 工作经历

### [公司名 A] · 高级前端工程师

**[起止年月，共约 8 年]**　|　**[城市]**

- [核心职责与成果：架构主导 / 性能治理 / 工程化建设 / 跨团队协作，用「问题 → 动作 → 可量化结果」写]
- [量化示例：主导 X 个系统前端架构；支撑 X 万日活；首屏 X s → Y s；组件复用率提升至 X%]
- [体现"高级"的证据：技术选型决策、规范与基建推广、带人/Code Review、跨端跨团队推动]

### [公司名 B] · 前端工程师（如有）

**[起止年月]**　|　**[城市]**

- [同上结构，2–3 条]

> **填写提示**：8 年经历是定价基本盘，务必写足。面试官会用它判断你的工程成熟度——而工程成熟度正是你做 Agent 项目时那些"别人想不到的设计"（权限边界、幂等、降级、成本治理）的来源。不要只写"参与了什么功能"，要写"做了什么决策、解决了什么难题、带来什么量化变化"。

---

## 项目经历

### TradePilot AI · 外贸 AI 数字员工平台

**角色**：独立完成（业务调研 + 架构 + 全栈 + Agent）　|　**时间**：2026.09 – 至今
**技术栈**：LangGraph.js · NestJS · TypeScript · Vue 3 · PostgreSQL(pgvector) · Redis/BullMQ · Drizzle · pnpm + Turborepo

> 面向真实外贸企业交付的 AI 员工系统。从业务现场梳理作业流程起步，独立完成后端 Agent Runtime、前端工作台与邮箱/CRM 集成，已交付首个客户（[某家居/机械/汽配] 出口企业，[N] 人销售团队）试用运行。系统覆盖 16 个业务模块、40 张数据表、6 条工作流，全栈代码约 9.5 万行。

- **业务建模**：将获客、客户研究、销售跟进、报价、订单履约、经营分析 6 类真实岗位作业流程，抽象为 `Role / Goal / SOP / Tools / Knowledge / Memory / Approval / KPI` 的 AI 员工模型；以「业务目标 → Agent 建任务 → 按 SOP 执行 → 产出业务结果 → 人工审核」替代 Chat 形态，不做聊天机器人。
- **Agent Runtime**：用 LangGraph.js 将 SOP 编译为有向图；Postgres Checkpointer（`thread_id = taskId`）实现长任务断点续跑；审批挂起态由数据库权威表达（`waiting_approval` + `ApprovalPendingError`），恢复后 `invoke(null)` 从检查点续跑，并做 `freshnessCheck` 新鲜度校验，避免"批完再发"打到已回复的客户。
- **AI 安全与权限边界**：设计工具注册表——**入参 Zod schema 即权限边界**（AI 无法传入 `ownerId` 等越权字段）；`riskLevel` 三级分流（低风险直发 / 中风险可配自动放行 / 高风险必人工）；外发邮件以 `taskId + nodeId + 内容hash` 做幂等键，杜绝重复触达客户。
- **可信输出与幻觉治理**：所有 LLM 节点强制结构化输出（Zod + 解析失败重试 2 次）；AI 产出必须携带 `confidence / reasons / citations`，缺依据时输出 `grounded=false + missingInfo[]` 走"补料"分支而非硬答；成本价等敏感字段在 prompt 前脱敏，并在提示词写死"禁止编造参数/认证/价格"红线。
- **成本与模型治理**：统一 LLM Gateway 封装 OpenAI / Anthropic / DeepSeek / Azure，按场景路由模型档位、provider 不可用时 `degraded` 降级兜底；每次调用全量记账（token / cost / latency），月度预算越界告警不熔断。
- **效果可量化**：建立「AI 节省工时」估算口径（获客 10min/客户、邮件 15min/封、跟进 5min/次）与 14 天归因窗口 + 最后触点归因，常量单点定义；看板任意数字可下钻到明细行人工复算，**向业务方交付的是可对账的数字而非"感觉有用"**。
- **真实环境集成与性能**：打通 Gmail / Outlook / SMTP-IMAP 真实邮箱收发、CRM 集成与开放 API（API Key + scope fail-closed + 限流、Webhook HMAC-SHA256 签名 + 指数退避 + 死信标记）；定位并修复首屏聚合 N+1（1080 次往返 → 3 次批量聚合），接口耗时 **6.0s → 0.06s**。

**业务价值（待补真实数据）**
- 支撑 [N] 人销售团队，管理 [X] 万级客户与询盘数据，日均处理 [N] 封询盘
- 单封开发信/回复从 [约 20 分钟撰写] 降至 [约 5 分钟审核确认]
- 报价核算由人工手算改为引擎计算 + 利润红线强拦截，[杜绝了 X 类漏算]

---

### [其他项目 / 工作经历]

**[项目或公司名]**　|　**[角色]**　|　**[起止时间]**
- [用业务语言描述：解决了什么问题 → 你怎么做 → 产生了什么可量化的结果]
- [突出与 FDE 相关的能力：客户沟通、快速交付、跨系统集成、AI/数据能力]

---

## 教育背景

**[学校名称]**　|　**[专业]**　|　**[学历]**　|　**[起止时间]**
- [相关课程 / 荣誉 / 论文，如无可删]

---

<br>

---

# English Version

## [Your Name]

**Target Role**: AI Application / Full-stack Engineer (Agent Systems) · Forward Deployed Engineer
**Experience**: 8 years frontend & full-stack + 6 months shipping a production-grade agent system

📞 [Phone]　✉️ [Email]　📍 [City]　🔗 GitHub: [link]

---

## Summary

Eight years of frontend and full-stack engineering, with the last six months spent independently delivering an AI agent system for a real foreign-trade company. **My edge is injecting engineering rigor into AI systems** — permission boundaries, human-in-the-loop, idempotency and graceful degradation, cost governance — turning agents from demos into auditable, production-grade systems. End-to-end ownership from business discovery and SOP modeling through agent architecture, implementation, and real-world integration. The 8-year frontend background makes shipping high-quality interactive prototypes fast, which is scarce and decisive in AI delivery work.

---

## Core Skills

**Engineering Depth (8 years)**
- Frontend architecture: Vue 3 / React, component libraries and design tokens, complex state management, modularization
- Performance: render & load optimization, query aggregation (N+1) elimination, virtualization, code splitting (case: dashboard 6.0s → 0.06s)
- Tooling: Monorepo (pnpm + Turborepo), end-to-end TypeScript strict, CI with test gates (Vitest unit / integration / contract)
- Delivery: requirements decomposition, cross-system integration, production debugging, tech-debt management

**AI / Agent Engineering**
- Orchestration: LangGraph.js, SOP→graph compilation, checkpointers for long-running tasks, multi-step tool use
- Reliability: structured output (Zod) with retry, evidence chains (`confidence / reasons / citations`), groundedness gating, untrusted-data isolation
- Human-in-the-loop: risk-tiered approval gates, freshness re-validation, three-way disposition (approve / edit-and-approve / reject), human handoff
- Safety: input schema as permission boundary, AI identity & authorization model, sensitive-field redaction, idempotent actions
- LLM Gateway: multi-provider routing & graceful degradation, token/cost accounting, budget alerting
- RAG: pgvector + pg_trgm hybrid retrieval, chunking & embedding, citation traceability, degradation paths

**Full-stack**
- Backend: Node.js / TypeScript (strict), NestJS, BullMQ + Redis, PostgreSQL (RLS multi-tenancy, pgvector), Drizzle ORM, SSE streaming
- Frontend: Vue 3 + TypeScript + Vite, Pinia, TanStack Query, Element Plus, ECharts, Tiptap
- Tooling: pnpm workspace + Turborepo, Vitest (integration & contract tests), ESLint/Prettier, CI gates

**Delivery**
- Business discovery & SOP abstraction, MVP scoping & phased delivery, system integration (mailbox / CRM / Webhook / Open API), metric definition & outcome attribution

---

## Experience

### [Company A] · Senior Frontend Engineer

**[Dates, ~8 years total]**　|　**[City]**

- [Ownership & outcomes: architecture leadership, performance work, tooling, cross-team collaboration — write as problem → action → quantified result]
- [e.g. Led frontend architecture for X systems serving X users; cut first-paint from Xs to Ys; raised component reuse to X%]
- [Evidence of seniority: tech-selection decisions, standards/platform adoption, mentoring, code review ownership]

### [Company B] · Frontend Engineer (if applicable)

**[Dates]**　|　**[City]**

- [Same structure, 2–3 bullets]

> **Note**: These 8 years are your pricing floor — write them fully. They are the source of the engineering maturity your agent project demonstrates (permission boundaries, idempotency, degradation, cost governance) — things most AI-only candidates never think about.

### TradePilot AI — AI Digital Workforce Platform for Foreign Trade

**Sole builder (Discovery + Architecture + Full-stack + Agent)**　|　**2026.09 – Present**
LangGraph.js · NestJS · TypeScript · Vue 3 · PostgreSQL (pgvector) · Redis/BullMQ · Drizzle · pnpm + Turborepo

> AI employee system delivered to a **real foreign-trade company**. Started from on-site workflow discovery; independently built the agent runtime, operator workbench, and mailbox/CRM integrations. Shipped to the first customer (a [home/industrial/auto-parts] export company, [N]-person sales team). 16 business modules, 40 tables, 6 workflows, ~95k LOC.

- **Business → Agent modeling**: Abstracted six real job roles (lead generation, customer research, sales, follow-up, order fulfillment, business management) into an AI-employee model of `Role / Goal / SOP / Tools / Knowledge / Memory / Approval / KPI`. Deliberately **not a chatbot**: users set business goals, agents create tasks, execute SOPs, produce business outcomes, and route to human review.
- **Agent Runtime**: Compiled SOPs into LangGraph.js state graphs; Postgres checkpointer (`thread_id = taskId`) enables long-running tasks and resume-from-checkpoint. Approval suspension is expressed authoritatively in the DB (`waiting_approval` + `ApprovalPendingError`); on resume, `invoke(null)` continues from the checkpoint and runs a `freshnessCheck` so an approved email is never sent to a customer who already replied.
- **Safety boundaries for AI**: Built a tool registry where **the input Zod schema is the permission boundary** (the model cannot pass `ownerId` or similar). Three-tier `riskLevel` routing (low → execute, medium → configurable auto-approval, high → mandatory human). Outbound email idempotency key = `taskId + nodeId + content hash`, preventing duplicate customer contact.
- **Trustworthy output**: Every LLM node enforces structured output (Zod, 2 retries). Outputs must carry `confidence / reasons / citations`; when evidence is missing the node emits `grounded=false + missingInfo[]` and routes to a "request more info" branch instead of fabricating. Cost prices are redacted before prompting, with explicit anti-fabrication instructions.
- **Cost & model governance**: Unified LLM Gateway over OpenAI / Anthropic / DeepSeek / Azure with scene-based routing and `degraded` fallback. Full per-call accounting (tokens / cost / latency); monthly budget alerts without hard cut-off.
- **Measurable impact**: Defined a single-source "hours saved" model (10 min per lead, 15 min per email, 5 min per follow-up) plus a 14-day attribution window with last-touch attribution. Every dashboard number drills down to row-level detail that a human can recompute — **the customer gets auditable numbers, not a vibe**.
- **Real-world integration & performance**: Integrated Gmail / Outlook / SMTP-IMAP mailboxes, CRM integration, and an Open API (API keys with fail-closed scopes and rate limiting; webhooks with HMAC-SHA256 signatures, exponential backoff, dead-lettering). Fixed an N+1 aggregation on the landing page (1,080 round-trips → 3 batched queries): **6.0s → 0.06s**.

**Business impact (fill in with real figures)**
- Supports [N]-person sales team; [X]k+ customers and inquiries; [N] inquiries/day
- Outreach drafting time reduced from ~[20] min to ~[5] min of review
- Quote costing moved from manual spreadsheets to engine computation with a hard profit floor, eliminating [X] classes of miscalculation

---

### [Other Projects / Experience]

**[Project or Company]**　|　**[Role]**　|　**[Dates]**
- [Problem in business terms → what you did → quantified result]

---

## Education

**[University]**　|　**[Major]**　|　**[Degree]**　|　**[Dates]**

---

<br>

---

# 待办清单：投递前必填

| # | 待填项 | 说明 |
|---|---|---|
| 1 | 姓名 / 手机 / 邮箱 / 城市 / GitHub | 基础信息 |
| 2 | 客户行业与规模 | 你姐公司的主营品类、业务员人数、客户/询盘存量、日均询盘量 |
| 3 | **节省工时数据** | 最值钱的一项：一封开发信/回复以前多久、现在多久 |
| 4 | 是否已真实外发 | "已真实外发 N 封邮件 / 生成 N 份报价"，有数字就写 |
| 5 | **8 年工作经历（最重要）** | 补 2 家公司 × 2–3 条。写「决策 / 难题 / 量化结果」，不要写"参与了哪些功能"——这是你 40K+ 定价的基本盘 |
| 6 | 教育背景 | 学校 / 专业 / 学历 / 时间 |

---

# 关键词对齐表（按 JD 微调）

| 如果 JD 强调 | 就突出这些词 |
|---|---|
| **FDE / 客户交付** | 业务调研、SOP 抽象、MVP 分期、真实客户落地、跨系统集成、驻场式迭代 |
| **Agent 工程** | LangGraph、Checkpointer、工具注册表、人在回路、状态机、多轮编排 |
| **LLM 可靠性** | 结构化输出、证据链、幻觉治理、groundedness、降级路径、不可信数据隔离 |
| **RAG** | pgvector 混合检索、引用溯源、分块嵌入、检索降级 |
| **AI 安全** | 权限边界、AI 身份、审批闸门、幂等、敏感字段脱敏、审计 |
| **成本优化** | 多 provider 路由、模型档位、token 记账、预算告警、degraded 降级 |
| **全栈能力** | NestJS / Vue 3 / PostgreSQL / BullMQ / SSE / Turborepo / Vitest |

---

# 面试准备：10 分钟端到端演练

能流畅讲完这条链路，比任何 bullet 都有力：

```
创建获客任务 → AI 检索并发现线索 → 线索评分（带 reasons）
→ 生成开发信草稿（带 citations）→ 触发审批（riskLevel 分级）
→ 人工「编辑后批准」→ 真实邮箱外发 → 客户回复被捕获
→ AI 生成回复草稿 → 触发跟进序列 → 高价值客户静默 14 天被识别为风险
→ 一键转人工（交接摘要可回溯）→ 数据中心/AI 经理报告可对账
```

**必答题（准备逐字稿）**：
1. 你怎么把模糊业务需求变成系统？（答：先建模岗位，不列功能清单）
2. AI 乱发邮件/报错价怎么办？（答：权限边界 + 风险分级 + 新鲜度校验 + 幂等，四道防线）
3. 怎么证明有价值？（答：口径单点 + 可下钻复算，诚实标注"估算"）
4. LLM 挂了/数据脏了怎么办？（答：provider 降级、向量路降级为全文检索、站点级降级不中断任务）
5. 为什么不用 LangGraph 原生 interrupt？（答：挂起态必须能被审核中心独立查询、超时扫描、跨进程恢复，所以由 DB 权威表达）

---

# 薪资定位与谈薪（深圳 · 8 年前端 + 半年 Agent）

## 报价建议

| 目标岗位 | 建议报价（月薪） | 目标年包 | 底线 |
|---|---|---|---|
| AI 全栈 / 应用工程师（推荐） | 45–60K | 65–85W | 40K |
| FDE（前沿部署工程师） | 45–55K | 60–80W | 40K |
| 大厂前端 / 全栈（AI 产品线） | 按职级谈（8 年 ≈ T10/P7） | 70–100W | 现薪不降 |

**绝对底线：40K。** 8 年经验在深圳跌破 40K 即为被降级，宁可不去。

## 核心风险：被"重新定级"

HR 最容易按「AI 经验 0.5 年」给你定中级价（25–40K），**可能低于你现在的前端薪资**。必须主动阻断。

**❌ 不要这样说**
> "我有 8 年前端经验，最近半年在学习 Agent，做了个项目"

**✅ 要这样说（开场话术，背下来）**
> "我做 Agent 只有半年，但我做工程有八年。这个项目里真正难的不是调 prompt，是让 AI 不出事——权限边界、审批闸门、幂等、成本控制、降级链路。这些是工程问题，恰好是我的强项。"

## 你的差异化卖点（面试必讲）

1. **前端强 = FDE 的核心生产力**：FDE 大量工作是快速做出让客户"哇"出来的 demo。8 年前端意味着你能半天做出像样的界面，算法背景的人做不到。TradePilot 的 Vue3 工作台、SSE 实时日志流、Tiptap 草稿编辑器就是证据。
2. **踩过的坑比用过的框架值钱**：向量降级时 SQL 仍引用 `vec` CTE 导致整链 500、N+1 导致 6s 响应、Node 18 缺 `globalThis.crypto` —— 这些只有真跑起来才会遇到。
3. **垂直行业理解**：深圳/珠三角是外贸与出海 SaaS 最密集的地区，你做的是本地最主流产业场景，不是通用 demo。
