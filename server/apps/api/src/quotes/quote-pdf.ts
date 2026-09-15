/**
 * 报价单 PDF 服务端渲染（09 §3.6 / 需求 §7 澄清）。
 *
 * MVP 采用零依赖的最小 PDF 写入器（不引入 puppeteer/pdfkit 等重依赖，保持服务可离线构建）：
 * - 纯 ASCII 文本走 Base-14 Helvetica（任何 PDF 阅读器必然可用）；
 * - 含非 ASCII（中文等）文本走 Type0 / STSong-Light + UniGB-UCS2-H 预定义 CMap，
 *   由阅读器按标准 CJK 字体做替换渲染（避免内嵌字体的体积与授权问题）；
 * - 模板 = 公司抬头（16 组织信息 name/country）+ 报价头结构化字段 + 明细表 + 合计 + 条款。
 * 完整单证（PI/CI/PL）与 CJK 字体内嵌留待「单证需求专项」（09 §4）。
 */

export interface QuotePdfCompany {
  name: string;
  country?: string | null;
  logoUrl?: string | null;
}

export interface QuotePdfItem {
  seq: number;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface QuotePdfInput {
  company: QuotePdfCompany;
  quoteNo: string;
  status: string;
  createdAt: string;
  customerName: string;
  customerCountry?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  currency: string;
  incoterms: string;
  validUntil: string;
  paymentTerms: string;
  exchangeRate: { rate: string; date: string; source: string };
  items: QuotePdfItem[];
  totalAmount: string;
  profitMarginPct?: string | null;
}

/** 纸张（A4，单位 pt） */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;

/** 文字绘制项 */
interface TextOp {
  x: number;
  y: number;
  text: string;
  size: number;
  bold: boolean;
}

/** 线条绘制项 */
interface LineOp {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

class PdfPage {
  private readonly texts: TextOp[] = [];
  private readonly lines: LineOp[] = [];

  text(x: number, y: number, text: string, size = 10, bold = false): void {
    if (!text) {
      return;
    }
    this.texts.push({ x, y, text, size, bold });
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.75): void {
    this.lines.push({ x1, y1, x2, y2, width });
  }

  /** 生成页面内容流（BT/ET 文本块 + 路径描边） */
  toContentStream(): string {
    const parts: string[] = [];
    for (const l of this.lines) {
      parts.push(`${fmt(l.width)} w`, `${fmt(l.x1)} ${fmt(l.y1)} m ${fmt(l.x2)} ${fmt(l.y2)} l S`);
    }
    for (const t of this.texts) {
      const font = isAscii(t.text) ? (t.bold ? 'F2' : 'F1') : 'FC';
      const show = isAscii(t.text) ? literal(t.text) : `<${toUcs2Hex(t.text)}>`;
      parts.push(`BT /${font} ${fmt(t.size)} Tf ${fmt(t.x)} ${fmt(t.y)} Td ${show} Tj ET`);
    }
    return `${parts.join('\n')}\n`;
  }
}

/** 渲染报价单 PDF（返回 Buffer，供接口直接外发） */
export function renderQuotePdf(input: QuotePdfInput): Buffer {
  const page = new PdfPage();
  let y = PAGE_HEIGHT - MARGIN;

  // ===== 公司抬头 =====
  page.text(MARGIN, y, input.company.name, 18, true);
  y -= 16;
  if (input.company.country) {
    page.text(MARGIN, y, input.company.country, 9);
    y -= 12;
  }
  page.text(MARGIN, y, `Logo: ${input.company.logoUrl ?? '-'}`, 8);
  y -= 10;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 1);
  y -= 28;

  // ===== 标题 =====
  page.text(MARGIN, y, 'QUOTATION', 20, true);
  page.text(PAGE_WIDTH - MARGIN - 150, y, `No. ${input.quoteNo}`, 12, true);
  y -= 18;
  page.text(PAGE_WIDTH - MARGIN - 150, y, `Status: ${input.status}`, 9);
  y -= 8;
  page.text(PAGE_WIDTH - MARGIN - 150, y, `Date: ${input.createdAt.slice(0, 10)}`, 9);
  y -= 26;

  // ===== 客户信息 =====
  page.text(MARGIN, y, 'To:', 10, true);
  page.text(MARGIN + 30, y, input.customerName, 10);
  y -= 14;
  if (input.customerCountry) {
    page.text(MARGIN + 30, y, input.customerCountry, 10);
    y -= 14;
  }
  if (input.contactName || input.contactEmail) {
    const contact = [input.contactName, input.contactEmail].filter(Boolean).join('  ');
    page.text(MARGIN + 30, y, contact, 10);
    y -= 14;
  }
  y -= 12;

  // ===== 报价头结构化字段 =====
  const headers: [string, string][] = [
    ['Currency', input.currency],
    ['Incoterms', input.incoterms],
    ['Valid Until', input.validUntil],
    ['Payment Terms', input.paymentTerms],
    [
      'Exchange Rate',
      `${input.exchangeRate.rate} (${input.exchangeRate.date}, ${input.exchangeRate.source})`,
    ],
  ];
  for (const [label, value] of headers) {
    page.text(MARGIN, y, `${label}:`, 10, true);
    page.text(MARGIN + 110, y, value, 10);
    y -= 15;
  }
  y -= 14;

  // ===== 明细表 =====
  const colNo = MARGIN;
  const colProduct = MARGIN + 32;
  const colQty = PAGE_WIDTH - MARGIN - 220;
  const colUnit = PAGE_WIDTH - MARGIN - 140;
  const colTotal = PAGE_WIDTH - MARGIN - 60;

  page.text(colNo, y, '#', 10, true);
  page.text(colProduct, y, 'Product', 10, true);
  page.text(colQty, y, 'Qty', 10, true);
  page.text(colUnit, y, 'Unit Price', 10, true);
  page.text(colTotal, y, 'Amount', 10, true);
  y -= 6;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.75);
  y -= 14;

  for (const item of input.items) {
    page.text(colNo, y, String(item.seq), 10);
    page.text(colProduct, y, truncate(item.productName, 46), 10);
    page.text(colQty, y, String(item.quantity), 10);
    page.text(colUnit, y, item.unitPrice, 10);
    page.text(colTotal, y, item.lineTotal, 10);
    y -= 16;
  }

  y += 4;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.75);
  y -= 18;
  page.text(colUnit - 20, y, 'Total:', 11, true);
  page.text(colTotal, y, `${input.currency} ${input.totalAmount}`, 11, true);
  y -= 16;
  if (input.profitMarginPct) {
    page.text(colUnit - 20, y, 'Profit Margin:', 9);
    page.text(colTotal, y, `${input.profitMarginPct}%`, 9);
    y -= 16;
  }

  // ===== 页脚 =====
  page.text(
    MARGIN,
    MARGIN,
    `Generated by TradePilot · ${new Date().toISOString().slice(0, 10)}`,
    8,
  );

  return assemblePdf(page.toContentStream());
}

// ===== 最小 PDF 组装 =====

/** 组装单页 PDF（对象图：Catalog/Pages/Page/Contents/字体） */
function assemblePdf(content: string): Buffer {
  const contentBytes = Buffer.from(content, 'latin1');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R /FC 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H ' +
      '/DescendantFonts [8 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> ' +
      '/FontDescriptor 9 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 ' +
      '/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 ' +
      '/CapHeight 880 /StemV 93 >>',
  ];

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    cursor += buf.length;
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  objects.forEach((body, index) => {
    offsets.push(cursor);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = cursor;
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** 数字保留 4 位小数并去除尾随 0（PDF 数值） */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '');
}

/** 是否纯 ASCII（可用 Base-14 Helvetica 渲染） */
function isAscii(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

/** PDF 字面量字符串转义（非拉丁字符回落 '?'） */
function literal(text: string): string {
  const safe = text.replace(/[^\x20-\x7E]/g, '?');
  return `(${safe.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

/** 文本 → UCS-2 大端十六进制（Type0/UniGB-UCS2-H） */
function toUcs2Hex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i += 1) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return hex;
}

/** 截断过长文本（表格列宽保护） */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
