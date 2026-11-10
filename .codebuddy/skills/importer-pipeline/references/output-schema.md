# 标准输出 JSON Schema（importer-pipeline）

每个进口商一个文件：`./商品类型/进口商/<importer_slug>.json`，UTF-8，顶层为单一对象。取不到的字段填 `Unknown`（字符串）或 `[]`（数组），不允许编造。

## 顶层结构

```json
{
  "meta": {},
  "company": {},
  "import_records": [],
  "contacts": [],
  "sourcing": {},
  "assessment": {},
  "data_confidence": "",
  "missing_information": [],
  "sources": []
}
```

## meta

| 字段 | 类型 | 说明 |
|---|---|---|
| schema_version | string | 固定 `1.0` |
| generated_at | string | ISO 8601，如 `2026-11-10T15:30:00+08:00` |
| product | string | 输入的商品名称 |
| target_country | string | 输入的目标国家 |
| product_keywords | array | 输入的商品关键词 |
| hs_code | string | 输入的 HS 编码，无则 `Unknown` |
| pipeline_version | string | 阶段一来源技能名 + 阶段二来源技能名，如 `finder@importer-finder-contact-enricher + investigator@importer-sourcing-investigator` |

## company（阶段一）

| 字段 | 类型 | 说明 |
|---|---|---|
| company_name | string | 必填，非空 |
| website | string | 官网 URL，无则 `Unknown` |
| country / city | string | 所在国家 / 城市 |
| company_type | string | Importer / Distributor / Wholesaler / Retailer / Unknown |
| business_description | string | 企业简介 |
| relevant_products | array | 相关产品关键词 |
| aliases | array | 阶段二识别的品牌名/DBA/历史名称 |

## import_records（阶段一证据 + 阶段二提单明细合并）

数组元素（去重后）：

| 字段 | 类型 | 说明 |
|---|---|---|
| supplier_names | array | 供应商名 |
| supplier_countries | array | 供应商国家 |
| shipment_date | string | 提单日期，无则 `Unknown` |
| product_description | string | 货物描述 |
| hs_code | string | 无披露留 `Unknown` |
| quantity / weight / trade_value | string | 无披露留 `Unknown` |
| bill_of_lading | string | 提单号，无留 `Unknown` |
| evidence_source | string | 数据平台名（ImportYeti 等） |
| evidence_url | string | 原始页面 URL |

## contacts（阶段一）

| 字段 | 类型 | 说明 |
|---|---|---|
| contact_name | string | 姓名，推测身份须标 `Unknown` 并在 note 说明 |
| contact_title | string | 职位 |
| contact_department | string | 部门 |
| business_email | string | 邮箱 |
| email_verification_status | string | `Valid` / `Invalid` / `Accept-all` / `Unknown`，四选一 |
| phone / whatsapp | string | 无则 `Unknown` |
| linkedin_profile | string | 个人主页 URL |
| contact_page | string | 企业官网联系页 URL |
| contact_source_url | string | 联系人证据来源 |
| contact_priority | string | 阶段二建议的联系优先级 `high` / `medium` / `low` |

## sourcing（阶段二）

| 字段 | 类型 | 说明 |
|---|---|---|
| investigation_status | string | `completed` / `no_data` / `blocked` |
| importer_aliases | array | Alias List（品牌名、法律名、DBA、母子公司） |
| source_countries | array | 元素 `{country, supplier_count, shipment_count, main_products}` |
| suppliers | array | 元素 `{name, country, products, shipment_count, first_shipment, last_shipment, relationship_type, is_china_supplier}`；relationship_type ∈ `core/new/alternative/supporting/competitor/Unknown` |
| products | array | 元素 `{category, descriptions, hs_code, notes}`；category ∈ `finished_goods/semi_finished/raw_material/components/packaging/other` |
| trends | object | `{period_1y, period_3y, period_5y, summary, is_sample_only}`；数据不完整时 is_sample_only=true |
| china_opportunities | array | 元素 `{type, description, evidence, confidence}`；type ∈ `existing_china_supplier/china_replacement/oem_odm_entry/new_product_line` |
| competitor_analysis | array | 元素 `{supplier, threat_level, reason}` |
| development_advice | object | `{recommended_products, target_titles, selling_points, outreach_angle, pricing_strategy, follow_up_plan, open_questions}` |

## assessment

| 字段 | 类型 | 说明 |
|---|---|---|
| match_score | int | 0-100，阶段一评分，深挖后可按证据修订（修订须在 match_reason 注明） |
| customer_level | string | `A`(80-100) / `B`(65-79) / `C`(50-64) / `D`(<50) |
| match_reason | string | 评分理由 |
| potential_needs | string | 阶段二推断的采购需求（区分已验证/推测） |
| recommended_sales_strategy | string | 推荐销售策略 |
| priority_rank | int | 本批客户中的优先级排名，index 内唯一 |

## 其他顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| data_confidence | string | `A`(原始提单可验证) / `B`(双平台交叉) / `C`(单平台档案) / `D`(间接线索)，取两阶段较低值 |
| missing_information | array | 缺失项清单，字符串数组，如 `"trade_value: 平台未披露"` |
| sources | array | 元素 `{source, url, related_field, confidence}`，关键结论逐条对应 |

## index.json（目录级汇总）

```json
{
  "schema_version": "1.0",
  "generated_at": "",
  "product": "",
  "target_country": "",
  "stats": {"total_candidates": 0, "investigated": 0, "level_counts": {"A": 0, "B": 0, "C": 0, "D": 0}, "contacts_verified": 0},
  "importers": [
    {
      "company_name": "",
      "importer_slug": "",
      "customer_level": "",
      "match_score": 0,
      "investigation_status": "",
      "contact_count": 0,
      "china_supplier_found": false,
      "json_file": "",
      "md_file": ""
    }
  ]
}
```

`importers` 按 match_score 降序；`json_file`/`md_file` 为相对本目录的文件名。

## Markdown 报告结构（<importer_slug>.md）

1. 企业基本信息（表）
2. 进口来源国家分析（表 + 统计口径说明）
3. 供应商名单（表）
4. 重点贸易记录（表，选 5-10 条代表性提单）
5. 采购趋势（标注样本趋势）
6. 中国供应商分析（逐家）
7. 供应链机会（已确认 / 有证据 / 推测分层）
8. 联系人与开发建议（联系人表 + 开发信方向）
9. 数据来源及可信度（A-D 分级 + URL 清单）
