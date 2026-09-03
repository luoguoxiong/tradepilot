import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, findJunkWords, validateOutreach, JUNK_WORDS } from '../prompts/outreach.js';
import { validateAnalysis } from '../prompts/analysis.js';

// 红线 R3：开发信后置校验
const v = validateOutreach(150);
const good = { subjects: ['A subject', 'B subject'], body: 'Hi Mr. Weber, I noticed your tumbler line. We manufacture insulated bottles with laser engraving. Would samples help? Best regards, Kevin' };

test('R3: 合规开发信通过', () => {
  assert.equal(v(good), null);
});

test('R3: 超过 150 词拒绝', () => {
  const long = { ...good, body: Array(160).fill('word').join(' ') };
  assert.match(v(long)!, /超过上限 150/);
});

test('R3: 垃圾词命中拒绝（逐词黑名单）', () => {
  for (const w of JUNK_WORDS.slice(0, 5)) {
    const bad = { subjects: ['s', 's2'], body: `${good.body} ${w}` };
    assert.match(v(bad)!, /垃圾邮件触发词/, `应命中 ${w}`);
  }
});

test('R3: 标题必须恰好 2 个', () => {
  assert.match(v({ ...good, subjects: ['only one'] })!, /恰好 2 个/);
  assert.match(v({ ...good, subjects: ['1', '2', '3'] })!, /恰好 2 个/);
});

test('R3: 中英混合词数统计（CJK 按 2 字符折 1 词）', () => {
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('你好世界很好'), 3); // 6 个 CJK 字符 → 3 词
});

// 红线 R4：分析 JSON schema 校验（幻觉防线）
const validAnalysis = {
  company_summary: 'German drinkware distributor',
  main_business: 'wholesale insulated bottles',
  product_lines: ['stainless bottles'],
  market_coverage: 'DACH',
  scale_info: null,
  scale_evidence: null,
  match: { level: 'high', evidence: 'quotes "stainless steel bottles" on /products' },
  importer: { level: 'strong', evidence: 'page contains "wholesale distribution"' },
  market_fit: { level: 'high', evidence: 'lists Germany, USA markets' },
  incomplete: ['认证信息未获取到'],
  sources: [{ page: 'home', url: 'https://x.com' }],
};

test('R4: 合规分析 JSON 通过', () => {
  assert.equal(validateAnalysis(validAnalysis), null);
});

test('R4: 缺 evidence 的评估被拒绝（防无证据评分）', () => {
  const bad: any = { ...validAnalysis, match: { level: 'high', evidence: '' } };
  assert.match(validateAnalysis(bad)!, /evidence/);
});

test('R4: 非法 level 被拒绝', () => {
  const bad: any = { ...validAnalysis, importer: { level: 'super', evidence: 'x' } };
  assert.match(validateAnalysis(bad)!, /importer\.level/);
});

test('R4: 缺关键字段被拒绝（禁止 LLM 漏报以隐藏幻觉）', () => {
  const bad: any = { ...validAnalysis };
  delete bad.main_business;
  assert.match(validateAnalysis(bad)!, /main_business/);
});
