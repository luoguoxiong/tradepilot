/**
 * email_send 外发配置注入（M4 #4/#5）：
 * tools 包不直接依赖 env 装配（api/worker/test 各自注入），进程启动时 configureEmailSend 一次。
 * - encryptionKey：凭据信封解密（08 §2，发送瞬间内存中进行）；
 * - oauth：Gmail/Outlook OAuth 客户端凭据（06 §2.4）；
 * - db：失败留痕专用连接（06 §2.3「最终失败 message.status='failed'」）——失败路径必须
 *   独立事务落库：工具节点执行被 runtime execTool 的 withOrg 单事务包裹，抛错会连带回滚
 *   ctx.tx 内的一切写入，failed 行须走独立连接才能留存。
 * 测试注入：setMailboxDriverFactory（@tradepilot/integrations）替换驱动。
 */
import type { MailboxDriverOptions } from '@tradepilot/integrations';
import type { Db } from '@tradepilot/db';

export interface EmailSendOptions extends MailboxDriverOptions {
  /** 失败留痕独立事务连接（可选；未配置时失败不留 message 行，仅任务错误可见） */
  db?: Db;
}

let config: EmailSendOptions | null = null;

export function configureEmailSend(options: EmailSendOptions): void {
  config = options;
}

/** 配置是否已注入（未注入 → email_send 走 mock 外发兜底，M3 测试/演练语义） */
export function isEmailSendConfigured(): boolean {
  return config !== null;
}

export function getEmailSendConfig(): EmailSendOptions {
  if (!config) {
    throw new Error('email_send 配置未初始化（configureEmailSend 未调用）');
  }
  return config;
}
