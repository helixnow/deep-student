import { afterEach, describe, expect, it } from 'vitest';

import type { MindMapNode } from '@/features/mindmap/types';
import {
  clearOutlineGoalColumn,
  collectSubtreeCollapseTargets,
  countDescendants,
  createOutlineCaretController,
  estimateOutlineTextWidth,
  getOutlineGoalColumn,
  getOutlineGoalVisual,
  requestOutlineCaret,
  resolveGoalColumnOffset,
  resolveGoalEntryOffset,
  resolveVisualColumnOffset,
  shouldNavigateAcrossOutlineNode,
  isOutlineCompositionActive,
  setOutlineGoalColumn,
  setOutlineGoalVisual,
  takeOutlineCaret,
} from '@/features/mindmap/utils/outlineCaret';

function node(
  id: string,
  text: string,
  children: MindMapNode[] = [],
  extra: Partial<MindMapNode> = {},
): MindMapNode {
  return { id, text, children, ...extra };
}

afterEach(() => {
  clearOutlineGoalColumn();
  // drain any leftover pending caret
  takeOutlineCaret('__drain__');
});

describe('resolveGoalColumnOffset', () => {
  it('clamps goal to text length', () => {
    expect(resolveGoalColumnOffset(10, 4)).toBe(4);
    expect(resolveGoalColumnOffset(0, 4)).toBe(0);
    expect(resolveGoalColumnOffset(2, 4)).toBe(2);
  });

  it('uses fallback when goal is null/undefined', () => {
    expect(resolveGoalColumnOffset(null, 5, 3)).toBe(3);
    expect(resolveGoalColumnOffset(undefined, 5, 1)).toBe(1);
    expect(resolveGoalColumnOffset(null, 5)).toBe(0);
  });

  it('never returns negative or beyond length', () => {
    expect(resolveGoalColumnOffset(-3, 8)).toBe(0);
    expect(resolveGoalColumnOffset(99, 0)).toBe(0);
  });
});

describe('outline keyboard boundaries', () => {
  it('keeps vertical arrows inside multiline text until a logical boundary', () => {
    const text = 'first\nsecond\nthird';
    expect(shouldNavigateAcrossOutlineNode(text, 8, 'up')).toBe(false);
    expect(shouldNavigateAcrossOutlineNode(text, 8, 'down')).toBe(false);
    expect(shouldNavigateAcrossOutlineNode(text, 2, 'up')).toBe(true);
    expect(shouldNavigateAcrossOutlineNode(text, text.length - 2, 'down')).toBe(true);
  });

  it('recognizes both modern and legacy IME composition signals', () => {
    expect(isOutlineCompositionActive({ isComposing: true })).toBe(true);
    expect(isOutlineCompositionActive({ keyCode: 229 })).toBe(true);
    expect(isOutlineCompositionActive({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe('outline goal column state', () => {
  it('stores and clears goal column across vertical nav', () => {
    expect(getOutlineGoalColumn()).toBeNull();
    setOutlineGoalColumn(7);
    expect(getOutlineGoalColumn()).toBe(7);
    clearOutlineGoalColumn();
    expect(getOutlineGoalColumn()).toBeNull();
  });

  it('stores visual goal (px + font) and clears together with column', () => {
    expect(getOutlineGoalVisual()).toBeNull();
    setOutlineGoalVisual(42.5, '15px sans-serif');
    expect(getOutlineGoalVisual()).toEqual({ px: 42.5, font: '15px sans-serif' });
    setOutlineGoalVisual(10);
    expect(getOutlineGoalVisual()).toEqual({ px: 10, font: null });
    clearOutlineGoalColumn();
    expect(getOutlineGoalVisual()).toBeNull();
  });

  it('clamps negative / non-finite visual goals', () => {
    setOutlineGoalVisual(-5);
    expect(getOutlineGoalVisual()).toEqual({ px: 0, font: null });
    setOutlineGoalVisual(Number.NaN);
    expect(getOutlineGoalVisual()).toBeNull();
  });

  it('pending caret is consumed once per node', () => {
    requestOutlineCaret('a', 3);
    expect(takeOutlineCaret('b')).toBeNull();
    expect(takeOutlineCaret('a')).toBe(3);
    expect(takeOutlineCaret('a')).toBeNull();
  });
});

describe('per-instance caret scopes (E01 B1)', () => {
  it('isolates pending caret between scopes', () => {
    const scopeA = {};
    const scopeB = {};
    requestOutlineCaret('n1', 2, scopeA);
    requestOutlineCaret('n1', 9, scopeB);
    expect(takeOutlineCaret('n1', scopeA)).toBe(2);
    expect(takeOutlineCaret('n1', scopeB)).toBe(9);
    expect(takeOutlineCaret('n1', scopeA)).toBeNull();
  });

  it('isolates goal column / visual goal between scopes', () => {
    const scopeA = {};
    const scopeB = {};
    setOutlineGoalColumn(4, scopeA);
    setOutlineGoalVisual(30, '15px sans-serif', scopeA);
    expect(getOutlineGoalColumn(scopeB)).toBeNull();
    expect(getOutlineGoalVisual(scopeB)).toBeNull();
    expect(getOutlineGoalColumn(scopeA)).toBe(4);
    clearOutlineGoalColumn(scopeA);
    expect(getOutlineGoalColumn(scopeA)).toBeNull();
    expect(getOutlineGoalVisual(scopeA)).toBeNull();
  });

  it('scoped take falls back to the default scope (viewContinuity path)', () => {
    const scope = {};
    // 视图切换 resume 等无 scope 的写入落在默认 scope
    requestOutlineCaret('resume-node', 5);
    expect(takeOutlineCaret('resume-node', scope)).toBe(5);
    expect(takeOutlineCaret('resume-node', scope)).toBeNull();
    // scoped 写入优先于默认 scope 的同名 pending
    requestOutlineCaret('n2', 1);
    requestOutlineCaret('n2', 7, scope);
    expect(takeOutlineCaret('n2', scope)).toBe(7);
    expect(takeOutlineCaret('n2')).toBe(1);
  });

  it('controller binds all operations to its scope', () => {
    const ctl = createOutlineCaretController({});
    ctl.requestOutlineCaret('x', 6);
    expect(takeOutlineCaret('x')).toBeNull();
    expect(ctl.takeOutlineCaret('x')).toBe(6);
    ctl.setOutlineGoalColumn(3);
    ctl.setOutlineGoalVisual(12, '15px sans-serif');
    expect(getOutlineGoalColumn()).toBeNull();
    expect(ctl.getOutlineGoalColumn()).toBe(3);
    expect(ctl.getOutlineGoalVisual()).toEqual({ px: 12, font: '15px sans-serif' });
    ctl.clearOutlineGoalColumn();
    expect(ctl.getOutlineGoalColumn()).toBeNull();
  });
});

describe('estimateOutlineTextWidth', () => {
  it('estimates ascii at 0.55em and CJK at 1em with the default 15px font', () => {
    expect(estimateOutlineTextWidth('')).toBe(0);
    expect(estimateOutlineTextWidth('ab')).toBeCloseTo(2 * 15 * 0.55);
    expect(estimateOutlineTextWidth('中文')).toBeCloseTo(2 * 15);
    expect(estimateOutlineTextWidth('a中')).toBeCloseTo(15 * 0.55 + 15);
  });

  it('respects an explicit font size', () => {
    expect(estimateOutlineTextWidth('a', '20px sans-serif')).toBeCloseTo(11);
    expect(estimateOutlineTextWidth('中', 'bold 20px "PingFang SC"')).toBeCloseTo(20);
  });
});

describe('resolveVisualColumnOffset', () => {
  // 具体中段落点依赖测量实现（canvas 或估宽），这里只锁边界与单调性
  it('clamps to line boundaries', () => {
    expect(resolveVisualColumnOffset('', 100)).toBe(0);
    expect(resolveVisualColumnOffset('abc', 0)).toBe(0);
    expect(resolveVisualColumnOffset('abc', -1)).toBe(0);
    expect(resolveVisualColumnOffset('abc中文', 1e6)).toBe(5);
  });

  it('is monotonic in the pixel goal', () => {
    const text = 'ab中文cd';
    let prev = 0;
    for (let px = 0; px <= 120; px += 5) {
      const offset = resolveVisualColumnOffset(text, px);
      expect(offset).toBeGreaterThanOrEqual(prev);
      prev = offset;
    }
    expect(prev).toBe(text.length);
  });
});

describe('resolveGoalEntryOffset', () => {
  it('uses the character column when no visual goal is present', () => {
    expect(resolveGoalEntryOffset('hello', 'first-line', { column: 3 })).toBe(3);
    expect(resolveGoalEntryOffset('hello', 'first-line', { column: 99 })).toBe(5);
    expect(resolveGoalEntryOffset('hello', 'last-line', { column: null })).toBe(0);
  });

  it('lands on the first logical line when navigating down', () => {
    expect(resolveGoalEntryOffset('ab\ncdef', 'first-line', { column: 5 })).toBe(2);
    expect(resolveGoalEntryOffset('ab\ncdef', 'first-line', { column: 1 })).toBe(1);
  });

  it('lands on the last logical line when navigating up', () => {
    expect(resolveGoalEntryOffset('ab\ncdef', 'last-line', { column: 1 })).toBe(4);
    expect(resolveGoalEntryOffset('ab\ncdef', 'last-line', { column: 99 })).toBe(7);
  });

  it('prefers the visual pixel goal over the character column', () => {
    // px=0 必落行首，即使字符列更大（说明 px 优先生效）
    expect(resolveGoalEntryOffset('ab\ncdef', 'last-line', { column: 3, px: 0 })).toBe(3);
    expect(
      resolveGoalEntryOffset('ab\ncdef', 'last-line', { column: 0, px: 1e6 }),
    ).toBe(7);
  });
});

describe('countDescendants', () => {
  it('returns 0 for leaf', () => {
    expect(countDescendants(node('a', 'A'))).toBe(0);
  });

  it('counts nested descendants excluding self', () => {
    const tree = node('root', 'R', [
      node('a', 'A', [node('a1', 'A1'), node('a2', 'A2', [node('a21', 'A21')])]),
      node('b', 'B'),
    ]);
    expect(countDescendants(tree)).toBe(5);
    expect(countDescendants(tree.children[0])).toBe(3);
  });
});

describe('collectSubtreeCollapseTargets', () => {
  it('skips subtree root and only collects mismatched nodes', () => {
    const root = node('vr', 'Focus', [
      node('a', 'A', [node('a1', 'A1')], { collapsed: false }),
      node('b', 'B', [node('b1', 'B1')], { collapsed: true }),
      node('c', 'C'),
    ]);

    expect(collectSubtreeCollapseTargets(root, 'collapse')).toEqual(['a']);
    expect(collectSubtreeCollapseTargets(root, 'expand')).toEqual(['b']);
  });

  it('walks nested levels for expand/collapse', () => {
    const root = node('vr', 'Focus', [
      node('a', 'A', [
        node('a1', 'A1', [node('a11', 'A11')], { collapsed: true }),
      ], { collapsed: false }),
    ]);

    expect(collectSubtreeCollapseTargets(root, 'collapse')).toEqual(['a']);
    expect(collectSubtreeCollapseTargets(root, 'expand')).toEqual(['a1']);
  });
});
