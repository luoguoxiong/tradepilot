# 05 · CRM 客户中心 · 页面字段与接口

| 项 | 内容 |
|---|---|
| 对应需求文档 | [05-CRM客户中心](../05-CRM客户中心.md) |
| 版本 | v0.4（2026-09-05，补齐页签字段对齐缺口与批量操作接口，见 §1.3/§2/§3.5）<br>v0.3（2026-09-05，明确 ownerId 默认/指派/转交规则与 owner_change 活动，见 §2/§4）<br>v0.2（2026-09-05，添加表单新增 `isFormal`，潜在/正式判定与升级规则见 §4）<br>v0.1（2026-09-04） |
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
| isFormal | boolean | — | 客户身份：false 潜在（默认）/ true 正式；成交自动升级见 §4 |
| stage | string | ✓ | 初始阶段，默认 `new_lead` |
| ownerId | string | ✓ | 负责人（默认当前用户）；转交仅经理/管理员可改，见 §4 |
| contacts | object[] | — | `[{ name, title, email }]` |
| remark | string | — | 备注 |

### 1.3 联系人页签 / 全部活动页签

- 联系人行：`contactId, name, title, email, customerId, companyName, decisionInfluencePct, isPrimary`
- 活动行：`activityId, type(stage_change/owner_change/email/quote/follow_up/note/ai_action), summary, customerId, operatorType(ai/user), operatorName, refType, refId, createdAt`

---

## 2. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/customers` | 客户列表（tab 区分潜在/正式） |
| POST | `/api/v1/customers` | 添加客户（手工录入） |
| GET | `/api/v1/customers/{id}` | 详情（复用 04） |
| PUT | `/api/v1/customers/{id}` | 编辑客户资料（改 `ownerId` 即转交，经理/管理员限定，见 §4） |
| POST | `/api/v1/customers/{id}/stage` | 推进客户阶段 |
| DELETE | `/api/v1/customers/{id}` | 删除客户 → 生成审批（customer_delete） |
| POST | `/api/v1/customers/batch-delete` | 批量删除（逐客户生成审批，见 §3.5） |
| POST | `/api/v1/customers/batch-owner` | 批量改派负责人（经理/管理员，见 §3.5） |
| GET | `/api/v1/contacts` | 联系人列表 |
| POST | `/api/v1/contacts` | 新增联系人 |
| PUT | `/api/v1/contacts/{id}` | 编辑联系人 |
| DELETE | `/api/v1/contacts/{id}` | 删除联系人（单条，见 §3.5） |
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

### 3.5 批量操作与联系人删除（FR-08，需求 §7 已澄清）

- `POST /api/v1/customers/batch-delete`：请求 `{ customerIds: ["cus_1", "cus_2"] }`；逐客户生成一条 `customer_delete` 审批并进入删除待审锁定态（同 §3.3），响应 `{ approvals: [{ customerId, approvalId }], failed: [{ customerId, reason }] }`；已锁定 / 已删除客户计入 `failed`。
- `POST /api/v1/customers/batch-owner`：请求 `{ customerIds: [...], ownerId }`；仅经理/管理员（业务员返回 `40301`）；逐客户更新 `ownerId` 并写 `owner_change` 活动（口径同 §4），响应 `{ updated: 2 }`。
- `DELETE /api/v1/contacts/{id}`：单条删除联系人；普通写操作（owner 权限内），不走审批、不写客户活动（与新增/编辑一致）。
- 边界：活动页签只读无批量操作；批量身份切换（转正式/潜在）与批量导出 v0.1 不做。

---

## 4. 联动与边界

- 「AI 建议重新激活」仅为 `nextAction` 建议，执行时创建 [07-AI自动跟进](./07-AI自动跟进.md) 策略，不自动发信。
- 阶段由人工或明确业务规则推进；AI 不得调用 `stage` 接口（权限层禁止 AI 身份调用）。
- 潜在/正式为客户身份（`isFormal`，默认 false 潜在），与 `stage` 解耦：负责人可在添加（1.2）或编辑客户（`PUT /customers/{id}`）时手工归属；P1 起报价标记成交（[09-报价中心](./09-报价中心.md) `mark-won`）自动升级为正式并写活动流水，不自动降级；AI 不得变更身份（需求 §7 已澄清）。
- 负责人（`ownerId`）规则（需求 §7 已澄清）：新建客户默认当前操作人；转交仅经理/管理员通过 `PUT /customers/{id}` 修改 `ownerId`，写 `owner_change` 活动流水，数据权限随新负责人即时切换；AI 不得变更归属；不设公海池。
- 批量操作（FR-08，需求 §7 已澄清）：批量删除逐客户生成 `customer_delete` 审批（高危边界对齐 [12-AI审核中心](./12-AI审核中心.md)）；批量改派仅经理/管理员；联系人仅单条删除；活动页签只读（见 §3.5）。
- 「发送报价」「发送开发信」分别跳转 [09-报价中心](./09-报价中心.md) / [06-AI销售工作台](./06-AI销售工作台.md)。
