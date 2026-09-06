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
} as const satisfies Record<string, EnumOption[]>

export type EnumGroup = keyof typeof ENUMS
