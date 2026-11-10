---
name: tradepilot-plan-executor
description: 严格按照 plan.md 中的九阶段开发计划执行 TradePilot AI 项目开发，提供跨会话的持久化进度追踪、每阶段验收门检查和子技能自动编排。当用户要求开始、继续或推进 TradePilot 项目开发，查看开发进度，跳转到指定阶段，或说"继续开发"、"开始下一阶段"、"执行开发计划"、"看看进度"时使用本技能。
---

# TradePilot 开发计划执行器

严格按照 `plan.md` 中的九阶段计划编排 TradePilot AI SaaS MVP 的开发。一次只执行一个阶段，每个阶段验证可运行后才推进，并持久化进度以便任何后续会话都能从停止的位置无缝续接。

## 核心文件

- `plan.md` — 唯一权威的产品计划（需求、技术栈、阶段划分、验收标准）。绝不与它冲突；若发现它与实际情况矛盾，向用户呈现矛盾点，而不是悄悄偏离。
- `.codebuddy/progress.md` — 执行状态的唯一事实来源。模板见 `references/phases.md`。
- `references/phases.md` — 各阶段详细执行指南：目标、交付物、需加载的子技能、验收门。**执行某阶段前必须先读完该阶段对应的章节。**

## 工作流

本技能每次被触发时，按以下顺序执行：

### 1. 定位当前状态

1. 完整阅读 `plan.md`（约 500 行，全部读完）。
2. 读取 `.codebuddy/progress.md`。
   - 若该文件不存在，按 `references/phases.md` 中的模板创建，9 个阶段全部标记 `pending`，阶段 1 标记 `in_progress`。
3. 向用户汇报：当前阶段、其状态、剩余内容、接下来要做的事。

### 2. 执行当前阶段

1. 读取 `references/phases.md` 中对应阶段的章节。
2. 在动手前，先加载（通过技能工具）该阶段列出的子技能。
3. 按"薄切片、可验证"的方式推进——遵循 `incremental-implementation` 原则。绝不一次性生成大批未验证的代码。
4. 全程遵守下方的硬性规则。

### 3. 运行验收门

验收门未通过，阶段就不算完成。每个验收门至少包含：

- TypeScript 类型检查通过（`tsc --noEmit` 或项目配置的检查命令）。
- 应用（或本阶段构建的部分）真实可运行——启动它、请求接口或渲染页面、确认行为。
- 本阶段编写的测试全部通过。
- `references/phases.md` 中列出的阶段专项检查。

验收门失败时，先修复再继续。不允许"先标完成、回头再修"。

### 4. 记录进度与检查点

1. 更新 `.codebuddy/progress.md`：将该阶段标记 `done`，填写交付物、日期、验收证据、备注/决策。将下一阶段设为 `in_progress`。
2. 用规范化信息提交（如 `feat(phase-4): scaffold frontend/backend workspace with docker compose`）。提交中须包含 `.codebuddy/progress.md`。
3. 向用户简要汇报本阶段交付了什么、下一阶段将做什么。

### 5. 推进

仅当用户要求连续推进（如"把整个计划做完"）时，才不停顿直接进入下一阶段。否则每个阶段结束后暂停，等待用户决策。

## 硬性规则（源自 plan.md——不可协商）

- **可运行优先于完备**：绝不输出大批无法运行的代码。每个阶段必须以可运行、可演示的状态收尾。
- **禁止伪造数据冒充真实数据**：Mock/演示数据必须显著标注 DEMO；绝不把伪造的联系人、邮箱、海关记录伪装成真实 API 结果。
- **所有第三方 API（Google Search、Apollo、海关数据）一律走 Adapter 模式**：业务代码中不得出现第三方 API 调用逻辑；全部封装在适配器后，且每个适配器都有无 Key 可用的 Mock 实现。
- **API Key 只通过环境变量管理**，绝不硬编码。
- **AI 输出必须可解释**：客户评分必须返回匹配原因、采购需求、合作机会、开发建议和不确定性说明——不能只有一个分数。
- **MVP 阶段邮件只生成草稿**——不自动发送。
- 技术栈：React 18 + TypeScript + Vite + Tailwind + shadcn/ui + Zustand（前端）；Node.js + TypeScript + NestJS/Fastify + PostgreSQL + Prisma/Drizzle + Redis + BullMQ（后端）；OpenAI 兼容大模型 + Tool Calling + 结构化 JSON 输出。

## 阶段跳转与重入

- 若用户要求跳到指定阶段（如"直接做第八步测试"），先验证该阶段的前置条件是否就绪；若未就绪，先补齐最小缺失的前置内容，并在 `.codebuddy/progress.md` 中注明。
- 若后续开发中发现某个已标记 `done` 的阶段被破坏，先修复，然后在该阶段条目中追加修复记录——绝不放任其处于损坏状态。
