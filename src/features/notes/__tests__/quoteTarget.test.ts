import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingNotesQuoteTargetsForTests,
  consumeNotesQuoteTarget,
  findQuoteBlockIndex,
  NOTES_QUOTE_TARGET_EVENT,
  NOTES_QUOTE_TARGET_TTL_MS,
  publishNotesQuoteTarget,
} from '../quoteTarget';

afterEach(() => {
  clearPendingNotesQuoteTargetsForTests();
  vi.useRealTimers();
});

describe('notes quote target delivery', () => {
  it('delivers immediately and retains the quote once for a cold editor mount', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    publishNotesQuoteTarget({ noteId: 'note_a', quote: '  特征值的定义  ' });

    const event = dispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(NOTES_QUOTE_TARGET_EVENT);
    expect(event.detail).toEqual({ noteId: 'note_a', quote: '特征值的定义' });
    expect(consumeNotesQuoteTarget('note_a')).toBe('特征值的定义');
    expect(consumeNotesQuoteTarget('note_a')).toBeNull();
    dispatch.mockRestore();
  });

  it('drops a request whose note did not open in time', () => {
    vi.useFakeTimers();
    publishNotesQuoteTarget({ noteId: 'note_a', quote: 'stale' });
    vi.advanceTimersByTime(NOTES_QUOTE_TARGET_TTL_MS + 1);
    expect(consumeNotesQuoteTarget('note_a')).toBeNull();
  });

  it('ignores empty requests and keeps notes independent', () => {
    publishNotesQuoteTarget({ noteId: 'note_a', quote: '   ' });
    publishNotesQuoteTarget({ noteId: 'note_b', quote: 'beta' });
    expect(consumeNotesQuoteTarget('note_a')).toBeNull();
    expect(consumeNotesQuoteTarget('note_b')).toBe('beta');
  });
});

describe('findQuoteBlockIndex', () => {
  const linearAlgebra = [
    '线性代数笔记',
    '特征值',
    '设 A 是 n 阶方阵，若存在数 λ 和非零向量 x 使 Ax = λx，则称 λ 为 A 的特征值。',
    '求特征多项式 det(λE − A)',
    '解特征方程得到全部特征值',
    '复习相似对角化',
    '二次型',
    '二次型可以通过正交变换化为标准形。',
  ];

  it('finds the block a chunk starts in, mid-line and with the markers indexing left on later lines', () => {
    const chunk = [
      '零向量 x 使 Ax = λx，则称 λ 为 A 的特征值。',
      '1. 求特征多项式 det(λE − A)',
      '2. 解特征方程得到全部特征值',
      '- [x] 复习相似对角化',
      '## 二次型',
    ].join('\n');
    expect(findQuoteBlockIndex(linearAlgebra, chunk)).toBe(2);
  });

  it('falls back to the first unique line when the chunk skips text indexing dropped', () => {
    const blocks = ['快速排序', '快排的平均复杂度是 O(n log n)。', 'def quicksort(arr):\n    return arr', '最坏情况退化为 O(n²)，可以随机选主元避免。'];
    const chunk = '快排的平均复杂度是 O(n log n)。\n最坏情况退化为 O(n²)，可以随机选主元避免。';
    expect(findQuoteBlockIndex(blocks, chunk)).toBe(1);
  });

  it('skips lines that occur more than once, and settles for the first occurrence when none is unique', () => {
    const blocks = ['本章小结与回顾', '第一节', '本章小结与回顾', '第二节的定理很多'];
    expect(findQuoteBlockIndex(blocks, '本章小结与回顾\n索引里有而笔记里没有\n第二节的定理很多')).toBe(3);
    expect(findQuoteBlockIndex(blocks, '本章小结与回顾\n索引里有而笔记里没有')).toBe(0);
  });

  it('ignores case, full-width forms and punctuation', () => {
    const blocks = ['Eigenvalues and Eigenvectors', 'The ＡＢＣ theorem states…'];
    expect(findQuoteBlockIndex(blocks, 'eigenvalues AND eigenvectors\nthe abc theorem')).toBe(0);
  });

  it('returns -1 when nothing matches or only fragments are left', () => {
    expect(findQuoteBlockIndex(linearAlgebra, '量子力学的基本假设')).toBe(-1);
    expect(findQuoteBlockIndex([], '特征值')).toBe(-1);
    expect(findQuoteBlockIndex(linearAlgebra, '- a\n1')).toBe(-1);
  });
});
