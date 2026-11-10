# TradePilot AI 开发进度

> 本文件是开发进度的唯一事实来源，由 tradepilot-plan-executor 技能维护。

## 当前状态

- 当前阶段：全部 9 阶段完成（2026-11-10 用户指令"把整个计划做完"，阶段 8/9 连续交付）
- 状态：done
- 最后更新：2026-11-10

## 阶段清单

| # | 阶段 | 状态 | 完成日期 | 验收证据 | 提交 |
|---|---|---|---|---|---|
| 1 | PRD + 核心业务流程 | done | 2026-11-10 | 用户确认 PRD（含 3 项决策）；PRD 覆盖六大模块+Agent 设计+12 条验收场景 | a1efb3d |
| 2 | 系统架构 + 模块划分 | done | 2026-11-10 | 用户确认（"继续阶段3"）；对抗性审查 13 项修正全部回填 | fe4c7aa |
| 3 | PostgreSQL Schema | done | 2026-11-10 | 迁移 init 成功（13 表落库）；seed 唯一约束验证 2/2 通过（P2002 拒绝重复 dedupeKey 与重复 contact）；tsc 零错误 | 见下 |
| 4 | 前后端工程 + Docker | done | 2026-11-10 | /api/health 200（db/redis up）；前端 200+IDE 预览导航正常；/api 代理通；前后端 tsc 零错误；web build 成功 | 见下 |
| 5 | 核心 API + 前端页面 | done | 2026-11-10 | 未登录 401 ✓；登录→建任务→异步搜索→7 家 DEMO 企业列表 ✓；集成测试 13/13（4 套件）；双端 tsc 零错误 | 见下 |
| 6 | AI 分析 + 开发信生成 | done | 2026-11-10 | 两次评分波动 0 等级一致；六项输出齐全；无记录企业邮件无伪造采购；异常注入 503 结构化；22/22 测试通过 | 见下 |
| 7 | CRM 业务闭环 | done | 2026-11-10 | 非法流转 400 ✓；跟进+汇总变化 ✓；CSV 往返无损 ✓；挖掘/海关 DEMO ✓；全闭环任务(4 步 DONE+自动入 CRM)；31/31 测试 | 见下 |
| 8 | 测试验证 | done | 2026-11-10 | 纯函数单测 38 用例（评分/去重/CSV/Adapter 映射）；npm test 69/69（7 套件）；双端 tsc 零错误；浏览器全链路 9 张截图留档 docs/screenshots/；console 0 error | 见下 |
| 9 | README + 部署 + 验收 | done | 2026-11-10 | README/deployment/acceptance 三文档；12/12 验收场景逐条留档；新目录 clone 按 README 从零启动实测成功（migrate+seed+health+登录+console 0 error） | 见下 |

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
- 修复记录（74a3071）：预览发现 GET /api/products 返回数组而前端按 {data} 解析，致 Settings/LeadDiscovery 崩溃——前端两处改为直接消费数组；新增路由级 RouteErrorBoundary 防白屏
- 遗留问题：无

### 阶段 6：AI 客户匹配分析 + 英文开发信生成

- 交付物：
  - DeepSeekLlmClient（OpenAI 兼容）：response_format json_object + 显式 JSON 指令、低温（评分 0.2/邮件 0.6）、显式 max_tokens（1500/2000）、60s 超时、网络/5xx/429 重试一次、输出校验失败纠错重试一次、finish_reason=length 与空内容按无效处理、usage Token 记录
  - LeadScoringService：zod 五维子分 + 六项解释输出；**总分/等级由代码按 PRD 权重（30/25/25/10/10）计算**保证一致性；无 LLM Key 降级 ruleBasedScoring（确定性，model=mock-rules-v1）
  - EmailGenerationService：四件套生成；无 Key 降级模板生成（mock-template-v1）；无采购记录时提示词+模板双重禁止提采购；草稿落库可编辑
  - Prompt 模板集中 server/src/ai/prompts/；端点：POST/GET /companies/:id/lead-scores、POST/GET /companies/:id/email-drafts、PATCH /companies/email-drafts/:draftId
  - 前端：LeadScoreCard（子分条+六项输出+重跑+mock 标注）、EmailDraftsCard（联系人选择/生成/编辑/复制/保存/历史草稿）、Company Detail 接入
  - 测试：ai.spec 9 用例（稳定性/权重一致/历史/数据缺失注明/subject 含企业名/无伪造采购/PATCH 编辑/非法 JSON 注入→503 结构化/截断处理）
- 决策与备注：
  - **source-driven 修正**：核对 DeepSeek 官方文档（2026-11）发现模型 ID 已是 deepseek-flash/deepseek-v4-pro（非 deepseek-chat），config 默认改为 deepseek-flash（出处注释在 config.ts 与 .env.example）；非 JSON 输出会被替换为空格（空内容处理依据）
  - 无 LLM Key 的演示路径：确定性规则评分+模板邮件（确定性 → 稳定性验收门波动=0）；model 字段标注 mock-*，前端明示"规则降级结果（未配置 LLM Key）"
  - jest 29 node 环境无 Response 构造器 → fetch mock 用对象 stub
- 验收证据：
  - 两次评分：73/B vs 73/B，波动 0、等级一致 ✓（验收门）
  - 开发信 subject 含 "Summit Sports Gear LLC" 与产品名 ✓；无记录企业 all-text 不匹配 /shipment|import record|purchasing history|hs ?code/i ✓
  - 异常注入：非法 JSON → LlmOutputError → ServiceUnavailableException(code=LLM_OUTPUT_INVALID) → 过滤器 503 结构化（不 500）✓
  - npm test 22/22（5 套件）✓；双端 tsc 零错误 ✓；预览正常 ✓
- 遗留问题：真实 DeepSeek 调用未实测（本机无 DEEPSEEK_API_KEY），客户端逻辑以契约测试覆盖；配置 Key 后走同一 LlmClient 接口

### 阶段 7：CRM 完整业务闭环

- 交付物：
  - 联系人挖掘：Apollo Real（响应 zod 校验、不编造邮箱）+ Mock（确定性 1-3 人、验证状态混合、DEMO 标注）；挖掘去重（邮箱/名称+职位）；手动补充（isManual/source=manual）
  - 海关数据：通用 Customs API Real + Mock（0-3 条确定性、DEMO 标注）；幂等落库；企业级聚合（recordCount/first/last/frequency/supplierCountries）
  - CRM：状态机白名单（NEW→QUALIFIED→CONTACTED→REPLIED→NEGOTIATING→WON/LOST；LOST 可从 QUALIFIED+ 退出；WON 仅自 NEGOTIATING；终态拒绝）、非法跳转 400 INVALID_TRANSITION、每次流转写审计+STATUS_CHANGE 记录；跟进记录+nextFollowUpAt 同步 company；/api/crm/summary 汇总
  - 任务编排升级为完整闭环：searching→enriching(逐企业逐子步,单企业失败容忍)→scoring(TASK_SCORE_LIMIT,超出 SKIPPED)→emailing(A/B/C 生成草稿+自动入 CRM NEW)；retry 支持四步（子步归并父步）
  - CSV：RFC4180 序列化/解析（BOM/引号转义）；companies 按 dedupeKey upsert（CRM 状态不覆盖）、contacts 按 (companyId,email) upsert；审计落库
  - 前端：CRM 列表页（状态 Tab/搜索/分页/CSV 导入导出）、CrmStatusPanel（流转按钮+跟进表单+时间线，详情页集成）、Dashboard（真实汇总+待跟进卡片+最近任务）
  - 测试：crm.spec 9 用例（状态机合法/非法/终态、跟进同步、挖掘 DEMO、海关聚合、CSV 双向往返、整合视图、非 CRM 404）
- 决策与备注：
  - **用户并行改动（Serper 迁移）**：开发期间用户在 IDE 将企业搜索从 Google Custom Search 切换为 Serper.dev（新 serper-search.adapter、integrations providers=['serper','apollo','customs']、config SERPER_API_KEY、Data source 'serper'）——已兼容对齐（.env.example、集成测试改 serper provider），未覆盖用户改动
  - **踩坑**：TasksModule 未导入新增的 Contacts/Customs/Ai 模块 → NestFactory.create 期间 DI 报错被静默吞掉（进程 exit 1 零输出）——用 Nest logger 开启 + 分步诊断脚本定位；教训记入排查流程（DI 变更后先 tsc 再起服务）
  - Mock 确定性数据跨运行污染 → 测试 beforeAll 重置种子企业规范名/CRM 状态
- 验收证据：
  - 场景 1-7、11、12 可现场演示：登录✓ 产品✓ 搜索✓ 企业资料✓ 联系人(3 家 DEMO)✓ 海关+采购判断(quarterly)✓ 评分(73/B)✓ 邮件(含企业名)✓ CRM 保存(自动 NEW)✓ 跟进+时间(汇总 due=1)✓
  - 全闭环 E2E：任务 4 步全 DONE、CRM 4→6（自动导入 2 家）、草稿/评分/联系人落库 ✓
  - 非法流转 QUALIFIED→WON → 400 INVALID_TRANSITION ✓
  - CSV 导出→改名称→导入→再导出，字段无损、CRM 状态不覆盖 ✓
  - npm test 31/31（6 套件）✓；双端 tsc 零错误 ✓
- 遗留问题：无

### 阶段 8：测试验证

- 交付物：
  - server/test/unit.spec.ts：38 用例关键纯函数单测——computeWeightedScore（权重 30/25/25/10/10 各维单独系数验证+四舍五入）、gradeOf（80/79/60/59/40/39 边界）、ruleBasedScoring（同输入同输出确定性、六项结构、关键词命中提升、无海关记录=25+注记、DEMO 注记、无联系人=30+建议）、domainFromWebsite（协议/www/大小写/裸域名/非法/localhost）、buildDedupeKey（域名优先、fp- 指纹回退、名称规范化稳定、确定性）、hashInt（范围/确定性）、CSV RFC4180（csvEscape 转义、toCsv BOM+CRLF、parseCsv 引号内逗号/换行/""转义、rowsToObjects 往返、缺列补空、空输入）、三个 Mock 适配器映射（确定性、source 恒 demo、limit 钳制 0→1/>30→30、联系人 1-3 与 emailVerified 枚举、海关 0-3 条由 hashInt 决定并枚举覆盖 0 与 >0）、SerperSearchAdapter fetch-mock 契约（title「 | Home」清洗、请求体组装 q/gl/num、429→RATE_LIMITED、organic 缺省→[]、非法 schema→BAD_RESPONSE、AbortError→TIMEOUT、AdapterError 透传）
  - test/setup-env.cjs：LLM/SERPER/APOLLO/CUSTOMS_API_KEY 置空——测试套件强制走确定性 Mock 路径
  - web/public/favicon.svg + index.html 引用：消除 favicon.ico 404 的 2 个 console error
  - docs/screenshots/：9 张浏览器全链路截图
- 决策与备注：
  - **测试环境前提变化**：用户在 server/.env 并行配置真实 LLM_API_KEY（Serper/Apollo/Customs 同理），jest 继承后 ai.spec 走真 LLM 导致 3 用例失败（等级 B/A 波动、subject 无 LLC、含敏感词）——修复为 setup-env 置空 Key 强制 Mock；真实第三方路径仍由 fetch-mock 契约测试覆盖（不烧配额、可重复）
  - **用户并行改动（ImportYeti）**：开发期间用户新增 ImportYetiAdapter（美国海关 AMS 提单，provider='importyeti' 仅 Key）接入 adapter.factory + .env.example + architecture.md——修复其 CustomsDataAdapter 类型导入（应从 ./customs.adapter 而非 ../types），一并验证提交
  - 浏览器验收用 playwright-cli（chrome-devtools MCP 未配置）；截图/快照临时文件不入库（.gitignore 加 .playwright-cli/）
- 验收证据：
  - npm test 69/69（7 套件 = unit 38 + 集成 31）✓；双端 tsc 零错误 ✓
  - 浏览器全链路（demo@tradepilot.dev）：登录 → Dashboard → Settings(产品+Key 管理) → Lead Discovery 建任务(Carbon Fiber Insoles/US/10 家) → 四步完成 → Companies(DEMO 徽章+CRM 状态) → 详情页(联系人 2/海关无记录/评分 65 B mock-rules-v1/开发信草稿生成含企业名与收件人) → CRM 流转 NEW→QUALIFIED(时间线) → 跟进+下次跟进 2026/11/17 → CRM 列表「已合格」Tab 筛选命中 → Email Studio 占位 → 登出 ✓（截图 01–09）
  - console 全程 0 error（修复 favicon 后；仅 React Router v7 future flag warning 与浏览器 verbose 提示）✓
- 遗留问题：Email Studio 为「待实现」占位页（PRD 中 P1，MVP 邮件草稿已在企业详情页完成）

### 阶段 9：README + 部署 + 总验收

- 交付物：
  - README.md：简介与 MVP 边界（只生成草稿/DEMO 标注）、功能总览、技术栈、快速开始（nvm 22 → docker → server(migrate+seed) → web）、架构图、env 表、API 概览（10 模块 37 端点）、目录结构
  - docs/deployment.md：环境要求、本地从零部署、生产构建/迁移 deploy/Secrets 注入表、进程与端口（worker 拆分预留）、生产化检查清单、回滚策略、实测运维要点（@Inject 约定/127.0.0.1 绑定/--runInBand）
  - docs/acceptance.md：12 条验收场景逐条留档（操作/预期/实测/证据截图），12/12 通过；回归保障与 P2 范围声明
- 决策与备注：
  - 文档以代码为准逐项核对（env 键名、端点清单取自 controller 扫描、演示账号取自 seed.ts）
  - 新目录 clone 实测选择「全新数据库 tradepilot_clonetest」而非复用现有库，确保 migrate/seed 真实从零执行；docker 基础设施容器名固定（README 假设干净机器，本机已运行即复用）
- 验收证据：
  - **新目录 clone 实测**（/tmp/tradepilot-clone-20261110，HEAD=43d3561）：cp .env.example→填 JWT_SECRET/APP_ENCRYPTION_KEY→npm install→prisma migrate dev（全新库建表）→npm run seed（唯一约束自检通过+演示账号）→npm run dev → `/api/health` {status:ok,db:up,redis:up} ✓；web npm install→build 成功（gzip 79.89KB）→dev :5173 200→/api 代理通 ✓；浏览器登录 demo 账号→Dashboard 渲染（全新库空数据正确）→console 0 error ✓
  - 12 条验收场景：全部通过（acceptance.md 逐条留档，关键场景附 API 响应摘录：任务 params country=US/companyTypes、海关记录 source=demo、评分 76/B、CRM summary dueFollowUps）
  - 测试后清理：clone dev 进程已停，工作区 server/web dev 已恢复（health ok / web 200）
- 遗留问题：
  - 独立 worker 进程拆分推迟到多副本部署时（单实例同进程已验证）
  - 真实第三方 API（Serper/Apollo/ImportYeti/DeepSeek）未在验收中实测（无正式配额），路径由 fetch-mock 契约测试覆盖；配置 Key 后走同一 Adapter 接口
  - JWT Bearer + localStorage 为 PRD 确认的 MVP 决策，生产化建议换 httpOnly cookie（ADR 留档）
