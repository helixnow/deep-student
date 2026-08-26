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

function undirectedEdgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

interface NeighborRef {
  id: string;
  title: string;
  exists: boolean;
  /** 与展开源之间那条边的链接类型 */
  kind: LocalGraphEdgeKind;
}

function edgeKindFromLinkType(linkType: string): LocalGraphEdgeKind {
  if (linkType === 'noteref') return 'noteref';
  if (linkType === 'wikilink') return 'wikilink';
  return 'unknown';
}

/** 单个节点的邻居列表（入链优先、出链其后、幽灵最后），按预算截断。 */
function collectNeighbors(
  neighborhood: LocalGraphNeighborhood,
  selfId: string,
  limit: number,
  includeGhosts: boolean,
): { refs: NeighborRef[]; truncated: boolean } {
  const seen = new Set<string>([selfId]);
  const refs: NeighborRef[] = [];
  let truncated = false;
  const push = (ref: NeighborRef) => {
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    if (refs.length >= limit) {
      truncated = true;
      return;
    }
    refs.push(ref);
  };

  // 入链行不带 linkType；双向链接时借用反向出链行的类型标注这条无向边
  const outgoingKindById = new Map<string, LocalGraphEdgeKind>();
  for (const row of neighborhood.outgoing) {
    const id = row.targetId
      ?? (row.targetTitle.trim() ? ghostNodeId(row.targetTitle) : null);
    if (!id) continue;
    const kind = edgeKindFromLinkType(row.linkType);
    const previous = outgoingKindById.get(id);
    if (!previous || (previous === 'unknown' && kind !== 'unknown')) {
      outgoingKindById.set(id, kind);
    }
  }

  for (const row of neighborhood.backlinks) {
    push({
      id: row.sourceId,
      title: row.sourceTitle,
      exists: true,
      kind: outgoingKindById.get(row.sourceId) ?? 'unknown',
    });
  }
  for (const row of neighborhood.outgoing) {
    if (row.targetId) {
      push({
        id: row.targetId,
        title: row.targetTitle,
        exists: true,
        kind: outgoingKindById.get(row.targetId) ?? edgeKindFromLinkType(row.linkType),
      });
    } else if (includeGhosts && row.targetTitle.trim()) {
      push({
        id: ghostNodeId(row.targetTitle),
        title: row.targetTitle.trim(),
        exists: false,
        kind: edgeKindFromLinkType(row.linkType),
      });
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
    const key = undirectedEdgeKey(source, target);
    const existing = edgesByKey.get(key);
    if (existing) {
      // 同一条无向边先由入链行（类型未知）引入、后被出链行看到时补全类型
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
    if (addNode(ref, 1)) addEdge(center.id, ref.id, ref.kind);
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
          addEdge(ref.id, neighbor.id, neighbor.kind);
        }
      }
    }
  }

  return {
    nodes: Array.from(nodesById.values()),
    edges: Array.from(edgesByKey.values()),
    truncated,
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
