/**
 * 订单单证确定性逻辑单测（红线R1：数字全部来自订单，精确断言）
 * 覆盖：英文大写金额 / buildDocData 金额计算 / validateDoc 一致性校验
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, buildDocData, validateDoc, type DocData } from '../services/docs.js';
import type { Order, OrderItem } from '../db.js';

const mockOrder = (over: Partial<Order> = {}): Order => ({
  id: 1, order_no: 'PO-001', customer_name: 'Acme GmbH', customer_email: 'b@a.com',
  order_date: '2026-08-20', delivery_date: '2026-09-01', incoterms: 'FOB',
  payment_terms: 'T/T 30%', currency: 'USD', total_amount: 4500, status: 'active',
  remarks: '', source_type: 'manual', source_file_name: '', created_at: '', updated_at: '',
  ...over,
});
const mockItems = (): OrderItem[] => [
  { name: 'LED Panel', model: 'LP-40W', qty: 1000, unit: 'pcs', unit_price: 4.5, amount: 4500 },
];

test('amountInWords: 整数金额', () => {
  assert.equal(amountInWords(4500, 'USD'), 'Four Thousand Five Hundred US Dollars Only');
});
test('amountInWords: 含分', () => {
  assert.equal(amountInWords(12150.56, 'USD'), 'Twelve Thousand One Hundred Fifty US Dollars and Fifty-Six Cents Only');
});
test('amountInWords: 百万位', () => {
  assert.match(amountInWords(1234567.89, 'EUR'), /^One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven Euros and Eighty-Nine Cents Only$/);
});
test('amountInWords: 零', () => {
  assert.equal(amountInWords(0, 'USD'), 'Zero US Dollars Only');
});
test('amountInWords: 非标币种回退', () => {
  assert.match(amountInWords(88, 'XXX'), /XXX Dollars Only$/);
});

test('buildDocData: 行金额=数量×单价（自动计算，不信任输入）', () => {
  const items = [{ name: 'A', model: '', qty: 3, unit: 'pcs', unit_price: 10.105, amount: 0 }];
  const d = buildDocData(mockOrder(), items, 'pi');
  assert.equal(d.items[0].amount, 30.32); // 30.315 → 分四舍五入 30.32
  assert.equal(d.total_amount, 30.32);
  assert.equal(d.amount_in_words, '');
});
test('buildDocData: 单证号规则由调用方填充，此处为空', () => {
  const d = buildDocData(mockOrder(), mockItems(), 'pi');
  assert.equal(d.doc_no, '');
});

const fullDoc = (over: Partial<DocData> = {}): DocData => {
  const d = buildDocData(mockOrder(), mockItems(), 'pi');
  d.amount_in_words = amountInWords(d.total_amount, d.currency);
  d.seller_name = 'Seller Ltd';
  return { ...d, ...over };
};

test('validateDoc: 合法单证零问题（红线R1通过路径）', () => {
  assert.deepEqual(validateDoc(fullDoc()), []);
});
test('validateDoc: 行金额与数量×单价不一致必须拦截', () => {
  const d = fullDoc();
  d.items[0].amount = 999;
  const issues = validateDoc(d);
  assert.ok(issues.some((s) => s.includes('数量×单价')));
});
test('validateDoc: 合计与总额不一致必须拦截', () => {
  const d = fullDoc({ total_amount: 100 });
  const issues = validateDoc(d);
  assert.ok(issues.some((s) => s.includes('总金额')));
});
test('validateDoc: 缺买方信息必须拦截', () => {
  const d = fullDoc({ buyer_name: '' });
  assert.ok(validateDoc(d).length > 0);
});
test('validateDoc: 装箱单缺箱数必须拦截', () => {
  const d = fullDoc({ doc_type: 'pl' });
  assert.ok(validateDoc(d).some((s) => s.includes('箱数')));
});
test('validateDoc: 装箱单补箱数后通过', () => {
  const d = fullDoc({ doc_type: 'pl', cartons: '50' });
  assert.deepEqual(validateDoc(d), []);
});
test('renderDocHtml: 含关键要素（单证号/大写金额/买卖双方）', async () => {
  const { renderDocHtml } = await import('../services/docs.js');
  const html = renderDocHtml(fullDoc({ doc_no: 'PO-001-PI-v1' }));
  assert.ok(html.includes('PO-001-PI-v1'));
  assert.ok(html.includes('Four Thousand Five Hundred'));
  assert.ok(html.includes('Acme GmbH'));
  assert.ok(html.includes('PROFORMA INVOICE'));
});
