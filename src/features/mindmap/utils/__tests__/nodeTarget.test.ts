import { describe, expect, it } from 'vitest';

import type { MindMapNode } from '../../types';
import {
  expandAncestorsInTree,
  normalizeMindmapNodeText,
  resolveMindmapNodeTarget,
} from '../nodeTarget';

function n(id: string, text: string, children: MindMapNode[] = [], extra: Partial<MindMapNode> = {}): MindMapNode {
  return { id, text, children, ...extra };
}

const tree: MindMapNode = n('root', '第 3 章 · 数据并行训练', [
  n('b1', '数据并行', [
    n('b1a', '梯度同步：All-Reduce 实现', [], { note: '环形 all-reduce\n带宽最优' }),
    n('b1b', '参数服务器'),
    n('b1c', '定义'),
  ], { collapsed: true }),
  n('b2', '模型并行', [
    n('b2a', '张量并行'),
    n('b2b', '流水线并行'),
    n('b2c', '定义'),
  ]),
]);

describe('normalizeMindmapNodeText', () => {
  it('folds width, case, markdown and punctuation', () => {
    expect(normalizeMindmapNodeText('  **ＡＢＣ**：  梯度`同步` ')).toBe('abc 梯度 同步');
  });
});

describe('resolveMindmapNodeTarget', () => {
  it('matches an explicit node id', () => {
    expect(resolveMindmapNodeTarget(tree, { nodeId: 'b2a' })).toEqual({ nodeId: 'b2a', matchedBy: 'id' });
  });

  it('treats a hint that equals a node id as id', () => {
    expect(resolveMindmapNodeTarget(tree, { text: 'b1b' })).toEqual({ nodeId: 'b1b', matchedBy: 'id' });
  });

  it('falls through an unknown explicit id to the text hint', () => {
    expect(resolveMindmapNodeTarget(tree, { nodeId: 'gone', text: '参数服务器' }))
      .toEqual({ nodeId: 'b1b', matchedBy: 'exact' });
  });

  it('matches exact text, then normalized text', () => {
    expect(resolveMindmapNodeTarget(tree, { text: '张量并行' })).toEqual({ nodeId: 'b2a', matchedBy: 'exact' });
    expect(resolveMindmapNodeTarget(tree, { text: '梯度同步: all-reduce 实现' }))
      .toEqual({ nodeId: 'b1a', matchedBy: 'normalized' });
  });

  it('fuzzy-matches partial / slightly different text', () => {
    expect(resolveMindmapNodeTarget(tree, { text: 'All-Reduce' })).toEqual({ nodeId: 'b1a', matchedBy: 'fuzzy' });
    expect(resolveMindmapNodeTarget(tree, { text: '流水并行' })).toEqual({ nodeId: 'b2b', matchedBy: 'fuzzy' });
  });

  it('returns null when nothing matches (caller just opens the mindmap)', () => {
    expect(resolveMindmapNodeTarget(tree, { text: '量子纠缠' })).toBeNull();
    expect(resolveMindmapNodeTarget(tree, { text: '   ' })).toBeNull();
    expect(resolveMindmapNodeTarget(tree, {})).toBeNull();
    expect(resolveMindmapNodeTarget(null, { text: '数据并行' })).toBeNull();
  });

  describe('retrieval chunk text (MindmapBuilder indented outline)', () => {
    it('locates the lowest common ancestor of the matched lines, ignoring note lines', () => {
      const chunk = [
        '  数据并行',
        '    梯度同步：All-Reduce 实现',
        '      环形 all-reduce',
        '      带宽最优',
        '    参数服务器',
      ].join('\n');
      expect(resolveMindmapNodeTarget(tree, { chunkText: chunk })).toEqual({ nodeId: 'b1', matchedBy: 'chunk' });
    });

    it('locates a single node line', () => {
      expect(resolveMindmapNodeTarget(tree, { chunkText: '    流水线并行\n' }))
        .toEqual({ nodeId: 'b2b', matchedBy: 'chunk' });
    });

    it('ignores ambiguous duplicate lines when unique lines exist', () => {
      expect(resolveMindmapNodeTarget(tree, { chunkText: '    张量并行\n    定义' }))
        .toEqual({ nodeId: 'b2a', matchedBy: 'chunk' });
    });

    it('gives up when the chunk spans multiple top-level branches', () => {
      expect(resolveMindmapNodeTarget(tree, { chunkText: '    参数服务器\n  模型并行\n    张量并行' })).toBeNull();
    });

    it('falls back to fuzzy matching a truncated snippet line', () => {
      expect(resolveMindmapNodeTarget(tree, { chunkText: '梯度同步：All-Reduce 实' }))
        .toEqual({ nodeId: 'b1a', matchedBy: 'chunk' });
    });

    it('prefers the text hint over the chunk', () => {
      expect(resolveMindmapNodeTarget(tree, { text: '张量并行', chunkText: '参数服务器' }))
        .toEqual({ nodeId: 'b2a', matchedBy: 'exact' });
    });
  });
});

describe('expandAncestorsInTree', () => {
  it('uncollapses only ancestors of the target and shares untouched subtrees', () => {
    const next = expandAncestorsInTree(tree, 'b1a');
    expect(next).not.toBe(tree);
    expect(next.children[0].collapsed).toBe(false);
    expect(next.children[1]).toBe(tree.children[1]);
    expect(tree.children[0].collapsed).toBe(true);
  });

  it('returns the same tree when nothing needs expanding or target is missing', () => {
    expect(expandAncestorsInTree(tree, 'b2a')).toBe(tree);
    expect(expandAncestorsInTree(tree, 'missing')).toBe(tree);
  });
});
