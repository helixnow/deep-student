/**
 * 局部图谱（Local Graph）纯逻辑：以当前笔记为中心的 1-2 度邻接图。
 *
 * 数据源复用后端持久链接图（notes_get_backlinks / notes_get_outgoing_links，
 * 见 backlinksBackend.ts）：每个待展开节点各取一次入链 + 出链，宽度受
 * 每节点邻居预算与全图节点上限约束，命中任一上限即标记 truncated。
 *
 * 布局为确定性同心圆：中心笔记在原点，1 度邻居均匀分布在内环，
 * 2 度邻居按其挂靠的 1 度父节点的扇区就近分布在外环 —— 无需力导迭代，
 * 渲染结果稳定可测。
 */

import type { NoteBacklinkDto, NoteOutgoingLinkDto } from '../backlinksBackend';

export interface LocalGraphNodeDatum {
  /** 笔记 ID；未解析目标为 `ghost:<标题小写>` */
  id: string;
  title: string;
  /** 距中心笔记的跳数（0 = 中心） */
  degree: 0 | 1 | 2;
  /** false = 未解析的 [[目标]]（尚无对应笔记，不可打开） */
  exists: boolean;
}

/**
 * 边的链接类型（对齐 RemNote 图谱分色心智的双类型子集）：
 * - wikilink：`[[目标]]` 双链
 * - noteref：`[标签](note://id)` 引用链接
 * - unknown：仅从入链行（NoteBacklinkDto 不携带 linkType）可见、
 *   且反向出链信息不可得时的兜底；渲染层按 wikilink 的中性样式处理
 */
export type LocalGraphEdgeKind = 'wikilink' | 'noteref' | 'unknown';

export interface LocalGraphEdgeDatum {
  id: string;
  source: string;
  target: string;
  kind: LocalGraphEdgeKind;
}

export interface LocalGraphData {
  nodes: LocalGraphNodeDatum[];
  edges: LocalGraphEdgeDatum[];
  /** 命中节点/邻居预算，图不完整 */
  truncated: boolean;
  /** 局部有向图中存在引用环路（至少包含 2 个节点的有向强连通分量） */
  hasCycle?: boolean;
  /** 参与引用环路的节点 ID 列表 */
  cycleNodeIds?: string[];
  /** 参与引用环路的有向边 ID 列表 */
  cycleEdgeIds?: string[];
}

export interface LocalGraphNeighborhood {
  backlinks: NoteBacklinkDto[];
  outgoing: NoteOutgoingLinkDto[];
}

export type LocalGraphFetcher = (noteId: string) => Promise<LocalGraphNeighborhood>;

/** 全图节点上限（含中心与幽灵节点） */
export const LOCAL_GRAPH_MAX_NODES = 80;
/** 中心笔记的邻居预算（入链 + 出链合计） */
export const LOCAL_GRAPH_CENTER_NEIGHBOR_LIMIT = 30;
/** 每个 1 度节点向外扩展时的邻居预算 */
export const LOCAL_GRAPH_EXPANSION_NEIGHBOR_LIMIT = 8;
/** 最多展开多少个 1 度节点（控制 2 度请求扇出） */
export const LOCAL_GRAPH_EXPANSION_NODE_LIMIT = 12;

export function ghostNodeId(title: string): string {
  return `ghost:${title.trim().toLocaleLowerCase()}`;
}

function directedEdgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

export interface DirectedCycleSummary {
  hasCycle: boolean;
  cycleNodeIds: string[];
  cycleEdgeIds: string[];
}

/**
 * 基于 Tarjan 有向强连通分量算法识别真实引用环路（忽略纯 DAG 合流，只标记闭环成员）。
 */
export function detectDirectedCycles(
  edges: readonly LocalGraphEdgeDatum[],
): DirectedCycleSummary {
  const adjacency = new Map<string, LocalGraphEdgeDatum[]>();
  const allNodes = new Set<string>();
  for (const edge of edges) {
    allNodes.add(edge.source);
    allNodes.add(edge.target);
    const list = adjacency.get(edge.source);
    if (list) list.push(edge);
    else adjacency.set(edge.source, [edge]);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccIdByNode = new Map<string, number>();
  const cycleSccs = new Set<number>();
  let nextSccId = 0;

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const edge of adjacency.get(v) ?? []) {
      const w = edge.target;
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const sccId = nextSccId++;
      const members: string[] = [];
      while (stack.length > 0) {
        const w = stack.pop()!;
        onStack.delete(w);
        sccIdByNode.set(w, sccId);
        members.push(w);
        if (w === v) break;
      }
      if (members.length >= 2) {
        cycleSccs.add(sccId);
      } else if (members.length === 1) {
        const selfId = members[0]!;
        if ((adjacency.get(selfId) ?? []).some((e) => e.target === selfId)) {
          cycleSccs.add(sccId);
        }
      }
    }
  };

  for (const nodeId of allNodes) {
    if (!indices.has(nodeId)) strongConnect(nodeId);
  }

  const cycleNodeIds = Array.from(allNodes).filter((id) => cycleSccs.has(sccIdByNode.get(id)!));
  const cycleEdgeIds = edges
    .filter((edge) => {
      const srcScc = sccIdByNode.get(edge.source);
      return srcScc !== undefined && srcScc === sccIdByNode.get(edge.target) && cycleSccs.has(srcScc);
    })
    .map((edge) => edge.id);

  return {
    hasCycle: cycleEdgeIds.length > 0,
    cycleNodeIds,
    cycleEdgeIds,
  };
}

interface NeighborRef {
  id: string;
  title: string;
  exists: boolean;
  /** 存在 incoming 入链（ref -> self） */
  hasInbound: boolean;
  inboundKind: LocalGraphEdgeKind;
  /** 存在 outgoing 出链（self -> ref） */
  hasOutbound: boolean;
  outboundKind: LocalGraphEdgeKind;
}

function edgeKindFromLinkType(linkType: string): LocalGraphEdgeKind {
  if (linkType === 'noteref') return 'noteref';
  if (linkType === 'wikilink') return 'wikilink';
  return 'unknown';
}

function mergeEdgeKind(prev: LocalGraphEdgeKind, next: LocalGraphEdgeKind): LocalGraphEdgeKind {
  return prev === 'unknown' && next !== 'unknown' ? next : prev;
}

/** 单个节点的邻居列表（保留真实入链/出链方向；入链优先、出链其后、幽灵最后），按预算截断。 */
function collectNeighbors(
  neighborhood: LocalGraphNeighborhood,
  selfId: string,
  limit: number,
  includeGhosts: boolean,
): { refs: NeighborRef[]; truncated: boolean } {
  const byId = new Map<string, NeighborRef>();
  const refs: NeighborRef[] = [];
  let truncated = false;

  const upsertNeighbor = (
    id: string,
    title: string,
    exists: boolean,
    direction: 'inbound' | 'outbound',
    kind: LocalGraphEdgeKind,
  ) => {
    if (id === selfId) return;
    const existing = byId.get(id);
    if (existing) {
      if (direction === 'inbound') {
        existing.hasInbound = true;
        existing.inboundKind = mergeEdgeKind(existing.inboundKind, kind);
      } else {
        existing.hasOutbound = true;
        existing.outboundKind = mergeEdgeKind(existing.outboundKind, kind);
      }
      return;
    }
    if (refs.length >= limit) {
      truncated = true;
      return;
    }
    const ref: NeighborRef = {
      id,
      title,
      exists,
      hasInbound: direction === 'inbound',
      inboundKind: direction === 'inbound' ? kind : 'unknown',
      hasOutbound: direction === 'outbound',
      outboundKind: direction === 'outbound' ? kind : 'unknown',
    };
    byId.set(id, ref);
    refs.push(ref);
  };

  for (const row of neighborhood.backlinks) {
    upsertNeighbor(row.sourceId, row.sourceTitle, true, 'inbound', 'unknown');
  }
  for (const row of neighborhood.outgoing) {
    const kind = edgeKindFromLinkType(row.linkType);
    if (row.targetId) {
      upsertNeighbor(row.targetId, row.targetTitle, true, 'outbound', kind);
    } else if (includeGhosts && row.targetTitle.trim()) {
      upsertNeighbor(
        ghostNodeId(row.targetTitle),
        row.targetTitle.trim(),
        false,
        'outbound',
        kind,
      );
    }
  }
  return { refs, truncated };
}

/**
 * 从中心笔记出发做宽度受限 BFS，产出 1-2 度邻接图。
 * 幽灵节点只从中心笔记引入（外环未解析目标会让图充满噪声），且不再展开。
 */
export async function buildLocalGraph(
  center: { id: string; title: string },
  depth: 1 | 2,
  fetchNeighborhood: LocalGraphFetcher,
): Promise<LocalGraphData> {
  const nodesById = new Map<string, LocalGraphNodeDatum>();
  const edgesByKey = new Map<string, LocalGraphEdgeDatum>();
  let truncated = false;

  nodesById.set(center.id, { id: center.id, title: center.title, degree: 0, exists: true });

  const addEdge = (source: string, target: string, kind: LocalGraphEdgeKind) => {
    if (source === target) return;
    const key = directedEdgeKey(source, target);
    const existing = edgesByKey.get(key);
    if (existing) {
      // 同一条有向边先由入链行（类型未知）引入、后被源节点出链行看到时补全类型
      if (existing.kind === 'unknown' && kind !== 'unknown') existing.kind = kind;
      return;
    }
    edgesByKey.set(key, { id: `e-${edgesByKey.size}`, source, target, kind });
  };

  const addNode = (ref: NeighborRef, degree: 1 | 2): boolean => {
    const existing = nodesById.get(ref.id);
    if (existing) return true;
    if (nodesById.size >= LOCAL_GRAPH_MAX_NODES) {
      truncated = true;
      return false;
    }
    nodesById.set(ref.id, { id: ref.id, title: ref.title, degree, exists: ref.exists });
    return true;
  };

  // ── 第 1 度：中心笔记的入链 + 出链（含幽灵目标） ──────────────────
  const centerNeighborhood = await fetchNeighborhood(center.id);
  const centerNeighbors = collectNeighbors(
    centerNeighborhood,
    center.id,
    LOCAL_GRAPH_CENTER_NEIGHBOR_LIMIT,
    true,
  );
  truncated = truncated || centerNeighbors.truncated;
  for (const ref of centerNeighbors.refs) {
    if (addNode(ref, 1)) {
      if (ref.hasInbound) addEdge(ref.id, center.id, ref.inboundKind);
      if (ref.hasOutbound) addEdge(center.id, ref.id, ref.outboundKind);
    }
  }

  // ── 第 2 度：展开部分 1 度真实笔记 ────────────────────────────────
  if (depth >= 2) {
    const expandable = centerNeighbors.refs
      .filter((ref) => ref.exists && nodesById.has(ref.id))
      .slice(0, LOCAL_GRAPH_EXPANSION_NODE_LIMIT);
    if (centerNeighbors.refs.filter((ref) => ref.exists).length > expandable.length) {
      truncated = true;
    }

    const neighborhoods = await Promise.all(expandable.map(async (ref) => {
      try {
        return { ref, neighborhood: await fetchNeighborhood(ref.id) };
      } catch {
        // 单个节点扩展失败不阻断整图（如并发中笔记被删除）
        return { ref, neighborhood: null };
      }
    }));

    for (const { ref, neighborhood } of neighborhoods) {
      if (!neighborhood) continue;
      const expansion = collectNeighbors(
        neighborhood,
        ref.id,
        LOCAL_GRAPH_EXPANSION_NEIGHBOR_LIMIT,
        false,
      );
      truncated = truncated || expansion.truncated;
      for (const neighbor of expansion.refs) {
        // 已在图中的节点只补边；新节点计为 2 度
        if (nodesById.has(neighbor.id) || addNode(neighbor, 2)) {
          if (neighbor.hasInbound) addEdge(neighbor.id, ref.id, neighbor.inboundKind);
          if (neighbor.hasOutbound) addEdge(ref.id, neighbor.id, neighbor.outboundKind);
        }
      }
    }
  }

  const nodes = Array.from(nodesById.values());
  const edges = Array.from(edgesByKey.values());
  const cycles = detectDirectedCycles(edges);

  return {
    nodes,
    edges,
    truncated,
    ...cycles,
  };
}

export interface PositionedGraphNode extends LocalGraphNodeDatum {
  x: number;
  y: number;
}

export const LOCAL_GRAPH_RING_1_RADIUS = 170;
export const LOCAL_GRAPH_RING_2_RADIUS = 330;

/**
 * 确定性同心圆布局。2 度节点按其相邻 1 度父节点的角度就近分布，
 * 让边尽量短、扇区内不交叉；无父可寻（数据异常）时退化为外环均匀分布。
 */
export function layoutLocalGraph(data: LocalGraphData): PositionedGraphNode[] {
  const ring1 = data.nodes.filter((node) => node.degree === 1);
  const ring2 = data.nodes.filter((node) => node.degree === 2);

  const angleByNodeId = new Map<string, number>();
  const positioned: PositionedGraphNode[] = [];

  for (const node of data.nodes) {
    if (node.degree === 0) positioned.push({ ...node, x: 0, y: 0 });
  }

  ring1.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, ring1.length) - Math.PI / 2;
    angleByNodeId.set(node.id, angle);
    positioned.push({
      ...node,
      x: Math.cos(angle) * LOCAL_GRAPH_RING_1_RADIUS,
      y: Math.sin(angle) * LOCAL_GRAPH_RING_1_RADIUS,
    });
  });

  // 2 度节点先按父节点分组（父 = 边上相邻的 1 度节点，取边表首个命中）
  const parentByChildId = new Map<string, string>();
  for (const edge of data.edges) {
    const candidates: Array<[string, string]> = [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ];
    for (const [a, b] of candidates) {
      if (
        angleByNodeId.has(a)
        && ring2.some((node) => node.id === b)
        && !parentByChildId.has(b)
      ) {
        parentByChildId.set(b, a);
      }
    }
  }

  const childrenByParentId = new Map<string, LocalGraphNodeDatum[]>();
  const orphans: LocalGraphNodeDatum[] = [];
  for (const node of ring2) {
    const parent = parentByChildId.get(node.id);
    if (parent === undefined) {
      orphans.push(node);
      continue;
    }
    const list = childrenByParentId.get(parent) ?? [];
    list.push(node);
    childrenByParentId.set(parent, list);
  }

  const parentSector = (2 * Math.PI) / Math.max(1, ring1.length);
  for (const [parentId, children] of childrenByParentId) {
    const baseAngle = angleByNodeId.get(parentId) ?? -Math.PI / 2;
    const spread = parentSector * 0.8;
    children.forEach((node, index) => {
      const offset = children.length === 1
        ? 0
        : (index / (children.length - 1) - 0.5) * spread;
      const angle = baseAngle + offset;
      positioned.push({
        ...node,
        x: Math.cos(angle) * LOCAL_GRAPH_RING_2_RADIUS,
        y: Math.sin(angle) * LOCAL_GRAPH_RING_2_RADIUS,
      });
    });
  }

  orphans.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, orphans.length) + Math.PI / 4;
    positioned.push({
      ...node,
      x: Math.cos(angle) * LOCAL_GRAPH_RING_2_RADIUS,
      y: Math.sin(angle) * LOCAL_GRAPH_RING_2_RADIUS,
    });
  });

  return positioned;
}
