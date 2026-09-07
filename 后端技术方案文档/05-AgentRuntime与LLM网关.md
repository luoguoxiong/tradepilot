# 后端技术方案 · 05 · Agent Runtime 与 LLM 网关

| 项 | 内容 |
|---|---|
| 前置文档 | 设计权威 = [Agent Runtime 总纲](../产品需求文档/Agent%20Runtime%20架构/00-运行时架构总纲.md)（组件/校验链/审批语义不在此重复）；图定义 = [LangGraph 工作流 00](../产品需求文档/LangGraph%20工作流/00-P0工作流定义.md)；执行承载 = [04-任务调度与队列](./04-任务调度与队列.md) |
| 版本 | v0.1（2026-09-06） |

---

## 1. 包结构与职责

```text
packages/runtime/src/
├── task-runner.ts        # 领取→执行→收尾骨架（04 §5.1）
├── graph-compiler.ts     # SOP jsonb → CompiledGraph（缓存按 sopId+version）
├── state/                # BaseTaskState 与各图 State 类型（LangGraph 工作流 §1.1）
├── approval-gate.ts      # §4
├── memory/               # 三层记忆读写
└── llm-gateway/          # §6：provider 适配、路由、结构化输出、成本记账

packages/tools/src/       # ToolDefinition + 内置工具
packages/workflows/src/   # lead_hunting / email_reply / follow_up 图 + prompts/
```

## 2. LangGraph.js 执行

| 项 | 决策 |
|---|---|
| Checkpointer | `@langchain/langgraph-checkpoint-postgres`，与业务库同实例（独立 schema `langgraph`）；`thread_id = taskId` |
| 中断 | 审批等待用原生 `interrupt()`；恢复 `Command { resume: ResumePayload }`（批准 / 编辑后内容 / 拒绝原因） |
| 节点粒度事务 | 每节点内 DB 写共享一个 `withOrg` 事务（[02 §4.3](./02-数据访问层设计.md)）；节点完成后 checkpointer 落盘 |
| 图版本 | 启动时按任务锁定的 `(sopId, version)` 取编译缓存；SOP 修改不影响进行中任务 |
| State 演进 | `packages/runtime/state` 类型与 LangGraph 工作流 §1~§4 的 TS 定义一字不差（shared 包导出，编译器消费） |

**编译器**：`compile(sop: SopContent)` 校验 jsonb（Zod：nodes/edges/kind 枚举/promptRef 存在性/风险标注）→ 生成 `StateGraph`：

- `kind=llm` → LLM 节点包装器（promptRef 加载 + Gateway 调用 + Zod 输出校验 + 2 次重试）；
- `kind=tool` → ToolRegistry 调用包装器（**自动前置 Approval Gate**，图中不手写 interrupt，Runtime §4.3）；
- `kind=flow` → 代码注册表中的控制节点（dedup_check / check_replied / schedule_next 等在 workflows 包实现）。

## 3. Tool Registry 与内置工具

```typescript
interface ToolDefinition<I, O> {
  name: ToolName;                 // 白名单键
  description: string;
  inputSchema: ZodSchema<I>;      // 入参即权限边界（AI 不可传 ownerId 等，03 §5）
  riskLevel: 'low' | 'medium' | 'high';
  approvalType?: ApprovalType;    // 六类（12 §1.2）
  quotaWeight?: 1 | 2;            // 外部调用计权（06 §3）
  freshnessCheck?(ctx): Promise<boolean>;  // 审批 resume 后的新鲜度校验钩子
  execute(ctx: ToolContext, input: I): Promise<O>;
}
```

| 工具 | 风险 | 实现要点 |
|---|---|---|
| `web_search` | low | 供应商适配（[06 §3](./06-外部集成设计.md)），配额 ×1 |
| `site_crawl` | low | Playwright 渲染 + robots.txt，配额 ×2；内容标记「不可信数据」注入（[08 §6](./08-安全设计与合规.md)） |
| `email_read` | low | 读 conversation/message（org 内），同步触发入口 |
| `email_send` | medium | 真实外发唯一出口：凭据解密 → SMTP/API 发送 → message 行 + external_id；幂等键 taskId+nodeId+messageHash |
| `crm_read` | low | 客户/联系人/会话只读（scope=org 全量，AI 不受 user scope 限制但限 org） |
| `crm_write` | low | 仅写 ai_lead 池与活动记录；不暴露阶段推进/身份变更/owner 变更（[03 §5](./03-认证授权与多租户.md)） |
| `lead_scoring` | low | 确定性规则 + LLM 评分混合；输出必须含 reasons（可解释红线） |
| `knowledge_search` | low | [07 §4](./07-知识检索与RAG.md)，按 knowledge_scope 过滤 |
| `pricing_engine` | low（P1） | 报价规则引擎：五项成本 + profitFloorPct 拦截（09 §7） |
| `report_generate` | medium（P1） | 经理报告产出；属 business_analysis 图内部节点 |

**校验链**（执行前顺序固定，任一不过即失败，越权 `40301`）：

```text
员工 tools/permissions 白名单 → 数据 scope（withOrg + knowledge_scope）
→ 风险分流（low 直执行 / medium、high → Approval Gate）
→ 外部配额检查（quotaWeight 计权令牌桶）
→ approval_policy 细化（§4.2）
```

## 4. Approval Gate 实现

### 4.1 分流放行链（顺序判定，全部通过才直发）

```text
riskLevel=high → 必人工
riskLevel=medium：
  ① 强制人工例外命中？（Break-up Email（contentKind）；approval_policy.email_send='always'；
     'high_value_only' 且客户 tier=high）→ 必人工
  ② org autoApprove（16 FR-08，仅 medium 可开）+ 员工 approval_policy.autoExecute 含该类型
     → 直发，approval_request.status='auto_approved' + approval_log 留痕
  ③ 其余 → 人工审批（interrupt）
```

### 4.2 interrupt 与恢复

```text
Gate 判定需审批
→ interrupt(payload) → checkpointer 落盘
→ 事务：ai_task.waiting_approval + linked_approval_id
       + approval_request(biz_type+biz_id 多态, expires_at=now+48h, snapshot=工具入参)
       + follow_up_task 状态同步（waiting_approval / next_run_at 冻结）
→ SSE status 事件
─────────── 审批处置（12 接口 → Worker resume）───────────
approve          → Command{resume:{decision:'approve'}} → freshnessCheck() 通过 → 真实执行
edited_approved  → resume 携带编辑后内容替换工具入参，差异写 approval_log
reject           → 拒绝原因写 Org Memory（反馈闭环）→ 图走拒绝收尾（completed 带反馈）
```

- **新鲜度校验**：`email_send` 工具的 `freshnessCheck`——email_reply 重查会话是否已被人工回复/关闭；follow_up 重跑 `check_replied`。不通过则不发送，转 `completed(insight)` / `pause_strategy`。
- 审批超时不由图处理：由 [04 §4](./04-任务调度与队列.md) 扫描器统一级联（图侧仅感知任务 failed，checkpointer 线程弃用）。

### 4.3 Org Memory 回流

- 拒绝原因、草稿编辑差异、`need_info` 缺料清单 → `ai_task.outputs`（type=insight）+ 追加至客户维度上下文包（crm_read 时注入最近 N 条拒绝原因摘要），实现「修正反馈闭环」而不新增表。

## 5. Memory Manager（三层落地）

| 层 | 实现 |
|---|---|
| Working | LangGraph State + checkpointer（任务内）；`retentionDays` 控制清理（Cron 按员工配置删除过期 checkpoint 线程） |
| Task | `ai_task.outputs`（结构化产出，前端渲染 + 后续任务引用） |
| Org | CRM 结构化数据 + pgvector 知识 + 拒绝反馈（§4.3）；`knowledge_search` 按 scene 检索注入 |

## 6. LLM Gateway

### 6.1 Provider 适配

```text
llm-gateway/
├── chat-model.factory.ts   # (provider, modelName, {temperature, maxTokens}) → BaseChatModel
├── providers/openai.ts / anthropic.ts / deepseek.ts / azure.ts   # 统一走 OpenAI 兼容协议 + 专用 SDK
└── usage-recorder.ts       # 成本记账（§6.4）
```

- 统一走 LangChain `BaseChatModel` 抽象；供应商差异（Anthropic 消息结构、Azure 部署名）收敛在适配器。
- 供应商与模型名来自 `ai_model_setting.scenes`（**org 级**，16 FR-10）；`provider` + `apiKey` 引用服务端密钥库（key 名存配置，真实 key 在 env/密管，[08 §2](./08-安全设计与合规.md)）。

### 6.2 路由（场景 → 模型档位）

```text
resolveModel(orgId, scene: 'high'|'medium'|'low'|'default', fallbackChain)
→ ai_model_setting.scenes 精确命中 → 否则 default
→ 构造 ChatModel（temperature/maxTokens 随行配置）
→ 不可用（超时/5xx×2）→ 降级链（high→medium 档）+ warn 日志标记 degraded
```

- promptRef ↔ 模型档位映射固化为 LangGraph 工作流 §6 表（parseGoal=轻…draftReply=强），编译器据此传 scene。

### 6.3 结构化输出

- 所有 LLM 节点强制 `withStructuredOutput(zodSchema)`；解析失败重试 2 次（附错误提示）→ 仍失败节点失败（`state.errors` 追加 → fail 收尾）。
- 信念红线：`grounded` 字段由 `draft_reply` 类节点输出；缺依据 → `grounded=false + missingInfo[]`，下游节点据此走 need_info 分支，不阻塞（06 §4 / D9）。

### 6.4 成本记账与预算

- 每次调用记录：`org_id / task_id / node / promptRef / model / prompt_tokens / completion_tokens / cost_usd / latency_ms / degraded`。
- **落点**：ER 02 无专表，本文档提出增补建议（待 ER 同步，不阻塞开发——首期可先写 `ai_task_log` 之外的独立表）：

```sql
-- 增补建议：ER 02 新增第 6 表 llm_call（数据中心 15 成本报表数据源）
CREATE TABLE llm_call (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES org(id),
  task_id text REFERENCES ai_task(id), employee_id text REFERENCES ai_employee(id),
  node text NOT NULL, scene text, model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0, completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0, latency_ms integer,
  degraded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_llm_call_org_time ON llm_call (org_id, created_at DESC);
```

- 预算（MVP 增量口径 / 16 FR-10）：每次调用记账后汇总当月 `sum(cost_usd)` 对比 `budgetLimit`；当月累计**首次越界**（前值 ≤ 预算 < 后值）写一次告警通知（`q:notify`，事件 `budget_limit`），**不熔断**。Cron 每 10min 汇总 + 超 80%/100% 两级阈值随 M5 #9 复核。

## 7. Prompt 管理

- `packages/workflows/prompts/<scene>/<promptRef>.md` + 同名 `.schema.ts`（Zod）；promptRef 即文件路径约定，编译器加载时校验存在性。
- 文案内使用 `{{变量}}` 占位；上下文注入（知识检索结果、拒绝原因摘要）由节点包装器统一填充；**爬取/邮件原文注入时包裹不可信数据分隔符**（[08 §6](./08-安全设计与合规.md)）。
- 提示词版本随代码走 git；不做运行时编辑（MVP 边界）。

## 8. P1 扩展点

| 图 | 承载要点 |
|---|---|
| `knowledge_index` | [07 §2](./07-知识检索与RAG.md) 流水线，纯内部无审批节点 |
| `product_analysis` | 产品资料解析 → product_knowledge 生成 |
| `order_monitor` | 规则引擎判定 + `order_change` 审批接入（工具 risk=high） |
| `business_analysis` | 多源聚合长任务；检查点密集；report outputs 五段式结构（13 需求） |
