# 05 · CRM 客户中心 · 页面字段与接口

| 项 | 内容 |
|---|---|
| 对应需求文档 | [05-CRM客户中心](../05-CRM客户中心.md) |
| 版本 | v0.1（2026-09-04） |
| 页面 | 客户列表（四页签）、添加客户表单 |

---

## 1. 页面区块与字段清单

### 1.1 客户列表行（FR-04～06）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| customerId | string | ✓ | 跳转客户 360° |
| companyName | string | ✓ | 客户名 |
| stage | string | ✓ | customerStage 枚举（语义色 🔵🟡🟢🔴） |
| lastActivityAt | string | ✓ | 最近活动时间（相对时间展示） |
| nextAction | object | — | `{ type: "send_quote" | "follow_up" | "send_outreach" | "reactivate_ai", label: "发送报价" / "Follow-up #2" / "发送开发信" / "AI 建议重新激活" }` |
| country / ownerId | string | — | 筛选字段 |
| reactivateSuggestion | object | — | Cold 客户的 AI 重新激活建议（Insight Schema） |

筛选：`tab`（potential / formal / contacts / activities）、`keyword`、`country`、`stage`、`ownerId`、`overdueDays`（超期未联系）。

### 1.2 添加客户表单（FR-03）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| companyName | string | ✓ | 公司名 |
| country | string | ✓ | 国家 |
| website | string | — | 官网 |
| industry | string | — | 行业 |
| customerType | string | — | Brand / Distributor / Factory / Other |
| stage | string | ✓ | 初始阶段，默认 `new_lead` |
| ownerId | string | ✓ | 负责人（默认当前用户） |
| contacts | object[] | — | `[{ name, title, email }]` |
| remark | string | — | 备注 |

### 1.3 联系人页签 / 全部活动页签

- 联系人行：`contactId, name, title, email, customerId, companyName, decisionInfluencePct`
- 活动行：`activityId, type(stage_change/email/quote/follow_up/note/ai_action), summary, customerId, operatorType(ai/user), operatorName, createdAt`

---

## 2. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/customers` | 客户列表（tab 区分潜在/正式） |
| POST | `/api/v1/customers` | 添加客户（手工录入） |
| GET | `/api/v1/customers/{id}` | 详情（复用 04） |
| PUT | `/api/v1/customers/{id}` | 编辑客户资料 |
| POST | `/api/v1/customers/{id}/stage` | 推进客户阶段 |
| DELETE | `/api/v1/customers/{id}` | 删除客户 → 生成审批（customer_delete） |
| GET | `/api/v1/contacts` | 联系人列表 |
| POST | `/api/v1/contacts` | 新增联系人 |
| PUT | `/api/v1/contacts/{id}` | 编辑联系人 |
| GET | `/api/v1/activities` | 活动列表（全局时间线） |

---

## 3. 接口详细定义

### 3.1 GET /api/v1/customers

请求参数：`tab(potential|formal)`、`keyword`、`country`、`stage`、`ownerId`、`scope(self|team|all)`、`overdueDays`、分页。

响应 `data.items[]`：1.1 字段。示例：

```json
{ "customerId": "cus_1", "companyName": "ABC Sports", "stage": "negotiation",
  "lastActivityAt": "2026-09-04T14:30:00Z",
  "nextAction": { "type": "send_quote", "label": "发送报价" } }
```

### 3.2 POST /api/v1/customers/{id}/stage

请求：`{ stage: "contacted", reason?: "首次邮件回复" }`

响应：`{ customerId, stage, activityId }`（自动写入 `stage_change` 活动）。

校验：仅允许沿阶段机正向流转或回退到 `contacted`；非法流转返回 `40901`。

### 3.3 DELETE /api/v1/customers/{id}

响应（不直接删除）：

```json
{ "approvalId": "appr_88", "approvalType": "customer_delete", "status": "pending" }
```

客户进入「删除待审」锁定态，审批拒绝后自动解锁（见 [12-AI审核中心](./12-AI审核中心.md)）。

### 3.4 GET /api/v1/activities

请求参数：`customerId`、`type`、`startDate/endDate`、`operatorType(ai|user)`、分页。响应 `items[]`：1.3 活动行字段。

---

## 4. 联动与边界

- 「AI 建议重新激活」仅为 `nextAction` 建议，执行时创建 [07-AI自动跟进](./07-AI自动跟进.md) 策略，不自动发信。
- 阶段由人工或明确业务规则推进；AI 不得调用 `stage` 接口（权限层禁止 AI 身份调用）。
- 潜在/正式判定规则待澄清（首次成交自动升级），v0.1 先用 `tab` + `customerType` 区分。
- 「发送报价」「发送开发信」分别跳转 [09-报价中心](./09-报价中心.md) / [06-AI销售工作台](./06-AI销售工作台.md)。
