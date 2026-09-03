# 智能客户开发（customer-prospecting）测试计划 v1

- 日期：2026-09-03
- 测试依据：prod/customer-prospecting/prd.md v1.1（第 5 节 AI 行为边界 / 第 6 节验收标准）、server/docs/customer-prospecting/design-v1.md
- 环境约束：**无真实 LLM key、无 Tavily key**。策略：确定性逻辑精确断言（100% 离线可跑）+ 本地 Mock LLM 验证 AI 链路与降级路径 + 本地 Fixture 站点替代真实抓取。真实 LLM/搜索源效果评估（评估集语义断言）列为「持 key 后执行」项。

## 一、测试范围与红线场景

| 红线 | 测试对象 | 断言方式 |
|------|---------|---------|
| R1 评分引擎确定性 | `services/score.ts` | 精确断言：各 level→分数映射、grade 边界（80/60/40）、scale_info=null 计 0 |
| R2 联系方式不走 LLM | `services/scraper.ts` 规则抽取 | 精确断言：邮箱正则抽取、form 检测、集成测试中 LLM 返回伪造 contact 被规则结果覆盖 |
| R3 开发信后置校验 | `prompts/outreach.ts` | 精确断言：>150 词拒绝、垃圾词命中、双标题强制 |
| R4 幻觉防线 | `prompts/analysis.ts` validateAnalysis | 精确断言：缺 evidence/非法 level/缺字段均拒绝；抓取失败时 incomplete 标注 |
| R5 过滤与去重 | `providers/search.ts` isBlocked | 精确断言：amazon/社媒/pdf 等黑名单、非 http 拒绝 |
| R6 失败降级 | 队列 + LLM client | 集成：LLM 持续 500 → 自动重试 1 次 → lead=failed 且 error 明确 |
| R7 JSON 校验重试 | `llm/client.ts` chatJson | 集成：首次非法 JSON → 带错误重试 → 成功 |

## 二、测试策略分层

1. **确定性单测**（node:test，离线，CI 必跑）：R1-R5
2. **集成测试**（Mock LLM 服务 + Fixture 官网点 + 内存 DB）：
   - 分析全链路：lead→抓取→LLM(mock)→评分→落库 done
   - 抓取失败降级：目标站不可达 → snippet 兜底 + incomplete 标注
   - 开发信生成：合规输出通过；垃圾词首次输出→重试通过
   - R6/R7 降级路径
3. **API 冒烟**（已在 Phase 2 完成：profiles/search/leads/analyze/tasks 已 curl 验证）
4. **持 key 后执行项**（本环境无法覆盖，列入报告遗留风险）：
   - 真实 LLM 分析事实准确率抽检 20 客户（验收 ≥95%）
   - 真实搜索返回 ≥10 条有效线索
   - 开发信采纳率（业务真实使用回流）

## 三、评估集设计

`test/customer-prospecting/eval-sets/analysis-golden-v1.jsonl`：Mock 输入（fixture 官网文本）+ 理想分析 JSON + 要素清单（必须命中哪些证据短语、哪些字段必须为 null）。本轮以 Mock 断言执行；持真实 key 后重跑做语义评估。
`eval-sets/outreach-golden-v1.jsonl`：产品档案+报告输入 → 理想开发信要素（含钩子引用证据、无编造认证、<150 词、单一 CTA）。

## 四、环境与数据

- 单测：node:test + tsx，DB 用 `DB_PATH=/tmp/*.db` 隔离（db.ts 已支持环境变量覆盖）
- Mock LLM：node:http 起本地服务，按序返回 canned response（可注入非法 JSON/垃圾词/500）
- Fixture 站点：本地 http 服务返回含 About/Products/Contact 链接、邮箱、表单、importer 信号词的 HTML

## 五、准入/准出（质量门禁）

- 准出：红线 R1-R7 全部 PASS；单测全绿；集成链路 done/failed 状态机正确
- 真实 key 验收项未执行 → 报告结论为「**有条件 Go**」（代码链路可上线，效果指标待真实环境回填）

## 六、风险

- Mock 与真实模型行为差异 → 用评估集回填
- DuckDuckGo/Google 源在用户网络不可达 → 已有级联降级，集成测试覆盖失败链路
