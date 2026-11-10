/** Prompt 模板集中管理（architecture.md §5）；开发信/评分约束与 PRD 权重保持一致 */

export interface ScoringPromptInput {
  productName: string | null;
  productKeywords: string[];
  sellingPoints: string[];
  company: {
    name: string;
    country: string;
    description: string | null;
    mainProducts: string[];
    source: string;
  };
  contacts: { name: string; title: string }[];
  customsRecords: {
    productDescription: string | null;
    shipmentDate: string;
    quantity: string | null;
    supplierCountry: string | null;
  }[];
}

export const SCORING_SYSTEM_PROMPT = `You are a B2B lead-qualification analyst for a Chinese exporter.
You MUST reply with a single JSON object only — no markdown, no commentary. Do not fabricate facts.

Score the prospect on five dimensions, each 0-100:
- product: how well our product matches the company's business (30% of final score)
- business: importer/distributor/wholesaler fit (25%)
- customs: credibility of real purchasing records (25%)
- contact: how well available contact titles match purchasing roles (10%)
- region: fit of the company's country with our target markets (10%)

Required JSON shape:
{
  "subScores": { "product": 0, "business": 0, "customs": 0, "contact": 0, "region": 0 },
  "matchReasons": ["..."],
  "purchaseNeeds": "...",
  "opportunities": "...",
  "suggestions": "...",
  "uncertaintyNotes": "..."
}

Rules:
- matchReasons: 3-5 short bullet strings citing the given evidence.
- purchaseNeeds / opportunities / suggestions: 1-3 sentences each, concrete, evidence-based.
- uncertaintyNotes: MUST state which data is missing or uncertain (e.g. no customs records, no verified contacts).
- If customs records are absent, score customs low (<=30) and say so. Never invent shipments.
- If the company data is marked DEMO, mention that in uncertaintyNotes.`;

export function buildScoringUserPrompt(input: ScoringPromptInput): string {
  const lines: string[] = [];
  lines.push('## Our product');
  lines.push(`- Name: ${input.productName ?? '(not specified)'}`);
  lines.push(`- Keywords: ${input.productKeywords.join(', ') || '(none)'}`);
  if (input.sellingPoints.length) lines.push(`- Selling points: ${input.sellingPoints.join('; ')}`);
  lines.push('');
  lines.push('## Company');
  lines.push(`- Name: ${input.company.name}`);
  lines.push(`- Country: ${input.company.country}`);
  lines.push(`- Description: ${input.company.description ?? '(none)'}`);
  lines.push(`- Main products: ${input.company.mainProducts.join(', ') || '(none)'}`);
  lines.push(`- Data source: ${input.company.source}`);
  lines.push('');
  lines.push('## Contacts');
  if (input.contacts.length === 0) {
    lines.push('(none discovered yet)');
  } else {
    input.contacts.forEach((c) => lines.push(`- ${c.name} — ${c.title}`));
  }
  lines.push('');
  lines.push('## Customs import records');
  if (input.customsRecords.length === 0) {
    lines.push('(no import records found — treat purchasing credibility as unverified, score customs <= 30)');
  } else {
    input.customsRecords.forEach((r) =>
      lines.push(`- ${r.shipmentDate} | ${r.productDescription ?? 'n/a'} | qty ${r.quantity ?? 'n/a'} | supplier country ${r.supplierCountry ?? 'n/a'}`),
    );
  }
  return lines.join('\n');
}
