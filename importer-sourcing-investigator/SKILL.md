---
name: importer-sourcing-investigator
description: 调查指定海外进口商的进出口记录、进口来源国家、供应商、采购商品、贸易频率及潜在供应链机会。适用于外贸客户背景调查、竞品供应链分析和进口商采购行为分析。
---

# Importer Sourcing Investigator

## 1. Skill 目标

输入一个进口商、品牌或企业名称，调查其历史进口记录，重点回答：

1. 进口商从哪些国家采购？
2. 主要供应商有哪些？
3. 每个供应商来自哪个国家？
4. 进口了哪些产品？
5. 产品的 HS Code 是什么？
6. 采购频率、数量、重量和金额如何变化？
7. 是否存在中国供应商？
8. 是否有其他潜在供应商可以开发？
9. 是否存在可以切入的产品采购机会？

核心目标：通过公开贸易数据还原进口商的供应链结构，帮助外贸业务员找到潜在采购需求。

## 2. 输入参数

支持以下输入：

```json
{
  "company_name": "VKTRY",
  "country": "United States",
  "product_keywords": [
    "carbon fiber insole",
    "sports insole",
    "orthotic insole"
  ],
  "date_range": "last_5_years",
  "target_country": "China"
}
```

字段说明：

- company_name：进口商名称，必填。
- country：进口商所在国家。
- product_keywords：关注的产品关键词，可选。
- date_range：调查时间范围，默认近 5 年。
- target_country：重点关注的供应商国家，默认 China。

如果只有公司名称，也必须能够执行调查。

## 3. 数据来源

优先使用以下数据平台：

### 第一梯队：美国海关提单数据

1. ImportYeti
   https://www.importyeti.com/

   重点获取：
   - Importer
   - Shipper
   - Supplier
   - Shipment Date
   - Product Description
   - Port of Loading
   - Port of Arrival
   - Shipment Count

2. ImportKey
   https://www.importkey.com/

   重点获取：
   - Importer Profile
   - Supplier Relationships
   - Shipment Records
   - Product Descriptions
   - Trade History

3. ImportGenius
   https://www.importgenius.com/

   重点获取：
   - Bill of Lading
   - Shipper
   - Consignee
   - Cargo Description
   - Quantity
   - Weight
   - Shipment Date

4. Trademo
   https://www.trademo.com/

   重点获取：
   - Importer Profile
   - Exporter Profile
   - Trade Partners
   - Trade Value
   - Shipment Volume
   - HS Code
   - Country of Origin（如有披露）

### 第二梯队：其他贸易数据

- Panjiva：https://panjiva.com/
- Volza：https://www.volza.com/
- TradeAtlas：https://www.tradeatlas.com/

用于交叉验证供应商、商品及贸易关系。

### 第三梯队：企业信息核实

- Google Search
- 企业官网
- LinkedIn
- OpenCorporates
- 公司注册信息
- 企业新闻及供应商介绍

用于确认企业真实身份、名称别名、经营范围和供应商背景。

注意：
不得假设上述平台全部免费或均可自动访问。优先使用可公开访问的数据；需要账号、付费订阅或 API Key 时，明确说明。

## 4. 调查执行流程

### Step 1：进口商身份识别

先搜索企业名称及别名。

搜索关键词：

```text
"VKTRY"
"VKTRY Gear"
"ROAR ATHLETIC PERFORMANCE"
"VKTRY USA"
```

重点识别：

- 品牌名称
- 法律注册名称
- DBA 名称
- 母公司
- 子公司
- 历史公司名称
- 公司地址
- 企业官网

建立 Importer Alias List。

注意：
不能仅凭名称相似就将两家企业认定为同一进口商。

### Step 2：搜索进口记录

在各贸易数据平台搜索：

```text
Importer: COMPANY_NAME
Consignee: COMPANY_NAME
Company Alias: ALIAS_NAME
```

收集所有可访问的进口记录。

记录字段：

```json
{
  "importer": "",
  "shipper": "",
  "supplier": "",
  "shipment_date": "",
  "product_description": "",
  "hs_code": "",
  "origin_country": "",
  "port_of_loading": "",
  "port_of_arrival": "",
  "quantity": "",
  "weight": "",
  "trade_value": "",
  "bill_of_lading": "",
  "source": "",
  "source_url": ""
}
```

没有披露的字段必须留空，不允许自行推断。

### Step 3：供应商国家识别

对每个供应商进行企业背景调查。

搜索：

```text
"SUPPLIER_NAME" company
"SUPPLIER_NAME" factory
"SUPPLIER_NAME" manufacturer
"SUPPLIER_NAME" country
"SUPPLIER_NAME" official website
```

重点确认：

- 供应商注册地址
- 实际生产所在地
- 企业官网
- 经营范围
- 生产产品
- 是否为制造商
- 是否为贸易商

区分三个概念：

1. Supplier Country：供应商注册或经营所在国家。
2. Country of Origin：货物原产国。
3. Port of Loading：货物装货港所在地点。

不能将装货港直接等同于原产国。

### Step 4：进口产品分类

对 Product Description 进行清洗和分类。

例如：

```text
CARBON FIBER INSOLE
SPORTS INSOLE
PU INSOLE
EVA INSOLE
ORTHOTIC INSOLE
EVA CLOG
ANKLE SLEEVE
GIFT BOX
PACKAGING MATERIAL
```

按照产品类别进行归类：

- 成品
- 半成品
- 原材料
- 零部件
- 包装材料
- 其他商品

特别注意：

货物描述可能存在缩写、错误或模糊表达。

例如：

BOTTOM BOARD 不一定代表碳纤维鞋垫底板，必须结合其他货物描述、供应商业务及产品资料判断。

### Step 5：采购频率和趋势分析

按供应商统计：

- 总提单数
- 首次采购时间
- 最近采购时间
- 年度采购次数
- 商品种类
- 总重量
- 总金额（仅在数据可用时）
- 采购趋势

生成供应商排名：

| Supplier | Country | Shipments | Products | Last Shipment |
|---|---|---:|---|---|

分析：

1. 哪些供应商是长期合作伙伴？
2. 哪些供应商是新进入的？
3. 哪些供应商采购频率下降？
4. 哪些国家占主要进口来源？
5. 是否有中国供应商？
6. 是否有多个供应商供应相同产品？

不能将提单数量直接等同于订单数量。

### Step 6：中国供应链机会识别

重点寻找：

- 已有中国供应商
- 同类产品中国供应商
- 中国制造商是否具备替代能力
- 是否存在多供应商采购
- 是否存在新产品采购线索
- 是否有可以切入的 OEM / ODM 机会

分析中国供应商时，重点判断：

- 是否为工厂
- 是否为贸易商
- 是否具备相关产品生产能力
- 是否有官方网站
- 是否有其他海外客户
- 是否有相同产品出口记录

### Step 7：竞争供应商分析

对进口商现有供应商进行分类：

| 类型 | 定义 |
|---|---|
| 核心供应商 | 长期、多次供应 |
| 新供应商 | 最近才出现 |
| 替代供应商 | 供应相同产品 |
| 配套供应商 | 提供包装、配件等 |
| 潜在竞争者 | 可能争夺同一采购订单 |

分析是否存在切入机会。

### Step 8：潜在客户开发建议

根据采购记录，输出：

- 建议开发的产品
- 建议联系的采购部门
- 目标联系人职位
- 产品差异化切入点
- 建议报价策略
- 开发信切入角度
- 需要进一步确认的问题

不要把历史进口行为直接认定为当前采购需求。

## 5. 输出报告格式

最终输出中文调查报告。

### 一、企业基本信息

| 字段 | 内容 |
|---|---|
| 企业名称 | |
| 品牌名称 | |
| 所在国家 | |
| 官网 | |
| 经营范围 | |
| 企业别名 | |

### 二、进口来源国家分析

| 国家 | 供应商数量 | 提单数量 | 主要商品 |
|---|---:|---:|---|
| China | | | |
| Vietnam | | | |
| India | | | |
| Other | | | |

说明统计口径和数据覆盖范围。

### 三、供应商名单

| 供应商 | 国家 | 采购产品 | 提单数 | 最近采购日期 |
|---|---|---|---:|---|

### 四、重点贸易记录

| 日期 | 进口商 | 供应商 | 商品描述 | HS Code | 重量 |
|---|---|---|---|---|---|

### 五、采购趋势

分析近 1 年、3 年、5 年的采购趋势。

如果数据不完整，必须标记为样本趋势，不能代表企业全部采购。

### 六、中国供应商分析

逐家列出：

- 公司名称
- 官网
- 国家及地区
- 产品
- 工厂能力
- 与进口商的贸易关系
- 证据来源

### 七、供应链机会

明确指出：

- 已确认的供应链关系
- 有证据支持的采购行为
- 尚未验证的推测
- 潜在供应链替代机会

### 八、客户开发建议

输出可执行的业务方案：

- 推荐销售产品
- 建议联系职位
- 产品卖点
- 开发信方向
- 后续跟进计划

### 九、数据来源及可信度

每条关键结论必须附带：

- 数据平台
- 原始页面 URL
- 提单日期
- 相关企业
- 数据可信度

可信度分级：

A：原始提单或官方记录可验证。

B：两个独立贸易数据平台交叉验证。

C：单个平台的企业档案或汇总数据。

D：企业官网或其他间接线索。

推测性结论必须单独标记。

## 6. 调查规则

1. 不允许虚构海关记录。
2. 不允许编造供应商名称。
3. 不允许将装货港当作原产国。
4. 不允许将货物描述中的模糊词语直接认定为目标产品。
5. 不允许将同一提单的重复展示计算为多票。
6. 不允许将贸易金额汇总数据当作精确采购金额。
7. 不允许将供应商官网合作声明当作已验证的具体采购订单。
8. 对不同平台的数据进行去重。
9. 关键数据尽量交叉验证。
10. 无法访问的数据必须明确标记为未获取。
11. 区分历史采购与当前采购需求。
12. 所有重要结论必须保留可追溯的来源链接。

## 7. 最终目标

不仅仅是调查一个进口商从哪里进货。

还要帮助外贸业务员回答：

- 这个进口商正在向谁采购？
- 从哪些国家采购？
- 采购什么产品？
- 有没有中国供应商？
- 我能不能成为它的新供应商？
- 我应该卖什么给它？
- 我应该联系谁？
- 下一步应该怎么开发？

最终输出一份可以直接指导 B2B 客户开发的供应链调查报告。