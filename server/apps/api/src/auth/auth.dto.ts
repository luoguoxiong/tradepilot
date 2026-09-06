import { z } from 'zod';

/**
 * 认证契约（接口 16 §3.1/§3.2 / 技术方案 03 §1.1）。
 * MVP 仅邮箱+密码；loginType 预留（验证码/企微扫码 P1，16 §7.3）。
 */

export const registerSchema = z.object({
  companyName: z.string().min(1, '企业名称必填').max(100),
  contactName: z.string().min(1, '联系人姓名必填').max(50),
  email: z.string().email('邮箱格式不正确').max(254),
  /** 密码 ≥ 8 位（16 需求 §3.3）；bcrypt 上限 72 字节 */
  password: z.string().min(8, '密码至少 8 位').max(72),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email('邮箱格式不正确').max(254),
  password: z.string().min(1).max(72),
  loginType: z.enum(['password']).optional(),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type LogoutDto = z.infer<typeof logoutSchema>;

/** 接受邀请（03 §1.1）：邀请 token 校验 → 补密码 → invited → active（公开接口） */
export const acceptInvitationSchema = z.object({
  token: z.string().min(1).max(128),
  name: z.string().min(1, '姓名必填').max(50),
  password: z.string().min(8, '密码至少 8 位').max(72),
});
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;
