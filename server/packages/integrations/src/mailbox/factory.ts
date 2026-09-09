/**
 * 驱动工厂（后端技术方案 06 §2.1）：provider → MailboxDriver。
 * 测试注入：setMailboxDriverFactory 覆盖默认工厂（mock 驱动保链路可测，对齐 M4-B4 mock 策略）。
 */
import { createGmailDriver } from './gmail.js';
import { createOutlookDriver } from './outlook.js';
import { createSmtpImapDriver } from './smtp-imap.js';
import type {
  MailboxDriver,
  MailboxDriverOptions,
  MailboxDriverRow,
} from './types.js';

export type MailboxDriverFactory = (row: MailboxDriverRow, options: MailboxDriverOptions) => MailboxDriver;

let customFactory: MailboxDriverFactory | null = null;

/** 测试/扩展注入（仅进程级，worker 启动时默认工厂即生效） */
export function setMailboxDriverFactory(factory: MailboxDriverFactory | null): void {
  customFactory = factory;
}

export function createMailboxDriver(
  row: MailboxDriverRow,
  options: MailboxDriverOptions,
): MailboxDriver {
  if (customFactory) {
    return customFactory(row, options);
  }
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
