/**
 * MIME 解析公共件（mailparser）：SMTP-IMAP / Gmail 驱动共用。
 */
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import type { RawMessage } from './types.js';

/** RFC822 源 → RawMessage（text/plain 优先，text/html 剥标签兜底；无 Message-ID 返回 null 丢弃） */
export async function parseRawSource(
  source: Buffer,
  folder: string,
  fallbackDate: Date,
): Promise<RawMessage | null> {
  const parsed = await simpleParser(source);
  const messageId = parsed.messageId?.trim();
  if (!messageId) {
    return null;
  }
  const htmlToText = (html: string): string =>
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const text =
    (typeof parsed.text === 'string' && parsed.text.trim()) ||
    (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '');
  const from = firstAddress(parsed.from);
  const rawDate = parsed.date;
  const date = rawDate instanceof Date && !Number.isNaN(rawDate.getTime()) ? rawDate : fallbackDate;
  return {
    externalMessageId: messageId,
    folder,
    fromName: from?.name ?? null,
    fromEmail: (from?.address ?? '').toLowerCase(),
    toEmails: extractAddresses(parsed.to)
      .map((a) => (a.address ?? '').toLowerCase())
      .filter((a) => a.length > 0),
    subject: parsed.subject ?? null,
    text,
    date,
  };
}

/** mailparser 地址字段归一（AddressObject | AddressObject[] | undefined） */
function extractAddresses(
  field: ParsedMail['to'] | ParsedMail['from'] | undefined,
): { name?: string; address?: string }[] {
  if (!field) {
    return [];
  }
  const arr = Array.isArray(field) ? field : [field];
  return arr.flatMap((entry) =>
    entry.value.map((v) => ({ name: v.name, address: v.address })),
  );
}

function firstAddress(
  field: ParsedMail['from'] | undefined,
): { name?: string; address?: string } | undefined {
  return extractAddresses(field)[0];
}
