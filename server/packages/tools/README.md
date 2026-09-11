# @tradepilot/tools

TradePilot 后端的 **工具注册表与内置工具包**：定义 `ToolDefinition` 统一描述、`ToolRegistry`
校验链，并实装 P0 全部内置工具（外部信息类 + CRM/邮件读写类）。

依据后端技术方案 **05（Agent Runtime 与工具）**。工具是 AI 唯一的「手脚」——所有外部动作
（搜索、抓站、发信、写发现池、知识检索）都必须经工具出口，保证校验、配额、日志、幂等可收口。

> 定位：依赖方向 **`tools` → `core` / `db` / `integrations` / `shared`**（+ `drizzle-orm` /
> `ioredis` / `pino` / `zod`）。
> 本包只提供**元数据与钩子**：校验链①②④（白名单 / 入参 / 配额）在此实现；**风险分流③（Approval Gate）
> 与执行编排在 `@tradepilot/runtime`**（`GraphCompiler.toolExec` 按 SOP 节点装配）。

---

## 目录

- [设计原则](#设计原则)
- [目录结构](#目录结构)
- [模块一览](#模块一览)
  - [registry.ts — 工具注册表与校验链](#registryts--工具注册表与校验链)
  - [builtin/search-tools.ts — 外部信息类工具](#builtinsearch-toolsts--外部信息类工具)
  - [builtin/crm-tools.ts — CRM 与邮件读写工具](#builtincrm-toolsts--crm-与邮件读写工具)
  - [builtin/knowledge-search.ts — 知识混合检索](#builtinknowledge-searchts--知识混合检索)
  - [builtin/quotas.ts — org 时区与搜索配额](#builtinquotasts--org-时区与搜索配额)
  - [builtin/content-compliance.ts — 外发内容合规](#builtincontent-compliancets--外发内容合规)
  - [builtin/email-send-config.ts — 外发配置注入](#builtinemail-send-configts--外发配置注入)
- [内置工具清单](#内置工具清单)
- [校验链与执行时序](#校验链与执行时序)
- [关键约定](#关键约定)
- [测试](#测试)
- [开发](#开发)

---

## 设计原则

1. **工具即权限边界**：`inputSchema` 就是权限边界——AI 不可传 `ownerId` / `orgId` 等身份字段
   （org 由 `ToolContext` 注入，03 §5）。
2. **校验链收口**：白名单 → 入参 schema → 风险分流 → 配额，四步在一次执行前固定顺序完成，
   调用方不各自校验。
3. **确定性优先**：联系人归并键、决策影响力档位、评分分档、去重口径全部为可复算纯函数；
   mock 供应商的产出亦确定性（测试可断言）。
4. **事务与事件一致**：`ToolContext.tx` 为节点级 `withOrg` 单事务；工具内**先写 `ai_task_log`
   再缓冲 SSE 事件**，事件在事务提交后由 runner flush（防订阅方先于提交读库）。
5. **可注入、不碰 env**：外发配置 / 供应商 / 合规钩子由进程启动时注入（`configure*` / `set*`），
   本包不直读环境变量，便于 api / worker / test 各自装配。

---

## 目录结构

```
src/
├── index.ts                    # 包入口：createToolRegistry + 重导出
├── registry.ts                 # ToolContext / ToolDefinition / ToolRegistry / 日志与幂等
└── builtin/
    ├── search-tools.ts         # web_search / site_crawl / find_contact / lookup_contact / lead_scoring
    ├── crm-tools.ts            # crm_read / crm_write / email_read / email_send / knowledge_search
    ├── knowledge-search.ts     # searchKnowledgeChunks（三路召回 + RRF）
    ├── quotas.ts               # getOrgTimezone / assertOrgSearchQuota
    ├── content-compliance.ts   # 外发内容合规基线 + 可注入钩子
    └── email-send-config.ts    # email_send 外发配置注入
```

---

## 模块一览

### registry.ts — 工具注册表与校验链

| 导出                                        | 说明                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolContext`                               | 节点级工具执行上下文：`orgId` / `taskId` / `employeeId` / `nodeId` / `taskType` / `tx`(withOrg 事务) / `redis` / `logger` / `now` / `bag`(任务级缓存) / `log()` / `emit()` |
| `BufferedTaskEvent`                         | 事务提交后发布的缓冲事件：`{ type: 'log'\|'progress'\|'status'\|'done', payload }`                                                                                         |
| `ToolDefinition<I,O>`                       | 工具唯一描述（见下）                                                                                                                                                       |
| `ToolRegistry`                              | 注册表 + 校验链方法                                                                                                                                                        |
| `writeToolLog(ctx, type, content, leadId?)` | 写 `ai_task_log`（事务内）+ 登记 SSE `log` 事件，返回 `logId`                                                                                                              |
| `toolIdempotencyKey(ctx, salt?)`            | 幂等键：`idem:{taskId}:{nodeId}[:{salt}]`                                                                                                                                  |
| `withIdempotency(ctx, key, ttl, fn)`        | `SET NX` 抢占执行；重复调用返回 `{ first: false }`（结果由 DB 状态承载，重试不重复外发）                                                                                   |

**`ToolDefinition` 字段**：

| 字段                          | 说明                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `name` / `description`        | 工具名（SOP 按名引用）与描述                                     |
| `inputSchema: z.ZodType<I>`   | 入参 schema（即权限边界，校验链②）                               |
| `riskLevel: RiskLevel`        | `low` 直接执行；`medium`/`high` 经 Approval Gate（Runtime §4.7） |
| `approvalType?`               | 审批类型（如 `email_send`），风险分流时随 meta 传门控            |
| `quotaWeight?: 1 \| 2`        | 外部调用计权（search ×1 / crawl ×2，06 §3）；缺省 0 = 不计配额   |
| `freshnessCheck?(ctx, input)` | 审批 resume 后、真实执行前的新鲜度校验钩子                       |
| `execute(ctx, input)`         | 工具实现                                                         |

**`ToolRegistry` 方法**：

| 方法                                 | 链路        | 说明                                                                          |
| ------------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `register(tool)`                     | —           | 重复注册同名工具直接抛错                                                      |
| `get(name)` / `has(name)`            | —           | 未注册 `get` 抛 `BizException(NOT_FOUND)`                                     |
| `assertAllowed(tool, employeeTools)` | **①白名单** | 员工 `tools` 不含该工具 → `FORBIDDEN`（40301）                                |
| `parseInput(tool, input)`            | **②入参**   | `safeParse` 失败 → `BAD_REQUEST`（错误信息汇总 issues）                       |
| `assertQuota(ctx, tool, dailyLimit)` | **④配额**   | 员工级外部调用日额度令牌桶；`weight=0` 直接放行；超限 `RATE_LIMITED`（42901） |

> 配额日 key 按 **org 时区墙钟日**分片（`zonedDayKey`，`quota:{orgId}:{employeeId}:{day}`，TTL 48h），
> `timezone` 由调用方从 `TaskRunContext.org.timezone` 快照传入，此处不查库。
> 风险分流③由 `runtime` 的 `ApprovalGate` 编排，本包不实现。

### builtin/search-tools.ts — 外部信息类工具

| 导出                            | 说明                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEFAULT_JOB_TITLES`            | 默认职衔白名单：`Purchasing Manager` / `Buyer` / `Sourcing Manager` / `Procurement Director`                                                                                         |
| `mapDecisionInfluence(title)`   | 决策影响力确定性映射：**90**（Director/VP/Head/Chief/CPO **且**采购职能）/ **75**（采购执行层 Manager/Buyer/Merchandiser）/ **40**（Engineer/R&D/Quality）/ `null`（未命中，不猜测） |
| `registerSearchTools(register)` | 注册 5 个外部信息类工具                                                                                                                                                              |

工具要点：

- `web_search`（quota ×1）：按轮次换词（`bag.searchRound` 轮换 `queries`）→ org 级搜索日额度 → 按 org
  解析搜索供应商 → hit 转公司候选（域名 + 标题派生公司名）。mock 供应商额外补确定性 `employeeCount`/`country`。
- `site_crawl`（quota ×2）：抓官网关键页生成摘要；**单站不可达不中断任务**——记日志后以空摘要降级
  （`reachable:false` + `note`）。
- `find_contact`：从确定性 mock 池产出联系人，按 `jobTitles` 白名单排序（命中优先）+ 影响力降档；
  **仅产职衔/姓名，不产联系方式**；跨轮累积写入 `bag.contactsAll`。
- `lookup_contact`（quota ×1）：为已有联系人补全**公开商务渠道**邮箱（GDPR/CCPA 边界，03 §4）；
  按去重键（域名优先）匹配，不跨公司串数据。
- `lead_scoring`：确定性规则评分（关键词 +10/项封顶 30、地区 +5，基线 55，封顶 97）+ 可解释 `reasons`；
  M4-1 后 `match_product` 以 LLM 直出，本工具保留为降级/独立评分入口。

> 域名归一 / 归并键（`normalizeDomain` / `entityKey`）与 `flows.ts` 同口径：**归一化域名优先，名称兜底**。

### builtin/crm-tools.ts — CRM 与邮件读写工具

| 导出                                                                                       | 说明                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `crmReadTool` / `crmWriteTool` / `emailReadTool` / `emailSendTool` / `knowledgeSearchTool` | 5 个工具定义                          |
| `EmailSendInput`                                                                           | `email_send` 入参类型                 |
| `writeCustomerActivity(ctx, customerId, summary, refType?, refId?)`                        | 写 `customer_activity`（`ai_action`） |
| `registerCrmTools(register)`                                                               | 注册 5 个工具                         |

工具要点：

- `crm_read`：本 org 客户/联系人/会话只读（scope=org，AI 不受用户 scope 限制但限 org），产出含 `tier`
  （由 `score` 按 85/60 分档）。
- `crm_write`：批量写 `ai_lead` 发现池（`inCrm=false`，**不自动进 CRM**——加入是用户动作，03 §4）。
  按归一化域名去重：命中未转化 lead → 合并（取更高分），否则新建 `ai_lead` + `ai_lead_contact`。
  **AI 权限边界**：不暴露阶段推进 / 身份 / owner 变更。
- `email_read`：会话历史只读；`inboxMessageId → conversation` 或直接 `conversationId`/`customerId` 解析。
- `email_send`（`riskLevel: medium`，`approvalType: email_send`）：**真实外发唯一出口**（06 §2.3）——
  幂等键（`taskId+nodeId+messageHash`，TTL 24h）→ 窗口 + 频控校验 → 内容合规 → 邮箱解析 → 凭据解密 →
  驱动发送（**重试 2 次指数退避 500ms/2s；凭据失效不重试**）→ 落 `message` 行 + 刷新会话预览。
  失败则以**独立事务**落 `message.status='failed'`（`ctx.tx` 会随抛错回滚，故须独立连接），再抛
  `DEPENDENCY_UNAVAILABLE`。未注入配置时走 **mock 外发兜底**（测试/演练语义）。含 `freshnessCheck`：
  仅拦截「客户在基准之后新增的 in 消息」（reply 模式基准=触发消息；follow_up 模式=最近一次已发送 outbound，
  缺失回退 `conversation.createdAt`）。
- `knowledge_search`：委托 `searchKnowledgeChunks`；无命中时写显式日志并返回空（**禁止编造**，11 §3.3）。

### builtin/knowledge-search.ts — 知识混合检索

`searchKnowledgeChunks(tx, orgId, params)` → `{ results, noResult }`。三路召回 + **RRF 融合（k=60）**：

1. **向量**：query 嵌入 → HNSW `<=>` 距离 Top-20（含距离阈值 `VECTOR_MAX_COSINE_DISTANCE=0.75`）；
2. **全文**：`to_tsvector('simple') @@ websearch_to_tsquery` Top-20；
3. **相似**：`pg_trgm similarity` Top-20（trgm gin 索引，manual 迁移交付）。

融合取 Top-K，`score` 归一 0~1（相对三路满分 `3/(k+1)`）。场景差异化（`sceneCategories`/`sceneTopK`）
来自 `core/rrf.ts`；嵌入服务异常时降级为「全文+相似」两路（检索可用性优先）。

| 导出                    | 说明                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `searchKnowledgeChunks` | 混合检索主函数（纯库访问，仅 query 嵌入外呼）                                     |
| `KnowledgeSearchParams` | `{ query, scene?, topK?, categories? }`（`categories` 显式过滤优先于 scene 偏置） |
| `KnowledgeSearchHit`    | `{ chunkId, docId, docName, category, content, score, headingPath }`              |
| `KnowledgeSearchResult` | `{ results, noResult }`                                                           |

> 工具（AI）与 API 检索（`knowledge.service.ts` / `conversations.service.ts`）**共用本实现**，杜绝双口径。

### builtin/quotas.ts — org 时区与搜索配额

| 导出                                | 说明                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `getOrgTimezone(orgId, tx)`         | 读 `org.timezone`（缺省 UTC），**60s 进程内 memo**                                                       |
| `configureOrgSearchQuota(limit)`    | 注入 org 级日额度上限（worker 启动由 env 传入；缺省 2000）                                               |
| `assertOrgSearchQuota(ctx, weight)` | org 级搜索/抓取日额度令牌桶，key `orgsearch:{orgId}:{day}`（org 时区日界，TTL 48h），超限 `RATE_LIMITED` |

> 与 `registry.assertQuota`（**员工级**）分属两层：本函数是**org 级供应商额度**保护层。

### builtin/content-compliance.ts — 外发内容合规

| 导出                                                    | 说明                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `EmailContentInput` / `ComplianceFinding`               | 校验入参 / 机器可读结论（`{ code, detail }`）                       |
| `checkEmailContentCompliance(input)`                    | 返回 findings（不抛错）                                             |
| `assertEmailContentCompliance(input)`                   | 有 findings 即抛 `BIZ_VALIDATION`（42201）——`email_send` 内强制调用 |
| `setEmailComplianceHook(fn)` / `resetEmailCompliance()` | 注入 / 清除进程级扩展钩子（如 org 敏感词库，P1 随 16 设置扩展）     |

内置基线：主题非空且 ≤ 200 字符、正文非空且 ≤ 20000 字符、不含非法控制字符（`\n`/`\t` 除外）。

### builtin/email-send-config.ts — 外发配置注入

| 导出                          | 说明                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `configureEmailSend(options)` | 进程启动注入一次（`encryptionKey` / `oauth` / `db`）            |
| `getEmailSendConfig()`        | 未初始化时抛错                                                  |
| `EmailSendOptions`            | `MailboxDriverOptions & { db?: Db }`（`db` 为失败留痕专用连接） |

---

## 内置工具清单

`createToolRegistry()` = `registerSearchTools` + `registerCrmTools`，共 **10 个工具**：

| 工具               | 风险       | 配额权重 | 审批类型     | 说明                            |
| ------------------ | ---------- | -------- | ------------ | ------------------------------- |
| `web_search`       | low        | 1        | —            | 网页搜索，返回公司候选          |
| `site_crawl`       | low        | 2        | —            | 抓官网摘要（不可达降级）        |
| `find_contact`     | low        | —        | —            | 联系人发现 + 影响力基线         |
| `lookup_contact`   | low        | 1        | —            | 公开渠道联系方式                |
| `lead_scoring`     | low        | —        | —            | 确定性评分（降级入口）          |
| `crm_read`         | low        | —        | —            | 客户/会话只读                   |
| `crm_write`        | low        | —        | —            | 写 `ai_lead` 发现池（不进 CRM） |
| `email_read`       | low        | —        | —            | 会话历史只读                    |
| `email_send`       | **medium** | —        | `email_send` | **真实外发唯一出口**            |
| `knowledge_search` | low        | —        | —            | 知识混合检索                    |

---

## 校验链与执行时序

`GraphCompiler.toolExec`（runtime）按 SOP `tool` 节点装配，顺序固定：

```
1. tools.get(node.tool)                         → 未注册 404
2. assertAllowed(tool, ctx.employee.tools)      → ① 员工白名单，越权 40301
3. parseInput(tool, buildToolInput(node,state)) → ② 入参 schema，非法 BAD_REQUEST
4. assertQuota({...ctx, timezone}, tool, dailyLimit) → ④ 员工级外部配额，超限 42901
5. riskLevel = node.risk ?? tool.riskLevel      → ③ 风险分流（非 low 且非 resume）
      → gate.decide → interrupt(enterWaiting) / auto_approve(recordAutoApprove)
6. isResume && tool.freshnessCheck              → resume 新鲜度校验，失败 CONFLICT
7. execTool(tool, ctx, tool.execute)            → withOrg 单事务装配 ToolContext 执行
8. applyOutputKey(node.outputKey, result)       → 结果进 State 对应通道
```

> `node.risk` 优先于 `tool.riskLevel`（SOP 可对同一工具实例化抬高/放行，避免双轨漂移）。

Worker 装配（`apps/worker/src/index.ts`）：

```ts
const tools = createToolRegistry();
configureEmailSend({ encryptionKey, oauth, db }); // 外发配置
configureOrgSearchQuota(env.ORG_SEARCH_DAILY_LIMIT); // org 级搜索额度
const compiler = new GraphCompiler({ /* … */ tools /* … */ });
```

---

## 关键约定

- **org 由上下文注入**：工具实现内一律用 `ctx.orgId` + `ctx.tx`（已 `withOrg`），不接收也不信任
  AI 传入的租户/身份字段。
- **先落库再推事件**：日志必须 `tx.insert(ai_task_log)` 成功后再 `ctx.emit`，否则实时流与回放不一致。
- **失败路径独立事务**：`email_send` 的失败留痕必须走独立连接（`config.db`），因为主事务会随抛错回滚。
- **降级不中断**：单站抓取失败、嵌入服务异常、知识无命中均降级返回（记日志/置标记），不拖垮整条任务。
- **归并一律按去重键**：公司/联系人归并键 = 归一化域名优先、名称兜底；禁止按公司名归并。
- **真实供应商不产伪数据**：无依据字段缺失（如 `find_contact`/`lookup_contact` 当前返回空并留痕，
  联系人池留待 P1 扩展）；测试确定性由真实服务副作用落点 + 结构化断言保证。

---

## 测试

本包无独立单测（无 `test/` 目录与 `test` 脚本）；行为由 **worker 集成测试**覆盖：

- `apps/worker/test/full-chain.integration.spec.ts` — 端到端（含 `createToolRegistry`）。
- `apps/worker/test/m4-email-followup.integration.spec.ts` — 邮件/跟进链路。
- `apps/worker/test/m4-mailbox.integration.spec.ts` — 邮箱外发/凭据。
- `apps/worker/test/m4-dryrun.integration.spec.ts` — 演练装配（含 `configureEmailSend`）。
- `apps/worker/test/m5-insight-writeback.integration.spec.ts` — 洞察写回。
- `apps/worker/test/m5-d3-schedule-consistency.integration.spec.ts` — 排期/频控一致性。

---

## 开发

```bash
pnpm --filter @tradepilot/tools build      # tsc 构建到 dist/
pnpm --filter @tradepilot/tools typecheck  # 类型检查
pnpm --filter @tradepilot/tools lint       # eslint
```

**新增工具**：

1. 在 `builtin/*.ts` 定义 `ToolDefinition`（`name` / `inputSchema` / `riskLevel` / `execute`），
   并在对应 `register*Tools` 中注册。
2. 若需外部调用计费，设置 `quotaWeight`；若为外发/写操作，设置 `riskLevel` 与 `approvalType`。
3. 需审批后复查的加 `freshnessCheck`；在 `sops.ts` 的 SOP 中以 `node.tool` 引用即可被图调用。
4. 遵循「`withOrg` 事务 + 先落库再推事件 + 输入即权限边界」三条硬约定。
