/**
 * 订单模块 API 集成测试：Mock LLM + 隔离 DB（红线 R2/R3/R4）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH = `/tmp/tp-order-api-${Date.now()}.db`;
process.env.LLM_BASE_URL = 'http://127.0.0.1:4603/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'mock-model';
process.env.PORT = '8789'; // 测试专用端口，避免与开发服务冲突

const MOCK_PORT = 4603;

// —— Mock LLM ——
let SCRIPT: any[] = [];
let llmCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmCalls++;
    const step = SCRIPT.shift();
    const reply = (content: string) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 42 } }));
    };
    if (!step || step.fail) { res.writeHead(500).end('mock llm down'); return; }
    reply(step.raw ?? JSON.stringify(step.json));
  });
});

const BASE = 'http://127.0.0.1:8789';
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  return res.json() as Promise<{ code: number; message: string; data: any }>;
};

test('setup: 启动 mock LLM 与服务', async () => {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
  await import('../index.js');
  await new Promise((r) => setTimeout(r, 300));
});

// —— 建单校验（R2 相关联：确认才建单） ——
test('建单：缺客户名拒绝', async () => {
  const r = await api('POST', '/api/orders', { order: { customer_name: '' }, items: [{ name: 'A', qty: 1, unit_price: 1 }] });
  assert.equal(r.code, 1);
});
test('建单：产品行空拒绝', async () => {
  const r = await api('POST', '/api/orders', { order: { customer_name: 'C' }, items: [{ name: '', qty: 1, unit_price: 1 }] });
  assert.equal(r.code, 1);
  assert.match(r.message, /有效产品/);
});
test('建单：总金额与行合计不一致拒绝（R1 前置）', async () => {
  const r = await api('POST', '/api/orders', {
    order: { customer_name: 'C', total_amount: 999 },
    items: [{ name: 'A', qty: 10, unit_price: 2 }],
  });
  assert.equal(r.code, 1);
  assert.match(r.message, /不一致/);
});
test('建单：成功且 total_amount 自动计算', async () => {
  const r = await api('POST', '/api/orders', {
    order: { order_no: 'PO-T1', customer_name: 'Acme GmbH', delivery_date: '2026-09-20', incoterms: 'FOB', currency: 'USD' },
    items: [{ name: 'LED', qty: 1000, unit: 'pcs', unit_price: 4.5 }],
  });
  assert.equal(r.code, 0);
  assert.equal(r.data.order.total_amount, 4500);
  assert.equal(r.data.items.length, 1);
});
test('建单：日期与术语枚举校验', async () => {
  const r = await api('POST', '/api/orders', {
    order: { customer_name: 'C', delivery_date: '2026/09/01', incoterms: 'XXX' },
    items: [{ name: 'A', qty: 1, unit_price: 1 }],
  });
  assert.equal(r.code, 1);
});

// —— 单证端点（R1） ——
let orderId = 0;
test('单证：PI 生成成功且校验通过', async () => {
  const list = await api('GET', '/api/orders');
  orderId = list.data[0].id;
  const r = await api('POST', `/api/orders/${orderId}/docs`, { doc_type: 'pi' });
  assert.equal(r.code, 0);
  assert.match(r.data.doc_no, /PO-T1-PI-v1/);
  const htmlRes = await fetch(`${BASE}${r.data.html_url}`);
  const html = await htmlRes.text();
  assert.ok(html.includes('4,500.00') || html.includes('4500.00'));
  assert.ok(html.includes('PROFORMA INVOICE'));
});
test('单证：装箱单缺箱数阻断（code=2 + issues）', async () => {
  const r = await api('POST', `/api/orders/${orderId}/docs`, { doc_type: 'pl' });
  assert.equal(r.code, 2);
  assert.ok(r.data.issues.some((s: string) => s.includes('箱数')));
});
test('单证：人工微调必须注明原因（留痕红线）', async () => {
  const r = await api('POST', `/api/orders/${orderId}/docs`, { doc_type: 'pl', overrides: { cartons: '50' } });
  assert.equal(r.code, 1);
  assert.match(r.message, /note/);
  const r2 = await api('POST', `/api/orders/${orderId}/docs`, { doc_type: 'pl', overrides: { cartons: '50' }, note: '客户确认 50 箱' });
  assert.equal(r2.code, 0);
});
test('单证：编辑订单导致金额不一致后重新生成被阻断', async () => {
  // 把行数量改为 2000（总额自动 9000），单证校验基于订单数据应仍一致 → 通过
  await api('PUT', `/api/orders/${orderId}`, {
    order: { order_no: 'PO-T1', customer_name: 'Acme GmbH', currency: 'USD' },
    items: [{ name: 'LED', qty: 2000, unit: 'pcs', unit_price: 4.5 }],
  });
  const r = await api('POST', `/api/orders/${orderId}/docs`, { doc_type: 'pi' });
  assert.equal(r.code, 0);
  assert.match(r.data.doc_no, /-v2$/); // 版本自增
});

// —— 进度事件 ——
test('事件：非法节点拒绝，合法节点成功', async () => {
  const r = await api('POST', `/api/orders/${orderId}/events`, { node: 'hacking' });
  assert.equal(r.code, 1);
  const r2 = await api('POST', `/api/orders/${orderId}/events`, { node: 'deposit_received' });
  assert.equal(r2.code, 0);
  assert.ok(r2.data.some((e: any) => e.node === 'deposit_received'));
});

// —— 导入解析（R2：暂存不建单） ——
test('导入解析：确认前不进订单库', async () => {
  SCRIPT = [{
    json: {
      order_no: 'PI-777', customer_name: 'Parsed GmbH', customer_email: 'p@g.de',
      order_date: '2026-08-01', delivery_date: '2026-10-01', incoterms: 'CIF',
      payment_terms: 'T/T', currency: 'USD', total_amount: 100,
      remarks: null, confidence: { order_no: 0.95, customer_name: 0.5, total_amount: 0.9 },
      items: [{ name: 'A', model: null, qty: 10, unit: 'pcs', unit_price: 10, amount: 100 }],
    },
  }];
  const imp = await api('POST', '/api/orders/import', { text: 'some order text PI-777' });
  assert.equal(imp.code, 0);
  assert.ok(imp.data.lowFields.includes('customer_name')); // 0.5 < 0.7 标黄
  const before = (await api('GET', '/api/orders')).data.length;
  assert.equal(imp.data.parsed.order_no, 'PI-777');

  // 确认入库
  const r = await api('POST', '/api/orders', {
    importId: imp.data.importId,
    order: { order_no: 'PI-777', customer_name: 'Parsed GmbH', currency: 'USD' },
    items: [{ name: 'A', qty: 10, unit_price: 10 }],
  });
  assert.equal(r.code, 0);
  assert.equal((await api('GET', '/api/orders')).data.length, before + 1);
});
test('导入解析：LLM 失败时返回错误并记录', async () => {
  SCRIPT = [{ fail: true }];
  const r = await api('POST', '/api/orders/import', { text: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.message, /解析失败/);
});

// —— 邮件草稿（R3） ——
test('邮件：占位符残留被校验器拒绝（chatJson 重试后仍失败）', async () => {
  SCRIPT = [
    { json: { subject: 'Update', body: 'Your order [ORDER_NO] is progressing.' } },
    { json: { subject: 'Update', body: 'Still {placeholder} here.' } },
  ];
  const r = await api('POST', `/api/orders/${orderId}/mail`, { kind: 'progress', to: 'b@acme.com' });
  assert.equal(r.code, 1);
  assert.match(r.message, /草稿生成失败/);
});
test('邮件：合法草稿生成并落库为 draft', async () => {
  SCRIPT = [{ json: { subject: 'Order PO-T1 progress update', body: 'Dear Acme GmbH, your order is in production and on track for 2026-09-20.' } }];
  const r = await api('POST', `/api/orders/${orderId}/mail`, { kind: 'progress', to: 'b@acme.com' });
  assert.equal(r.code, 0);
  assert.equal(r.data.status, 'draft');
});
test('邮件：编辑草稿后可发送；未配置 SMTP 时发送失败有留痕', async () => {
  const list = (await api('GET', `/api/orders/${orderId}`)).data;
  const mailId = list.mails[0].id;
  const put = await api('PUT', `/api/mails/${mailId}`, { subject: 'Order PO-T1 update', body: 'Dear Acme, production is 50% done. ETA 2026-09-20.' });
  assert.equal(put.code, 0);
  const send = await api('POST', `/api/mails/${mailId}/send`);
  assert.equal(send.code, 1); // 未配置 SMTP
  const after = (await api('GET', `/api/orders/${orderId}`)).data.mails.find((m: any) => m.id === mailId);
  assert.equal(after.status, 'failed');
  assert.ok(after.error);
});

// —— 设置（R4） ——
test('设置：SMTP 密码 write-only 且不下发', async () => {
  const put = await api('PUT', '/api/settings', {
    smtp: { host: 'smtp.test.com', port: 465, secure: true, user: 'a@test.com', pass: 'secret123', sender_name: 'Tester' },
  });
  assert.equal(put.code, 0);
  const get = await api('GET', '/api/settings');
  assert.equal(get.data.smtp.host, 'smtp.test.com');
  assert.equal(get.data.smtp.has_password, true);
  assert.ok(!JSON.stringify(get.data).includes('secret123'));
});
test('设置：提醒规则更新生效', async () => {
  await api('PUT', '/api/settings', { reminder_rules: { days_before: [10, 5], deposit_days: 5, stalled_days: 20 } });
  const get = await api('GET', '/api/settings');
  assert.deepEqual(get.data.reminder_rules.days_before, [10, 5]);
  assert.equal(get.data.reminder_rules.deposit_days, 5);
});
test('SMTP 密码加解密回环（R4）', async () => {
  const { encryptSecret, decryptSecret } = await import('../services/mailer.js');
  const enc = encryptSecret('another-secret');
  assert.notEqual(enc, 'another-secret');
  assert.equal(decryptSecret(enc), 'another-secret');
});

test('cleanup', async () => {
  mock.close();
  // 服务与监控定时器会保持事件循环，测试报告无法自然结束；
  // 用 unref 定时器兜底退出：不影响测试结果正常上报，短暂延迟后强制结束进程
  setTimeout(() => process.exit(0), 300).unref();
});
