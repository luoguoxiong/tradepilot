/**
 * knowledge_search 混合检索实装（M4 #8，后端技术方案 07 §4）：
 * 三路召回 + RRF 融合（k=60）——
 *   ① 向量：query 嵌入 → HNSW（vector_cosine_ops）Top-20（idx_kchunk_embedding；含距离阈值）；
 *   ② 全文：to_tsvector('simple') @@ websearch_to_tsquery Top-20；
 *   ③ 相似：pg_trgm similarity Top-20（trgm gin 索引，manual 迁移交付）；
 * 融合排序取 Top-K，score 归一 0~1（相对三路满分 3/(k+1)）。
 * 场景差异化（07 §4.1）：sceneCategories/sceneTopK（core/rrf.ts）。
 * 纯库访问、无外呼（query 嵌入除外）；工具（AI）与 11 API 检索共用本实现。
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '@tradepilot/db';
import { RRF_K, sceneCategories, sceneTopK, type SearchScene } from '@tradepilot/core';
import { getEmbeddingProvider } from '@tradepilot/integrations';

export interface KnowledgeSearchParams {
  query: string;
  scene?: SearchScene | null;
  topK?: number;
  /** 显式类目过滤（优先于 scene 偏置；11 §3.3 category 入参） */
  categories?: string[];
}

export interface KnowledgeSearchHit {
  chunkId: string;
  docId: string;
  docName: string;
  category: string;
  content: string;
  /** 归一相关度 0~1 */
  score: number;
  headingPath: string[];
}

export interface KnowledgeSearchResult {
  results: KnowledgeSearchHit[];
  noResult: boolean;
}

/** 每路召回候选数（07 §4.1：Top-20 融合） */
const CANDIDATE_K = 20;

/**
 * 向量路召回下限（余弦距离，`<=>` 越小越相近；距 0.75 ≈ 相似度 0.25）。
 * 向量路缺失阈值时会对「库内任意 chunk」返回 Top-20，使无关 query 也命中、
 * `noResult` 永不成立（违反 11 §1.3 FR-06「无相关信息须明示且禁止编造」）。
 * mock 嵌入近正交（距离≈1.0）被自然滤除；真实嵌入相关文本通常 <0.5 仍保留召回。
 */
const VECTOR_MAX_COSINE_DISTANCE = 0.75;

/** 三路满分（score 归一基准） */
const MAX_RRF = 3 / (RRF_K + 1);

export async function searchKnowledgeChunks(
  tx: Tx,
  orgId: string,
  params: KnowledgeSearchParams,
): Promise<KnowledgeSearchResult> {
  const topK = params.topK ?? sceneTopK(params.scene ?? null);
  const categories = params.categories?.length
    ? params.categories
    : sceneCategories(params.scene ?? null);

  // query 嵌入（向量路）；按 org 选用模型解析（16 FR-10 扩展），
  // 嵌入服务异常降级为「全文+相似」两路（检索可用性优先）
  let vecLiteral: string | null = null;
  try {
    const embedding = await getEmbeddingProvider(orgId);
    const [vec] = await embedding.embed([params.query]);
    if (vec?.length) {
      vecLiteral = `[${vec.join(',')}]`;
    }
  } catch {
    vecLiteral = null;
  }

  const categoryCond =
    categories && categories.length > 0
      ? sql` AND kd.category IN (${sql.join(
          categories.map((c) => sql`${c}`),
          sql`, `,
        )})`
      : sql``;
  const vecPath = vecLiteral
    ? sql`
    vec AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vecLiteral}::vector) AS rn
      FROM scope
      WHERE embedding IS NOT NULL AND embedding <=> ${vecLiteral}::vector < ${VECTOR_MAX_COSINE_DISTANCE}
      ORDER BY embedding <=> ${vecLiteral}::vector
      LIMIT ${CANDIDATE_K}
    ),`
    : sql``;
  const vecJoin = vecLiteral ? sql`LEFT JOIN vec ON vec.id = s.id` : sql``;

  const rowsRes = await tx.execute(sql`
    WITH scope AS (
      SELECT kc.id, kc.content, kc.metadata, kc.embedding, kd.id AS document_id, kd.file_name, kd.category
      FROM knowledge_chunk kc
      JOIN knowledge_document kd ON kd.id = kc.document_id
      WHERE kd.org_id = ${orgId} AND kd.deleted_at IS NULL${categoryCond}
    ),${vecPath}
    fts AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('simple', content), q.ts) DESC) AS rn
      FROM scope, websearch_to_tsquery('simple', ${params.query}) AS q(ts)
      WHERE to_tsvector('simple', content) @@ q.ts
      LIMIT ${CANDIDATE_K}
    ),
    trgm AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY similarity(content, ${params.query}) DESC) AS rn
      FROM scope WHERE content % ${params.query}
      LIMIT ${CANDIDATE_K}
    )
    SELECT s.id AS chunk_id, s.document_id, s.file_name, s.category, s.content, s.metadata,
      COALESCE(1.0/(${RRF_K}+vec.rn),0) + COALESCE(1.0/(${RRF_K}+fts.rn),0) + COALESCE(1.0/(${RRF_K}+trgm.rn),0) AS rrf
    FROM scope s
    ${vecJoin}
    LEFT JOIN fts ON fts.id = s.id
    LEFT JOIN trgm ON trgm.id = s.id
    WHERE vec.id IS NOT NULL OR fts.id IS NOT NULL OR trgm.id IS NOT NULL
    ORDER BY rrf DESC
    LIMIT ${topK}
  `);

  const rows = (rowsRes as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  const results = rows.map((r) => ({
    chunkId: String(r['chunk_id']),
    docId: String(r['document_id']),
    docName: String(r['file_name'] ?? ''),
    category: String(r['category'] ?? ''),
    content: String(r['content'] ?? ''),
    score: Math.min(1, Number(r['rrf'] ?? 0) / MAX_RRF),
    headingPath: extractHeadingPath(r['metadata']),
  }));
  return { results, noResult: results.length === 0 };
}

function extractHeadingPath(metadata: unknown): string[] {
  if (metadata === null || typeof metadata !== 'object') {
    return [];
  }
  const path = (metadata as Record<string, unknown>)['headingPath'];
  return Array.isArray(path) ? path.map(String) : [];
}
