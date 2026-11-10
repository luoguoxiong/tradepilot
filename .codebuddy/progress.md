# TradePilot AI 开发进度

> 本文件是开发进度的唯一事实来源，由 tradepilot-plan-executor 技能维护。

## 当前状态

- 当前阶段：阶段 6/9（AI 客户分析 + 开发信生成）
- 状态：pending（待用户确认后开始）
- 最后更新：2026-11-10

## 阶段清单

| # | 阶段 | 状态 | 完成日期 | 验收证据 | 提交 |
|---|---|---|---|---|---|
| 1 | PRD + 核心业务流程 | done | 2026-11-10 | 用户确认 PRD（含 3 项决策）；PRD 覆盖六大模块+Agent 设计+12 条验收场景 | a1efb3d |
| 2 | 系统架构 + 模块划分 | done | 2026-11-10 | 用户确认（"继续阶段3"）；对抗性审查 13 项修正全部回填 | fe4c7aa |
| 3 | PostgreSQL Schema | done | 2026-11-10 | 迁移 init 成功（13 表落库）；seed 唯一约束验证 2/2 通过（P2002 拒绝重复 dedupeKey 与重复 contact）；tsc 零错误 | 见下 |
| 4 | 前后端工程 + Docker | done | 2026-11-10 | /api/health 200（db/redis up）；前端 200+IDE 预览导航正常；/api 代理通；前后端 tsc 零错误；web build 成功 | 见下 |
| 5 | 核心 API + 前端页面 | done | 2026-11-10 | 未登录 401 ✓；登录→建任务→异步搜索→7 家 DEMO 企业列表 ✓；集成测试 13/13（4 套件）；双端 tsc 零错误 | 见下 |
| 6 | AI 分析 + 开发信生成 | pending | - | - | - |
| 7 | CRM 业务闭环 | pending | - | - | - |
| 8 | 测试验证 | pending | - | - | - |
| 9 | README + 部署 + 验收 | pending | - | - | - |

## 各阶段记录

### 阶段 1：PRD + 核心业务流程

- 交付物：docs/PRD.md（v1.0）、docs/tasks.md（T01–T25 + 检查点）
- 决策与备注：
  - 核心闭环唯一化：输入产品→搜索企业→联系人→匹配分析→开发信→CRM，其余全部 P1/P2
  - 12 条最终验收场景逐条编号写入 PRD 第 4 节，作为阶段 8/9 验收依据
  - 发现仓库遗留旧版实现的未暂存删除记录（feature-new-v2 分支），按 plan.md"从 0 到 1"意图按全新开发处理，不迁移旧代码；提交只新增文件、不动删除记录，处置方式待用户决策（PRD 开放问题 1）
- 待办：无（已确认）
- 遗留问题：无

用户决策（2026-11-10）：
- 旧代码删除记录已正式提交清空（f108f2c，552 文件）；plan.md 与 .codebuddy/skills/ 已纳入版本管理（b440ded）
- LLM 提供商指定 DeepSeek
- 后端框架选型 NestJS

### 阶段 2：系统架构 + 模块划分

- 交付物：docs/architecture.md（v1.1）
- 决策与备注：
  - ADR-001 NestJS（用户确认）；ADR-002 Prisma（schema-first + 内置迁移）
  - 对抗性新鲜上下文审查发现 13 项问题，全部归类为 valid+actionable 并回填（v1.0→v1.1）：任务前缀统一、enriching 子步粒度重试、enrichment_tasks 企业级失败落库、BullMQ 对账兜底、Google 字段可得性分工、海关频率改服务层聚合、评分/邮件草稿端点补齐、三方 API 日配额、前端 2s 轮询、audit_logs 审计表、Key AES-256-GCM 加密+脱敏、前端补 Company Detail、DataSource 扩 enrichment:*
  - PRD §6.3 Key 管理表述同步修正
- 待办：无（用户已确认，进入阶段 3）
- 遗留问题：无

### 阶段 3：PostgreSQL Schema

- 交付物：server/prisma/schema.prisma（13 模型）、docker-compose.yml（postgres:16 + redis:7）、server/prisma/seed.ts、server/.env.example、根 .gitignore
- 决策与备注：
  - plan.md 11 张表 + task_step_logs + audit_logs = 13 张；CRM 客户 = crmStatus 非空的 Company（免冗余 customers 表，/api/crm/customers 映射筛选）
  - 端口避让：postgres 5435、redis 6393（本机 5432-5434、6390-6392 已被其他项目占用）
  - Docker daemon 未运行，已 open -a Docker 启动；旧版遗留容器仅清理了冲突的 tradepilot-redis（tradepilot-pg/minio/mailpit 仍在，未动其数据卷）
  - Prisma 6.19.3（8.x 尚为 rc，不跟进）
- 验收证据：
  - `npx prisma migrate dev --name init` 成功，migrations/20261110021743_init，\dt 确认 13 表
  - `npm run seed`：演示数据插入成功；dedupeKey 与 (companyId,email) 重复插入均被 P2002 拒绝
  - `tsc --noEmit` 零错误
- 遗留问题：无（阶段 4 将扩展 server/ 为 NestJS 工程，本阶段 package.json 为最小骨架）

### 阶段 4：前后端工程 + Docker 开发环境

- 交付物：
  - server/：NestJS 骨架（zod 配置校验 fail-fast、pino+pino-http 结构化日志、全局 AllExceptionsFilter 统一错误结构、PrismaService 全局模块、/api/health 含 DB+Redis 连通）
  - web/：Vite5 + React 18 + TS + Tailwind3 + shadcn 风格组件（button/badge/card，badge 含 DEMO 变体）+ Zustand + react-router 7 页面路由 + 侧边栏布局（可折叠）
  - AGENTS.md 规则文件、.github/workflows/ci.yml（前后端 typecheck + web build）
  - server/.env.example 全量分组
- 决策与备注：
  - tsx/esbuild 不支持 emitDecoratorMetadata → 后端注入约定显式 @Inject(Token)（已记入 AGENTS.md）
  - vite server 显式绑定 127.0.0.1（本机 localhost 解析 ::1 的坑）；/api 代理目标 127.0.0.1:3020
  - API 端口 3020（避开本机 3000/3005/3010/3015）
  - ioredis lazyConnect 时 ping 前需显式 connect()（health 检查修复）
- 验收证据：/api/health 200 {status:ok,db:up,redis:up}；404 返回统一错误结构；web 200 且模块编译 200、代理 200；IDE 预览打开 /dashboard 正常；server/web tsc exit=0；web build 成功（gzip 66KB）
- 遗留问题：无（认证 Guard 将在阶段 5 全局接入）

### 阶段 5：核心 API + 前端页面（P0 主体）

- 交付物（5 个切片提交 46e5f86→3fabf3e→…）：
  - 认证：register/login/me（JWT + bcrypt 12 轮 + @nestjs/jwt）、全局 JwtAuthGuard + @Public、登录限流（内存版单实例，AUTH_RATE_LIMIT_MAX 可调）、zod 边界校验
  - 产品 CRUD：products 模块（归属校验防 IDOR）
  - Adapter 层：types 契约、Mock（确定性 DEMO）/Google Real（zod 校验响应+超时+错误分类）、AdapterFactory（integrations→env→Mock 降级）、QuotaService 日配额（Redis）
  - integrations：AES-256-GCM 加密存取 + 掩码响应（只回尾 4 位）
  - tasks：BullMQ lead-discovery 队列 + Processor（searching 步：步骤日志/幂等 upsert/失败置 FAILED/重试耗尽 onFailed 兜底）、retry 端点（阶段 5 仅 searching）
  - companies：分页筛选（q 匹配名称或域名/country/favorite/inCrm）、详情聚合、收藏、批量导入 CRM（置 NEW+负责人+audit_logs）
  - 前端：登录/注册页（真实调用+错误态）、api 客户端（Bearer/401 登出）、RequireAuth、Lead Discovery（表单+2s 轮询+最近任务+DEMO 提示卡）、Companies 列表（筛选/分页/收藏/批量导入/DEMO 徽章）、Company Detail（信息/联系人/海关记录/AI 占位）、Settings（产品 CRUD+集成 Key 管理）
  - 集成测试：jest+ts-jest+supertest，create-app 工厂共享，13 用例（401/注册重复/422/错误密码/伪造 token/CRUD/IDOR/任务异步/边界/归属/收藏/CRM 导入幂等/Key 加密掩码）
- 决策与备注：
  - JWT Bearer 存 localStorage：PRD 已确认非 cookie 方案，MVP 单实例+同源代理接受该风险（store 注释留档），生产化换 httpOnly cookie
  - Worker 进程内运行（@nestjs/bullmq 同进程），架构 v1.1 的独立 worker 进程推迟到部署阶段；@Processor 装饰器漏写曾致 worker 不启动（已修复并成为检查点）
  - 测试 --runInBand 串行：多 jest 进程各自启停 BullMQ worker 会造成 stalled 重投递波动
  - Mock 确定性数据跨运行复用同 dedupeKey → 测试用 updateMany 重置 CRM 状态保证幂等
  - 架构偏差：dev 期 tasks 创建时 jobId=taskId；retry 改用 `${taskId}:retry:${ts}` 避免 jobId 冲突
- 验收证据：
  - 未登录 /api/products 401 UNAUTHENTICATED ✓（验收门）
  - 端到端 curl：登录→POST /search-tasks→5 家 DEMO 企业入库→/api/companies 分页可见 ✓
  - npm test：13/13 通过（4 套件）✓（验收门"新增接口集成测试"）
  - server/web tsc exit=0；IDE 预览 /companies 正常渲染 ✓
- 遗留问题：无
