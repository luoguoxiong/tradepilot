# @tradepilot/shared

TradePilot 后端的**契约与常量包**：把「枚举、通用类型、HTTP/分页/队列/通知/环境变量契约、
SSE 事件、Insight Schema、工作流 State 与 SOP 图结构、语言检测、Prompt 守卫、模块启用判定」
收敛为一份跨端共享的单一事实源。

所有 server 侧 `packages/*` 与 `apps/*` 都消费本包；本包**只依赖 `zod`**，无业务实现、无 IO、
不依赖任何本地包。

> 定位：依赖方向 **`api` / `worker` / `packages/*` → `shared` → `zod`**。
> 只放「值 / 类型 / 常量 / 校验 schema」，不放服务、不放数据库、不放运行逻辑。
> 凡「前后端/多服务需一致」的口径（状态枚举、错误外层结构、队列名、事件频道、AI 结论结构）
> 一律在此定义，**禁止在消费方散落字面量**（后端技术方案 01 §6.5）。

---

## 目录

- [设计原则](#设计原则)
- [目录结构](#目录结构)
- [模块一览](#模块一览)
  - [enums — 全局枚举](#enums--全局枚举)
  - [types/http.ts — 响应 envelope](#typeshttpts--响应-envelope)
  - [contracts/pagination.ts — 分页与日志游标](#contractspaginationts--分页与日志游标)
  - [contracts/queues.ts — 队列拓扑](#contractsqueuests--队列拓扑)
  - [contracts/notify.ts — 通知载荷与分发](#contractsnotifyts--通知载荷与分发)
  - [contracts/env.ts — 环境变量契约](#contractsenvts--环境变量契约)
  - [sse/events.ts — SSE 事件契约](#sseeventsts--sse-事件契约)
  - [insight/schema.ts — AI 产出 Insight](#insightschemats--ai-产出-insight)
  - [workflow-state.ts — 工作流 State 与 SOP 图结构](#workflow-statets--工作流-state-与-sop-图结构)
  - [language.ts — 邮件语言检测](#languagets--邮件语言检测)
  - [prompt-guard.ts — Prompt 上下文守卫](#prompt-guardts--prompt-上下文守卫)
  - [module-enablement.ts — 模块启用判定](#module-enablementts--模块启用判定)
- [契约边界与约定](#契约边界与约定)
- [测试](#测试)
- [开发](#开发)

---

## 设计原则

1. **单一事实源**：状态枚举、队列名、事件频道、Insight 结构、SOP 图 schema 只在此定义一处，
   消费方 `import` 引用，杜绝多份实现漂移。
2. **零业务、零 IO**：只有常量对象、类型、Zod schema 与纯函数；可被 api / worker / 任意 package
   无差别引用，不引入 Nest / Drizzle / Redis / LangGraph。
3. **只依赖 zod**：需要运行时校验的契约用 Zod 表达（可同时导出推断类型）；不产生本地包依赖环
   （如 notify 的事件键**独立声明**，避免 `db → shared` 反向依赖）。
4. **契约对齐文档**：各枚举/结构与产品文档、接口总览条目一一对应（注释标注来源章节），
   便于评审时逐条核对。
5. **值统一小写蛇形**：所有枚举值为小写蛇形字符串，前端按语义色映射表渲染。

---

## 目录结构

```
src/
├── index.ts                    # 包入口：统一重导出
├── enums/index.ts              # 全局枚举常量对象 + 联合类型
├── language.ts                 # detectEmailLanguage：确定性 zh/en 检测
├── module-enablement.ts        # MODULE_KEY / MODULE_PHASE / isModuleEnabled
├── prompt-guard.ts             # 敏感字段剥离 + 外部内容边界标记
├── workflow-state.ts           # SOP 图结构 + BaseTaskState + 三工作流 State
├── types/
│   └── http.ts                 # Envelope / PageResp
├── contracts/
│   ├── pagination.ts           # 分页 / 排序 / 筛选 / 日志游标 schema
│   ├── queues.ts               # QUEUE_NAME / QUEUE_CONCURRENCY / TASK_TYPE_QUEUE
│   ├── notify.ts               # q:notify 载荷 schema + 事件键映射
│   └── env.ts                  # baseEnvSchema / apiEnvSchema / workerEnvSchema / parseEnv
├── sse/
│   └── events.ts               # SSE 事件类型 / payload schema / 频道函数
└── insight/
    └── schema.ts               # Insight / InsightReason / InsightCitation
```

---

## 模块一览

### enums — 全局枚举

TS 侧只用本文件的常量对象（`as const`）并派生联合类型，禁止散落字符串字面量。

| 常量（类型）                                     | 说明 / 取值                                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK_STATUS` / `TaskStatus`                     | 任务状态：`running` / `waiting_approval` / `scheduled` / `paused` / `completed` / `failed` / `canceled`                                 |
| `EMPLOYEE_OCCUPYING_TASK_STATUSES`               | 员工并发=1 的**占用态**集合：`[running, waiting_approval]`（挂起占用员工位、不占 org 额度，Dispatcher/API/终态回写共用口径）            |
| `EMPLOYEE_STATUS` / `EmployeeStatus`             | 员工状态：`working` / `waiting_approval` / `scheduled` / `risk` / `failed` / `idle`                                                     |
| `TASK_TYPE` / `TaskType`                         | 任务类型：`lead_hunting` / `email_reply` / `follow_up` / `order_monitor` / `business_analysis` / `knowledge_index` / `product_analysis` |
| `CUSTOMER_STAGE` / `CustomerStage`               | 客户阶段：`new_lead` / `contacted` / `negotiation` / `cold`                                                                             |
| `LEAD_VALUE` / `LeadValue`                       | 价值分层：`high` / `medium` / `low`                                                                                                     |
| `APPROVAL_TYPE` / `ApprovalType`                 | 审批类型：`quote` / `email_send` / `contract` / `order_change` / `bulk_marketing` / `customer_delete`                                   |
| `RISK_LEVEL` / `RiskLevel`                       | 工具风险级：`low` / `medium` / `high`                                                                                                   |
| `APPROVAL_STATUS` / `ApprovalStatus`             | 审批状态：`pending` / `approved` / `edited_approved` / `rejected` / `auto_approved` / `expired`                                         |
| `APPROVAL_LOG_ACTION` / `ApprovalLogAction`      | `approval_log.action`（与 `APPROVAL_STATUS` 同域）                                                                                      |
| `QUOTE_STATUS` / `QuoteStatus`                   | 报价：`draft` / `waiting_approval` / `sent` / `won` / `lost`                                                                            |
| `ORDER_STATUS` / `OrderStatus`                   | 订单：`pending_payment` / `in_production` / `ready_to_ship` / `completed`                                                               |
| `ORDER_RISK` / `OrderRisk`                       | 订单风险：`normal` / `at_risk`                                                                                                          |
| `PRODUCT_STATUS` / `ProductStatus`               | 产品：`active` / `draft` / `archived`                                                                                                   |
| `INDEX_STATUS` / `IndexStatus`                   | 知识索引：`indexed` / `indexing` / `failed`                                                                                             |
| `FOLLOW_UP_TASK_STATUS` / `FollowUpTaskStatus`   | 跟进任务：`ready` / `scheduled` / `waiting_approval` / `completed` / `paused`                                                           |
| `FOLLOW_UP_SKIP_REASON` / `FollowUpSkipReason`   | 跟进跳过原因：`frequency_capped`                                                                                                        |
| `CONVERSATION_PRIORITY` / `ConversationPriority` | 会话优先级：`high` / `normal` / `pending`                                                                                               |
| `AI_INTENT` / `AiIntent`                         | 邮件意图：`rfq` / `price_compare` / `logistics` / `sample` / `other`                                                                    |
| `ROLE` / `Role`                                  | 角色基线：`admin` / `manager` / `sales`                                                                                                 |
| `SCOPE` / `Scope`                                | 数据范围（应用层裁剪，不走 RLS）：`self` / `team` / `all`                                                                               |
| `OPERATOR_TYPE` / `OperatorType`                 | 操作者身份：`ai` / `user`                                                                                                               |
| `MESSAGE_DIRECTION` / `MessageDirection`         | 邮件方向：`in` / `out`                                                                                                                  |
| `MESSAGE_STATUS` / `MessageStatus`               | 邮件发送状态：`draft` / `pending` / `sent` / `failed`                                                                                   |

### types/http.ts — 响应 envelope

| 导出          | 说明                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Envelope<T>` | 统一响应外层：`{ code, message, data, traceId }`（`code=0` 成功；非 0 取值见 `@tradepilot/core` error-codes，此处保持 `number` 避免底层互依赖） |
| `PageResp<T>` | 列表 `data` 固定结构：`{ items, total, page, pageSize }`                                                                                        |

### contracts/pagination.ts — 分页与日志游标

| 导出                                        | 说明                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `paginationQuerySchema` / `PaginationQuery` | 分页查询：`page≥1`(默认 1) / `pageSize 1~100`(默认 20) / `keyword≤200` / `sortBy≤64` / `sortOrder`(默认 desc) |
| `logAfterQuerySchema` / `LogAfterQuery`     | 日志类**增量**接口游标：`after`（雪花 logId）/ `limit 1~200`(默认 50)                                         |

### contracts/queues.ts — 队列拓扑

`task_type` 与队列**一对一映射**；队列名用 `q.` 前缀（BullMQ 禁含 `:`）。

| 导出                       | 说明                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE_NAME` / `QueueName` | 队列名：`q.lead_hunting` / `q.email_reply` / `q.follow_up` / `q.knowledge_index` / `q.analysis` / `q.email_sync` / `q.notify` |
| `QUEUE_CONCURRENCY`        | 每实例并发基线：lead_hunting 2 / email_reply 5 / follow_up 5 / knowledge_index 2 / analysis 1 / email_sync 3 / notify 5       |
| `TASK_TYPE_QUEUE`          | `TaskType → QueueName`（`product_analysis→knowledge_index`、`order_monitor`/`business_analysis→analysis`）                    |
| `ALL_QUEUES`               | 全部队列名列表（worker 注册用）                                                                                               |

### contracts/notify.ts — 通知载荷与分发

`q:notify` 生产/消费契约；消费端 `NotifyProcessor` 按 `notification_setting` 的「事件 × 渠道」开关矩阵分发。

| 导出                                  | 说明                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_EVENT_KEY` / `NotifyEventKey` | 设置矩阵事件键：`approval_pending` / `risk_alert` / `task_failed`（独立声明，避免 `db→shared` 反向依赖）                                      |
| `NotifyEventSwitch`                   | 单事件渠道开关：`{ site, email }`                                                                                                             |
| `DEFAULT_NOTIFICATION_EVENTS`         | 缺省开关矩阵（与 `settings.ensureNotificationRow` 同源）：审批/风险站内+邮件开，任务失败仅站内                                                |
| `notifyJobSchema` / `NotifyJob`       | job 载荷：`{ type, orgId, title, content?, refType?, refId? }`（消费端安全解析，畸形载荷留痕跳过不重投）                                      |
| `notifyEventKey(type)`                | 原始事件类型 → 矩阵键：`approval_expired→approval_pending`、`task_failed→task_failed`、其余（含 `budget_limit`/`mailbox_error`）→`risk_alert` |

### contracts/env.ts — 环境变量契约

配置差异全部经环境变量（Zod fail-fast）；**业务配置（org 级）一律读库**，不进环境变量。

| 导出                            | 说明                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseEnvSchema` / `BaseEnv`     | api/worker 共享：`NODE_ENV` / `LOG_LEVEL` / `DATABASE_URL`(必填) / `REDIS_URL`(必填) / `WORKER_INDEX 0~1023`(雪花机器位)                                   |
| `apiEnvSchema` / `ApiEnv`       | 含 `API_PORT` / `JWT_SECRET`(≥32 字符) / `ENCRYPTION_KEY`(64 位 hex) / `SCHED_DATABASE_URL?` / Google·Microsoft OAuth / S3 五项 / `ORG_SEARCH_DAILY_LIMIT` |
| `workerEnvSchema` / `WorkerEnv` | 含 `WORKER_QUEUES`(逗号分隔→数组) / `ENCRYPTION_KEY` / OAuth / S3 / `LANGGRAPH_CHECKPOINT_SETUP`（字符串→布尔）                                            |
| `parseEnv(schema, source?)`     | 校验并解析，失败抛错**终止启动**（fail-fast）                                                                                                              |

**要点**：

- LLM / Embedding / Search 供应商**不再经环境变量**，统一由「系统设置 → AI 模型配置」台账读库解析。
- `LANGGRAPH_CHECKPOINT_SETUP` 故**不用 `z.coerce.boolean`**（其实现为 `Boolean(input)`，字符串
  `'false'` 也为真），改用 `enum(['true','false']).transform(...)`。
- 敏感默认值（S3）对齐 `docker-compose` 本地值，仅便于本地起服务，生产须显式注入。

### sse/events.ts — SSE 事件契约

Worker 写库后 Redis `PUBLISH task:{taskId}:events`；API 先订阅 → 按 `after` 回放 → flush。
`seq` 为雪花字符串，供客户端去重。

| 导出                                              | 说明                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SSE_EVENT_TYPE` / `SseEventType`                 | 事件类型：`log` / `progress` / `status` / `done`                                                               |
| `sseLogPayloadSchema` / `SseLogPayload`           | `{ logId, time(ISO), type, content, leadId? }`（与 `/logs` 单条同源同构，实时与回放一致）                      |
| `sseProgressPayloadSchema` / `SseProgressPayload` | `{ progressPct(0~100), currentStep }`                                                                          |
| `sseStatusPayloadSchema` / `SseStatusPayload`     | `{ status, linkedApprovalId?, error? }`（status 取 running/waiting_approval/scheduled/paused/failed/canceled） |
| `sseDonePayloadSchema` / `SseDonePayload`         | `{ status, outputs[], error? }`（status 取 completed/failed/canceled）                                         |
| `taskEventSchema` / `TaskEvent`                   | 事件总线完整消息 = `discriminatedUnion('type', ...)`，每类含 `seq`                                             |
| `taskEventChannel(taskId)`                        | 频道名 `task:{taskId}:events`                                                                                  |

### insight/schema.ts — AI 产出 Insight

凡 AI 生成结论（评分/概率/建议/风险/定价）**必须携带证据链与置信度**（可解释红线，禁止虚构）；
jsonb 列以 `$type<Insight>()` 引用，写入前 `parse`。

| 导出                                        | 说明                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `insightReasonSchema` / `InsightReason`     | 单条理由：`{ text, evidence, source }`（source 如 `web_crawl` / `knowledge_search` / `mailbox_sync`）   |
| `insightCitationSchema` / `InsightCitation` | 引用：`{ docId, docName, chunkId }`                                                                     |
| `insightSchema` / `Insight`                 | 结论：`{ value(number\|string), confidence(0~1), reasons[≥1], citations[](默认 []), generatedAt(ISO) }` |

### workflow-state.ts — 工作流 State 与 SOP 图结构

LangGraph 工作流编译器（`packages/runtime`）的输入契约；State 类型与文档定义**一字不差**。

**SOP 图结构**：

| 导出                                                     | 说明                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TASK_LOG_TYPE` / `TaskLogType`                          | 任务日志类型（与 DB `task_log_type` 一致）：`search` / `found` / `crawl` / `match` / `contact` / `lookup` / `error` |
| `SOP_NODE_KIND` / `SopNodeKind`                          | 节点种类：`llm` / `tool` / `flow`                                                                                   |
| `MODEL_TIER` / `ModelTier`                               | 模型档位：`light` / `medium` / `strong`                                                                             |
| `SopLlmNode` / `SopToolNode` / `SopFlowNode` / `SopNode` | 三类节点定义（`outputKey` / `logType` / `title` / `progress` / `tier` / `risk` / `approvalType` / `route` 等）      |
| `SopEdge`                                                | 边：`{ from, to, when? }`（`when` 为条件边分支键，如 `yes`/`no`、`matched`/`low`）                                  |
| `SopGraphDefinition`                                     | 图定义：`{ version, entry, nodes, edges, doneWhen? }`                                                               |
| `sopGraphDefinitionSchema`                               | 编译器入参 Zod 校验；`superRefine` 校验 `entry` 存在、每条边 `from/to` 均引用已知节点                               |

> `tool` 节点 `risk=medium/high` 在执行前自动进 Approval Gate（Runtime §4.7），**图中不手写 `interrupt`**。

**State 结构**：

| 导出                                                            | 说明                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TaskStateError` / `BaseTaskState`                              | 基础态：`{ taskId, orgId, employeeId, taskType, input, errors[] }`                                         |
| `CompanyLead` / `MatchThresholds` / `LeadScore` / `LeadContact` | 获客中间态（含 `duplicate`/`excluded` 标记、`decisionInfluencePct` 等）                                    |
| `LeadHuntingState`                                              | 获客图 State                                                                                               |
| `EmailMessageRef` / `KnowledgeChunkRef` / `EmailReplyState`     | 邮件回复图 State（`thread`/`detectedLanguage`/`intent`/`copilot`/`knowledgeRefs`/`draft`/`sentMessageId`） |
| `FollowUpState`                                                 | 跟进图 State（`strategyStep`/`customer`/`repliedSinceLast`/`content`/`nextStep`）                          |
| `ProgressOf<S>`                                                 | 节点进度贡献纯函数类型：`(state) => number`                                                                |

### language.ts — 邮件语言检测

`detectEmailLanguage(body)`：**确定性纯函数**（无 AI），回复语言跟随最近一条 `in` 消息；
`message.language` 有值时以落库值为准，缺失时才调用。
CJK 字符占比 ≥ **10%** 判 `zh`，否则 `en`（空正文/无 CJK 信号默认英文）。
与邮件同步链路共用同一实现，杜绝双口径。

### prompt-guard.ts — Prompt 上下文守卫

08 安全设计与合规 §6/§7（M3-16）。

| 导出                                                  | 说明                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROMPT_SENSITIVE_KEYS`                               | 默认敏感键 deny-list（成本口径）：`costPrice` / `cost_price` / `purchasePrice` / `purchase_price` / `purchase_cost` / `unitCost` / `unit_cost` / `采购成本` |
| `UNTRUSTED_BOUNDARY_BEGIN` / `UNTRUSTED_BOUNDARY_END` | 不可信外部内容边界标记                                                                                                                                      |
| `stripSensitiveFields(value, extraDenyKeys?)`         | 递归剥离敏感键并返回**副本**（数组/嵌套对象均覆盖，不改入参；非对象原样返回）；支持调用方追加 deny 键                                                       |
| `boundExternal(content)`                              | 外部不可信文本 → 带边界标记的 prompt 片段（邮件原文/网页正文/文档检索内容注入前调用）                                                                       |

> 接线：`runtime.compiler.renderTemplate` 已对模板对象变量统一剥离敏感键（结构化数据唯一出口）；
> `workflows.loadThread` 对客户来信 body 包边界标记。只做值处理、不抛错。

### module-enablement.ts — 模块启用判定

M5-A1 · 产品总览 §5.1 **D1~D12 降级矩阵统一收口**，是「模块是否启用」的**唯一事实源**。

| 导出                       | 说明                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MODULE_KEY` / `ModuleKey` | 可判定模块键：`product_center` / `quote_center` / `order_center` / `ai_manager` / `task_ops` / `data_center` |
| `ModulePhase`              | 交付阶段：`'p0'`(已启用) / `'p1'`(未启用)                                                                    |
| `MODULE_PHASE`             | 模块阶段登记表（P0 基线全部 `'p1'`，模块交付时逐项翻转）                                                     |
| `isModuleEnabled(module)`  | 是否启用：聚合接口据此决定是否返回对应 metric/页签/建议                                                      |
| `listEnabledModules()`     | 当前启用模块清单（调试/自检用）                                                                              |

> 口径：P0/P1 边界由交付版本决定，**不做运行时功能开关 UI**；聚合接口只返回已启用模块的数据
> （未启用 metric **不返回**，而非返回 0）。P1 模块交付时翻转登记表即恢复，无需改消费方。

---

## 契约边界与约定

- **值域一致**：`sseStatusPayloadSchema` 的 status 子集、`APPROVAL_LOG_ACTION` 与 `APPROVAL_STATUS` 同域等，
  刻意从枚举派生，保证「枚举改了、schema 跟着变」。
- **避免反向依赖**：`notify.ts` 的 `NOTIFY_EVENT_KEY` 与 DB `NotificationEventKey` **同域但独立声明**，
  以防 `db → shared` 形成依赖环；改动时两侧须同步（注释已标注）。
- **错误码不在此包**：`Envelope.code` 仅声明为 `number`，具体取值与映射在 `@tradepilot/core`（error-codes），
  避免底层互依赖。
- **模型供应商不进 env**：见 `contracts/env.ts`，改由 AI 模型配置台账读库解析。
- **前后端边界**：本包当前仅被 server 侧消费；前端如需共享枚举/契约，另行约定（勿直接跨栈引用）。

---

## 测试

```bash
pnpm --filter @tradepilot/shared test
```

- `test/language.test.ts`：`detectEmailLanguage` 确定性检测（中文→zh、英文→en、夹签名不翻转、
  中文标点计入 CJK、空/空白/null/undefined→en）。

> `test` 脚本带 `--passWithNoTests`；契约类模块以「类型 + Zod schema」为主，由消费方单测/集成测试间接覆盖。

---

## 开发

```bash
pnpm --filter @tradepilot/shared build      # tsc 构建到 dist/
pnpm --filter @tradepilot/shared typecheck  # 类型检查
pnpm --filter @tradepilot/shared test       # vitest 单测
pnpm --filter @tradepilot/shared lint       # eslint
```

**约定**：

1. 新增枚举/常量：值用**小写蛇形**、`as const` 收口，并同步导出 `(typeof X)[keyof typeof X]` 联合类型。
2. 新增契约：需要运行时校验的用 **Zod** 表达并导出 `z.infer` 类型；仅在类型层面够用的用纯 `interface`。
3. 变更已发布契约（枚举取值、schema 字段、队列名、频道名）属**破坏性变更**，须同步所有消费方并核对文档。
4. 保持**零本地依赖**：新增依赖前先确认能否用 `zod` / 语言内建能力替代；绝不引入 Nest/Drizzle/Redis。
5. 契约注释标注来源章节（产品文档 / 接口总览 / 后端技术方案），便于评审对照。
