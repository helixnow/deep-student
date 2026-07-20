import { describe, expect, it } from 'vitest';

import { BalancedLayoutEngine } from '@/features/mindmap/layouts/mindmap/BalancedLayoutEngine';
import { DEFAULT_LAYOUT_CONFIG } from '@/features/mindmap/constants';
import { calculateNodeWidth } from '@/features/mindmap/utils/layout/helpers';
import type { MindMapNode } from '@/features/mindmap/types';

const engine = new BalancedLayoutEngine();

function leaf(id: string, text: string): MindMapNode {
  return { id, text, children: [] };
}

// 注意：等高子树的 tie-break 规则为「先比子树数量，数量也相等时默认右侧」，
// 因此想让某个子树落在左侧，需要先用更高的 filler 子树占住右侧。

describe('BalancedLayoutEngine left X', () => {
  it('places each left grandchild by its own width (not children[0] width)', () => {
    const short = leaf('short', 'A');
    const wide = leaf('wide', 'WWWWWWWWWWWWWWWWWWWWWWWWWW');
    const leftParent: MindMapNode = {
      id: 'left-parent',
      text: 'L',
      children: [short, wide],
    };
    // 3 个叶子的 filler 子树更高 → 首个分配到右侧，把 leftParent 挤到左侧
    const tallFiller: MindMapNode = {
      id: 'tall-filler',
      text: 'F',
      children: [leaf('f1', 'a'), leaf('f2', 'b'), leaf('f3', 'c')],
    };
    const root: MindMapNode = {
      id: 'root',
      text: 'Root',
      children: [tallFiller, leftParent],
    };

    const config = { ...DEFAULT_LAYOUT_CONFIG };
    const { nodes } = engine.calculate(root, config);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const parent = byId.get('left-parent')!;
    const shortNode = byId.get('short')!;
    const wideNode = byId.get('wide')!;

    expect(parent.data?.side).toBe('left');
    expect(byId.get('tall-filler')!.data?.side).toBe('right');

    const parentWidth = calculateNodeWidth(leftParent, config);
    const shortWidth = calculateNodeWidth(short, config);
    const wideWidth = calculateNodeWidth(wide, config);

    // Parent right edge sits at -horizontalGap from root
    // （根 → 一级层距 = horizontalGap × scale(0) = 80 × 1 = 80，深度收敛不影响首层）
    expect(parent.position.x + parentWidth).toBeCloseTo(-config.horizontalGap, 5);

    // Each left child: x = parentLeft - depthGap - ownWidth
    // 深度间距收敛默认开启：level-1 父节点 → level-2 子节点的层距
    // = horizontalGap × 0.9¹ = 80 × 0.9 = 72
    const childRightEdge = parent.position.x - config.horizontalGap * 0.9;
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
    // 更高的 filler 子树先占右侧，其余等高叶子依次落到左侧
    const tallFiller: MindMapNode = {
      id: 'R-fill',
      text: 'F',
      children: [leaf('rf1', 'a'), leaf('rf2', 'b')],
    };
    const short = leaf('L-short', 'Hi');
    const wide = leaf('L-wide', 'XXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    const root: MindMapNode = {
      id: 'root2',
      text: 'Root',
      children: [tallFiller, short, wide],
    };

    const config = { ...DEFAULT_LAYOUT_CONFIG };
    const { nodes } = engine.calculate(root, config);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const shortNode = byId.get('L-short')!;
    const wideNode = byId.get('L-wide')!;
    expect(byId.get('R-fill')!.data?.side).toBe('right');
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

  it('sends a single child to the right side (XMind convention)', () => {
    const only = leaf('only', 'Solo');
    const root: MindMapNode = { id: 'root3', text: 'Root', children: [only] };

    const config = { ...DEFAULT_LAYOUT_CONFIG };
    const { nodes } = engine.calculate(root, config);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const onlyNode = byId.get('only')!;
    expect(onlyNode.data?.side).toBe('right');
    expect(onlyNode.position.x).toBeGreaterThan(0);
  });

  it('alternates equal-height siblings between sides', () => {
    const kids = ['a', 'b', 'c', 'd'].map((id) => leaf(id, id));
    const root: MindMapNode = { id: 'root4', text: 'Root', children: kids };

    const config = { ...DEFAULT_LAYOUT_CONFIG };
    const { nodes } = engine.calculate(root, config);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const sides = ['a', 'b', 'c', 'd'].map((id) => byId.get(id)!.data?.side);
    expect(sides.filter((s) => s === 'left')).toHaveLength(2);
    expect(sides.filter((s) => s === 'right')).toHaveLength(2);
  });
});
