# TradePilot Redis 使用梳理

> 梳理日期：2026-09-15
> 覆盖范围：`server/`（API + Worker + packages）、`web/`、配置与测试
> 结论基线：ioredis + BullMQ 5.x + Redis 7，无 Cluster、无哨兵、无 Lua/事务/SCAN/pipeline

---

## 1. 定位与职责

### 1.1 技术选型依据

`后端技术方案文档/00-总纲与技术选型.md:50`：

```
| 队列 | BullMQ + ioredis | 5.x / Redis 7 | 按 task_type 队列 + delayed job |
```

配套约束（同文档 `:90` 架构图、`:119` 实时链路、`:158` 指标、`:159` 可用性）：

- 架构图：`RD[(Redis 7<br/>BullMQ + Pub/Sub + 令牌桶)]`
- 实时链路：`Worker 写库后向 Redis Pub/Sub 发布 task:{id}:events；API 侧 SSE 订阅推送，断线用 GET /tasks/{id}/logs?after= 补齐`
- 实时性：任务事件 SSE 端到端 < 2s（Pub/Sub 直推）
- 可用性：api / worker 无状态可扩容，PG / Redis 托管

### 1.2 四大职责总览

| 职责 | 载体 | 关键 Key / 频道 | 数据特征 |
|---|---|---|---|
| ① 消息队列（BullMQ） | `q.*` 队列 | `bull:q.*:*` | 可重建，痕迹留 DB |
| ② 实时广播（Pub/Sub） | SSE 事件总线 | `task:{taskId}:events` | 瞬态，不保证送达 |
| ③ 频控 / 配额（令牌桶） | 计数器 | `rl:*`、`quota:*`、`orgsearch:*` | 短期窗口，可丢 |
| ④ 可撤销状态 | String 状态位 | `refresh:*`、`invite:*`、`disabled:*`、`uctx:*`、`task:*:heartbeat`、`idem:*` | 有明确 TTL，DB 兜底 |

### 1.3 一致性原则

**PostgreSQL 是权威源，Redis 只做队列 / 广播 / 缓存，可重建**（`后端技术方案文档/09-部署运维与可观测性.md:31`：生产 Redis 7 托管、开 AOF，「仅缓存/队列，可重建」）。

具体体现：

- 任务状态以 `ai_task.status/finished_at/outputs` 为准，Redis 事件**不承担送达保证**（`04-任务调度与队列.md:184`）
- 队列 job 痕迹不落 Redis：`removeOnComplete {age:3600,count:1000}` / `removeOnFail {age:24h}`，痕迹在 DB
- Redis 丢失时有 DB 侧对账补投（DelayedJobReconciler 60s、ZombieReaper 60s、SSE 5s 终态轮询）

---

## 2. 四大职责详解

### 2.1 职责一：消息队列（BullMQ）

#### 为什么需要

双进程架构：**API 只入队与查询，Worker 是唯一执行 AI 图的地方**，靠 Redis 队列解耦（`docs/TradePilot-架构图.md:1029`）。
任务执行是分钟级的长流程（lead_hunting / analysis），不能在 HTTP 请求内同步跑完，必须异步化 + 可重试 + 可延迟。

#### 队列拓扑

`server/packages/shared/src/contracts/queues.ts:7-30`

| 队列 | 并发 | 承载内容 |
|---|---|---|
| `q.lead_hunting` | 2 | 获客任务 |
| `q.email_reply` | 5 | 邮件回复任务 |
| `q.follow_up` | 5 | 跟进任务 |
| `q.knowledge_index` | 2 | 知识库入库流水线 |
| `q.analysis` | 1 | 分析任务（重，单并发） |
| `q.email_sync` | 3 | 邮箱收信同步（系统队列） |
| `q.notify` | 5 | 通知分发（系统队列） |
| `q.webhook` | 5 | 出站 webhook 投递（系统队列） |

命名规则（`queues.ts:2-3`）：**BullMQ 禁止队列名含 `:`**（Redis key 前缀分隔符），故用 `q.` 前缀，且不与业务键 `task:*` 冲突。

#### 并发考量（两层）

并发分**两层**独立设计，作用域与约束对象完全不同：

| 层 | 位置 | 作用域 | 约束什么 |
|---|---|---|---|
| ① BullMQ 技术并发 | `shared/src/contracts/queues.ts:21-30` → `worker/src/queues/registry.ts:34` | **每 Worker 实例 / 每队列** | 资源：CPU、LLM、外部 API |
| ② DB 业务并发闸门 | `worker/src/scheduler/dispatcher.ts:95-116`；`api/src/tasks/tasks.service.ts:103-120`；`delayed-reconciler.ts:95` | **跨实例全局** | 租户公平性 |

**层一：按单 job 画像反向定档**（`后端技术方案文档/04-任务调度与队列.md:12-20`）

- 长任务 / LLM 密集 → 压低：`analysis` 1、`lead_hunting` 2、`knowledge_index` 2
- 短任务 / IO 密集 / 削峰 → 抬高：`email_reply` 5、`follow_up` 5、`notify` 5、`webhook` 5
- `email_sync` 3：`jobId = mbxsync.{mailboxId}` 已按邮箱去重，无需更高（`:142-155`）
- **按 task_type 拆队列，而非单队列 + 全局并发**：并发按队列隔离，慢任务不饿死快任务（避免 head-of-line blocking）——`analysis` 卡住不会拖住 `email_reply`
- 与 stalled 配套：分钟级长任务需 `stalledInterval: 60s` / `maxStalledCount: 2`（`registry.ts:36-37`），沿用默认 30s 会误判长任务 stalled
- **定档值硬编码于 shared 常量，无环境变量覆盖**：`WORKER_QUEUES` 只能过滤启停队列，调并发需改代码

**层二：租户并发闸门**（`04-任务调度与队列.md:83-87`）

| 限制 | 口径 |
|---|---|
| 单员工并发 = 1 | 员工是单线程执行单元；占用集合 `{running, waiting_approval}`（`EMPLOYEE_OCCUPYING_TASK_STATUSES`），**挂起占员工位**——杜绝「挂起员工被派第二任务 → resume 双 running」 |
| org 总并发 = 10 | 仅统计 `running`（`ORG_CONCURRENCY_LIMIT`，MVP 常量）；`waiting_approval` **不占** org 额度 |

三处同口径（API 直投 / Dispatcher 每 2s / DelayedJobReconciler 60s）；超发由 `Runner.claim` 乐观锁（`UPDATE ai_task SET status='running' WHERE id=? AND status='scheduled'`，影响行数=0 则放弃）兜底，双实例安全。

**两层的乘积关系**：层一实际并发 = 定档值 × Worker 实例数，**扩实例只放大吞吐（消化速度），不突破租户上限**；层二是全局唯一上限。真正短板还可能是第三层——外部调用配额（员工日配额 200 计权 / org 搜索 2000 每天），超限任务转 `paused`（见 §2.3）。

**已知观察**：Dispatcher 投递后任务仍为 `scheduled`，需 `Runner.claim` 后才计 `running`，故 org 计数存在「已投递未 claim」的统计窗口；当前由 `jobId=taskId` 的 BullMQ 幂等 + claim 乐观锁兜住，不会双跑。

#### 入队路径（`packages/runtime/src/enqueue.ts`）

`TaskEnqueuer` 持有 8 个 `Queue` 实例，暴露 7 条入队入口：

| 方法 | jobId | 用途 |
|---|---|---|
| `enqueueTask` | `taskId` | 主链路：API 触发 / 调度到期 / delayed job（`:59-76`） |
| `enqueueResume` | `taskId` | 审批 approve/reject 后续跑，`job.data.resume={nodeId,approvalId}`（`:208-216`） |
| `enqueueResumeFromPause` | `taskId` | 暂停任务手动恢复，`fromPause=true` 从检查点续跑（`:223-231`） |
| `enqueueNotify` | 自动 | 通知分发，削峰（`:109-115`） |
| `enqueueWebhook` | 自动 | 出站投递，job 名含 `webhook:{id}`（`:123-132`） |
| `enqueueEmailSync` | `mbxsync.{mailboxId}` | 同邮箱活跃 job 唯一，防堆积（`:142-155`） |
| `enqueueKnowledgeIndex` | `kidx.{docId}` | 同文档重试/并发上传互斥（`:163-171`） |

> jobId 同样禁含 `:`（BullMQ 5 校验），统一用 `.` 分隔。

#### 重试与留存策略（`enqueue.ts:36-55`）

```ts
const autoRetry = taskQueues.has(name);   // 仅承载 ai_task 的 5 个队列开启自动重投
defaultJobOptions: {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
  attempts: autoRetry ? TASK_MAX_ATTEMPTS : 1,           // 3
  ...(autoRetry ? { backoff: { type: 'exponential', delay: TASK_RETRY_BACKOFF_MS } } : {}),  // 30s 起
}
```

- **任务队列**：attempts=3 + 指数退避 30s（可重试错误自动重投）
- **系统队列**（notify / email_sync / knowledge_index）：attempts=1（投递/同步失败重投无益，留痕即可）
- **webhook 队列**：job 级覆盖 attempts=5 + 指数退避 1m（`enqueue.ts:128-131`），出站投递需更强重试
- **痕迹在 DB 不在 Redis**：两类 `removeOn*` 保证 Redis 不无限膨胀

#### 延迟任务与对账

- `scheduled_at` 非空 → `queue.add(..., { delay: delayMs })` 走 BullMQ delayed（`enqueue.ts:73`）
- `DelayedJobReconciler` 每 60s 扫描「已到期但无活跃 job」的任务补投（`worker/src/scheduler/delayed-reconciler.ts:85,98`），兜底 Redis 丢 job
- 补投前执行与 Dispatcher 一致的闸门校验，且 `jobId=taskId` 保证幂等

#### BullMQ 幂等 no-op 陷阱（重要设计点）

`enqueue.ts:138-141, 173-201`：

> BullMQ `Queue.add` 对仍存在的同 jobId **幂等 no-op**（不更新、不重投）。而 `removeOnComplete/Fail` 会留存终态 job（1h/24h），导致 5min 周期的邮箱同步、手动重试、审批续跑被**静默吞掉**。

解法：`removeTerminalJob()` 在入队前清掉 `completed`/`failed` 的历史 job，仅保留 `waiting/active/delayed` 以维持「同 id 活跃 job 唯一」的互斥语义。

#### Worker 侧（`worker/src/queues/registry.ts:30-49`）

```ts
new Worker(queueName, processor, {
  connection: new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true }),
  concurrency: QUEUE_CONCURRENCY[queueName],
  stalledInterval: 60_000,   // 长任务（分钟级）给足 stalled 容忍
  maxStalledCount: 2,
});
```

- 每个队列一条独立 ioredis 连接（BullMQ 内部还会复制连接）
- `WORKER_QUEUES` 环境变量可过滤只启动部分队列（`registry.ts:24-28`）
- 优雅停机：`worker.close()` 让 BullMQ 等待当前 job，未完成的由 stalled 机制重投

#### Redis 中的实际结构

| 结构 | 用途 |
|---|---|
| List | `wait` / `active` / `paused` |
| ZSet | `delayed`（score = 可执行时间戳）、`priority`、`repeat` |
| Hash | job 数据 `bull:{queue}:{jobId}` |
| Stream | `bull:{queue}:events`（BullMQ 5 job 事件日志） |

---

### 2.2 职责二：实时广播（Pub/Sub）

#### 为什么需要

任务执行分钟级，前端需要实时看到日志/进度/状态。方案是 **Worker 写库 → Redis PUBLISH → API SSE 转发**，端到端 < 2s。

#### 完整链路

```
Worker 节点完成
  → DB 写入（ai_task_log / ai_task.progress_pct / current_step / status）
  → flushBufferedEvents()
  → TaskEventPublisher.publish()  【zod 校验】
  → PUBLISH task:{taskId}:events
                                     ↓
API TaskStreamController（GET /tasks/:id/stream）
  → 鉴权 → redis.duplicate() 建订阅连接
  → SUBSCRIBE task:{taskId}:events   【订阅先行】
  → 回放：按 ?after={logId} 从 DB 补齐增量日志（sendLog 按 logId 去重）
  → 重读任务行：已终态则补发 status + done 并关闭
  → 实时转发 + 15s 心跳 + 5s 终态兜底轮询
```

#### 频道与事件契约

- 频道：`task:{taskId}:events`（`shared/src/sse/events.ts:84-86`）
- 事件类型（`events.ts:9-14`）：`log` / `progress` / `status` / `done`
- `seq`：雪花 ID 的 **Crockford 编码**（`events.ts:16-21`），字典序 = 时间序，客户端作去重游标
- 发布前强制 `taskEventSchema.safeParse`，不符契约**直接抛错**（`events.ts:66-72`）——宁可不发也不发脏数据
- 批量发布 `publishAll` 是 `for` 循环串行 `publish`，**非 pipeline**（`events.ts:77-81`）

#### 三个关键设计点

**① 必须用 `redis.duplicate()` 建独立订阅连接**（`task-stream.controller.ts:94`）
ioredis 连接进入 subscriber 模式后不能再执行普通命令，所以 SSE 每条连接都复制一条独立连接。

**② 订阅先行，再回放**（`task-stream.controller.ts:93` 注释）
先 `SUBSCRIBE` 再查 DB 回放，避免「回放查询」与「订阅回调」之间的 PUBLISH 丢失。双通道可能投递同一条日志，用 `sentLogIds: Set<string>` 按 `logId` 去重（M3-09）。

**③ 三层兜底弥合崩溃窗口**

| 层 | 机制 | 弥合的窗口 |
|---|---|---|
| M3-03 | 订阅成功后**重读一次任务行**，已终态则补发 status+done 并关闭 | ① 读快照与订阅成功之间的终态提交 |
| M3-11 | 非终态连接每 **5s** 重读任务行（`TERMINAL_POLL_MS`），DB 已终态且未发过 done → 补发并关闭 | Worker commit → PUBLISH done 之间崩溃 |
| 心跳 | SSE 15s 心跳保活 | 连接假死 |

#### 明确的设计取舍（不引入 outbox）

`后端技术方案文档/04-任务调度与队列.md:182-184`：

> 事件通道采用「先写库、后 PUBLISH」，MVP 不引入事务 outbox……Worker 在「终态事务提交」与「PUBLISH done」之间崩溃 → 该 done 永久丢失。**DB 是任务最终一致性的权威源，Redis 事件仅作实时广播、不承担送达保证**。

即：Pub/Sub 是**尽力而为**的加速通道，正确性由 DB + 轮询兜底保证。

#### 连接上限（已知待办）

单用户 ≤10、org ≤200，超限 `42901`（`task-stream.controller.ts:28-30, 70-79`）。
**当前用进程内 `Map` 计数**，多实例部署时约束失效；代码注释 `:26` 已标注「多实例共享计数随 M4 部署扩展（Redis 计数）」。

#### 资源清理

`cleanup()` 幂等（`:294-324`）：`res.end()` → `subscriber.unsubscribe()` → `subscriber.quit().catch(() => disconnect())`，`__cleaned` 标记防重入；`subscribe` 抛错路径同样走 cleanup 递减计数（M3-10，防连接泄漏）。

---

### 2.3 职责三：频控 / 配额（令牌桶）

分**三层**，从接入层到业务层逐级收紧。

#### 层一：接入层 IP 限流（`api/src/common/middleware/rate-limit.middleware.ts`）

```ts
const minuteIndex = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));  // 固定窗口
const key = `rl:${ip}:${minuteIndex}`;
const used = await this.redis.incr(key);
if (used === 1) await this.redis.expire(key, WINDOW_SECONDS + 5);      // 65s
if (used > limit) → 42901
```

- 默认 **600 req/min/IP**（`DEFAULT_LIMIT = 600`），`RATE_LIMIT_PER_MINUTE=0` 关闭
- 豁免 `/healthz` `/readyz` `/metrics`（K8s 高频抓取）
- **fail-open**：Redis 异常吞掉继续 `next()`（`:61-63`）
- 阈值解析坑（`:18-30`）：`Number('') === 0` 会把「未配置」误判为「显式关闭」，故未配置/空白回落 600，仅显式 `0` 才关闭

#### 层二：认证与开放 API 限流

| 场景 | Key | 阈值 | 位置 |
|---|---|---|---|
| 登录（账号维） | `rl:login:u:{email}` | 5 次 / 15min | `auth.service.ts:304-311` |
| 登录（IP 维） | `rl:login:ip:{clientIp}` | 30 次 / 15min | `auth.service.ts:313-319` |
| 开放 API Key | `rl:apikey:{apiKeyId}:{windowIndex}` | `API_KEY_RATE_LIMIT_PER_MINUTE` | `api-key.service.ts:183-192` |

同样是「INCR + 首次 EXPIRE」固定窗口；API Key 限流 **fail-open**（仅吞非 `BizException`）。

#### 层三：业务配额（加权令牌桶）

**员工外部调用日配额**（`packages/tools/src/registry.ts:112-132`）

```ts
const weight = tool.quotaWeight ?? 0;          // search×1 / crawl×2 / lookup×1
if (weight === 0) return;                       // 非外部调用工具不计额
const day = zonedDayKey(ctx.now, ctx.timezone || 'Asia/Shanghai');
const key = `quota:${ctx.orgId}:${ctx.employeeId}:${day}`;
const used = await ctx.redis.incrby(key, weight);
if (used === weight) await ctx.redis.expire(key, 48 * 3600);
if (used > dailyLimit) throw new BizException(ErrorCode.RATE_LIMITED, ...);
```

**org 搜索/抓取日额度**（`packages/tools/src/builtin/quotas.ts:46-63`）：key `orgsearch:{orgId}:{day@tz}`，默认 2000，同构。

超限行为：抛 `RATE_LIMITED`（42901）→ 任务转 `paused`，`outputs` 提示额度用尽，次日重置后手动 resume。

#### 日界精确轮换：不清零的设计

`worker/src/scheduler/quota-reset.ts:1-9`

> 配额本身**无需清零**：`quota:{org}:{emp}:{day@tz}` 与 `orgsearch:{org}:{day@tz}` 均按 org 时区**日分片**，当地零点后自动落在新 key 上，旧 key 随 48h TTL 过期。

`QuotaResetScanner` 每 **5min** 扫描全部 org，用 `SET quotareset:{orgId}:{day} 1 EX 48h NX` 写日界标记：

- 返回 `OK` = 该 org 进入新的当地日 → 日志留痕 + 通知入队
- 写入失败只 warn「下轮重试」，不抛错

即「精确重置」= **分片 key 天然轮换** + **扫描器日界留痕**共同构成，避免了对海量 key 做清零扫描。

#### 熔断计数器

`emailsync:fail:{mailboxId}`（`worker/src/queues/email-sync.ts:28,133-134`）：连续失败 **3 次** → 邮箱 status 置 `error`；成功或凭据失效时清零（`:119,152`）。TTL 7d。

---

### 2.4 职责四：可撤销状态

这一类的共同特征：**短期、带明确 TTL、DB 有兜底**，Redis 只用来实现「即时失效」这个 DB 难以低成本做到的语义。

#### ① refresh token 撤销表

`token.service.ts:54-98`

```ts
// 签发：写 Redis（TTL 与 JWT 过期严格对齐）
await this.redis.set(`refresh:${p.sub}:${jti}`, '1', 'EX', REFRESH_TTL_SECONDS);  // 14d

// 校验：签名通过后查撤销表
const stored = await this.redis.get(`refresh:${payload.sub}:${payload.jti}`);
if (stored === null) throw new BizException(ErrorCode.UNAUTHORIZED, '登录已失效');

// 撤销：logout / 轮换时 DEL
await this.redis.del(`refresh:${payload.sub}:${payload.jti}`);
```

- access 2h / refresh 14d（`ACCESS_TTL_SECONDS` / `REFRESH_TTL_SECONDS`，`:15-16`）
- JWT 是无状态的，Redis 撤销表是**唯一**能让 refresh 立即失效的手段
- **fail-closed**：Redis 挂 → 所有 refresh 校验失败（见 §10 问题 5）

#### ② 用户角色缓存 `uctx:{userId}`（30s）

`auth.service.ts:266-282`。权限以**库内角色为准**（JWT 里的 role 只是冗余），缓存 30s 减少查库；角色变更时 `org.service.ts:276` 主动删 key 使其立即生效。

#### ③ 成员停用标记 `disabled:{userId}`（30d）

- 写：成员停用时 `SET disabled:{userId} 1 EX 30d`（`org.service.ts:279`）
- 读：`JwtAuthGuard` 每请求校验（`auth.service.ts:295`），命中即拒绝
- 删：重新启用时 `DEL`（`org.service.ts:282`）
- 解决的是「access token 2h 内无法主动失效」的问题

#### ④ 邀请 token `invite:{token}`（7d，单次有效）

- 生成：`randomBytes(24).base64url`，`SET invite:{token} {orgId,email,role,invitedBy} EX 7d`（`org.service.ts:220-225`）
- 消费：注册时读取（`auth.service.ts:169`）→ 用后即删（`:212`），保证单次有效
- 无 DB 表承载，纯 Redis —— 丢失仅影响邀请需重新生成

#### ⑤ 任务心跳 `task:{taskId}:heartbeat`（90s TTL / 30s 刷新）

`packages/runtime/src/runner.ts:24-25, 660-676`

```ts
export function heartbeatKey(taskId: string): string {
  return `task:${taskId}:heartbeat`;   // 值 = process.pid
}
```

- Worker 每 30s 写入，TTL 90s；任务收尾时清理（6 处）
- 写入静默吞异常（`runner.ts:664`），心跳失败不阻断任务
- `ZombieReaper` 每 60s：`running` 且 `started_at` 超 30min 且 `exists(heartbeat) === 0` → 置 `failed('timeout')`
- 用途：识别 Worker 进程被 kill / 节点崩溃导致的「假 running」任务

#### ⑥ 工具执行幂等 `idem:{taskId}:{nodeId}[:{salt}]`（24h）

`packages/tools/src/registry.ts:159-180`

```ts
export function toolIdempotencyKey(ctx, salt?): string {
  return salt ? `idem:${ctx.taskId}:${ctx.nodeId}:${salt}` : `idem:${ctx.taskId}:${ctx.nodeId}`;
}

export async function withIdempotency<T>(ctx, key, ttlSeconds, fn) {
  const ok = await ctx.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  if (ok !== 'OK') return { first: false, result: undefined as T };   // 已执行过，跳过
  const result = await fn();
  return { first: true, result };
}
```

- `salt` = `messageHash`（sha256(subject+body).slice(0,16)），用于 `email_send` 区分不同内容
- **重试不重复外发**（邮件/外部 API 这类不可回滚副作用）
- 发送失败时主动 `DEL` 释放幂等键，允许重投（`crm-tools.ts:495`）
- 语义上承担了「分布式锁」角色，但**无续期、无可重入、无 Redlock**（见 §10 问题 9）

---

### 2.5 未启用的 Redis 能力（当前取舍）

| 能力 | 是否使用 | 说明 |
|---|---|---|
| **Lua 脚本 / `eval` / `defineCommand`** | ❌ | 全仓无。限流、配额、幂等均用原生单命令或两命令组合实现 |
| **事务 `MULTI` / `WATCH`** | ❌ | 业务代码无（BullMQ 内部使用）。`SET NX` 系列为单条原子命令，无需事务 |
| **`SCAN` 系列** | ❌ | 无键遍历需求；配额靠 key 分片轮换，不做批量清理 |
| **pipeline** | ❌ | 逐条命令；`publishAll` 是 `for` 循环串行 publish |
| **ZSet / List / Set / Hash / Stream（业务侧）** | ❌ | 业务侧只用 String + Pub/Sub；这些结构仅由 BullMQ 内部使用 |
| **Redis Cluster / 哨兵** | ❌ | 单实例 / 托管实例；`REDIS_URL` 单点配置 |
| **独立 db 隔离** | ❌ | 全部走 db0；测试共用同一实例（见 §10 问题 7） |

**影响与风险**：

- 不用 Lua → 「INCR + EXPIRE」两命令**非原子**，中间崩溃会留下无 TTL 的计数键（见 §10 问题 2）。用 Lua 或一个 `INCR` + `EXPIRE` 合并脚本即可根治
- 不用 pipeline → 批量事件发布（节点提交后 flush 缓冲）是 N 次 RTT，事件量大时有延迟，当前量级可接受
- 不用 Stream 做事件总线 → Pub/Sub 不持久化，掉事件只能靠 DB 轮询补（已由三层兜底覆盖）

---

## 3. 客户端创建与配置

### 3.1 全部实例化点

| # | 位置 | 配置 | 用途 |
|---|---|---|---|
| 1 | `server/apps/api/src/redis/redis.module.ts:11` | `new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false })` | **API 全局单例**（Nest `@Global()`，DI token `REDIS`） |
| 2 | `server/apps/worker/src/index.ts:69` | `new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })` | **Worker 主连接**：TaskEventPublisher / Runner / ApprovalGate / GraphCompiler / ZombieReaper / QuotaReset 共用 |
| 3 | `server/apps/worker/src/queues/registry.ts:33` | `new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true })` | **每个 BullMQ Worker 一条独立连接**（8 队列 → 8 条） |
| 4 | `server/packages/runtime/src/enqueue.ts:44` | `new IORedis(redisUrl, { maxRetriesPerRequest: null })` | **每个 BullMQ Queue 一条**（`TaskEnqueuer` 为 8 个队列各建一个） |
| 5 | `server/apps/api/src/health/health.controller.ts:59-64` | `new Redis(REDIS_URL, { connectTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true })` | `/readyz` 探测临时建连，用完 `disconnect()` |

### 3.2 配置特征

- **单例 vs 多实例**：API 侧是进程级单例；Worker 侧非单例。
  `TaskEnqueuer` 在 API 侧被 `tasks.service.ts:74`、`approvals.service.ts:63`、`knowledge.service.ts:35`、`orders.service.ts:106`、`products.service.ts:43`、`quotes.service.ts:92` **各自 new 一次**，每个又建 8 条连接 → API 进程实际有数十条 Redis 连接（见 §10 问题 1）
- **db 选择**：未使用，全部走 db0
- **keyPrefix**：**未设置**（`api-key.service.ts:31` 的 `keyPrefix` 是 API Key 展示前缀 `tpk_live_xxx`，与 ioredis 无关）
- **maxRetriesPerRequest**：API = 2；Worker / BullMQ = `null`（BullMQ 阻塞命令要求）
- **retryStrategy**：仅 `/readyz` 覆盖为 `() => null`，其余走 ioredis 默认指数退避
- **TLS / 账号密码**：全部由 `REDIS_URL` 承载，代码无额外处理

---

## 4. 封装层清单

| 封装层 | 文件 | 职责 |
|---|---|---|
| `RedisModule` | `api/src/redis/redis.module.ts` | `@Global()` 模块，provider token `REDIS`，实现 `OnApplicationShutdown` |
| `TaskEnqueuer` | `packages/runtime/src/enqueue.ts` | BullMQ 入队封装：8 个 Queue + 7 条入队路径；`removeTerminalJob` 规避幂等 no-op 陷阱 |
| `TaskEventPublisher` | `packages/runtime/src/events.ts:62-82` | `publish(taskId, event)` 经 `taskEventSchema` 校验后 `PUBLISH` |
| `createWorkers` | `worker/src/queues/registry.ts:18-50` | 按队列注册 Worker，`stalledInterval: 60_000`、`maxStalledCount: 2` |
| `RateLimitMiddleware` | `api/src/common/middleware/rate-limit.middleware.ts` | 全局 IP 固定窗口限流，fail-open |
| `TokenService` | `api/src/auth/token.service.ts` | refresh token 存 / 取 / 删（可撤销） |
| `ApiKeyService` | `api/src/open-api/api-key.service.ts:178-199` | 每 Key 固定窗口限流，fail-open |
| `AuthService` | `api/src/auth/auth.service.ts:263-321` | 角色缓存、停用标记、登录双维限流 |
| `ToolRegistry` | `packages/tools/src/registry.ts:112-180` | `assertQuota`（INCRBY 令牌桶）、`toolIdempotencyKey`、`withIdempotency`（SET NX） |
| org 搜索配额 | `packages/tools/src/builtin/quotas.ts:46-63` | `assertOrgSearchQuota`（INCRBY + 48h TTL） |
| `TaskStreamController` | `api/src/tasks/task-stream.controller.ts` | `redis.duplicate()` 建订阅连接 → SUBSCRIBE → 回放 → 转发 SSE |
| `ZombieReaper` | `worker/src/scheduler/zombie-reaper.ts` | 读心跳判活，收割僵尸任务 |
| `QuotaResetScanner` | `worker/src/scheduler/quota-reset.ts` | `SET NX` 写配额日界标记 |
| `EmailSyncProcessor` | `worker/src/queues/email-sync.ts` | 同步连续失败计数熔断 |
| `HealthController` | `api/src/health/health.controller.ts:57-74` | `/readyz` Redis 连通性探针 |

> 无独立「分布式锁」封装：`withIdempotency` 用 `SET NX` 承担锁语义，无 TTL 续期、无 Redlock、无可重入。
> 无独立「缓存 service」：缓存逻辑散落在各业务 service 中直接调 `this.redis`。

---

## 5. Redis Key 全表

| Key 模式 | 类型 | TTL | 读 | 写 | 删 |
|---|---|---|---|---|---|
| `refresh:{userId}:{jti}` | String | 14d | `token.service.ts:81` | `:63` | `:93` |
| `uctx:{userId}` | String | 30s | `auth.service.ts:267` | `:282` | `org.service.ts:276` |
| `disabled:{userId}` | String | 30d | `auth.service.ts:295` | `org.service.ts:279` | `org.service.ts:282` |
| `invite:{token}` | String(JSON) | 7d | `auth.service.ts:169` | `org.service.ts:220` | `auth.service.ts:212` |
| `rl:{ip}:{minuteIndex}` | String | 65s | — | `rate-limit.middleware.ts:48,50` | — |
| `rl:login:u:{email}` | String | 900s | — | `auth.service.ts:305,307` | 测试 `auth-login-rls:106` |
| `rl:login:ip:{ip}` | String | 900s | — | `auth.service.ts:314,316` | 同上 |
| `rl:apikey:{id}:{window}` | String | 65s | — | `api-key.service.ts:186,188` | — |
| `quota:{orgId}:{empId}:{day@tz}` | String | 48h | — | `tools/registry.ts:125,127` | — |
| `orgsearch:{orgId}:{day@tz}` | String | 48h | — | `tools/quotas.ts:53,55` | — |
| `idem:{taskId}:{nodeId}[:{salt}]` | String | 24h | — | `tools/registry.ts:174`（SET NX） | `crm-tools.ts:495` |
| `task:{taskId}:heartbeat` | String(pid) | 90s | `zombie-reaper.ts:60` | `runner.ts:664` | `runner.ts:177/186/193/531/579/630`、`zombie-reaper.ts:104` |
| `emailsync:fail:{mailboxId}` | String | 7d | — | `email-sync.ts:133,134` | `:119,152` |
| `quotareset:{orgId}:{day}` | String | 48h | — | `quota-reset.ts:45`（SET NX） | — |
| `task:{taskId}:events` | **Pub/Sub 频道** | — | `task-stream.controller.ts:154` | `runtime/events.ts:73` | `unsubscribe` `:322` |
| `bull:q.*:*` | List/ZSet/Hash/Stream | BullMQ 管理 | — | BullMQ | `removeOnComplete {age:3600,count:1000}` / `removeOnFail {age:24h}` |

**命名空间说明**：`task:{id}:heartbeat`（String）与 `task:{id}:events`（Pub/Sub）共用 `task:{id}:` 前缀；`rl:` 前缀被三处限流共用，靠中间段区分。

---

## 6. 业务场景分类

### 6.1 会话 / Token

| 目的 | 结构 | Key | TTL | 位置 |
|---|---|---|---|---|
| refresh token 可撤销存储 | String（值 `'1'`） | `refresh:{userId}:{jti}` | 14d（与 JWT 对齐） | `token.service.ts:63/81/93` |
| 用户角色缓存（库内角色为准） | String | `uctx:{userId}` | 30s | `auth.service.ts:266-282` |
| 成员停用即时失效标记 | String（`'1'`） | `disabled:{userId}` | 30d | 写 `org.service.ts:279`；读 `auth.service.ts:295` |
| 邀请 token（单次有效） | String(JSON) | `invite:{inviteToken}` | 7d | 写 `org.service.ts:220`；消费即删 `auth.service.ts:212` |

JWT 常量：`token.service.ts:15-16` — `ACCESS_TTL_SECONDS = 2h`、`REFRESH_TTL_SECONDS = 14d`。

### 6.2 限流 / 频控

| 目的 | Key | TTL | 阈值 | 降级 |
|---|---|---|---|---|
| 全局 IP 接口限流 | `rl:{ip}:{minuteIndex}` | 65s | 600 req/min（`RATE_LIMIT_PER_MINUTE=0` 关闭） | **fail-open** |
| 登录限流（账号） | `rl:login:u:{email}` | 900s | 5 次 / 15min | 无兜底 |
| 登录限流（IP） | `rl:login:ip:{clientIp}` | 900s | 30 次 / 15min | 无兜底 |
| 开放 API Key 限流 | `rl:apikey:{apiKeyId}:{windowIndex}` | 65s | `API_KEY_RATE_LIMIT_PER_MINUTE` | **fail-open** |
| 员工外部调用日配额 | `quota:{orgId}:{employeeId}:{day@tz}` | 48h | 默认 200（INCRBY 计权） | — |
| org 搜索/抓取日配额 | `orgsearch:{orgId}:{day@tz}` | 48h | 默认 2000 | — |

计数均为固定窗口 / 令牌桶，`minuteIndex = floor(now/60000)`，日界按 **org 时区**分片（`zonedDayKey`）。
计权：`search ×1 / crawl ×2 / lookup ×1`。
豁免路径：`/healthz`、`/readyz`、`/metrics`。

### 6.3 幂等

| 目的 | Key | TTL | 位置 |
|---|---|---|---|
| 工具执行幂等（防重复外发） | `idem:{taskId}:{nodeId}[:{salt}]`（salt = sha256(subject+body).slice(0,16)） | 24h | `tools/registry.ts:160-180` |
| 幂等键释放（发送失败可重投） | 同上（`DEL`） | — | `crm-tools.ts:495` |
| BullMQ 防重复入队 | `jobId = taskId` / `mbxsync.{mailboxId}` / `kidx.{docId}` | — | `enqueue.ts:72,147,168,215,230` |

> `后端技术方案文档/04-任务调度与队列.md:130` 提到「API 层请求幂等键可选（`Idempotency-Key` header → Redis 10min）」，前端 `web/src/api/http.ts:65-71` 确实发送该 header，但**后端无 Redis 侧消费点**（见 §10 问题 4）。

### 6.4 任务心跳 / 僵尸收割

- Key：`task:{taskId}:heartbeat`，值 = `process.pid`，TTL 90s，每 30s 刷新
- 常量：`runtime/src/runner.ts:24-25`（`HEARTBEAT_INTERVAL_MS = 30_000`、`HEARTBEAT_TTL_S = 90`）
- 写入 `runner.ts:660-669`；清理 `runner.ts:177,186,193,531,579,630`；判活 `zombie-reaper.ts:60`
- 规则：`running` 且 `started_at` 超 30min 且 `exists(heartbeat) === 0` → 置 `failed('timeout')`

### 6.5 计数 / 熔断

| 目的 | Key | TTL | 阈值 |
|---|---|---|---|
| 邮箱同步连续失败计数 | `emailsync:fail:{mailboxId}` | 7d | 连续 3 次 → status = `error`（`email-sync.ts:28`） |
| 配额日界滚动标记 | `quotareset:{orgId}:{yyyyMMdd@tz}` | 48h | `SET ... EX ... NX` 返回 `OK` 表示进入新当地日 |

配额**不清零**，靠「按 org 时区日分片的 key 天然轮换 + 旧 key TTL 过期」实现精确重置。

### 6.6 消息广播 / SSE（Pub/Sub）

| 项目 | 内容 |
|---|---|
| 频道 | `task:{taskId}:events`（`shared/src/sse/events.ts:84-86`） |
| 发布方 | `runtime/src/events.ts:73`（Worker）；API 侧 employees/approvals/tasks service 亦通过 `TaskEventPublisher` 发布 |
| 订阅方 | `task-stream.controller.ts:94` `redis.duplicate()` → `:152` `on('message')` → `:154` `subscribe(channel)` |
| 事件类型 | `log` / `progress` / `status` / `done`，每条带 `seq`（雪花 Crockford 编码，字典序 = 时间序，作客户端去重游标） |
| 契约校验 | 发布前 `taskEventSchema.safeParse`，不符直接抛错 |
| 去重 | 回放与实时双通道按 `logId` 去重（`sentLogIds`） |
| 连接上限 | 单用户 ≤10、org ≤200 —— **进程内 Map 计数，非 Redis**（`task-stream.controller.ts:28-30,41-42,70-79`），多实例失效 |
| 兜底 | SSE 心跳 15s；终态兜底轮询 5s（覆盖 commit → PUBLISH 间崩溃） |
| 清理 | `cleanup()` 幂等：`res.end()` → `unsubscribe()` → `quit()` |

### 6.7 队列 / 延迟任务（BullMQ 内部数据结构）

见 §2.1，Redis 中实际结构由 BullMQ 管理（List / ZSet / Hash / Stream），业务代码不直接操作。

### 6.8 未使用的数据结构

业务侧**无** ZSet / List / Set / Stream / Hash 的直接操作，仅用 **String**（`get/set/setex/incr/incrby/del/expire/exists/set NX`）与 **Pub/Sub**。
**无验证码 / OTP 场景**。

---

## 7. 连接生命周期管理

### 7.1 初始化

- **API**：Nest DI 启动时 `RedisModule` 的 `useFactory` 执行，`lazyConnect: false` → 工厂返回即建连；模块注册于 `app.module.ts:43`（`security.module.ts:12` 再次 import，`@Global()` 保证单例）
- **Worker**：`bootstrap()` 顺序建连（`index.ts:67-80`）：db → `IORedis` → Publisher → `TaskEnqueuer`（8 条 Queue 连接）→ schedulers；`createWorkers` 在 `:245-250` 建 8 条 Worker 连接
- **Env**：`api/src/config/env.ts:9-14` `loadEnv()` fail-fast + 进程内 memoize；`REDIS_URL` 由 `baseEnvSchema` 校验，必填

### 7.2 健康检查

- `/healthz`（liveness，不探依赖）：`health.controller.ts:21-25`
- `/readyz`（readiness）`checkRedis()`：`:57-74` 临时建连 → `ping()` → 判 `PONG` → 返回 `{ ok, latencyMs, error }`；无论成败均 `disconnect()`；失败整体 503 `status: 'degraded'`
- Docker：`server/docker/docker-compose.yml:33-37` `redis-cli ping`，interval 5s / timeout 3s / retries 10

### 7.3 重连与优雅关闭

- 重连：API 主连接 / Worker 主连接 / Queue 连接走 ioredis 默认退避；Worker 阻塞连接 `maxRetriesPerRequest: null`；`/readyz` 禁用重连
- API 关闭：`redis.module.ts:23-25`
  ```ts
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
  ```
  依赖 `main.ts:77` `app.enableShutdownHooks()`
- Worker 关闭：`index.ts:294-307` SIGTERM/SIGINT → 停扫描 → `workers.map(w => w.close())` → `Promise.allSettled([enqueuer.close(), checkpointer.close(), redis.quit()])` → 关 db → `process.exit(0)`；`shuttingDown` 防重入
- SSE 订阅：`task-stream.controller.ts:322-323` `unsubscribe()` → `quit().catch(() => disconnect())`，`__cleaned` 标记幂等

### 7.4 失败降级

**整体策略：限流 fail-open + 其余硬失败**

| 场景 | 行为 | 位置 |
|---|---|---|
| 全局 IP 限流 | **fail-open**，吞异常继续 `next()` | `rate-limit.middleware.ts:61-64` |
| API Key 限流 | **fail-open**（仅吞非 `BizException`） | `api-key.service.ts:193-198` |
| 心跳写入 | 静默吞 | `runner.ts:664` |
| 幂等键释放 | `.catch(() => undefined)` | `crm-tools.ts:495` |
| 配额日界标记 | 吞 → warn「下轮重试」 | `quota-reset.ts:59-64` |
| 心跳清理 | **无 catch**，Redis 挂导致任务收尾抛错 | `runner.ts:177/186/193/531/579/630` |
| refresh token 校验 | `null` → `UNAUTHORIZED`（**fail-closed**，Redis 挂 = 全体登出） | `token.service.ts:81-84` |
| 停用标记校验 | 无兜底 → 500 | `auth.service.ts:295` |
| 登录限流 | 无兜底 → 无法登录 | `auth.service.ts:300-321` |
| SSE 订阅 | 抛错 → cleanup 后 `return` | `task-stream.controller.ts:153-160` |

**无 Redis 的内存兜底**。仅两处独立的进程内缓存：org 时区缓存（`tools/quotas.ts:13-31`，Map 60s）、SSE 连接计数（`task-stream.controller.ts:41-42`）。
**PostgreSQL 兜底**：DB 为权威源，SSE 掉事件靠 5s 轮询补发，delayed job 丢失靠 60s 对账补投，僵尸任务靠 ZombieReaper 收割。

---

## 8. 环境变量与配置

| 变量 | 读取位置 | 默认值 |
|---|---|---|
| `REDIS_URL` | `shared/contracts/env.ts:13`（schema，必填）；`redis.module.ts:11`；`worker/src/index.ts:69,80,247`；`health.controller.ts:59`；各 service 的 `TaskEnqueuer` | **无（必填）** |
| `REDIS_PORT` | `server/docker/docker-compose.yml:30` | `6379` |
| `RATE_LIMIT_PER_MINUTE` | `rate-limit.middleware.ts:24`（直接读 `process.env`，**未进 zod schema**） | 600；显式 `0` = 关闭 |
| `API_KEY_RATE_LIMIT_PER_MINUTE` | `api-key.service.ts:218`（同上） | shared 常量 |
| `WORKER_QUEUES` | `worker/src/queues/registry.ts:24-28` | 空 = 全部队列 |

`server/.env.example:14-16`
```bash
# ===== Redis（BullMQ + Pub/Sub + 限流/令牌桶）=====
REDIS_PORT=6379
REDIS_URL=redis://localhost:6379
```

> `server/.env.test` 与 `.env.test.example` **不含** `REDIS_*`；测试用 `process.env.REDIS_URL ||= 'redis://localhost:6379'` 兜底。

---

## 9. 测试中的 Redis

**策略：集成测试全部连真实 Redis，无 mock 兜底。**

- `apps/api/vitest.config.ts:6`、`apps/worker/vitest.config.ts:5-7` 设 `fileParallelism=false`，串行化消除跨文件竞态
- API 集成测试（约 15 个文件）：`new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })`，手工 new controller，不启 Nest
- Worker 集成测试：`new IORedis(REDIS_URL, { maxRetriesPerRequest: null })`
- Pub/Sub 测试：`redis.duplicate()` + `subscribe`
- 真实 key 断言：`org-settings.integration.spec.ts:175`（`invite:{token}`）、`:215-217`（`disabled:{memberId}`）、`zombie-reaper.integration.spec.ts:178`（预置心跳）、`full-chain:333`（心跳已清）
- 限流 key 清理：`auth-login-rls.integration.spec.ts:106`
- 纯单测 mock：`runtime/test/approval-gate.test.ts:45` `redis: {} as Redis`
- `test/setup/` 下 `crypto.ts`、`providers.ts` **不初始化 Redis**

---

## 10. 风险与待办清单

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 1 | **连接数膨胀**：6 个 service 各 `new TaskEnqueuer`（8 条连接 = 48 条），除 `tasks.service.ts` 外无关闭钩子 | `tasks/approvals/knowledge/orders/products/quotes.service.ts` | API 进程 Redis 连接数远超预期 |
| 2 | **限流非原子**：`INCR` 与 `EXPIRE` 分两条命令（5 处），中间崩溃留下无 TTL 的 key | `rate-limit.middleware.ts:48-51`、`auth.service.ts:305-307`、`api-key.service.ts:186-188`、`email-sync.ts:133-134`、`quotas.ts:53-55`、`registry.ts:125-127` | 该 IP / Key 永久被限流（可用 Lua 根治，见 §2.5） |
| 3 | 限流阈值未纳入 zod schema，直接读 `process.env` | `rate-limit.middleware.ts:24`、`api-key.service.ts:218` | 无集中校验 |
| 4 | **`Idempotency-Key` header 有发送无消费**：前端发、后端无 Redis 幂等存储 | `web/src/api/http.ts:71` | 文档标注「可选」，实际未实现 |
| 5 | **fail-closed 风险**：refresh / 停用校验在 Redis 故障时拒绝请求，与限流 fail-open 策略相反 | `token.service.ts:81`、`auth.service.ts:295` | Redis 挂 = 全体登出 |
| 6 | 文档与代码不一致：08 §4 写 100 req/min（代码 600）；08 §5「200 封/天/org + 50 封/天/员工」发信令牌桶未实现 | `后端技术方案文档/08-安全设计与合规.md:46,56` | 安全设计未落地 |
| 7 | **测试与 dev 共用 Redis**（缺陷 14），未切独立 `REDIS_DB` | `docs/TradePilot-全流程测试用例.md:1136` | 本地 worker 消费测试 job，flaky |
| 8 | SSE 连接上限为进程内 Map，多实例下 org ≤200 约束失效（代码注释已标注待办） | `task-stream.controller.ts:26,41-42` | 多实例超限 |
| 9 | `withIdempotency` 非严格分布式锁：`SET NX` 无续期、无可重入、无 Redlock | `tools/registry.ts:168-180` | 长任务锁提前过期 |
| 10 | `/readyz` 每次探测新建连接后 `disconnect()` | `health.controller.ts:59` | K8s 高频抓取有建连开销 |
| 11 | Redis 故障时限流 fail-open 场景无测试覆盖（TC-NFR-32） | `docs/TradePilot-全流程测试用例.md:958` | 降级行为未验证 |
| 12 | **设计文档队列拓扑缺 `q.webhook`**：04 §1 表只有 7 个队列，代码 8 个 | `后端技术方案文档/04-任务调度与队列.md:12-20` vs `shared/src/contracts/queues.ts:8-17` | 后加的 webhook 队列未回写设计文档 |
| 13 | `QUEUE_CONCURRENCY` 硬编码于 shared 常量，无法通过环境变量按环境调并发 | `shared/src/contracts/queues.ts:21-30`；`registry.ts:24-28` | 扩容/压测只能改代码；`WORKER_QUEUES` 仅能过滤启停 |

---

## 11. 设计文档要点摘录

| 文档 | 要点 |
|---|---|
| `00-总纲与技术选型.md:50,90,119,158` | BullMQ + ioredis；架构图 `RD[(Redis 7 BullMQ + Pub/Sub + 令牌桶)]`；SSE 端到端 < 2s |
| `01-工程结构与编码规范.md:136,146` | 幂等键来源声明（taskId+nodeId / external_message_id）；集成测试用 Testcontainers PG16+pgvector / Redis7 |
| `03-认证授权与多租户.md:25-26,34,104` | 登录限流 5次/15min、IP 30次/15min；`disabled:{userId}`；refresh 14d Redis 可撤销；邀请 token 单次 7d |
| `04-任务调度与队列.md:12-20,22,25,55,83-87,96,128-132,147,151-155,161-187` | 队列并发基线（每 worker 1~5，按 job 画像定档）；并发闸门（员工 =1 / org =10）；队列 `q.` 前缀；`jobId=taskId`；DelayedJobReconciler 60s 补投；ZombieReaper 判活；「先写库后 PUBLISH」，DB 为权威源，Redis 不承担送达保证 |
| `06-外部集成设计.md:88-94` | 额度令牌桶 `quota:{orgId}:{employeeId}:{day}` INCRBY TTL 48h，超限任务转 paused |
| `08-安全设计与合规.md:46,56` | 全局限流、外发滥用防护（与代码存在偏差，见 §10-6） |
| `09-部署运维与可观测性.md:14,31,36,54` | docker compose redis7；生产 Redis 托管 AOF，可重建；`/readyz` 探 DB/Redis |
| `docs/TradePilot-架构图.md:55,372,387,451,566-578,1029` | `RDS[("Redis 7 队列 + Pub/Sub + 心跳 + 配额")]`；RateLimitMiddleware 600 req/min fail-open；ZombieReaper / QuotaResetScanner 说明 |
| `server/packages/runtime/README.md:90,220,349,354` | 心跳 30s/90s；PUBLISH → SSE；Publisher 复用 Worker 连接 |
| `server/packages/tools/README.md:79-80,104,155,189` | 幂等键、`zonedDayKey`、assertOrgSearchQuota |
