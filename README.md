# TradePilot AI — AI 外贸客户开发平台

输入我方产品与目标市场 → 自动搜索海外潜在客户 → 挖掘采购联系人 → 海关数据验证采购需求 → AI 匹配度评分 → 生成英文开发信草稿 → 全程沉淀到 CRM。

> **MVP 边界**：开发信只生成草稿、不自动发送（P2 再做自动发送）；所有无 Key 降级的演示数据显著标注 **DEMO**，绝不伪装成真实数据。

## 功能总览

| 模块 | 说明 |
|---|---|
| Lead Discovery | 表单发起搜索任务，BullMQ 异步四步流水线：searching → enriching(逐企业子步) → scoring → emailing，2s 轮询实时进度 |
| Companies | 企业列表（分页/搜索/国家筛选/收藏）、详情聚合（资料/联系人/海关记录/AI 分析/开发信/CRM 面板） |
| AI 工作台 | 五维评分（产品30/业务25/采购25/联系人10/地区10）+ 六项解释性输出；英文开发信四件套草稿（Subject/Body/Follow-up 1/2） |
| CRM | 状态机白名单流转（NEW→QUALIFIED→CONTACTED→REPLIED→NEGOTIATING→WON/LOST）、跟进时间线、汇总看板、CSV 导入导出 |
| Settings | 我方产品资料 CRUD；Serper/Apollo/海关 API Key 管理（AES-256-GCM 加密落库、仅回显尾 4 位） |
| 降级策略 | 任一第三方无 Key 自动降级确定性 Mock（标注 DEMO），零配置即可完整演示 |

## 技术栈

- **后端** `server/`：NestJS 11 + Prisma 6 + PostgreSQL 16 + Redis 7 + BullMQ 5 + zod + pino
- **前端** `web/`：React 18 + TypeScript + Vite 5 + Tailwind 3 + shadcn 风格组件 + Zustand + React Router 6
- **AI**：OpenAI 兼容协议 → DeepSeek（`deepseek-flash` 默认）；无 Key 时确定性规则降级（`mock-rules-v1`/`mock-template-v1`）
- **Node 版本**：要求 **v22.19.0**（nvm 管理；默认 node 18 不兼容）

## 快速开始

```bash
# 0. Node 22
source ~/.nvm/nvm.sh && nvm install 22.19.0 && nvm use 22.19.0

# 1. 基础设施（PostgreSQL 127.0.0.1:5435 + Redis 127.0.0.1:6393）
docker compose up -d

# 2. 后端
cd server
cp .env.example .env            # 开发可留空全部第三方 Key（自动 Mock 降级）
npm install
npx prisma migrate dev          # 建表（13 张）
npm run seed                    # 演示数据：demo@tradepilot.dev / demo123456 + 种子企业
npm run dev                     # API http://127.0.0.1:3020/api/health

# 3. 前端（新终端）
cd web
npm install
npm run dev                     # Web http://127.0.0.1:5173
```

打开 http://127.0.0.1:5173 ，用演示账号 `demo@tradepilot.dev / demo123456` 登录，到 Settings 建产品后即可发起搜索任务。

### 测试与类型检查

```bash
cd server && npm test           # 69 用例 / 7 套件（测试强制走确定性 Mock，不烧真实配额）
cd server && npm run typecheck  # server tsc
cd web && npm run typecheck     # web tsc
```

## 架构

```
浏览器
  │  http://127.0.0.1:5173
  ▼
React SPA (web/)  ──/api 代理──▶  NestJS API (server/, :3020)
                                   │
                     ┌─────────────┼───────────────┐
                     ▼             ▼               ▼
              PostgreSQL 16   Redis 7 (BullMQ)  Adapter 层（src/adapters/）
              (Prisma, 13表)  lead-discovery    │ serper     企业搜索
                     │         任务队列+Worker  │ apollo     联系人挖掘
                     │                        │ customs    海关数据(importyeti/generic)
                     └────────────────────────┤ ai/(DeepSeek LLM)
                                              │
                              无 Key / 失败 → 确定性 Mock 降级（DEMO 标注）
```

- **分层约束**：第三方 API 调用只允许出现在 `server/src/adapters/` 与 `server/src/ai/`，业务模块零直接调用（`docs/architecture.md` §4）。
- **评分一致性**：LLM 只产出五维子分与解释文本，总分/等级由代码按 PRD 权重计算（`computeWeightedScore` + `gradeOf`），保证可复现。
- **任务流水线**：四步全落库（task/step 日志），单企业 enrich 失败容忍，支持四步级 retry；AI 评分超 `TASK_SCORE_LIMIT` 标记 skipped。
- **CRM 状态机**：非法流转返回 400 `INVALID_TRANSITION`，每次流转写审计与时间线。

## 环境变量（`server/.env`，全部可选 Key 留空即 Mock 降级）

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://tradepilot:tradepilot@127.0.0.1:5435/tradepilot` |
| `REDIS_URL` | Redis 连接串（BullMQ + 日配额计数） | `redis://127.0.0.1:6393` |
| `PORT` | API 端口 | `3020` |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | JWT 签名与有效期 | 必填 / `7d` |
| `APP_ENCRYPTION_KEY` | integrations Key 的 AES-256-GCM 密钥（`openssl rand -hex 32`） | 必填 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容 LLM（DeepSeek 官方文档模型 ID） | 无 Key → 规则降级 |
| `SERPER_API_KEY` | Serper.dev 企业搜索 | 无 Key → Mock |
| `APOLLO_API_KEY` | Apollo 联系人挖掘 | 无 Key → Mock |
| `CUSTOMS_API_KEY` / `CUSTOMS_API_URL` / `CUSTOMS_API_PROVIDER` | 海关数据：`importyeti`（仅 Key）或 `generic`（Key+URL） | 无 Key → Mock |
| `ADAPTER_DAILY_QUOTA_*` | Serper/Apollo/Customs 日配额（Redis 计数） | 各 `100` |
| `TASK_SCORE_LIMIT` | 每任务 AI 评分企业数上限 | `10` |

## API 概览（前缀 `/api`，除 auth 外均需 `Authorization: Bearer <token>`）

| 模块 | 端点 |
|---|---|
| health | `GET /health`（DB+Redis 连通） |
| auth | `POST /auth/register` · `POST /auth/login` · `GET /auth/me` |
| products | `GET/POST /products` · `GET/PATCH/DELETE /products/:id` |
| search-tasks | `POST /search-tasks` · `GET /search-tasks` · `GET /search-tasks/:id` · `POST /search-tasks/:id/retry` |
| companies | `GET /companies`（分页/筛选） · `GET /companies/:id`（详情聚合） · `PATCH /companies/:id/favorite` · `POST /companies/import-crm` |
| contacts | `GET/POST /companies/:id/contacts` · `POST /companies/:id/contacts/discover` |
| customs | `POST /companies/:id/customs-records/query` · `GET /companies/:id/customs-records` |
| ai | `POST/GET /companies/:id/lead-scores` · `POST/GET /companies/:id/email-drafts` · `PATCH /companies/email-drafts/:draftId` |
| crm | `GET /crm/summary` · `GET /crm/customers` · `GET /crm/customers/:id` · `POST /crm/customers/:id/transition` · `POST /crm/customers/:id/activities` · `GET /crm/export` · `POST /crm/import` |
| integrations | `GET /integrations` · `PATCH /integrations/:provider` · `DELETE /integrations/:provider` |

错误结构统一为 `{ "error": { "code", "message", "details?" } }`。

## 目录结构

```
tradepilot/
├── docker-compose.yml          # postgres(5435) + redis(6393)
├── docs/
│   ├── PRD.md                  # 需求基线 + 12 条验收场景
│   ├── architecture.md         # 技术基线 + ADR
│   ├── tasks.md                # 任务清单
│   ├── deployment.md           # 部署手册
│   ├── acceptance.md           # 12 条场景验收留档
│   └── screenshots/            # 全链路浏览器截图（阶段 8）
├── server/
│   ├── prisma/                 # schema（13 表）+ migrations + seed
│   ├── src/
│   │   ├── adapters/           # serper/apollo/customs/importyeti + Mock + 工厂 + 配额
│   │   ├── ai/                 # DeepSeek 客户端/评分/开发信/prompt 模板
│   │   ├── auth/ crm/ companies/ contacts/ customs/ products/ tasks/ integrations/ health/
│   │   ├── processor/          # BullMQ 四步流水线 Worker
│   │   └── config.ts logger.ts filters/
│   └── test/                   # 7 套件 69 用例（jest + supertest）
└── web/
    └── src/
        ├── pages/              # Dashboard/LeadDiscovery/Companies/CompanyDetail/Crm/Settings…
        ├── components/         # ui/ + company/（评分卡/草稿卡/CRM 面板）
        └── stores/ types/
```

## 文档

- 需求与验收场景：`docs/PRD.md`
- 架构与 ADR：`docs/architecture.md`
- 部署手册：`docs/deployment.md`
- 12 条验收场景留档：`docs/acceptance.md`
