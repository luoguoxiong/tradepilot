---
name: importer-finder-contact-enricher
description: 根据商品和目标国家主动寻找潜在海外进口商，通过 Google 搜索、海关贸易数据（ImportYeti/Panjiva 等）、企业官网、LinkedIn 和邮箱查找工具（Apollo/Hunter 等）挖掘企业与采购负责人联系方式，按匹配度评分并输出 Excel 客户名单与 Markdown 调查报告。当用户要求找海外客户、寻找进口商、外贸客户开发、获取采购负责人联系方式时使用本技能。
---

# Global Importer Finder & Buyer Contact Enrichment

## 1. Skill 目标

根据用户输入的商品和目标国家，自动寻找潜在进口商，并进一步获取企业及采购负责人的联系方式。

最终目标：帮助外贸业务员找到真实、有采购能力、可以直接联系的海外 B2B 客户。

## 2. 输入参数

- product：商品名称（必填）
- target_country：目标国家（必填）
- product_keywords：商品英文关键词、同义词
- hs_code：HS 编码（可选）
- buyer_type：客户类型（Importer / Distributor / Wholesaler / Retailer）
- limit：目标客户数量（默认 50）

示例：

product: Carbon Fiber Insoles
target_country: United States
product_keywords:
- Carbon Fiber Shoe Insoles
- Carbon Fiber Foot Orthotics
- Performance Insoles
- Carbon Fiber Footplates

## 3. 数据采集渠道

### A. Google Search

搜索企业：

- carbon fiber insoles importer USA
- carbon fiber insoles distributor USA
- carbon fiber footplates wholesale
- orthopedic insoles importer USA
- site:linkedin.com/company carbon fiber insoles

提取：
- 企业名称
- 官方网站
- 企业所在地
- 产品类型
- 企业简介
- 联系页面

### B. 海关进口数据

优先查询：

- ImportYeti
- Panjiva
- ImportGenius
- Volza
- 其他可用的贸易数据平台

重点获取：

- Importer Name
- Importer Address
- Supplier Name
- Supplier Country
- Shipment Date
- Product Description
- HS Code（如果有）
- Shipment Frequency
- Shipment Volume（如果有）

判断企业是否有真实进口记录。

注意：不同平台的数据覆盖范围不同，不能把搜索不到记录理解为没有进口记录。

### C. 企业官网联系方式

访问企业官网，优先检查：

- /contact
- /about
- /team
- /leadership
- /sales
- /wholesale
- /distributors

提取：

- 企业邮箱
- 销售邮箱
- 采购邮箱
- 联系电话
- WhatsApp
- 联系表单 URL
- 企业地址

### D. LinkedIn 联系人挖掘

搜索企业相关人员，优先级：

1. Purchasing Manager
2. Procurement Manager
3. Sourcing Manager
4. Supply Chain Manager
5. Category Manager
6. Product Manager
7. CEO / Founder / Owner

搜索示例：

site:linkedin.com/in "Company Name" Purchasing Manager

提取：

- 姓名
- 职位
- 所属公司
- LinkedIn 个人主页
- 工作地区

不得将推测出来的联系人身份当成已验证信息。

### E. 邮箱查找与验证

可使用：

- Apollo
- Hunter.io
- Snov.io
- Prospeo
- 企业官网公开邮箱

邮箱优先级：

1. 已验证的采购负责人工作邮箱
2. 官网公开的采购邮箱
3. 官网公开的销售邮箱
4. 企业通用邮箱（info@ / sales@）
5. 通过域名规则推测的邮箱（必须标记为未验证）

邮箱验证：

- Valid
- Invalid
- Accept-all
- Unknown

不能把邮箱格式正确等同于邮箱真实可用。

## 4. 客户筛选规则

排除：

- 纯个人消费者
- 无实际经营信息的企业
- 与目标商品无关的企业
- 明确只有生产能力、没有采购或分销业务的工厂（可另行归类为供应商）

优先：

- 有相关商品销售业务
- 有进口记录
- 有批发或经销业务
- 有多个销售渠道
- 有明确采购或供应链负责人

## 5. 客户评分模型（100分）

| 维度 | 分值 |
|---|---:|
| 商品匹配度 | 25 |
| 进口记录证据 | 25 |
| 企业业务匹配度 | 15 |
| 企业规模与渠道 | 10 |
| 联系人完整度 | 15 |
| 联系方式可信度 | 10 |

等级：

- A：80-100，优先开发
- B：65-79，重点跟进
- C：50-64，继续调查
- D：低于50，暂缓开发

无进口数据不能直接判定为低质量客户，应单独标记证据缺失。

## 6. 输出字段

每个进口商输出：

### 企业信息
- company_name
- website
- country
- city
- company_type
- business_description
- relevant_products

### 进口记录
- import_status
- supplier_names
- supplier_countries
- latest_shipment_date
- shipment_frequency
- product_description
- hs_code
- evidence_source
- evidence_url

### 联系方式
- contact_name
- contact_title
- contact_department
- business_email
- email_verification_status
- phone
- whatsapp
- linkedin_profile
- contact_page
- contact_source_url

### 客户分析
- match_score
- customer_level
- match_reason
- potential_needs
- recommended_sales_strategy
- data_confidence
- missing_information

## 7. 数据真实性要求

必须遵守：

1. 每个企业尽量提供官网来源。
2. 每个联系人必须有可追溯来源。
3. 每个邮箱必须标记验证状态。
4. 进口记录必须提供数据平台或公开来源证据。
5. 不允许编造采购记录、邮箱、电话号码和联系人。
6. 无法获取的数据填写 Unknown，不允许猜测。
7. 区分已验证信息、公开信息和推测信息。
8. 同一企业去重，保留多个来源。

## 8. 最终输出

生成 Excel 文件：

Sheet 1：进口商名单
Sheet 2：采购负责人联系方式
Sheet 3：进口记录
Sheet 4：客户评分与开发优先级

同时生成 Markdown 客户调查报告。

## 9. 推荐开发顺序

1. 搜索 100 家潜在进口商。
2. 筛选 50 家相关企业。
3. 深入调查 30 家企业。
4. 尽可能找到 20-30 位采购相关联系人。
5. 验证可用邮箱。
6. 根据客户匹配度生成英文开发信。
7. 输出优先开发名单。

## 10. 运行原则

这是一个多阶段调查 Skill，不是单纯的 Google 搜索。

必须先找到企业，再验证企业业务，再挖掘联系人，最后验证联系方式。

每条数据都要保留来源 URL 和证据状态。

不允许为了达到目标数量而填充虚假客户。