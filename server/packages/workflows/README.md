# @tradepilot/workflows

TradePilot 后端的 **P0 任务工作流装配包**：把「三张注册表（prompts / outputSchemas / flows）+
SOP 图定义 provider + 终态 outputs 组装」收敛为一份可被 Worker 注入 `GraphCompiler` / `TaskRunner` 的实现。

依据 LangGraph 工作流 00（§2~§7）；本包只负责**图定义与节点实现**，图执行、审批门控、LLM 网关、
事件总线等运行时能力由 `@tradepilot/runtime` 承载。

> 定位：依赖方向 **`workflows` → `runtime` / `db` / `core` / `shared`**（+ `drizzle-orm`、`zod`）。
> `runtime` **不反向依赖**本包——`GraphCompiler` 只面向 `FlowRegistry` / `PromptRegistry` /
> `OutputSchemaRegistry` 与 `TaskSopProvider` 接口，由 Worker 在启动时注入本包实现（接口注入，非硬编码）。
> 工具（`knowledge_search` / `web_search` / `email_send` …）由图以**名字**引用，经运行时注入的
> `ToolRegistry` 解析，故本包不在依赖中直连 `@tradepilot/tools`。

---

## 目录

- [设计原则](#设计原则)
- [目录结构](#目录结构)
- [模块一览](#模块一览)
  - [sops.ts — SOP 图定义与 State 通道键](#sopsts--sop-图定义与-state-通道键)
  - [prompts.ts — 提示词注册表](#promptsts--提示词注册表)
  - [output-schemas.ts — 结构化输出契约](#output-schemasts--结构化输出契约)
  - [flows.ts — flow 节点注册表](#flowsts--flow-节点注册表)
  - [outputs.ts — 类型化 outputs 组装](#outputsts--类型化-outputs-组装)
- [四张 SOP 图](#四张-sop-图)
- [执行接线](#执行接线)
- [关键约定](#关键约定)
- [测试](#测试)
- [开发](#开发)

---

## 设计原则

1. **契约与实现分离**：`runtime` 定义 `FlowRegistry` / `PromptRegistry` / `OutputSchemaRegistry` /
   `TaskSopProvider` 接口，本包提供 P0 实现；运行时可脱离本包单测。
2. **单一事实源**：`promptRef`、`outputSchema` 名与 `flows.ts` 注册键**跨文件一一对应**，
   由 `sops.ts` 的图定义串起来，新增节点须三处同步。
3. **确定性优先**：能用规则判定的绝不用 AI——评分分档（`mapScoreLevel`）、去重、频控顺延、
   意图枚举映射均为纯函数；LLM 输出仅作参考/素材。
4. **RLS fail-closed**：所有 flow 的 DB 访问一律经 `withOrg`（带 `orgId` 的租户事务），
   不裸连、不跨租户。
5. **硬约束 schema**：所有 `outputSchema` 一律 `.strict()`——LLM 多产未知键即校验失败并随重试回喂，
   杜绝「未知键被 Zod 静默剥离」。

---

## 目录结构

```
src/
├── index.ts            # 包入口：统一重导出三注册表 + SOP provider + outputs
├── sops.ts             # 四图 SOP 定义 + stateKeys + workflowSopProvider
├── prompts.ts          # 8 个 promptRef 模板 + createPromptRegistry
├── output-schemas.ts   # 7 个结构化输出 Zod 契约 + createOutputSchemaRegistry
├── flows.ts            # 17 个 flow 节点实现 + createFlowRegistry / mapScoreLevel
└── outputs.ts          # buildWorkflowOutputs：按 taskType 组装类型化产出
```

---

## 模块一览

### sops.ts — SOP 图定义与 State 通道键

| 导出                       | 说明                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `WORKFLOW_SOP_DEFINITIONS` | `taskType → SopGraphDefinition` 直接映射（诊断/测试用）            |
| `workflowSopProvider`      | `TaskSopProvider` 实现，Worker 注入 `GraphCompiler` / `TaskRunner` |

`TaskSopProvider` 两个方法：

- `get(taskType)` → `{ sop, stateKeys }`；未知 `task_type` 抛 `BizException(NOT_FOUND)`。
- `buildOutputs(taskType, finalState)` → 类型化 outputs（委托 `buildWorkflowOutputs`），未注册类型返回 `null`
  走 runner 通用兜底。

**四个 taskType 的 `stateKeys`** = `BaseTaskState` 六键（`taskId`/`orgId`/`employeeId`/`taskType`/`input`/`errors`）

- 文档 State 字段 + **编排辅助键**：

| taskType           | 文档字段                                                                                           | 编排辅助键                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `lead_hunting`     | `parsed` / `searchQueries` / `discovered` / `scored` / `contacts` / `targetCount`                  | `searchPlan` / `searchResult` / `siteSummary` / `currentScore` / `crmLeads` / `knowledgeChunks` / `lookupResult` |
| `email_reply`      | `thread` / `detectedLanguage` / `intent` / `copilot` / `knowledgeRefs` / `draft` / `sentMessageId` | `inboxMessageId` / `conversationId` / `customerId` / `customerSnapshot` / `knowledgeChunks` / `messageId`        |
| `follow_up`        | `followUpTaskId` / `strategyStep` / `customer` / `repliedSinceLast` / `content` / `nextStep`       | `conversationId` / `customerId` / `knowledgeChunks` / `messageId`                                                |
| `product_analysis` | —（`input` 播种 `customerId` 或 `leadIds`）                                                        | `analysisTargets` / `copilot`                                                                                    |

> **为何有辅助键**：LangGraph `LastValue` 通道无 reducer，无法在 State 内累积；跨轮累积一律走
> `ctx.bag`（见 `flows.ts`），State 只保留「文档契约字段 + 工具出参桥接所需的中间键」。
> `stateKeys` 供 `GraphCompiler` 建通道；`input` 顶层同名键由 runner 播种进初始 State。

### prompts.ts — 提示词注册表

8 个 `promptRef` 模板（lead_hunting 3 / email_reply 3 / follow_up 1 / product_analysis 1），
只锁 I/O 契约，文案为 M3 基线（M4 调优）。`{{var}}` 点路径插值由 `runtime.renderTemplate` 处理。

| 导出                        | 说明                                  |
| --------------------------- | ------------------------------------- |
| `registerPrompts(registry)` | 注册全部模板到 `SimplePromptRegistry` |
| `createPromptRegistry()`    | 新建并注入全部模板（Worker 装配用）   |

`promptRef` 清单：`leadHunting.parseGoal` / `leadHunting.planSearch` / `leadHunting.matchProduct` /
`sales.analyzeIntent` / `sales.copilotAnalyze` / `sales.draftReply` / `sales.productAnalysis` /
`followUp.generate`。

### output-schemas.ts — 结构化输出契约

7 个 Zod 契约（名字与 SOP `llm` 节点 `outputSchema` 一一对应），**全部 `.strict()`**。

| 导出                    | 契约要点                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `parsedGoalSchema`      | `{ targetMarket?, customerType?, targetProduct?, companySize? }`（全部可选，缺失留空）                                                     |
| `searchPlanSchema`      | `{ queries[1~10], targetCount[1~100] }`                                                                                                    |
| `leadScoreSchema`       | `{ companyName, matchPct[0~100], scoreLevel?, reasons[] }`；`scoreLevel` **optional**（以 `matchPct` 确定性映射为准，`record_score` 覆写） |
| `intentSchema`          | `{ label, confidence[0~1] }`                                                                                                               |
| `copilotSchema`         | `{ purchaseProbability[0~100], stage, recommendedActions[] }`                                                                              |
| `draftReplySchema`      | `{ subject, body, grounded, missingInfo? }`（`grounded=false` + `missingInfo` → `need_info` 分支）                                         |
| `followUpContentSchema` | `{ subject, body, grounded }`                                                                                                              |

| 装配导出                          | 说明                                            |
| --------------------------------- | ----------------------------------------------- |
| `registerOutputSchemas(registry)` | 注册全部 schema 到 `SimpleOutputSchemaRegistry` |
| `createOutputSchemaRegistry()`    | 新建并注入全部 schema（Worker 装配用）          |

### flows.ts — flow 节点注册表

17 个 `FlowNodeFn`（`(state, ctx) → { patch, branch, done }`），DB 访问一律 `withOrg`。

**lead_hunting（5 个）**

| 节点             | 语义                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedup_check`    | 三级去重：`excludeDomains` / `companySizeRange` 硬过滤 → 任务内 `seenKeys` → 发现池/CRM 查重（归一化域名优先，`lower(company_name)` 兜底）。每轮仅产出首个新公司 → `discovered=[current]`；无新公司 → `duplicate`；`maxRounds`（默认 5）守护防死循环。按去重键留存 `leadIdentity`（域名/官网/国家） |
| `record_score`   | `scoreLevel` 按 `matchPct` + `matchThresholds` **确定性覆写**；累积 `scoredAll`；低于 Medium 分档线 → `low`（不进联系人发现），否则 `matched`                                                                                                                                                       |
| `target_reached` | `scored ≥ targetCount` 或轮次耗尽 → `save`，否则 `continue` 回 `web_search`                                                                                                                                                                                                                         |
| `assemble_leads` | `scored × contacts` **按去重键**（非公司名）归并 + 回填身份 → `crmLeads`                                                                                                                                                                                                                            |
| `finalize`       | 产出统计落 `ai_task_log` **后**推日志事件（先落库再推，保证实时与 `?after=` 回放同构）                                                                                                                                                                                                              |

**email_reply（4 个）**

| 节点           | 语义                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_thread`  | `inboxMessageId → conversationId → customerId`；加载最近会话；**对来信（`direction=in`）body 包 `boundExternal` 边界标记防注入**；语言跟随（落库 `language` 优先，缺失 `detectEmailLanguage` 检测并**回写** `message.language`）；加载客户画像快照 |
| `draft_branch` | `draft.grounded=true → grounded`；否则 `need_info`                                                                                                                                                                                                 |
| `need_info`    | 不发送，`draft.missingInfo` 随 outputs 留存；仍写回会话洞察（右栏展示）                                                                                                                                                                            |
| `writeback`    | 写会话洞察 + `customer_activity`（`ai_action`）                                                                                                                                                                                                    |

**follow_up（6 个）**

| 节点                  | 语义                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_context`        | `follow_up_task` → 客户 `stage`/`score` → `customer.tier`（85/60 分档）                                                                                                         |
| `check_replied`       | 扫描上次触达后客户回复（撞车防护）→ `replied`/`no`；缓存 `lastOutboundAt`（L）供频控复用                                                                                        |
| `pause_strategy`      | 转人工：`follow_up_task.status=paused` + CRM 活动记录                                                                                                                           |
| `select_step`         | 取首个未执行策略步（按 `follow_up_execution.status='sent'` 消费标记）；走完 → `done`                                                                                            |
| `writeback_execution` | 落 `follow_up_execution(sent)` + `lastExecutedAt` + 活动记录（`strategyStep.id` 为幂等锚点）                                                                                    |
| `schedule_next`       | 候选 = `max(策略基准 + dayOffset, L + minTouchIntervalDays)` → `core.computeDeferredNextRunAt` 按 `org.timezone` 窗口对齐；有下一步 → `scheduled`，走完 → `completed`（`done`） |

**product_analysis（2 个）**

| 节点                     | 语义                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `load_analysis_context`  | `customerId`（客户 360）或 `leadIds`（批量分析）→ `analysisTargets`                                                                      |
| `write_customer_insight` | 仅 `customerId` 场景写 `customer_insight`（按 `(customer_id, insight_type)` upsert，`taskId` 溯源）；`leadIds` 场景随 outputs 留存不落表 |

| 装配导出                               | 说明                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `mapScoreLevel(matchPct, thresholds?)` | 分档纯函数：`≥high`(默认 85) → high、`≥medium`(默认 60) → medium、否则 low |
| `registerFlows(registry)`              | 注册全部 17 个 flow                                                        |
| `createFlowRegistry()`                 | 新建并注入全部 flow（Worker 装配用）                                       |

### outputs.ts — 类型化 outputs 组装

`buildWorkflowOutputs(taskType, finalState)` → `[{ type: 'leads' | 'draft' | 'insight', payload }]`；
未注册 `taskType` 返回 `null`（runner 回落通用 result 包裹）。

| taskType           | 产出                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead_hunting`     | `leads`：`{ leads, foundCount, analyzedCount, highValueCount }`                                                                                 |
| `email_reply`      | `draft`（含 `missingInfo`）+ `insight`（`intent` / `copilot`，**不发送也落**供右栏展示）                                                        |
| `follow_up`        | `replied` → 仅 `insight`（`{ paused, handoff:'human', reason:'customer_replied' }`）；否则 `draft` + `insight`（策略步/`messageId`/`nextStep`） |
| `product_analysis` | `insight`（`copilot` + `customerId` + `targets`）                                                                                               |

---

## 四张 SOP 图

节点 `kind`：`llm` / `tool` / `flow`；`tool` 节点 `risk=medium`（如 `email_send`）执行前**自动进 Approval Gate**，图中不手写 `interrupt`。

**lead_hunting**（version 2，entry `parse_goal`）：

```
parse_goal(llm) → retrieve_knowledge(tool) → plan_search(llm) → web_search(tool) → dedup_check(flow)
  dedup_check ─new→ crawl_site(tool) → match_product(llm) → record_score(flow)
  dedup_check ─duplicate→ target_check
  record_score ─matched→ find_contact(tool) → lookup_contact(tool) → target_check
  record_score ─low→ target_check
  target_check ─continue→ web_search（循环）
  target_check ─save→ assemble_leads(flow) → save_to_crm_pool(tool crm_write) → finalize(flow)
```

**email_reply**（version 1，entry `load_thread`）：

```
load_thread(flow) → analyze_intent(llm) → copilot_analyze(llm) → retrieve_knowledge(tool)
  → draft_reply(llm) → draft_branch(flow)
  draft_branch ─grounded→ email_send(tool·risk=medium·approvalType=email_send) → writeback(flow)
  draft_branch ─need_info→ need_info(flow)
```

**follow_up**（version 1，entry `load_context`）：

```
load_context(flow) → check_replied(flow)
  check_replied ─replied→ pause_strategy(flow)
  check_replied ─no→ select_step(flow) → retrieve_content(tool) → generate_follow_up(llm)
    → email_send(tool·risk=medium) → writeback_execution(flow) → schedule_next(flow)
```

**product_analysis**（version 1，entry `load_analysis_context`）：

```
load_analysis_context(flow) → analyze_customer(llm·outputSchema=copilot) → write_customer_insight(flow)
```

---

## 执行接线

Worker 启动时装配（`apps/worker/src/index.ts`）：

```ts
const compiler = new GraphCompiler({
  tools, // ToolRegistry（按名解析 knowledge_search / email_send …）
  flows: createFlowRegistry(), // 本包
  prompts: createPromptRegistry(), // 本包
  outputSchemas: createOutputSchemaRegistry(), // 本包
  checkpointer: checkpointer.saver,
});
const runner = new TaskRunner({
  /* … */
  compiler,
  sops: workflowSopProvider, // 本包：SOP + stateKeys + 类型化 outputs
});
```

> API 侧如需同一输出契约（如 `conversations` 草稿），**刻意不引入本包**，而是就地声明同构 Zod
> （见 `conversations.service.ts`），避免 API 依赖图定义层。

---

## 关键约定

- **三处同步**：新增一个 LLM/工具节点时，`sops.ts` 的 `promptRef`/`outputSchema` 名、
  `prompts.ts` 模板键、`output-schemas.ts` 注册键必须一致，否则编译或运行期报「未知引用」。
- **累积走 `ctx.bag`**：`scored/discovered/contacts` 的跨轮累积、`seenKeys`/`leadIdentity`/`rounds`/
  `lastOutboundAt` 等编排状态都在 `bag`；State 字段只保留文档契约与桥接键。
- **身份以发现阶段为准**：`match_product` 只决定 `matchPct` 与理由，`companyName` 由 `discovered` 回填
  （mock provider 会把名字退化为 `mock-*`）；`assemble_leads` 与联系人归并**一律按去重键**非公司名。
- **语言跟随**：`detectedLanguage` 取最近一条 `in` 消息的落库 `language`，缺失才确定性检测；
  检测结果回写 `message.language`，保证「详情 / 草稿 / 状态」同源。
- **先落库再推事件**：日志类产出必须先写 `ai_task_log` 再 `ctx.events.push`，保证 SSE 实时与
  `/logs?after=` 回放一致、断线不丢。
- **`.strict()` 硬约束**：所有输出契约必须 `.strict()`，禁止静默剥离未知键（对齐 order-parse 教训）。

---

## 测试

本包无独立单测（`package.json` 未提供 `test` 脚本）；行为由 **worker 集成测试**覆盖：

- `apps/worker/test/full-chain.integration.spec.ts` — 三图端到端。
- `apps/worker/test/m4-email-followup.integration.spec.ts` — email_reply / follow_up。
- `apps/worker/test/m4-dryrun.integration.spec.ts` — dry-run 装配。
- `apps/worker/test/m5-insight-writeback.integration.spec.ts` — 洞察写回。
- `apps/worker/test/m5-d3-schedule-consistency.integration.spec.ts` — 排期/频控一致性。

---

## 开发

```bash
pnpm --filter @tradepilot/workflows build      # tsc 构建到 dist/
pnpm --filter @tradepilot/workflows typecheck  # 类型检查
pnpm --filter @tradepilot/workflows lint       # eslint
```

**新增任务图的步骤**：

1. 在 `sops.ts` 增加 `SopGraphDefinition` 与 `TASK_SOPS` 条目（含 `stateKeys`）。
2. `output-schemas.ts` 增加 Zod 契约并注册；`prompts.ts` 增加对应模板。
3. `flows.ts` 实现并注册新 flow；必要时在 `outputs.ts` 增加 `buildWorkflowOutputs` 分支。
4. 遵循「确定性优先 + `withOrg` + `.strict()` + 先落库再推事件」四条硬约定。
