import { describe, expect, it } from 'vitest';

import type { MindMapNode } from '@/features/mindmap/types';
import {
  collectSearchPathIds,
  flattenOutlineTree,
  hasSearchResults,
  resolveSearchPathIds,
  searchMindMapNodeIds,
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

  describe('SearchOptions', () => {
    const optionsRoot = node('root', 'Root', [
      node('lower', 'target here', [], { note: 'plain note' }),
      node('upper', 'Target here'),
      node('word', 'a cat sat'),
      node('substring', 'concatenate'),
      node('note-only', 'no hit in text', [], { note: 'CAT in note' }),
    ]);

    it('defaults stay backward compatible: case-insensitive substring', () => {
      expect(searchMindMapNodeIds(optionsRoot, 'target')).toEqual(['lower', 'upper']);
      expect(searchMindMapNodeIds(optionsRoot, 'cat')).toEqual([
        'word', 'substring', 'note-only',
      ]);
    });

    it('caseSensitive matches exact case in text and note', () => {
      expect(searchMindMapNodeIds(optionsRoot, 'Target', { caseSensitive: true })).toEqual([
        'upper',
      ]);
      expect(searchMindMapNodeIds(optionsRoot, 'CAT', { caseSensitive: true })).toEqual([
        'note-only',
      ]);
    });

    it('wholeWord skips substring-only occurrences', () => {
      expect(searchMindMapNodeIds(optionsRoot, 'cat', { wholeWord: true })).toEqual([
        'word', 'note-only',
      ]);
    });

    it('caseSensitive + wholeWord combine', () => {
      expect(
        searchMindMapNodeIds(optionsRoot, 'cat', { caseSensitive: true, wholeWord: true }),
      ).toEqual(['word']);
    });

    it('splitSearchHighlights honors caseSensitive', () => {
      expect(splitSearchHighlights('Target target', 'target', { caseSensitive: true })).toEqual([
        { text: 'Target ', match: false },
        { text: 'target', match: true },
      ]);
    });

    it('splitSearchHighlights honors wholeWord', () => {
      expect(splitSearchHighlights('concatenate cat', 'cat', { wholeWord: true })).toEqual([
        { text: 'concatenate ', match: false },
        { text: 'cat', match: true },
      ]);
    });

    it('wholeWord treats unicode letters as word characters', () => {
      // 「猫」两侧是 CJK 字符时不算词边界；两侧是空格/标点时命中
      expect(splitSearchHighlights('a cat, dog', 'cat', { wholeWord: true })).toEqual([
        { text: 'a ', match: false },
        { text: 'cat', match: true },
        { text: ', dog', match: false },
      ]);
    });
  });

  describe('hasSearchResults', () => {
    it('returns true when search is inactive or query empty', () => {
      expect(hasSearchResults({ enabled: false, query: 'x', matchIds: [] })).toBe(true);
      expect(hasSearchResults({ enabled: true, query: '   ', matchIds: [] })).toBe(true);
    });

    it('reflects matches for an active non-empty query', () => {
      expect(hasSearchResults({ enabled: true, query: 'x', matchIds: ['a'] })).toBe(true);
      expect(hasSearchResults({ enabled: true, query: 'x', matchIds: [] })).toBe(false);
    });
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
