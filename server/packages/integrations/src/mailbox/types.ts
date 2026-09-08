/**
 * 邮箱驱动公共类型（后端技术方案 06 §2.1）。
 * 与 @tradepilot/db 解耦：驱动只消费结构性入参（依赖方向 integrations → core/shared）。
 */

/** 驱动所需的邮箱行投影（由调用方从 db mailbox 行映射） */
export interface MailboxDriverRow {
  mailboxId: string;
  orgId: string;
  provider: 'gmail' | 'outlook' | 'smtp_imap';
  account: string;
  imap?: { host: string; port: number; ssl: boolean; credential_enc?: string } | null;
  smtp?: { host: string; port: number; ssl: boolean; credential_enc?: string } | null;
  /** OAuth 凭据（gmail/outlook）：refresh token 信封密文（06 §2.4） */
  oauth?: { refresh_token_enc?: string } | null;
  syncScope: { historyDays: number; folders: string[] };
}

/** 收到的原始消息（驱动内解析 MIME 后的统一投影） */
export interface RawMessage {
  /** RFC 5322 Message-ID（幂等唯一键，02 §5 message.external_message_id） */
  externalMessageId: string;
  /** 所在文件夹（INBOX/Sent…，用于方向推断） */
  folder: string;
  fromName: string | null;
  fromEmail: string;
  toEmails: string[];
  subject: string | null;
  /** 纯文本正文（text/plain 优先，text/html 剥标签兜底） */
  text: string;
  /** 邮件时间（Date 头；缺省用服务器接收时间） */
  date: Date;
}

/** 外发消息（email_send 唯一出口的载荷，06 §2.3） */
export interface OutboundMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** 会话内回复引用（可选） */
  inReplyTo?: string | null;
}

export interface SyncParams {
  since: Date;
  folders: string[];
}

export interface DriverTestResult {
  imap?: 'ok' | 'fail';
  smtp?: 'ok' | 'fail';
  error?: string;
}

export interface SendMessageResult {
  externalId: string;
}

/**
 * MailboxDriver 统一接口（06 §2.1）：
 * 所有实现必须实现 healthCheck()；外呼超时与重试在各驱动内配置。
 * 失败映射 50301 由上层（email_send / email_sync 消费者）负责。
 */
export interface MailboxDriver {
  /** 连接测试（16 §2.6：IMAP/SMTP 分别校验并回显；保存前必须通过） */
  testConnection(): Promise<DriverTestResult>;
  /** 增量拉取（首次全量回填由 since = now - historyDays 表达） */
  syncMessages(params: SyncParams): AsyncIterable<RawMessage>;
  sendMessage(msg: OutboundMessage): Promise<SendMessageResult>;
  markSeen?(externalId: string): Promise<void>;
}

/** 驱动工厂依赖（OAuth 客户端凭据来自 env；加密主密钥用于凭据解密） */
export interface MailboxDriverOptions {
  encryptionKey: string;
  oauth?: {
    googleClientId?: string;
    googleClientSecret?: string;
    microsoftClientId?: string;
    microsoftClientSecret?: string;
  };
}
