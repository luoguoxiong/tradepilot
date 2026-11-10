import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AdapterError } from '../adapters/types';

/**
 * integrations 表 Key 存储：AES-256-GCM，密钥来自 env APP_ENCRYPTION_KEY（32 字节 hex）。
 * 密文格式：v1:<iv>:<authTag>:<ciphertext>（hex）。API 响应只回尾 4 位掩码。
 */
const PREFIX = 'v1';

function loadKey(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new AdapterError(
      'UPSTREAM_ERROR',
      'APP_ENCRYPTION_KEY 未配置或非法（需 32 字节 hex），无法加解密 integrations 配置',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptConfig(plain: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptConfig(payload: string): Record<string, string> {
  const [prefix, ivHex, tagHex, dataHex] = payload.split(':');
  if (prefix !== PREFIX || !ivHex || !tagHex || !dataHex) {
    throw new AdapterError('UPSTREAM_ERROR', 'integrations 配置密文格式非法');
  }
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as Record<string, string>;
}

/** 掩码展示：只留尾 4 位 */
export function maskKey(value: string | undefined): string | null {
  if (!value) return null;
  return `****${value.slice(-4)}`;
}
