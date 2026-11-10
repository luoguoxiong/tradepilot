/** 开发信 Prompt 模板（PRD §3.5 质量约束） */

export interface EmailPromptInput {
  ourCompanyIntro: string | null;
  productName: string | null;
  productKeywords: string[];
  sellingPoints: string[];
  company: { name: string; country: string; description: string | null; mainProducts: string[] };
  contact: { name: string; title: string } | null;
  customsRecords: { productDescription: string | null; shipmentDate: string }[];
  leadSummary: string | null;
}

export const EMAIL_SYSTEM_PROMPT = `You are an expert B2B outbound-email copywriter for a Chinese exporter writing to overseas buyers.
You MUST reply with a single JSON object only — no markdown, no commentary.

Required JSON shape:
{ "subject": "...", "body": "...", "followUp1": "...", "followUp2": "..." }

Requirements:
- Natural, professional business English. No AI clichés ("I hope this email finds you well", "revolutionary", "game-changer").
- Personalize with the company name, the contact's name/title (if given), and a specific angle connecting OUR product to THEIR business.
- body: 120-180 words. followUp1/followUp2: 60-100 words each, short and polite.
- Only reference the customs import records listed in the input. If none are listed, DO NOT mention shipments, imports, or purchasing history at all. Never invent facts.
- Include one clear, low-friction call to action (e.g. reply for a catalog or samples).`;

export function buildEmailUserPrompt(input: EmailPromptInput): string {
  const lines: string[] = [];
  lines.push('## About us');
  lines.push(`- Company intro: ${input.ourCompanyIntro ?? '(not provided — keep intro generic)'}`);
  lines.push(`- Product: ${input.productName ?? input.productKeywords.join(', ')}`);
  if (input.sellingPoints.length) lines.push(`- Selling points: ${input.sellingPoints.join('; ')}`);
  lines.push('');
  lines.push('## Prospect');
  lines.push(`- Company: ${input.company.name} (${input.company.country})`);
  lines.push(`- Their business: ${input.company.description ?? '(none)'}`);
  lines.push(`- Their main products: ${input.company.mainProducts.join(', ') || '(none)'}`);
  lines.push(
    input.contact
      ? `- Recipient: ${input.contact.name}, ${input.contact.title}`
      : '- Recipient: unknown (use a generic salutation like "Hi there")',
  );
  lines.push('');
  lines.push('## Verified import records (only these may be referenced)');
  if (input.customsRecords.length === 0) {
    lines.push('(NONE — do not mention shipments/imports/purchasing history)');
  } else {
    input.customsRecords.forEach((r) => lines.push(`- ${r.shipmentDate} | ${r.productDescription ?? 'n/a'}`));
  }
  if (input.leadSummary) {
    lines.push('');
    lines.push(`## AI analysis summary (for angle, do not quote numbers) \n${input.leadSummary}`);
  }
  return lines.join('\n');
}
