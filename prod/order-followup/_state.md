# 工作流状态

- 需求原文：二期开发「AI 外贸跟单助理」：自动读取客户订单、自动生成PI（形式发票）、自动跟踪订单进度、自动提醒工厂交期、自动催货、自动生成装箱单和Invoice、自动给客户发送订单进度邮件、自动整理异常订单
- 需求澄清结论（2026-09-04）：订单来源=文件上传+AI解析；邮件=生成+确认+SMTP发送；进度=手动更新+系统提醒；用户=一线业务员/SOHO 单账号
- feature 目录：order-followup
- 当前阶段：gate2
- 迭代轮次：v1
- 阶段历史：
  - [{阶段: phase1, 完成时间: 2026-09-04, 产物: prod/order-followup/diagnosis.md, prod/order-followup/prd.md}]
  - [{阶段: phase2, 完成时间: 2026-09-04, 产物: server/docs/order-followup/design-v1.md, web/docs/order-followup/design-v1.md, server/src/order-routes.ts 及 services/prompts/views 代码}]
- skip-gates: false
