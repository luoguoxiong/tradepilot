import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { runSearch, isBlocked, domainOf } from './providers/search.js';
import { enqueue, getTaskStats } from './services/queue.js';
import { generateEmail, buildEml } from './services/outreach.js';

const ok = (data: unknown) => ({ code: 0, message: 'ok', data });
const fail = (msg: string, code = 1) => ({ code, message: msg, data: null });

/** 搜索 query 组合：关键词 × (wholesale/importer/distributor) × 目标市场 */
function buildQueries(keywords: string, markets: string): string[] {
  const kws = keywords.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const mks = markets.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const intents = ['wholesale', 'importer', 'distributor'];
  const queries: string[] = [];
  for (const kw of kws) {
    for (const intent of intents) {
      queries.push(`"${kw}" ${intent}${mks.length ? ' ' + mks.join(' OR ') : ''}`);
    }
  }
  return queries.slice(0, 6);
}

export function registerRoutes(app: FastifyInstance) {
  // —— 产品档案 ——
  app.get('/api/profiles', () => ok(db.prepare('SELECT * FROM profiles ORDER BY id DESC').all()));

  app.post('/api/profiles', (req: any) => {
    const b = req.body || {};
    if (!b.name?.trim()) return fail('name 必填');
    const r = db.prepare('INSERT INTO profiles(name, product_desc, keywords, markets, advantages) VALUES (?,?,?,?,?)')
      .run(b.name.trim(), b.product_desc || '', b.keywords || '', b.markets || '', b.advantages || '');
    return ok(db.prepare('SELECT * FROM profiles WHERE id=?').get(r.lastInsertRowid));
  });

  app.put('/api/profiles/:id', (req: any) => {
    const b = req.body || {};
    const r = db.prepare('UPDATE profiles SET name=?, product_desc=?, keywords=?, markets=?, advantages=? WHERE id=?')
      .run(b.name, b.product_desc || '', b.keywords || '', b.markets || '', b.advantages || '', req.params.id);
    if (!r.changes) return fail('档案不存在');
    return ok(db.prepare('SELECT * FROM profiles WHERE id=?').get(req.params.id));
  });

  app.delete('/api/profiles/:id', (req: any) => {
    const leads = db.prepare('SELECT COUNT(*) c FROM leads WHERE profile_id=?').get(req.params.id) as any;
    if (leads.c > 0) return fail('该档案下已有线索，不能删除');
    db.prepare('DELETE FROM profiles WHERE id=?').run(req.params.id);
    return ok(true);
  });

  // —— 自动搜索 ——
  app.post('/api/search', async (req: any) => {
    const b = req.body || {};
    const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(b.profileId) as any;
    if (!profile) return fail('产品档案不存在');
    const keywords = b.keywords?.trim() || profile.keywords;
    const markets = b.markets?.trim() || profile.markets;
    if (!keywords) return fail('缺少搜索关键词，请先在产品档案中配置');
    const queries = buildQueries(keywords, markets);
    const seen = new Set<string>();
    const candidates: any[] = [];
    const perQueryErrors: string[] = [];
    for (const q of queries) {
      try {
        const results = await runSearch(q, 10, b.provider);
        for (const r of results) {
          if (!r.domain || seen.has(r.domain) || isBlocked(r.url)) continue;
          seen.add(r.domain);
          const exists = db.prepare('SELECT id FROM leads WHERE profile_id=? AND domain=?').get(profile.id, r.domain);
          if (exists) continue; // 已有线索不重复入库
          const ins = db.prepare(`INSERT INTO leads(profile_id, company_name, domain, source_url, source_query, snippet) VALUES (?,?,?,?,?,?)`)
            .run(profile.id, r.title.replace(/\s*[|\-–].*$/, '').slice(0, 100), r.domain, r.url, q, r.snippet);
          candidates.push({ id: Number(ins.lastInsertRowid), company_name: r.title, domain: r.domain, source_url: r.url, source_query: q, snippet: r.snippet, status: 'new' });
        }
      } catch (e) {
        perQueryErrors.push(`${q}: ${(e as Error).message}`);
      }
    }
    return ok({ candidates, queries, errors: perQueryErrors });
  });

  // —— 粘贴导入 ——
  app.post('/api/leads/import', (req: any) => {
    const b = req.body || {};
    const items: string[] = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return fail('items 不能为空');
    const created: any[] = [];
    for (const raw of items) {
      const item = String(raw).trim();
      if (!item) continue;
      let company = item, url = '', domain = '';
      if (/^https?:\/\//i.test(item) || /^[\w-]+\.[a-z]{2,}/i.test(item)) {
        url = /^https?:\/\//i.test(item) ? item : `https://${item}`;
        domain = domainOf(url);
        company = domain;
        if (!domain || isBlocked(url)) continue;
      }
      const exists = domain
        ? db.prepare('SELECT id FROM leads WHERE profile_id=? AND domain=?').get(b.profileId, domain)
        : db.prepare('SELECT id FROM leads WHERE profile_id=? AND company_name=?').get(b.profileId, company);
      if (exists) continue;
      const ins = db.prepare(`INSERT INTO leads(profile_id, company_name, domain, source_url) VALUES (?,?,?,?)`)
        .run(b.profileId, company, domain, url);
      created.push({ id: Number(ins.lastInsertRowid), company_name: company, domain, source_url: url, status: 'new' });
    }
    return ok(created);
  });

  // —— 线索列表/详情 ——
  app.get('/api/leads', (req: any) => {
    const { profileId, status } = req.query;
    const cond: string[] = [];
    const args: any[] = [];
    if (profileId) { cond.push('profile_id=?'); args.push(profileId); }
    if (status) { cond.push('status=?'); args.push(status); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM leads ${where} ORDER BY (score IS NULL), score DESC, id DESC`).all(...args) as any[];
    // 列表附带主营摘要与联系方式（来自最新报告）
    const stmt = db.prepare('SELECT data_json FROM reports WHERE lead_id=? ORDER BY id DESC LIMIT 1');
    for (const r of rows) {
      const rep = stmt.get(r.id) as any;
      if (rep) {
        try {
          const d = JSON.parse(rep.data_json);
          r.main_business = d.main_business;
          r.contact = d.contact?.emails?.[0] ? d.contact.emails[0] : d.contact?.has_form ? '仅表单' : '—';
        } catch { /* 忽略坏数据 */ }
      }
    }
    return ok(rows);
  });

  app.get('/api/leads/:id', (req: any) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id) as any;
    if (!lead) return fail('线索不存在');
    const rep = db.prepare('SELECT * FROM reports WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(req.params.id) as any;
    return ok({ ...lead, report: rep ? { id: rep.id, ...JSON.parse(rep.data_json) } : null });
  });

  // —— 批量分析 / 重试 / 确认 ——
  app.post('/api/leads/analyze', (req: any) => {
    const ids: number[] = req.body?.ids || [];
    if (!ids.length) return fail('ids 不能为空');
    const added = enqueue(ids);
    return ok({ added });
  });

  app.post('/api/leads/:id/retry', (req: any) => {
    const added = enqueue([Number(req.params.id)]);
    return ok({ added });
  });

  app.post('/api/leads/:id/confirm', (req: any) => {
    const r = db.prepare(`UPDATE leads SET status='confirmed' WHERE id=? AND status IN ('done')`).run(req.params.id);
    if (!r.changes) return fail('仅已完成分析的线索可确认');
    return ok(true);
  });

  // —— 开发信 ——
  app.post('/api/leads/:id/email', async (req: any) => {
    try {
      return ok(await generateEmail(Number(req.params.id), req.body?.language || 'en'));
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  app.get('/api/leads/:id/emails', (req: any) => {
    return ok(db.prepare('SELECT * FROM emails WHERE lead_id=? ORDER BY id DESC').all(req.params.id));
  });

  app.get('/api/emails/:id/eml', (req: any, reply: any) => {
    const e = db.prepare('SELECT * FROM emails WHERE id=?').get(req.params.id) as any;
    if (!e) return reply.code(404).send('not found');
    reply
      .header('Content-Type', 'message/rfc822')
      .header('Content-Disposition', `attachment; filename="outreach-${e.id}.eml"`)
      .send(buildEml(e.subject, e.body));
  });

  // —— 任务状态 ——
  app.get('/api/tasks', () => ok(getTaskStats()));
}
