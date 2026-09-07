import { describe, expect, it } from 'vitest';

import {
  composeWindowedSave,
  createMarkdownWindow,
  expandMarkdownWindow,
} from '../markdownWindow';

/**
 * N02（2026-09-07 审阅）：窗口投影 + 无修改合回必须保持原文——
 * 空行边界、CRLF、尾随空行、代码块/表格都不能因分窗而增减换行。
 * 窗口最小 100 行，夹具必须超过窗口才会真正分窗。
 */

/** 生成 1600 行夹具，并按需改写指定行（0-based）制造边界形态。 */
function makeLines(overrides: Record<number, string> = {}, total = 1600): string[] {
  const lines = Array.from({ length: total }, (_, i) => `line ${i + 1}`);
  for (const [index, value] of Object.entries(overrides)) {
    lines[Number(index)] = value;
  }
  return lines;
}

const WINDOW = 600; // 默认窗口；边界即第 600 行（index 599/600 之间）

const FIXTURES: Array<[string, string]> = [
  ['普通长文', makeLines().join('\n')],
  // 窗口末行为空行：loaded 以 '\n' 结尾——审阅主样本形态
  ['边界空行', makeLines({ 599: '' }).join('\n')],
  // 窗口末连续多个空行
  ['边界多个空行', makeLines({ 598: '', 599: '' }).join('\n')],
  // suffix 首行为空行
  ['suffix 首行空行', makeLines({ 600: '' }).join('\n')],
  // 尾随换行/空行
  ['尾随空行', makeLines({ 1597: '', 1598: '', 1599: '' }).join('\n')],
  // CRLF：\r 留在行尾，round-trip 不得增减
  ['CRLF 边界', makeLines({ 599: '' }).join('\r\n')],
  // 代码块跨边界（触发 adjustMarkdownBoundary 扩展，仍须 round-trip）
  [
    '代码块跨边界',
    makeLines({ 598: '```rust', 599: 'fn main() {}', 600: '```' }).join('\n'),
  ],
  // 表格跨边界
  [
    '表格跨边界',
    makeLines({ 598: '| a | b |', 599: '|---|---|', 600: '| 1 | 2 |' }).join('\n'),
  ],
];

describe('markdownWindow N02 无修改 round-trip 不变量', () => {
  for (const [name, text] of FIXTURES) {
    it(`compose 保持原文：${name}`, () => {
      const w = createMarkdownWindow(text, WINDOW);
      expect(w.hasMore).toBe(true);
      const saved = composeWindowedSave(w.loadedMarkdown, text, w.loadedLineCount, w.hasMore);
      expect(saved).toBe(text);
    });

    it(`expand 链式加载到全文后等于原文：${name}`, () => {
      let w = createMarkdownWindow(text, WINDOW);
      let guard = 0;
      while (w.hasMore && guard < 100) {
        w = expandMarkdownWindow(text, w.loadedMarkdown, w.loadedLineCount, 300);
        guard += 1;
      }
      expect(w.hasMore).toBe(false);
      expect(w.loadedMarkdown).toBe(text);
    });
  }

  it('逐行 expand（最小步长）也保持原文', () => {
    const text = makeLines({ 599: '', 600: '' }).join('\n');
    let w = createMarkdownWindow(text, 100);
    let guard = 0;
    while (w.hasMore && guard < 2000) {
      w = expandMarkdownWindow(text, w.loadedMarkdown, w.loadedLineCount, 1);
      guard += 1;
    }
    expect(w.loadedMarkdown).toBe(text);
  });

  it('零行 expand 不改变已加载内容', () => {
    const text = makeLines({ 599: '' }).join('\n');
    const w = createMarkdownWindow(text, WINDOW);
    const expanded = expandMarkdownWindow(text, w.loadedMarkdown, w.loadedLineCount, 0);
    expect(expanded.loadedMarkdown).toBe(w.loadedMarkdown);
    expect(expanded.loadedLineCount).toBe(w.loadedLineCount);
  });

  it('编辑后的窗口内容与 suffix 之间恰好一个分隔换行', () => {
    const text = makeLines({ 599: '' }).join('\n');
    const w = createMarkdownWindow(text, WINDOW);
    // 用户把窗口内容改成 "edited"（无尾随换行）
    const saved = composeWindowedSave('edited', text, w.loadedLineCount, w.hasMore);
    const suffix = makeLines({ 599: '' }).slice(w.loadedLineCount).join('\n');
    expect(saved).toBe(`edited\n${suffix}`);
  });
});
