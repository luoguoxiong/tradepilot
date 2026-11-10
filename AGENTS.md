# TradePilot AI — Agent 工作规则

## 项目结构

- `plan.md` — 产品计划（唯一权威需求来源）
- `docs/PRD.md` — 需求基线；`docs/architecture.md` — 技术基线；`docs/tasks.md` — 任务清单
- `.codebuddy/progress.md` — 开发进度唯一事实来源（tradepilot-plan-executor 技能维护）
- `server/` — NestJS 后端（Prisma + PostgreSQL + Redis/BullMQ）
- `web/` — React 18 前端（Vite + Tailwind + shadcn/ui + Zustand）

## 命令（一律用 nvm v22.19.0；默认 node 18 不兼容）

```bash
source ~/.nvm/nvm.sh && nvm use 22.19.0
docker compose up -d                                  # postgres(5435) + redis(6393)
cd server && npm run dev                              # API http://127.0.0.1:3020/api/health
cd web && npm run dev                                 # Web http://127.0.0.1:5173
cd server && npx prisma migrate dev && npm run seed   # 迁移 + 种子
npx tsc --noEmit                                      # 类型检查（server/ 与 web/ 各自跑）
```

## 后端约定

- **tsx/esbuild 不支持 emitDecoratorMetadata**：所有构造器注入必须显式 `@Inject(Token)`，禁止裸构造器参数依赖。
- 第三方 API（Google/Apollo/海关/LLM）调用只允许出现在 `server/src/adapters/` 与 `server/src/ai/`，业务模块零直接调用。
- 无 API Key 时 Adapter 自动降级 Mock；Mock 数据 `source: 'demo'`，前端必须显示 DEMO 徽章。
- 统一错误结构 `{ error: { code, message, details? } }`（AllExceptionsFilter 已全局生效，勿绕过）。
- 环境变量只经 `server/src/config.ts`（zod 校验）读取；Key 绝不硬编码、不入 git。
- 日志用 `logger`（pino 结构化 JSON）。

## 前端约定

- 组件 named export；路径别名 `@/` → `web/src/`。
- UI 组件放 `web/src/components/ui/`（shadcn 风格；可 `npx shadcn add <name>` 扩展，components.json 已配置）。
- 页面放 `web/src/pages/`，路由在 `web/src/App.tsx`。
- dev server 显式绑定 `127.0.0.1`（本机 localhost 会解析到 ::1，curl 不通）。

## 硬性规则（违反即交付失败）

1. Mock/演示数据必须显著标注 DEMO；禁止把伪造的联系人、邮箱、海关记录伪装成真实数据。
2. MVP 邮件只生成草稿，不自动发送。
3. 每个阶段以可运行、可演示状态收尾；禁止一次性生成大批未验证代码。
4. 提交信息规范：`feat(phase-N)/fix/docs/chore(scope): 描述`，且包含 `.codebuddy/progress.md` 更新。

## 验收

- 阶段验收门与 12 条最终演示场景见 `docs/PRD.md` 第 4 节。
