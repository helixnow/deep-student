/**
 * 翻译分段/对齐规则测试（共享模块 src/translation/segmentation.ts）
 *
 * 同时验证 ComparisonView 与 TranslationViewerWrapper 都消费该模块
 * （分段规则统一，两处不再各自维护不同的切分正则）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alignTexts, splitParagraphs, splitSentences } from '@/translation/segmentation';

describe('splitParagraphs', () => {
  it('按空行切分，单换行不拆段', () => {
    expect(splitParagraphs('第一段第一行\n第一段第二行\n\n第二段')).toEqual([
      '第一段第一行\n第一段第二行',
      '第二段',
    ]);
  });

  it('丢弃空白段', () => {
    expect(splitParagraphs('a\n\n\n\nb\n\n  \n\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('splitSentences', () => {
  it('兼顾 CJK 与西文终止符并保留终止符', () => {
    expect(splitSentences('你好。How are you? 好的；')).toEqual([
      '你好。',
      'How are you?',
      '好的；',
    ]);
  });
});

describe('alignTexts', () => {
  it('段落数一致时按段硬配对', () => {
    const result = alignTexts('a\n\nb', 'A\n\nB');
    expect(result.usedSentenceFallback).toBe(false);
    expect(result.pairs).toEqual([
      { src: 'a', tgt: 'A' },
      { src: 'b', tgt: 'B' },
    ]);
  });

  it('译文为空时不触发句子降级（流式初期）', () => {
    const result = alignTexts('a\n\nb', '');
    expect(result.usedSentenceFallback).toBe(false);
    expect(result.pairs).toEqual([
      { src: 'a', tgt: '' },
      { src: 'b', tgt: '' },
    ]);
  });

  it('段落数不一致时降级为句子级对齐并明示', () => {
    const result = alignTexts(
      '第一句。第二句。\n\n第三句。',
      '译文只有一段。第一二三句都在这里。',
    );
    expect(result.usedSentenceFallback).toBe(true);
    expect(result.pairs.length).toBeGreaterThan(0);
    // 原文全部句子都被分配进某一行
    const joinedSrc = result.pairs.map((p) => p.src).join(' ');
    expect(joinedSrc).toContain('第一句。');
    expect(joinedSrc).toContain('第三句。');
  });
});

describe('分段规则统一（源码契约）', () => {
  const read = (rel: string) =>
    readFileSync(resolve(__dirname, '../../../', rel), 'utf-8');

  it('ComparisonView 与 TranslationViewerWrapper 都从共享模块导入 alignTexts', () => {
    const comparison = read('src/components/translation/ComparisonView.tsx');
    const viewer = read('src/dstu/editors/TranslationViewerWrapper.tsx');
    expect(comparison).toMatch(/from '@\/translation\/segmentation'/);
    expect(viewer).toMatch(/from '@\/translation\/segmentation'/);
    // 不允许各自残留私有分段实现
    expect(comparison).not.toMatch(/const splitParagraphs\s*=/);
    expect(viewer).not.toMatch(/function splitParagraphs/);
  });
});
