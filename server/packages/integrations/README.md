# @tradepilot/integrations

TradePilot 后端的**外部集成适配层包**：把与外部系统交互的差异收敛为稳定的本地接口。

涵盖四类适配——**邮箱驱动**（Gmail / Outlook / SMTP-IMAP）、**搜索与抓取**（web_search / site_crawl）、
**嵌入服务**（OpenAI 兼容 / mock）、**对象存储**（S3 兼容 / MinIO）。上层
（`api` / `worker` / `packages/tools`）一律只面向其接口与进程级注入消费，
**不直接引入各供应商 SDK**。

依据后端技术方案 **06（外部集成）、07（知识检索与 RAG）、08（安全与合规）**。

> 定位：依赖方向 **`integrations` → `core`**（仅用 `core` 的 `crypto` 解密凭据）。
> 本包**不依赖** `db` / `runtime`：驱动只消费结构性入参（行投影），不感知 Drizzle。

---

## 目录

- [设计原则](#设计原则)
- [目录结构](#目录结构)
- [模块一览](#模块一览)
  - [mailbox/ — 邮箱驱动](#mailbox--邮箱驱动)
  - [search/ — 搜索与抓取](#search--搜索与抓取)
  - [embedding/ — 嵌入服务](#embedding--嵌入服务)
  - [storage/ — 对象存储](#storage--对象存储)
- [进程级注入与装配](#进程级注入与装配)
- [使用示例](#使用示例)
- [测试](#测试)
- [开发](#开发)

---

## 设计原则

1. **接口收敛供应商差异**：每个能力对外暴露单一接口（`MailboxDriver` / `SearchProvider` /
   `EmbeddingProvider` / `ObjectStorage`），供应商细节（SDK、REST、签名）封在实现内。
2. **进程级注入 + 回落兜底**：`api` / `worker` 启动时装配一次，业务代码经 `get*` 读取；
   未装配时搜索 / 嵌入**回落确定性 mock**，保证离线与单测可跑（对齐 M4 mock 供应商策略）。
3. **凭据零明文落盘**：邮箱凭据一律 AES-256-GCM 信封加密（`credential_enc`），
   解密仅在发送 / 同步瞬间内存中进行，接口层永不回显明文（08 §2）。
4. **失败可分类**：认证失效（`MailboxAuthError`）与可重试发送失败（`MailboxSendError`）显式区分，
   供上层置 `status='disconnected'` 或退避重试。
5. **抓取合规内建**：`site_crawl` 遵守 robots.txt、单站限速、UA 自报、域名硬过滤与数据最小化（08 §7）。

---

## 目录结构

```
src/
├── index.ts                 # 包入口：统一重导出四类适配器（接口 / 工厂 / 注入 API）
├── mailbox/                 # 邮箱驱动（06 §2）
│   ├── types.ts             # MailboxDriver 接口 + 行投影 / 消息 / 选项类型
│   ├── factory.ts           # provider → MailboxDriver 工厂 + 测试注入
│   ├── gmail.ts             # Gmail API（收发同通道，OAuth2）
│   ├── outlook.ts           # Microsoft Graph REST（fetch 直连，OAuth2）
│   ├── smtp-imap.ts         # imapflow（收）+ nodemailer（发）
│   ├── credentials.ts       # 凭据解密 + OAuth 客户端 / token 刷新
│   ├── errors.ts            # MailboxAuthError / MailboxSendError
│   └── mime.ts              # RFC822 → RawMessage（mailparser，SMTP-IMAP/Gmail 共用）
├── search/
│   └── index.ts             # web_search / site_crawl 适配 + 合规基元（06 §3）
├── embedding/
│   └── index.ts             # 嵌入服务适配（07 §2 ④）
└── storage/
    └── index.ts             # S3 兼容对象存储（AWS SigV4，07 §2）
test/
└── search-compliance.spec.ts # 抓取合规基元单测（纯逻辑，无外部依赖）
```

---

## 模块一览

### mailbox/ — 邮箱驱动

邮箱收发的**统一出口**（06 §2）。`email_sync`（worker 收信）与 `email_send`（tools 发信）、
`mailbox.service`（连接测试）均经 `createMailboxDriver` 获取驱动。

#### MailboxDriver 接口（06 §2.1）

| 方法                    | 说明                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `testConnection()`      | 连接测试，IMAP / SMTP 分别校验并回显（16 §2.6，保存前必须通过）                           |
| `syncMessages(params)`  | 增量拉取，返回 `AsyncIterable<RawMessage>`（首次全量由 `since = now - historyDays` 表达） |
| `sendMessage(msg)`      | 外发，返回 `{ externalId }`（落 `message.external_message_id`）                           |
| `markSeen?(externalId)` | 可选：标记已读（按 `Message-ID` 定位）                                                    |

#### 工厂与测试注入

| 导出                                       | 说明                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `createMailboxDriver(row, options)`        | 按 `row.provider` 分派到 gmail / outlook / smtp_imap 驱动；未知 provider 编译期穷尽校验 |
| `setMailboxDriverFactory(factory)`         | 测试 / 扩展注入自定义工厂（传 `null` 还原默认）；集成测试以 mock 驱动保链路可测         |
| `MailboxDriverFactory`                     | 工厂类型 `(row, options) => MailboxDriver`                                              |
| `createSmtpImapDriver(row, encryptionKey)` | SMTP-IMAP 驱动直接构造（默认工厂亦经此）                                                |

#### provider 对照

| Provider    | 收                                              | 发                        | 增量机制（当前 / P1）                                                      | 超时                |
| ----------- | ----------------------------------------------- | ------------------------- | -------------------------------------------------------------------------- | ------------------- |
| `gmail`     | Gmail API `messages.list` + `messages.get(raw)` | Gmail API `messages.send` | 当前 `after:` 日期粒度回扫 + Message-ID 幂等去重；`historyId` 游标 P1      | API 30s             |
| `outlook`   | Graph `/me/mailFolders/{folder}/messages`       | Graph `/me/sendMail`      | 当前 `receivedDateTime ge since` + `internetMessageId` 幂等；delta 查询 P1 | 请求 30s            |
| `smtp_imap` | imapflow（轮询兜底，IDLE P1）                   | nodemailer SMTP           | `UID + since` 服务端过滤                                                   | 连接 10s / 命令 30s |

> 文件夹约定 `INBOX` / `Sent`：Gmail → label、Outlook → `inbox` / `sentitems`，映射在驱动内收敛。

#### 凭据与 OAuth（06 §2.4、08 §2）

| 导出                                                       | 说明                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `decryptChannelCredential(channel, key)`                   | 解密 IMAP/SMTP 凭据（`credential_enc`）；未配置返回 `null`                       |
| `decryptRefreshToken(oauth, key)`                          | 解密 OAuth refresh token；未配置返回 `null`                                      |
| `assertGoogleOAuthConfig(clients)`                         | 校验 Gmail OAuth 客户端凭据是否配置，缺失抛 `MailboxAuthError`                   |
| `getMicrosoftAccessToken(refreshToken, cacheKey, clients)` | Outlook refresh token grant 刷新 access token，进程内缓存（到期前 60s 失效重取） |

- Gmail：refresh token 存凭据，`googleapis` OAuth2 client 自动刷新 access token（**动态 import**，非 OAuth 链路不加载 SDK）。
- Outlook：REST token 端点直连，access token **不落盘**、进程内缓存。
- 刷新失败一律抛 `MailboxAuthError` → 上层置 `status='disconnected'` + 重连入口提示。
- 加密实现复用 `@tradepilot/core` 的 `decryptSecret`（AES-256-GCM，每行独立 IV）。

#### 错误分类（06 §1/§2.4）

| 导出                      | 说明                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `MailboxAuthError`        | 凭据失效 / OAuth 刷新失败 → 置 `mailbox.status='disconnected'` |
| `MailboxSendError`        | 发送失败（可重试）→ `email_send` 退避重试，最终 `failed`       |
| `isMailboxAuthError(err)` | 判定是否凭据类错误（含底层库常见认证文案兜底匹配）             |

> 其余网络 / 超时错误原样上抛，由消费者按「同步连续失败」口径熔断（06 §2.2）。

#### MIME 解析（共用件）

`parseRawSource(source, folder, fallbackDate)`：`mailparser` 解析 RFC822 源 →
`RawMessage`（text/plain 优先，text/html 剥标签兜底；无 `Message-ID` 返回 `null` 丢弃）。
Gmail 收信与 SMTP-IMAP 收信共用，保证解析口径一致。

#### 关键类型

| 导出                                                    | 说明                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `MailboxDriver`                                         | 驱动统一接口                                                                      |
| `MailboxDriverRow`                                      | 驱动所需的邮箱行投影（由调用方从 `db mailbox` 行映射，本包不依赖 `db`）           |
| `MailboxDriverOptions`                                  | 驱动选项：`encryptionKey` + Google/Microsoft OAuth 客户端凭据                     |
| `RawMessage`                                            | 收到的原始消息统一投影（`externalMessageId` / `folder` / 收发人 / 正文 / `date`） |
| `OutboundMessage`                                       | 外发载荷（`from` / `to` / `subject` / `text` / `inReplyTo?`）                     |
| `SyncParams` / `DriverTestResult` / `SendMessageResult` | 同步参数 / 连接测试结果 / 发送结果                                                |

### search/ — 搜索与抓取

`web_search` / `site_crawl` 供应商适配（06 §3，M4 #6）。

| 导出                                                                               | 说明                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SearchProvider`                                                                   | 接口：`webSearch(query, page?)` → `WebSearchHit[]`；`crawlSite(domain)` → `SiteCrawlResult` |
| `HttpSearchProvider`                                                               | Serper 兼容搜索 API + 轻量 HTML 抓取（非 Playwright 渲染，动态页列后续增强）                |
| `MockSearchProvider`                                                               | 确定性产出（跨轮换词 / 翻页可复算），保三图 dry-run 与单测可测                              |
| `createSearchProvider(options)`                                                    | 按 `provider: 'mock' \| 'http'` 构造                                                        |
| `setSearchProviderFactory(factory)` / `configureSearchProvider(provider)`          | 进程级注入（按 org 解析 / 静态注册）                                                        |
| `getSearchProvider(orgId?)`                                                        | 读取 provider；未注入回落 `MockSearchProvider`                                              |
| `HttpSearchOptions` / `WebSearchHit` / `SiteCrawlResult` / `SearchProviderFactory` | 类型                                                                                        |

**抓取合规内建**（08 §7，M4 C8）——以下基元在模块内实现，供 `HttpSearchProvider` 装配：

- **robots.txt 尊重**：`parseRobots` + `robotsAllows`（UA 命中最长前缀、平长 allow 优先；解析 / 获取失败视为允许）。
- **单站限速**：`PerHostRateLimiter`，同 host 两次请求间隔 ≥ `perHostIntervalMs`（默认 2000ms）。
- **UA 自报**：`CRAWLER_UA = TradePilotBot/1.0 (...)`，不伪装浏览器。
- **域名硬过滤**：`isExcludedDomain`，host 归一（去 `www.`）后精确 / 子域匹配。
- **数据最小化**：抓取仅提取 `<title>` / meta description 摘要与产品链接锚文本，不整页入库。
- 抓取页固定为 `/`、`/products`、`/about`；根域与 `www` 变体依次尝试。

> `HttpSearchProvider` 构造参数含 `fetchTimeoutMs` / `excludeDomains` / `perHostIntervalMs` /
> `respectRobots` / `robotsCacheTtlMs`；供应商 ToS 由契约承担，额度令牌桶在 `tools` 侧（06 §3.2）。

### embedding/ — 嵌入服务

知识索引与检索 query 的向量化适配（07 §2 ④ / 06 §4）。

| 导出                                                                    | 说明                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `EmbeddingProvider`                                                     | 接口：`dimensions` / `model` / `embed(texts)`（调用方保证 ≤100 条/批） |
| `OpenAiEmbeddingProvider`                                               | OpenAI 兼容 `/embeddings`（默认 `text-embedding-3-small`，1536 维）    |
| `MockEmbeddingProvider` / `mockEmbed`                                   | 文本 sha256 派生**确定性向量** + L2 归一（同文本恒同向量，跨进程一致） |
| `MOCK_EMBEDDING_DIMENSIONS` / `KNOWLEDGE_EMBEDDING_DIMENSIONS`          | 均为 `1536`（对齐 `knowledge_chunk.embedding vector(1536)`）           |
| `createEmbeddingProvider(options)`                                      | 按 `provider: 'mock' \| 'openai'` 构造                                 |
| `setEmbeddingProviderFactory(factory)` / `configureEmbedding(provider)` | 进程级注入（按 org 解析 / 静态注册）                                   |
| `getEmbeddingProvider(orgId?)`                                          | 读取 provider；未注入回落 `MockEmbeddingProvider`                      |

> **维度硬约束**：`knowledge_chunk.embedding` 为 `vector(1536)`，选用模型维度必须一致，
> 否则入库报维度不匹配；**换维度 = 换模型**，需全量重建索引（07 §5）。
> mock 确定性保证「API 侧 query 向量」与「worker 侧 chunk 向量」同源可复算。

### storage/ — 对象存储

知识原文的对象存储适配（07 §2 / 08 §7）。**S3 兼容（MinIO）最小客户端**：
仅 `PutObject` / `GetObject` / `PutBucket`，AWS **SigV4** 签名（`node:crypto`），
path-style 寻址（MinIO 约定），**不引入 aws-sdk**。

| 导出                                 | 说明                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `ObjectStorage`                      | 接口：`putObject(key, body, contentType)` / `getObject(key)` / `ensureBucket()`        |
| `createS3Storage(options)`           | 构造 S3 客户端（`endpoint` / `bucket` / `region` / `accessKeyId` / `secretAccessKey`） |
| `configureObjectStorage(storage)`    | 进程级注入（api / worker 启动时一次）                                                  |
| `getObjectStorage()`                 | 读取存储；**未注入抛错**（无 mock 回落，属基础设施强依赖）                             |
| `isObjectStorageConfigured()`        | 是否已装配                                                                             |
| `knowledgeDocKey(orgId, docId, ext)` | 知识原文对象 key：`kdoc/{orgId}/{docId}.{ext}`                                         |
| `S3StorageOptions`                   | 构造选项类型                                                                           |

> `putObject` / `getObject` 失败会抛出带 HTTP 状态与 MinIO 返回体摘要的错误
> （避免静默吞掉 `NoSuchBucket` 等，触发上层自举重试）。

---

## 进程级注入与装配

四类适配器均采用「**启动时注入一次，业务经 `get*` 读取**」模式（同 `email-send-config`）：

| 能力     | 注入 API                                               | 读取 API                       | 未注入时行为                   |
| -------- | ------------------------------------------------------ | ------------------------------ | ------------------------------ |
| 邮箱驱动 | `setMailboxDriverFactory`                              | `createMailboxDriver`          | 走默认工厂（按 provider 分派） |
| 搜索     | `setSearchProviderFactory` / `configureSearchProvider` | `getSearchProvider(orgId?)`    | 回落 `MockSearchProvider`      |
| 嵌入     | `setEmbeddingProviderFactory` / `configureEmbedding`   | `getEmbeddingProvider(orgId?)` | 回落 `MockEmbeddingProvider`   |
| 对象存储 | `configureObjectStorage`                               | `getObjectStorage()`           | **抛错**（未初始化）           |

**装配现状**（16 FR-10 后为「按 org 解析」）：

- `apps/api/src/main.ts`：注入 S3 对象存储 + **按 org 解析 embedding 模型**（读「系统设置 → AI 模型配置」，
  经 `@tradepilot/runtime` 的 `resolveActiveModel` / `toEmbeddingProviderConfig`，未配置回落内置兜底）。
- `apps/worker/src/index.ts`：注入 S3 + **按 org 解析 search / embedding**，
  并构造 `MailboxDriverOptions`（`ENCRYPTION_KEY` + Google/Microsoft OAuth 客户端）供队列消费。
- 邮箱驱动选项在 `api` 的 `mailbox.service` / `approvals.service` / `conversations.service`
  与 `worker` 的 `email-sync` / `notify` 队列各自装配（同一 env 口径）。

相关环境变量：`ENCRYPTION_KEY`、`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`、
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`、`S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`。

---

## 使用示例

```ts
import {
  createMailboxDriver,
  setMailboxDriverFactory,
  getSearchProvider,
  getEmbeddingProvider,
  getObjectStorage,
  knowledgeDocKey,
  isMailboxAuthError,
  type MailboxDriverOptions,
} from '@tradepilot/integrations';

// 1) 邮箱驱动：按行投影构造并收发（收信 / 发信唯一出口）
const driverOptions: MailboxDriverOptions = {
  encryptionKey: env.ENCRYPTION_KEY,
  oauth: {
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  },
};
const driver = createMailboxDriver(mailboxRow, driverOptions);
try {
  const result = await driver.testConnection();
} catch (err) {
  if (isMailboxAuthError(err)) {
    // 凭据失效 → 置 mailbox.status='disconnected'
  }
}
for await (const msg of driver.syncMessages({ since, folders: ['INBOX', 'Sent'] })) {
  // 幂等入库（external_message_id 唯一键）
}
await driver.sendMessage({ from: row.account, to: ['buyer@acme.com'], subject, text });

// 2) 搜索：web_search / site_crawl（worker 侧已按 org 注入；未注入回落 mock）
const search = await getSearchProvider(orgId);
const hits = await search.webSearch('steel fastener importer germany', 1);
const site = await search.crawlSite('acme-industries.com');

// 3) 嵌入：知识 chunk / 检索 query 向量化（维度 1536）
const embedding = await getEmbeddingProvider(orgId);
const vectors = await embedding.embed(['...chunk text...']);

// 4) 对象存储：知识原文存取
const key = knowledgeDocKey(orgId, docId, 'pdf');
await getObjectStorage().putObject(key, fileBuffer, 'application/pdf');

// 5) 单测：注入 mock 工厂保链路可测
setMailboxDriverFactory(() => mockDriver);
```

---

## 测试

`test/search-compliance.spec.ts` 为**纯逻辑单测**（无外部依赖），覆盖抓取合规基元：

```bash
pnpm --filter @tradepilot/integrations test
```

覆盖点：robots.txt 放行判定（UA 组 / `*` 回落 / 最长前缀 / allow 平长优先 / 空 Disallow / 无文件）、
`excludeDomains` 硬过滤（host 归一 + 子域匹配 + 防误杀）、`PerHostRateLimiter`
（同 host 间隔 / 跨 host 不互斥 / `<=0` 放行）、`HttpSearchProvider` 装配剔除命中项。

> 邮箱 / 嵌入 / 存储的真实链路为**集成测试**，位于消费方：
> `apps/worker/test/m4-mailbox.integration.spec.ts`（mock 驱动注入 + 凭据加密往返 +
> 发信唯一出口）、`apps/worker/test/m4-knowledge-index.integration.spec.ts`、
> `apps/api/test/m5-d3-ai-model-catalog.integration.spec.ts`（按 org 解析 provider）等。

---

## 开发

```bash
pnpm --filter @tradepilot/integrations build      # tsc 构建到 dist/
pnpm --filter @tradepilot/integrations typecheck  # 类型检查
pnpm --filter @tradepilot/integrations test       # vitest 单测
pnpm --filter @tradepilot/integrations lint       # eslint
```

**新增能力时**：

1. 对外暴露**接口 + 工厂 + 注入 API**三件套，供应商细节封装在实现内；
2. 对外统一经 `src/index.ts` 重导出；
3. 涉及外部调用的能力须可注入 mock（保离线 / 单测 / dry-run 可跑）；
4. 凭据一律经 `credential_enc` 信封加密，接口层不回显明文；
5. 抓取类能力须内建 robots.txt / 限速 / UA / 域名过滤等合规基元（08 §7）。
