import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore } from '../services/score.js';

// 红线 R1：评分引擎确定性（权重 40/25/15/10/10，A>=80 B>=60 C>=40 D<40）
const base = {
  match: { level: 'high', evidence: 'e' },
  importer: { level: 'strong', evidence: 'e' },
  market_fit: { level: 'high', evidence: 'e' },
  scale_info: { founded: '2008', employees: '50-100', certifications: ['BSCI'] },
  scale_evidence: 'e',
  contact: { emails: ['a@b.com'], persons: [], has_form: true },
};

test('R1: 全高配 = 100 分 A 级', () => {
  const r = computeScore(base);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
});

test('R1: grade 边界 80/60/40', () => {
  // high40+strong25+scale15+form5+low2 = 87 → A
  const a = computeScore({ ...base, market_fit: { level: 'low', evidence: 'e' }, contact: { emails: [], persons: [], has_form: true } });
  assert.deepEqual([a.score, a.grade], [87, 'A']);
  // med24+weak15+scale0+email10+med6 = 55 → C
  const c = computeScore({ ...base, match: { level: 'medium', evidence: 'e' }, importer: { level: 'weak', evidence: 'e' }, scale_info: null, scale_evidence: null, market_fit: { level: 'medium', evidence: 'e' } });
  assert.deepEqual([c.score, c.grade], [55, 'C']);
  // low8+none0+scale0+none0+low2 = 10 → D
  const d = computeScore({ ...base, match: { level: 'low', evidence: 'e' }, importer: { level: 'none', evidence: 'e' }, scale_info: null, scale_evidence: null, market_fit: { level: 'low', evidence: 'e' }, contact: { emails: [], persons: [], has_form: false } });
  assert.deepEqual([d.score, d.grade], [10, 'D']);
});

test('R1: scale_info 部分证据按项计分（各5分）', () => {
  const r = computeScore({ ...base, scale_info: { certifications: ['ISO9001'] } });
  assert.equal(r.dims.find((d) => d.key === 'scale')!.earned, 5);
});

test('R1: scale_info=null 计 0 分且不推测（红线）', () => {
  const r = computeScore({ ...base, scale_info: null, scale_evidence: null });
  const scale = r.dims.find((d) => d.key === 'scale')!;
  assert.equal(scale.earned, 0);
  assert.match(scale.evidence, /不推测/);
});

test('R1: contact 规则分档：邮箱10 / 仅表单5 / 无0', () => {
  const e = computeScore(base).dims.find((d) => d.key === 'contact')!;
  const f = computeScore({ ...base, contact: { emails: [], persons: [], has_form: true } }).dims.find((d) => d.key === 'contact')!;
  const n = computeScore({ ...base, contact: { emails: [], persons: [], has_form: false } }).dims.find((d) => d.key === 'contact')!;
  assert.deepEqual([e.earned, f.earned, n.earned], [10, 5, 0]);
});

test('R1: 每个维度都有 evidence（评分可解释性验收）', () => {
  const r = computeScore(base);
  assert.ok(r.dims.every((d) => d.evidence && d.evidence.length > 0));
  assert.ok(r.dims.every((d) => d.earned >= 0 && d.earned <= d.max));
});
