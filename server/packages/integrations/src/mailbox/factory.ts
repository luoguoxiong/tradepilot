/**
 * 驱动工厂（后端技术方案 06 §2.1）：provider → MailboxDriver。
 * 无测试替身注入点：集成测试同样走真实驱动（本地 GreenMail / 真实供应商端点）。
 */
import { createGmailDriver } from './gmail.js';
import { createOutlookDriver } from './outlook.js';
import { createSmtpImapDriver } from './smtp-imap.js';
import type { MailboxDriver, MailboxDriverOptions, MailboxDriverRow } from './types.js';

export function createMailboxDriver(
  row: MailboxDriverRow,
  options: MailboxDriverOptions,
): MailboxDriver {
  switch (row.provider) {
    case 'gmail':
      return createGmailDriver(row, options);
    case 'outlook':
      return createOutlookDriver(row, options);
    case 'smtp_imap':
      return createSmtpImapDriver(row, options.encryptionKey);
    default: {
      const exhaustive: never = row.provider;
      throw new Error(`未知邮箱 provider: ${String(exhaustive)}`);
    }
  }
}
