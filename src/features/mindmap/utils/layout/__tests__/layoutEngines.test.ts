/**
 * 布局引擎行为回归测试
 *
 * 覆盖：LogicBalanced 左侧右缘锚点对齐、超长文本换行高度估算、
 * 重叠消除、空树/children 缺失防御、OrgChart 语义化间距、
 * 兄弟轮廓紧凑、深度超限 truncated 信号、间距档位解析。
 *
 * 注意：本套测试只依赖估算尺寸（不注入 measuredNodeHeights），
 * 断言使用相对关系而非绝对坐标，容忍估算参数微调。
 */

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { MindMapNode, LayoutConfig } from '../../../types';
import type { LayoutBoundsWithMeta } from '../../../registry/types';
import { DEFAULT_LAYOUT_CONFIG } from '../../../constants';
import { BalancedLayoutEngine } from '../../../layouts/mindmap/BalancedLayoutEngine';
import { TreeLayoutEngine } from '../../../layouts/mindmap/TreeLayoutEngine';
import { LogicBalancedLayoutEngine } from '../../../layouts/logic/LogicBalancedLayoutEngine';
import { LogicTreeLayoutEngine } from '../../../layouts/logic/LogicTreeLayoutEngine';
import { VerticalOrgChartEngine } from '../../../layouts/orgchart/VerticalOrgChartEngine';
import { HorizontalOrgChartEngine } from '../../../layouts/orgchart/HorizontalOrgChartEngine';
import { TimelineLayoutEngine } from '../../../layouts/timeline/TimelineLayoutEngine';
import {
  calculateNodeHeight,
  calculateSubtreeSize,
  normalizeLayoutRoot,
} from '../helpers';
import { resolveSpacingConfig, normalizeSpacingTier } from '../spacingPresets';

const balanced = new BalancedLayoutEngine();
const tree = new TreeLayoutEngine();
const logicBalanced = new LogicBalancedLayoutEngine();
const logicTree = new LogicTreeLayoutEngine();
const verticalOrg = new VerticalOrgChartEngine();
const horizontalOrg = new HorizontalOrgChartEngine();
const timeline = new TimelineLayoutEngine();

const allEngines = [
  balanced,
  tree,
  logicBalanced,
  logicTree,
  verticalOrg,
  horizontalOrg,
  timeline,
] as const;

let seq = 0;
function n(text: string, children: MindMapNode[] = [], extra: Partial<MindMapNode> = {}): MindMapNode {
  return { id: `t${seq++}`, text, children, ...extra };
}

/** 每次调用返回新 config 引用（helpers 缓存按 config 身份失效） */
function freshConfig(overrides: Record<string, unknown> = {}): LayoutConfig {
  return { ...DEFAULT_LAYOUT_CONFIG, ...overrides } as LayoutConfig;
}

function chain(depth: number): MindMapNode {
  const root = n('chain-root');
  let cursor = root;
  for (let i = 0; i < depth; i++) {
    const child = n(`c${i}`);
    cursor.children.push(child);
    cursor = child;
  }
  return root;
}

function byId(nodes: Node[], id: string): Node {
  const found = nodes.find(node => node.id === id);
  expect(found, `node ${id} missing from layout`).toBeDefined();
  return found!;
}

function box(node: Node) {
  return {
    minX: node.position.x,
    maxX: node.position.x + (node.width ?? 0),
    minY: node.position.y,
    maxY: node.position.y + (node.height ?? 0),
  };
}

/** 全对节点盒无重叠断言（X 相交则 Y 必须分离，允许 0.5px 浮点容差） */
function assertNoOverlaps(nodes: Node[]) {
  const eps = 0.5;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = box(nodes[i]);
      const b = box(nodes[j]);
      const xOverlap = a.minX < b.maxX - eps && b.minX < a.maxX - eps;
      const yOverlap = a.minY < b.maxY - eps && b.minY < a.maxY - eps;
      expect(
        xOverlap && yOverlap,
        `nodes ${nodes[i].id} and ${nodes[j].id} overlap`
      ).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// LogicBalanced 左侧右缘锚点（B1 / P0-1）
// ---------------------------------------------------------------------------

describe('LogicBalancedLayoutEngine left anchor', () => {
  it('right-edge-aligns left-side root children of different widths', () => {
    // 6 个等高但宽度差异极大的子节点，保证左右两侧都有分布
    const root = n('root', [
      n('短'),
      n('一个非常非常非常长的中文标题节点'),
      n('mid length'),
      n('x'),
      n('another fairly long english title'),
      n('中'),
    ]);
    const config = freshConfig();
    const result = logicBalanced.calculate(root, config, 'both');

    const leftLevel1 = result.nodes.filter(
      node => (node.data as { side?: string }).side === 'left' &&
        (node.data as { level?: number }).level === 1
    );
    expect(leftLevel1.length).toBeGreaterThan(0);
    for (const node of leftLevel1) {
      // 右边缘统一锚在根左边缘 - horizontalGap
      expect(node.position.x + (node.width ?? 0)).toBeCloseTo(-config.horizontalGap, 3);
    }
  });

  it('matches BalancedLayoutEngine positions on a flat tree', () => {
    // 扁平树（无孙子）下紧凑后处理无效果，两引擎坐标应完全一致
    const root = n('root', [n('短'), n('一个很长很长很长的标题'), n('mid'), n('leaf-4')]);
    const config = freshConfig();

    const a = balanced.calculate(root, config, 'both');
    const b = logicBalanced.calculate(root, config, 'both');

    const posOf = (r: { nodes: Node[] }) =>
      Object.fromEntries(r.nodes.map(node => [node.id, node.position]));
    expect(posOf(b)).toEqual(posOf(a));
  });

  it('anchors grandchildren of a left branch to parent left edge minus gap', () => {
    // 用大子树强制其中一支在左侧
    const heavy = n('heavy', [n('h1'), n('h2'), n('h3'), n('h4')]);
    const light = n('light-parent', [n('短孙'), n('很长很长的孙节点标题')]);
    const root = n('root', [heavy, light]);
    const config = freshConfig();
    const result = logicBalanced.calculate(root, config, 'both');

    const leftParents = result.nodes.filter(
      node => (node.data as { side?: string }).side === 'left' &&
        (node.data as { level?: number }).level === 1 &&
        (node.data as { hasChildren?: boolean }).hasChildren
    );
    for (const parent of leftParents) {
      const childEdges = result.edges.filter(e => e.source === parent.id);
      for (const edge of childEdges) {
        const child = byId(result.nodes, edge.target);
        // 左侧子节点右缘 = 父节点左缘 - horizontalGap
        expect(child.position.x + (child.width ?? 0)).toBeCloseTo(
          parent.position.x - config.horizontalGap,
          3
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 超长文本换行高度（P0-2）与重叠消除
// ---------------------------------------------------------------------------

describe('long text height estimation and overlap resolution', () => {
  const LONG_TEXT =
    '这是一个非常长的没有手动换行符的标题文本它应该在到达节点最大宽度后自动折行从而需要更高的节点高度来容纳多行内容';

  it('estimates wrapped title height above single-line base height', () => {
    const config = freshConfig();
    const short = calculateNodeHeight(n('短标题'), false, config);
    const long = calculateNodeHeight(n(LONG_TEXT), false, config);
    expect(short).toBe(config.nodeHeight);
    expect(long).toBeGreaterThan(config.nodeHeight);
  });

  it('keeps long-text siblings from overlapping in tree and balanced layouts', () => {
    const root = n('root', [
      n(LONG_TEXT, [n(LONG_TEXT), n('leaf-a')]),
      n(LONG_TEXT),
      n('short', [n(LONG_TEXT)]),
      n(LONG_TEXT),
    ]);

    assertNoOverlaps(tree.calculate(root, freshConfig(), 'right').nodes);
    assertNoOverlaps(balanced.calculate(root, freshConfig(), 'both').nodes);
    assertNoOverlaps(logicTree.calculate(root, freshConfig(), 'right').nodes);
    assertNoOverlaps(logicBalanced.calculate(root, freshConfig(), 'both').nodes);
  });

  it('keeps orgchart layouts free of overlaps with long text', () => {
    const root = n('root', [
      n(LONG_TEXT, [n('a'), n(LONG_TEXT)]),
      n('b'),
      n(LONG_TEXT),
    ]);
    assertNoOverlaps(verticalOrg.calculate(root, freshConfig(), 'down').nodes);
    assertNoOverlaps(horizontalOrg.calculate(root, freshConfig(), 'right').nodes);
  });
});

// ---------------------------------------------------------------------------
// 空树 / children 缺失防御
// ---------------------------------------------------------------------------

describe('empty tree and missing children defense', () => {
  it('normalizeLayoutRoot backfills missing children array', () => {
    const broken = { id: 'x', text: 'broken' } as unknown as MindMapNode;
    const normalized = normalizeLayoutRoot(broken);
    expect(Array.isArray(normalized.children)).toBe(true);
    expect(normalized.children).toHaveLength(0);
    // 已有 children 时保持对象身份（不破坏 WeakMap 缓存）
    const ok = n('ok');
    expect(normalizeLayoutRoot(ok)).toBe(ok);
  });

  it('all engines survive a root without children field', () => {
    for (const engine of allEngines) {
      const broken = { id: `broken-${engine.id}`, text: 'broken' } as unknown as MindMapNode;
      const result = engine.calculate(broken, freshConfig(), engine.defaultDirection);
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
      expect(result.bounds.width).toBeGreaterThan(0);
    }
  });

  it('all engines handle an empty-children root', () => {
    for (const engine of allEngines) {
      const result = engine.calculate(n('empty'), freshConfig(), engine.defaultDirection);
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// OrgChart 语义化间距（siblingGap / levelGap）
// ---------------------------------------------------------------------------

describe('orgchart semantic gaps', () => {
  it('vertical orgchart uses siblingGap along X and levelGap along Y', () => {
    const root = n('r', [n('c1'), n('c2')]);
    const config = freshConfig({ siblingGap: 40, levelGap: 100 });
    const result = verticalOrg.calculate(root, config, 'down');

    const rootNode = byId(result.nodes, root.id);
    const c1 = byId(result.nodes, root.children[0].id);
    const c2 = byId(result.nodes, root.children[1].id);

    // 层距：子节点顶边 = 根底边 + levelGap
    expect(c1.position.y).toBeCloseTo(
      rootNode.position.y + (rootNode.height ?? 0) + 100,
      3
    );
    // 兄弟距：叶子子树宽 = 节点宽，水平净距 = siblingGap
    expect(c2.position.x - (c1.position.x + (c1.width ?? 0))).toBeCloseTo(40, 3);
  });

  it('falls back to legacy verticalGap/horizontalGap when semantic fields absent', () => {
    const root = n('r', [n('c1'), n('c2')]);
    const config = freshConfig();
    const result = verticalOrg.calculate(root, config, 'down');

    const rootNode = byId(result.nodes, root.id);
    const c1 = byId(result.nodes, root.children[0].id);
    const c2 = byId(result.nodes, root.children[1].id);

    // 旧行为兼容：层距回退 horizontalGap，兄弟距回退 verticalGap
    expect(c1.position.y).toBeCloseTo(
      rootNode.position.y + (rootNode.height ?? 0) + config.horizontalGap,
      3
    );
    expect(c2.position.x - (c1.position.x + (c1.width ?? 0))).toBeCloseTo(
      config.verticalGap,
      3
    );
  });

  it('horizontal orgchart keeps a tall root centered on its children', () => {
    // 根节点带手动多行文本 → 根高度显著大于分支基准高度；
    // 子树高预计算若低估根高度会导致初排/居中错位
    const root = n('第一行\n第二行\n第三行\n第四行', [n('child-1'), n('child-2')]);
    const config = freshConfig();
    const result = horizontalOrg.calculate(root, config, 'right');

    const rootNode = byId(result.nodes, root.id);
    const c1 = byId(result.nodes, root.children[0].id);
    const c2 = byId(result.nodes, root.children[1].id);
    const rootCenter = rootNode.position.y + (rootNode.height ?? 0) / 2;
    const childrenCenter =
      (c1.position.y + (c2.position.y + (c2.height ?? 0))) / 2;
    expect(rootCenter).toBeCloseTo(childrenCenter, 1);
    assertNoOverlaps(result.nodes);
  });
});

// ---------------------------------------------------------------------------
// 兄弟轮廓紧凑（compactSiblings）
// ---------------------------------------------------------------------------

describe('sibling contour compaction', () => {
  const TALL = '很长很长很长很长很长很长很长很长很长很长很长很长很长很长的多行文本节点标题';

  /**
   * 构造「深窄」形态：child A 自身矮，但其孙代（更远 X 带）很高；
   * child B 是叶子。包围盒分离会把 B 推到 A 整个子树下方，
   * 轮廓紧凑应允许 B 贴到 A 节点自身下方。
   */
  function deepNarrowTree(): MindMapNode {
    return n('root', [
      n('A', [n('A1', [n(TALL), n(TALL), n(TALL)])]),
      n('B'),
    ]);
  }

  it('pulls a leaf sibling closer than envelope stacking in tree layout', () => {
    const rootCompact = deepNarrowTree();
    const compactResult = tree.calculate(rootCompact, freshConfig(), 'right');

    const rootLoose = deepNarrowTree();
    const looseResult = tree.calculate(rootLoose, freshConfig({ compactSiblings: false }), 'right');

    const bCompact = byId(compactResult.nodes, rootCompact.children[1].id);
    const bLoose = byId(looseResult.nodes, rootLoose.children[1].id);

    // 紧凑后 B 相对其兄弟 A 的距离应严格小于关闭紧凑时
    const aCompact = byId(compactResult.nodes, rootCompact.children[0].id);
    const aLoose = byId(looseResult.nodes, rootLoose.children[0].id);
    const gapCompact = bCompact.position.y - (aCompact.position.y + (aCompact.height ?? 0));
    const gapLoose = bLoose.position.y - (aLoose.position.y + (aLoose.height ?? 0));
    expect(gapCompact).toBeLessThan(gapLoose);

    // 紧凑后仍不得产生重叠
    assertNoOverlaps(compactResult.nodes);
    assertNoOverlaps(looseResult.nodes);
  });

  it('keeps balanced layout overlap-free with compaction enabled (default)', () => {
    const root = n('root', [
      n('A', [n('A1', [n(TALL), n(TALL)])]),
      n('B'),
      n('C', [n('C1', [n(TALL), n(TALL)])]),
      n('D'),
    ]);
    const result = balanced.calculate(root, freshConfig(), 'both');
    assertNoOverlaps(result.nodes);
  });

  it('respects the compactSiblings: false escape hatch', () => {
    const root = deepNarrowTree();
    const result = tree.calculate(root, freshConfig({ compactSiblings: false }), 'right');
    // 关闭紧凑 = 纯包围盒分离：B 顶边不高于 A 子树包围盒底边 - gap 之上
    // （用「所有 A 子树节点的最大底边」近似包围盒底边）
    const aSubtreeIds = new Set<string>();
    const collect = (node: MindMapNode) => {
      aSubtreeIds.add(node.id);
      node.children.forEach(collect);
    };
    collect(root.children[0]);
    const aBottom = Math.max(
      ...result.nodes
        .filter(node => aSubtreeIds.has(node.id))
        .map(node => node.position.y + (node.height ?? 0))
    );
    const b = byId(result.nodes, root.children[1].id);
    expect(b.position.y).toBeGreaterThanOrEqual(aBottom);
  });
});

// ---------------------------------------------------------------------------
// 深度超限 truncated 信号
// ---------------------------------------------------------------------------

describe('depth truncation signal', () => {
  it('marks bounds.truncated when tree exceeds MAX_TREE_DEPTH', () => {
    const deep = chain(520);
    for (const engine of [tree, balanced, logicTree, logicBalanced, verticalOrg, horizontalOrg, timeline]) {
      const result = engine.calculate(deep, freshConfig(), engine.defaultDirection);
      expect(
        (result.bounds as LayoutBoundsWithMeta).truncated,
        `${engine.id} should flag truncation`
      ).toBe(true);
    }
  });

  it('leaves truncated unset for shallow trees', () => {
    const shallow = n('root', [n('a', [n('b')]), n('c')]);
    for (const engine of allEngines) {
      const result = engine.calculate(shallow, freshConfig(), engine.defaultDirection);
      expect((result.bounds as LayoutBoundsWithMeta).truncated).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 间距档位与子树尺寸缓存
// ---------------------------------------------------------------------------

describe('spacing tiers', () => {
  it('normalizes unknown tiers to default', () => {
    expect(normalizeSpacingTier('compact')).toBe('compact');
    expect(normalizeSpacingTier('spacious')).toBe('spacious');
    expect(normalizeSpacingTier('nope')).toBe('default');
    expect(normalizeSpacingTier(undefined)).toBe('default');
  });

  it('returns a fresh config object per call (cache invalidation contract)', () => {
    expect(resolveSpacingConfig('compact')).not.toBe(resolveSpacingConfig('compact'));
  });

  it('tier gaps flow into engine coordinates', () => {
    const build = () => n('root', [n('only')]);
    const compactCfg = resolveSpacingConfig('compact');
    const spaciousCfg = resolveSpacingConfig('spacious');

    // 直接比较层距：child.x - root 右边缘 = horizontalGap
    const compactResult = tree.calculate(build(), compactCfg, 'right');
    const spaciousResult = tree.calculate(build(), spaciousCfg, 'right');
    const gapOf = (result: { nodes: Node[] }) => {
      const [rootNode, child] = [result.nodes[0], result.nodes[1]];
      return child.position.x - (rootNode.position.x + (rootNode.width ?? 0));
    };
    expect(gapOf(compactResult)).toBeCloseTo(compactCfg.horizontalGap, 3);
    expect(gapOf(spaciousResult)).toBeCloseTo(spaciousCfg.horizontalGap, 3);
  });
});

describe('subtree size cache', () => {
  it('returns the cached object for repeated non-root queries with same config', () => {
    const child = n('child', [n('g1'), n('g2')]);
    const config = freshConfig();
    const first = calculateSubtreeSize(child, config);
    const second = calculateSubtreeSize(child, config);
    expect(second).toBe(first);

    // 换 config 引用后缓存失效（值相等但对象不同）
    const third = calculateSubtreeSize(child, freshConfig());
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});
