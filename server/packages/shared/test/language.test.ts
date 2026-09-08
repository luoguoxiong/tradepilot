import { describe, expect, it } from 'vitest';
import { detectEmailLanguage } from '../src/language.js';

describe('detectEmailLanguage（06 §7 确定性 zh/en 检测）', () => {
  it('中文正文 → zh', () => {
    expect(detectEmailLanguage('您好，我们对中国供应商的产品很感兴趣，请报价。')).toBe('zh');
  });

  it('英文正文 → en', () => {
    expect(detectEmailLanguage('Hello, we are interested in your products. Please quote.')).toBe('en');
  });

  it('英文为主夹少量中文签名（< 10%）→ en', () => {
    const body =
      'Hello, could you send me the latest catalog and price list for your carbon fiber insoles?\n\nBest regards,\nJohn（约翰）';
    expect(detectEmailLanguage(body)).toBe('en');
  });

  it('中文为主夹英文产品词 → zh', () => {
    expect(detectEmailLanguage('我们需要 carbon fiber insoles 的报价，数量 5000 双，请报 FOB 价格。')).toBe('zh');
  });

  it('中文标点/全角字符计入 CJK（纯标点正文 → zh）', () => {
    expect(detectEmailLanguage('你好！请查收附件，谢谢。')).toBe('zh');
  });

  it('无信号：空正文 / 空白 / null / undefined → en（缺省英文）', () => {
    expect(detectEmailLanguage('')).toBe('en');
    expect(detectEmailLanguage('   \n\t ')).toBe('en');
    expect(detectEmailLanguage(null)).toBe('en');
    expect(detectEmailLanguage(undefined)).toBe('en');
  });
});
