/**
 * 订单解析评估集测试（真实 LLM）：test/order-followup/eval-sets/order-parse-golden-v1.jsonl
 * 默认跳过；设置 RUN_PARSE_EVAL=1 且配置真实 key 后运行（约 8 次调用）
 * 输出逐字段命中率与 badcase 明细，供 test-report 评估章节使用
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = process.env.RUN_PARSE_EVAL !== '1';
if (SKIP) {
  test('order-parse eval（设置 RUN_PARSE_EVAL=1 启用真实 LLM 评估）', { skip: true }, () => {});
} else {
  const { parseOrderText, lowConfidenceFields } = await import('../prompts/order-parse.js');

  interface Case {
    id: string; desc: string; input: string; golden: Record<string, any>;
  }
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'order-followup', 'eval-sets', 'order-parse-golden-v1.jsonl');
  const cases: Case[] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') return v.trim() || null;
    return v ?? null;
  };
  const eq = (a: unknown, b: unknown): boolean => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
    if (a == null && b == null) return true;
    return String(a ?? '') === String(b ?? '');
  };

  const HEAD_FIELDS = ['order_no', 'customer_name', 'customer_email', 'order_date', 'delivery_date', 'incoterms', 'payment_terms', 'currency', 'total_amount'];

  test(`评估集：${cases.length} 个样本逐字段命中率`, async () => {
    let hit = 0, total = 0;
    const badcases: string[] = [];
    for (const c of cases) {
      const out = await parseOrderText(c.input);
      for (const f of HEAD_FIELDS) {
        if (c.golden[f] === undefined) continue;
        total++;
        if (eq(norm((out as any)[f]), norm(c.golden[f]))) hit++;
        else badcases.push(`${c.id}.${f}: 期望=${JSON.stringify(c.golden[f])} 实际=${JSON.stringify((out as any)[f])}`);
      }
      const gItems: any[] = c.golden.items || [];
      if (gItems.length !== (out.items || []).length) {
        badcases.push(`${c.id}.items: 行数 期望=${gItems.length} 实际=${(out.items || []).length}`);
        total++;
        continue;
      }
      gItems.forEach((gi, i) => {
        for (const f of ['name', 'model', 'qty', 'unit', 'unit_price']) {
          if (gi[f] === undefined) continue;
          total++;
          if (eq(norm((out.items[i] as any)?.[f]), norm(gi[f]))) hit++;
          else badcases.push(`${c.id}.items[${i}].${f}: 期望=${JSON.stringify(gi[f])} 实际=${JSON.stringify((out.items[i] as any)?.[f])}`);
        }
      });
      // 低置信度提示可用性：字段缺失时应有低置信度标注（容错体验）
      console.log(`[eval] ${c.id} lowFields=${lowConfidenceFields(out).join(',') || '-'}`);
    }
    const rate = Math.round((hit / total) * 1000) / 10;
    console.log(`[eval] 字段命中率: ${hit}/${total} = ${rate}%`);
    if (badcases.length) console.log(`[eval] badcase:\n  ${badcases.join('\n  ')}`);
    // 将结果写入报告数据文件（badcase 回流依据）
    fs.writeFileSync(
      path.join(path.dirname(file), '..', 'eval-run-latest.txt'),
      `rate=${rate} hit=${hit}/${total}\n${badcases.map((b) => `- ${b}`).join('\n')}\n`,
    );
    assert.ok(rate >= 90, `字段命中率 ${rate}% 低于 90% 门禁`);
  });
}
