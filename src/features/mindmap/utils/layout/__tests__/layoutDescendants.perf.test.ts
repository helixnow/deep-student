/**
 * 布局后代数缓存：坐标稳定性回归 + 千级节点计时断言
 */

import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '../../../types';
import { BalancedLayoutEngine } from '../../../layouts/mindmap/BalancedLayoutEngine';
import { TreeLayoutEngine } from '../../../layouts/mindmap/TreeLayoutEngine';
import { countAllDescendants, MAX_TREE_DEPTH } from '../countDescendants';

// 旧的 calculateBalancedLayout/calculateTreeLayout 函数式实现已删除，
// 计时与坐标稳定性回归改为直接压生产引擎类
const balancedEngine = new BalancedLayoutEngine();
const treeEngine = new TreeLayoutEngine();
const calculateBalancedLayout = (root: MindMapNode) => balancedEngine.calculate(root);
const calculateTreeLayout = (root: MindMapNode) => treeEngine.calculate(root);

/** 生成扇出树：root → branching^depth 量级节点 */
function buildTree(totalNodes: number, branching = 4): MindMapNode {
  let nextId = 0;
  const makeNode = (): MindMapNode => ({
    id: `n${nextId++}`,
    text: `Node ${nextId}`,
    children: [],
  });

  const root = makeNode();
  const queue: MindMapNode[] = [root];

  while (nextId < totalNodes && queue.length > 0) {
    const parent = queue.shift()!;
    const slots = Math.min(branching, totalNodes - nextId);
    for (let i = 0; i < slots; i++) {
      const child = makeNode();
      parent.children.push(child);
      queue.push(child);
    }
  }

  return root;
}

/** 链式深树：放大无缓存 O(n²) 路径，便于计时对比 */
function buildChain(totalNodes: number): MindMapNode {
  const root: MindMapNode = { id: 'n0', text: 'Node 0', children: [] };
  let cursor = root;
  for (let i = 1; i < totalNodes; i++) {
    const child: MindMapNode = { id: `n${i}`, text: `Node ${i}`, children: [] };
    cursor.children.push(child);
    cursor = child;
  }
  return root;
}

function positionMap(result: { nodes: Array<{ id: string; position: { x: number; y: number } }> }) {
  return Object.fromEntries(
    result.nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }])
  );
}

/** 无缓存 O(n²) 基线，仅用于 bench 对比（不污染生产路径） */
function countAllDescendantsUncached(node: MindMapNode): number {
  if (!node.children) return 0;
  return node.children.reduce(
    (sum, child) => sum + 1 + countAllDescendantsUncached(child),
    0
  );
}

/** 模拟布局：对每个节点调用一次 count（无缓存时合计 O(n²)） */
function walkAndCount(
  root: MindMapNode,
  countFn: (n: MindMapNode) => number
): void {
  const walk = (node: MindMapNode) => {
    countFn(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
}

describe('layout countAllDescendants cache', () => {
  it('keeps balanced + tree layout positions stable across runs', () => {
    const root = buildTree(64, 3);

    const balancedA = calculateBalancedLayout(root);
    const balancedB = calculateBalancedLayout(root);
    expect(positionMap(balancedB)).toEqual(positionMap(balancedA));

    const treeA = calculateTreeLayout(root);
    const treeB = calculateTreeLayout(root);
    expect(positionMap(treeB)).toEqual(positionMap(treeA));

    // childCount 与坐标一并稳定
    const countsA = Object.fromEntries(
      balancedA.nodes.map((n) => [n.id, (n.data as { childCount: number }).childCount])
    );
    const countsB = Object.fromEntries(
      balancedB.nodes.map((n) => [n.id, (n.data as { childCount: number }).childCount])
    );
    expect(countsB).toEqual(countsA);
  });

  it('cached count matches uncached values on the same tree', () => {
    const root = buildTree(120, 3);
    const walk = (node: MindMapNode) => {
      expect(countAllDescendants(node)).toBe(countAllDescendantsUncached(node));
      for (const child of node.children) walk(child);
    };
    walk(root);
  });

  it('does not reuse a depth-truncated value for a shallower count', () => {
    const root = buildChain(8);

    expect(countAllDescendants(root, MAX_TREE_DEPTH)).toBe(1);
    expect(countAllDescendants(root, 0)).toBe(7);
  });

  it('1000 / 3000 node descendant counting stays under loose thresholds', () => {
    // 用链式树放大 O(n²)：布局对每个节点 count 一次时无缓存访问量 ≈ n(n+1)/2
    for (const size of [1000, 3000] as const) {
      const root = buildChain(size);

      const tUncached = performance.now();
      walkAndCount(root, countAllDescendantsUncached);
      const uncachedMs = performance.now() - tUncached;

      // 冷缓存：首次填满 WeakMap，仍为 O(n) 节点写入
      const tCold = performance.now();
      walkAndCount(root, countAllDescendants);
      const cachedColdMs = performance.now() - tCold;

      // 热缓存：纯 WeakMap 命中
      const tWarm = performance.now();
      walkAndCount(root, countAllDescendants);
      const cachedWarmMs = performance.now() - tWarm;

      // 宽松阈值防 flaky（CI 机器差异大）
      const coldMaxMs = size === 1000 ? 80 : 400;
      const warmMaxMs = size === 1000 ? 40 : 120;
      expect(
        cachedColdMs,
        `cached-cold ${size} took ${cachedColdMs.toFixed(2)}ms (uncached ${uncachedMs.toFixed(2)}ms)`
      ).toBeLessThan(coldMaxMs);
      expect(
        cachedWarmMs,
        `cached-warm ${size} took ${cachedWarmMs.toFixed(2)}ms`
      ).toBeLessThan(warmMaxMs);
      // 热缓存应明显快于无缓存（允许极端机器抖动）
      expect(cachedWarmMs).toBeLessThan(uncachedMs * 0.5 + 10);

      // 扇出树全量布局计时（真实导图形态）
      const bushy = buildTree(size, 5);
      const layoutStart = performance.now();
      const layout = calculateBalancedLayout(bushy);
      const layoutMs = performance.now() - layoutStart;
      expect(layout.nodes.length).toBe(size);
      const layoutMaxMs = size === 1000 ? 500 : 2000;
      expect(
        layoutMs,
        `balanced layout ${size} nodes took ${layoutMs.toFixed(2)}ms`
      ).toBeLessThan(layoutMaxMs);

      // 供报告读取（不作为断言）
      // eslint-disable-next-line no-console
      console.info(
        `[layout-bench] n=${size} uncached=${uncachedMs.toFixed(2)}ms cold=${cachedColdMs.toFixed(2)}ms warm=${cachedWarmMs.toFixed(2)}ms layout=${layoutMs.toFixed(2)}ms`
      );
    }
  });
});
