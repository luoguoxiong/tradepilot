# TradePilot 系统架构图（详解版）

> 生成时间：2026-09-14 ｜ 分支：`feautre-mvp`
> 数据来源：源码实测（`server/apps/*`、`server/packages/*`、`web/src`）+ 后端技术方案 00～09 / 前端技术方案 00～06
> 阅读方式：本文按 **部署 → 工程 → 后端 → 前端 → 数据 → 运行时 → 流程 → 集成** 共 16 个视图展开，均为可直接渲染的 Mermaid 源码。

---

## 目录

| 视图 | 内容 |
|---|---|
| [一](#一系统总体架构部署拓扑) | 系统总体架构（部署拓扑） |
| [二](#二monorepo-工程结构) | Monorepo 工程结构 |
| [三](#三后端包依赖-dag分层拓扑) | 后端包依赖 DAG（分层拓扑） |
| [四](#四前端架构分层) | 前端架构分层 |
| [五](#五前端路由与页面地图) | 前端路由与页面地图 |
| [六](#六api-模块与全局请求管道) | API 模块与全局请求管道 |
| [七](#七认证--rbac--多租户-请求链路) | 认证 / RBAC / 多租户 请求链路 |
| [八](#八rls-多租户硬隔离机制) | RLS 多租户硬隔离机制 |
| [九](#九worker-队列与调度器) | Worker 队列与调度器 |
| [十](#十agent-runtime-执行引擎) | Agent Runtime 执行引擎 |
| [十一](#十一sop-工作流图7-张) | SOP 工作流图（7 张） |
| [十二](#十二任务全链路时序图) | 任务全链路时序图 |
| [十三](#十三数据层-er-分组49-张业务表) | 数据层 ER 分组（49 张业务表） |
| [十四](#十四外部集成与防腐层) | 外部集成与防腐层 |
| [十五](#十五可观测性与运维) | 可观测性与运维 |
| [十六](#十六关键常量速查表) | 关键常量速查表 |

---

## 一、系统总体架构（部署拓扑）

```mermaid
flowchart TB
    subgraph CLIENT["客户端"]
        WEB["Web 前端<br/>Vue 3.5 + Vite 6 + Element Plus<br/>:5173"]
    end

    subgraph EDGE["接入层 · apps/api（NestJS 10 · :8080）"]
        REST["REST /api/v1<br/>19 个业务模块"]
        SSEGW["SSE 网关<br/>GET /tasks/:id/stream"]
        GUARDS["Guard 链<br/>Jwt → Roles → Scopes"]
        PROBE["探针<br/>/healthz /readyz /metrics"]
    end

    subgraph WORKERL["调度执行层 · apps/worker（BullMQ · 无端口）"]
        WK["8 个 BullMQ Worker<br/>并发 1~5"]
        SCHED["8 个扫描循环<br/>2s ~ 1h"]
        RT["Agent Runtime<br/>TaskRunner + LangGraph"]
    end

    subgraph DATA["数据层"]
        PG[("PostgreSQL 16 + pgvector<br/>50 张表 · 业务+checkpoint+向量<br/>:5432")]
        RDS[("Redis 7<br/>队列 + Pub/Sub + 心跳 + 配额<br/>:6379")]
        OSS[("MinIO / S3<br/>知识文档原文<br/>:9000")]
    end

    subgraph EXT["外部系统"]
        MAIL["邮箱<br/>Gmail / Outlook / SMTP-IMAP"]
        MAILPIT["GreenMail 测试邮件<br/>SMTP 1025 / IMAP 1114 / UI 8025"]
        SEARCH["搜索抓取<br/>Serper 兼容"]
        LLM["LLM 供应商<br/>openai / anthropic / deepseek / azure"]
        EMB["Embedding 供应商<br/>OpenAI 兼容 · 1536 维"]
        WH["客户 Webhook 接收端"]
    end

    WEB -->|"HTTPS / JSON"| REST
    WEB -.->|"SSE 长连接"| SSEGW
    REST --> GUARDS
    GUARDS --> PG
    GUARDS --> RDS
    REST -->|"TaskEnqueuer 入队"| RDS
    RDS -->|"BullMQ 消费"| WK
    WK --> RT
    SCHED --> PG
    SCHED -->|"补投 / 派生"| RDS
    RT --> PG
    RT --> RDS
    RT --> OSS
    RT -->|"LlmGateway"| LLM
    RT -->|"工具调用"| MAIL
    RT -->|"工具调用"| SEARCH
    RT -->|"Embedding"| EMB
    RT -->|"出站 Webhook"| WH
    MAILPIT -->|"IMAP 收信"| WK
    RDS -->|"Pub/Sub task:id:events"| SSEGW
```

**双进程核心模型**

| 进程 | 职责 | 是否执行 AI 图 |
|---|---|---|
| `apps/api` | 鉴权、校验、入队、查询、SSE 推流 | ❌ 绝不执行 |
| `apps/worker` | 消费队列、驱动图执行、定时扫描 | ✅ 唯一执行方 |

---

## 二、Monorepo 工程结构

```mermaid
flowchart LR
    ROOT["tradepilot/"] --> WEBD["web/<br/>Vue 3 前端单应用"]
    ROOT --> SRVD["server/<br/>pnpm + turbo monorepo"]
    ROOT --> DOC1["产品需求文档/ ×45"]
    ROOT --> DOC2["后端技术方案文档/ ×10"]
    ROOT --> DOC3["前端技术方案文档/ ×7"]
    ROOT --> DOC4["docs/"]
    ROOT --> SCRIPT["restart-dev.sh<br/>一键重启 api+worker+web"]

    SRVD --> APPS["apps/"]
    SRVD --> PKGS["packages/"]
    SRVD --> DOCK["docker/docker-compose.yml"]
    SRVD --> ENVF[".env · .env.test"]

    APPS --> API["api/<br/>@tradepilot/api<br/>NestJS"]
    APPS --> WRK["worker/<br/>@tradepilot/worker<br/>BullMQ"]

    PKGS --> P1["core"]
    PKGS --> P2["shared"]
    PKGS --> P3["db"]
    PKGS --> P4["integrations"]
    PKGS --> P5["tools"]
    PKGS --> P6["runtime"]
    PKGS --> P7["workflows"]

    DOCK --> C1["postgres pgvector/pgvector:pg16"]
    DOCK --> C2["redis:7-alpine"]
    DOCK --> C3["minio/minio"]
    DOCK --> C4["greenmail/standalone:2.1.3"]
```

**构建拓扑序（turbo）**：`core` ∥ `shared` → `db` ∥ `integrations` → `tools` → `runtime` → `workflows` → `apps/*`

---

## 三、后端包依赖 DAG（分层拓扑）

```mermaid
flowchart TB
    subgraph L0["L0 · 零依赖地基（互不依赖，平行）"]
        CORE["@tradepilot/core<br/>15 个纯计算模块<br/>ID/金额/成本/风险/时区/RRF<br/>零依赖"]
        SHARED["@tradepilot/shared<br/>跨端契约 · 仅依赖 zod<br/>枚举/Envelope/SSE/队列/env schema/SOP schema"]
    end

    subgraph L1["L1"]
        DB["@tradepilot/db<br/>49 表 Drizzle schema<br/>withOrg 多租户唯一入口<br/>scope/软删/迁移/种子"]
        INTG["@tradepilot/integrations<br/>防腐层 · 不依赖 db<br/>邮箱/搜索/Embedding/S3/Webhook"]
    end

    subgraph L2["L2"]
        TOOLS["@tradepilot/tools<br/>AI 可调用能力层<br/>ToolRegistry + 10 内置工具<br/>校验链 ①②④"]
    end

    subgraph L3["L3"]
        RT2["@tradepilot/runtime<br/>AI 任务执行引擎<br/>TaskRunner/GraphCompiler/LlmGateway/ApprovalGate<br/>校验链 ③"]
    end

    subgraph L4["L4"]
        WF["@tradepilot/workflows<br/>声明式编排资产<br/>7 SOP + 27 flow + 9 prompt + 8 schema"]
    end

    subgraph APP["应用层"]
        AAPI["apps/api<br/>core·db·shared·integrations·runtime·tools"]
        AWRK["apps/worker<br/>全部 7 个包"]
    end

    CORE --> DB
    CORE --> INTG
    CORE --> TOOLS
    CORE --> RT2
    CORE --> WF
    SHARED --> TOOLS
    SHARED --> RT2
    SHARED --> WF
    DB --> TOOLS
    INTG --> TOOLS
    TOOLS --> RT2
    DB --> RT2
    DB --> WF
    RT2 --> WF

    CORE --> AAPI
    SHARED --> AAPI
    DB --> AAPI
    INTG --> AAPI
    TOOLS --> AAPI
    RT2 --> AAPI

    CORE --> AWRK
    SHARED --> AWRK
    DB --> AWRK
    INTG --> AWRK
    TOOLS --> AWRK
    RT2 --> AWRK
    WF --> AWRK
```

**三条关键设计约束**

| # | 约束 | 意义 |
|---|---|---|
| 1 | `core` 与 `shared` 平行且互不依赖 | core 装「算法」，shared 装「契约」，地基不互相污染 |
| 2 | `workflows → runtime` 单向（依赖倒置） | runtime 只暴露 `Simple*Registry` / `TaskSopProvider` 接口，由 worker 注入 workflows 实现 → 引擎可脱离具体业务流测试 |
| 3 | `integrations` 不依赖 `db` | 驱动层只吃结构性入参，api（连接测试/发信）与 worker（同步/索引）无差别复用 |

**依赖矩阵（✅ = package.json 声明且 src 实际 import）**

| ↓依赖 \ 被依赖→ | core | shared | db | integrations | tools | runtime | workflows |
|---|---|---|---|---|---|---|---|
| core | — | | | | | | |
| shared | | — | | | | | |
| db | ✅ | | — | | | | |
| integrations | ✅ | | | — | | | |
| tools | ✅ | ✅ | ✅ | ✅ | — | | |
| runtime | ✅ | ✅ | ✅ | 间接 | ✅ | — | |
| workflows | ✅ | ✅ | ✅ | | | ✅ | — |
| apps/api | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| apps/worker | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 四、前端架构分层

```mermaid
flowchart TB
    subgraph ENTRY["入口"]
        MAIN["main.ts<br/>装配 Pinia / Router / i18n / VueQuery"]
        APP["app.vue<br/>el-config-provider 同步 EP locale"]
    end

    subgraph LAYOUT["布局层 layouts/"]
        DL["default-layout<br/>Header 64 + Sider 240/64 + Main<br/>keep-alive 白名单"]
        BL["blank-layout<br/>登录 / 注册 / 引导"]
    end

    subgraph ROUTER["路由与守卫 router/"]
        RIDX["index.ts 装配 + filterByFeatures 整枝"]
        RAUTH["routes/auth.ts"]
        RMOD["routes/modules.ts"]
        GRD["guards.ts<br/>①认证 ②onboarding ③角色 ④标题"]
    end

    subgraph STATE["状态层"]
        PINIA["Pinia ×4<br/>auth / app / dict / notify"]
        VQ["TanStack Vue Query 5<br/>服务端数据主力<br/>qk key 工厂 + staleTime 档位"]
        SSE2["sse/useTaskStream<br/>SSE + 增量日志 + 退避重连 + 降级轮询"]
    end

    subgraph APIL["请求层 api/"]
        HTTP["http.ts<br/>axios + 拦截器 + ApiError + request T"]
        RES["resources/ ×16 业务模块"]
        TYPE["types/ ×20 响应类型"]
        ERR["error-codes.ts + error-handler.ts<br/>错误码 → UI 行为单一事实源"]
    end

    subgraph FEAT["业务域 features/ ×18"]
        F1["auth / onboarding / dashboard"]
        F2["employees / lead-gen / crm / customer360"]
        F3["inbox / follow-up / knowledge / approvals"]
        F4["settings（11 子页）"]
        F5["P1: tasks / products / quotes / orders / manager / data-center"]
    end

    subgraph SHAREDC["共享层"]
        COMP["components/business ×20<br/>ProTable / FilterBar / ScopeSelect / InsightCard<br/>CitationPopover / StreamLogPanel ..."]
        COMPO["composables/<br/>usePermission / usePolling / useFormLeaveGuard"]
        UTIL["utils/<br/>date / format(decimal.js) / enum-map / sanitize"]
        I18N["locales/<br/>zh-CN(默认) + en · 27 命名空间"]
        DIR["directives/v-permission"]
        STY["styles/tokens.scss Design Tokens"]
    end

    MAIN --> APP --> LAYOUT
    MAIN --> ROUTER
    MAIN --> STATE
    MAIN --> I18N
    ROUTER --> FEAT
    FEAT --> APIL
    FEAT --> COMP
    FEAT --> VQ
    FEAT --> SSE2
    FEAT --> COMPO
    FEAT --> UTIL
    APIL --> HTTP
    VQ --> RES
    PINIA --> RES
```

**技术栈**：Vue 3.5 / TypeScript 5.9 strict / Vite 6 / Element Plus 2.14（按需导入）/ Pinia 2.3 / Vue Router 4.6 / axios 1.20 / TanStack Vue Query 5 / vue-i18n 9 / @microsoft/fetch-event-source（SSE）/ Tiptap 3（富文本）/ dayjs / decimal.js / dompurify / @vueuse/core

> 两个值得注意的事实：① **无图表库**，数据中心 `TrendChart` / `MarketDistribution` 为内联 SVG 手写；② 服务端数据几乎全部交给 Vue Query，Pinia 仅存 4 类客户端状态。

---

## 五、前端路由与页面地图

```mermaid
flowchart TB
    ROOT["/（DefaultLayout）"] --> DASH["/dashboard 工作台"]
    ROOT --> EMP["/ai-employees AI 员工中心"]
    ROOT --> LEAD["/lead-gen AI 获客"]
    LEAD --> LEADD["/lead-gen/leads 线索池"]
    ROOT --> CRM["/crm 客户中心"]
    CRM --> CRMC["/crm/contacts 联系人页签"]
    ROOT --> INB["/inbox AI 销售工作台（满屏三窗格）"]
    ROOT --> OUT["/outreach 开发信（占位）"]
    ROOT --> FU["/follow-up 自动跟进"]
    FU --> FUS["/follow-up/strategies 跟进策略"]
    ROOT --> TPL["/templates 话术模板（占位）"]
    ROOT --> KN["/knowledge 知识中心"]
    ROOT --> APV["/approvals 审核中心（带待审角标）"]
    ROOT --> C360["/customers/:id 客户 360°"]

    ROOT --> SET["/settings 设置中心（二级侧导航）"]
    SET --> S1["org 企业信息"]
    SET --> S2["members 成员"]
    SET --> S3["mailboxes 邮箱连接"]
    SET --> S4["approval-rules 审批规则"]
    SET --> S5["notifications 通知"]
    SET --> S6["ai-employees 员工入口"]
    SET --> S7["crm-integration CRM 集成（admin+manager）"]
    SET --> S8["pricing-rules 定价规则（admin+manager）"]
    SET --> S9["ai-models 模型台账（admin）"]
    SET --> S10["api-keys API Key + Webhook（admin）"]

    ROOT -.->|"P1 · feature 开关"| P1A["/tasks · /tasks/:id"]
    ROOT -.-> P1B["/products · /products/:id"]
    ROOT -.-> P1C["/quotes · /quotes/:id"]
    ROOT -.-> P1D["/orders · /orders/:id"]
    ROOT -.->|"roles: admin,manager"| P1E["/manager AI 外贸经理"]
    ROOT -.-> P1F["/data-center 数据中心"]

    AUTH["/login · /register · /onboarding（BlankLayout 免认证）"]
    ERR2["/403 · /404"]
```

**特性开关**：`src/features.ts` 依据 `VITE_FEATURES_PROFILE`（默认 `p0`）在**编译期**决定 `quotes / orders / products / manager / taskCenter / dataCenter` 六个模块，路由、菜单、页签、卡片、推荐动作五处读同一份常量，`p0` 构建时 `filterByFeatures` 整枝剔除。

---

## 六、API 模块与全局请求管道

### 6.1 19 个业务模块 → 路由前缀

```mermaid
flowchart LR
    subgraph MOD["apps/api 业务模块"]
        M1["auth → /auth"]
        M2["org → /org"]
        M3["settings → /settings · /settings/ai-models"]
        M4["tasks → /tasks（含 SSE :id/stream）"]
        M5["knowledge → /knowledge"]
        M6["approvals → /approvals"]
        M7["conversations → /conversations · /messages · /copilot"]
        M8["customers → /customers · /contacts · /activities"]
        M9["leads → /lead-hunter · /lead-tasks · /leads"]
        M10["dashboard → /dashboard"]
        M11["employees → /ai-employees"]
        M12["follow-ups → /follow-ups · /follow-up-tasks · /follow-up-strategies"]
        M13["products → /products"]
        M14["quotes → /quotes"]
        M15["orders → /orders"]
        M16["analytics → /analytics"]
        M17["manager → /manager（@Roles admin,manager）"]
        M18["open-api → /settings/api-keys · /settings/webhooks"]
        M19["health → /healthz · /readyz（根路径）"]
    end

    subgraph GLOBAL["全局模块"]
        G1["db.module @Global<br/>Provider DB + EnvService"]
        G2["redis.module @Global<br/>Provider REDIS"]
        G3["logging.module<br/>pino + pino-http"]
        G4["metrics.module<br/>prom-client → /metrics"]
        G5["security.module<br/>限流中间件 forRoutes(*)"]
    end
```

> **无独立 repository 层**：全仓 0 个 `*repository*` 文件，数据访问由 `*.service.ts` 直接用 Drizzle schema + `withOrg()` 事务完成。

### 6.2 请求管道（中间件 → 守卫 → 拦截器）

```mermaid
flowchart TB
    REQ["HTTP Request"] --> MW1["① pino-http 中间件<br/>生成 traceId trc_xxx · 写 x-trace-id"]
    MW1 --> MW2["② RequestContextMiddleware<br/>traceId 注入 AsyncLocalStorage"]
    MW2 --> MW3["③ RateLimitMiddleware<br/>Redis 按 IP · 600 req/min · 超限 42901<br/>豁免 /healthz /readyz /metrics · Redis 故障 fail-open"]
    MW3 --> GD1["④ JwtAuthGuard<br/>@Public 放行 / x-api-key 分支 / Bearer 分支"]
    GD1 --> GD2["⑤ RolesGuard<br/>比对 @Roles 元数据 · 不匹配 40301"]
    GD2 --> GD3["⑥ ScopesGuard<br/>仅 API Key 通道 · 未声明 @Scopes 则 fail-closed"]
    GD3 --> PIPE["⑦ ZodValidationPipe（按参数）<br/>失败 → BizException 40001 + issues"]
    PIPE --> CTRL["⑧ Controller<br/>私有 ctx(req) 组装 orgId/userId/role/scope"]
    CTRL --> SVC["⑨ Service<br/>withOrg(db, orgId, tx) → RLS 生效"]
    SVC --> IT1["⑩ MetricsInterceptor<br/>qps / p95 / 错误率 / in-flight"]
    IT1 --> IT2["⑪ TransformInterceptor<br/>包装 code:0,message:ok,data,traceId<br/>@RawResponse 跳过"]
    IT2 --> RESP["Response"]
    SVC -.->|"任何异常"| FILT["HttpExceptionFilter 全局唯一出口<br/>BizException / HttpException / ZodError / 未知→50001"]
    FILT -.-> RESP
```

**四类异常映射**：`BizException` → 业务错误码；`HttpException` → `mapHttpStatus`（404→40401）；`ZodError` → `40001` + 字段级 issues；未知 → `50001`（不泄露堆栈）。

---

## 七、认证 / RBAC / 多租户 请求链路

```mermaid
sequenceDiagram
    autonumber
    participant W as Web 前端
    participant G as JwtAuthGuard
    participant T as TokenService
    participant A as AuthService
    participant ALS as AsyncLocalStorage
    participant S as Service
    participant PG as PostgreSQL RLS

    W->>G: Authorization: Bearer <access token>
    alt 令牌通道
        G->>T: verifyAccessToken（HS256）
        T-->>G: payload { sub, orgId, role, typ:access }
        G->>A: resolveLiveRole(sub)
        Note over A: 库内角色为准<br/>停用/改角色即时生效
        A-->>G: liveRole
        G->>ALS: patchContext({ orgId, userId:sub, role:liveRole })
        G->>G: request.authUser = {...payload, role}
    else API Key 通道
        W->>G: x-api-key: tp_live_xxx
        G->>A: ApiKeyService.authenticate（key_hash 全局定位）
        A-->>G: { orgId, userId, scopes }
        G->>ALS: patchContext({ orgId, userId })
        Note over G: 不写 authUser<br/>→ 所有 @Roles 端点对 API Key 自动关闭
    end

    G->>S: 放行至 Controller
    S->>S: ctx = { orgId, userId, role, scope: resolveScope(role) }
    Note over S: scope 在 Controller 私有 ctx() 推导<br/>resolveScope 单一实现在 @tradepilot/core
    S->>PG: withOrg(db, orgId) → BEGIN
    S->>PG: SELECT set_config('app.org_id', orgId, true)
    Note over PG: 事务级 GUC → tenant_isolation 策略生效<br/>漏包 withOrg 则返回空集（fail-closed）
    PG-->>S: 仅本 org 行
    S->>PG: applyOwnerScope(owner_id, ctx) 再裁剪 self/team/all
    S->>PG: COMMIT
```

**令牌规格**

| 令牌 | Payload | TTL | 存储 |
|---|---|---|---|
| Access | `{ sub, orgId, role, typ:'access' }` | 2h | 前端内存 + localStorage `tradepilot.token` |
| Refresh | `{ sub, orgId, role, typ:'refresh', jti }` | 14d | Redis `refresh:{sub}:{jti}`（可撤销/轮换） |

**数据范围（scope）**：`self` → `owner_id = userId`；`team` → MVP 不追加（RLS 已限 org）；`all` → 不追加。

---

## 八、RLS 多租户硬隔离机制

```mermaid
flowchart TB
    subgraph ROLES["三个 DB 角色（02 §4.1）"]
        R1["tradepilot_app<br/>业务表 CRUD<br/>无 BYPASSRLS → RLS 生效"]
        R2["tradepilot_sched<br/>白名单表 SELECT/UPDATE<br/>follow_up_task / approval_request<br/>mailbox / ai_task / analytics_daily_summary<br/>跨租户调度扫描专用"]
        R3["tradepilot_migrate<br/>NOINHERIT<br/>仅迁移流水线"]
    end

    subgraph MECH["隔离机制"]
        E1["manual/0001 DO 块<br/>自动枚举所有含 org_id 的业务表"]
        E2["ENABLE + FORCE ROW LEVEL SECURITY<br/>策略 tenant_isolation"]
        E3["withOrg(db, orgId, fn)<br/>set_config('app.org_id', orgId, true)<br/>第三参 true = 事务级"]
        E4["fail-closed<br/>null / 空 app.org_id 一律不匹配"]
    end

    subgraph SPECIAL["特殊上下文旁路"]
        S1["withLoginContext<br/>app.login='1'<br/>user_account 登录按 email 全局定位"]
        S2["withApiKeyContext<br/>app.apikey<br/>按 key_hash 全局定位"]
        S3["set_config('app.sched','1',true)<br/>worker 跨租户扫描"]
    end

    E1 --> E2 --> E3 --> E4
    R1 --> E3
    R2 --> S3
```

**应用层双保险**：RLS 解决 org **之间** 隔离；org **之内** 按 `owner_id` 裁剪由 `applyOwnerScope` 落地，越权判定 `resolveScope` / `assertScopeAllowed` 收口在 `@tradepilot/core`。

---

## 九、Worker 队列与调度器

### 9.1 八条 BullMQ 队列

```mermaid
flowchart LR
    subgraph PROD["生产者（apps/api · TaskEnqueuer）"]
        P1["tasks.service<br/>enqueueTask / enqueueResumeFromPause"]
        P2["approvals.service<br/>enqueueResume（审批后续跑）"]
        P3["knowledge.service · products.service<br/>enqueueKnowledgeIndex"]
        P4["orders/quotes.service<br/>enqueueNotify"]
    end

    subgraph QUEUES["Redis 队列（BullMQ）"]
        Q1["q.lead_hunting<br/>并发 2"]
        Q2["q.email_reply<br/>并发 5"]
        Q3["q.follow_up<br/>并发 5"]
        Q4["q.knowledge_index<br/>并发 2（混合语义）"]
        Q5["q.analysis<br/>并发 1"]
        Q6["q.email_sync<br/>并发 3"]
        Q7["q.notify<br/>并发 5"]
        Q8["q.webhook<br/>并发 5 · attempts 5 · 指数退避 60s"]
    end

    subgraph CONS["消费者（apps/worker registry.ts）"]
        PROC["processor.ts 统一分流"]
        TR2["TaskRunner（AI 任务）"]
        KIP["KnowledgeIndexProcessor"]
        ESP["EmailSyncProcessor"]
        NP["NotifyProcessor"]
        WDP["WebhookDeliveryProcessor"]
    end

    P1 --> Q1 & Q2 & Q3 & Q4 & Q5
    P2 --> Q1 & Q2 & Q3
    P3 --> Q4
    P4 --> Q7

    Q1 --> PROC
    Q2 --> PROC
    Q3 --> PROC
    Q5 --> PROC
    Q4 --> PROC
    PROC -->|"docId 为 string"| KIP
    PROC -->|"task_type 映射"| TR2
    PROC -->|"system job"| ESP & NP & WDP
    Q6 --> ESP
    Q7 --> NP
    Q8 --> WDP
    NP -->|"命中 webhook 订阅"| Q8
```

**task_type → 队列映射（8 → 5）**

| task_type | 队列 |
|---|---|
| `lead_hunting` | `q.lead_hunting` |
| `email_reply` | `q.email_reply` |
| `follow_up` | `q.follow_up` |
| `knowledge_index` / `product_analysis` / `product_knowledge` | `q.knowledge_index` |
| `business_analysis` / `order_monitor` | `q.analysis` |

**投递策略**：`attempts = 1`（任务级不自动重投，失败走手动 `retry_of` 新任务）；`removeOnComplete {age:3600,count:1000}`；`removeOnFail {age:24h}`；**唯一例外** `q.webhook` = 5 次指数退避。
**幂等**：`jobId = taskId` / `kidx.{docId}` / `mbxsync.{mailboxId}`，入队前 `removeTerminalJob()` 清历史（否则同 jobId `add` 是 no-op 被静默吞掉）。
> 注意：BullMQ 禁 `:` 故真实队列名为 `q.xxx`（文档口径常写作 `q:xxx`）。

### 9.2 八个扫描循环

```mermaid
flowchart TB
    LOOP["startLoop 基座<br/>setInterval + 串行不重叠 + 首轮立即执行"]

    LOOP --> S1["Dispatcher · 2s · batch 50<br/>并发闸门：单员工=1 · org 总并发=10<br/>扫 ai_task(scheduled) 逐个预检投递"]
    LOOP --> S2["FollowUpScanner · 10s · batch 50<br/>扫 follow_up_task 到期 → 频控预检<br/>不满足则乐观锁顺延 + skipped 留痕<br/>三级防重：快照 / FOR UPDATE SKIP LOCKED / 唯一索引 uq_ai_task_active_followup"]
    LOOP --> S3["MailboxSyncScheduler · 5min · batch 100<br/>扫非 disconnected 邮箱 → enqueueEmailSync"]
    LOOP --> S4["ApprovalExpiryScanner · 60s · batch 50<br/>审批超时 → expired + 日志 + 级联 ai_task failed<br/>+ 释放员工 idle + follow_up_task paused + 通知"]
    LOOP --> S5["DelayedJobReconciler · 60s · batch 50<br/>对账 scheduled_at 到期但队列无活跃 job → 补投<br/>补投前重走 Dispatcher 同口径闸门"]
    LOOP --> S6["ZombieReaper · 60s · 阈值 30min<br/>running 且 Redis 心跳缺失 → failed(timeout)<br/>（TaskRunner 每 30s 写心跳 TTL 90s）"]
    LOOP --> S7["QuotaResetScanner · 5min<br/>按 org.timezone 算当地日<br/>Redis SET NX EX 写日界标记<br/>配额本身按日分片 key 天然轮换，不清零"]
    LOOP --> S8["AnalyticsEtl · 1h · 回看 2 天<br/>按 org 当地日回算 → analytics_daily_summary<br/>UNIQUE(org_id,stat_date,country,employee_id) 幂等 upsert"]
```

**多实例防重手法**：`FOR UPDATE SKIP LOCKED` + 乐观锁状态迁移（带 where 条件 `update ... returning`，不"先查后写"）+ 唯一索引 + BullMQ 同 jobId 幂等。

### 9.3 API ⇄ Worker 协作

| 方向 | 通道 | 细节 |
|---|---|---|
| API → Worker | BullMQ 队列 | API 仅做生产者（全仓 `new Worker(` 只在 worker 侧出现一次） |
| Worker → API（实时） | Redis Pub/Sub | 频道 `task:{taskId}:events`，事件 `log/progress/status/done`，`seq` 为雪花 Crockford（字典序=时间序，作去重游标） |
| 双向权威状态 | PostgreSQL | `ai_task` / `ai_task_log` / `approval_request` / `follow_up_task` / `notification` / `knowledge_document` |
| SSE 兜底 | API 侧 | `TERMINAL_POLL_MS = 5s` 终态轮询（覆盖 commit→PUBLISH 间崩溃）；`HEARTBEAT_MS = 15s`；`MAX_CONNECTIONS_PER_ORG = 200` |

---

## 十、Agent Runtime 执行引擎

```mermaid
flowchart TB
    subgraph RUN["TaskRunner 生命周期"]
        C1["claim · CAS 抢占<br/>scheduled → running 乐观锁"]
        C2["loadSnapshot · 加载任务快照"]
        C3["startHeartbeat · 每 30s 写 task:id:heartbeat TTL 90s"]
        C4["GraphCompiler.compile(sop, stateKeys)<br/>SopGraphDefinition → LangGraph 图"]
        C5["执行 · llmExec / toolExec / flowExec"]
        C6["终态 · complete / pause(PauseAbortError) / fail"]
    end

    subgraph COMP["GraphCompiler 内部"]
        K1["renderTemplate 变量渲染"]
        K2["buildRouter 边条件路由（when）"]
        K3["wrapNode<br/>beginStep / completeStep / failStep"]
        K4["checkpointer = LangGraph Postgres Saver<br/>manual 0009 建表 · 断点续跑"]
    end

    subgraph GATE["四层工具校验链"]
        V1["① Zod 入参校验（tools/registry）"]
        V2["② 幂等 withIdempotency / toolIdempotencyKey"]
        V3["③ ApprovalGate 风险分流（runtime）<br/>按 riskLevel + 客户分层 + 员工/org 策略<br/>裁决 auto_approve 或 interrupt（TTL 48h）"]
        V4["④ 配额 assertOrgSearchQuota"]
    end

    subgraph LLMG["LlmGateway"]
        L1["多厂商适配<br/>openai / anthropic / deepseek / azure"]
        L2["模型档位降级 MODEL_TIER"]
        L3["结构化输出重试 extractJson"]
        L4["成本记账 → llm_call 表"]
        L5["预算告警 → enqueueNotify(budget_limit)"]
    end

    subgraph MEM["记忆装配 memory.ts"]
        MM1["readOrgMemory"]
        MM2["loadCustomerInsights"]
        MM3["loadRecentMessages"]
    end

    C1 --> C2 --> C3 --> C4 --> C5 --> C6
    C4 --> K1 & K2 & K3 & K4
    C5 --> V1 --> V2 --> V3 --> V4
    C5 --> LLMG
    C5 --> MEM
    V3 -.->|"interrupt"| C6
    V3 -.->|"waiting_approval"| DBW[("approval_request")]
```

**内置工具集（10 个）**

| 类别 | 工具 |
|---|---|
| CRM / 邮件（P0） | `crm_read`、`crm_write`、`email_read`、`email_send`、`knowledge_search` |
| 获客 | `web_search`、`site_crawl`、`find_contact`、`lookup_contact`、`lead_scoring` |

**声明式资产（workflows 包）**：7 张 SOP 图 + 27 个确定性 flow 节点 + 9 个提示词模板 + 8 个结构化输出 schema。

---

## 十一、SOP 工作流图（7 张）

### 11.1 `lead_hunting` AI 获客（P0）

```mermaid
flowchart TD
    A["parse_goal<br/>LLM · 解析获客目标"] --> B["retrieve_knowledge<br/>TOOL knowledge_search"]
    B --> C["plan_search<br/>LLM · 生成搜索计划"]
    C --> D["web_search<br/>TOOL · 网页搜索"]
    D --> E{"dedup_check<br/>三级去重"}
    E -->|new| F["crawl_site<br/>TOOL · 站点抓取"]
    E -->|duplicate| I{"target_check<br/>目标数检查"}
    F --> G["match_product<br/>LLM · 产品匹配度"]
    G --> H{"record_score<br/>记录评分"}
    H -->|matched| J["find_contact<br/>TOOL · 找决策人"]
    H -->|low| I
    J --> K["lookup_contact<br/>TOOL · 邮箱补全"]
    K --> I
    I -->|continue| D
    I -->|save| L["assemble_leads<br/>汇总发现池"]
    L --> M["save_to_crm_pool<br/>TOOL crm_write"]
    M --> N["finalize<br/>汇总产出"]
```

### 11.2 `email_reply` AI 销售工作台（P0）

```mermaid
flowchart TD
    A["load_thread<br/>加载会话上下文"] --> B["analyze_intent<br/>LLM · 意图识别"]
    B --> C["copilot_analyze<br/>LLM · Copilot 分析"]
    C --> D["retrieve_knowledge<br/>TOOL · scene=email_reply topK=5"]
    D --> E["draft_reply<br/>LLM · 生成回复草稿"]
    E --> F{"draft_branch<br/>依据校验分流"}
    F -->|grounded| G["email_send<br/>TOOL · risk=medium<br/>approvalType=email_send"]
    F -->|need_info| H["need_info<br/>缺料收尾"]
    G --> I["writeback<br/>回写 CRM 活动"]
```

### 11.3 `follow_up` AI 自动跟进（P0）

```mermaid
flowchart TD
    A["load_context<br/>加载跟进上下文"] --> B{"check_replied<br/>客户回复检查"}
    B -->|replied| C["pause_strategy<br/>暂停策略转人工"]
    B -->|no| D["select_step<br/>选取策略步 Day 0/3/7/14/30"]
    D --> E["retrieve_content<br/>TOOL · scene=follow_up topK=3"]
    E --> F["generate_follow_up<br/>LLM · 生成跟进内容"]
    F --> G["email_send<br/>TOOL · risk=medium"]
    G --> H["writeback_execution<br/>执行记录回写"]
    H --> I["schedule_next<br/>排期下一步"]
```

### 11.4 其余 4 张 P1 SOP

```mermaid
flowchart LR
    subgraph PA["product_analysis 客户 AI 分析"]
        PA1["load_analysis_context"] --> PA2["analyze_customer LLM"] --> PA3["write_customer_insight"]
    end
    subgraph PK["product_knowledge 产品知识生成"]
        PK1["load_product_context"] --> PK2["generate_knowledge LLM"] --> PK3["write_product_knowledge"]
    end
    subgraph OM["order_monitor 订单风险监控"]
        OM1["load_order"] --> OM2["assess_risk LLM"] --> OM3["alert_anomaly"]
    end
    subgraph BA["business_analysis AI 外贸经理报告"]
        BA1["load_report_context"] --> BA2["detect_opportunities LLM"]
        BA2 --> BA3["detect_risks"] --> BA4["compose_report LLM"] --> BA5["persist_report"]
    end
```

**SOP 注册**：`WORKFLOW_SOP_DEFINITIONS` + `workflowSopProvider`（含 `get` 与 `buildOutputs`）由 `apps/worker` 在启动时注入 `TaskRunner`，**apps/api 完全不需要 workflows 包**。

---

## 十二、任务全链路时序图

```mermaid
sequenceDiagram
    autonumber
    participant W as Web 前端
    participant API as apps/api
    participant Q as Redis BullMQ
    participant WK as apps/worker
    participant RT as TaskRunner + LangGraph
    participant TL as ToolRegistry
    participant AG as ApprovalGate
    participant LLM as LLM 供应商
    participant PG as PostgreSQL
    participant SUB as Redis Pub/Sub

    W->>API: POST /api/v1/tasks（创建任务）
    API->>PG: withOrg → INSERT ai_task(status=scheduled)
    API->>Q: TaskEnqueuer.enqueueTask(jobId=taskId)
    API-->>W: { id, status: scheduled }

    Note over W: 前端跳转任务详情<br/>GET /tasks/:id/stream 建立 SSE
    W->>API: SSE 连接
    API->>SUB: SUBSCRIBE task:{id}:events

    Q->>WK: 消费 job
    WK->>RT: TaskRunner.run(taskId)
    RT->>PG: claim CAS: scheduled → running
    RT->>PG: 启动心跳（30s / TTL 90s）
    RT->>RT: GraphCompiler.compile(SOP)

    loop 每个节点
        RT->>PG: beginStep → ai_task_step
        alt LLM 节点
            RT->>LLM: LlmGateway.structured(promptRef, outputSchema)
            LLM-->>RT: 结构化输出（失败自动重试 + 档位降级）
            RT->>PG: 记账 → llm_call
        else Tool 节点
            RT->>TL: execTool
            TL->>TL: ①Zod 校验 → ②幂等
            TL->>AG: ③ 风险分流 decide()
            alt 需人工审批
                AG->>PG: INSERT approval_request(pending, TTL 48h)
                AG->>SUB: publish status=waiting_approval
                SUB-->>API: SSE 推送
                API-->>W: 前端展示审批卡
                W->>API: POST /approvals/:id/approve
                API->>Q: enqueueResume(taskId, {nodeId, approvalId})
                Q->>RT: 从 checkpoint 断点续跑
            else 自动通过
                AG->>PG: recordAutoApprove → approval_log
                TL->>TL: ④ 配额校验 → execute
            end
        end
        RT->>PG: completeStep + ai_task_log
        RT->>SUB: publish log / progress 事件
        SUB-->>API: SSE
        API-->>W: 实时日志与进度
    end

    RT->>PG: complete → ai_task(completed) + outputs
    RT->>SUB: publish done
    SUB-->>API: SSE done
    API-->>W: 任务完成
    Note over API: TERMINAL_POLL_MS=5s 兜底轮询<br/>覆盖 commit→PUBLISH 间崩溃窗口
```

---

## 十三、数据层 ER 分组（49 张业务表）

```mermaid
flowchart TB
    subgraph ER1["ER-01 企业与用户设置（12）"]
        T1["org · user_account · role_permission · mailbox<br/>crm_integration · pricing_rule_setting<br/>notification_setting · notification<br/>ai_model_setting · ai_model · api_key · webhook"]
    end
    subgraph ER2["ER-02 AI 员工与任务（6）"]
        T2["sop_template · ai_employee · ai_task<br/>ai_task_step · ai_task_log · llm_call"]
    end
    subgraph ER3["ER-03 线索（2）"]
        T3["ai_lead · ai_lead_contact"]
    end
    subgraph ER4["ER-04 客户（4）"]
        T4["customer · contact · customer_insight · customer_activity"]
    end
    subgraph ER5["ER-05 邮件与跟进（7）"]
        T5["conversation · message · conversation_insight<br/>follow_up_strategy · follow_up_strategy_step<br/>follow_up_task · follow_up_execution"]
    end
    subgraph ER6["ER-06 产品与知识（7）"]
        T6["product · product_spec · product_price_tier · product_document<br/>product_knowledge · knowledge_document · knowledge_chunk"]
    end
    subgraph ER7["ER-07 报价与订单（6）"]
        T7["quotation · quotation_item · sales_order<br/>sales_order_item · order_risk_insight · order_progress_log"]
    end
    subgraph ER8["ER-08 审批与数据（5）"]
        T8["approval_request · approval_log · business_report<br/>ai_discovery · analytics_daily_summary"]
    end

    T1 --> T2
    T2 --> T3
    T3 --> T4
    T4 --> T5
    T5 --> T6
    T6 --> T7
    T7 --> T8
```

**核心实体关系（任务与审批主干）**

```mermaid
erDiagram
    ORG ||--o{ USER_ACCOUNT : "拥有成员"
    ORG ||--o{ AI_EMPLOYEE : "配置员工"
    ORG ||--o{ MAILBOX : "连接邮箱"
    AI_EMPLOYEE ||--o{ AI_TASK : "执行任务"
    SOP_TEMPLATE ||--o{ AI_EMPLOYEE : "绑定 SOP"
    AI_TASK ||--o{ AI_TASK_STEP : "拆解步骤"
    AI_TASK ||--o{ AI_TASK_LOG : "运行日志"
    AI_TASK ||--o{ APPROVAL_REQUEST : "触发审批"
    APPROVAL_REQUEST ||--o{ APPROVAL_LOG : "审批留痕"
    AI_TASK ||--o{ LLM_CALL : "LLM 记账"
    AI_LEAD ||--o{ AI_LEAD_CONTACT : "关联联系人"
    CUSTOMER ||--o{ CONTACT : "多联系人"
    CUSTOMER ||--o{ CONVERSATION : "往来会话"
    CONVERSATION ||--o{ MESSAGE : "消息"
    FOLLOW_UP_STRATEGY ||--o{ FOLLOW_UP_STRATEGY_STEP : "五步节奏"
    FOLLOW_UP_TASK ||--o{ FOLLOW_UP_EXECUTION : "执行留痕"
    KNOWLEDGE_DOCUMENT ||--o{ KNOWLEDGE_CHUNK : "切块向量化"
    QUOTATION ||--o{ QUOTATION_ITEM : "明细"
    SALES_ORDER ||--o{ SALES_ORDER_ITEM : "明细"
```

**数据约定**

| 项 | 约定 |
|---|---|
| 主键 | 应用层生成 `createId(...)`，形态 `{前缀}_{雪花}`，无 DB 默认值 |
| 金额 | `numeric` 存储，出入参十进制字符串（如 `"12500.00"`），`total 18,2` / `rate 18,8`，**禁用浮点** |
| 软删 | `deleted_at IS NULL`，由 `notDeleted()` 显式拼接 |
| 时间 | 一律 UTC 存储，业务语义按 `org.timezone` 解释 |
| 向量 | `knowledge_chunk.embedding = vector(1536)`，pgvector |
| 迁移 | `migrate.ts` 三步串行：扩展 `0000` → drizzle 产物（`_journal.json` 驱动）→ `manual/*.sql`（追踪表 `schema_manual_migrations` 防重放）；**禁止运行时自动迁移** |

**迁移流水线（实测已应用 15 个 manual 文件）**

```
0000_extensions → 0001_rls_roles → 0002_column_comments → 0003_langgraph
→ 0004_ai_task_active_followup_uq → 0005_ai_task_status_default
→ 0006_notification → 0007_msg_status_waiting_approval → 0008_kdoc_sched_scan
→ 0009_langgraph_checkpoint_tables → 0010_ai_model → 0011_ai_model_type_search
→ 0012_p1_check_constraints → 0013_api_key_lookup → 0014_task_type_product_knowledge
```

---

## 十四、外部集成与防腐层

```mermaid
flowchart LR
    CORE["apps/api · apps/worker · packages/tools"]

    subgraph INTEG["@tradepilot/integrations（防腐层）"]
        I1["mailbox/factory<br/>createMailboxDriver"]
        I2["search/index<br/>HttpSearchProvider（Serper 兼容）<br/>robots.txt · 排除域名 · PerHostRateLimiter"]
        I3["embedding/index<br/>OpenAiEmbeddingProvider（1536 维）"]
        I4["storage/index<br/>S3Storage（自实现 SigV4，不引 aws-sdk）"]
        I5["webhook-out<br/>HMAC 签名投递"]
    end

    subgraph DRV["邮箱驱动三选一"]
        D1["gmail · googleapis"]
        D2["outlook · Microsoft Graph"]
        D3["smtp-imap · imapflow + nodemailer"]
    end

    CORE --> I1 --> DRV
    CORE --> I2 --> SEA["搜索/抓取供应商"]
    CORE --> I3 --> EMBP["Embedding 服务"]
    CORE --> I4 --> MINIO["MinIO / S3"]
    CORE --> I5 --> CUSTWH["客户 Webhook 端点"]

    DRV --> MAILP["GreenMail（本地测试）<br/>SMTP 1025 / IMAP 1114 / UI 8025"]
```

**统一手法：进程级工厂注入**（`setXxxFactory` / `configureXxx`）——未注入即**明确抛错，不回落 mock**。

| 注入点 | 工厂 |
|---|---|
| 邮件外发 | `configureEmailSend({ encryptionKey, oauth, db })` |
| 搜索 | `setSearchProviderFactory(orgId => resolveActiveModel(db, orgId, 'search'))` |
| Embedding | `setEmbeddingProviderFactory(orgId => resolveActiveModel(db, orgId, 'embedding'))` |
| 对象存储 | `createS3Storage(...) + configureObjectStorage(...)` |
| 搜索配额 | `configureOrgSearchQuota(ORG_SEARCH_DAILY_LIMIT)` |

> **重要**：LLM / Embedding / Search 的模型与供应商配置**不再走环境变量**，统一由「系统设置 → AI 模型台账」`ai_model` 表（仅 admin）读库解析。

---

## 十五、可观测性与运维

```mermaid
flowchart TB
    subgraph LOG["日志"]
        L1["pino JSON 结构化<br/>base: app=api|worker, env, workerIndex"]
        L2["ALS 自动绑定 traceId / orgId / userId"]
        L3["redact: authorization · cookie · *.password · *.token · *.secret"]
        L4["忽略 /metrics /healthz /readyz"]
    end

    subgraph MET["指标 prom-client"]
        M1["HTTP qps"]
        M2["p95 延迟"]
        M3["错误率"]
        M4["in-flight 请求数"]
        M5["路由模板 label 防基数爆炸<br/>如 /tasks/:id"]
    end

    subgraph PROBE2["探针"]
        H1["GET /healthz liveness"]
        H2["GET /readyz readiness"]
        H3["GET /metrics Prometheus 抓取"]
    end

    subgraph AUDIT["审计链（四表串联）"]
        A1["ai_task 任务"]
        A2["ai_task_step 步骤"]
        A3["ai_task_log 日志"]
        A4["approval_log + llm_call 审批与成本"]
    end

    subgraph BUS["业务可追溯"]
        B1["每任务 steps / logs / outputs 全留存"]
        B2["llm_call 全量 token 与成本记账"]
        B3["Insight 结构：理由 reasons + 引用 citations"]
    end

    LOG --> PROBE2
    MET --> PROBE2
```

**本地中间件（docker-compose）**

| 服务 | 镜像 | 端口 | 数据卷 |
|---|---|---|---|
| postgres | `pgvector/pgvector:pg16` | 5432 | `tradepilot-dev_pg_data` |
| redis | `redis:7-alpine` | 6379 | `tradepilot-dev_redis_data` |
| minio | `minio/minio:latest` | 9000 / 9001 | `tradepilot-dev_minio_data` |
| mailpit | `greenmail/standalone:2.1.3` | 1025 / 1114 / 8025 | 无（易失） |

---

## 十六、关键常量速查表

### 队列与并发

| 队列 | 并发 | 用途 |
|---|---|---|
| `q.lead_hunting` | 2 | AI 获客 |
| `q.email_reply` | 5 | 邮件回复 |
| `q.follow_up` | 5 | 自动跟进 |
| `q.knowledge_index` | 2 | 知识入库（混合语义） |
| `q.analysis` | 1 | 经营分析 / 订单监控 |
| `q.email_sync` | 3 | 邮箱收信同步 |
| `q.notify` | 5 | 通知分发 |
| `q.webhook` | 5 | 出站 Webhook（5 次重试） |

### 调度间隔

| 扫描器 | 间隔 | 批次 |
|---|---|---|
| Dispatcher | 2s | 50 |
| FollowUpScanner | 10s | 50 |
| MailboxSyncScheduler | 5min | 100 |
| ApprovalExpiryScanner | 60s | 50 |
| DelayedJobReconciler | 60s | 50 |
| ZombieReaper | 60s（僵尸阈值 30min） | 50 |
| QuotaResetScanner | 5min | 全量 |
| AnalyticsEtl | 1h（回看 2 天） | 全 org × 2 天 |

### 闸门与阈值

| 项 | 值 |
|---|---|
| 单员工并发 | 1 |
| org 总并发 | 10（`ORG_CONCURRENCY_LIMIT`） |
| BullMQ worker | `stalledInterval 60s`、`maxStalledCount 2` |
| 任务心跳 | 每 30s 写，TTL 90s |
| 审批 TTL | 48h（`APPROVAL_TTL_MS`） |
| API 限流 | 600 req/min / IP（`RATE_LIMIT_PER_MINUTE`，0=关闭） |
| 搜索日额度 | org 级 2000（`ORG_SEARCH_DAILY_LIMIT`） |
| PostgreSQL 池 | `max=20`、`idleTimeoutMillis=30s`、`statement_timeout=15s` |
| JWT | Access 2h / Refresh 14d，HS256 |
| Webhook | 超时 10s、最多 5 次、退避 60s、签名头 `x-tp-signature` |
| API Key 限流 | `API_KEY_RATE_LIMIT_PER_MINUTE` |

### 错误码

| Code | 含义 | | Code | 含义 |
|---|---|---|---|---|
| `0` | OK | | `42201` | 业务校验失败 |
| `40001` | 参数错误 | | `42901` | 限流 |
| `40101` | 未认证 | | `50001` | 内部错误 |
| `40301` | 无权限 | | `50301` | 依赖不可用 |
| `40401` | 不存在 | | `40901` | 冲突 |

---

## 附：架构要点速记

1. **双进程**：API 只入队与查询，Worker 唯一执行 AI 图，靠 Redis 队列解耦、PostgreSQL 作权威状态、Redis Pub/Sub 回传实时。
2. **租户隔离双保险**：应用层 `withOrg` 注入 `app.org_id` GUC + DB 层 RLS `FORCE`；fail-closed，漏包返回空集。
3. **依赖倒置**：`runtime` 定义引擎与注册表接口，`workflows` 提供声明式 SOP/提示词/节点，由 worker 注入 → 新增业务流只加资产不动引擎。
4. **防腐层无 mock**：所有外部供应商走进程级工厂注入，未配置明确抛错。
5. **可中断可恢复**：LangGraph + Postgres Checkpointer 实现审批挂起与断点续跑；心跳 + CAS 抢占 + 乐观锁保证多实例安全。
6. **成本与合规内建**：`llm_call` 全量记账与预算告警；Insight 强制「理由 + 引用」；提示词注入防护 `boundExternal` / `stripSensitiveFields`。
