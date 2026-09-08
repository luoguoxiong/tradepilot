import { describe, expect, it } from 'vitest';
import {
  cleanDocumentText,
  chunkDocumentText,
  estimateTokens,
} from '../src/text-chunk.js';

describe('cleanDocumentText', () => {
  it('折叠连续空行为单行分隔 + 全角空格归一', () => {
    const out = cleanDocumentText('A\u00a0B\r\n\r\n\r\nC\r\n');
    expect(out).toBe('A B\n\nC');
  });

  it('剔除重复页眉页脚短行（≥3 次）', () => {
    const raw = ['Page 1', 'A', 'Page 1', 'B', 'Page 1'].join('\n');
    expect(cleanDocumentText(raw)).toBe('A\nB');
  });
});

describe('chunkDocumentText', () => {
  it('短文档单块输出，携带标题路径', () => {
    const chunks = chunkDocumentText('# H1\nbody text');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.headingPath).toEqual(['H1']);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('确定性：同输入同输出（跨进程一致，mock 嵌入依赖此前提）', () => {
    const raw = '段落一。\n\n段落二。\n\n## 子标题\n段落三。';
    expect(chunkDocumentText(raw)).toEqual(chunkDocumentText(raw));
  });

  it('超长段按行滑窗，overlap 使相邻块共享尾部行', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkDocumentText(long, { maxTokens: 40, overlapRatio: 0.1 });
    expect(chunks.length).toBeGreaterThan(1);
    // overlap：第一块尾部行被第二块回带（共享，非全新分界）
    const firstLast = chunks[0].content.split('\n').at(-1);
    expect(chunks[1].content).toContain(firstLast);
  });

  it('空文本产出零块', () => {
    expect(chunkDocumentText('   \n\n  ')).toHaveLength(0);
  });
});

describe('estimateTokens', () => {
  it('CJK 与 Latin 混合计权（CJK ≈ 1.5 字符/token，Latin ≈ 4 字符/token）', () => {
    expect(estimateTokens('aaaa')).toBe(1); // 4 latin = 1 token
    expect(estimateTokens('你好')).toBe(2); // 2 cjk ≈ 1.33 → ceil 2
    expect(estimateTokens('你好世界你好世界')).toBe(6); // 8 cjk ≈ 5.33 → ceil 6
  });
});
