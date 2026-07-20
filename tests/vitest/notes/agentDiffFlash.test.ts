/**
 * ACR 4.0 A4 — 破坏类直改演出的差异定位纯函数单测。
 */
import { describe, expect, it } from 'vitest';
import {
  extractFlashSnippet,
  findFirstDiffLine,
  resolveFlashSnippet,
} from '@/components/crepe/agentDiffFlash';

describe('findFirstDiffLine', () => {
  it('两文一致 → null', () => {
    expect(findFirstDiffLine('a\nb', 'a\nb')).toBeNull();
  });

  it('返回首个差异行（新文侧）与共同上下文', () => {
    const before = '# 标题\n\n第一段\n第二段';
    const after = '# 标题\n\n改写后的第一段\n第二段';
    const diff = findFirstDiffLine(before, after);
    expect(diff).not.toBeNull();
    expect(diff!.lineIndex).toBe(2);
    expect(diff!.lineText).toBe('改写后的第一段');
    expect(diff!.contextText).toBe('# 标题');
  });

  it('尾部追加：差异行为新增行', () => {
    const diff = findFirstDiffLine('a\nb', 'a\nb\nc-new');
    expect(diff!.lineText).toBe('c-new');
  });

  it('尾部删除：新文侧无该行时 lineText 为空串，保留上下文', () => {
    const diff = findFirstDiffLine('a\nbbb\nccc', 'a');
    expect(diff!.lineText).toBe('');
    expect(diff!.contextText).toBe('a');
  });
});

describe('extractFlashSnippet', () => {
  it('剥掉标题/列表/引用等块级前缀与行内标记', () => {
    expect(extractFlashSnippet('## 章节标题')).toBe('章节标题');
    expect(extractFlashSnippet('- **加粗要点**')).toBe('加粗要点');
    expect(extractFlashSnippet('> 引用内容片段')).toBe('引用内容片段');
    expect(extractFlashSnippet('1. 有序列表项')).toBe('有序列表项');
    expect(extractFlashSnippet('[链接文本](https://x.dev) 追加说明')).toBe(
      '链接文本 追加说明',
    );
  });

  it('过短片段视为不可靠 → 空串', () => {
    expect(extractFlashSnippet('- a')).toBe('');
    expect(extractFlashSnippet('')).toBe('');
  });

  it('超长行截断到上限', () => {
    const long = 'x'.repeat(100);
    expect(extractFlashSnippet(long).length).toBeLessThanOrEqual(48);
  });
});

describe('resolveFlashSnippet', () => {
  it('无差异 → null（无需演出）', () => {
    expect(resolveFlashSnippet('same', 'same')).toBeNull();
  });

  it('优先用差异行文本；删除类回退共同上下文', () => {
    expect(resolveFlashSnippet('a\n老段落文本', 'a\n新段落文本')).toEqual({
      snippet: '新段落文本',
    });
    expect(resolveFlashSnippet('上文锚点段\n将被删除的段落', '上文锚点段')).toEqual({
      snippet: '上文锚点段',
    });
  });

  it('完全无可用文本时 snippet 为空串（调用方走整体脉冲退化）', () => {
    expect(resolveFlashSnippet('ab', '')).toEqual({ snippet: '' });
  });
});
