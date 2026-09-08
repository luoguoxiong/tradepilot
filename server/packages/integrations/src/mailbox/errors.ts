/**
 * 邮箱驱动错误分类（后端技术方案 06 §1/§2.4）：
 * - MailboxAuthError：凭据失效/OAuth 刷新失败 → 上层置 mailbox.status='disconnected'；
 * - MailboxSendError：发送失败（可重试）→ email_send 退避重试，最终 failed；
 * 其余网络/超时错误原样上抛，由消费者按「同步连续失败」口径熔断。
 */

export class MailboxAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailboxAuthError';
  }
}

export class MailboxSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailboxSendError';
  }
}

/** 判定驱动错误是否属于凭据失效（含底层库的常见认证错误文案） */
export function isMailboxAuthError(err: unknown): err is MailboxAuthError {
  if (err instanceof MailboxAuthError) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return /invalid credentials|authenticationfailed|auth.*(fail|invalid|expired)|invalid_grant|unauthorized|401/.test(
    msg,
  );
}
