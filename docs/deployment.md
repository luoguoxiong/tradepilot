# TradePilot AI 部署手册

覆盖本地开发部署与生产部署建议。MVP 的演示主路径是「零第三方 Key + Mock 降级」，生产化只需按需补 Key。

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | **22.19.0**（nvm 管理） | 默认 node 18 不兼容（tsx/esbuild、undici 等） |
| Docker + Compose | 稳定版 | 仅用于 PostgreSQL 16 与 Redis 7 |
| PostgreSQL | 16 | 容器映射 `127.0.0.1:5435` |
| Redis | 7 | 容器映射 `127.0.0.1:6393`（BullMQ + 日配额） |

> 端口避让说明：本机 5432–5434、6390–6392 被其他项目占用，故映射 5435/6393；如无冲突可在 `docker-compose.yml` 自行改回标准端口（同步 `server/.env`）。

## 2. 本地开发部署（从零到可演示）

```bash
# ① Node 22
source ~/.nvm/nvm.sh && nvm use 22.19.0

# ② 基础设施
docker compose up -d
docker compose ps        # 两个容器均 healthy

# ③ 后端
cd server
cp .env.example .env
# 必填两项：
#   JWT_SECRET=$(openssl rand -hex 32)
#   APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
npm install
npx prisma migrate dev   # 建表（13 张）
npm run seed             # 演示账号 demo@tradepilot.dev / demo123456 + 种子企业
npm run dev              # http://127.0.0.1:3020/api/health

# ④ 前端（新终端）
cd web && npm install && npm run dev   # http://127.0.0.1:5173
```

健康检查：`curl http://127.0.0.1:3020/api/health` 返回 `{ "status": "ok", "db": "up", "redis": "up" }`。

## 3. 生产部署

### 3.1 构建

```bash
# 后端：Prisma client + 编译（生产用 node 跑 dist 或保持 tsx）
cd server && npm ci && npx prisma generate && npm run build

# 前端：静态产物（部署到任意静态托管/CDN）
cd web && npm ci && npm run build    # 产物 dist/
```

### 3.2 数据库迁移（生产用 deploy，不用 dev）

```bash
cd server && npx prisma migrate deploy
```

### 3.3 环境变量（生产）

在部署环境（容器编排/Secrets 管理器）注入，**绝不写入镜像或 git**：

| 类别 | 必填 | 说明 |
|---|---|---|
| 安全 | `JWT_SECRET`、`APP_ENCRYPTION_KEY` | 各自 `openssl rand -hex 32`；`APP_ENCRYPTION_KEY` 一旦启用不可更换（已加密数据不可解） |
| 数据库 | `DATABASE_URL` | 指向托管 PG；建议连接池 + TLS |
| 缓存/队列 | `REDIS_URL` | BullMQ 与配额计数共用 |
| LLM | `LLM_API_KEY`（可选） | 缺失时 AI 功能走确定性规则降级并标注 `mock-*` |
| 第三方 | `SERPER_API_KEY` / `APOLLO_API_KEY` / `CUSTOMS_API_*`（可选） | 也可由用户在 Settings 页按用户级写入（AES-256-GCM 加密落库） |
| 配额 | `ADAPTER_DAILY_QUOTA_*`、`TASK_SCORE_LIMIT` | 成本护栏，按供应商套餐调整 |

### 3.4 进程与端口

- API：`node dist/main.js`（或 `tsx src/main.ts`），监听 `PORT`（默认 3020）。
- Worker：MVP 与 API 同进程（`@nestjs/bullmq` 注册在应用内）。多副本部署时需将 Processor 拆为独立进程（架构文档 §2 已预留），避免任务重复消费。
- 静态前端：Nginx/CDN 托管 `web/dist`，反代 `/api` → API 服务（同源部署，避免 CORS 配置）。
- 健康检查：`GET /api/health` 作为存活与就绪探针。

### 3.5 生产化检查清单（发布前）

- [ ] 所有测试通过：`cd server && npm test`（69 用例；测试强制 Mock，不消耗真实配额）
- [ ] 双端类型检查：`npm run typecheck`（server/web）
- [ ] `web` 生产构建成功
- [ ] 环境变量经 Secrets 注入，`.env` 不入库（`.gitignore` 已覆盖）
- [ ] `JWT_SECRET` 与 `APP_ENCRYPTION_KEY` 为强随机且与旧环境一致（更换后者会导致已存 Key 不可解密）
- [ ] 登录限流已开启（`AUTH_RATE_LIMIT_MAX`，内存版单实例；多实例需迁移 Redis 计数）
- [ ] JWT 为 Bearer + localStorage（MVP 决策）；如需提高安全等级改 httpOnly cookie（见 architecture.md ADR）
- [ ] 数据库每日备份（PG `pg_dump` 或托管快照）
- [ ] 日志为 pino 结构化 JSON，接入日志采集

### 3.6 回滚

1. 应用回滚：`git revert <commit>` 重新构建部署（无状态服务，秒级）。
2. 数据库回滚：Prisma 迁移不可自动降级——回滚前评估；MVP 阶段以「备份恢复」兜底。
3. 第三方故障：无需回滚——Adapter 层按 Key 存在性自动降级 Mock（数据标注 DEMO），LLM 故障返回结构化 503（`LLM_UNAVAILABLE` / `LLM_OUTPUT_INVALID`）。

### 3.7 已知运维要点（来自开发实测）

- **tsx/esbuild 不支持 `emitDecoratorMetadata`**：NestJS 注入必须显式 `@Inject(Token)`；DI 变更后先 `tsc --noEmit` 再起服务（模块缺导入曾导致进程 exit 1 零输出）。
- dev server 显式绑定 `127.0.0.1`（本机 localhost 解析到 ::1 导致 curl 不通）。
- BullMQ 测试运行须 `--runInBand`（多 jest 进程各自启停 worker 会造成 stalled 重投递波动）。
