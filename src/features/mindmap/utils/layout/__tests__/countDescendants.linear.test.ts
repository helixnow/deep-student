/**
 * 后代数缓存的工作量与精确性：布局对每个节点以 depth=0 调用一次，冷缓存也应是线性工作量；
 * 深度上限的截断语义与无缓存定义逐一相等。
 */
import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '../../../types';
import { countAllDescendants, MAX_TREE_DEPTH } from '../countDescendants';

const ID = 'RF-W09-mindmap-descendant-count-linear';

/** 无缓存的定义：深度超过上限的层不计。 */
function definition(node: MindMapNode, depth = 0): number {
  if (!node.children || depth > MAX_TREE_DEPTH) return 0;
  let sum = 0;
  for (const child of node.children) sum += 1 + definition(child, depth + 1);
  return sum;
}

function bushy(total: number, branching: number): MindMapNode[] {
  const nodes: MindMapNode[] = [{ id: 'n0', text: 'n0', children: [] }];
  for (let i = 1; i < total; i++) {
    const node: MindMapNode = { id: `n${i}`, text: `n${i}`, children: [] };
    nodes[Math.floor((i - 1) / branching)].children.push(node);
    nodes.push(node);
  }
  return nodes;
}

function chain(total: number): MindMapNode[] {
  const nodes: MindMapNode[] = [{ id: 'n0', text: 'n0', children: [] }];
  for (let i = 1; i < total; i++) {
    const node: MindMapNode = { id: `n${i}`, text: `n${i}`, children: [] };
    nodes[i - 1].children.push(node);
    nodes.push(node);
  }
  return nodes;
}

/** 把每个节点的 children 换成计数的 getter。 */
function countChildrenReads(nodes: MindMapNode[]): { reads: () => number } {
  let reads = 0;
  for (const node of nodes) {
    const children = node.children;
    Object.defineProperty(node, 'children', { get: () => { reads += 1; return children; }, configurable: true });
  }
  return { reads: () => reads };
}

describe(ID, () => {
  it(`${ID}: a layout pass over a bushy tree reads each node's children a bounded number of times`, () => {
    const nodes = bushy(3000, 5);
    const { reads } = countChildrenReads(nodes);
    for (const node of nodes) countAllDescendants(node);
    // 每个节点：入口判空一次、统计时展开一次、汇总子树一次。无缓存命中时是各子树大小之和（约 n × 平均深度）的两倍。
    expect(reads()).toBeLessThanOrEqual(3 * nodes.length);

    const before = reads();
    for (const node of nodes) countAllDescendants(node);
    expect(reads() - before).toBeLessThanOrEqual(nodes.length);
  });

  it(`${ID}: matches the depth-limited definition for every node and depth, on bushy trees and on chains deeper than the limit`, () => {
    const depths = [0, 1, 7, MAX_TREE_DEPTH - 2, MAX_TREE_DEPTH, MAX_TREE_DEPTH + 1];
    for (const nodes of [bushy(400, 3), chain(MAX_TREE_DEPTH + 40)]) {
      for (const depth of depths) {
        for (const node of nodes) {
          expect(countAllDescendants(node, depth), `${node.id} @ depth ${depth}`).toBe(definition(node, depth));
        }
      }
    }
  });

  it(`${ID}: a repeated pass over a chain deeper than the limit is answered from the cache`, () => {
    const nodes = chain(MAX_TREE_DEPTH * 2);
    for (const node of nodes) countAllDescendants(node);
    const { reads } = countChildrenReads(nodes);
    for (const node of nodes) countAllDescendants(node);
    expect(reads()).toBeLessThanOrEqual(nodes.length);
    expect(countAllDescendants(nodes[0])).toBe(MAX_TREE_DEPTH + 1);
  });

  it(`${ID}: a node reached twice (not a tree) is still counted by the definition`, () => {
    const shared: MindMapNode = { id: 's', text: 's', children: [{ id: 's1', text: 's1', children: [] }] };
    const root: MindMapNode = { id: 'r', text: 'r', children: [
      { id: 'a', text: 'a', children: [shared] },
      { id: 'b', text: 'b', children: [shared] },
    ] };
    expect(countAllDescendants(root)).toBe(definition(root));
    expect(countAllDescendants(root, MAX_TREE_DEPTH - 1)).toBe(definition(root, MAX_TREE_DEPTH - 1));
  });
});
