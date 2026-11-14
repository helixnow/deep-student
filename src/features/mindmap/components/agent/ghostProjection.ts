import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { ensureInitialized } from '../../init';
import { LayoutRegistry } from '../../registry';
import type { LayoutDirection, MindMapNode } from '../../types';
import { findNodeById } from '../../utils/node/find';
import type {
  GhostProposalBranch,
  MindmapAgentSuggestion,
} from '@/stores/mindmapSuggestionStore';

export interface ProjectedGhostNode {
  ghostId: string;
  branchId: string;
  parentId: string;
  text: string;
  note?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isBranchEntry: boolean;
}

export interface ProjectedGhostEdge {
  edgeId: string;
  branchId: string;
  sourceId: string;
  targetId: string;
  /** Cubic bezier SVG path `d` in ReactFlow flow coordinates */
  pathD: string;
  kind?: 'add_branch' | 'move_branch';
}

export interface ProjectedNodeDiffAnnotation {
  nodeId: string;
  branchId: string;
  kind: 'modify_node' | 'remove_subtree' | 'move_branch';
  beforeText?: string;
  afterText?: string;
  noteChanged?: boolean;
  styleChanged?: boolean;
  removedSubtreeCount?: number;
  moveTargetParentText?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GhostCanvasProjection {
  ghostNodes: ProjectedGhostNode[];
  ghostEdges: ProjectedGhostEdge[];
  annotations: ProjectedNodeDiffAnnotation[];
}

export interface RenderedNodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputeGhostCanvasProjectionInput {
  root: MindMapNode;
  viewRootId?: string | null;
  suggestion: MindmapAgentSuggestion | null;
  layoutId?: string;
  layoutDirection?: LayoutDirection;
  measuredNodeHeights?: Record<string, number>;
  realRenderedNodePositions?: ReadonlyMap<string, RenderedNodeBox>;
}

interface GhostNodeMeta {
  branchId: string;
  parentId: string;
  anchorNodeId: string;
  text: string;
  note?: string;
  isBranchEntry: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function cloneTreeSafe(node: MindMapNode, seen = new WeakSet<object>()): MindMapNode {
  seen.add(node);
  const rawChildren = Array.isArray(node.children) ? node.children : [];
  const children: MindMapNode[] = [];
  for (const child of rawChildren) {
    if (child && typeof child === 'object' && !seen.has(child)) {
      children.push(cloneTreeSafe(child, seen));
    }
  }
  return {
    ...node,
    style: node.style ? { ...node.style } : undefined,
    children,
  };
}

function countSubtreeNodes(node: MindMapNode): number {
  let count = 0;
  const stack: MindMapNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    for (let i = current.children.length - 1; i >= 0; i--) {
      stack.push(current.children[i]);
    }
  }
  return count;
}

function indexTree(
  root: MindMapNode,
  nodeMap: Map<string, MindMapNode>,
  parentMap: Map<string, string>,
): void {
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeMap.set(current.id, current);
    for (let i = current.children.length - 1; i >= 0; i--) {
      const child = current.children[i];
      parentMap.set(child.id, current.id);
      stack.push(child);
    }
  }
}

function expandAncestorsInMap(
  nodeId: string,
  nodeMap: Map<string, MindMapNode>,
  parentMap: Map<string, string>,
): void {
  let currentId = parentMap.get(nodeId);
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const anc = nodeMap.get(currentId);
    if (anc && anc.collapsed) {
      anc.collapsed = false;
    }
    currentId = parentMap.get(currentId);
  }
}

export function buildCubicBezierEdgePath(
  source: RenderedNodeBox,
  target: RenderedNodeBox,
  direction: LayoutDirection,
): string {
  if (direction === 'down' || direction === 'up') {
    const isUp = direction === 'up';
    const sx = Math.round(source.x + source.width / 2);
    const sy = Math.round(isUp ? source.y : source.y + source.height);
    const tx = Math.round(target.x + target.width / 2);
    const ty = Math.round(isUp ? target.y + target.height : target.y);
    const cy = Math.round((sy + ty) / 2);
    return `M ${sx} ${sy} C ${sx} ${cy}, ${tx} ${cy}, ${tx} ${ty}`;
  }

  const sourceCenterX = source.x + source.width / 2;
  const targetCenterX = target.x + target.width / 2;
  const goesLeft =
    direction === 'left' || (direction !== 'right' && targetCenterX < sourceCenterX);

  const sx = Math.round(goesLeft ? source.x : source.x + source.width);
  const sy = Math.round(source.y + source.height / 2);
  const tx = Math.round(goesLeft ? target.x + target.width : target.x);
  const ty = Math.round(target.y + target.height / 2);
  const cx = Math.round((sx + tx) / 2);
  return `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ty}, ${tx} ${ty}`;
}

function buildRelocationArcPath(fromBox: RenderedNodeBox, toBox: RenderedNodeBox): string {
  const sx = Math.round(fromBox.x + fromBox.width / 2);
  const sy = Math.round(fromBox.y + fromBox.height / 2);
  const tx = Math.round(toBox.x + toBox.width / 2);
  const ty = Math.round(toBox.y + toBox.height / 2);
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = Math.min(72, Math.max(28, dist * 0.22));
  const nx = -dy / dist;
  const ny = dx / dist;
  const c1x = Math.round(sx + dx * 0.33 + nx * bend);
  const c1y = Math.round(sy + dy * 0.33 + ny * bend);
  const c2x = Math.round(sx + dx * 0.67 + nx * bend);
  const c2y = Math.round(sy + dy * 0.67 + ny * bend);
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
}

function resolveAlignmentDelta(
  anchorNodeId: string,
  parentMap: Map<string, string>,
  virtualLayoutMap: Map<string, RenderedNodeBox>,
  realPositions?: ReadonlyMap<string, RenderedNodeBox>,
): { dx: number; dy: number } {
  if (!realPositions || realPositions.size === 0) return { dx: 0, dy: 0 };
  let candidateId: string | undefined = anchorNodeId;
  const visited = new Set<string>();
  while (candidateId && !visited.has(candidateId)) {
    visited.add(candidateId);
    const realBox = realPositions.get(candidateId);
    const virtualBox = virtualLayoutMap.get(candidateId);
    if (realBox && virtualBox) {
      return {
        dx: realBox.x - virtualBox.x,
        dy: realBox.y - virtualBox.y,
      };
    }
    candidateId = parentMap.get(candidateId);
  }
  return { dx: 0, dy: 0 };
}

export function computeGhostCanvasProjection(
  input: ComputeGhostCanvasProjectionInput,
): GhostCanvasProjection {
  ensureInitialized();

  const {
    root,
    viewRootId,
    suggestion,
    layoutId = 'tree',
    layoutDirection = 'right',
    measuredNodeHeights,
    realRenderedNodePositions,
  } = input;

  if (!root || !suggestion || suggestion.branches.length === 0) {
    return { ghostNodes: [], ghostEdges: [], annotations: [] };
  }

  const visibleSourceRoot = viewRootId
    ? (findNodeById(root, viewRootId) ?? root)
    : root;

  const virtualRoot = cloneTreeSafe(visibleSourceRoot);
  const virtualNodeMap = new Map<string, MindMapNode>();
  const parentMap = new Map<string, string>();
  indexTree(virtualRoot, virtualNodeMap, parentMap);

  // Expand collapsed ancestors for any valid in-scope proposal anchor
  for (const branch of suggestion.branches) {
    if (!virtualNodeMap.has(branch.anchorNodeId)) continue;
    expandAncestorsInMap(branch.anchorNodeId, virtualNodeMap, parentMap);
    if (branch.kind === 'add_branch') {
      const anchorNode = virtualNodeMap.get(branch.anchorNodeId);
      if (anchorNode && anchorNode.collapsed) {
        anchorNode.collapsed = false;
      }
    } else if (branch.kind === 'move_branch' && branch.targetParentId) {
      if (virtualNodeMap.has(branch.targetParentId)) {
        expandAncestorsInMap(branch.targetParentId, virtualNodeMap, parentMap);
      }
    }
  }

  const ghostMetaById = new Map<string, GhostNodeMeta>();

  const injectAddBranch = (branch: GhostProposalBranch): void => {
    if (!virtualNodeMap.has(branch.anchorNodeId)) return;
    let seq = 0;
    let entryAssigned = false;
    const proposedToGhostId = new Map<string, string>();

    const buildVirtualSubtree = (
      rawData: Record<string, unknown>,
      parentVirtualId: string,
      isEntry: boolean,
      seenObjects: WeakSet<object>,
    ): MindMapNode => {
      seenObjects.add(rawData);
      const ghostId = `__ghost__${branch.branchId}__${seq++}`;
      if (typeof rawData.id === 'string' && rawData.id.trim().length > 0) {
        proposedToGhostId.set(rawData.id.trim(), ghostId);
      }
      const text = typeof rawData.text === 'string' ? rawData.text : '';
      const note = typeof rawData.note === 'string' ? rawData.note : undefined;
      const rawChildren = Array.isArray(rawData.children) ? rawData.children : [];
      const children: MindMapNode[] = [];

      for (const childItem of rawChildren) {
        const childRec = asRecord(childItem);
        if (!childRec || seenObjects.has(childRec)) continue;
        const childGhost = buildVirtualSubtree(childRec, ghostId, false, seenObjects);
        children.push(childGhost);
      }

      const ghostNode: MindMapNode = {
        id: ghostId,
        text,
        ...(note !== undefined ? { note } : {}),
        children,
      };
      virtualNodeMap.set(ghostId, ghostNode);
      parentMap.set(ghostId, parentVirtualId);
      ghostMetaById.set(ghostId, {
        branchId: branch.branchId,
        parentId: parentVirtualId,
        anchorNodeId: branch.anchorNodeId,
        text,
        note,
        isBranchEntry: isEntry,
      });
      return ghostNode;
    };

    for (const op of branch.ops) {
      const anchor = asRecord(op.anchor) ?? {};
      const payload = asRecord(op.payload) ?? {};

      if (op.kind === 'add_node') {
        const rawParentId = typeof anchor.parent_id === 'string' ? anchor.parent_id : '';
        const resolvedParentId = proposedToGhostId.get(rawParentId) ?? rawParentId;
        const parentNode = resolvedParentId ? virtualNodeMap.get(resolvedParentId) : undefined;
        if (!parentNode) continue;
        if (parentNode.collapsed) parentNode.collapsed = false;

        const data = asRecord(payload.data) ?? {};
        const isEntry = !entryAssigned && resolvedParentId === branch.anchorNodeId;
        if (isEntry) entryAssigned = true;

        const gNode = buildVirtualSubtree(data, resolvedParentId, isEntry, new WeakSet<object>());
        const rawIndex =
          typeof payload.index === 'number' && Number.isFinite(payload.index)
            ? payload.index
            : parentNode.children.length;
        const clampedIndex = Math.max(0, Math.min(rawIndex, parentNode.children.length));
        parentNode.children.splice(clampedIndex, 0, gNode);
      } else if (op.kind === 'update_node') {
        const rawNodeId = typeof anchor.node_id === 'string' ? anchor.node_id : '';
        const ghostId = proposedToGhostId.get(rawNodeId);
        if (!ghostId) continue;
        const gNode = virtualNodeMap.get(ghostId);
        const meta = ghostMetaById.get(ghostId);
        const patch = asRecord(payload.patch);
        if (gNode && meta && patch) {
          if (typeof patch.text === 'string') {
            gNode.text = patch.text;
            meta.text = patch.text;
          }
          if (typeof patch.note === 'string') {
            gNode.note = patch.note;
            meta.note = patch.note;
          }
        }
      }
    }
  };

  for (const branch of suggestion.branches) {
    if (branch.kind === 'add_branch') {
      injectAddBranch(branch);
    }
  }

  const engine = LayoutRegistry.get(layoutId) ?? LayoutRegistry.get('tree');
  if (!engine) {
    return { ghostNodes: [], ghostEdges: [], annotations: [] };
  }

  const effectiveDirection = engine.directions.includes(layoutDirection)
    ? layoutDirection
    : engine.defaultDirection;

  const layoutConfig = {
    ...DEFAULT_LAYOUT_CONFIG,
    direction: effectiveDirection,
    measuredNodeHeights,
  };

  const layoutResult = engine.calculate(virtualRoot, layoutConfig, effectiveDirection);
  const virtualLayoutMap = new Map<string, RenderedNodeBox>();
  for (const n of layoutResult.nodes) {
    virtualLayoutMap.set(n.id, {
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      width: n.width ?? DEFAULT_LAYOUT_CONFIG.nodeMinWidth,
      height: n.height ?? DEFAULT_LAYOUT_CONFIG.nodeHeight,
    });
  }

  const deltaByAnchorId = new Map<string, { dx: number; dy: number }>();
  const getDeltaForAnchor = (anchorId: string): { dx: number; dy: number } => {
    const cached = deltaByAnchorId.get(anchorId);
    if (cached) return cached;
    const computed = resolveAlignmentDelta(
      anchorId,
      parentMap,
      virtualLayoutMap,
      realRenderedNodePositions,
    );
    deltaByAnchorId.set(anchorId, computed);
    return computed;
  };

  const alignedGhostBoxById = new Map<string, RenderedNodeBox>();
  const ghostNodes: ProjectedGhostNode[] = [];
  const ghostEdges: ProjectedGhostEdge[] = [];

  for (const [ghostId, meta] of ghostMetaById.entries()) {
    const vbox = virtualLayoutMap.get(ghostId);
    if (!vbox) continue;
    const { dx, dy } = getDeltaForAnchor(meta.anchorNodeId);
    const alignedBox: RenderedNodeBox = {
      x: Math.round(vbox.x + dx),
      y: Math.round(vbox.y + dy),
      width: vbox.width,
      height: vbox.height,
    };
    alignedGhostBoxById.set(ghostId, alignedBox);
    ghostNodes.push({
      ghostId,
      branchId: meta.branchId,
      parentId: meta.parentId,
      text: meta.text,
      ...(meta.note !== undefined ? { note: meta.note } : {}),
      x: alignedBox.x,
      y: alignedBox.y,
      width: alignedBox.width,
      height: alignedBox.height,
      isBranchEntry: meta.isBranchEntry,
    });
  }

  for (const [ghostId, meta] of ghostMetaById.entries()) {
    const targetBox = alignedGhostBoxById.get(ghostId);
    if (!targetBox) continue;
    let sourceBox: RenderedNodeBox | undefined = alignedGhostBoxById.get(meta.parentId);
    if (!sourceBox) {
      sourceBox = realRenderedNodePositions?.get(meta.parentId);
    }
    if (!sourceBox) {
      const vParent = virtualLayoutMap.get(meta.parentId);
      if (vParent) {
        const { dx, dy } = getDeltaForAnchor(meta.anchorNodeId);
        sourceBox = {
          x: Math.round(vParent.x + dx),
          y: Math.round(vParent.y + dy),
          width: vParent.width,
          height: vParent.height,
        };
      }
    }
    if (!sourceBox) continue;

    ghostEdges.push({
      edgeId: `ge_${ghostId}`,
      branchId: meta.branchId,
      sourceId: meta.parentId,
      targetId: ghostId,
      pathD: buildCubicBezierEdgePath(sourceBox, targetBox, effectiveDirection),
      kind: 'add_branch',
    });
  }

  const resolveRealOrVirtualBox = (nodeId: string): RenderedNodeBox | null => {
    const real = realRenderedNodePositions?.get(nodeId);
    if (real) return real;
    const v = virtualLayoutMap.get(nodeId);
    if (!v) return null;
    const { dx, dy } = getDeltaForAnchor(nodeId);
    return {
      x: Math.round(v.x + dx),
      y: Math.round(v.y + dy),
      width: v.width,
      height: v.height,
    };
  };

  const annotations: ProjectedNodeDiffAnnotation[] = [];

  for (const branch of suggestion.branches) {
    if (branch.kind === 'add_branch') continue;

    const sourceNode = findNodeById(visibleSourceRoot, branch.anchorNodeId);
    if (!sourceNode) continue;
    const box = resolveRealOrVirtualBox(branch.anchorNodeId);
    if (!box) continue;

    if (branch.kind === 'modify_node') {
      let afterText = sourceNode.text;
      let noteChanged = false;
      let styleChanged = false;
      for (const op of branch.ops) {
        const payload = asRecord(op.payload);
        const patch = asRecord(payload?.patch);
        if (!patch) continue;
        if (typeof patch.text === 'string') {
          afterText = patch.text;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'note') && patch.note !== sourceNode.note) {
          noteChanged = true;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'style')) {
          styleChanged = true;
        }
      }
      annotations.push({
        nodeId: branch.anchorNodeId,
        branchId: branch.branchId,
        kind: 'modify_node',
        beforeText: sourceNode.text,
        afterText,
        noteChanged,
        styleChanged,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
    } else if (branch.kind === 'remove_subtree') {
      annotations.push({
        nodeId: branch.anchorNodeId,
        branchId: branch.branchId,
        kind: 'remove_subtree',
        beforeText: sourceNode.text,
        removedSubtreeCount: countSubtreeNodes(sourceNode),
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
    } else if (branch.kind === 'move_branch') {
      const targetParent = branch.targetParentId
        ? findNodeById(visibleSourceRoot, branch.targetParentId)
        : null;
      annotations.push({
        nodeId: branch.anchorNodeId,
        branchId: branch.branchId,
        kind: 'move_branch',
        beforeText: sourceNode.text,
        moveTargetParentText: targetParent?.text ?? branch.targetParentId,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });

      if (branch.targetParentId && findNodeById(visibleSourceRoot, branch.targetParentId)) {
        const destBox = resolveRealOrVirtualBox(branch.targetParentId);
        if (destBox) {
          ghostEdges.push({
            edgeId: `ge_move_${branch.branchId}`,
            branchId: branch.branchId,
            sourceId: branch.anchorNodeId,
            targetId: branch.targetParentId,
            pathD: buildRelocationArcPath(box, destBox),
            kind: 'move_branch',
          });
        }
      }
    }
  }

  return { ghostNodes, ghostEdges, annotations };
}
