---
name: importer-pipeline
description: 外贸客户开发全流程编排技能：先调用 importer-finder-contact-enricher 按商品和目标国家寻找潜在海外进口商并挖掘采购负责人联系方式，再对筛选出的进口商逐个调用 importer-sourcing-investigator 深挖供应链（供应商、来源国、产品、采购趋势），最后整合两阶段数据输出标准化 JSON 与中文 Markdown 调查报告，落盘到 ./商品类型/进口商/ 目录。当用户要求跑进口商开发全流程、找客户并深挖供应链、生成"客户名单+调查报告"JSON/文档时使用本技能。
---

# Importer Pipeline（进口商开发全流程编排）

## 1. 目标

把两个既有技能串成一条流水线，一次交付可直接指导开发的成果：

1. **阶段一（找客户）**：调用 `importer-finder-contact-enricher`，按商品 + 目标国家找潜在进口商，挖掘采购负责人联系方式，按匹配度评分。
2. **阶段二（深挖供应链）**：对筛选出的进口商逐个调用 `importer-sourcing-investigator`，还原供应商结构、来源国、产品、采购趋势与中国供应链机会。
3. **阶段三（整合落盘）**：合并两阶段数据，输出标准 JSON + 中文 Markdown 报告到 `./商品类型/进口商/` 目录。

## 2. 依赖技能

本技能是编排层，不重复实现两阶段的具体调查逻辑：

| 阶段 | 技能 | 获取方式 |
|---|---|---|
| 一 | `importer-finder-contact-enricher` | 优先通过 use_skill 按名称调用；不可用时读取 `.codebuddy/skills/importer-finder-contact-enricher/SKILL.md` |
| 二 | `importer-sourcing-investigator` | 同上，路径 `.codebuddy/skills/importer-sourcing-investigator/SKILL.md` |

输出格式细节见 `references/output-schema.md`（标准 JSON 字段定义）。

## 3. 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| product | 是 | 商品名称，如 Carbon Fiber Insoles |
| target_country | 是 | 目标国家，如 United States |
| product_keywords | 否 | 英文关键词/同义词列表 |
| hs_code | 否 | HS 编码 |
| buyer_type | 否 | Importer / Distributor / Wholesaler / Retailer |
| limit | 否 | 阶段一目标客户数，默认 50 |
| investigate_limit | 否 | 阶段二深挖家数，默认 10 |

只给商品和国家也必须能执行，其余参数用默认值。

## 4. 执行流程

### Phase 0：准备

1. 解析输入，缺失参数按默认值补齐并向用户复述执行计划（阶段一找 N 家 → 阶段二深挖 M 家 → 输出目录）。
2. 规范化商品类型目录名 `product_dir`：保留原文（含中文），仅将空格与路径非法字符（`/ \ : * ? " < > |`）替换为 `_`，例如 `Carbon Fiber Insoles` → `Carbon_Fiber_Insoles`。
3. 创建输出目录 `./product_dir/进口商/`。

### Phase 1：获取进口商（阶段一）

1. 以 product / target_country / product_keywords / hs_code / buyer_type / limit 为输入，执行 `importer-finder-contact-enricher` 的完整流程（搜索企业 → 海关数据验证 → 官网与 LinkedIn 联系人 → 邮箱查找）。
2. 产出候选进口商清单：企业信息、进口记录证据、联系人、match_score、customer_level。
3. 按 match_score 从高到低排序，去重（同企业多来源合并，保留全部 evidence_url）。
4. 找到的企业数少于预期时如实说明，不允许凑数。

### Phase 2：深挖供应链（阶段二）

1. 选取前 investigate_limit 家：按等级优先级 A → B → C 排序取前 M 家；D 级默认不深挖。
2. 对每家进口商，以 company_name / country / product_keywords / target_country 为输入，执行 `importer-sourcing-investigator` 的完整八步流程（身份识别 → 进口记录 → 供应商国家 → 产品分类 → 趋势 → 中国供应链机会 → 竞争供应商 → 开发建议）。
3. **每完成一家立即落盘**（Phase 3 写 JSON + MD），不要等全部完成后统一写。
4. 单家深挖失败（无贸易数据、平台不可访问）时：该家标记 `investigation_status: no_data` 或 `blocked`，写入 missing_information，继续下一家，不中断流水线。
5. 阶段一 contacts 为空的企业，深挖时优先补找采购联系人。

### Phase 3：整合落盘

对每家进口商：

1. 按 `references/output-schema.md` 合并数据：
   - 阶段一 → `company`、`import_records`、`contacts`、`assessment.match_score/customer_level/match_reason`。
   - 阶段二 → `sourcing`（source_countries、suppliers、products、trends、china_opportunities、competitor_analysis、development_advice）、`assessment.potential_needs/recommended_sales_strategy`。
   - 两阶段重复证据去重，保留所有来源 URL；`data_confidence` 取两阶段中较低值，`missing_information` 合并。
2. 写 `./product_dir/进口商/<importer_slug>.json`：UTF-8、合法 JSON（无尾逗号）、不虚构字段，取不到的数据填 `Unknown` 或空数组。
3. 写同名 `.md`：中文调查报告，结构 = 企业基本信息 / 进口来源国家 / 供应商名单 / 重点贸易记录 / 采购趋势 / 中国供应商分析 / 供应链机会 / 联系人与开发建议 / 数据来源及可信度（A-D 分级 + URL）。

`importer_slug` 生成规则：企业名执行 Phase 0 第 2 步同样的清洗，再压缩连续下划线，如 `VKTRY Gear LLC` → `VKTRY_Gear_LLC`。

最后更新 `./product_dir/进口商/index.json`（schema 见 references），汇总全部进口商：名称、等级、分数、是否深挖、联系人数、文件名，按分数排序。

### Phase 4：交付

1. 运行 `python3 scripts/validate_output.py ./product_dir/进口商/` 校验全部输出，修复报错后复跑。
2. 向用户汇报：目录结构、统计（候选 N 家 / 深挖 M 家 / A 级 x 家 / 有效联系人 y 个）、Top 5 客户及推荐理由、数据覆盖缺口、下一步开发建议。

## 5. 数据真实性规则

继承两个被编排技能的全部规则，另加：

1. 不为凑 investigate_limit 深挖低质量客户；数量服从质量。
2. JSON 中每个证据字段（evidence_url / evidence_source）必须真实可追溯，缺失即留空。
3. 阶段一未验证的邮箱带入阶段二时保持原 verification_status，不得升级。
4. 重跑时先检查已有输出：文件存在且非空则跳过（续跑语义），用户明确要求覆盖时才重写。
5. 全程中断恢复：index.json 缺某家但 JSON 已存在，按已深挖处理，仅补 index。

## 6. 运行原则

- 这是多阶段编排技能，不是单次搜索；先找客户、再验证业务、再挖供应链、最后整合落盘。
- 两个阶段共享同一套去重与证据标准，冲突时以原始提单/海关记录为准。
- 每阶段结束向用户同步进度与中间产出。
