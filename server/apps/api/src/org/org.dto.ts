import { z } from 'zod';

/**
 * 组织与成员契约（接口 16 §1.2/§1.3/§1.4 / 技术方案 03 §4/§6）。
 * 组织级变更（PUT /org、邀请、成员变更）仅 admin（03 §4）。
 */

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const onboardingStepKeys = ['company', 'products', 'mailbox', 'done'] as const;

export const updateOnboardingSchema = z.object({
  currentStep: z.number().int().min(1).max(4),
});
export type UpdateOnboardingDto = z.infer<typeof updateOnboardingSchema>;

/** GET/PUT /org 契约形状（前端 OrgProfile：sendRules 为扁平字段） */
export const sendRulesSchema = z.object({
  timeWindowStart: z.string().regex(HH_MM, '窗口起点格式 HH:mm').optional(),
  timeWindowEnd: z.string().regex(HH_MM, '窗口终点格式 HH:mm').optional(),
  minTouchIntervalDays: z.number().int().min(1, '频控至少 1 天').max(365).optional(),
});
export type SendRulesDto = z.infer<typeof sendRulesSchema>;

export const updateOrgSchema = z
  .object({
    name: z.string().min(1, '企业名称不能为空').max(100).optional(),
    logo: z.string().url('logo 需为合法 URL').max(2048).nullable().optional(),
    country: z.string().max(56).nullable().optional(),
    /** IANA 时区（16 §1.3）；变更仅对新排期生效 */
    timezone: z.string().refine(isIanaTimezone, '非法 IANA 时区').optional(),
    defaultLanguage: z.enum(['zh-CN', 'en']).optional(),
    defaultCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/, '币种为 3 位大写字母（ISO 4217）')
      .optional(),
    industry: z.string().max(56).nullable().optional(),
    sendRules: sendRulesSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      !(v.sendRules?.timeWindowStart && v.sendRules?.timeWindowEnd) ||
      v.sendRules.timeWindowStart < v.sendRules.timeWindowEnd,
    { message: '外发规则不合法：窗口起点需早于终点' },
  );
export type UpdateOrgDto = z.infer<typeof updateOrgSchema>;

export const inviteMemberSchema = z.object({
  email: z.string().email('邮箱格式不正确').max(254),
  role: z.enum(['admin', 'manager', 'sales']),
});
export type InviteMemberDto = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z.object({
  role: z.enum(['admin', 'manager', 'sales']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>;

function isIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
