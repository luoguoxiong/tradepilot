import { createRequire } from 'node:module';
import { db } from '../db.js';
import { parseOrderText, lowConfidenceFields, type ParsedOrder } from '../prompts/order-parse.js';

const require = createRequire(import.meta.url);
// 经 lib 子路径引入，规避 pdf-parse 在 ESM 下误判为入口执行自测代码的问题
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text: string }>;

const MAX_TEXT = 12_000;

/** 从上传文件/粘贴文本中抽取纯文本 */
export async function extractText(fileName: string, buf: Buffer | null, pastedText: string | null): Promise<string> {
  if (pastedText?.trim()) return pastedText.trim().slice(0, MAX_TEXT);
  if (!buf) throw new Error('未提供文件内容或粘贴文本');
  const lower = (fileName || '').toLowerCase();
  let text = '';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  } else if (lower.endsWith('.pdf')) {
    const out = await pdfParse(buf);
    text = out.text || '';
    if (!text.trim()) throw new Error('该 PDF 未抽取到文本（可能是扫描件/图片型），请手动录入订单');
  } else {
    // csv / txt / 其他按 UTF-8 文本处理
    text = buf.toString('utf8');
  }
  if (!text.trim()) throw new Error('未能从文件中抽取到文本内容');
  return text.trim().slice(0, MAX_TEXT);
}

/** 导入解析：抽取文本 → LLM 抽取 → 暂存 order_imports（确认前不进订单库） */
export async function importAndParse(fileName: string, buf: Buffer | null, pastedText: string | null) {
  const ins = db.prepare(`INSERT INTO order_imports(file_name, source_type) VALUES (?,?)`)
    .run(fileName || (pastedText ? '粘贴文本' : '未知'), pastedText ? 'paste' : 'upload');
  const importId = Number(ins.lastInsertRowid);
  try {
    const text = await extractText(fileName, buf, pastedText);
    const parsed = await parseOrderText(text);
    db.prepare(`UPDATE order_imports SET parsed_json=? WHERE id=?`).run(JSON.stringify(parsed), importId);
    return { importId, parsed, lowFields: lowConfidenceFields(parsed) };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    db.prepare(`UPDATE order_imports SET error=? WHERE id=?`).run(msg, importId);
    throw e;
  }
}
