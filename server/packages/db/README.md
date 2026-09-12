# @tradepilot/db

TradePilot 后端的**数据访问层包**：Drizzle schema（全量 49 表）、迁移产物与执行器、
RLS 多租户会话注入、软删 / scope 查询注入、注册事务种子。

依据后端技术方案 **02（数据层）、03（认证与权限）**，是 `api` / `worker` 及
`packages/*` 访问 PostgreSQL 的**唯一入口**。

> 依赖：`@tradepilot/core`（ID / scope 原语）、`drizzle-orm`、`pg`。
> 上层不直接 `new Pool()`，一律经本包 `createDb` / `withOrg`。

---

## 目录

- [核心概念](#核心概念)
  - [多租户与 RLS](#多租户与-rls)
  - [RLS 会话注入](#rls-会话注入)
  - [数据范围（scope）与软删](#数据范围scope与软删)
  - [ID 与金额约定](#id-与金额约定)
- [目录结构](#目录结构)
- [导出 API](#导出-api)
  - [连接管理](#连接管理)
  - [会话上下文](#会话上下文)
  - [scope / 软删查询注入](#scope--软删查询注入)
  - [schema 与类型](#schema-与类型)
  - [迁移](#迁移)
  - [种子](#种子)
- [Schema 表清单](#schema-表清单)
- [迁移流水线](#迁移流水线)
- [使用示例](#使用示例)
- [测试](#测试)
- [开发](#开发)

---

## 核心概念

### 多租户与 RLS

- 多租户主键为 `org_id`（`org` 为租户根）。**所有含 `org_id` 的业务表**在 DB 侧统一套用
  `tenant_isolation` 策略（`ENABLE` + `FORCE ROW LEVEL SECURITY`），由 `manual/0001` 的 DO 块
  自动枚举套用（02 §4.2）。
- 三个 DB 角色（02 §4.1）：
  - `tradepilot_app`：业务表通用 CRUD，**无 `BYPASSRLS`**，RLS 生效；
  - `tradepilot_sched`：仅白名单表 `SELECT/UPDATE`（`follow_up_task` / `approval_request` /
    `mailbox` / `ai_task` / `analytics_daily_summary`），供跨租户调度扫描；
  - `tradepilot_migrate`：`NOINHERIT`，仅迁移流水线使用，运行时不可用。

### RLS 会话注入

库层不做任何隐式 `where org_id`。隔离由事务级 GUC 承载，业务代码经**唯一入口**
`withOrg` 注入：

```ts
await withOrg(db, orgId, async (tx) => {
  /* tx 内 SQL 自动限定本 org */
});
```

- 实现：`set_config('app.org_id', orgId, true)`（第三参 `true` = 事务级）。
- **fail-closed**：漏包 `withOrg` 时策略匹配不到行 → 返回空集而非全量（02 §4.3）。
  `null` / 空 `app.org_id` 一律不匹配。
- `withLoginContext`：登录场景专用，置 `app.login = '1'`，配合 `user_account` 上的
  `login_lookup` 策略实现「按 email 全局定位用户」（03 §1.1）；其他表不受影响。

### 数据范围（scope）与软删

- RLS 只解决 **org 之间**隔离；**org 之内**按 `owner_id` 裁剪由 `applyOwnerScope` 落地
  （03 §4.2）。`self | team | all` 的语义与越权判定（`resolveScope` / `assertScopeAllowed`）
  在 `@tradepilot/core` 收口，本包仅重导出并转换为 SQL 条件。
- 软删：`deleted_at IS NULL` 由 `notDeleted()` 显式拼接，repository 默认追加；
  引用回溯场景（如展示已删客户的历史报价）显式绕过。

### ID 与金额约定

- 主键一律**应用层生成**（`createId(...)`），不设 DB 默认值；形态 `{前缀}_{雪花}`。
- 金额用 `numeric` 存储、出入参为十进制字符串（`"12500.00"`），禁用浮点（02 §7）；
  `total 18,2` / `rate 18,8`，集成测试覆盖精度往返无损。

---

## 目录结构

```
src/
├── index.ts            # 包入口：createDb / closeDb / withOrg / schema / scope 重导出
├── tenant.ts           # Db / Tx 类型 + withOrg / withLoginContext（RLS 会话注入）
├── scope.ts            # 软删过滤 + applyOwnerScope / assertResourceAccess / scopeAnd
├── migrate.ts          # 迁移执行器（extensions → drizzle 产物 → manual_*.sql）
├── schema/             # Drizzle 表定义（ER 00~08 + 增补表）
│   ├── enums.ts        # 全局 pgEnum（与接口总览 §3 严格一致）
│   ├── 01-org-user.ts          # ER 01 企业与用户设置（12 表）
│   ├── 02-ai-task.ts           # ER 02 AI 员工与任务（6 表，含 llm_call 记账）
│   ├── 03-lead.ts              # ER 03 线索（2 表）
│   ├── 04-customer.ts          # ER 04 客户（4 表）
│   ├── 05-mail-followup.ts     # ER 05 邮件与跟进（7 表）
│   ├── 06-product-knowledge.ts # ER 06 产品与知识（7 表）
│   ├── 07-quote-order.ts       # ER 07 报价与订单（6 表）
│   ├── 08-approval-data.ts     # ER 08 审批与数据（5 表）
│   └── index.ts                # 汇总重导出
├── migrations/         # drizzle-kit 产物（0000~0004）+ manual/（手工 SQL）
│   └── manual/         # 扩展 / 角色 / RLS / 清注释 / 跨模块 FK / 表达式索引
└── seed/
    └── register-seed.ts # 注册事务种子 seedOrg
test/
└── rls.integration.spec.ts   # RLS / 软删 / 金额往返 集成测试
drizzle.config.ts       # drizzle-kit 生成配置（out → src/migrations）
```

---

## 导出 API

### 连接管理

| 导出                                | 说明                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDb(connectionString, opts?)` | 创建连接池 + drizzle 实例。默认 `max=20`、`idleTimeoutMillis=30s`、`statement_timeout=15s`（02 §3 池参数基线）。`api` 与 `worker` **各自独立**实例 |
| `closeDb(db)`                       | 关闭连接池（进程优雅退出）                                                                                                                         |

### 会话上下文

| 导出                       | 说明                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `Db`                       | drizzle 实例类型（`NodePgDatabase<typeof schema> & { $client: Pool }`）                        |
| `Tx`                       | `db.transaction(cb)` 回调入参类型                                                              |
| `withOrg(db, orgId, fn)`   | 以 org 上下文开启事务，`fn(tx)` 内所有查询受 RLS 限定；**service 层跨表/多租户查询必须包在内** |
| `withLoginContext(db, fn)` | 登录上下文事务，仅用于按 email 全局定位用户                                                    |

### scope / 软删查询注入

| 导出                                                | 说明                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `notDeleted(deletedAtColumn)`                       | `deleted_at IS NULL` 软删过滤                                                                                       |
| `ScopeContext` / `OrgScopeContext`                  | scope 上下文（`userId` / `role` / `scope`，后者含 `orgId`）                                                         |
| `applyOwnerScope(ownerColumn, ctx, teamMemberIds?)` | 生成 scope 条件：`self → owner_id = userId`；`team`（P1 传成员集合）→ `IN (...)`，MVP 缺省不追加；`all → undefined` |
| `assertResourceAccess(row, ctx)`                    | 单资源访问校验（与列表同口径）：不存在 → `404`，越权 → `403`（03 §4.2，防旁路）                                     |
| `scopeAnd(...conds)`                                | 组合软删 + scope 等条件（自动剔除 `undefined`，可链式 `and`）                                                       |
| `resolveScope` / `assertScopeAllowed`               | 重导出 `@tradepilot/core` 的单一实现点                                                                              |
| `Scope` / `Role`                                    | 重导出类型                                                                                                          |

### schema 与类型

| 导出           | 说明                                                                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`       | 全量 schema 命名空间（供 `drizzle(pool, { schema })` 与类型推导）                                                                                                                                                                                                                                                    |
| 表对象         | 每张表以驼峰命名导出（如 `schema.org`、`schema.customer`、`schema.aiTask`）                                                                                                                                                                                                                                          |
| 行类型         | `Org` / `UserAccount` / `Mailbox` / `AiModel` 等 `$inferSelect` 类型                                                                                                                                                                                                                                                 |
| jsonb 结构类型 | `OrgOnboarding` / `OrgSendRules` / `RolePermissionMatrix` / `ApprovalRule` / `EmployeeApprovalPolicy` / `EmployeeKpiConfig` / `SopContent` / `MailboxChannelConfig` / `MailboxOAuthConfig` / `MailboxSyncScope` / `NotificationChannels` / `NotificationEventKey` / `NotificationEventSwitch` / `NotificationEvents` |

### 迁移

见[迁移流水线](#迁移流水线)。包内不导出运行时迁移 API；CLI：`pnpm --filter @tradepilot/db migrate`。

### 种子

| 导出                              | 说明                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seedOrg(tx, orgId, adminUserId)` | 注册事务种子（在注册事务内随 org/admin 一起提交，单 org 幂等）：<br>1. `role_permission` ×3（admin/manager/sales 权限矩阵 + 审批规则基线）<br>2. 默认跟进策略 + 五步（Day 0/3/7/14/30，末步 Break-up 强制人工）<br>3. 六预置 AI 员工（`sop_template` + `ai_employee` 成对，含 goal/skills/tools/kpi/approvalPolicy）<br>4. `ai_model_setting` ×4 场景（lead_hunting / email_reply / follow_up / analysis） |

---

## Schema 表清单

| 文件                      | ER    | 表                                                                                                                                                                                |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-org-user.ts`          | ER 01 | `org` `user_account` `role_permission` `mailbox` `crm_integration` `pricing_rule_setting` `notification_setting` `notification` `ai_model_setting` `ai_model` `api_key` `webhook` |
| `02-ai-task.ts`           | ER 02 | `sop_template` `ai_employee` `ai_task` `ai_task_step` `ai_task_log` `llm_call`（记账增补）                                                                                        |
| `03-lead.ts`              | ER 03 | `ai_lead` `ai_lead_contact`                                                                                                                                                       |
| `04-customer.ts`          | ER 04 | `customer` `contact` `customer_insight` `customer_activity`                                                                                                                       |
| `05-mail-followup.ts`     | ER 05 | `conversation` `message` `conversation_insight` `follow_up_strategy` `follow_up_strategy_step` `follow_up_task` `follow_up_execution`                                             |
| `06-product-knowledge.ts` | ER 06 | `product` `product_spec` `product_price_tier` `product_document` `product_knowledge` `knowledge_document` `knowledge_chunk`                                                       |
| `07-quote-order.ts`       | ER 07 | `quotation` `quotation_item` `sales_order` `sales_order_item` `order_risk_insight` `order_progress_log`                                                                           |
| `08-approval-data.ts`     | ER 08 | `approval_request` `approval_log` `business_report` `ai_discovery` `analytics_daily_summary`                                                                                      |

> **增补表**：`llm_call`（LLM 记账）、`notification`（站内通知收件箱）等为 ER 外补充，
> 对齐 ER 增补先例，注释中标注所属需求编号。
>
> **枚举**：`enums.ts` 集中定义全部 `pgEnum`（名称即 `CREATE TYPE` 名）。新增取值必须用
> `ALTER TYPE ... ADD VALUE` 迁移，**禁止修改字面量**。

---

## 迁移流水线

执行器 `src/migrate.ts`（`pnpm --filter @tradepilot/db migrate`），连接串取
`MIGRATE_DATABASE_URL`（缺省回退 `DATABASE_URL`）——生产指向 `tradepilot_migrate` 专用角色。

三步串行执行（02 §2）：

1. **扩展**：`manual/0000_extensions.sql`（`vector` / `pg_trgm`，先于建表，幂等）；
2. **drizzle 产物**：由 `meta/_journal.json` 驱动重放（`0000` ~ `0004`）；
3. **manual\_*.sql**：角色 / RLS 策略 / 列注释 / 跨模块 FK / 表达式索引 / 枚举标签补齐；
   文件内 `IF NOT EXISTS` 幂等 + `schema_manual_migrations` 跟踪表防重放（双保险）。

**约定**：

- 生成走 `pnpm --filter @tradepilot/db db:generate`（drizzle-kit，产物纳入 git）；
- **禁止运行时自动迁移**，迁移由部署流水线串行执行。

| manual 文件                                   | 内容                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `0000_extensions.sql`                         | `vector` / `pg_trgm` 扩展                        |
| `0001_manual_rls_roles.sql`                   | 三 DB 角色 + RLS 双保险 + 跨模块 FK + 表达式索引 |
| `0002_manual_column_comments.sql`             | 列注释                                           |
| `0003_manual_langgraph.sql`                   | LangGraph 相关对象                               |
| `0004_manual_ai_task_active_followup_uq.sql`  | 活跃跟进任务唯一约束                             |
| `0005_manual_ai_task_status_default.sql`      | `ai_task.status` 默认值                          |
| `0006_manual_notification.sql`                | 通知表增补                                       |
| `0007_manual_msg_status_waiting_approval.sql` | `msg_status` 枚举标签补齐                        |
| `0008_manual_kdoc_sched_scan.sql`             | 知识文档调度扫描索引                             |
| `0009_manual_langgraph_checkpoint_tables.sql` | LangGraph checkpoint 表                          |
| `0010_manual_ai_model.sql`                    | AI 模型台账表增补                                |
| `0011_manual_ai_model_type_search.sql`        | `ai_model_type` 的 `search` 标签幂等补齐         |

---

## 使用示例

```ts
import { createId } from '@tradepilot/core';
import {
  applyOwnerScope,
  closeDb,
  createDb,
  notDeleted,
  resolveScope,
  schema,
  scopeAnd,
  withOrg,
  type OrgScopeContext,
} from '@tradepilot/db';

const db = createDb(process.env.DATABASE_URL!);

// 列表查询：RLS 限 org + scope 限 owner + 软删过滤
const ctx: OrgScopeContext = {
  orgId,
  userId,
  role: 'sales',
  scope: resolveScope('sales', 'self'),
};

const rows = await withOrg(db, ctx.orgId, (tx) =>
  tx
    .select()
    .from(schema.customer)
    .where(
      scopeAnd(
        notDeleted(schema.customer.deletedAt),
        applyOwnerScope(schema.customer.ownerId, ctx),
      ),
    ),
);

// 单资源校验（与列表同口径，越权即抛 403）
// assertResourceAccess(row, ctx);

// 事务内写入（主键应用层生成）
await withOrg(db, ctx.orgId, (tx) =>
  tx.insert(schema.customer).values({ id: createId('cus'), orgId: ctx.orgId /* ... */ }),
);

await closeDb(db);
```

> 注册流程：在注册事务内调用 `seedOrg(tx, orgId, adminUserId)`，一并为新 org 写入
> 权限矩阵、默认跟进策略与预置员工。

---

## 测试

`test/rls.integration.spec.ts` 为**集成测试**，需先启动 PostgreSQL 并完成迁移：

```bash
docker compose -f server/docker/docker-compose.yml --env-file server/.env up -d
pnpm --filter @tradepilot/db migrate
pnpm --filter @tradepilot/db test
```

覆盖点：`fail-closed` 空集、org 行级隔离、越权写被 `WITH CHECK` 拒绝、`login_lookup`
全局定位、`notDeleted()` 过滤、`numeric` 金额精度往返无损。

---

## 开发

```bash
pnpm --filter @tradepilot/db build       # tsc 构建到 dist/
pnpm --filter @tradepilot/db typecheck    # 类型检查
pnpm --filter @tradepilot/db lint         # eslint
pnpm --filter @tradepilot/db db:generate  # 由 schema 生成迁移产物
pnpm --filter @tradepilot/db migrate      # 执行迁移（extensions → drizzle → manual）
pnpm --filter @tradepilot/db test         # vitest 集成测试
```

**新增表 / 字段时**：改 `src/schema/` → `db:generate` 产出迁移 → 如涉及 RLS / 跨模块 FK /
表达式索引，补充 `migrations/manual/` 下**新的** `00NN_manual_*.sql`（勿改已应用文件）→
在 `schema/index.ts` 与包 `index.ts` 补齐导出。
