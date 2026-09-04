import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { getSetting, setSetting } from '../db.js';
import { config } from '../config.js';

export interface SmtpConfig {
  host: string; port: number; secure: boolean;
  user: string; sender_name: string;
  /** 只写不读：加密后的密码（auth pass） */
  pass_enc?: string;
}

const SMTP_KEY = 'smtp';
export const getSmtp = () => getSetting<SmtpConfig>(SMTP_KEY);
export const saveSmtp = (s: SmtpConfig) => setSetting(SMTP_KEY, s);

/* ---- 密码加密（AES-256-GCM，密钥 scrypt 派生） ---- */
function deriveKey(): Buffer {
  const secret = config.order.appSecret || `${config.llm.apiKey}|tradepilot-order-mailer`;
  return crypto.scryptSync(secret, 'tradepilot-smtp-salt', 32);
}
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function transport(s: SmtpConfig) {
  if (!s.host || !s.user) throw new Error('SMTP 未配置完整（缺少主机或账号），请到设置页配置');
  if (!s.pass_enc) throw new Error('SMTP 未配置密码/授权码');
  return nodemailer.createTransport({
    host: s.host, port: Number(s.port) || 465, secure: !!s.secure,
    auth: { user: s.user, pass: decryptSecret(s.pass_enc) },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

/** 连接测试（不发信） */
export async function testSmtp(): Promise<{ ok: true }> {
  const s = getSmtp();
  if (!s) throw new Error('SMTP 未配置');
  await transport(s).verify();
  return { ok: true };
}

export interface OutgoingMail { to: string; subject: string; body: string }

/** 发送邮件：成功返回 messageId，失败抛错（调用方落库失败状态） */
export async function sendMail(mail: OutgoingMail): Promise<string> {
  const s = getSmtp();
  if (!s) throw new Error('SMTP 未配置，请先到设置页完成配置');
  const from = s.sender_name ? `"${s.sender_name.replace(/"/g, '')}" <${s.user}>` : s.user;
  const info = await transport(s).sendMail({
    from, to: mail.to, subject: mail.subject, text: mail.body,
  });
  return info.messageId || 'sent';
}
