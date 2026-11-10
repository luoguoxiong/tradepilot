# TradePilot AI — 任务清单（按 P0 优先级）

> 来源：`docs/PRD.md`。切片 = 一个可独立验证的纵向薄切片。
> 阶段编号对应九阶段计划：3=Schema、4=工程+Docker、5=核心 API+页面、6=AI、7=CRM 闭环、8=测试、9=文档。

## P0（核心闭环）

| 编号 | 任务 | 阶段 | 预估切片 |
|---|---|---|---|
| T01 | PostgreSQL Schema：11 张表 + 唯一约束 + 索引 + tenant_id 预留 + docker-compose 起 postgres/redis + 首次迁移跑通 | 3 | 2 |
| T02 | 种子数据脚本：插入用户/产品/企业样例，验证唯一约束（重复插入报冲突） | 3 | 1 |
| T03 | 后端工程骨架：框架选型落地、`GET /health`（含 DB 连通）、.env + 校验、全局错误处理、结构化日志 | 4 | 2 |
| T04 | 前端工程骨架：Vite + React 18 + TS + Tailwind + shadcn/ui、侧边栏布局、6 大页面路由骨架 | 4 | 2 |
| T05 | `.env.example` 全量环境变量（DB/Redis/LLM/三方 Key，标注无 Key 走 Mock） | 4 | 1 |
| T06 | 认证：注册/登录（JWT + 密码哈希）、未登录 401 中间件 | 5 | 2 |
| T07 | 我方产品 CRUD（products）+ 前端产品配置页 | 5 | 2 |
| T08 | CompanySearchAdapter 接口 + Mock 实现（DEMO 标记数据） | 5 | 1 |
| T09 | 搜索任务：POST 创建 → BullMQ 异步执行 → 状态查询接口 | 5 | 2 |
| T10 | 前端 Lead Discovery 页：表单 + 任务进度轮询 + 结果展示 | 5 | 2 |
| T11 | Companies 列表页：分页、去重展示、收藏、批量导入 CRM | 5 | 2 |
| T12 | Company Detail 基础版：企业字段全量展示 | 5 | 1 |
| T13 | Settings 页：integrations 表读写各 Adapter API Key | 5 | 1 |
| T14 | LLM 调用层：OpenAI 兼容客户端、超时、重试、Token/成本日志 | 6 | 1 |
| T15 | LeadScoringTool：zod 结构化输出六件套、权重一致性、稳定性保障、A/B/C/D 落库 | 6 | 2 |
| T16 | EmailGenerationTool：四件套生成、prompt 模板集中管理、禁止编造约束 | 6 | 2 |
| T17 | Company Detail 集成 AI：分析结果展示 + 开发信生成/编辑/复制/保存 | 6 | 2 |
| T18 | CRM 客户列表：状态筛选、搜索、分页 | 7 | 1 |
| T19 | CRM 客户详情：企业+联系人+海关+AI+邮件+跟进时间线整合 | 7 | 2 |
| T20 | 状态机流转 + 跟进记录 + 下次跟进时间 + Dashboard 待跟进卡片 | 7 | 2 |

## P1（阶段 7 内完成）

| 编号 | 任务 | 阶段 | 预估切片 |
|---|---|---|---|
| T21 | ContactDiscoveryAdapter（Apollo Mock/Real）+ 联系人挖掘集成 Company Detail | 7 | 2 |
| T22 | 手动补充联系人 + 邮箱验证状态展示 | 7 | 1 |
| T23 | CustomsDataAdapter（Mock 标注 DEMO）+ Company Detail 海关记录展示 | 7 | 2 |
| T24 | CSV 导入导出（companies/contacts），导出再导入无损往返 | 7 | 2 |
| T25 | 任务编排完善：单步失败恢复、步骤日志、频率限制与成本控制 | 7 | 2 |

## P2（MVP 不做）

自动邮件发送、邮件回复分析、自动跟进、多 Agent 协作、订阅付费。

## 检查点

- **阶段 3 末**：docker compose 起 postgres，迁移成功，约束验证通过
- **阶段 4 末**：前端可打开导航可点击，`/health` 200 含 DB 状态，tsc 零错误
- **阶段 5 末**：演示流程 登录→配置碳纤维鞋垫→搜索 US+Importer→列表见 DEMO 企业
- **阶段 6 末**：评分稳定性（两次评分波动 ≤10）、邮件无伪造采购内容、非法 JSON 不 500
- **阶段 7 末**：PRD 第 4 节验收场景 1–7、11、12 全部可现场演示
- **阶段 8/9**：自动化测试全通过 + 浏览器全链路截图留档 + 12 条场景逐条验收
