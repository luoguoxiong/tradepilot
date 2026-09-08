/**
 * @tradepilot/integrations —— 邮箱驱动（Gmail/Outlook/SMTP-IMAP）、搜索/抓取、
 * 嵌入服务、对象存储适配器（后端技术方案 06）。
 * 依赖方向：integrations → core/shared。
 */
export {
  createMailboxDriver,
  setMailboxDriverFactory,
  type MailboxDriverFactory,
} from './mailbox/factory.js';
export { MailboxAuthError, MailboxSendError, isMailboxAuthError } from './mailbox/errors.js';
export {
  decryptChannelCredential,
  decryptRefreshToken,
  getMicrosoftAccessToken,
  assertGoogleOAuthConfig,
} from './mailbox/credentials.js';
export type {
  MailboxDriver,
  MailboxDriverOptions,
  MailboxDriverRow,
  RawMessage,
  OutboundMessage,
  SyncParams,
  DriverTestResult,
  SendMessageResult,
} from './mailbox/types.js';
