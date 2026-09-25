import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks, createMarkdownBlockSplitter } from '../splitMarkdownBlocks';

describe('splitMarkdownBlocks', () => {
  it('keeps the active streaming block id stable while append-only content grows', () => {
    const first = splitMarkdownBlocks('第一句', true);
    const second = splitMarkdownBlocks('第一句，第二句', true);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.type).toBe('paragraph');
    expect(second[0]?.type).toBe('paragraph');
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it('keeps a block id when the block closes and the stream completes', () => {
    const split = createMarkdownBlockSplitter();
    const active = split('First paragraph.', true);
    const closed = split('First paragraph.\n\nSecond paragraph.', true);
    const complete = split('First paragraph.\n\nSecond paragraph.', false);
    expect(closed[0].id).toBe(active[0].id);
    expect(complete.map((block) => block.id)).toEqual(closed.map((block) => block.id));
    expect(complete.every((block) => block.isComplete)).toBe(true);
  });

  it('treats a single-line $$...$$ as a self-closed math block', () => {
    const blocks = splitMarkdownBlocks('$$E=mc^2$$\n\n后续段落内容', false);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe('math');
    expect(blocks[0]?.raw).toBe('$$E=mc^2$$');
    expect(blocks[0]?.isComplete).toBe(true);
    expect(blocks[1]?.type).toBe('paragraph');
    expect(blocks[1]?.raw).toBe('后续段落内容');
  });

  it('does not close a 4-backtick fence with an inner 3-backtick fence', () => {
    const content = '````md\n```js\nconst a = 1;\n```\n````\n\n尾随段落';
    const blocks = splitMarkdownBlocks(content, false);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.isComplete).toBe(true);
    expect(blocks[0]?.raw).toContain('```js');
    expect(blocks[1]?.type).toBe('paragraph');
  });

  it('does not close a backtick fence with a tilde fence', () => {
    const content = '```\n~~~\ncode\n```';
    const blocks = splitMarkdownBlocks(content, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.isComplete).toBe(true);
  });

  it('marks an unclosed streaming fence as incomplete', () => {
    const blocks = splitMarkdownBlocks('```python\nprint(1)', true);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.isComplete).toBe(false);
  });
});

describe('createMarkdownBlockSplitter (incremental)', () => {
  /** 逐 chunk 追加喂给增量拆分器，每步都必须与全量解析完全一致 */
  const expectIncrementalMatchesFull = (chunks: string[], isStreaming = true) => {
    const split = createMarkdownBlockSplitter();
    let content = '';
    for (const chunk of chunks) {
      content += chunk;
      expect(split(content, isStreaming)).toEqual(splitMarkdownBlocks(content, isStreaming));
    }
    // 流式结束（isStreaming 翻转）也必须一致
    expect(split(content, false)).toEqual(splitMarkdownBlocks(content, false));
  };

  it('matches full parse for a mixed document streamed in small chunks', () => {
    const doc = [
      '# 标题\n\n',
      '第一段文字，',
      '继续第一段。\n\n',
      '- 列表项 A\n',
      '- 列表项 B\n\n',
      '```js\nconst a = 1;\n',
      'const b = 2;\n```\n\n',
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n',
      '$$\nE = mc^2\n$$\n\n',
      '> 引用一行\n\n',
      '收尾段落',
    ];
    expectIncrementalMatchesFull(doc);
  });

  it('handles retroactive list merge across the last two blocks', () => {
    // "- a\n\n-" 先被解析为 [list, paragraph]，追加 " b" 后
    // 空行前瞻规则会把两者合并成单个 list 块——增量路径必须复现
    expectIncrementalMatchesFull(['前置段落\n\n', '- a\n', '\n', '-', ' b\n', '- c\n']);
  });

  it('handles an unclosed code fence that swallows subsequent chunks', () => {
    expectIncrementalMatchesFull([
      '开头段落\n\n',
      '第二段\n\n',
      '```python\n',
      'print(1)\n',
      'print(2)\n',
      '不再闭合的更多内容\n',
    ]);
  });

  it('falls back to a full re-parse when content is not append-only', () => {
    const split = createMarkdownBlockSplitter();
    const first = '# A\n\n段落一\n\n段落二\n\n段落三';
    expect(split(first, true)).toEqual(splitMarkdownBlocks(first, true));

    const replaced = '完全不同的内容\n\n- x\n- y';
    expect(split(replaced, true)).toEqual(splitMarkdownBlocks(replaced, true));

    expect(split('', true)).toEqual([]);
    const again = '重新开始';
    expect(split(again, false)).toEqual(splitMarkdownBlocks(again, false));
  });

  it('keeps completed block ids stable while streaming grows', () => {
    const split = createMarkdownBlockSplitter();
    const base = '# 标题\n\n第一段\n\n第二段\n\n';
    const first = split(`${base}活跃`, true);
    const second = split(`${base}活跃内容继续增长`, true);
    expect(second.slice(0, 3).map((b) => b.id)).toEqual(first.slice(0, 3).map((b) => b.id));
    expect(second[second.length - 1]?.id).toBe(first[first.length - 1]?.id);
  });

  it('reuses finalized objects for completed prefix blocks across flushes (identity stable)', () => {
    // 🚀 长会话性能契约：已完成块对象跨 flush 复用同一引用，
    // MemoizedBlock 的 props 引用比较直接命中，无需逐块值比较 raw。
    // 注意首帧就需 ≥3 个块才会进入增量路径（MIN_BLOCKS_FOR_INCREMENTAL）。
    const split = createMarkdownBlockSplitter();
    const base = '# 标题\n\n第一段\n\n第二段\n\n';
    const first = split(base, true);
    const second = split(`${base}活跃正文`, true);
    expect(first).toHaveLength(3);
    // 增量路径保留前 n-2 个前缀块：块 0 保持对象身份
    expect(second[0]).toBe(first[0]);
    // 块 1 在重解析窗口内：对象重建但 id/raw 值必须一致
    expect(second[1].id).toBe(first[1].id);
    expect(second[1].raw).toBe(first[1].raw);
  });

  it('keeps prefix identity stable on repeated same-content calls after stream end', () => {
    const split = createMarkdownBlockSplitter();
    const content = '# A\n\n段落\n\n活跃内容';
    split(content, true);
    const done = split(content, false);
    const again = split(content, false);
    expect(again[0]).toBe(done[0]);
    // 增量路径会重解析尾部两块，但输出必须与全量解析一致
    expect(again).toEqual(splitMarkdownBlocks(content, false));
  });
});
