import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '@/features/mindmap/types';
import {
  collectCanvasDragSubtreeIds,
  resolveCanvasDragNodeIds,
} from '@/features/mindmap/utils/canvasDragSelection';
import {
  dropOrientationForDirection,
  isWithinDropRadius,
  resolveDropTarget,
  type DropCandidate,
} from '@/features/mindmap/utils/dropTarget';
import {
  computeDropPreview,
  dropPreviewEquals,
  resolveChildGrowthSide,
  DROP_PREVIEW_GAP,
  DROP_PREVIEW_THICKNESS,
} from '@/features/mindmap/utils/dragLayoutPreview';

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

describe('drop orientation awareness', () => {
  const target: DropCandidate = { id: 't', x: 0, y: 0, width: 100, height: 40 };

  it('maps layout direction to the sibling ordering axis', () => {
    expect(dropOrientationForDirection('right')).toBe('vertical');
    expect(dropOrientationForDirection('left')).toBe('vertical');
    expect(dropOrientationForDirection('both')).toBe('vertical');
    expect(dropOrientationForDirection('radial')).toBe('vertical');
    expect(dropOrientationForDirection('up')).toBe('horizontal');
    expect(dropOrientationForDirection('down')).toBe('horizontal');
    expect(dropOrientationForDirection(undefined)).toBe('vertical');
  });

  it('resolves sibling-before/after along the X axis for up/down layouts', () => {
    const base = {
      candidates: [target],
      previousTargetId: null,
      previousMode: 'child' as const,
      orientation: 'horizontal' as const,
      modeHysteresisRatio: 0,
    };
    // band = width * 0.3 = 30，中心 x=50：x<20 → before，x>80 → after
    expect(resolveDropTarget({ ...base, dragCenterX: 10, dragCenterY: 20 }).mode)
      .toBe('sibling-before');
    expect(resolveDropTarget({ ...base, dragCenterX: 50, dragCenterY: 20 }).mode)
      .toBe('child');
    expect(resolveDropTarget({ ...base, dragCenterX: 90, dragCenterY: 20 }).mode)
      .toBe('sibling-after');
  });

  it('keeps the legacy vertical thirds when orientation is omitted', () => {
    const r = resolveDropTarget({
      dragCenterX: 50,
      dragCenterY: -10,
      candidates: [target],
      previousTargetId: null,
      previousMode: 'child',
      modeHysteresisRatio: 0,
    });
    expect(r.mode).toBe('sibling-before');
  });

  it('prefilters candidates beyond the drop radius bounding box', () => {
    expect(isWithinDropRadius(0, 0, target)).toBe(true);
    expect(isWithinDropRadius(500, 0, target)).toBe(false);
    expect(isWithinDropRadius(0, 500, target)).toBe(false);
  });
});

describe('drag layout preview (ghost insert line)', () => {
  const target = { x: 100, y: 100, width: 120, height: 40 };

  it('draws a horizontal insert line above/below for vertical sibling ordering', () => {
    const before = computeDropPreview({
      target,
      mode: 'sibling-before',
      orientation: 'vertical',
      layoutDirection: 'right',
      dragCenterX: 160,
      dragCenterY: 90,
    });
    expect(before).toMatchObject({ kind: 'insert', axis: 'h' });
    expect(before!.top).toBe(target.y - DROP_PREVIEW_GAP - DROP_PREVIEW_THICKNESS);

    const after = computeDropPreview({
      target,
      mode: 'sibling-after',
      orientation: 'vertical',
      layoutDirection: 'right',
      dragCenterX: 160,
      dragCenterY: 150,
    });
    expect(after!.top).toBe(target.y + target.height + DROP_PREVIEW_GAP);
  });

  it('draws a vertical insert line left/right for horizontal sibling ordering', () => {
    const before = computeDropPreview({
      target,
      mode: 'sibling-before',
      orientation: 'horizontal',
      layoutDirection: 'down',
      dragCenterX: 90,
      dragCenterY: 120,
    });
    expect(before).toMatchObject({ kind: 'insert', axis: 'v' });
    expect(before!.left).toBe(target.x - DROP_PREVIEW_GAP - DROP_PREVIEW_THICKNESS);

    const after = computeDropPreview({
      target,
      mode: 'sibling-after',
      orientation: 'horizontal',
      layoutDirection: 'down',
      dragCenterX: 240,
      dragCenterY: 120,
    });
    expect(after!.left).toBe(target.x + target.width + DROP_PREVIEW_GAP);
  });

  it('points the child link toward the growth side, both layout picks nearest side', () => {
    expect(resolveChildGrowthSide('right', target, 0)).toBe('right');
    expect(resolveChildGrowthSide('left', target, 999)).toBe('left');
    expect(resolveChildGrowthSide('down', target, 0)).toBe('down');
    expect(resolveChildGrowthSide('both', target, 0)).toBe('left');
    expect(resolveChildGrowthSide('both', target, 999)).toBe('right');

    const link = computeDropPreview({
      target,
      mode: 'child',
      orientation: 'vertical',
      layoutDirection: 'right',
      dragCenterX: 300,
      dragCenterY: 120,
    });
    expect(link).toMatchObject({ kind: 'child-link', axis: 'h' });
    expect(link!.left).toBe(target.x + target.width + DROP_PREVIEW_GAP);
  });

  it('dropPreviewEquals dedupes identical geometry to avoid per-frame setState', () => {
    const a = computeDropPreview({
      target,
      mode: 'sibling-after',
      orientation: 'vertical',
      layoutDirection: 'right',
      dragCenterX: 160,
      dragCenterY: 150,
    });
    const b = computeDropPreview({
      target,
      mode: 'sibling-after',
      orientation: 'vertical',
      layoutDirection: 'right',
      dragCenterX: 170,
      dragCenterY: 152,
    });
    expect(dropPreviewEquals(a, b)).toBe(true);
    expect(dropPreviewEquals(a, null)).toBe(false);
    expect(dropPreviewEquals(null, null)).toBe(true);
  });
});
