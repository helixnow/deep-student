import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '@/features/mindmap/types';
import {
  collapseAll,
  expandAll,
  collapseToDepth,
  expandToDepth,
} from '@/features/mindmap/utils/node/update';
import { countDescendants } from '@/features/mindmap/utils/node/traverse';

function node(
  id: string,
  children: MindMapNode[] = [],
  collapsed = false,
): MindMapNode {
  return { id, text: id, children, collapsed };
}

/** root → a → a1 → a1a ; root → b */
function sampleTree(): MindMapNode {
  return node('root', [
    node('a', [node('a1', [node('a1a')])]),
    node('b'),
  ]);
}

function find(root: MindMapNode, id: string): MindMapNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

describe('countDescendants', () => {
  it('counts all descendants excluding self', () => {
    const root = sampleTree();
    expect(countDescendants(root)).toBe(4);
    expect(countDescendants(find(root, 'a')!)).toBe(2);
    expect(countDescendants(find(root, 'b')!)).toBe(0);
  });
});

describe('collapse / expand helpers', () => {
  it('collapseAll folds every non-root node with children', () => {
    const next = collapseAll(sampleTree());
    expect(next.collapsed).toBe(false);
    expect(find(next, 'a')!.collapsed).toBe(true);
    expect(find(next, 'a1')!.collapsed).toBe(true);
    expect(find(next, 'b')!.collapsed).toBe(false);
  });

  it('expandAll clears collapsed on all nodes', () => {
    const collapsed = collapseAll(sampleTree());
    const next = expandAll(collapsed);
    expect(find(next, 'a')!.collapsed).toBe(false);
    expect(find(next, 'a1')!.collapsed).toBe(false);
  });

  it('collapseToDepth(1) keeps root expanded and folds depth>=1 with children', () => {
    const next = collapseToDepth(sampleTree(), 1);
    expect(next.collapsed).toBe(false);
    expect(find(next, 'a')!.collapsed).toBe(true);
    expect(find(next, 'a1')!.collapsed).toBe(true);
    expect(find(next, 'b')!.collapsed).toBe(false);
  });

  it('collapseToDepth(2) folds only depth>=2 with children', () => {
    const next = collapseToDepth(sampleTree(), 2);
    expect(find(next, 'a')!.collapsed).toBe(false);
    expect(find(next, 'a1')!.collapsed).toBe(true);
  });

  it('expandToDepth aliases collapseToDepth', () => {
    const a = collapseToDepth(sampleTree(), 2);
    const b = expandToDepth(sampleTree(), 2);
    expect(find(a, 'a')!.collapsed).toBe(find(b, 'a')!.collapsed);
    expect(find(a, 'a1')!.collapsed).toBe(find(b, 'a1')!.collapsed);
  });
});
