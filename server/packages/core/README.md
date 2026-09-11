# @tradepilot/core

TradePilot 后端的**基础能力包（无业务依赖、无 IO 依赖）**。

本包汇集全服务共享的「原语级」能力：统一错误码与异常、Snowflake ID、时区与发送窗口对齐、
金额十进制序列化、数据范围（scope）判定、敏感凭据加解密、知识文本分块、RRF 混合检索融合。
所有模块均为**纯函数 / 轻量类**，不依赖 Drizzle、Nest、Redis、LangGraph 等，可被
`api` / `worker` / 各 `packages/*` 无差别复用。

> 定位：**最底层依赖**。其它包可以依赖 `core`，`core` 不依赖任何本地包。

---

## 目录

- [设计原则](#设计原则)
- [模块一览](#模块一览)
  - [error-codes.ts — 错误码表](#error-codests--错误码表)
  - [errors.ts — 业务异常](#errorsts--业务异常)
  - [id.ts — Snowflake ID](#idts--snowflake-id)
  - [time-window.ts — 时区与发送窗口](#time-windowts--时区与发送窗口)
  - [money.ts — 金额序列化](#moneyts--金额序列化)
  - [scope.ts — 数据范围](#scopets--数据范围)
  - [crypto.ts — 凭据加解密](#cryptots--凭据加解密)
  - [text-chunk.ts — 文档清洗与分块](#text-chunkts--文档清洗与分块)
  - [rrf.ts — 混合检索融合](#rrfts--混合检索融合)
- [使用示例](#使用示例)
- [开发](#开发)

---

## 设计原则

1. **零本地依赖**：仅使用 `node:*` 内置模块（`crypto`）与语言内建能力，保证可被任意层引用。
2. **纯函数优先**：除 `Snowflake` 实例与格式化器缓存外无状态，便于单测与并发安全。
3. **单一实现点**：发送窗口对齐、scope 判定、错误码映射等在同一处收口，避免多处实现漂移。
4. **确定性**：时区换算不使用本地时区、金额不使用浮点、ID 字典序等于时间序，保证可复算可断言。

---

## 模块一览

### error-codes.ts — 错误码表

统一业务错误码，以及到 HTTP 状态码、默认文案的映射（接口总览 §2.5）。

| 导出                    | 说明                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ErrorCode`             | 错误码常量表（`OK` / `BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `BIZ_VALIDATION` / `RATE_LIMITED` / `INTERNAL` / `DEPENDENCY_UNAVAILABLE`） |
| `ErrorCodeValue`        | 错误码取值联合类型                                                                                                                                                         |
| `ERROR_HTTP_STATUS`     | 错误码 → HTTP 状态码映射                                                                                                                                                   |
| `ERROR_DEFAULT_MESSAGE` | 错误码 → 默认中文提示                                                                                                                                                      |

**约束**：业务代码禁止使用魔法数字，一律引用 `ErrorCode`。

### errors.ts — 业务异常

| 导出           | 说明                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `BizException` | service 层统一的业务异常类，携带 `code`（业务码）、`httpStatus`、`extra`（字段级 detail，如 Zod issues） |

提供一组静态工厂，避免手写魔法数字：`BizException.badRequest / unauthorized / forbidden /
notFound / conflict / bizValidation / rateLimited / dependencyUnavailable`。

全局异常过滤器将 `BizException` 映射为统一 envelope `{ code, message, data, traceId }`。

```ts
throw BizException.notFound(`AI 员工不存在: ${employeeId}`);
```

### id.ts — Snowflake ID

资源 ID 生成与解析（后端技术方案 02 §9、ER §2.2）。

- **格式**：`{前缀}_{Crockford雪花}`，例如 `task_01J8...`。
- **雪花结构**：41bit 毫秒（自定义纪元 `2026-01-01T00:00:00Z`）+ 10bit 机器位 + 12bit 序列。
- **编码**：Crockford Base32 定长 13 位，**字典序 = 时间序**，因此可直接作为 `after={logId}` 的游标。
- **时钟回拨保护**：回拨 > 5ms 抛错拒发，< 5ms 自旋等待。

| 导出                                  | 说明                                                             |
| ------------------------------------- | ---------------------------------------------------------------- |
| `Snowflake`                           | 雪花生成器类，`next(): bigint`、`Snowflake.decode(value)`        |
| `SnowflakeParts`                      | 解码结果（`timestampMs` / `machineId` / `sequence` / `epochMs`） |
| `initSnowflake(machineId, now?)`      | 替换全局默认实例（测试 / 多进程初始化）                          |
| `encodeCrockford` / `decodeCrockford` | 定长 Base32 编解码（解码容忍小写与 `I/L→1`、`O→0`）              |
| `createId(prefix)`                    | 生成 `{前缀}_{雪花}` 形态 ID                                     |
| `isIdWithPrefix(id, prefix)`          | 校验 ID 形态（防注入式枚举，02 §7）                              |
| `parseId(id)`                         | 解析出前缀与雪花成分（调试 / 游标换算）                          |
| `ID_PREFIX`                           | 各资源类型前缀对照表                                             |
| `IdPrefix`                            | 前缀取值联合类型                                                 |

```ts
createId(ID_PREFIX.task); // task_0XXXXXXXXXXXX
parseId('task_0XXXXXXXXXXXX').epochMs;
```

> 默认实例机器位取环境变量 `WORKER_INDEX`（缺省 `1`，自动 clamp 到 10bit 范围）。

### time-window.ts — 时区与发送窗口

发送窗口对齐与频控顺延的**唯一实现点**（后端技术方案 04 §3.2）。库层一律 UTC，
本模块集中处理时区换算与墙钟日边界。

- **窗口对齐 `alignToSendWindow(target)`**：当地 < `startHour` → 当日窗口起点；≥ `endHour` → 次日窗口起点；窗口内保持。默认窗口 `09:00–18:00`。
- **频控顺延 `computeDeferredNextRunAt`**：`target = max(next_run_at, L + minTouchIntervalDays 天)`，再对齐发送窗口（`L` = 客户最近一次 outbound 时间）。Scheduler 预检与图内 `schedule_next` 均复用此函数，保证排期单一写入口。

| 导出                                           | 说明                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `SendWindow` / `DEFAULT_SEND_WINDOW`           | 发送窗口类型与默认值（09–18）                               |
| `ZonedWallTime`                                | 时区墙钟时间结构                                            |
| `getZonedWallTime(date, timeZone)`             | UTC → 指定时区墙钟（不含毫秒）                              |
| `zonedDayKey(date, timeZone)`                  | 墙钟日 key（`yyyyMMdd`），用于按 org 时区日界轮换的外部配额 |
| `zonedWallTimeToUtc(wall, timeZone)`           | 墙钟 → UTC（两遍法处理 DST 边界）                           |
| `alignToSendWindow(target, timeZone, window?)` | 对齐到发送窗口                                              |
| `computeDeferredNextRunAt(input)`              | 频控顺延目标公式                                            |
| `FrequencyDeferralInput`                       | 顺延计算的入参结构                                          |

### money.ts — 金额序列化

金额出入参一律**十进制字符串**（如 `"12500.00"`）+ `currency`，库内 `numeric`，
杜绝浮点误差（后端技术方案 02 §7、接口总览 §2.1）。不引入 `decimal.js`。

| 导出                                   | 说明                                                |
| -------------------------------------- | --------------------------------------------------- |
| `isValidAmount(value)`                 | 校验十进制金额形态                                  |
| `normalizeAmount(value, scale=2)`      | half-up 四舍五入 → 定标字符串                       |
| `amountToScaledBigInt(value, scale=2)` | 金额 → 缩放整数 `BigInt`（无误差运算 / 入库前校验） |

```ts
normalizeAmount('12500.005'); // '12500.01'
amountToScaledBigInt('12500.00'); // 1250000n
```

### scope.ts — 数据范围

数据范围 `self | team | all` 判定的**单一实现点**（后端技术方案 03 §4.1）。RLS 只解决
org 之间隔离；org 之内按 `owner_id` 裁剪由 `packages/db` 的 `applyOwnerScope` 落地。

| 导出                                  | 说明                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `Scope` / `Role`                      | 数据范围与角色类型（`admin` → `all`、`manager` → `team`、`sales` → `self`） |
| `assertScopeAllowed(role, requested)` | 请求 scope 超出角色上限 → `40301`                                           |
| `resolveScope(role, requested?)`      | 生效 scope = `min(请求 scope, 角色上限)`，缺省取上限                        |

### crypto.ts — 凭据加解密

敏感凭据加密（后端技术方案 08 §2）：**AES-256-GCM**，主密钥 `ENCRYPTION_KEY`
（64 位 hex = 32 字节），每行独立 IV + authTag。

- 密文格式：`v1:{iv_hex}:{tag_hex}:{cipher_hex}`。
- 接口层永不回显明文（16 §3.3）。

| 导出                             | 说明                               |
| -------------------------------- | ---------------------------------- |
| `encryptSecret(plain, keyHex)`   | 加密 → `v1:iv:tag:cipher`          |
| `decryptSecret(encoded, keyHex)` | 解密；格式 / 校验不合法抛错        |
| `safeEqual(a, b)`                | 恒时字符串比较（webhook 签名校验） |

### text-chunk.ts — 文档清洗与分块

知识入库的文本处理（后端技术方案 07 §2 ②③），纯函数无 IO，单测覆盖确定性。

- **token 估算口径**：Latin ≈ 4 字符/token，CJK ≈ 1.5 字符/token（逐字符加权）。
- **分块**：块长 ~500 token、overlap ~10%；标题层级优先切分，超长段按行滑窗。

| 导出                            | 说明                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `cleanDocumentText(raw)`        | 清洗：全角空白归一、空白折叠、剔除出现 ≥3 次的短行（页眉页脚）      |
| `estimateTokens(text)`          | 粗略 token 估算（分块配额与 `token_count` 留痕，非计费口径）        |
| `chunkDocumentText(raw, opts?)` | 结构感知分块 → `TextChunk[]`（携带 `headingPath` 元数据）           |
| `TextChunk` / `ChunkOptions`    | 块结构（`index` / `content` / `tokenCount` / `metadata`）与分块参数 |

### rrf.ts — 混合检索融合

混合检索 RRF 融合（后端技术方案 07 §4.1）：多路召回（向量 / 全文 / trgm 相似度）各按名次
取倒数分，`RRF 分数 = Σ 1/(k + rank)`，`k = 60`。纯函数——SQL 侧只产名次，融合在此复算，
便于单测与调参（07 §5 融合权重可配置）。

| 导出                            | 说明                                                     |
| ------------------------------- | -------------------------------------------------------- |
| `RRF_K`                         | 融合常数（默认 60）                                      |
| `RrfCandidate`                  | 单路候选（`id` / `rank`）                                |
| `rrfScore(rank, k?)`            | 单路名次 → RRF 分量                                      |
| `fuseRrf(lists, k?)`            | 多路融合：同 id 分数求和，降序；并列按 id 字典序稳定排序 |
| `SearchScene`                   | 检索场景类型                                             |
| `sceneCategories(scene?)`       | 场景 → 类目召回偏置（`null` = 不限类目）                 |
| `sceneTopK(scene?, fallback=5)` | 场景 → Top-K（`business_analysis` 至少 10）              |

---

## 使用示例

```ts
import {
  BizException,
  ErrorCode,
  createId,
  ID_PREFIX,
  alignToSendWindow,
  normalizeAmount,
  resolveScope,
  chunkDocumentText,
  fuseRrf,
} from '@tradepilot/core';

// 生成任务 ID 并做存在性校验
const taskId = createId(ID_PREFIX.task);
if (!taskId) throw BizException.notFound('任务不存在');

// 金额规范化
const amount = normalizeAmount(req.amount); // '12500.00'

// 发送窗口对齐（企业当地时间 09:00–18:00）
const when = alignToSendWindow(new Date(), 'Asia/Shanghai');

// 数据范围收敛
const scope = resolveScope(user.role, req.scope);

// 知识文本分块
const chunks = chunkDocumentText(rawText, { maxTokens: 500, overlapRatio: 0.1 });

// 多路召回融合
const fused = fuseRrf([vectorHits, fulltextHits, trgmHits]);
```

---

## 开发

```bash
pnpm --filter @tradepilot/core build      # tsc 构建到 dist/
pnpm --filter @tradepilot/core typecheck  # 类型检查
pnpm --filter @tradepilot/core test       # vitest 单测
pnpm --filter @tradepilot/core lint       # eslint
```

**新增能力时**：保持模块零本地依赖与纯函数风格；对外统一经 `src/index.ts` 重导出；
涉及多个消费方的语义（如时间、金额、scope）应在本包收敛为单一实现点。
