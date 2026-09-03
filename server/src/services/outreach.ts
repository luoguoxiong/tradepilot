import { db } from '../db.js';
import { chatJson } from '../llm/client.js';
import { buildOutreachMessages, validateOutreach, countWords } from '../prompts/outreach.js';

const MAX_WORDS = 150;

/** 生成开发信：LLM 产出 → 后置校验（词数/垃圾词/双标题），校验失败已由 chatJson 带错误重试 */
export async function generateEmail(leadId: number, language = 'en') {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId) as any;
  if (!lead) throw new Error('线索不存在');
  if (lead.status !== 'done' && lead.status !== 'confirmed') throw new Error('该线索尚未完成分析，无法生成开发信');
  const reportRow = db.prepare('SELECT data_json FROM reports WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId) as any;
  if (!reportRow) throw new Error('缺少客户分析报告');
  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(lead.profile_id) as any;
  const report = JSON.parse(reportRow.data_json);

  const out = await chatJson<{ subjects: string[]; body: string }>(
    buildOutreachMessages({ profile, report, language }),
    validateOutreach(MAX_WORDS),
  );

  const wc = countWords(out.body);
  const r = db.prepare('INSERT INTO emails(lead_id, subject, body, word_count) VALUES (?,?,?,?)')
    .run(leadId, out.subjects[0], out.body, wc);
  return {
    id: Number(r.lastInsertRowid), lead_id: leadId,
    subject: out.subjects[0], subjects: out.subjects, body: out.body, word_count: wc, language,
  };
}

/** 导出 RFC822 .eml */
export function buildEml(subject: string, body: string): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return [
    'Subject: =?utf-8?B?' + b64(subject) + '?=',
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
}
