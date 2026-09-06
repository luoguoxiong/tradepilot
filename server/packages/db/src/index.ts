/**
 * @tradepilot/db —— Drizzle schema、迁移、RLS 策略、种子（后端技术方案 02）。
 * M2 数据层与认证授权里程碑实现：
 * - schema/ 按业务域拆分（ER 00~08 全量 46 表 + llm_call 增补）
 * - withOrg 事务注入（RLS 双保险 fail-closed）
 * - 三 DB 角色（tradepilot_app / tradepilot_sched / tradepilot_migrate）
 * - seed/（默认角色权限、默认跟进策略、6 员工 SOP、ai_model_setting）
 */
export {};
