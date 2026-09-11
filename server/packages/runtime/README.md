# @tradepilot/runtime

TradePilot 后端的 **Agent 运行时承载包**：把「任务领取 → 图执行 → 审批挂起/恢复 → 终态收尾」这条主链路，
以及其上的 **LLM 网关**、**审批门控（Approval Gate）**、**记忆读写**、**事件总线**、**入队封装**
收敛为一组可被 Worker / API 装配复用的组件。

依据后端技术方案 **05（Agent Runtime 与 LLM 网关）、04（任务调度与队列）**。

> 定位：依赖方向 **`runtime` → `tools` / `db` / `core` / `shared`**。
> `workflows`（图定义与 prompts）**不是** runtime 的依赖，而是以接口形式注入——
> `GraphCompiler` 只面向 `FlowRegistry` / `PromptRegistry` / `OutputSchemaRegistry` 与 `TaskSopProvider`，
> 由 Worker 装配 `@tradepilot/workflows` 的实现。

---

## 目录

- [设计原则](#设计原则)
- [目录结构](#目录结构)
- [模块一览](#模块一览)
  - [runner.ts — TaskRunner（执行骨架）](#runnerts--taskrunner执行骨架)
  - [compiler.ts — GraphCompiler（SOP → 图）](#compilerts--graphcompilersop--图)
  - [approval-gate.ts — Approval Gate（审批门控）](#approval-gatets--approval-gate审批门控)
  - [llm-gateway.ts — LLM 网关](#llm-gatewayts--llm-网关)
  - [model-config.ts — 模型配置解析](#model-configts--模型配置解析)
  - [llm-probe.ts — LLM 连通性探活](#llm-probets--llm-连通性探活)
  - [events.ts — 任务事件总线](#eventsts--任务事件总线)
  - [enqueue.ts — 入队封装](#enqueuets--入队封装)
  - [memory.ts — 三层记忆（读侧）](#memoryts--三层记忆读侧)
  - [context.ts — 运行时上下文](#contextts--运行时上下文)
  - [release-employee.ts — 员工终态回写前置校验](#release-employeets--员工终态回写前置校验)
  - [checkpoint.ts — LangGraph 检查点](#checkpointts--langgraph-检查点)
- [执行主链路](#执行主链路)
- [审批挂起与恢复](#审批挂起与恢复)
- [进程级装配](#进程级装配)
- [测试](#测试)
- [开发](#开发)

---

## 设计原则

1. **接口注入、实现分离**：runtime 只依赖「注册表接口 + 提供方接口」，三个图（lead_hunting / email_reply /
   follow_up）的具体节点实现、prompts、输出 schema 由 `workflows` 包提供并在装配时注入。
2. **DB 是权威挂起态**：审批挂起不依赖 LangGraph 原生 `interrupt()`，而是落库 `waiting_approval` +
   抛 `ApprovalPendingError`，job 正常结束；恢复 = re-enqueue 后 `invoke(null)` 从检查点续跑。
3. **每节点一事务**：节点内所有 DB 写共享一个 `withOrg` 事务（RLS fail-closed）；事务提交后
   才 flush 该节点缓冲的 SSE 事件（防订阅方先于提交读库）。
4. **幂等贯穿全链**：`jobId=taskId` 防重复入队、步骤表 `[taskId, seq]` upsert、审批单
   `(task, node)` 复用、工具幂等键——任一层重放都安全。
5. **失败分类决定去路**：审批挂起 / 外部暂停（`paused`）/ 额度耗尽（`paused`）/ 真失败（`failed`）
   语义分离，绝不互相覆盖（终态写回带 `status` 前置）。
6. **mock 先行**：`LlmGateway` 的 mock provider 由 Zod schema 驱动确定性产出，保证三工作流全链路
   可离线测试（真实 provider 随 M4 接入）。

---

## 目录结构

```
src/
├── index.ts             # 包入口：统一重导出全部运行组件与类型
├── runner.ts            # TaskRunner：领取 → 图执行 → 终态收尾骨架
├── compiler.ts          # GraphCompiler：SOP jsonb → LangGraph StateGraph + 三个注册表
├── approval-gate.ts     # ApprovalGate：分流放行链 / 挂起落库 / 恢复 / 自动放行留痕
├── llm-gateway.ts       # LlmGateway：provider 适配 / org 路由 / 结构化输出 / 记账与预算
├── llm-probe.ts         # probeLlmConnection：保存模型配置前的连通性探活
├── model-config.ts      # resolveActiveModel + to{Embedding,Search}ProviderConfig（16 FR-10）
├── events.ts            # 任务事件总线（seq / 事件构造 / publisher / flush）
├── enqueue.ts           # TaskEnqueuer：四条入队 + resume / email_sync / knowledge_index / notify
├── memory.ts            # 三层记忆读侧助手（客户画像 / 会话消息 / org memory）
├── context.ts           # EmployeeRuntime / OrgRuntime / NodeTxContext / TaskRunContext
├── release-employee.ts  # releaseEmployeeIdle：员工终态回写前置校验（M3-06）
└── checkpoint.ts        # createCheckpointer：LangGraph PostgresSaver（schema=langgraph）
```

---

## 模块一览

### runner.ts — TaskRunner（执行骨架）

单任务执行的**唯一入口**（05 §2 / 04 §5）。`run(taskId, { resume? })` 顺序：

| 步骤         | 内容                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| ① 跨租户定位 | `SET LOCAL app.sched='1'` 放行 `SELECT` 读取任务行（02 §4.3）；不存在 → `{ status: 'missing' }`                        |
| ② 乐观锁领取 | `scheduled → running`（resume 时 `waiting_approval → running`，已 running 幂等放行）；未命中 → `{ status: 'skipped' }` |
| ③ 快照加载   | 组装 `EmployeeRuntime` / `OrgRuntime` → `TaskRunContext`（resume 时 `bag.resumeApproval`）                             |
| ④ 心跳       | Redis `task:{id}:heartbeat`，30s 间隔 / 90s TTL（供 ZombieReaper 判定）                                                |
| ⑤ 图执行     | `compiler.compile(...)` → `graph.invoke(...)` → `buildOutputs` → 终态写回                                              |

**终态映射**（`RunTaskResult.status`）：

| 情形                         | 状态                    | 说明                                                 |
| ---------------------------- | ----------------------- | ---------------------------------------------------- |
| 正常完成                     | `completed` + `outputs` | 回写 `progressPct=100`，员工按前置校验释放           |
| `ApprovalPendingError`       | `waiting_approval`      | gate 已落库，仅清心跳 + flush 挂起事件，job 正常结束 |
| `PauseAbortError`            | `paused`                | 员工级 pause 协作收口，不覆盖 API 已置的 `paused`    |
| `BizException(RATE_LIMITED)` | `paused`                | 外部调用日额度耗尽，次日额度重置后手动 resume        |
| 其它异常                     | `failed` + `error`      | 落 `ai_task.error` + error 日志 + 失败通知           |
| 完成/失败写回 0 行命中       | `paused`                | 执行期间被外部暂停 → 不覆盖终态                      |

**关键导出**：`TaskRunner`、`heartbeatKey(taskId)`、`TaskRunnerDeps`、`TaskSopProvider`、`ResumeHint`、`RunTaskResult`。

- `TaskSopProvider`：`get(taskType) → { sop, stateKeys }` + 可选 `buildOutputs(taskType, finalState)`；
  后者返回 `null` 时回落通用 `result` 包裹（剥离运行时键后的全量 State）。
- `ResumeHint { nodeId, approvalId }`：审批通过后由 API 随 job 携带重入队。
- 员工并发=1 / org 并发=10 的领取闸门不在此处，属 Worker Dispatcher / API / Reconciler 职责。

### compiler.ts — GraphCompiler（SOP → 图）

把 SOP jsonb（`sop_template.content`）编译为 LangGraph `StateGraph`（05 §4）。

- **缓存键**：`orgId:taskType@sop.version`（含 org 维度防多租户交叉；SOP 修改不影响进行中任务）。
- **动态 State 通道**：`stateKeys` 每键 `Annotation<unknown>()` + `_branch`（`BRANCH_KEY`）。

**节点类型**：

| kind   | 执行体                  | 说明                                                                          |
| ------ | ----------------------- | ----------------------------------------------------------------------------- |
| `llm`  | `LlmGateway.structured` | `promptRef` → 模板插值（`scene=taskType`）→ Zod 输出校验（失败重试 2 次）     |
| `tool` | 校验链 + `ApprovalGate` | 白名单 → schema → 配额 → 风险分流；`medium/high` 走 Gate（resume 命中则跳过） |
| `flow` | `flows` 注册表          | `(state, ctx) → { patch, branch, done }`；`done` 写 `_branch=DONE` → END      |

**节点骨架 `runStep`**（`beginStep → exec → completeStep / failStep`）：

- `beginStep`：节点级暂停探测（任务已离开 `running` → 抛 `PauseAbortError`）+ `ai_task_step` upsert（`[taskId, seq]` 幂等）。
- `completeStep`：步骤置 `completed` + 可选节点日志 + `ai_task.progressPct` 累加（`least(100, ...)`）→ **事务提交后** flush 缓冲事件。
- `failStep`：置步骤 `failed`（审批挂起 / 外部暂停**豁免**，不落 failed）。

**工具桥接 `execTool`**：`withOrg` 单事务装配 `ToolContext`（`log` 绑定 `ai_task_log` + 事件缓冲）。
`tool` 节点执行顺序：`assertAllowed`（员工工具白名单）→ `parseInput`（Zod 入参即权限边界）→
`assertQuota`（`quotaWeight` + org 时区墙钟日分片）→ 风险分流 → `freshnessCheck`（仅 resume）。

**关键导出**（包根）：`GraphCompiler`、`ApprovalPendingError`、`renderTemplate`、
`SimplePromptRegistry` / `SimpleOutputSchemaRegistry` / `SimpleFlowRegistry`、
`BRANCH_KEY` / `DONE_KEY` / `DEFAULT_KEY` / `RECURSION_LIMIT(200)` 及各类接口与类型。

> `PauseAbortError` 定义于本模块并抛出，但**未在包根重导出**（消费方经 `TaskRunner` 的 `paused` 语义感知）。

### approval-gate.ts — Approval Gate（审批门控）

`medium` / `high` 风险工具的统一门控（05 §4）。**分流放行链**（`decide`，顺序判定，不落库）：

```
① riskLevel=high                          → interrupt（必人工）
② 强制人工例外（优先于 autoApprove）：
     Break-up Email（input.contentKind='breakup'）
     / approval_policy.email_send='always'
     / 'high_value_only' 且客户 score≥85      → interrupt
③ medium + org autoApprove + 员工 autoExecute 命中 → auto_approve（留痕）
④ 其余                                     → interrupt
```

| 方法                                     | 说明                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `decide(tool, ctx, input)`               | 纯判定，返回 `GateVerdict { action, approvalId?, reason }`                                                                                                                                             |
| `enterWaiting(tool, ctx, input)`         | 挂起落库（**幂等**）：`approval_request(pending)` + `ai_task.waiting_approval` + `linked_approval_id` + `follow_up_task` 冻结 + 员工 `waiting_approval` + SSE status；新建单才回调 `onPendingApproval` |
| `recordAutoApprove(tool, ctx, input)`    | `approval_request(auto_approved)` + `approval_log` + `ai_task_log` + SSE log 留痕                                                                                                                      |
| `markResumed(orgId, taskId, employeeId)` | 处置后恢复：`ai_task.running` + 员工 `working` + `follow_up_task.scheduled` + SSE status                                                                                                               |

**关键导出**：包根为 `ApprovalGate`、`APPROVAL_TTL_MS(48h)`、`GateToolMeta`、`GateVerdict`；
`approvalTtlMs(ctx, tool)`（按 `org.approvalTtlMsByType` 解析，非法值回落 48h）、`ApprovalGateHooks`、
`resolveSystemApproverId`（autoApprove 留痕 approver 兜底：任务创建人 → org 首个管理员）
均为**模块内导出**（未在包根重导出，测试从 `../src/approval-gate.js` 直接引用）。

> 客户分层：`score ≥ 85 → high`、`≥ 60 → medium`、其余 `low`（与 `memory.ts` 一致）。

### llm-gateway.ts — LLM 网关

Provider 适配 + org 级路由 + Zod 结构化输出 + 成本记账（05 §6）。

**路由 `resolveTarget(orgId, scene)`**（优先级）：

1. 「系统设置 → AI 模型配置」该 org **选用**的 LLM（`ai_model.is_selected`，凭据解密；模型/端点以选用为准，
   温度 / maxTokens 由场景配置精调）；
2. 场景配置 `ai_model_setting` 命中（沿用环境变量 provider + 场景模型）；
3. 默认兜底 `opts.defaultModel`（`degraded=true` 标记）。

**结构化输出 `structured(meta, schemaOut, messages)`**：

- `createChatModel` → `invoke` → `extractJson` → `schemaOut.safeParse`；
- **自纠正重试**：失败原因回喂下一次请求（`RETRY_LIMIT=3`，即首次 + 重试 2 次），仍失败抛错（节点失败）。
- 每次调用写 `llm_call`（`org/task/node/scene/model/tokens/cost/latency/degraded`）。

**预算**：`record` 内汇总当月 `sum(cost_usd)` 与 `budgetLimit` 对比，
`crossedBudget(prev, next, budget)`（仅「前值 ≤ 预算 < 后值」触发一次）→ 调 `opts.alert`（Worker 接 `q:notify`）。
**仅告警不熔断**（16 FR-10 口径）。

**关键导出**：`LlmGateway`、`extractJson`、`crossedBudget`、
`GatewayOptions`、`ModelTarget`、`LlmInvokeMeta`、`LlmUsage`、`StructuredResult`、`BudgetAlertInfo`、`LlmProvider`
（`'openai' | 'anthropic' | 'deepseek' | 'azure'`）。

### model-config.ts — 模型配置解析

「系统设置 → AI 模型配置」的 org 选用模型解析（16 FR-10），供 LLM / embedding / search **三类共用**。

| 导出                                                  | 说明                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveActiveModel(db, orgId, type, encryptionKey?)` | 读 `ai_model.is_selected=true` 行；`type ∈ llm/embedding/search`；未配置返回 `null`；`apiKeyEnc` 在此解密回填（缺 `encryptionKey` 跳过） |
| `ActiveModelConfig`                                   | 运行时可消费配置（`provider` / `model` / `baseUrl?` / `apiKey?` / `dimensions?` / `temperature` / `maxTokens?`）                         |
| `EMBEDDING_FIELD_DEFAULTS` / `SEARCH_FIELD_DEFAULTS`  | 字段级缺省（baseUrl/apiKey/model）；未配置选用模型时启动装配明确报错，不再回落 mock                                                      |
| `toEmbeddingProviderConfig(active, fallback)`         | 台账选用 → `EmbeddingProviderConfig`（字段逐项回落）                                                                                     |
| `toSearchProviderConfig(active, fallback)`            | 台账选用 → `SearchProviderConfig`                                                                                                        |

> 输出结构刻意与 `integrations` 的 `EmbeddingOptions` / `createSearchProvider` 入参**保持一致**，
> 但**不引包**（避免 `runtime → integrations` 依赖），保证依赖方向不变。

### llm-probe.ts — LLM 连通性探活

保存「AI 模型配置」前的极小化真实调用校验（`probeLlmConnection`）。
端点点径与 `LlmGateway.createChatModel` **保持一致**；`mock` 直接 `ok`；`maxTokens=16`、`temperature=0`、
默认 15s 超时（`AbortSignal.timeout`）；任何异常收敛为 `{ ok: false, message }`（截断 300 字）。
导出 `probeLlmConnection`、`LlmProbeOptions`、`LlmProbeResult`。

### events.ts — 任务事件总线

Worker 写库后 `PUBLISH` Redis 频道，API 订阅 → `after` 回放 → flush（04 §6）。

| 导出                                                                           | 说明                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `nextSeq()`                                                                    | 雪花事件序号（Crockford 编码，字典序 = 时间序，客户端去重游标）                         |
| `buildLogEvent` / `buildProgressEvent` / `buildStatusEvent` / `buildDoneEvent` | 四类事件构造（自动补 `seq` / `time`）                                                   |
| `TaskEventPublisher`                                                           | `publish` / `publishAll`，发布前经 `taskEventSchema` **zod 校验**（不符即抛，保证契约） |
| `flushBufferedEvents(publisher, taskId, buffered)`                             | 节点事务提交后，把缓冲事件转 `TaskEvent` 并发布，随后清空缓冲                           |

事件类型与频道由 `@tradepilot/shared` 约定（`SSE_EVENT_TYPE` / `taskEventChannel`）。

### enqueue.ts — 入队封装

`TaskEnqueuer`：四条入队路径（API 触发 / Scheduler 到期 / delayed job / 手动重试）**统一收口**（04 §1/§2）。

| 方法                                          | 说明                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `enqueueTask(taskId, taskType, { delayMs? })` | 按 `TASK_TYPE_QUEUE` 路由；`jobId=taskId`（同 id 活跃 job 唯一，天然防重）；`delayMs>0` → BullMQ delayed |
| `enqueueResume(taskId, taskType, resume)`     | 审批处置后重投，`job.data.resume={ nodeId, approvalId }`                                                 |
| `removeTask(taskId, taskType)`                | 取消 / 暂停 → 移除 delayed job                                                                           |
| `hasActiveJob(taskId, taskType)`              | 对账用：`waiting/active/delayed` 是否存在                                                                |
| `enqueueEmailSync(mailboxId)`                 | `q.email_sync`，`jobId=mbxsync.{mailboxId}`                                                              |
| `enqueueKnowledgeIndex(docId)`                | `q.knowledge_index`，`jobId=kidx.{docId}`                                                                |
| `enqueueNotify(payload)`                      | `q.notify`（削峰）                                                                                       |
| `close()`                                     | 关闭全部队列连接                                                                                         |

- `defaultJobOptions`：`attempts: 1`（任务级不自动重投，失败走手动重试 `retry_of`）、
  `removeOnComplete { age: 3600, count: 1000 }`、`removeOnFail { age: 24h }`。
- **`removeTerminalJob` 关键点**：BullMQ 5 对同 `jobId` 且仍存在的 job 是幂等 no-op，而终态 job 会留存，
  会导致周期性调度被静默吞掉；故 `email_sync` / `knowledge_index` 入队前先移除**终态**（`completed/failed`）历史 job，
  仅保留 `waiting/active/delayed` → `add` no-op 维持「同 id 活跃 job 唯一」互斥。
- `jobId` **禁含 `:`**（BullMQ 5 校验），统一用 `.` 分隔。

### memory.ts — 三层记忆（读侧）

05 §5 三层落地：Working = State + checkpointer；Task = `ai_task.outputs`；Org = 本文件读侧助手。

| 导出                                                        | 说明                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `loadCustomerInsights(db, orgId, customerId)`               | 客户画像快照：`customer` 档案 + `customer_insight` 全量（每类型单行）          |
| `loadRecentMessages(db, orgId, conversationId, { limit? })` | 会话最近消息（时间正序，默认 10 条，单条截断 2000 字，`EmailMessageRef` 同构） |
| `readOrgMemory(db, orgId, customerId?)`                     | **M3 空实现**返回 `[]`；写侧（拒绝原因回流）随反馈闭环 P1 落地                 |

全部走 `withOrg`（RLS fail-closed），供 workflows 的 flow 节点组装 LLM 上下文注入。

### context.ts — 运行时上下文

| 类型              | 说明                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskRunContext`  | 任务级上下文：`NodeTxContext` + `db` / `employee` / `org` / `task` / `progressPct` / `currentStep`，经 LangGraph `config.configurable` 传入节点 |
| `NodeTxContext`   | 节点级：`orgId/taskId/employeeId/nodeId/taskType` + `redis/logger/now/bag/events`（与 `tools.ToolContext` 的结构化子集兼容）                    |
| `EmployeeRuntime` | 员工快照：`tools` / `knowledgeScope` / `approvalPolicy` / `memoryConfig` / `externalCallDailyLimit`（领取时加载，任务内不变）                   |
| `OrgRuntime`      | org 快照：`timezone` / `sendRules` / `autoApproveTypes` / `approvalTtlMsByType`                                                                 |
| `OrgApprovalRule` | `role_permission.approval_rules` 行（`autoApprove` / `expireHours` 为运行时扩展）                                                               |

### release-employee.ts — 员工终态回写前置校验

`releaseEmployeeIdle(tx, { employeeId, excludeTaskId, now })`（M3-06）：任务终态回写员工 `idle` 前，
先确认该员工已无其它占用任务（`running` / `waiting_approval`，排除自身）。
须与终态任务 `update` **同事务**调用；返回 `false` 表示员工仍被占用，由占用任务终态再收口——
避免并发场景「任务 A 结束把正在跑任务 B 的员工误置 idle」。

### checkpoint.ts — LangGraph 检查点

`createCheckpointer(databaseUrl, { provisionSchema? })`：基于 `@langchain/langgraph-checkpoint-postgres`，
与业务库同实例、独立 `search_path=langgraph,public`（manual 迁移建表并授权），`thread_id = taskId`。

> `provisionSchema` 默认 **false**：checkpoint 4 表 DDL 归 manual 迁移以表 owner 执行；
> 运行时角色 `tradepilot_app` 无数据库级 CREATE 权限，调用 `setup()` 会 `42501`
> （首句即 `CREATE SCHEMA IF NOT EXISTS`）。仅在依赖升级补列时临时置 true（须具备 DDL 权限的连接串）。

包根导出 `createCheckpointer` 与 `CheckpointerHandle`；`CheckpointerOptions` 为模块内导出。

---

## 执行主链路

```text
TaskEnqueuer.enqueueTask（API / Scheduler / delayed / 重试）
  → BullMQ Worker.job（jobId=taskId）
  → TaskRunner.run(taskId)
      ① 跨租户定位（app.sched 放行）
      ② 乐观锁领取（scheduled→running）
      ③ 加载员工/org 快照 → TaskRunContext
      ④ 心跳 task:{id}:heartbeat（30s / 90s TTL）
      ⑤ GraphCompiler.compile(orgId, taskType, sop, stateKeys) → graph.invoke
           每个节点：beginStep → [llm | tool(+Gate) | flow] → completeStep → flushBufferedEvents
      终态：completed(+outputs) / waiting_approval / paused / failed
  → TaskEventPublisher（Redis PUBLISH task:{id}:events）→ API SSE
```

---

## 审批挂起与恢复

**未用** LangGraph 原生 `interrupt()` / `Command{resume}`，改为「DB 权威挂起态 + 异常中断」：

```text
compiler.toolExec：riskLevel ≠ low 且非 resume
  → ApprovalGate.decide
      ├─ execute ？（low 已在上游直执）
      ├─ auto_approve → recordAutoApprove（落库留痕）→ 继续执行工具
      └─ interrupt    → enterWaiting（单事务幂等落库）
                        → throw ApprovalPendingError(approvalId)
  → TaskRunner 捕获：清心跳 + flush 挂起事件 → job **正常结束**，任务保持 waiting_approval
────────────────── 审批处置（API 12 接口 → Worker resume job）──────────────────
approve / edited_approved
  → markResumed（waiting_approval→running、员工 working、follow_up_task scheduled）
  → TaskEnqueuer.enqueueResume(taskId, taskType, { nodeId, approvalId })
  → TaskRunner.run(taskId, { resume }) → invoke(null) 从检查点续跑
  → 命中工具节点（isResume）：freshnessCheck() 通过 → 真实执行
reject
  → 图走拒绝收尾（completed 带反馈）
```

- **幂等**：`enterWaiting` 对同 `(task, node)` 已有 pending 单复用不重建；`claim` 对已 `running`（`markResumed`
  先置位）幂等放行。
- **新鲜度校验**：`email_send` 重查会话是否已被人工回复 / 关闭；不通过则抛 `CONFLICT` 终止执行。
- **超时不归图处理**：由 Worker `ApprovalExpiryScanner` 统一级联。

---

## 进程级装配

Worker 是 runtime 的主要装配方（`apps/worker/src/index.ts`）：

| 组件                 | 装配要点                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Checkpointer`       | `createCheckpointer(env.DATABASE_URL, { provisionSchema: env.LANGGRAPH_CHECKPOINT_SETUP })`                                                                                                       |
| `TaskEventPublisher` | 复用 Worker 的 ioredis 连接                                                                                                                                                                       |
| `LlmGateway`         | `encryptionKey: env.ENCRYPTION_KEY`、`alert` → `enqueueNotify({ type: 'budget_limit' })`；不传 `provider`/`defaultModel`（org 未配置选用模型时 `resolveTarget` 明确报错，不再回落 mock）          |
| `ApprovalGate`       | `hooks.onPendingApproval` → `enqueueNotify({ type: 'approval_pending' })`                                                                                                                         |
| `GraphCompiler`      | 注入 `gateway` / `gate` / `createToolRegistry()` / `createFlowRegistry()` / `createPromptRegistry()` / `createOutputSchemaRegistry()`（后三者来自 `@tradepilot/workflows`）/ `checkpointer.saver` |
| `TaskRunner`         | 注入 `compiler` / `workflowSopProvider` / `onTaskFailed` → `enqueueNotify({ type: 'task_failed' })`                                                                                               |
| `TaskEnqueuer`       | `new TaskEnqueuer(env.REDIS_URL, logger)`                                                                                                                                                         |

API 侧直接消费的 runtime 组件：`TaskEnqueuer`（`knowledge.service` 投递索引）、
`LlmGateway`（`leads.service` / `conversations.service` 场景调用）、
`TaskEventPublisher` / `buildStatusEvent` / `buildDoneEvent` / `releaseEmployeeIdle`
（`employees.service` / `approvals.service`）。

> `resolveActiveModel` / `toEmbeddingProviderConfig` / `toSearchProviderConfig` 亦由 api / worker
> 启动时用于装配 embedding / search provider（详见 `@tradepilot/integrations` README）。

---

## 测试

```bash
pnpm --filter @tradepilot/runtime test
```

`test/` 下为**纯逻辑单测**（无外部依赖，fake Db / mock Redis）：

- `approval-gate.test.ts`：`decide` 分流放行链四档全覆盖（high / 强制人工例外 / auto_approve / 缺省 interrupt）
  与 `approvalTtlMs` 按类型超时解析。
- `llm-gateway.test.ts`：`crossedBudget` 跨阈值判定（首超 / 等值 / 持续超限 / 预算 0 / 异常防御）。
- `prompt-guard.test.ts`：`renderTemplate` 出口兜底（对象变量剥离敏感键、数组递归剥离）。

> 真实链路（图执行 / 审批挂起恢复 / worker 全链）为 **集成测试**，位于消费方 `apps/worker/test/`
> （`full-chain.integration.spec.ts`、`m4-dryrun.integration.spec.ts`、`m4-email-followup.integration.spec.ts`、
> `m5-insight-writeback.integration.spec.ts`、`m5-d3-schedule-consistency.integration.spec.ts` 等），
> 需 `docker compose up` + 迁移后再跑。

---

## 开发

```bash
pnpm --filter @tradepilot/runtime build      # tsc 构建到 dist/
pnpm --filter @tradepilot/runtime typecheck  # 类型检查
pnpm --filter @tradepilot/runtime test       # vitest 单测
pnpm --filter @tradepilot/runtime lint       # eslint
```

**约定**：

1. 新增节点类型 / 注册表：先定义**接口**，实现由消费方（`workflows`）注入，保持 runtime 不反向依赖业务实现。
2. 任何「挂起 / 暂停 / 终止」语义新增异常时，须在 `wrapNode` 豁免落 `failed`，并在 `TaskRunner` 统一收尾。
3. 节点内 DB 写一律经 `withOrg`（RLS），SSE 事件先缓冲、事务提交后再 `flushBufferedEvents`。
4. 新增入队路径统一经 `TaskEnqueuer`，`jobId` 不含 `:`，终态 job 入队前先清理以保重投必达。
5. 涉及 LLM 的产出必须经 Zod 结构化校验，mock provider 须保证 schema 驱动可复算。
