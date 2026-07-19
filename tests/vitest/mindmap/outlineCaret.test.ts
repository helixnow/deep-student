import { afterEach, describe, expect, it } from 'vitest';

import type { MindMapNode } from '@/features/mindmap/types';
import {
  clearOutlineGoalColumn,
  collectSubtreeCollapseTargets,
  countDescendants,
  getOutlineGoalColumn,
  requestOutlineCaret,
  resolveGoalColumnOffset,
  shouldNavigateAcrossOutlineNode,
  isOutlineCompositionActive,
  setOutlineGoalColumn,
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

  it('pending caret is consumed once per node', () => {
    requestOutlineCaret('a', 3);
    expect(takeOutlineCaret('b')).toBeNull();
    expect(takeOutlineCaret('a')).toBe(3);
    expect(takeOutlineCaret('a')).toBeNull();
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
