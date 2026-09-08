/**
 * vitest 全局 crypto 兜底（@langchain/core rng 依赖 globalThis.crypto.getRandomValues）。
 * Node 18 在某些子进程/隔离环境下不暴露 WebCrypto 全局，统一在此注入，保证测试可复算。
 */
import { webcrypto } from 'node:crypto';

if (
  typeof (globalThis as { crypto?: Crypto }).crypto === 'undefined' ||
  typeof (globalThis as { crypto?: Crypto }).crypto?.getRandomValues !== 'function'
) {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

export {};
