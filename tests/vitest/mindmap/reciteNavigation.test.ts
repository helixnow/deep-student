import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '@/features/mindmap/types';
import { findNextUnrevealedBlank } from '@/features/mindmap/utils/reciteNavigation';

const nodes: MindMapNode[] = [
  { id: 'a', text: 'alpha', children: [], blankedRanges: [{ start: 0, end: 2 }] },
  {
    id: 'b',
    text: 'beta',
    children: [],
    blankedRanges: [{ start: 0, end: 1 }, { start: 2, end: 4 }],
  },
];

describe('recite keyboard navigation', () => {
  it('reveals the next hidden blank on the focused node', () => {
    expect(findNextUnrevealedBlank(nodes, 'b', { b: { 0: true } })).toEqual({
      nodeId: 'b',
      rangeIndex: 1,
    });
  });

  it('advances and wraps to another node when the focused node is complete', () => {
    expect(findNextUnrevealedBlank(nodes, 'b', { b: { 0: true, 1: true } })).toEqual({
      nodeId: 'a',
      rangeIndex: 0,
    });
  });

  it('returns null when every blank is revealed', () => {
    expect(findNextUnrevealedBlank(nodes, 'a', { a: { 0: true }, b: { 0: true, 1: true } })).toBeNull();
  });
});
