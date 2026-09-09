/**
 * 知识入库文本处理（后端技术方案 07 §2 ②③）：清洗 + 结构感知分块。
 * 纯函数、无 IO——嵌入与落库由 worker 流水线承担；单测覆盖确定性。
 *
 * token 估算口径：Latin ≈ 4 字符/token，CJK ≈ 1.5 字符/token（逐字符加权求和），
 * 块长 ~500 token、overlap ~10%（07 §2）。
 */

export interface TextChunk {
  /** 块序号（0 起） */
  index: number;
  content: string;
  /** 估算 token 数 */
  tokenCount: number;
  /** 结构感知元数据：标题路径（md # 层级 / 编号小节），无标题时为空数组 */
  metadata: { headingPath: string[] };
}

/** 清洗（07 §2 ②）：全角空白归一、空白折叠、剔除重复页眉页脚类短行 */
export function cleanDocumentText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n');
  const freq = new Map<string, number>();
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0 && t.length <= 60) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const out: string[] = [];
  for (const line of lines) {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    // 出现 ≥3 次的短行视为页眉页脚/装饰线，剔除
    if (t.length > 0 && t.length <= 60 && (freq.get(t) ?? 0) >= 3) {
      continue;
    }
    if (t.length === 0) {
      // 连续空行折叠为单行分隔（保段落边界，去多余空白）
      if (out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      continue;
    }
    out.push(t);
  }
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }
  return out.join('\n');
}

/** 粗略 token 估算（混合中英文；仅用于分块配额与 token_count 留痕，非精确计费口径） */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 0x2e7f ? 1 / 1.5 : 1 / 4;
  }
  return Math.max(1, Math.ceil(tokens));
}

interface Segment {
  headingPath: string[];
  /** 原文段落（连续非空行聚合的最小不可分单元） */
  text: string;
}

const HEADING_RE = /^(#{1,6}\s+.+|\d+(?:\.\d+)*[.、)]?\s+\S.{0,80})$/;

/** 段落聚合：标题行开启新段（携带层级路径），其余按连续非空行聚合 */
function toSegments(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  const headingPath: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text.length > 0) {
      segments.push({ headingPath: [...headingPath], text });
    }
    buf = [];
  };
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      flush();
      const depth = line.startsWith('#') ? (line.match(/^#+/)?.[0].length ?? 1) : 1;
      const title = line.replace(/^#+\s*/, '');
      headingPath.length = Math.min(headingPath.length, depth - 1);
      headingPath[depth - 1] = title;
      headingPath.length = depth;
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return segments;
}

export interface ChunkOptions {
  /** 块长上限（估算 token，默认 ~500） */
  maxTokens?: number;
  /** 重叠比例（0~0.5，默认 0.1 ≈ 10%） */
  overlapRatio?: number;
}

/**
 * 结构感知分块（07 §2 ③）：标题层级优先切分 → 段内按行滑窗（步进 = max - overlap）。
 * 标题路径随块元数据携带（sales_reply 场景引用链用，07 §4.1）。
 */
export function chunkDocumentText(raw: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxTokens = opts.maxTokens ?? 500;
  const overlapRatio = Math.min(0.5, Math.max(0, opts.overlapRatio ?? 0.1));
  const overlapTokens = Math.floor(maxTokens * overlapRatio);

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const segments = toSegments(lines);
  const chunks: TextChunk[] = [];

  const pushChunk = (content: string, headingPath: string[]): void => {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return;
    }
    chunks.push({
      index: chunks.length,
      content: trimmed,
      tokenCount: estimateTokens(trimmed),
      metadata: { headingPath: [...headingPath] },
    });
  };

  for (const seg of segments) {
    if (estimateTokens(seg.text) <= maxTokens) {
      pushChunk(seg.text, seg.headingPath);
      continue;
    }
    // 超长段：按行滑窗（窗口预算 maxTokens，步进 max - overlap，窗口间携带 overlap 行）
    const segLines = seg.text.split('\n');
    let window: string[] = [];
    let windowTokens = 0;
    for (const line of segLines) {
      const lineTokens = estimateTokens(line);
      if (windowTokens + lineTokens > maxTokens && window.length > 0) {
        pushChunk(window.join('\n'), seg.headingPath);
        // overlap：从当前窗口尾部回带若干行（预算 overlapTokens）
        const carry: string[] = [];
        let carryTokens = 0;
        for (let i = window.length - 1; i >= 0 && carryTokens < overlapTokens; i--) {
          const t = estimateTokens(window[i] ?? '');
          if (carryTokens + t > overlapTokens && carry.length > 0) {
            break;
          }
          carry.unshift(window[i] ?? '');
          carryTokens += t;
        }
        window = carry;
        windowTokens = carryTokens;
      }
      window.push(line);
      windowTokens += lineTokens;
    }
    pushChunk(window.join('\n'), seg.headingPath);
  }
  return chunks;
}
