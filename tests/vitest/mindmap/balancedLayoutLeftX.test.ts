import { describe, expect, it } from 'vitest';

import { BalancedLayoutEngine } from '@/features/mindmap/layouts/mindmap/BalancedLayoutEngine';
import { DEFAULT_LAYOUT_CONFIG } from '@/features/mindmap/constants';
import { calculateNodeWidth } from '@/features/mindmap/utils/layout/helpers';
import type { MindMapNode } from '@/features/mindmap/types';

const engine = new BalancedLayoutEngine();

function leaf(id: string, text: string): MindMapNode {
  return { id, text, children: [] };
}

describe('BalancedLayoutEngine left X', () => {
  it('places each left grandchild by its own width (not children[0] width)', () => {
    const short = leaf('short', 'A');
    const wide = leaf('wide', 'WWWWWWWWWWWWWWWWWWWWWWWWWW');
    const leftParent: MindMapNode = {
      id: 'left-parent',
      text: 'L',
      children: [short, wide],
    };
    const root: MindMapNode = {
      id: 'root',
      text: 'Root',
      children: [leftParent],
    };

    const config = { ...DEFAULT_LAYOUT_CONFIG };
    const { nodes } = engine.calculate(root, config);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const parent = byId.get('left-parent')!;
    const shortNode = byId.get('short')!;
    const wideNode = byId.get('wide')!;

    const parentWidth = calculateNodeWidth(leftParent, config);
    const shortWidth = calculateNodeWidth(short, config);
    const wideWidth = calculateNodeWidth(wide, config);

    // Parent right edge sits at -horizontalGap from root
    expect(parent.position.x + parentWidth).toBeCloseTo(-config.horizontalGap, 5);

    // Each left child: x = parentLeft - gap - ownWidth
    const childRightEdge = parent.position.x - config.horizontalGap;
    expect(shortNode.position.x).toBeCloseTo(childRightEdge - shortWidth, 5);
    expect(wideNode.position.x).toBeCloseTo(childRightEdge - wideWidth, 5);

    // Wide sibling must not share the short sibling's X
    expect(wideWidth).toBeGreaterThan(shortWidth);
    expect(wideNode.position.x).toBeLessThan(shortNode.position.x);

    // Neither overlaps the root (x >= 0)
    expect(shortNode.position.x + shortWidth).toBeLessThanOrEqual(0);
    expect(wideNode.position.x + wideWidth).toBeLessThanOrEqual(0);
  });

  it('places unequal-width root-level left siblings on their own widths', () => {
    // Equal-height leaves: distribute L, R, L → short & wide both on left
    const short = leaf('L-short', 'Hi');
    const rightFiller = leaf('R-fill', 'R');
    const wide = leaf('L-wide', 'XXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    const root: MindMapNode = {
      id: 'root2',
      text: 'Root',
      children: [short, rightFiller, wide],
    };

    const config = { ...DEFAULT_LAYOUT_CONFIG };
    const { nodes } = engine.calculate(root, config);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const shortNode = byId.get('L-short')!;
    const wideNode = byId.get('L-wide')!;
    expect(shortNode.data?.side).toBe('left');
    expect(wideNode.data?.side).toBe('left');

    const shortWidth = calculateNodeWidth(short, config);
    const wideWidth = calculateNodeWidth(wide, config);
    const expectedRightEdge = -config.horizontalGap;

    expect(shortNode.position.x + shortWidth).toBeCloseTo(expectedRightEdge, 5);
    expect(wideNode.position.x + wideWidth).toBeCloseTo(expectedRightEdge, 5);
    expect(wideWidth).toBeGreaterThan(shortWidth);
    expect(wideNode.position.x).toBeLessThan(shortNode.position.x);
  });
});
