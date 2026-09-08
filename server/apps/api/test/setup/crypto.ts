/**
 * vitest 全局 crypto 兜底（token.service / logging.module 使用 crypto.randomUUID()）。
 */
import { webcrypto } from 'node:crypto';

if (
  typeof (globalThis as { crypto?: Crypto }).crypto === 'undefined' ||
  typeof (globalThis as { crypto?: Crypto }).crypto?.randomUUID !== 'function'
) {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

export {};
