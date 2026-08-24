import { describe, expect, it } from 'vitest';

import {
  canNavigateNext,
  canNavigatePrev,
  getNextNavigationPage,
  getPrevNavigationPage,
  getSpreadStart,
  resolvePageScrollKeyAction,
} from '../pdfPageNavigation';

describe('getSpreadStart', () => {
  it('maps pages to their spread first page ([1,2] [3,4] …)', () => {
    expect(getSpreadStart(1)).toBe(1);
    expect(getSpreadStart(2)).toBe(1);
    expect(getSpreadStart(3)).toBe(3);
    expect(getSpreadStart(4)).toBe(3);
    expect(getSpreadStart(9)).toBe(9);
  });
});

describe('single mode navigation (±1)', () => {
  it('steps forward and backward one page with clamping', () => {
    expect(getNextNavigationPage(3, 'single', 10)).toBe(4);
    expect(getPrevNavigationPage(3, 'single', 10)).toBe(2);
    expect(getPrevNavigationPage(1, 'single', 10)).toBe(1);
    expect(getNextNavigationPage(10, 'single', 10)).toBe(10);
  });
});

describe('dual mode navigation (±2 per spread)', () => {
  it('steps a full spread instead of a single page', () => {
    // spread [3,4] → 下一 spread 行首 5，上一 spread 行首 1
    expect(getNextNavigationPage(3, 'dual', 10)).toBe(5);
    expect(getPrevNavigationPage(3, 'dual', 10)).toBe(1);
  });

  it('aligns even current pages to their spread before stepping', () => {
    // 第 4 页属于 spread [3,4]：下一页 5，上一页 1（而不是 6/2）
    expect(getNextNavigationPage(4, 'dual', 10)).toBe(5);
    expect(getPrevNavigationPage(4, 'dual', 10)).toBe(1);
  });

  it('stays put at the first spread', () => {
    expect(getPrevNavigationPage(1, 'dual', 10)).toBe(1);
    expect(getPrevNavigationPage(2, 'dual', 10)).toBe(1);
  });

  it('does not collapse into the same spread at the tail', () => {
    // 4 页文档、当前 spread [3,4]：下一页不应变成 4（同 spread），保持 3
    expect(getNextNavigationPage(3, 'dual', 4)).toBe(3);
    expect(getNextNavigationPage(4, 'dual', 4)).toBe(3);
  });

  it('lands on a trailing odd page spread', () => {
    // 5 页文档：spread [5] 单独成行，从 [3,4] 前进应到 5
    expect(getNextNavigationPage(3, 'dual', 5)).toBe(5);
    expect(getNextNavigationPage(5, 'dual', 5)).toBe(5);
    expect(getPrevNavigationPage(5, 'dual', 5)).toBe(3);
  });
});

describe('cover offset spreads ([1] [2,3] [4,5] …)', () => {
  it('maps pages to cover-offset spread starts', () => {
    expect(getSpreadStart(1, true)).toBe(1);
    expect(getSpreadStart(2, true)).toBe(2);
    expect(getSpreadStart(3, true)).toBe(2);
    expect(getSpreadStart(4, true)).toBe(4);
    expect(getSpreadStart(5, true)).toBe(4);
  });

  it('steps between the cover row and even-first spreads', () => {
    // 封面 [1] → 下一 spread [2,3]
    expect(getNextNavigationPage(1, 'dual', 10, true)).toBe(2);
    // [2,3] → [4,5]；回退到封面
    expect(getNextNavigationPage(2, 'dual', 10, true)).toBe(4);
    expect(getNextNavigationPage(3, 'dual', 10, true)).toBe(4);
    expect(getPrevNavigationPage(2, 'dual', 10, true)).toBe(1);
    expect(getPrevNavigationPage(3, 'dual', 10, true)).toBe(1);
    expect(getPrevNavigationPage(5, 'dual', 10, true)).toBe(2);
  });

  it('clamps at the tail spread without collapsing', () => {
    // 5 页 + 封面偏移：spreads [1] [2,3] [4,5]，末 spread 行首 4
    expect(getNextNavigationPage(4, 'dual', 5, true)).toBe(4);
    expect(getNextNavigationPage(5, 'dual', 5, true)).toBe(4);
    // 4 页：spreads [1] [2,3] [4]，从 [2,3] 前进落在尾页 4
    expect(getNextNavigationPage(2, 'dual', 4, true)).toBe(4);
    expect(getNextNavigationPage(4, 'dual', 4, true)).toBe(4);
  });

  it('reports availability with the cover as its own step', () => {
    expect(canNavigatePrev(1, 'dual', true)).toBe(false);
    // 第 2 页已是第二个 spread，可以退回封面
    expect(canNavigatePrev(2, 'dual', true)).toBe(true);
    expect(canNavigateNext(4, 'dual', 5, true)).toBe(false);
    expect(canNavigateNext(5, 'dual', 5, true)).toBe(false);
    expect(canNavigateNext(1, 'dual', 5, true)).toBe(true);
  });
});

describe('toolbar availability', () => {
  it('single mode mirrors page bounds', () => {
    expect(canNavigatePrev(1, 'single')).toBe(false);
    expect(canNavigatePrev(2, 'single')).toBe(true);
    expect(canNavigateNext(9, 'single', 10)).toBe(true);
    expect(canNavigateNext(10, 'single', 10)).toBe(false);
  });

  it('dual mode treats the whole spread as one step', () => {
    // 首个 spread 内（第 1、2 页）都不可再往前
    expect(canNavigatePrev(1, 'dual')).toBe(false);
    expect(canNavigatePrev(2, 'dual')).toBe(false);
    expect(canNavigatePrev(3, 'dual')).toBe(true);
    // 末 spread（[3,4] of 4 页）不可再往后
    expect(canNavigateNext(3, 'dual', 4)).toBe(false);
    expect(canNavigateNext(4, 'dual', 4)).toBe(false);
    expect(canNavigateNext(2, 'dual', 4)).toBe(true);
  });

  it('handles empty documents', () => {
    expect(canNavigateNext(1, 'single', 0)).toBe(false);
    expect(canNavigateNext(1, 'dual', 0)).toBe(false);
  });
});

describe('resolvePageScrollKeyAction (PageUp/PageDown semantics)', () => {
  it('scrolls one screen when the page is taller than the viewport (zoomed in)', () => {
    expect(resolvePageScrollKeyAction(1600, 800)).toBe('scroll');
    expect(resolvePageScrollKeyAction(802, 800)).toBe('scroll');
  });

  it('navigates by page when the page fits the viewport', () => {
    expect(resolvePageScrollKeyAction(800, 800)).toBe('navigate');
    expect(resolvePageScrollKeyAction(801, 800)).toBe('navigate'); // 1px 容差内视为可见
    expect(resolvePageScrollKeyAction(400, 800)).toBe('navigate');
  });

  it('falls back to navigate on degenerate metrics', () => {
    expect(resolvePageScrollKeyAction(0, 800)).toBe('navigate');
    expect(resolvePageScrollKeyAction(800, 0)).toBe('navigate');
    expect(resolvePageScrollKeyAction(Number.NaN, 800)).toBe('navigate');
    expect(resolvePageScrollKeyAction(800, Number.POSITIVE_INFINITY)).toBe('navigate');
  });
});
