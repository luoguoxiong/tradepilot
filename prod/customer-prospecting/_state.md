# 工作流状态

- 需求原文：根据产品和目标市场自动寻找潜在客户，AI 分析客户官网生成客户分析报告并评分；业务员确认后 AI 自动生成个性化开发信。将单客户 20 分钟开发流程缩短到 3~5 分钟。
- Feature：customer-prospecting
- 当前阶段：done
- 迭代轮次：v1
- 用户决策记录：v1 即含自动搜索（主通道，DDG 默认+Google CSE/SerpAPI 可选），粘贴导入为备用；开发信=生成+人工发送；产品形态=Web 应用
- 阶段历史：
  - [{阶段: phase1, 完成时间: 2026-09-03, 产物: prod/customer-prospecting/diagnosis.md, prod/customer-prospecting/prd.md(v1.1), prototype.html}]
  - [{阶段: gate1, 完成时间: 2026-09-03, 结果: PRD v1.1 通过}]
  - [{阶段: phase2, 完成时间: 2026-09-03, 产物: server/(12源文件+tsc通过), web/(Vue3构建通过), server/docs+web/docs design-v1.md}]
  - [{阶段: gate2, 完成时间: 2026-09-03, 结果: 实现方案通过}]
  - [{阶段: phase3, 完成时间: 2026-09-03, 产物: test/customer-prospecting/{test-plan.md, test-report-v1.md, eval-sets/golden-v1.jsonl}, 结果: 有条件Go（24/24通过，3项真实key验收待回填）}]
  - [{阶段: phase4, 完成时间: 2026-09-03, 结果: 交付总结完成}]
