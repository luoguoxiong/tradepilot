/**
 * 外发内容合规钩子（M4 #11 安全基线，后端技术方案 08 §6）：
 * email_send 外发前强制校验——内置基线（长度上限、空内容、控制字符）+
 * 进程级可注入扩展钩子（org 敏感词/合规规则随 16 设置扩展）。
 * 违规 → BIZ_VALIDATION（42201，任务失败可溯源，不静默外发）。
 */
import { BizException, ErrorCode } from '@tradepilot/core';

export interface EmailContentInput {
  subject: string;
  body: string;
}

export interface ComplianceFinding {
  /** 机器可读规则码（如 subject_too_long / banned_keyword） */
  code: string;
  detail: string;
}

/** 内置基线（08 §6 外发滥用防护最小集） */
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20_000;

/** 控制字符（除 \n \t 外）——防注入/乱码外发 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type ComplianceHook = (input: EmailContentInput) => ComplianceFinding[] | Promise<ComplianceFinding[]>;

let hook: ComplianceHook | null = null;

/** 注入扩展合规钩子（如 org 级敏感词库；P1 随 16 设置扩展） */
export function setEmailComplianceHook(fn: ComplianceHook): void {
  hook = fn;
}

export function resetEmailCompliance(): void {
  hook = null;
}

export async function checkEmailContentCompliance(
  input: EmailContentInput,
): Promise<ComplianceFinding[]> {
  const findings: ComplianceFinding[] = [];
  if (input.subject.trim().length === 0) {
    findings.push({ code: 'subject_empty', detail: '邮件主题不能为空' });
  }
  if (input.subject.length > MAX_SUBJECT_LENGTH) {
    findings.push({
      code: 'subject_too_long',
      detail: `邮件主题超过 ${MAX_SUBJECT_LENGTH} 字符`,
    });
  }
  if (input.body.trim().length === 0) {
    findings.push({ code: 'body_empty', detail: '邮件正文不能为空' });
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    findings.push({ code: 'body_too_long', detail: `邮件正文超过 ${MAX_BODY_LENGTH} 字符` });
  }
  if (CONTROL_CHARS_RE.test(input.subject) || CONTROL_CHARS_RE.test(input.body)) {
    findings.push({ code: 'control_chars', detail: '邮件内容包含非法控制字符' });
  }
  if (hook) {
    findings.push(...(await hook(input)));
  }
  return findings;
}

/** 外发前断言：违规抛 42201（email_send 唯一出口内强制调用，08 §6） */
export async function assertEmailContentCompliance(input: EmailContentInput): Promise<void> {
  const findings = await checkEmailContentCompliance(input);
  if (findings.length > 0) {
    throw new BizException(
      ErrorCode.BIZ_VALIDATION,
      `外发内容合规校验未通过: ${findings.map((f) => `${f.code}(${f.detail})`).join('; ')}`,
    );
  }
}
