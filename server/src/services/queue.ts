import { db, touch } from '../db.js';
import { scrapeSite } from './scraper.js';
import { buildAnalysisMessages, validateAnalysis, ANALYSIS_PROMPT_VERSION } from '../prompts/analysis.js';
import { chatJson } from '../llm/client.js';
import { computeScore } from './score.js';
import { runSearch, isBlocked, domainOf } from '../providers/search.js';

/** 进程内任务队列，并发=2，失败自动重试 1 次 */
const CONCURRENCY = 2;
let running = 0;
const queue: number[] = [];
const inQueue = new Set<number>();

export function enqueue(ids: number[]): number {
  let added = 0;
  for (const id of ids) {
    const lead = db.prepare('SELECT id,status FROM leads WHERE id=?').get(id) as any;
    if (!lead || ['queued', 'scraping', 'analyzing'].includes(lead.status)) continue;
    db.prepare(`UPDATE leads SET status='queued', error=NULL WHERE id=?`).run(id);
    if (!inQueue.has(id)) {
      inQueue.add(id);
      queue.push(id);
      added++;
    }
  }
  pump();
  return added;
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    running++;
    processLead(id)
      .catch((e) => console.error(`[queue] lead#${id} 处理异常:`, e))
      .finally(() => {
        running--;
        inQueue.delete(id);
        pump();
      });
  }
}

export function getTaskStats() {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM leads GROUP BY status`).all() as any[];
  return { running, pending: queue.length, byStatus: Object.fromEntries(rows.map((r) => [r.status, r.c])) };
}

async function findCompanySite(companyName: string): Promise<string | null> {
  // 公司名（无 URL）线索：先搜索其官网
  try {
    const results = await runSearch(`"${companyName}" official website`, 5);
    const hit = results.find((r) => !isBlocked(r.url));
    return hit?.url || null;
  } catch {
    return null;
  }
}

async function processLead(leadId: number, retried = false): Promise<void> {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId) as any;
  if (!lead) return;
  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(lead.profile_id) as any;
  try {
    // —— 阶段1：抓取官网 ——
    db.prepare(`UPDATE leads SET status='scraping' WHERE id=?`).run(leadId);
    let url = lead.source_url;
    if (!url) {
      url = await findCompanySite(lead.company_name);
      if (url) db.prepare('UPDATE leads SET source_url=? WHERE id=?').run(url, leadId);
    }
    const scraped = url ? await scrapeSite(url) : { pages: [], contact: { emails: [], persons: [], has_form: false }, allText: '', ok: false, failReason: '无可用官网地址' };

    // —— 阶段2：LLM 分析 ——
    db.prepare(`UPDATE leads SET status='analyzing' WHERE id=?`).run(leadId);
    const messages = buildAnalysisMessages({
      profile,
      pages: scraped.pages,
      snippet: lead.snippet || '',
      marketHint: lead.source_query,
    });
    const analysis = await chatJson<any>(messages, validateAnalysis);
    // contact 由规则抽取覆盖（红线：联系方式不走 LLM）
    analysis.contact = scraped.contact;
    // sources 以实际抓取页面为准（可追溯性：每条事实可回溯到具体页面与抓取时间）
    analysis.sources = scraped.pages
      .filter((p) => !p.error)
      .map((p) => ({ page: p.label, url: p.url, fetched_at: p.fetchedAt }));
    if (!scraped.ok) {
      analysis.incomplete = [...(analysis.incomplete || []), '官网抓取失败，仅基于搜索摘要分析，信息可能不完整'];
      if (!analysis.sources?.length && lead.source_url) {
        analysis.sources = [{ page: 'search', url: lead.source_url }];
      }
    }

    // —— 阶段3：确定性评分 + 落库 ——
    const scored = computeScore(analysis);
    const meta = { promptVersion: ANALYSIS_PROMPT_VERSION, analyzedAt: new Date().toISOString(), scrapeOk: scraped.ok, failReason: scraped.failReason || null };
    db.prepare('INSERT INTO reports(lead_id, data_json, scraped_pages_json) VALUES (?,?,?)').run(
      leadId,
      JSON.stringify({ ...analysis, score: scored.score, grade: scored.grade, dims: scored.dims, meta }),
      JSON.stringify(scraped.pages),
    );
    db.prepare(`UPDATE leads SET status='done', score=?, grade=?, error=NULL, company_name=COALESCE(NULLIF(company_name,''),?) WHERE id=?`).run(
      scored.score, scored.grade, analysis.company_summary.slice(0, 80), leadId,
    );
    touch.run(leadId);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[queue] lead#${leadId} 失败: ${msg}`);
    if (!retried) {
      // 自动重试 1 次
      db.prepare(`UPDATE leads SET status='queued', error=? WHERE id=?`).run(`首次失败将重试: ${msg.slice(0, 200)}`, leadId);
      return processLead(leadId, true);
    }
    db.prepare(`UPDATE leads SET status='failed', error=? WHERE id=?`).run(msg.slice(0, 500), leadId);
  }
}
