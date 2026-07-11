import { describe, expect, it } from 'vitest';

import type { MindMapNode } from '@/features/mindmap/types';
import {
  collectSearchPathIds,
  flattenOutlineTree,
  resolveSearchPathIds,
  splitSearchHighlights,
} from '@/features/mindmap/utils/searchFilter';
import { collectTopLevelNodeIds } from '@/features/mindmap/utils/node/traverse';

function node(
  id: string,
  text: string,
  children: MindMapNode[] = [],
  extras: Partial<MindMapNode> = {}
): MindMapNode {
  return { id, text, children, ...extras };
}

describe('searchFilter', () => {
  const root = node('root', 'Root', [
    node('a', 'Alpha', [
      node('a1', 'Alpha child'),
      node('a2', 'Target match'),
    ]),
    node('b', 'Beta', [node('b1', 'Other')]),
  ]);

  it('collectSearchPathIds keeps matches and ancestors', () => {
    const path = collectSearchPathIds(root, ['a2']);
    expect([...path].sort()).toEqual(['a', 'a2', 'root']);
  });

  it('flattenOutlineTree filter mode shows only path nodes and ignores collapse', () => {
    const collapsedRoot: MindMapNode = {
      ...root,
      children: [
        { ...root.children[0], collapsed: true },
        root.children[1],
      ],
    };
    const pathIds = collectSearchPathIds(collapsedRoot, ['a2']);
    const flat = flattenOutlineTree(collapsedRoot, { pathIds });
    expect(flat.map((n) => n.id)).toEqual(['root', 'a', 'a2']);
  });

  it('flattenOutlineTree without pathIds respects collapse', () => {
    const collapsedRoot: MindMapNode = {
      ...root,
      children: [
        { ...root.children[0], collapsed: true },
        root.children[1],
      ],
    };
    const flat = flattenOutlineTree(collapsedRoot);
    expect(flat.map((n) => n.id)).toEqual(['root', 'a', 'b', 'b1']);
  });

  it('clearing pathIds restores full visible tree', () => {
    const pathIds = collectSearchPathIds(root, ['a2']);
    const filtered = flattenOutlineTree(root, { pathIds });
    const full = flattenOutlineTree(root, { pathIds: null });
    expect(filtered.map((n) => n.id)).toEqual(['root', 'a', 'a2']);
    expect(full.map((n) => n.id)).toEqual(['root', 'a', 'a1', 'a2', 'b', 'b1']);
  });

  it('splitSearchHighlights marks query fragments case-insensitively', () => {
    expect(splitSearchHighlights('Hello Target World', 'target')).toEqual([
      { text: 'Hello ', match: false },
      { text: 'Target', match: true },
      { text: ' World', match: false },
    ]);
  });

  it('hideCompleted still works when not filtering by search', () => {
    const tree = node('root', 'Root', [
      node('done', 'Done', [], { completed: true }),
      node('open', 'Open'),
    ]);
    const flat = flattenOutlineTree(tree, { hideCompleted: true });
    expect(flat.map((n) => n.id)).toEqual(['root', 'open']);
  });

  it('active non-empty search with zero matches keeps an empty filtered view', () => {
    const pathIds = resolveSearchPathIds(root, {
      enabled: true,
      query: 'missing',
      matchIds: [],
    });
    expect(pathIds).toEqual(new Set());
    expect(flattenOutlineTree(root, { pathIds }).map((n) => n.id)).toEqual([]);
  });

  it('collects paths and top-level selections linearly for 10k nodes', () => {
    const children = Array.from({ length: 10_000 }, (_, index) =>
      node(`n_${index}`, `Node ${index}`),
    );
    const largeRoot = node('large_root', 'Root', children);
    const ids = children.map((child) => child.id);

    const paths = collectSearchPathIds(largeRoot, ids);
    expect(paths.size).toBe(10_001);
    expect(paths.has('large_root')).toBe(true);

    const reversed = [...ids].reverse();
    expect(collectTopLevelNodeIds(largeRoot, [...reversed, reversed[0]])).toEqual(reversed);
  });
});
