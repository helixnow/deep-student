import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '@/features/mindmap/types';
import {
  collectCanvasDragSubtreeIds,
  resolveCanvasDragNodeIds,
} from '@/features/mindmap/utils/canvasDragSelection';

const root: MindMapNode = {
  id: 'root',
  text: 'Root',
  children: [
    {
      id: 'a',
      text: 'A',
      children: [{ id: 'a1', text: 'A1', children: [] }],
    },
    { id: 'b', text: 'B', children: [] },
    { id: 'c', text: 'C', children: [] },
  ],
};

describe('canvas multi-selection drag', () => {
  it('keeps all selected top-level roots when dragging one selected node', () => {
    expect(resolveCanvasDragNodeIds(root, ['a', 'a1', 'b'], 'b')).toEqual(['a', 'b']);
    expect(resolveCanvasDragNodeIds(root, ['a', 'a1', 'b'], 'a1')).toEqual(['a', 'b']);
  });

  it('falls back to a single node when drag starts outside the selection', () => {
    expect(resolveCanvasDragNodeIds(root, ['a', 'b'], 'c')).toEqual(['c']);
  });

  it('excludes the complete dragged forest from drop candidates', () => {
    expect([...collectCanvasDragSubtreeIds(root, ['a', 'b'])]).toEqual(['a', 'a1', 'b']);
  });
});
