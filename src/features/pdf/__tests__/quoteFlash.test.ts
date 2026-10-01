import { describe, expect, it } from 'vitest';
import { findQuoteSpans } from '../quoteFlash';

const spans = (...texts: string[]) => texts.map((text) => {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
});

describe('findQuoteSpans', () => {
  it('matches a quote split across spans with stray whitespace and returns only the covered spans', () => {
    const layer = spans('第三章 ', '拉格朗日中值', '定理 的几何意义：曲线上', '至少有一点的切线', ' 与弦平行。', '下一节');
    const hits = findQuoteSpans(layer, '拉格朗日中值定理的几何意义：曲线上至少有一点的切线与弦平行');
    expect(hits.map((s) => s.textContent)).toEqual(['拉格朗日中值', '定理 的几何意义：曲线上', '至少有一点的切线', ' 与弦平行。']);
  });

  it('falls back to a shorter prefix when the model paraphrased the tail', () => {
    const layer = spans('费马引理：若函数在极值点可导，', '则导数为零。');
    expect(findQuoteSpans(layer, '费马引理：若函数在极值点可导，那么它的导数等于 0')).toHaveLength(2);
  });

  it('returns nothing when the quote is absent or too short', () => {
    const layer = spans('完全无关的文字');
    expect(findQuoteSpans(layer, '牛顿莱布尼茨公式')).toEqual([]);
    expect(findQuoteSpans(layer, '完全')).toEqual([]);
  });
});
