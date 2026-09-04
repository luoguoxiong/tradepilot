# 01 · Dashboard 工作台 · 页面字段与接口

| 项 | 内容 |
|---|---|
| 对应需求文档 | [01-Dashboard工作台](../01-Dashboard工作台.md) |
| 版本 | v0.1（2026-09-04） |
| 页面 | 工作台 Dashboard（只读聚合视图） |

---

## 1. 页面区块与字段清单

### 1.1 顶部问候区（FR-01）

| 字段 | 类型 | 必填 | 说明 | 来源 |
|---|---|---|---|---|
| greeting | string | ✓ | 问候语，如「下午好，欢迎回来」 | 前端按时间生成 |
| date | string | ✓ | 当天日期 | 前端 |
| onlineEmployeeCount | number | ✓ | 在线 AI 员工数（status ∈ working/waiting_approval） | 接口 |
| onlineEmployeeTotal | number | ✓ | AI 员工总数 | 接口 |
| dailyReport | object | — | 「AI 每日报告」入口：`{ reportId, status }` | 接口 |

### 1.2 KPI 卡片组（FR-02）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| metric | string | ✓ | `new_customers` 新客户 / `new_inquiries` 新询盘 / `new_quotes` 新报价 / `estimated_revenue` 预计成交额 |
| value | number\|string | ✓ | 数值；`estimated_revenue` 为金额（配 `currency`） |
| currency | string | — | 金额类 KPI 的币种，默认 USD |
| changePct | number | ✓ | 环比变化百分比，如 20 表示 ↑20% |
| trend | string | ✓ | `up` / `down` / `flat` |
| comparePeriod | string | ✓ | 环比基准（如 `vs_last_week`） |

### 1.3 AI 员工工作状态区（FR-03）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| employeeId | string | ✓ | 员工 ID |
| name / role | string | ✓ | 名称 / 角色（02 模块定义） |
| status | string | ✓ | employeeStatus 枚举（语义色） |
| currentAction | string | ✓ | 正在做什么，如「正在寻找美国跑鞋品牌」 |
| todayOutput | object | ✓ | `{ label: "今日找到客户", count: 28, unit: "个" }` |
| waitingApprovalCount | number | — | 等待审核任务数（🟡 时展示） |

### 1.4 高价值客户榜（FR-04）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| customerId | string | ✓ | 跳转客户 360° |
| companyName | string | ✓ | 客户名 |
| score | number | ✓ | 评分百分比 |
| country | string | — | 国旗展示 |

### 1.5 今日待处理（FR-05）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| type | string | ✓ | `quote_approval` 报价待审核 / `high_value_overdue` 高价值客户超期未联系 / `customer_reply` 客户新回复 / `order_delay_risk` 订单延期风险 |
| count | number | ✓ | 数量 |
| level | string | ✓ | 语义色：`danger` 🔴 / `warning` 🟡 / `info` 🔵 |
| link | string | ✓ | 跳转目标（报价中心 / CRM / 收件箱 / 订单中心） |

---

## 2. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/dashboard/summary` | 首屏聚合（1.1～1.5 一次返回） |
| GET | `/api/v1/dashboard/daily-report` | 获取最新 AI 每日报告 |
| POST | `/api/v1/dashboard/daily-report/generate` | 触发生成 AI 每日报告（异步任务） |

---

## 3. 接口详细定义

### 3.1 GET /api/v1/dashboard/summary

请求参数：无（默认今日；预留 `date` 查询参数）

响应 `data`：

```json
{
  "greeting": { "onlineEmployeeCount": 5, "onlineEmployeeTotal": 6 },
  "kpis": [
    { "metric": "new_customers", "value": 28, "changePct": 20, "trend": "up", "comparePeriod": "vs_last_week" },
    { "metric": "new_inquiries", "value": 8, "changePct": 15, "trend": "up", "comparePeriod": "vs_last_week" },
    { "metric": "new_quotes", "value": 12, "changePct": 8, "trend": "up", "comparePeriod": "vs_last_week" },
    { "metric": "estimated_revenue", "value": "18500.00", "currency": "USD", "changePct": 32, "trend": "up", "comparePeriod": "vs_last_week" }
  ],
  "aiEmployees": [
    { "employeeId": "emp_1", "name": "AI 获客员工", "role": "lead_hunter", "status": "working",
      "currentAction": "正在寻找美国跑鞋品牌", "todayOutput": { "label": "今日找到客户", "count": 28, "unit": "个" } },
    { "employeeId": "emp_3", "name": "AI 跟进员工", "role": "follow_up", "status": "waiting_approval",
      "currentAction": "等待 3 个任务审核", "todayOutput": { "label": "今日跟进", "count": 8, "unit": "个" }, "waitingApprovalCount": 3 }
  ],
  "highValueCustomers": [
    { "customerId": "cus_1", "companyName": "ABC Sports", "score": 92, "country": "US" }
  ],
  "pendingItems": [
    { "type": "quote_approval", "count": 3, "level": "danger", "link": "/quotes?status=waiting_approval" },
    { "type": "high_value_overdue", "count": 5, "level": "warning", "link": "/crm?overdue=7d" },
    { "type": "customer_reply", "count": 2, "level": "warning", "link": "/inbox?unread=true" },
    { "type": "order_delay_risk", "count": 1, "level": "danger", "link": "/orders?risk=at_risk" }
  ],
  "dailyReport": { "reportId": "rpt_9", "status": "ready" }
}
```

### 3.2 GET /api/v1/dashboard/daily-report

响应 `data`：`{ reportId, period, status, content（Markdown）, generatedAt, citations[] }`；无报告时 `code=40401`。

### 3.3 POST /api/v1/dashboard/daily-report/generate

请求：`{ period: "daily" | "weekly" }`；响应：`{ taskId }`（异步任务，见 [00-总览 §4.3](./00-总览与接口规范.md)）。

---

## 4. 联动与边界

- 本页全部接口为**只读聚合**，不提供业务写操作；待办处理跳转各模块完成。
- 数据口径依赖：02/14（员工状态与产出）、05/04（客户与评分）、06/07（询盘与回复）、09（报价）、10（订单）。
- `estimated_revenue` 为估算值，前端需标注「预计」。
