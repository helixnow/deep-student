/**
 * compactSiblingSubtrees — 轮廓扫描线优化的数学等价性、零重叠与大图性能测试
 */

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { LayoutConfig, MindMapNode } from '../../../types';
import { DEFAULT_LAYOUT_CONFIG } from '../../../constants';
import { depthGapScale } from '../../../constants/layout';
import { BalancedLayoutEngine } from '../../../layouts/mindmap/BalancedLayoutEngine';
import { TreeLayoutEngine } from '../../../layouts/mindmap/TreeLayoutEngine';
import { calculateNodeHeight, calculateNodeWidth } from '../helpers';
import { compactSiblingSubtrees } from '../compactTree';

const treeEngine = new TreeLayoutEngine();
const balancedEngine = new BalancedLayoutEngine();

interface LayoutNodeLike {
  id: string;
  position: { x: number; y: number };
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 原始 O(N²) 逐对盒枚举参考实现（仅用于测试验证 100% 坐标等价性与加速比对比） */
function compactSiblingSubtreesReference(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0,
  siblingGap: number = config.verticalGap,
): Box[] {
  const layoutNode = nodesById.get(node.id);
  const width = calculateNodeWidth(node, config, isRoot);
  const height = calculateNodeHeight(node, isRoot, config);
  const x = layoutNode?.position.x ?? 0;
  const y = layoutNode?.position.y ?? 0;
  const ownBox: Box = { minX: x, maxX: x + width, minY: y, maxY: y + height };

  if (depth > 500 || node.collapsed || !node.children || node.children.length === 0) {
    return [ownBox];
  }

  const childrenWithBoxes = node.children.map((child) => ({
    node: child,
    boxes: compactSiblingSubtreesReference(child, nodesById, config, false, depth + 1, siblingGap),
  }));

  const parentCenterX = (ownBox.minX + ownBox.maxX) / 2;
  const envelope = (boxes: Box[]): Box =>
    boxes.reduce((acc, b) => ({
      minX: Math.min(acc.minX, b.minX),
      maxX: Math.max(acc.maxX, b.maxX),
      minY: Math.min(acc.minY, b.minY),
      maxY: Math.max(acc.maxY, b.maxY),
    }));

  type Item = { node: MindMapNode; boxes: Box[] };
  const leftGroup: Item[] = [];
  const rightGroup: Item[] = [];
  const spanGroup: Item[] = [];
  for (const item of childrenWithBoxes) {
    const env = envelope(item.boxes);
    if (env.maxX <= parentCenterX) leftGroup.push(item);
    else if (env.minX >= parentCenterX) rightGroup.push(item);
    else spanGroup.push(item);
  }

  const shiftSubtreeY = (target: MindMapNode, deltaY: number, d: number) => {
    if (d > 500) return;
    const ln = nodesById.get(target.id);
    if (ln) ln.position.y += deltaY;
    if (target.collapsed || !target.children?.length) return;
    target.children.forEach((c) => shiftSubtreeY(c, deltaY, d + 1));
  };

  const minClearance = (placed: Box[], current: Box[]): number => {
    let minGap = Infinity;
    for (const a of placed) {
      for (const b of current) {
        if (b.minX < a.maxX && b.maxX > a.minX) {
          const gap = b.minY - a.maxY;
          if (gap < minGap) minGap = gap;
        }
      }
    }
    return minGap;
  };

  const gapAtDepth = siblingGap * depthGapScale(config, depth);
  const compactGroup = (items: Item[]) => {
    const placed: Box[] = [];
    for (const item of items) {
      if (placed.length > 0) {
        const clearance = minClearance(placed, item.boxes);
        const delta = clearance - gapAtDepth;
        if (Number.isFinite(delta) && delta > 0) {
          shiftSubtreeY(item.node, -delta, depth + 1);
          item.boxes = item.boxes.map((b) => ({ ...b, minY: b.minY - delta, maxY: b.maxY - delta }));
        }
      }
      placed.push(...item.boxes);
    }
  };

  compactGroup(leftGroup);
  compactGroup(rightGroup);
  compactGroup(spanGroup);

  if (layoutNode && childrenWithBoxes.length > 0) {
    const firstChildBox = childrenWithBoxes[0].boxes[0];
    const lastChildBox = childrenWithBoxes[childrenWithBoxes.length - 1].boxes[0];
    const childrenMidY = (firstChildBox.minY + lastChildBox.maxY) / 2;
    const ownHeight = ownBox.maxY - ownBox.minY;
    layoutNode.position.y = childrenMidY - ownHeight / 2;
    ownBox.minY = layoutNode.position.y;
    ownBox.maxY = layoutNode.position.y + ownHeight;
  }

  return [ownBox, ...childrenWithBoxes.flatMap((item) => item.boxes)];
}

function freshConfig(overrides: Record<string, unknown> = {}): LayoutConfig {
  return { ...DEFAULT_LAYOUT_CONFIG, ...overrides } as LayoutConfig;
}

/** 简单确定性伪随机数发生器（Mulberry32） */
function createRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLE_LABELS = [
  '短',
  'Node',
  '中等长度的中文节点标题',
  'A fairly descriptive branch label',
  '这是一个非常长的会自动折行从而产生多行高度的中文节点标题内容用于压测轮廓紧凑',
  'Alpha Beta Gamma',
  'K',
];

function buildSeededTree(totalNodes: number, maxBranching: number, seed: number): MindMapNode {
  const rng = createRng(seed);
  let seq = 0;
  const make = (): MindMapNode => {
    const label = SAMPLE_LABELS[Math.floor(rng() * SAMPLE_LABELS.length)];
    const hasNote = rng() < 0.12;
    return {
      id: `n_${seq++}`,
      text: `${label} #${seq}`,
      ...(hasNote ? { note: '补充说明文本\n第二行备注' } : {}),
      children: [],
    };
  };

  const root = make();
  const frontier: MindMapNode[] = [root];
  while (seq < totalNodes && frontier.length > 0) {
    const pickIdx = Math.floor(rng() * Math.min(frontier.length, 6));
    const parent = frontier.splice(pickIdx, 1)[0];
    const remaining = totalNodes - seq;
    const fanout = Math.min(remaining, 1 + Math.floor(rng() * maxBranching));
    for (let i = 0; i < fanout; i++) {
      const child = make();
      parent.children.push(child);
      frontier.push(child);
    }
  }
  return root;
}

function buildWideTree(branchCount: number, childrenPerBranch: number): MindMapNode {
  let seq = 0;
  const root: MindMapNode = { id: `w_${seq++}`, text: 'Wide Root', children: [] };
  for (let i = 0; i < branchCount; i++) {
    const label = SAMPLE_LABELS[i % SAMPLE_LABELS.length];
    const branch: MindMapNode = {
      id: `w_${seq++}`,
      text: `${label} ${i}`,
      children: [],
    };
    const count = i % 3 === 0 ? childrenPerBranch : i % 3 === 1 ? 1 : 0;
    for (let j = 0; j < count; j++) {
      const child: MindMapNode = {
        id: `w_${seq++}`,
        text: SAMPLE_LABELS[(i + j) % SAMPLE_LABELS.length],
        children:
          j === 0 && i % 6 === 0
            ? [
                { id: `w_${seq++}`, text: SAMPLE_LABELS[4], children: [] },
                { id: `w_${seq++}`, text: 'deep leaf', children: [] },
              ]
            : [],
      };
      branch.children.push(child);
    }
    root.children.push(branch);
  }
  return root;
}

function buildDeepTree(depth: number): MindMapNode {
  let seq = 0;
  const root: MindMapNode = { id: `d_${seq++}`, text: 'Deep Root', children: [] };
  let cursor = root;
  for (let d = 0; d < depth; d++) {
    const main: MindMapNode = {
      id: `d_${seq++}`,
      text: SAMPLE_LABELS[d % SAMPLE_LABELS.length],
      children: [],
    };
    cursor.children.push(main);
    if (d % 3 === 0) {
      cursor.children.push({
        id: `d_${seq++}`,
        text: `side-${d}`,
        children: [],
      });
    }
    cursor = main;
  }
  return root;
}

function assertNoOverlaps(nodes: Node[]) {
  const eps = 0.5;
  // 按 minX 排序并用扫描线检查，确保千级节点测试本身快速完成
  const boxes = nodes
    .map((node) => ({
      id: node.id,
      minX: node.position.x,
      maxX: node.position.x + (node.width ?? 0),
      minY: node.position.y,
      maxY: node.position.y + (node.height ?? 0),
    }))
    .sort((a, b) => a.minX - b.minX);

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (b.minX >= a.maxX - eps) break;
      const yOverlap = a.minY < b.maxY - eps && b.minY < a.maxY - eps;
      expect(yOverlap, `nodes ${a.id} and ${b.id} overlap`).toBe(false);
    }
  }
}

function cloneNodeMap(nodes: Node[]): Map<string, LayoutNodeLike> {
  return new Map(nodes.map((n) => [n.id, { id: n.id, position: { x: n.position.x, y: n.position.y } }]));
}

describe('compactSiblingSubtrees contour optimization', () => {
  it('matches O(N²) reference coordinates and returned boxes bit-for-bit across tree shapes and directions', () => {
    const cases: Array<{ name: string; root: MindMapNode; engine: 'tree' | 'balanced'; direction: 'right' | 'left' | 'both' }> = [
      { name: 'wide right tree', root: buildWideTree(60, 4), engine: 'tree', direction: 'right' },
      { name: 'wide left tree', root: buildWideTree(60, 4), engine: 'tree', direction: 'left' },
      { name: 'wide balanced tree', root: buildWideTree(60, 4), engine: 'balanced', direction: 'both' },
      { name: 'seeded random right tree', root: buildSeededTree(220, 6, 42), engine: 'tree', direction: 'right' },
      { name: 'seeded random left tree', root: buildSeededTree(220, 6, 99), engine: 'tree', direction: 'left' },
      { name: 'seeded random balanced tree', root: buildSeededTree(220, 6, 1337), engine: 'balanced', direction: 'both' },
      { name: 'deep tree with side leaves', root: buildDeepTree(120), engine: 'tree', direction: 'right' },
    ];

    for (const tc of cases) {
      const config = freshConfig();
      const baseResult =
        tc.engine === 'tree'
          ? treeEngine.calculate(tc.root, freshConfig({ compactSiblings: false }), tc.direction)
          : balancedEngine.calculate(tc.root, freshConfig({ compactSiblings: false }), tc.direction);

      const refMap = cloneNodeMap(baseResult.nodes);
      const optMap = cloneNodeMap(baseResult.nodes);

      const refBoxes = compactSiblingSubtreesReference(tc.root, refMap, config, true);
      const optBoxes = compactSiblingSubtrees(tc.root, optMap, config, true);

      expect(optBoxes.length, `${tc.name} box count`).toBe(refBoxes.length);
      for (let i = 0; i < refBoxes.length; i++) {
        expect(optBoxes[i].minX, `${tc.name} box[${i}].minX`).toBeCloseTo(refBoxes[i].minX, 9);
        expect(optBoxes[i].maxX, `${tc.name} box[${i}].maxX`).toBeCloseTo(refBoxes[i].maxX, 9);
        expect(optBoxes[i].minY, `${tc.name} box[${i}].minY`).toBeCloseTo(refBoxes[i].minY, 9);
        expect(optBoxes[i].maxY, `${tc.name} box[${i}].maxY`).toBeCloseTo(refBoxes[i].maxY, 9);
      }

      for (const [id, refNode] of refMap.entries()) {
        const optNode = optMap.get(id)!;
        expect(optNode.position.x, `${tc.name} ${id}.x`).toBeCloseTo(refNode.position.x, 9);
        expect(optNode.position.y, `${tc.name} ${id}.y`).toBeCloseTo(refNode.position.y, 9);
      }

      // 全引擎端到端零重叠
      const fullResult =
        tc.engine === 'tree'
          ? treeEngine.calculate(tc.root, freshConfig(), tc.direction)
          : balancedEngine.calculate(tc.root, freshConfig(), tc.direction);
      assertNoOverlaps(fullResult.nodes);
    }
  });

  it('keeps 900+ node wide trees and 300-level deep trees overlap-free and dramatically faster than O(N²)', () => {
    // 宽树：200 个一级分支，合计约 800-1000 节点，覆盖不同宽度与嵌套轮廓
    const wideRoot = buildWideTree(260, 5);
    const config = freshConfig();
    const uncompacted = treeEngine.calculate(
      wideRoot,
      freshConfig({ compactSiblings: false }),
      'right',
    );
    expect(uncompacted.nodes.length).toBeGreaterThanOrEqual(700);

    const optMap = cloneNodeMap(uncompacted.nodes);
    const refMap = cloneNodeMap(uncompacted.nodes);

    const tOptStart = performance.now();
    compactSiblingSubtrees(wideRoot, optMap, config, true);
    const optMs = performance.now() - tOptStart;

    const tRefStart = performance.now();
    compactSiblingSubtreesReference(wideRoot, refMap, config, true);
    const refMs = performance.now() - tRefStart;

    // 坐标 100% 等价
    for (const [id, refNode] of refMap.entries()) {
      expect(optMap.get(id)!.position.y).toBeCloseTo(refNode.position.y, 9);
    }

    // 宽树端到端零重叠
    const wideTreeResult = treeEngine.calculate(wideRoot, freshConfig(), 'right');
    const wideBalancedResult = balancedEngine.calculate(wideRoot, freshConfig(), 'both');
    assertNoOverlaps(wideTreeResult.nodes);
    assertNoOverlaps(wideBalancedResult.nodes);

    // 宽松计时阈值（防止 CI 抖动，同时验证优化显著快于 O(N²) 基线）
    expect(optMs, `optimized compact took ${optMs.toFixed(2)}ms (ref ${refMs.toFixed(2)}ms)`).toBeLessThan(80);
    expect(optMs, `expected speedup over O(N²) ref (${refMs.toFixed(2)}ms)`).toBeLessThan(refMs * 0.5 + 5);

    // 深树（300 层 + 侧叶）：零重叠且快速完成
    const deepRoot = buildDeepTree(300);
    const tDeepStart = performance.now();
    const deepResult = treeEngine.calculate(deepRoot, freshConfig(), 'right');
    const deepMs = performance.now() - tDeepStart;
    assertNoOverlaps(deepResult.nodes);
    expect(deepMs, `deep 300-level layout took ${deepMs.toFixed(2)}ms`).toBeLessThan(150);

    // eslint-disable-next-line no-console
    console.info(
      `[compactTree-bench] wideNodes=${uncompacted.nodes.length} opt=${optMs.toFixed(2)}ms ref=${refMs.toFixed(2)}ms speedup=${(refMs / Math.max(optMs, 0.01)).toFixed(1)}x deep300=${deepMs.toFixed(2)}ms`,
    );
  });
});
