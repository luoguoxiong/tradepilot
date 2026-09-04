import type { FastifyInstance } from 'fastify';
import { db, touchOrder, type Order, type OrderItem } from './db.js';
import { importAndParse } from './services/order-parse.js';
import { INCOTERMS } from './prompts/order-parse.js';
import { generateMailDraft, type MailKind, type MailTone, NODE_LABELS } from './prompts/order-mail.js';
import {
  DOC_TYPES, buildDocData, validateDoc, renderDocHtml, amountInWords,
  type DocType, type DocOverride,
} from './services/docs.js';
import { computeAnomalies } from './services/anomalies.js';
import { getSmtp, saveSmtp, testSmtp, encryptSecret, sendMail } from './services/mailer.js';
import { getSetting, setSetting } from './db.js';
import { getRules } from './services/anomalies.js';

const ok = (data: unknown) => ({ code: 0, message: 'ok', data });
const fail = (msg: string, code = 1) => ({ code, message: msg, data: null });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NODES = Object.keys(NODE_LABELS);

/** 订单创建/更新的请求体结构 */
interface OrderPayload {
  order_no?: string; customer_name?: string; customer_email?: string;
  order_date?: string; delivery_date?: string; incoterms?: string;
  payment_terms?: string; currency?: string; total_amount?: number; remarks?: string;
  items?: Array<{ name?: string; model?: string; qty?: number; unit?: string; unit_price?: number }>;
}

function normalizeItems(orderId: number, raw: OrderPayload['items']): { items: OrderItem[]; error: string | null } {
  const items: OrderItem[] = [];
  if (!Array.isArray(raw) || !raw.length) return { items, error: '产品行不能为空' };
  raw.forEach((it, i) => {
    const qty = Number(it.qty) || 0;
    const price = Number(it.unit_price) || 0;
    if (!String(it.name || '').trim()) return; // 空行跳过
    items.push({
      order_id: orderId, name: String(it.name).trim(), model: String(it.model || '').trim(),
      qty, unit: String(it.unit || '').trim(), unit_price: price,
      amount: Math.round(qty * price * 100) / 100, sort: i,
    });
  });
  if (!items.length) return { items, error: '至少需要一行有效产品（品名必填）' };
  return { items, error: null };
}

/** 校验并规范化订单头字段；返回错误或规范化后的值 */
function validateOrderHead(b: OrderPayload): string | null {
  if (!String(b.customer_name || '').trim()) return '客户名必填';
  if (b.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.customer_email)) return '客户邮箱格式不正确';
  for (const k of ['order_date', 'delivery_date'] as const) {
    if (b[k] && !ISO_DATE.test(String(b[k]))) return `${k} 必须是 YYYY-MM-DD`;
  }
  if (b.incoterms && !INCOTERMS.includes(String(b.incoterms).toUpperCase())) return `incoterms 必须是 ${INCOTERMS.join('/')}`;
  if (b.currency && !/^[A-Za-z]{3}$/.test(String(b.currency))) return '币种必须是 3 位字母';
  return null;
}

function getOrderWithItems(id: number) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Order | undefined;
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort, id').all(id) as unknown as OrderItem[];
  return { order, items };
}

export function registerOrderRoutes(app: FastifyInstance) {
  // —— 导入解析（文件 base64 或粘贴文本）——
  app.post('/api/orders/import', async (req: any) => {
    const b = req.body || {};
    if (!b.fileName && !b.text?.trim()) return fail('请上传文件或粘贴订单文本');
    let buf: Buffer | null = null;
    if (b.contentBase64) {
      try { buf = Buffer.from(b.contentBase64, 'base64'); } catch { return fail('文件内容解码失败'); }
      if (buf.length > 8 * 1024 * 1024) return fail('文件过大（>8MB）');
    }
    try {
      const r = await importAndParse(String(b.fileName || ''), buf, b.text ? String(b.text) : null);
      return ok(r);
    } catch (e) {
      return fail(`订单解析失败：${(e as Error).message}`);
    }
  });

  // —— 确认建单（从暂存导入或手动录入）——
  app.post('/api/orders', (req: any) => {
    const b = req.body || {};
    const headErr = validateOrderHead(b.order || {});
    if (headErr) return fail(headErr);
    const p = b.order as OrderPayload;

    // total_amount：优先用前端提交值；未提交则用行金额合计（确定性计算，不让 LLM 定数）
    const { items, error } = normalizeItems(0, b.items || p.items);
    if (error) return fail(error);
    const sumAmount = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
    const totalAmount = p.total_amount != null && Number(p.total_amount) > 0 ? Number(p.total_amount) : sumAmount;
    if (Math.abs(totalAmount - sumAmount) > 0.01) return fail(`总金额（${totalAmount}）与产品行合计（${sumAmount}）不一致，请核对`);

    const importId = b.importId ? Number(b.importId) : null;
    if (importId) {
      const imp = db.prepare(`SELECT * FROM order_imports WHERE id=?`).get(importId) as any;
      if (!imp || imp.status !== 'parsed') return fail('导入记录不存在或已处理');
    }

    const create = db.transaction(() => {
      const ins = db.prepare(`INSERT INTO orders(order_no, customer_name, customer_email, order_date, delivery_date, incoterms, payment_terms, currency, total_amount, remarks, source_type, source_file_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        String(p.order_no || '').trim(), String(p.customer_name).trim(), String(p.customer_email || '').trim(),
        p.order_date || '', p.delivery_date || '', p.incoterms ? String(p.incoterms).toUpperCase() : '',
        String(p.payment_terms || '').trim(), String(p.currency || 'USD').toUpperCase(),
        totalAmount, String(p.remarks || '').trim(),
        importId ? 'upload' : 'manual', importId ? (db.prepare('SELECT file_name FROM order_imports WHERE id=?').get(importId) as any)?.file_name || '' : '',
      );
      const orderId = Number(ins.lastInsertRowid);
      const insItem = db.prepare(`INSERT INTO order_items(order_id, name, model, qty, unit, unit_price, amount, sort) VALUES (?,?,?,?,?,?,?,?)`);
      for (const it of items) insItem.run(orderId, it.name, it.model, it.qty, it.unit, it.unit_price, it.amount, it.sort);
      db.prepare(`INSERT INTO order_events(order_id, node, event_date, note) VALUES (?,?,?,?)`)
        .run(orderId, 'created', new Date().toISOString().slice(0, 10), importId ? '导入解析确认入库' : '手动录入');
      if (importId) db.prepare(`UPDATE order_imports SET status='confirmed' WHERE id=?`).run(importId);
      return orderId;
    });
    const orderId = create();
    return ok(getOrderWithItems(orderId));
  });

  // —— 订单列表（附当前节点与未处理异常）——
  app.get('/api/orders', (req: any) => {
    const { status } = req.query;
    const where = status ? `WHERE status=?` : '';
    const orders = db.prepare(`SELECT * FROM orders ${where} ORDER BY (delivery_date=''), delivery_date ASC, id DESC`)
      .all(...(status ? [status] : [])) as Order[];
    const nodeStmt = db.prepare(`SELECT node FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1`);
    const anomalies = computeAnomalies();
    const byOrder = new Map<number, string[]>();
    for (const a of anomalies) {
      const arr = byOrder.get(a.order_id) || [];
      arr.push(a.type);
      byOrder.set(a.order_id, arr);
    }
    const rows = orders.map((o) => {
      const lastNode = (nodeStmt.get(o.id) as any)?.node || '';
      const dlv = o.delivery_date ? new Date(o.delivery_date + 'T00:00:00') : null;
      const daysLeft = dlv ? Math.round((dlv.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000) : null;
      return { ...o, current_node: lastNode, days_left: daysLeft, anomaly_types: byOrder.get(o.id) || [] };
    });
    return ok(rows);
  });

  // —— 订单详情聚合 ——
  app.get('/api/orders/:id', (req: any) => {
    const withItems = getOrderWithItems(Number(req.params.id));
    if (!withItems) return fail('订单不存在');
    const events = db.prepare(`SELECT * FROM order_events WHERE order_id=? ORDER BY id ASC`).all(withItems.order.id);
    const docs = db.prepare(`SELECT id, doc_type, doc_no, version, overrides_json, note, created_at FROM order_docs WHERE order_id=? ORDER BY id DESC`).all(withItems.order.id);
    const mails = db.prepare(`SELECT * FROM order_mails WHERE order_id=? ORDER BY id DESC`).all(withItems.order.id);
    return ok({ ...withItems.order, items: withItems.items, events, docs, mails, nodes: NODE_LABELS });
  });

  // —— 编辑订单（整体替换产品行）——
  app.put('/api/orders/:id', (req: any) => {
    const id = Number(req.params.id);
    const existed = db.prepare('SELECT id FROM orders WHERE id=?').get(id);
    if (!existed) return fail('订单不存在');
    const b = req.body || {};
    const headErr = validateOrderHead(b.order || {});
    if (headErr) return fail(headErr);
    const p = b.order as OrderPayload;
    const { items, error } = normalizeItems(id, b.items || p.items);
    if (error) return fail(error);
    const sumAmount = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
    const totalAmount = p.total_amount != null && Number(p.total_amount) > 0 ? Number(p.total_amount) : sumAmount;
    if (Math.abs(totalAmount - sumAmount) > 0.01) return fail(`总金额（${totalAmount}）与产品行合计（${sumAmount}）不一致，请核对`);

    const update = db.transaction(() => {
      db.prepare(`UPDATE orders SET order_no=?, customer_name=?, customer_email=?, order_date=?, delivery_date=?, incoterms=?, payment_terms=?, currency=?, total_amount=?, remarks=?, updated_at=datetime('now') WHERE id=?`)
        .run(String(p.order_no || '').trim(), String(p.customer_name).trim(), String(p.customer_email || '').trim(),
          p.order_date || '', p.delivery_date || '', p.incoterms ? String(p.incoterms).toUpperCase() : '',
          String(p.payment_terms || '').trim(), String(p.currency || 'USD').toUpperCase(), totalAmount,
          String(p.remarks || '').trim(), id);
      db.prepare(`DELETE FROM order_items WHERE order_id=?`).run(id);
      const insItem = db.prepare(`INSERT INTO order_items(order_id, name, model, qty, unit, unit_price, amount, sort) VALUES (?,?,?,?,?,?,?,?)`);
      for (const it of items) insItem.run(id, it.name, it.model, it.qty, it.unit, it.unit_price, it.amount, it.sort);
    });
    update();
    touchOrder.run(id);
    return ok(getOrderWithItems(id));
  });

  // —— 订单状态（关闭/取消/恢复）——
  app.post('/api/orders/:id/status', (req: any) => {
    const s = String(req.body?.status || '');
    if (!['active', 'closed', 'cancelled'].includes(s)) return fail('status 必须是 active/closed/cancelled');
    const r = db.prepare(`UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?`).run(s, req.params.id);
    if (!r.changes) return fail('订单不存在');
    return ok(true);
  });

  // —— 进度事件 ——
  app.post('/api/orders/:id/events', (req: any) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM orders WHERE id=?').get(id)) return fail('订单不存在');
    const node = String(req.body?.node || '');
    if (!NODES.includes(node)) return fail(`node 必须是：${NODES.join('/')}`);
    const eventDate = req.body?.event_date || new Date().toISOString().slice(0, 10);
    if (!ISO_DATE.test(eventDate)) return fail('event_date 必须是 YYYY-MM-DD');
    db.prepare(`INSERT INTO order_events(order_id, node, event_date, note) VALUES (?,?,?,?)`)
      .run(id, node, eventDate, String(req.body?.note || '').trim());
    touchOrder.run(id);
    return ok(db.prepare(`SELECT * FROM order_events WHERE order_id=? ORDER BY id ASC`).all(id));
  });

  // —— 单证生成（确定性：订单数据 + 可选人工微调 → 校验 → 渲染 → 快照）——
  app.post('/api/orders/:id/docs', (req: any) => {
    const id = Number(req.params.id);
    const withItems = getOrderWithItems(id);
    if (!withItems) return fail('订单不存在');
    const docType = String(req.body?.doc_type || '') as DocType;
    if (!DOC_TYPES.includes(docType)) return fail(`doc_type 必须是 ${DOC_TYPES.join('/')}`);
    const overrides: DocOverride = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
    const note = String(req.body?.note || '').trim();
    // 人工微调必须留痕（红线：可追溯）
    if (Object.keys(overrides).length && !note) return fail('使用人工微调字段时必须填写微调原因（note）');

    const data = buildDocData(withItems.order, withItems.items, docType, overrides);
    data.amount_in_words = amountInWords(data.total_amount, data.currency);
    const count = db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS v FROM order_docs WHERE order_id=? AND doc_type=?`).get(id, docType) as any;
    data.doc_no = `${withItems.order.order_no || `ORD-${id}`}-${docType.toUpperCase()}-v${count.v}`;

    const issues = validateDoc(data);
    if (issues.length) return { code: 2, message: '单证校验未通过，已阻断生成', data: { issues } };

    const html = renderDocHtml(data);
    const ins = db.prepare(`INSERT INTO order_docs(order_id, doc_type, doc_no, version, data_json, html, overrides_json, note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, docType, data.doc_no, count.v, JSON.stringify(data), html, Object.keys(overrides).length ? JSON.stringify(overrides) : null, note);
    touchOrder.run(id);
    return ok({ id: Number(ins.lastInsertRowid), doc_no: data.doc_no, version: count.v, html_url: `/api/docs/${ins.lastInsertRowid}/html` });
  });

  // —— 单证 HTML 预览 ——
  app.get('/api/docs/:id/html', (req: any, reply: any) => {
    const doc = db.prepare(`SELECT html FROM order_docs WHERE id=?`).get(req.params.id) as any;
    if (!doc) return reply.code(404).send('not found');
    reply.header('Content-Type', 'text/html; charset=utf-8').send(doc.html);
  });

  // —— 异常看板（实时计算）——
  app.get('/api/anomalies', () => ok(computeAnomalies()));

  // —— 邮件草稿生成（LLM）——
  app.post('/api/orders/:id/mail', async (req: any) => {
    const id = Number(req.params.id);
    const withItems = getOrderWithItems(id);
    if (!withItems) return fail('订单不存在');
    const b = req.body || {};
    const kind = String(b.kind || 'progress');
    if (!['progress', 'chase', 'custom'].includes(kind)) return fail('kind 必须是 progress/chase/custom');
    const to = String(b.to || withItems.order.customer_email || '').trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail('收件邮箱缺失或格式不正确');
    const tone: MailTone = b.tone === 'formal' ? 'formal' : 'gentle';
    const language = String(b.language || 'en');
    try {
      const draft = await generateMailDraft({
        kind: kind === 'chase' ? 'chase' : 'progress', tone, language,
        order: withItems.order as unknown as Record<string, unknown>,
        items: withItems.items as unknown as Array<Record<string, unknown>>,
        events: db.prepare(`SELECT node, event_date, note FROM order_events WHERE order_id=? ORDER BY id ASC`).all(id) as any[],
        anomalyMessage: b.anomalyMessage ? String(b.anomalyMessage) : undefined,
        extraNote: b.extraNote ? String(b.extraNote) : undefined,
      });
      const ins = db.prepare(`INSERT INTO order_mails(order_id, kind, to_addr, subject, body) VALUES (?,?,?,?,?)`)
        .run(id, kind, to, draft.subject, draft.body);
      return ok(db.prepare(`SELECT * FROM order_mails WHERE id=?`).get(ins.lastInsertRowid));
    } catch (e) {
      return fail(`邮件草稿生成失败：${(e as Error).message}`);
    }
  });

  // —— 编辑草稿 ——
  app.put('/api/mails/:id', (req: any) => {
    const id = Number(req.params.id);
    const mail = db.prepare(`SELECT * FROM order_mails WHERE id=?`).get(id) as any;
    if (!mail) return fail('邮件不存在');
    if (mail.status === 'sent') return fail('已发送邮件不可修改');
    const subject = String(req.body?.subject ?? mail.subject).trim();
    const body = String(req.body?.body ?? mail.body);
    if (!subject || !body.trim()) return fail('主题与正文不能为空');
    db.prepare(`UPDATE order_mails SET subject=?, body=? WHERE id=?`).run(subject, body, id);
    return ok(db.prepare(`SELECT * FROM order_mails WHERE id=?`).get(id));
  });

  // —— 发送邮件（红线：仅草稿/失败态可发，由用户显式触发）——
  app.post('/api/mails/:id/send', async (req: any) => {
    const id = Number(req.params.id);
    const mail = db.prepare(`SELECT * FROM order_mails WHERE id=?`).get(id) as any;
    if (!mail) return fail('邮件不存在');
    if (mail.status === 'sent') return fail('该邮件已发送');
    try {
      const messageId = await sendMail({ to: mail.to_addr, subject: mail.subject, body: mail.body });
      db.prepare(`UPDATE order_mails SET status='sent', sent_at=datetime('now'), error=NULL WHERE id=?`).run(id);
      return ok({ message_id: messageId });
    } catch (e) {
      db.prepare(`UPDATE order_mails SET status='failed', error=? WHERE id=?`).run((e as Error).message.slice(0, 500), id);
      return fail(`发送失败：${(e as Error).message}`);
    }
  });

  // —— 设置 ——
  app.get('/api/settings', () => {
    const smtp = getSmtp();
    return ok({
      smtp: smtp ? { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, sender_name: smtp.sender_name, has_password: !!smtp.pass_enc } : null,
      reminder_rules: getRules(),
    });
  });

  app.put('/api/settings', (req: any) => {
    const b = req.body || {};
    if (b.smtp) {
      const s = b.smtp;
      if (s.host && !String(s.user || '').includes('@')) return fail('SMTP 账号必须是邮箱');
      const cur = getSmtp() || { host: '', port: 465, secure: true, user: '', sender_name: '' };
      const next = {
        host: String(s.host ?? cur.host), port: Number(s.port ?? cur.port) || 465,
        secure: s.secure != null ? !!s.secure : cur.secure,
        user: String(s.user ?? cur.user), sender_name: String(s.sender_name ?? cur.sender_name),
      } as any;
      // 密码只在提供新值时更新（write-only）
      if (s.pass) next.pass_enc = encryptSecret(String(s.pass));
      saveSmtp(next as any);
    }
    if (b.reminder_rules) {
      const r = b.reminder_rules;
      const days: number[] = Array.isArray(r.days_before)
        ? r.days_before.map(Number).filter((n: number) => n >= 0 && n <= 90)
        : [];
      setSetting('reminder_rules', {
        days_before: days.length ? [...new Set(days)].sort((a, z) => z - a).slice(0, 5) : getRules().days_before,
        deposit_days: Number(r.deposit_days) > 0 ? Number(r.deposit_days) : getRules().deposit_days,
        stalled_days: Number(r.stalled_days) > 0 ? Number(r.stalled_days) : getRules().stalled_days,
      });
    }
    return ok(true);
  });

  app.post('/api/settings/smtp/test', async () => {
    try {
      await testSmtp();
      return ok({ ok: true });
    } catch (e) {
      return fail(`SMTP 连接失败：${(e as Error).message}`);
    }
  });
}
