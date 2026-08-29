/**
 * epubReaderState 单测：
 * - localStorage payload 解析（含旧版本字段缺失回退）
 * - 初始位置合并（本机状态 × metadata 章节级进度，按时间戳）
 * - 章节级进度 → readingProgress 通道载荷
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEpubReaderState,
  resolveInitialEpubLocation,
  buildEpubReadingProgress,
  EPUB_DEFAULT_LINE_HEIGHT,
  EPUB_DEFAULT_PAGE_MARGIN,
  EPUB_MAX_FONT_SCALE,
} from '../epubReaderState';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseEpubReaderState', () => {
  it('null / 损坏 JSON → 全字段回退默认值', () => {
    for (const raw of [null, '{not json', '[]', '"str"']) {
      const state = parseEpubReaderState(raw);
      expect(state).toEqual({
        chapterIndex: 0,
        chapterProgress: 0,
        theme: 'light',
        fontScale: 1,
        fontFamily: 'book',
        lineHeight: EPUB_DEFAULT_LINE_HEIGHT,
        pageMargin: EPUB_DEFAULT_PAGE_MARGIN,
        updatedAt: 0,
      });
    }
  });

  it('旧版本 payload（无 lineHeight/pageMargin/updatedAt）每个字段独立回退', () => {
    const state = parseEpubReaderState(
      JSON.stringify({ chapterIndex: 3, chapterProgress: 0.5, theme: 'sepia', fontScale: 1.2 }),
    );
    expect(state.chapterIndex).toBe(3);
    expect(state.chapterProgress).toBe(0.5);
    expect(state.theme).toBe('sepia');
    expect(state.fontScale).toBe(1.2);
    expect(state.lineHeight).toBe(EPUB_DEFAULT_LINE_HEIGHT);
    expect(state.pageMargin).toBe(EPUB_DEFAULT_PAGE_MARGIN);
    expect(state.updatedAt).toBe(0);
  });

  it('越界值被钳位：负章节归零、进度夹在 [0,1]、字号夹在上限', () => {
    const state = parseEpubReaderState(
      JSON.stringify({ chapterIndex: -2, chapterProgress: 1.6, fontScale: 99, pageMargin: 2 }),
    );
    expect(state.chapterIndex).toBe(0);
    expect(state.chapterProgress).toBe(1);
    expect(state.fontScale).toBe(EPUB_MAX_FONT_SCALE);
    expect(state.pageMargin).toBe(1);
  });

  it('updatedAt 正常解析；非法值归 0', () => {
    expect(parseEpubReaderState(JSON.stringify({ updatedAt: 1700000000000 })).updatedAt).toBe(1700000000000);
    expect(parseEpubReaderState(JSON.stringify({ updatedAt: 'abc' })).updatedAt).toBe(0);
    expect(parseEpubReaderState(JSON.stringify({ updatedAt: -5 })).updatedAt).toBe(0);
  });
});

describe('resolveInitialEpubLocation', () => {
  const local = { chapterIndex: 2, chapterProgress: 0.4, updatedAt: 1000 };

  it('metadata 缺失 / page 非法 → 本机状态', () => {
    expect(resolveInitialEpubLocation(local, undefined)).toEqual({ chapterIndex: 2, chapterProgress: 0.4 });
    expect(resolveInitialEpubLocation(local, null)).toEqual({ chapterIndex: 2, chapterProgress: 0.4 });
    expect(resolveInitialEpubLocation(local, { page: 0 })).toEqual({ chapterIndex: 2, chapterProgress: 0.4 });
    expect(resolveInitialEpubLocation(local, { page: Number.NaN })).toEqual({ chapterIndex: 2, chapterProgress: 0.4 });
  });

  it('章节一致 → 保留本机章内滚动位置', () => {
    expect(resolveInitialEpubLocation(local, { page: 3, lastReadAt: 999_999 })).toEqual({
      chapterIndex: 2,
      chapterProgress: 0.4,
    });
  });

  it('章节不一致且 metadata 更新 → metadata 章节，从章首开始', () => {
    expect(resolveInitialEpubLocation(local, { page: 6, lastReadAt: 2000 })).toEqual({
      chapterIndex: 5,
      chapterProgress: 0,
    });
  });

  it('章节不一致且本机更新 → 本机状态', () => {
    expect(resolveInitialEpubLocation(local, { page: 6, lastReadAt: 500 })).toEqual({
      chapterIndex: 2,
      chapterProgress: 0.4,
    });
  });

  it('旧本机 payload（updatedAt=0）与 metadata 冲突 → metadata 赢（跨设备可靠通道）', () => {
    expect(
      resolveInitialEpubLocation({ chapterIndex: 2, chapterProgress: 0.4, updatedAt: 0 }, { page: 6 }),
    ).toEqual({ chapterIndex: 5, chapterProgress: 0 });
  });

  it('metadata 无 lastReadAt 时仍覆盖较新的本机章节（后端当前只回读 page）', () => {
    expect(resolveInitialEpubLocation(local, { page: 6 })).toEqual({
      chapterIndex: 5,
      chapterProgress: 0,
    });
  });
});

describe('buildEpubReadingProgress', () => {
  it('章节索引 → 1-based page + 当前时间戳', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234567890);
    expect(buildEpubReadingProgress(4)).toEqual({ page: 5, lastReadAt: 1234567890 });
    expect(buildEpubReadingProgress(0)).toEqual({ page: 1, lastReadAt: 1234567890 });
    expect(buildEpubReadingProgress(-1)).toEqual({ page: 1, lastReadAt: 1234567890 });
  });
});
