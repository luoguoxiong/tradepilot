# TradePilot AI — 系统架构与模块划分

> 版本：v1.1（吸收对抗性审查 13 项修正）｜状态：待用户确认｜前置：`docs/PRD.md` v1.0（已确认）
> 本文档是阶段 3–9 的技术基线。

## 1. 总体架构（分层）

MVP 采用**模块化单体**（NestJS 单进程 + BullMQ Worker 独立进程），不上微服务。

```
┌─────────────────────────────────────────────────────────────┐
│ 前端 web/                                                    │
│ Vite + React 18 + TS + Tailwind + shadcn/ui + Zustand        │
│ Dashboard / Lead Discovery / Companies / Company Detail      │
│ / CRM / Email Studio / Settings / Login                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST/JSON (HTTP, JWT Bearer)
┌──────────────────────────▼──────────────────────────────────┐
│ API 层 server/ (NestJS)                                      │
│ 全局 JWT Guard（/auth、/health 除外）· DTO 边界校验           │
│ 统一错误结构 · 统一响应/异常过滤器 · 结构化日志(pino)          │
├─────────────────────────────────────────────────────────────┤
│ 服务层（NestJS Modules）                                     │
│ auth · products · companies · contacts · customs             │
│ ai · crm · tasks · integrations                              │
├───────────────────────┬─────────────────────────────────────┤
│ 任务层（BullMQ @ Processor） │ Adapter 层（第三方隔离）        │
│ lead-discovery worker       │ CompanySearchAdapter           │
│ 步骤/子步可重试/可恢复       │ ContactDiscoveryAdapter        │
│ 单企业失败可见可重试         │ CustomsDataAdapter             │
│                             │ CompanyEnrichmentAdapter       │
│                             │ 每接口 Real | Mock 两实现       │
├──────────────────────────┬──┴───────────────────────────────┤
│ 数据层 Prisma + PostgreSQL │ 队列 Redis (BullMQ + 配额计数)   │
│ 11 张业务表 + audit_logs   │                                  │
│ + 任务/子任务/步骤日志      │                                  │
└──────────────────────────┴──────────────────────────────────┘
           基础设施：docker-compose（postgres / redis）
```

关键约束：
- **业务代码零第三方调用**：所有 Google/Apollo/海关/LLM 调用只能出现在 `server/src/adapters/` 与 `server/src/ai/`。
- **无 Key 自动降级 Mock**：Adapter 工厂检测 integrations 表/env 配置，无 Key 时返回 Mock 实现且数据带 `source: 'demo'`。
- **多租户预留**：全表 `tenant_id` 列 + 默认值 `'default'`，代码注释标注预留位，MVP 不做隔离。

## 2. 模块划分

| 模块 | 路径 | 职责 | 依赖 |
|---|---|---|---|
| auth | `server/src/auth` | 注册/登录、JWT 签发与校验、密码哈希（bcrypt） | prisma |
| products | `server/src/products` | 我方产品 CRUD（名称/描述/卖点/关键词/公司介绍） | prisma |
| companies | `server/src/companies` | 企业列表/详情/收藏/批量导入 CRM/去重（域名唯一） | prisma, adapters |
| contacts | `server/src/contacts` | 联系人 CRUD、挖掘触发、手动补充、(company_id,email) 去重 | prisma, adapters |
| customs | `server/src/customs` | 海关采购记录查询与存储（DEMO 标注）、记录聚合 | prisma, adapters |
| ai | `server/src/ai` | LLM 客户端（OpenAI 兼容→DeepSeek）、LeadScoringTool、EmailGenerationTool、prompt 模板、Token/成本日志 | prisma |
| crm | `server/src/crm` | 客户状态机、跟进记录、下次跟进时间、CSV 导入导出 | prisma |
| tasks | `server/src/tasks` | 编排任务 CRUD、任务/子任务状态查询、Lead Discovery 编排器、步骤日志 | prisma, bullmq, adapters, ai |
| integrations | `server/src/integrations` | 三方 API Key 配置读写（Settings 页后端；加密存储、响应脱敏） | prisma |

模块间只允许通过 service 公开方法调用，禁止跨模块直接操作他人 repository。

## 3. Lead Discovery Agent — 任务编排状态机

单一编排器 + 模块化工具（不做多 Agent 协作）。

### 3.1 状态机

```
            ┌──────────┐
            │ pending  │ 任务创建，入队
            └────┬─────┘
                 ▼
            ┌──────────┐   搜索企业（CompanySearchAdapter）
            │searching │──────────────┐
            └────┬─────┘              │ 步骤/子步日志
                 ▼                    ▼
            ┌──────────┐        task_step_logs
            │enriching │（子步：contacts → customs → enrich）
            └────┬─────┘
                 ▼
            ┌──────────┐
            │ scoring  │ AI 匹配度分析（每企业）
            └────┬─────┘
                 ▼
            ┌──────────┐
            │ emailing │ 开发信生成（A/B/C 级客户）
            └────┬─────┘
                 ▼
            ┌──────────┐
            │   done   │ 完成；汇总跳过/失败企业清单
            └──────────┘

  核心步骤（searching）失败，或单企业失败超过容忍阈值：
            ┌──────────┐
            │  failed  │（记录失败步骤/子步与原因，可从该步重试）
            └──────────┘
```

### 3.2 步骤、子步与可恢复设计（plan.md 第三节要求）

**步骤与子步**（日志与重试均支持子步粒度）：

| 状态 | 子步 | 产物落库 |
|---|---|---|
| searching | — | companies（域名 upsert 去重） |
| enriching | `enriching:contacts` → `enriching:customs` → `enriching:enrich` | contacts（唯一键 upsert）、customs_records、企业字段补充 |
| scoring | — | lead_scores（企业粒度） |
| emailing | — | email_drafts、crm 客户（A/B/C 级导入） |

**表分工**（阶段 3 落地，覆盖 plan.md 第五节 11 张表）：
- `search_tasks`：编排任务主表（状态机载体：参数、状态、进度计数、跳过/失败企业汇总）
- `enrichment_tasks`：企业粒度补充子任务（company_id、子步状态、失败原因）——单企业失败可见、可单独重试
- `task_step_logs`：步骤/子步执行日志（task_id, step, status, detail, started_at, finished_at, company_id 可空）

**单步/单企业重试**：`POST /api/search-tasks/:id/retry`，body `{ fromStep, companyId? }`。
`fromStep` 枚举 = `'searching' | 'enriching' | 'enriching:contacts' | 'enriching:customs' | 'enriching:enrich' | 'scoring' | 'emailing'`；带 `companyId` 时只重跑该企业的指定子步。已完成步骤产物已落库，不重复执行（幂等 upsert）。

**崩溃恢复与状态对账**：
- worker 崩溃后 BullMQ 未完成 job 重新投递，编排器读 `task_step_logs` 判断已完成步骤，从断点续跑
- BullMQ attempts 耗尽 → worker `onFailed` 钩子将任务置 failed
- 兜底对账：API 进程定时（每 5 分钟）扫描超过 30 分钟仍处中间态且无活跃 job 的任务，置 failed（可重试）——杜绝任务永久卡在中间态

**超时/频率/成本控制**：
- Adapter 调用 15s 超时；LLM 调用 60s 超时
- Adapter 层并发上限 3、调用间隔 500ms
- **三方 API 成本**：Google/Apollo/海关各有日配额（Redis 计数器，可配；超出抛 `AdapterError`，记步骤失败并提示降级配置）
- **LLM 成本**：每任务评分企业数上限（默认 10）；超出者标记 `score_status='skipped'`，任务结果中列出，Company Detail 可单独触发评分

**失败策略**：searching 失败 → 任务 failed；enriching/scoring/emailing 的单企业失败 → 记录到对应表（enrichment_tasks / lead_scores 状态字段），任务继续，done 时汇总失败清单。

**前端进度刷新**：MVP 采用轮询——前端每 2s 调 `GET /api/search-tasks/:id`，任务进入终态后停止（不上 SSE/WebSocket，P2 可演进）。

### 3.3 API 端点总览（REST 规范）

统一错误结构（全后端唯一）：

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` `/api/auth/login` | 注册/登录（Public） |
| GET | `/api/health` | 健康检查（含 DB/Redis 连通，Public） |
| GET/POST/PATCH/DELETE | `/api/products(/:id)` | 我方产品 CRUD |
| POST | `/api/search-tasks` | 创建搜索任务（入队） |
| GET | `/api/search-tasks(/:id)` | 任务列表/详情（含步骤日志、进度、跳过/失败企业） |
| POST | `/api/search-tasks/:id/retry` | 从指定步骤/子步重试（可限定 companyId） |
| GET | `/api/companies(/:id)` | 企业列表（分页/筛选/收藏）/ 详情 |
| POST | `/api/companies/import-crm` | 批量导入 CRM |
| GET/POST/PATCH/DELETE | `/api/companies/:id/contacts(/:cid)` | 联系人管理 |
| POST | `/api/companies/:id/contacts/discover` | 触发联系人挖掘 |
| GET | `/api/companies/:id/customs-records` | 海关记录查询（含服务层聚合摘要） |
| GET/POST | `/api/companies/:id/lead-scores` | 评分历史读取 / 触发 AI 评分（支持重跑） |
| GET/POST | `/api/companies/:id/email-drafts` | 邮件草稿列表 / 生成（支持重新生成） |
| PATCH | `/api/email-drafts/:id` | 编辑草稿（草稿随客户详情在 CRM 展示） |
| GET/PATCH | `/api/crm/customers(/:id)` | CRM 客户列表/详情/状态流转 |
| POST | `/api/crm/customers/:id/activities` | 添加跟进记录 |
| GET/POST | `/api/crm/export` `/api/crm/import` | CSV 导出/导入 |
| GET/PATCH | `/api/integrations` | 三方 Key 配置读写（加密存储、响应脱敏） |

约定：分页 `?page=1&pageSize=20`，响应 `{ data, pagination }`；字段 camelCase；枚举 UPPER_SNAKE；列表端点一律分页；任务资源统一 `/api/search-tasks` 前缀。

## 4. Adapter 接口定义（TypeScript）

> 实际文件在阶段 4/5 落地为 `server/src/adapters/*.ts`；接口契约以此为准，变更须同步本文档。

### 4.1 公共类型

```typescript
/** 数据来源标记：真实 API 返回具体提供方，Mock 恒为 'demo' */
type DataSource =
  | 'google'
  | 'apollo'
  | `customs:${string}`    // 如 'customs:importgenius'
  | `enrichment:${string}` // 如 'enrichment:apollo-org'
  | 'demo';

interface AdapterContext {
  userId: string;        // 调用方，用于 integrations 按用户取 Key（MVP 单租户默认）
  timeoutMs?: number;    // 默认 15000
}
```

### 4.2 CompanySearchAdapter（Google 搜索）

```typescript
interface CompanySearchInput {
  productKeywords: string[];        // ['carbon fiber insoles']
  country: string;                  // 'US' | 'CA'（ISO 3166-1 alpha-2）
  companyTypes: string[];           // ['Importer', 'Distributor']
  industryKeywords?: string[];
  limit: number;                    // 本次拉取企业数上限
  page?: number;                    // 搜索深度分页（默认 1）
}

interface CompanySearchResult {
  name: string;
  website?: string;                 // 去重主键；无官网时由名称生成指纹
  country: string;
  description?: string;             // Real：搜索摘要
  mainProducts?: string[];          // Real 通常为空 → 由 enriching:enrich 补齐
  email?: string;                   // 仅合法公开来源；不可得则留空
  linkedinUrl?: string;
  source: DataSource;               // Mock 恒 'demo'
  searchedAt: Date;
}

interface CompanySearchAdapter {
  readonly name: 'CompanySearchAdapter';
  /** 搜索潜在企业；Real 实现调 Serper（google.serper.dev，Google 检索结果）；Mock 返回确定性生成的 DEMO 数据 */
  search(input: CompanySearchInput, ctx: AdapterContext): Promise<CompanySearchResult[]>;
}
```

**字段可得性分工**：Serper 搜索 API 实际只返回标题/摘要/链接——Real 实现只填 `name/website/country/description/searchedAt/source`；`mainProducts/email/linkedinUrl` 等可选字段由 `enriching:enrich` 子步补齐，合法来源不可得时**留空**（前端显示"—"），禁止虚构。

### 4.3 CompanyEnrichmentAdapter（企业信息补充）

```typescript
interface CompanyEnrichment {
  description?: string;
  mainProducts?: string[];
  employeeRange?: string;
  linkedinUrl?: string;
  email?: string;                   // 仅合法公开来源
  source: DataSource;               // Real 为 enrichment:<provider>
}

interface CompanyEnrichmentAdapter {
  readonly name: 'CompanyEnrichmentAdapter';
  /** 已有名称/官网，补充其余字段；不得虚构 —— 仅返回数据源真实提供的字段 */
  enrich(company: { name: string; website?: string; country: string }, ctx: AdapterContext): Promise<CompanyEnrichment>;
}
```

### 4.4 ContactDiscoveryAdapter（Apollo 联系人）

```typescript
interface ContactDiscoveryInput {
  company: { id: string; name: string; website?: string; country: string };
  titles: string[];   // ['Purchasing Manager','Procurement Manager','Sourcing Manager','Import Manager','CEO','Founder']
}

interface ContactCandidate {
  name: string;
  title: string;
  email?: string;                  // 缺失时前端引导手动补充；禁止编造
  linkedinUrl?: string;
  country?: string;
  emailVerified: 'verified' | 'unverified' | 'unknown';
  source: DataSource;              // Mock 恒 'demo'
}

interface ContactDiscoveryAdapter {
  readonly name: 'ContactDiscoveryAdapter';
  /** 挖掘采购联系人；Real 调 Apollo；Mock 返回 DEMO 数据并标注 */
  discover(input: ContactDiscoveryInput, ctx: AdapterContext): Promise<ContactCandidate[]>;
}
```

### 4.5 CustomsDataAdapter（海关数据）

```typescript
/** 单条进口记录（原始粒度） */
interface CustomsRecord {
  companyName: string;
  importCountry: string;           // 进口国
  productDescription?: string;
  hsCode?: string;
  shipmentDate: Date;              // 采购时间
  quantity?: string;               // 数量/重量（原样字符串）
  supplierCountry?: string;
  supplierName?: string;
  source: DataSource;              // Mock 恒 'demo'，前端显示 DEMO 徽章
}

/** 服务层聚合结果（非 Adapter 输出）：企业级结论由多条记录推导 */
interface CustomsSummary {
  recordCount: number;
  firstShipmentDate?: Date;
  lastShipmentDate?: Date;
  frequency: 'monthly' | 'quarterly' | 'yearly' | 'irregular' | 'unknown';  // 记录 < 2 条时 'unknown'
  supplierCountries: string[];
}

interface CustomsDataAdapter {
  readonly name: 'CustomsDataAdapter';
  /** 查询单条进口记录列表；无真实数据返回空数组，绝不伪造 */
  queryImportRecords(company: { name: string; website?: string; country: string }, ctx: AdapterContext): Promise<CustomsRecord[]>;
}
```

采购频率、首次/最近采购等**企业级聚合维度**由 customs 服务层基于记录列表计算，作为 AI 评分输入——不在单条记录上建模。

Real 实现按 `CUSTOMS_API_PROVIDER`（或 integrations extra.provider）选择：`importyeti`（默认，美国 AMS 提单公开数据，仅 Key，端点 `GET {base}/v1.0/powerquery/us-import/bols`，ImportYeti 无数量字段故 `quantity` 留空）或 `generic`（通用 REST 约定，Key + URL）。无 Key 降级 Mock。

### 4.6 Real / Mock 实现约定

| 约定 | Real 实现 | Mock 实现 |
|---|---|---|
| 位置 | `adapters/<name>/real.adapter.ts` | `adapters/<name>/mock.adapter.ts` |
| Key 来源 | integrations 表（用户级，优先）或 env（部署级默认） | 无需 Key |
| 选择逻辑 | `AdapterFactory.resolve(name, ctx)`：有 Key→Real，无 Key→Mock（日志 WARN 提示降级） | 恒选 |
| 数据标记 | `source` 为真实提供方 | `source: 'demo'`，前端 DEMO 徽章 |
| 响应校验 | **第三方响应视为不可信输入**，过 zod schema 校验后才进入业务 | 按输入确定性生成（同输入同输出，利于测试） |
| 成本控制 | 日配额 Redis 计数器，超出抛 `AdapterError` | 不适用 |
| 失败语义 | 超时/限流/配额超限/5xx → 抛 `AdapterError`，任务层捕获记步骤失败 | 不抛错（除非测试注入） |

## 5. 选型决策记录（ADR）

### ADR-001：后端框架选 NestJS（已由用户确认）

- **决策**：NestJS（放弃 Fastify 裸框架）。
- **理由**：① 模块化单体需要清晰的模块边界（Module/Provider/DI），NestJS 原生提供；② 内置 Guard/Interceptor/Filter 正好承载统一鉴权、响应包装、错误结构；③ 生态成熟（@nestjs/bullmq、Prisma 集成、OpenAPI）。Fastify 更轻但需自建大量结构约定，MVP 阶段结构收益大于性能收益。
- **代价**：启动较慢、样板代码多——接受。

### ADR-002：ORM 选 Prisma（放弃 Drizzle）

- **决策**：Prisma。
- **理由**：① schema-first：`schema.prisma` 即阶段 3 交付的 Schema 文档，单一事实来源；② `prisma migrate` 内置迁移与迁移历史，满足"首次迁移可成功执行"验收门，Drizzle 需自组迁移工具链；③ 类型自动生成、与 NestJS 集成成熟；④ 11 张表的 CRUD 为主、无复杂 SQL 需求，Prisma 的表达力足够。
- **代价**：复杂查询/窗口函数不便——MVP 无此需求；冷启动生成开销小——接受。

### 其他小决策（记录备查）

- 日志：pino（结构化 JSON）。
- 校验：DTO 层用 zod（与 AI 输出校验同一套 schema 体系）。
- LLM：OpenAI 兼容客户端指向 DeepSeek（`base_url` + `DEEPSEEK_API_KEY`），prompt 模板集中 `server/src/ai/prompts/`。
- 队列：BullMQ（`lead-discovery` 队列，concurrency=2，15 分钟 stalled 检测）。
- 审计：`audit_logs` 表（第 12 张表，plan.md 允许超集）记录登录、CRM 状态流转、批量导入、CSV 导入导出等用户操作——满足"重要操作记录日志"。
- API Key 存储：integrations 表字段 AES-256-GCM 加密（密钥 `APP_ENCRYPTION_KEY` 走 env），API 响应只返回尾 4 位掩码。
- 前端任务进度：2s 轮询（MVP），SSE/WebSocket 留 P2。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 三方 API 无 Key，演示失真 | Mock 确定性数据 + DEMO 标注，验收场景 7 明确允许 DEMO |
| LLM 输出不稳定导致评分波动 | 低温参数 + 结构化 zod 校验 + 失败重试一次再降级；验收门要求两次评分波动 ≤10 |
| 任务中途崩溃丢失进度 | 步骤日志 + 幂等 upsert + BullMQ 重投递 + 定时对账兜底 |
| 三方 API 付费配额意外耗尽 | 日配额 Redis 计数器 + 超限结构化报错 |
| Key 泄露 | 加密落库 + 响应脱敏 + env 兜底 |
| 旧仓库历史混淆 | 已正式清空（f108f2c），全新目录结构 `server/` `web/` |

## 7. 待用户确认项

1. 整体架构与模块划分是否符合预期？
2. ADR-002（Prisma）是否认可？
3. API 端点清单有无增删需求？
