import { afterEach, describe, expect, it, vi } from 'vitest';
import { findQuoteSpans, flashQuoteOnPage } from '../quoteFlash';
afterEach(() => vi.useRealTimers());

const spans = (...texts: string[]) => texts.map((text) => {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
});

describe('quote flash cancellation', () => {
  it('cancels text-layer polling immediately without highlighting a superseded page', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const controller = new AbortController();
    const promise = flashQuoteOnPage(root, 12, 'original quote', 3000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    await expect(promise).resolves.toBe(false);
  });

  it('clears the pulse class and timer immediately when its viewer is disposed', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = '<div data-page-number="1"><div class="textLayer"><span>original quote</span></div></div>';
    const span = root.querySelector('span')!;
    span.scrollIntoView = vi.fn();
    const controller = new AbortController();
    expect(await flashQuoteOnPage(root, 1, 'original quote', 3000, controller.signal)).toBe(true);
    expect(span.classList.contains('ds-pdf-quote-flash')).toBe(true);
    controller.abort();
    await Promise.resolve();
    expect(span.classList.contains('ds-pdf-quote-flash')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
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
