import { describe, expect, it } from 'vitest';
import {
  BizException,
  amountToScaledBigInt,
  isValidAmount,
  normalizeAmount,
} from '../src/index.js';

describe('normalizeAmount', () => {
  it('补齐两位小数', () => {
    expect(normalizeAmount('12500')).toBe('12500.00');
    expect(normalizeAmount('12.3')).toBe('12.30');
    expect(normalizeAmount('0')).toBe('0.00');
  });

  it('half-up 四舍五入', () => {
    expect(normalizeAmount('12.345')).toBe('12.35');
    expect(normalizeAmount('12.344')).toBe('12.34');
    expect(normalizeAmount('0.005')).toBe('0.01');
    expect(normalizeAmount('-0.005')).toBe('-0.01');
    expect(normalizeAmount('999.999')).toBe('1000.00');
  });

  it('支持自定义小数位', () => {
    expect(normalizeAmount('0.12345', 4)).toBe('0.1235');
    expect(normalizeAmount('5', 0)).toBe('5');
  });

  it('number 入参', () => {
    expect(normalizeAmount(12500)).toBe('12500.00');
    expect(normalizeAmount(12.345)).toBe('12.35');
  });

  it('非法输入抛 40001', () => {
    expect(() => normalizeAmount('12.3.4')).toThrowError(BizException);
    expect(() => normalizeAmount('abc')).toThrowError(BizException);
    expect(() => normalizeAmount('')).toThrowError(BizException);
    expect(() => normalizeAmount('1e5')).toThrowError(BizException);
  });
});

describe('isValidAmount / amountToScaledBigInt', () => {
  it('isValidAmount', () => {
    expect(isValidAmount('12500.00')).toBe(true);
    expect(isValidAmount('-3.5')).toBe(true);
    expect(isValidAmount('01.5')).toBe(false);
    expect(isValidAmount('.5')).toBe(false);
    expect(isValidAmount('NaN')).toBe(false);
  });

  it('amountToScaledBigInt 无误差换算', () => {
    expect(amountToScaledBigInt('12.345')).toBe(1235n);
    expect(amountToScaledBigInt('-12.34')).toBe(-1234n);
    expect(amountToScaledBigInt('12500')).toBe(1_250_000n);
  });
});
