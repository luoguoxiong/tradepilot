import type { ChatMessage } from '../llm/client.js';
import type { Profile } from '../db.js';

export const OUTREACH_PROMPT_VERSION = 'v1';

export const JUNK_WORDS = [
  'free!!!', '100% guaranteed', 'buy now', 'risk-free', 'act now', 'limited time offer',
  'cheap', 'lowest price', 'don\'t miss', 'click here', 'urgent', 'make money',
];

export function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9''-]+/g) || []).length;
  return latin + Math.ceil(cjk / 2);
}

export function findJunkWords(text: string): string[] {
  const lower = text.toLowerCase();
  return JUNK_WORDS.filter((w) => lower.includes(w));
}

export function validateOutreach(maxWords: number) {
  return (obj: unknown): string | null => {
    const o: any = obj;
    if (!o || typeof o !== 'object') return '根节点必须是对象';
    if (!Array.isArray(o.subjects) || o.subjects.length !== 2 || o.subjects.some((s: unknown) => typeof s !== 'string' || !(s as string).trim()))
      return 'subjects 必须是恰好 2 个非空字符串';
    if (typeof o.body !== 'string' || !o.body.trim()) return 'body 必须是非空字符串';
    const wc = countWords(o.body);
    if (wc > maxWords) return `正文 ${wc} 词超过上限 ${maxWords} 词，请精简`;
    const junk = findJunkWords(`${o.subjects.join(' ')} ${o.body}`);
    if (junk.length) return `包含垃圾邮件触发词: ${junk.join(', ')}，请改写`;
    return null;
  };
}

export function buildOutreachMessages(input: {
  profile: Profile;
  report: any;       // 客户分析报告 JSON（唯一事实来源）
  language: string;  // en|de|es|fr|zh
}): ChatMessage[] {
  const { profile, report, language } = input;
  const langName = { en: 'English', de: 'German (Deutsch)', es: 'Spanish (Español)', fr: 'French (Français)', zh: '简体中文' }[language] || 'English';
  const system = `你是资深外贸开发信专家。基于给定的【客户分析报告】和【我方产品档案】撰写一封个性化开发信。

铁律（违反即失败）：
1. 客户侧的任何细节（产品线、业务、市场、规模）只能引用分析报告中已有的内容，禁止编造或延伸报告之外的信息。
2. 我方卖点（认证、产能、MOQ、交期等）只能引用产品档案中"我方优势"字段，未提及的能力一律不写，禁止虚构。
3. 不承诺价格、不报具体数字（除非来自产品档案），不夸大。
4. 结构：个性化钩子（引用客户官网证据，让客户知道你了解他）→ 一句话展示我方匹配点 → 提问钩子（引导回复）→ 单一 CTA 结尾。
5. 正文不超过 150 词（中文不超过 300 字），语气专业自然，不过度热情，不堆砌形容词。
6. 只输出 JSON：{"subjects": ["标题1", "标题2"], "body": "正文"}，标题不超过 60 字符，正文可用换行分段。`;

  const user = `输出语言：${langName}

我方产品档案：
- 产品：${profile.product_desc}
- 目标市场：${profile.markets}
- 我方优势（唯一允许引用的我方信息）：${profile.advantages || '（未填写，不要提任何资质承诺）'}

客户分析报告（唯一允许引用的客户信息）：
${JSON.stringify(
  {
    company_summary: report.company_summary,
    main_business: report.main_business,
    product_lines: report.product_lines,
    market_coverage: report.market_coverage,
    match: report.match,
    importer: report.importer,
    contact: report.contact,
  },
  null,
  2,
)}

请撰写开发信，只输出 JSON。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
