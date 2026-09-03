# tradepilot

外贸 agent

## Skill 体系

本项目在 `.trae/skills/` 下配置了 4 个外贸 AI Skill，覆盖「产品 → 开发 → 测试」全流程：

| Skill | 职责 | 触发场景 |
|-------|------|---------|
| `foreign-trade-ai-product-expert` | 产品专家 | 需求诊断、PRD 打磨、竞品分析 |
| `foreign-trade-ai-dev-expert` | 开发专家 | 前后端编码、技术选型、线上问题排查 |
| `foreign-trade-ai-qa-expert` | 测试专家 | 测试设计、LLM 效果评估、Bug 分级、Go/No-Go 门禁 |
| `foreign-trade-ai-workflow` | 总控编排 | 一句话需求端到端跑完整流水线 |

## 使用方式

### 方式一：全流程（推荐新需求使用）

一句话触发工作流：

```text
启动外贸AI工作流：做一个AI询盘自动回复功能，目标用户是机械行业的外贸业务员
```

流程会按 `产品 → Gate1(PRD确认) → 开发 → Gate2(代码确认) → 测试 → 交付总结` 自动推进，两个门禁处会暂停等你确认。会话中断后重新触发可从断点续跑。

### 方式二：单阶段（小需求/单项任务）

直接说需求，命中对应 Skill 自动生效：

- `帮我打磨一下AI报价功能的产品方案` → 产品专家
- `在 server 里实现询盘意图分类接口` → 开发专家
- `给单证生成功能设计测试用例并执行` → 测试专家

### 方式三：迭代已有需求

对已跑过的需求再次描述（如"询盘回复功能要支持西班牙语"），工作流会读取既有产物，作为新迭代轮次处理，不推倒重来。

## 产物目录约定

```text
prod/{feature}/                  # 产品文档：诊断报告、PRD（迭代追加修订记录）
server/                          # 后端项目（代码在 git 中演进）
server/docs/{feature}/           # 后端技术方案：design-v1.md, design-v2.md…
web/                             # 前端项目
web/docs/{feature}/              # 前端技术方案：design-v1.md, design-v2.md…
test/{feature}/                  # 测试资产：评估集（只增不减）、test-report-v{n}.md
```

迭代规则：文档类产物保留历史版本（PRD 追加修订记录、技术方案与测试报告按 v1/v2/v3 递增）；代码在 `server/`、`web/` 内持续演进由 git 管理；测试评估集只增不减，防止 AI 效果回退。

## 注意事项

- 金额、HS 编码、汇率、单证等业务红线内容禁止纯 LLM 生成（Skill 内已内置该约束）
- 默认 Gate 1/Gate 2 需人工确认；如需全自动，明确说"全自动不用确认"即可
- 详细方法论见各 Skill 的 `SKILL.md`
