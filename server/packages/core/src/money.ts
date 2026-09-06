import { BizException } from './errors.js';

/**
 * 金额序列化（后端技术方案 02 §7 / 接口总览 §2.1）：
 * 库内 numeric，出入参一律字符串十进制（如 "12500.00"）+ currency，杜绝浮点误差。
 * 本文件不引入 decimal.js，仅做「十进制字符串」的规范化与四舍五入（half-up）。
 */

const AMOUNT_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** 校验十进制金额字符串/数字形态 */
export function isValidAmount(value: string | number): boolean {
  return AMOUNT_PATTERN.test(typeof value === 'number' ? String(value) : value.trim());
}

/** 四舍五入到 scale 位（half-up），返回定标字符串（如 "12500.00"） */
export function normalizeAmount(value: string | number, scale = 2): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) {
    throw new BizException(50001, `金额小数位不合法: ${scale}`);
  }

  const raw = (typeof value === 'number' ? String(value) : value).trim();
  if (!AMOUNT_PATTERN.test(raw)) {
    throw new BizException(40001, `金额格式不合法: ${value}`);
  }

  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [intPart, fracRaw = ''] = unsigned.split('.');

  if (fracRaw.length <= scale) {
    const frac = fracRaw.padEnd(scale, '0');
    return `${negative ? '-' : ''}${intPart}${scale > 0 ? `.${frac}` : ''}`;
  }

  // 需要舍入：按 scale 位截断 + half-up
  const keep = fracRaw.slice(0, scale);
  const nextDigit = fracRaw[scale]!;
  const roundUp = nextDigit >= '5';

  let intDigits = intPart!;
  let fracDigits = keep;
  if (roundUp) {
    // 对 (intPart + keep) 整体 +1
    const combined = BigInt(intPart! + keep) + 1n;
    const padded = combined.toString().padStart(intPart!.length + keep.length, '0');
    if (keep.length > 0) {
      intDigits = padded.slice(0, padded.length - keep.length);
      fracDigits = padded.slice(padded.length - keep.length);
    } else {
      intDigits = padded;
    }
  }

  const normalizedInt = intDigits.replace(/^0+(?=\d)/, '');
  return `${negative ? '-' : ''}${normalizedInt}${scale > 0 ? `.${fracDigits}` : ''}`;
}

/** 金额字符串 → 缩放为整数的 BigInt（scale 位），用于无误差运算/入库前校验 */
export function amountToScaledBigInt(value: string | number, scale = 2): bigint {
  const normalized = normalizeAmount(value, scale);
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const scaled = BigInt(intPart! + fracPart.padEnd(scale, '0'));
  return negative ? -scaled : scaled;
}
