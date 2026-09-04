# AI 外贸跟单助理（order-followup）测试报告 v1

- 版本：v1（对应 PRD v1 / design-v1 / test-plan v1）
- 日期：2026-09-04
- 结论：**Go（准入通过）**——P0=0、P1=0（本轮发现 1 项 P1 已修复并回归）、评估集命中率 100%（门禁 ≥90%）、红线 R1-R5 全部 PASS

---

## 一、执行环境

- 后端：Node v18.20.8 / tsx，隔离 DB（/tmp 临时库），Mock LLM（本地 :4603）
- AI 评估：真实 DeepSeek（deepseek-chat），8 样本 × 1 次调用
- 前端：Vite 5173 + 运行中后端 8787，浏览器只读冒烟
- 一期回归：integration / prompts / score / search-filter

## 二、分层结果汇总

| 层 | 用例文件 | 结果 | 结论 |
|----|---------|------|------|
| 准入-构建 | server `tsc --noEmit` | 通过 | ✅ |
| 准入-构建 | web `vue-tsc --noEmit` | 通过 | ✅ |
| 一期回归 | integration + prompts + score + search-filter | **24/24 pass** | ✅ 无回退 |
| 确定性单测 | order-docs + order-anomalies | **21/21 pass** | ✅ |
| API 集成 | order-api（Mock LLM + 隔离 DB） | **20/20 pass**（exit 0） | ✅ |
| AI 评估集 | order-parse-eval（真实 LLM，golden v1） | **字段命中率 131/131 = 100%**（门禁 90%） | ✅ |
| E2E 冒烟 | 浏览器：/、/orders、/anomalies、/settings | **4 页全 PASS**，无 error 级 console 日志 | ✅ |

## 三、红线（P0）验证矩阵

| 红线 | 验证用例 | 结果 |
|------|---------|------|
| R1 单证数字来自订单确认数据 | 建单金额不一致拒绝（test 4）；PI 生成校验通过（7）；装箱单缺箱数阻断 code=2（8）；改单后金额不一致重生成阻断（10）；`amountInWords`/`validateDoc`/`buildDocData` 单测 | ✅ PASS |
| R2 解析未经确认不入库 | 导入只写 order_imports、confirm 才建单（test 12）；确认前订单表无数据 | ✅ PASS |
| R3 邮件不编造事实 | 占位符残留被拒（chatJson 重试后仍失败 → 明确报错，14）；合法草稿落库 draft（15）；发送仅由显式 /send 触发、失败有留痕（16） | ✅ PASS |
| R4 SMTP 密码 write-only + 加密 | 设置 GET 不含密码明文（17）；`encryptSecret`/`decryptSecret` 回环（19） | ✅ PASS |
| R5 异常规则不漏报 | 异常引擎四类规则 × 边界日期单测（order-anomalies.test） | ✅ PASS |

## 四、AI 评估集指标（golden v1，8 样本）

- 头部 9 字段 + items 行级字段，逐字段等值断言（日期标准化、币种大写、数值容差 0.005）
- **本轮：131/131 = 100%**；低置信度标注合理（缺失/模糊字段均如实给出 low confidence，符合"不编造"约束）
- 回流规则：后续 badcase 追加至 `eval-sets/order-parse-golden-v1.jsonl` 并标注来源轮次（只增不减）

## 五、缺陷清单（本轮发现）

| 编号 | 级别 | 描述 | 根因 | 修复 | 回归 |
|------|------|------|------|------|------|
| BUG-OF-01 | **P1**（已修复） | 订单解析对真实 LLM 输出字段命中率仅 61.8%：模型自造键名（`po_number`、`port_of_loading`、`buyer/seller` 等），golden 字段全部取到 undefined | Prompt 未显式约定 JSON 键名（Mock LLM 按脚本返回正确键名，集成测试无法暴露） | ① system prompt 增加显式 JSON schema（固定键名+类型+禁增删改）；② `validateParsedOrder` 拒绝未知键；③ 依赖 `chatJson` 将校验错误回灌模型自纠重试 | 评估集重跑 100%；order-api 20/20 重跑通过 |
| BUG-OF-02 | P3（测试卫生，已修复） | order-api 测试进程结束后不退出、残留监听 8789；且 cleanup 内直接 `process.exit(0)` 会截断 runner 上报（后 2 条用例结果丢失） | 服务与监控定时器保持事件循环 | cleanup 改为 `unref` 兜底定时器延迟退出，结果完整上报后释放端口 | 20/20 完整上报、端口释放确认 |

另：执行过程发现"多进程并发跑同一测试文件互写同一日志"导致 TAP 输出交错伪读（非代码缺陷，流程问题），已通过串行化单次执行消除。

## 六、E2E 冒烟明细（浏览器）

- `/` 首页渲染正常；`/orders` KPI + 表格 + 「导入订单/手动录入」按钮齐备；`/anomalies` KPI + 异常列表正常；`/settings` SMTP 与提醒规则表单齐备
- Console 无 error 级日志；仅 2 条 Element Plus `multipleLimit` prop 类型警告（String 传入 Number）→ **P3 观察项**，建议后续统一为 `:multiple-limit` 数字绑定

## 七、遗留风险与观察项

1. 解析评估依赖模型非确定性：本轮 100%，后续 prompt/模型/温度任何变更须全量重跑评估集（门禁 ≥90%，跌幅 5pct 阻断发布）
2. 扫描件 PDF 不支持为 PRD 明示边界（P3 观察项）
3. Element Plus prop 类型警告（P3，不影响功能）
4. 真实 SMTP 发送链路仅验证到"未配置 SMTP 时失败有留痕"；生产启用前建议用测试邮箱做一次真实发送演练

## 八、准出核对

- [x] server tsc / web vue-tsc 构建通过
- [x] 一期既有 24 用例回归通过
- [x] P0 = 0
- [x] P1 = 0（BUG-OF-01 已修复并回归）
- [x] 解析评估集字段命中率 100% ≥ 90%
- [x] 红线 R1-R5 全部 PASS
