/**
 * 全局枚举注册表（01 §6：枚举统一走 enum-map；03 §7 dictStore 数据源）。
 * labelKey 为 i18n key（locales/enums.*）；color 引用 Design Tokens 语义色（04 §1）。
 */
export interface EnumOption<V extends string = string> {
  value: V
  labelKey: string
  color?: string
}

/** 客户阶段（接口规范 §3.3 / Design Tokens 阶段色） */
export const CUSTOMER_STAGES = ['new_lead', 'contacted', 'negotiation', 'cold'] as const
export type CustomerStage = (typeof CUSTOMER_STAGES)[number]

export const ENUMS = {
  memberRole: [
    { value: 'admin', labelKey: 'enums.memberRole.admin' },
    { value: 'manager', labelKey: 'enums.memberRole.manager' },
    { value: 'sales', labelKey: 'enums.memberRole.sales' },
  ],
  memberStatus: [
    { value: 'active', labelKey: 'enums.memberStatus.active', color: 'var(--ai-working)' },
    { value: 'invited', labelKey: 'enums.memberStatus.invited', color: 'var(--ai-waiting)' },
    { value: 'disabled', labelKey: 'enums.memberStatus.disabled', color: 'var(--ai-idle)' },
  ],
  mailboxProvider: [
    { value: 'gmail', labelKey: 'enums.mailboxProvider.gmail' },
    { value: 'outlook', labelKey: 'enums.mailboxProvider.outlook' },
    { value: 'smtp_imap', labelKey: 'enums.mailboxProvider.smtpImap' },
  ],
  mailboxStatus: [
    { value: 'connected', labelKey: 'enums.mailboxStatus.connected', color: 'var(--ai-working)' },
    { value: 'error', labelKey: 'enums.mailboxStatus.error', color: 'var(--ai-risk)' },
    {
      value: 'disconnected',
      labelKey: 'enums.mailboxStatus.disconnected',
      color: 'var(--ai-idle)',
    },
  ],
  /** AI 模型类型（16 FR-10 扩展） */
  aiModelType: [
    { value: 'llm', labelKey: 'enums.aiModelType.llm' },
    { value: 'embedding', labelKey: 'enums.aiModelType.embedding' },
  ],
  /** AI 模型提供方（16 FR-10 扩展） */
  aiModelProvider: [
    { value: 'openai', labelKey: 'enums.aiModelProvider.openai' },
    { value: 'anthropic', labelKey: 'enums.aiModelProvider.anthropic' },
    { value: 'deepseek', labelKey: 'enums.aiModelProvider.deepseek' },
    { value: 'azure', labelKey: 'enums.aiModelProvider.azure' },
    { value: 'mock', labelKey: 'enums.aiModelProvider.mock' },
  ],
  customerStage: [
    {
      value: 'new_lead',
      labelKey: 'enums.customerStage.newLead',
      color: 'var(--tp-stage-new-lead)',
    },
    {
      value: 'contacted',
      labelKey: 'enums.customerStage.contacted',
      color: 'var(--tp-stage-contacted)',
    },
    {
      value: 'negotiation',
      labelKey: 'enums.customerStage.negotiation',
      color: 'var(--tp-stage-negotiation)',
    },
    { value: 'cold', labelKey: 'enums.customerStage.cold', color: 'var(--tp-stage-cold)' },
  ],
  approvalStatus: [
    { value: 'pending', labelKey: 'enums.approvalStatus.pending', color: 'var(--ai-waiting)' },
    { value: 'approved', labelKey: 'enums.approvalStatus.approved', color: 'var(--ai-working)' },
    {
      value: 'edited_approved',
      labelKey: 'enums.approvalStatus.editedApproved',
      color: 'var(--ai-working)',
    },
    { value: 'rejected', labelKey: 'enums.approvalStatus.rejected', color: 'var(--ai-risk)' },
    { value: 'expired', labelKey: 'enums.approvalStatus.expired', color: 'var(--ai-idle)' },
    {
      value: 'auto_approved',
      labelKey: 'enums.approvalStatus.autoApproved',
      color: 'var(--ai-scheduled)',
    },
  ],
  /** 员工角色（02 §1.1） */
  employeeRole: [
    { value: 'lead_hunter', labelKey: 'enums.employeeRole.leadHunter' },
    { value: 'customer_researcher', labelKey: 'enums.employeeRole.customerResearcher' },
    { value: 'sales', labelKey: 'enums.employeeRole.sales' },
    { value: 'follow_up', labelKey: 'enums.employeeRole.followUp' },
    { value: 'merchandiser', labelKey: 'enums.employeeRole.merchandiser' },
    { value: 'manager', labelKey: 'enums.employeeRole.manager' },
  ],
  /** 员工状态（02 §1.1，AI 语义色 04 §1.1） */
  employeeStatus: [
    { value: 'working', labelKey: 'enums.employeeStatus.working', color: 'var(--ai-working)' },
    {
      value: 'waiting_approval',
      labelKey: 'enums.employeeStatus.waitingApproval',
      color: 'var(--ai-waiting)',
    },
    { value: 'idle', labelKey: 'enums.employeeStatus.idle', color: 'var(--ai-idle)' },
    { value: 'error', labelKey: 'enums.employeeStatus.error', color: 'var(--ai-risk)' },
  ],
  /** 任务状态（14 §1.1） */
  taskStatus: [
    { value: 'running', labelKey: 'enums.taskStatus.running', color: 'var(--ai-working)' },
    {
      value: 'waiting_approval',
      labelKey: 'enums.taskStatus.waitingApproval',
      color: 'var(--ai-waiting)',
    },
    { value: 'scheduled', labelKey: 'enums.taskStatus.scheduled', color: 'var(--ai-scheduled)' },
    { value: 'completed', labelKey: 'enums.taskStatus.completed', color: 'var(--ai-working)' },
    { value: 'failed', labelKey: 'enums.taskStatus.failed', color: 'var(--ai-risk)' },
    { value: 'paused', labelKey: 'enums.taskStatus.paused', color: 'var(--ai-idle)' },
    { value: 'canceled', labelKey: 'enums.taskStatus.canceled', color: 'var(--ai-idle)' },
  ],
  /** 发现客户价值档（03 §1.6 leadValue） */
  leadValue: [
    { value: 'high', labelKey: 'enums.leadValue.high', color: 'var(--ai-working)' },
    { value: 'medium', labelKey: 'enums.leadValue.medium', color: 'var(--ai-waiting)' },
    { value: 'low', labelKey: 'enums.leadValue.low', color: 'var(--ai-idle)' },
  ],
  /** 知识分类（11 §1.1；引用溯源弹层 / 知识中心共用） */
  knowledgeCategory: [
    { value: 'product', labelKey: 'enums.knowledgeCategory.product', color: 'var(--ai-scheduled)' },
    { value: 'company', labelKey: 'enums.knowledgeCategory.company', color: 'var(--tp-primary)' },
    { value: 'sales', labelKey: 'enums.knowledgeCategory.sales', color: 'var(--ai-working)' },
    { value: 'customer', labelKey: 'enums.knowledgeCategory.customer', color: 'var(--ai-waiting)' },
    { value: 'faq', labelKey: 'enums.knowledgeCategory.faq', color: 'var(--ai-idle)' },
    { value: 'process', labelKey: 'enums.knowledgeCategory.process', color: 'var(--tp-primary)' },
    { value: 'other', labelKey: 'enums.knowledgeCategory.other', color: 'var(--ai-idle)' },
  ],
  /** 索引状态（11 §1.1 indexStatus） */
  knowledgeDocStatus: [
    { value: 'indexed', labelKey: 'enums.knowledgeDocStatus.indexed', color: 'var(--ai-working)' },
    {
      value: 'indexing',
      labelKey: 'enums.knowledgeDocStatus.indexing',
      color: 'var(--ai-scheduled)',
    },
    { value: 'failed', labelKey: 'enums.knowledgeDocStatus.failed', color: 'var(--ai-risk)' },
  ],
  /** 跟进任务状态（07 §1.2） */
  followUpTaskStatus: [
    { value: 'ready', labelKey: 'enums.followUpTaskStatus.ready', color: 'var(--ai-working)' },
    {
      value: 'scheduled',
      labelKey: 'enums.followUpTaskStatus.scheduled',
      color: 'var(--ai-scheduled)',
    },
    {
      value: 'waiting_approval',
      labelKey: 'enums.followUpTaskStatus.waitingApproval',
      color: 'var(--ai-waiting)',
    },
    {
      value: 'completed',
      labelKey: 'enums.followUpTaskStatus.completed',
      color: 'var(--ai-idle)',
    },
    { value: 'paused', labelKey: 'enums.followUpTaskStatus.paused', color: 'var(--ai-idle)' },
  ],
  /** 跟进阶段（07 §1.2） */
  followUpStage: [
    { value: 'follow_up_1', labelKey: 'enums.followUpStage.followUp1' },
    { value: 'follow_up_2', labelKey: 'enums.followUpStage.followUp2' },
    { value: 'follow_up_3', labelKey: 'enums.followUpStage.followUp3' },
    { value: 'follow_up_4', labelKey: 'enums.followUpStage.followUp4' },
    { value: 'quote_followup', labelKey: 'enums.followUpStage.quoteFollowup' },
  ],
  /** 自动发送策略（07 §1.4） */
  autoSendPolicy: [
    { value: 'manual_review', labelKey: 'enums.autoSendPolicy.manualReview' },
    { value: 'auto_send', labelKey: 'enums.autoSendPolicy.autoSend' },
    { value: 'value_based', labelKey: 'enums.autoSendPolicy.valueBased' },
  ],
  /** 跟进执行记录状态（07 §1.5） */
  executionStatus: [
    { value: 'sent', labelKey: 'enums.executionStatus.sent', color: 'var(--ai-working)' },
    {
      value: 'waiting_approval',
      labelKey: 'enums.executionStatus.waitingApproval',
      color: 'var(--ai-waiting)',
    },
    { value: 'approved', labelKey: 'enums.executionStatus.approved', color: 'var(--ai-working)' },
    { value: 'rejected', labelKey: 'enums.executionStatus.rejected', color: 'var(--ai-risk)' },
    { value: 'failed', labelKey: 'enums.executionStatus.failed', color: 'var(--ai-risk)' },
    { value: 'skipped', labelKey: 'enums.executionStatus.skipped', color: 'var(--ai-idle)' },
  ],
  /** 客户类型（05 §1.2 添加表单：Brand / Distributor / Factory / Other） */
  customerType: [
    { value: 'brand', labelKey: 'enums.customerType.brand' },
    { value: 'distributor', labelKey: 'enums.customerType.distributor' },
    { value: 'factory', labelKey: 'enums.customerType.factory' },
    { value: 'other', labelKey: 'enums.customerType.other' },
  ],
  /** 活动类型（05 §1.3；CRM 全部活动页签 / 客户 360° 时间线共用） */
  activityType: [
    {
      value: 'stage_change',
      labelKey: 'enums.activityType.stageChange',
      color: 'var(--tp-primary)',
    },
    {
      value: 'owner_change',
      labelKey: 'enums.activityType.ownerChange',
      color: 'var(--ai-waiting)',
    },
    { value: 'email', labelKey: 'enums.activityType.email', color: 'var(--ai-working)' },
    { value: 'quote', labelKey: 'enums.activityType.quote', color: 'var(--tp-primary)' },
    { value: 'follow_up', labelKey: 'enums.activityType.followUp', color: 'var(--ai-scheduled)' },
    { value: 'note', labelKey: 'enums.activityType.note', color: 'var(--ai-idle)' },
    { value: 'ai_action', labelKey: 'enums.activityType.aiAction', color: 'var(--ai-scheduled)' },
  ],
  /** 国家/地区（05 §1.2 添加客户表单 + 筛选；值 = ISO 3166-1 alpha-2 大写代码） */
  country: [
    { value: 'US', labelKey: 'enums.country.us' },
    { value: 'DE', labelKey: 'enums.country.de' },
    { value: 'UK', labelKey: 'enums.country.uk' },
    { value: 'FR', labelKey: 'enums.country.fr' },
    { value: 'JP', labelKey: 'enums.country.jp' },
    { value: 'CA', labelKey: 'enums.country.ca' },
    { value: 'AU', labelKey: 'enums.country.au' },
    { value: 'ES', labelKey: 'enums.country.es' },
    { value: 'SE', labelKey: 'enums.country.se' },
    { value: 'AE', labelKey: 'enums.country.ae' },
    { value: 'IT', labelKey: 'enums.country.it' },
    { value: 'CN', labelKey: 'enums.country.cn' },
  ],
} as const satisfies Record<string, EnumOption[]>

export type EnumGroup = keyof typeof ENUMS
