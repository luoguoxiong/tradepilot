import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 敏感凭据加密（后端技术方案 08 §2）：
 * AES-256-GCM，主密钥 ENCRYPTION_KEY（64 位 hex = 32 字节），每行独立 IV + authTag。
 * 密文格式：`v1:{iv_hex}:{tag_hex}:{cipher_hex}`；接口层永不回显明文（16 §3.3）。
 */

const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function resolveKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error('ENCRYPTION_KEY 必须为 32 字节（64 位 hex）');
  }
  return key;
}

/** 加密明文 → `v1:iv:tag:cipher`（iv/tag/cipher 均 hex） */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', resolveKey(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** 解密 `v1:iv:tag:cipher` → 明文；格式或校验不合法抛错 */
export function decryptSecret(encoded: string, keyHex: string): string {
  const [version, ivHex, tagHex, cipherHex] = encoded.split(':');
  if (version !== 'v1' || ivHex === undefined || tagHex === undefined || cipherHex === undefined) {
    throw new Error('密文格式不合法');
  }
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(keyHex), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}

/** 恒时字符串比较（webhook 签名校验，08 §2） */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
