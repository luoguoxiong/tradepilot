# 前端技术方案：智能客户开发（design-v1）

- 对应 PRD：prod/customer-prospecting/prd.md v1.1
- UI 原型：prod/customer-prosotyping/prototype.html（界面以原型为准）
- 日期：2026-09-03

## 1. 技术选型

- Vue 3 + TypeScript + Vite + Element Plus + Vue Router + Pinia（轻量使用）
- 构建：`web/`（Vite dev 5173，proxy `/api` → `http://localhost:8787`）

## 2. 页面结构（对应原型 5 步）

| 路由 | 页面 | 对应原型 |
|------|------|---------|
| /profiles | 产品档案管理（列表+编辑抽屉，支持多档案切换） | ① |
| /prospecting | 找客户：自动搜索（主通道，含 provider 选择、query 预览、候选勾选）+ 粘贴导入（备用，弱化卡片） | ② |
| /leads | 线索列表：KPI 卡（总数/A级/B级/失败）+ 评分排序表格 + 批量确认/导出 + 状态列与重试 | ③ |
| /leads/:id | 客户报告详情：左侧评分卡（总分+维度权重条），右侧证据链事实（每条带来源链接）+ 确认开发按钮 | ④ |
| /leads/:id/email | 开发信：标题候选单选、正文可编辑（contenteditable/textarea）、合规自检提示、复制/导出 .eml/重新生成/切换语种 | ⑤ |

布局：顶栏（logo + 产品档案切换下拉）+ 左侧步骤导航或面包屑；紧凑风格。

## 3. 与后端交互

- 统一响应 `{code,message,data}`；axios 封装拦截器（非 0 code → ElMessage.error）
- 任务进行中轮询 `GET /api/tasks` 与 `GET /api/leads?status=`（1.5s，页面可见时）
- AI 生成按钮防重复点击（loading + 禁用）
- AI 输出三原则落地：开发信**可编辑**（textarea 绑定）、**可追溯**（报告详情展示 sources 链接）、复制为纯文本

## 4. 目录结构

```text
web/
├── src/
│   ├── main.ts / App.vue / router.ts
│   ├── api/client.ts        # axios 实例 + 类型定义
│   ├── stores/profile.ts    # 当前档案（localStorage 持久化）
│   └── views/{Profiles,Prospecting,Leads,LeadDetail,EmailView}.vue
├── docs/customer-prospecting/design-v1.md
└── package.json / vite.config.ts / tsconfig.json
```
