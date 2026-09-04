import type { Order, OrderItem } from '../db.js';

export type DocType = 'pi' | 'invoice' | 'pl';
export const DOC_TYPES: DocType[] = ['pi', 'invoice', 'pl'];
export const DOC_TYPE_LABEL: Record<DocType, string> = { pi: 'PI（形式发票）', invoice: 'Invoice（商业发票）', pl: 'Packing List（装箱单）' };

const CENTS = (n: number) => Math.round(n * 100);

/* ==================== 英文大写金额（确定性实现） ==================== */

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigits(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

/** 1234.56 → "One Thousand Two Hundred Thirty-Four US Dollars and Fifty-Six Cents" */
export function amountInWords(amount: number, currency: string): string {
  const cur = (currency || 'USD').toUpperCase();
  const names: Record<string, [string, string]> = {
    USD: ['US Dollars', 'Cents'], EUR: ['Euros', 'Cents'], GBP: ['Pounds Sterling', 'Pence'],
    CNY: ['Chinese Yuan', 'Fen'], JPY: ['Japanese Yen', 'Sen'], HKD: ['Hong Kong Dollars', 'Cents'],
    AUD: ['Australian Dollars', 'Cents'], CAD: ['Canadian Dollars', 'Cents'],
  };
  const [major, minor] = names[cur] || [`${cur} Dollars`, 'Cents'];
  const total = CENTS(amount);
  const whole = Math.floor(total / 100);
  const cents = total % 100;
  const units = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']] as const;
  let rest = whole;
  const parts: string[] = [];
  for (const [value, label] of units) {
    if (rest >= value) { parts.push(`${threeDigits(Math.floor(rest / value))} ${label}`); rest %= value; }
  }
  if (rest > 0) parts.push(threeDigits(rest));
  const wholeStr = parts.length ? parts.join(' ') : 'Zero';
  return cents > 0
    ? `${wholeStr} ${major} and ${threeDigits(cents)} ${minor} Only`
    : `${wholeStr} ${major} Only`;
}

/* ==================== 单证数据构建与校验（红线：数字全部来自订单） ==================== */

export interface DocData {
  doc_type: DocType; doc_no: string; doc_date: string;
  seller_name: string; buyer_name: string; buyer_address: string;
  order_no: string; order_date: string;
  consignee: string; marks: string;
  incoterms: string; payment_terms: string; currency: string;
  items: Array<{ name: string; model: string; qty: number; unit: string; unit_price: number; amount: number }>;
  total_qty: number; total_amount: number;
  amount_in_words: string;
  cartons: string; gross_weight: string; net_weight: string; volume: string;
  remarks: string;
}

export interface DocOverride {
  seller_name?: string; buyer_address?: string; consignee?: string; marks?: string;
  cartons?: string; gross_weight?: string; net_weight?: string; volume?: string;
  remarks?: string;
}

export function buildDocData(order: Order, items: OrderItem[], docType: DocType, overrides: DocOverride = {}): DocData {
  const docItems = items.map((it) => ({
    name: it.name || '', model: it.model || '', qty: Number(it.qty) || 0, unit: it.unit || '',
    unit_price: Number(it.unit_price) || 0, amount: CENTS(Number(it.qty) * Number(it.unit_price)) / 100,
  }));
  return {
    doc_type: docType,
    doc_no: '',
    doc_date: new Date().toISOString().slice(0, 10),
    seller_name: overrides.seller_name || '（我方公司名，请在设置/微调中填写）',
    buyer_name: order.customer_name || '',
    buyer_address: overrides.buyer_address || '',
    order_no: order.order_no || '',
    order_date: order.order_date || '',
    consignee: overrides.consignee || order.customer_name || '',
    marks: overrides.marks || '',
    incoterms: order.incoterms || '',
    payment_terms: order.payment_terms || '',
    currency: order.currency || 'USD',
    items: docItems,
    total_qty: docItems.reduce((s, it) => s + it.qty, 0),
    total_amount: CENTS(docItems.reduce((s, it) => s + it.amount, 0)) / 100,
    amount_in_words: '',
    cartons: overrides.cartons || '', gross_weight: overrides.gross_weight || '',
    net_weight: overrides.net_weight || '', volume: overrides.volume || '',
    remarks: overrides.remarks || order.remarks || '',
  };
}

const TOL = 0.01;

/** 校验器：返回问题清单，非空则阻断出单 */
export function validateDoc(data: DocData): string[] {
  const issues: string[] = [];
  if (!data.buyer_name?.trim()) issues.push('买方（客户名）为空');
  if (!data.items.length) issues.push('产品行为空');
  data.items.forEach((it, i) => {
    if (!it.name?.trim()) issues.push(`第 ${i + 1} 行品名为空`);
    if (it.qty <= 0) issues.push(`第 ${i + 1} 行数量必须大于 0`);
    if (Math.abs(it.qty * it.unit_price - it.amount) > TOL) issues.push(`第 ${i + 1} 行金额与 数量×单价 不一致`);
  });
  const sum = CENTS(data.items.reduce((s, it) => s + it.amount, 0)) / 100;
  if (Math.abs(sum - data.total_amount) > TOL) issues.push(`行金额合计（${sum}）与订单总金额（${data.total_amount}）不一致`);
  if (!data.amount_in_words.includes('Only')) issues.push('大写金额生成异常');
  if (data.doc_type === 'pl' && !data.cartons?.trim()) issues.push('装箱单缺少箱数（可在生成时补充）');
  return issues;
}

/* ==================== HTML 渲染（A4 打印样式） ==================== */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, 'PingFang SC', sans-serif; color: #111; font-size: 13px; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 18mm 16mm; }
  h1 { font-size: 20px; text-align: center; letter-spacing: 2px; margin-bottom: 4px; }
  .doc-no { text-align: right; margin: 6px 0 14px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th, td { border: 1px solid #444; padding: 5px 8px; text-align: left; }
  th { background: #f0f0f0; }
  .num { text-align: right; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin: 8px 0; }
  .label { color: #555; }
  .totals { margin-top: 8px; text-align: right; }
  .words { margin-top: 6px; font-size: 12px; }
  .sign { display: flex; justify-content: space-between; margin-top: 40px; }
  .sign div { width: 45%; border-top: 1px solid #444; padding-top: 4px; text-align: center; }
  @media print { body { margin: 0; } .page { padding: 0; width: auto; } }
`;

function infoGrid(d: DocData): string {
  const rows: string[] = [];
  const add = (label: string, value: unknown) => rows.push(`<div><span class="label">${esc(label)}：</span>${esc(value) || '—'}</div>`);
  add('卖方 / Seller', d.seller_name);
  add('买方 / Buyer', d.buyer_name);
  if (d.buyer_address) add('买方地址 / Address', d.buyer_address);
  if (d.consignee && d.consignee !== d.buyer_name) add('收货人 / Consignee', d.consignee);
  add('订单号 / Order No.', d.order_no);
  add('订单日期 / Order Date', d.order_date);
  add('贸易术语 / Incoterms', d.incoterms ? `${d.incoterms} Incoterms 2020` : '—');
  add('付款方式 / Payment', d.payment_terms);
  add('唛头 / Marks', d.marks);
  add('备注 / Remarks', d.remarks);
  return `<div class="info-grid">${rows.join('')}</div>`;
}

function itemsTable(d: DocData, showPrice: boolean): string {
  const head = showPrice
    ? '<tr><th>#</th><th>品名 / Description</th><th>型号 / Model</th><th class="num">数量 / Qty</th><th>单位 / Unit</th><th class="num">单价 / Unit Price</th><th class="num">金额 / Amount</th></tr>'
    : '<tr><th>#</th><th>品名 / Description</th><th>型号 / Model</th><th class="num">数量 / Qty</th><th>单位 / Unit</th></tr>';
  const rows = d.items.map((it, i) => showPrice
    ? `<tr><td>${i + 1}</td><td>${esc(it.name)}</td><td>${esc(it.model)}</td><td class="num">${it.qty}</td><td>${esc(it.unit)}</td><td class="num">${it.unit_price.toFixed(2)}</td><td class="num">${it.amount.toFixed(2)}</td></tr>`
    : `<tr><td>${i + 1}</td><td>${esc(it.name)}</td><td>${esc(it.model)}</td><td class="num">${it.qty}</td><td>${esc(it.unit)}</td></tr>`).join('');
  const totalRow = showPrice
    ? `<tr><td colspan="3"><b>合计 / TOTAL</b></td><td class="num"><b>${d.total_qty}</b></td><td></td><td></td><td class="num"><b>${d.currency} ${d.total_amount.toFixed(2)}</b></td></tr>`
    : `<tr><td colspan="3"><b>合计 / TOTAL</b></td><td class="num"><b>${d.total_qty}</b></td><td></td></tr>`;
  return `<table>${head}${rows}${totalRow}</table>`;
}

const TITLE: Record<DocType, string> = {
  pi: 'PROFORMA INVOICE', invoice: 'COMMERCIAL INVOICE', pl: 'PACKING LIST',
};

function plBlock(d: DocData): string {
  return `<div class="info-grid">
    <div><span class="label">箱数 / Cartons：</span>${esc(d.cartons) || '—'}</div>
    <div><span class="label">毛重 / G.W.：</span>${esc(d.gross_weight) || '—'}</div>
    <div><span class="label">净重 / N.W.：</span>${esc(d.net_weight) || '—'}</div>
    <div><span class="label">体积 / Volume：</span>${esc(d.volume) || '—'}</div>
  </div>`;
}

export function renderDocHtml(d: DocData): string {
  const showPrice = d.doc_type !== 'pl';
  const totals = showPrice
    ? `<div class="totals"><b>总金额 / Total Amount: ${esc(d.currency)} ${d.total_amount.toFixed(2)}</b></div>
       <div class="words">大写金额 / Amount in Words: ${esc(d.amount_in_words)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(d.doc_no)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="page">
  <h1>${TITLE[d.doc_type]}</h1>
  <div class="doc-no"><b>${esc(d.doc_no)}</b><br>Date: ${esc(d.doc_date)}</div>
  ${infoGrid(d)}
  ${d.doc_type === 'pl' ? plBlock(d) : ''}
  ${itemsTable(d, showPrice)}
  ${totals}
  <div class="sign"><div>For the Seller（卖方签章）</div><div>Accepted by the Buyer（买方确认）</div></div>
</div>
</body>
</html>`;
}
