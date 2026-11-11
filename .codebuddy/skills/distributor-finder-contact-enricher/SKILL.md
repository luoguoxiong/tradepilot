---
name: distributor-finder-contact-enricher
description: 根据商品和目标国家寻找潜在海外分销商（Distributor/经销商/批发商），通过 Google 搜索、品牌授权目录反查、行业目录（ThomasNet/Kompass/Europages 等）、海关进口数据、企业官网与 LinkedIn 挖掘经销证据与品类/采购负责人联系方式，按匹配度评分并输出 Excel 客户名单与 Markdown 调查报告。当用户要求找海外分销商、经销商、代理、分销渠道客户、Distributor 名单或获取其联系方式时使用本技能。
---

# Global Distributor Finder & Contact Enrichment

## 1. Skill 目标

根据用户输入的商品和目标国家，寻找目标市场上经销同类商品的分销商（Distributor），并获取企业与品类/采购负责人的联系方式。

最终目标：帮助外贸业务员找到在目标市场有分销网络、能把产品铺进本地渠道的 B2B 经销客户。

与 `importer-finder-contact-enricher` 的关系：Importer 以"进口记录"为核心证据；本 Skill 以"经销关系与分销渠道"为核心证据。同一企业可能既是 importer 又是 distributor，两类证据都收集，按本 Skill 的评分口径计分。

## 2. 输入参数

- product：商品名称（必填）
- target_country：目标国家（必填）
- product_keywords：商品英文关键词、同义词
- hs_code：HS 编码（可选）
- target_brands：希望对标或替代的竞品品牌，用于反查其授权分销商（可选）
- distributor_type：目标分销商类型（Exclusive / Master / Regional / Wholesale / Value-Added / Retail chain / E-commerce）（可选）
- limit：目标客户数量（默认 50）

示例：

product: Carbon Fiber Insoles
target_country: United States
product_keywords:
- Carbon Fiber Shoe Insoles
- Carbon Fiber Foot Orthotics
- Performance Insoles
- Carbon Fiber Footplates
target_brands:
- VKTRY

## 3. 数据采集渠道

### A. Google Search

搜索企业：

- carbon fiber insoles distributor USA
- carbon fiber insoles wholesale supplier USA
- carbon fiber insoles <city/state> distributor
- authorized distributor <target_brand> USA
- carbon fiber insoles "become a distributor"（竞品招商页可反映经销市场格局）
- site:linkedin.com/company carbon fiber insoles distributor

提取：
- 企业名称
- 官方网站
- 企业所在地
- 经销角色声明（distributor / wholesale / agent）
- 产品线
- 企业简介
- 联系页面

### B. 品牌授权与经销目录反查（本 Skill 特色渠道）

大量品牌官网提供 Where to Buy / Distributor Locator / Find a Dealer / Our Partners 页面，列出授权分销商：

- 从 target_brands 及同类头部品牌官网反查授权分销商名单
- 品牌官网的 Become a Distributor 页面可判断该品类是否仍在招商
- 行业协会会员名录、相关展会 Exhibitor List 参展商目录

注意：目录信息可能过时，必须回访企业官网核实后再纳入名单。

### C. 行业与商业目录

可使用：

- ThomasNet（美国）
- Kompass
- Europages
- 各国 Yellow Pages
- 品类专业行业目录

提取：
- 企业类型（Distributor / Wholesaler / Agent / Retailer）
- 员工规模
- 覆盖区域
- 产品类别

### D. 海关进口数据

分销商经常自行进口（尤其独家/区域总代），优先查询：

- ImportYeti
- Panjiva
- ImportGenius
- Volza
- 其他可用的贸易数据平台

重点获取：

- Distributor Name
- Distributor Address
- Supplier Name
- Supplier Country
- Shipment Date
- Product Description
- HS Code（如果有）
- Shipment Frequency
- Shipment Volume（如果有）

有进口记录的分销商同时具备 importer 属性，开发价值更高（可直供）。
注意：搜索不到记录不能理解为没有进口记录。

### E. 企业官网核实（关键步骤）

访问企业官网，优先检查：

- /distributors
- /distribution
- /become-a-distributor
- /partners
- /brands
- /our-brands
- /products
- /catalog
- /wholesale
- /where-to-buy
- /contact
- /about
- /team

判断并提取：

- 是否声明 distributor / wholesale / agent 角色
- 经销的品牌与产品线（brands carried）
- 是否有经销授权（authorized / official / exclusive distributor）
- 覆盖区域（country / region / state）
- 销售渠道（线下网点、门店、e-commerce、catalog、B2B portal）
- 经销商门槛（MOQ、申请条件），用于判断该企业是否开放引进新品
- 企业邮箱
- 销售邮箱
- 采购邮箱
- 联系电话
- WhatsApp
- 联系表单 URL
- 企业地址

### F. LinkedIn 联系人挖掘

分销商决定"引进什么货"的人通常是品类/买手，优先级：

1. Category Manager
2. Category Buyer
3. Buyer / Merchandiser
4. Product Manager
5. Business Development Manager
6. Purchasing Manager / Sourcing Manager（对自采进口型分销商）
7. Sales Director / Commercial Director
8. Managing Director / CEO / Founder / Owner

搜索示例：

site:linkedin.com/in "Company Name" Category Manager

提取：

- 姓名
- 职位
- 所属公司
- LinkedIn 个人主页
- 工作地区

不得将推测出来的联系人身份当成已验证信息。

### G. 邮箱查找与验证

可使用：

- Apollo
- Hunter.io
- Snov.io
- Prospeo
- 企业官网公开邮箱

邮箱优先级：

1. 已验证的品类/采购负责人工作邮箱
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
- 明确只有生产能力、没有分销业务的工厂（可另行归类为供应商）
- 单一品牌直营零售店、无中间商角色的品牌直营电商（除非用户明确要零售渠道）

优先：

- 官网或目录明确有 distributor / wholesale / agent 角色
- 经销同类或互补产品线
- 有品牌授权或区域代理身份
- 有自有进口记录
- 渠道多元（线下网点 + 线上 + 目录）
- 有明确品类、采购或商务拓展负责人

## 5. 客户评分模型（100分）

| 维度 | 分值 |
|---|---:|
| 商品线匹配度（经销同类/互补产品） | 25 |
| 分销角色证据（distributor/wholesale/agent 声明与授权） | 20 |
| 分销渠道与区域覆盖 | 15 |
| 进口/采购证据（海关记录、直接进口能力） | 15 |
| 联系人完整度 | 15 |
| 联系方式可信度 | 10 |

等级：

- A：80-100，优先开发
- B：65-79，重点跟进
- C：50-64，继续调查
- D：低于50，暂缓开发

无进口数据不能直接判定为低质量客户，应单独标记证据缺失；仅有第三方目录信息、无官网的企业降低 data_confidence。

## 6. 输出字段

每个分销商输出：

### 企业信息
- company_name
- website
- country
- city
- company_type
- business_description
- relevant_products

### 分销证据
- distributor_role
- authorized_status
- brands_carried
- product_lines
- coverage_area
- sales_channels
- catalogue_url
- evidence_source
- evidence_url

### 进口/采购记录
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
4. 分销角色与授权状态必须提供官网、目录或数据平台来源证据。
5. 进口记录必须提供数据平台或公开来源证据。
6. 不允许编造经销品牌、采购记录、邮箱、电话号码和联系人。
7. 无法获取的数据填写 Unknown，不允许猜测。
8. 区分已验证信息、公开信息和推测信息。
9. 同一企业去重，保留多个来源。

## 8. 最终输出

生成 Excel 文件：

Sheet 1：分销商名单
Sheet 2：品类/采购负责人联系方式
Sheet 3：分销证据与经销品牌线
Sheet 4：进口记录（如有）
Sheet 5：客户评分与开发优先级

同时生成 Markdown 客户调查报告。

## 9. 推荐开发顺序

1. 搜索 100 家潜在分销商（含品牌授权目录反查）。
2. 筛选 50 家相关企业。
3. 深入核实 30 家企业官网与海关数据。
4. 尽可能找到 20-30 位品类/采购/商务拓展相关联系人。
5. 验证可用邮箱。
6. 根据客户匹配度生成英文开发信（切入角度：为其分销线提供新品或补充货源）。
7. 输出优先开发名单。

## 10. 运行原则

这是一个多阶段调查 Skill，不是单纯的 Google 搜索。

必须先找到企业，再验证经销角色与产品线，再挖掘联系人，最后验证联系方式。

Distributor 的核心验证对象是"经销关系与分销渠道"，进口记录是加分证据；两者都缺失时标记 evidence_gap，不强行归类。

每条数据都要保留来源 URL 和证据状态。

不允许为了达到目标数量而填充虚假客户。
