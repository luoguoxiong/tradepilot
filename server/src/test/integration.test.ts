/**
 * 集成测试：Mock LLM + 本地 Fixture 官网点 + 隔离 DB
 * 覆盖：分析全链路 / 规则抽取覆盖 LLM contact（红线R2）/ 抓取失败降级 / 开发信校验重试（R3）/ JSON校验重试（R7）/ 失败降级（R6）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH = `/tmp/tp-test-${Date.now()}.db`;
process.env.LLM_BASE_URL = 'http://127.0.0.1:4601/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'mock-model';
process.env.SEARCH_PROVIDER = 'duckduckgo';

const FIXTURE_PORT = 4599;
const MOCK_PORT = 4601;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/`;

// —— Fixture 官网点（含 importer 信号词/邮箱/表单/联系人） ——
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const fixture = http.createServer((req, res) => {
  const url = req.url || '/';
  const map: Record<string, string> = {
    '/': page(`<h1>FixtureCorp</h1>
      <a href="/about">About us</a> <a href="/products">Products</a> <a href="/contact">Contact</a>
      <p>Leading European importer and wholesale distribution of drinkware.</p>`),
    '/about': page('<p>Founded in 2008. 50-100 employees. Certified ISO9001, BSCI.</p>'),
    '/products': page('<p>Stainless steel insulated bottles, vacuum tumblers, custom laser engraving for retail chains.</p>'),
    '/contact': page('<p>Contact Max Weber, Head of Sourcing. Email: info@fixture-corp.com</p><form><input name="msg"></form>'),
  };
  res.setHeader('Content-Type', 'text/html');
  res.end(map[url] ?? '<html><body>not found</body></html>');
});

// —— Mock LLM（按脚本序列返回；SCRIPT=[{json?|raw?|fail?}]） ——
let SCRIPT: any[] = [];
let llmCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('data-end', () => {});
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

const waitStatus = async (leadId: number, statuses: string[], timeoutMs = 40_000) => {
  const { db } = await import('../db.js');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const lead: any = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
    if (statuses.includes(lead.status)) return lead;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待状态超时: ${statuses.join('/')}`);
};

const GOOD_ANALYSIS = {
  company_summary: 'FixtureCorp is a European importer of drinkware',
  main_business: 'wholesale distribution of insulated bottles',
  product_lines: ['stainless insulated bottles', 'vacuum tumblers'],
  market_coverage: 'Germany, France, Netherlands',
  scale_info: { founded: '2008', employees: '50-100', certifications: ['ISO9001', 'BSCI'] },
  scale_evidence: 'about page states founded 2008',
  match: { level: 'high', evidence: 'products page lists insulated bottles matching profile' },
  importer: { level: 'strong', evidence: 'home page contains importer and wholesale distribution' },
  market_fit: { level: 'high', evidence: 'markets listed on about page' },
  contact: { emails: ['fake@from-llm.com'], persons: ['Fake Person'], has_form: false }, // 故意伪造，应被规则结果覆盖
  incomplete: [],
  sources: [{ page: 'home', url: FIXTURE_URL }],
};
const GOOD_EMAIL = { subjects: ['Custom insulated bottles for FixtureCorp', 'Factory-direct 304 stainless tumblers'], body: 'Hi Max Weber,\n\nI noticed FixtureCorp distributes stainless steel insulated bottles across Europe.\nWe manufacture 304 stainless bottles with laser engraving, BSCI certified.\nWould a sample set be helpful for your next season?\n\nBest regards,\nKevin' };

test.before(async () => {
  await new Promise<void>((r) => fixture.listen(FIXTURE_PORT, () => r()));
  await new Promise<void>((r) => mock.listen(MOCK_PORT, () => r()));
});

test('R2+R4: 分析全链路 — 抓取→LLM→评分→落库，LLM 伪造 contact 被规则结果覆盖', async () => {
  SCRIPT = [{ json: GOOD_ANALYSIS }];
  const { db } = await import('../db.js');
  const { enqueue } = await import('../services/queue.js');
  const p = db.prepare('INSERT INTO profiles(name, product_desc, keywords, markets, advantages) VALUES (?,?,?,?,?)')
    .run('保温杯', '304 stainless insulated bottles', 'insulated water bottle', 'Germany', 'BSCI certified');
  const l = db.prepare('INSERT INTO leads(profile_id, company_name, domain, source_url) VALUES (?,?,?,?)')
    .run(Number(p.lastInsertRowid), 'FixtureCorp', `127.0.0.1:${FIXTURE_PORT}`, FIXTURE_URL);
  const leadId = Number(l.lastInsertRowid);

  enqueue([leadId]);
  const lead = await waitStatus(leadId, ['done']);
  assert.equal(lead.status, 'done');
  assert.equal(lead.grade, 'A'); // high40+strong25+scale15+email10+high10 = 100
  assert.equal(lead.score, 100);

  const rep = JSON.parse((db.prepare('SELECT data_json FROM reports WHERE lead_id=?').get(leadId) as any).data_json);
  // 红线 R2：contact 必须来自规则抽取，而非 LLM
  assert.deepEqual(rep.contact.emails, ['info@fixture-corp.com']);
  assert.ok(!rep.contact.emails.includes('fake@from-llm.com'));
  assert.ok(rep.contact.persons.includes('Max Weber'));
  assert.equal(rep.contact.has_form, true);
  // 抓取的子页被记录（来源可追溯）
  assert.ok(rep.sources.some((s: any) => s.url?.includes('/contact')));
  // 评分明细落库且总分一致
  assert.equal(rep.dims.length, 5);
  assert.equal(rep.dims.reduce((s: number, d: any) => s + d.earned, 0), rep.score);
});

test('R7: LLM 首次返回非法 JSON → 带错误重试成功', async () => {
  SCRIPT = [{ raw: 'this is not json at all' }, { json: GOOD_ANALYSIS }];
  const { db } = await import('../db.js');
  const { enqueue } = await import('../services/queue.js');
  const l = db.prepare('INSERT INTO leads(profile_id, company_name, domain, source_url) VALUES (1,?,?,?)')
    .run('FixtureCorp2', 'x', FIXTURE_URL);
  const leadId = Number(l.lastInsertRowid);
  enqueue([leadId]);
  const lead = await waitStatus(leadId, ['done']);
  assert.equal(lead.status, 'done');
});

test('R4: 抓取失败 → snippet 兜底 + incomplete 标注，不编造', async () => {
  SCRIPT = [{ json: { ...GOOD_ANALYSIS, scale_info: null, scale_evidence: null, incomplete: ['官网抓取失败，仅基于搜索摘要分析，信息可能不完整'] } }];
  const { db } = await import('../db.js');
  const { enqueue } = await import('../services/queue.js');
  const l = db.prepare(`INSERT INTO leads(profile_id, company_name, domain, source_url, snippet) VALUES (1,?,?,?,?)`)
    .run('DeadSite', 'dead.local', 'http://127.0.0.1:1/', 'FixtureCorp wholesale importer snippet');
  const leadId = Number(l.lastInsertRowid);
  enqueue([leadId]);
  const lead = await waitStatus(leadId, ['done']);
  const rep = JSON.parse((db.prepare('SELECT data_json FROM reports WHERE lead_id=?').get(leadId) as any).data_json);
  assert.ok(rep.meta.scrapeOk === false);
  assert.ok(rep.incomplete.some((s: string) => /抓取失败|不完整/.test(s)));
  assert.equal(rep.contact.emails.length, 0); // 无抓取内容则不虚构邮箱
});

test('R3: 开发信 — 合规输出通过，垃圾词首次输出自动重试后通过，超长始终拒绝', async () => {
  const { db } = await import('../db.js');
  const { generateEmail } = await import('../services/outreach.js');
  const doneLead = (db.prepare(`SELECT id FROM leads WHERE status='done' ORDER BY id LIMIT 1`).get() as any).id;

  // 1) 合规通过
  SCRIPT = [{ json: GOOD_EMAIL }];
  const e1 = await generateEmail(doneLead);
  assert.equal(e1.subjects.length, 2);
  assert.ok(e1.word_count <= 150);

  // 2) 首次含垃圾词 → 重试通过（R3 校验失败重试链路）
  SCRIPT = [{ json: { ...GOOD_EMAIL, body: GOOD_EMAIL.body + ' buy now!!!' } }, { json: GOOD_EMAIL }];
  const e2 = await generateEmail(doneLead);
  assert.ok(!/buy now/i.test(e2.body));

  // 3) 始终超长 → 明确报错
  SCRIPT = [{ json: { ...GOOD_EMAIL, body: Array(200).fill('word').join(' ') } }, { json: { ...GOOD_EMAIL, body: Array(200).fill('word').join(' ') } }];
  await assert.rejects(() => generateEmail(doneLead), /超过上限/);
});

test('R6: LLM 持续故障 → 自动重试后 lead=failed 且错误明确', async () => {
  SCRIPT = [{ fail: true }, { fail: true }, { fail: true }, { fail: true }, { fail: true }, { fail: true }, { fail: true }, { fail: true }];
  const { db } = await import('../db.js');
  const { enqueue } = await import('../services/queue.js');
  const l = db.prepare('INSERT INTO leads(profile_id, company_name, domain, source_url) VALUES (1,?,?,?)')
    .run('FailCase', 'y', FIXTURE_URL);
  const leadId = Number(l.lastInsertRowid);
  const callsBefore = llmCalls;
  enqueue([leadId]);
  const lead = await waitStatus(leadId, ['failed']);
  assert.equal(lead.status, 'failed');
  assert.match(lead.error, /HTTP 500/);
  // 自动重试过：调用次数 >= 6（chat 内部 3 次 × 整体重试 2 轮）
  assert.ok(llmCalls - callsBefore >= 6, `实际调用 ${llmCalls - callsBefore} 次`);
});

test.after(async () => {
  fixture.close();
  mock.close();
});
