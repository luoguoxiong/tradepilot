import { createHash } from 'node:crypto';

/** URL → 去重键（主机名，去 www、小写）；非法 URL 或空 → null */
export function domainFromWebsite(website: string | undefined | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith('http') ? website : `https://${website}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

/** 企业去重键：域名优先，无域名时用名称指纹（SHA-1 截断，稳定可复现） */
export function buildDedupeKey(name: string, website?: string | null): string {
  const domain = domainFromWebsite(website);
  if (domain) return domain;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return `fp-${createHash('sha1').update(normalized).digest('hex').slice(0, 16)}`;
}

/** 确定性伪随机（Mock 数据“同输入同输出”用） */
export function hashInt(input: string, mod: number): number {
  const h = parseInt(createHash('sha1').update(input).digest('hex').slice(0, 8), 16);
  return h % mod;
}
