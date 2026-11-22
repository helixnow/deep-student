import { useCallback, useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { LayoutDirection, MindMapNode } from '../../../types';
import type { ILayoutEngine, IStyleTheme } from '../../../registry/types';
import {
  DEFAULT_LAYOUT_CONFIG,
  ROOT_NODE_STYLE,
  calculateBaseNodeHeight,
  getBranchColor,
} from '../../../constants';
import { filterCompletedTree } from '../../../utils/hideCompleted';
import { findNodeById } from '../../../utils/node/find';
import { getAncestors } from '../../../utils/node/traverse';

const HOVER_PATH_CLASS = 'mm-edge-hover-path';

/** 计算像素对齐后的画布布局节点与树边 */
export function computeCanvasLayout(params: {
  root: MindMapNode | undefined;
  viewRootId: string | null;
  hideCompleted: boolean;
  layoutId: string;
  layoutDirection: string;
  layoutEngine: ILayoutEngine | undefined;
  activeTheme?: IStyleTheme | undefined;
  branchBaseHeight?: number;
  leafBaseHeight?: number;
  measuredNodeHeights: Record<string, number>;
  unnamedNodeLabel: string;
}): { nodes: Node[]; edges: Edge[] } {
  const {
    root,
    viewRootId,
    hideCompleted,
    layoutId,
    layoutDirection,
    layoutEngine,
    activeTheme,
    branchBaseHeight,
    leafBaseHeight,
    measuredNodeHeights,
    unnamedNodeLabel,
  } = params;
  if (!root || !layoutEngine) {
    if (root && !layoutEngine) {
      console.warn(`Layout engine "${layoutId}" not found and no default available`);
    }
    return { nodes: [], edges: [] };
  }

  const validDirection = layoutEngine.directions.includes(layoutDirection as LayoutDirection)
    ? (layoutDirection as LayoutDirection)
    : layoutEngine.defaultDirection;

  const resolvedBranchBaseHeight =
    branchBaseHeight ?? calculateBaseNodeHeight(activeTheme?.node?.branch, 15, '6px 12px');
  const resolvedLeafBaseHeight =
    leafBaseHeight ?? calculateBaseNodeHeight(activeTheme?.node?.leaf, 14, '4px 8px');

  const layoutConfig = {
    ...DEFAULT_LAYOUT_CONFIG,
    direction: validDirection,
    nodeHeight: Math.max(
      DEFAULT_LAYOUT_CONFIG.nodeHeight,
      resolvedBranchBaseHeight,
      resolvedLeafBaseHeight,
    ),
    rootNodeHeight: Math.max(
      DEFAULT_LAYOUT_CONFIG.rootNodeHeight,
      calculateBaseNodeHeight(ROOT_NODE_STYLE, 18, '12px 24px'),
    ),
    measuredNodeHeights,
    unnamedNodeLabel,
  };

  let layoutRoot = root;
  if (viewRootId) {
    const focused = findNodeById(root, viewRootId);
    if (focused) layoutRoot = focused;
  }
  if (hideCompleted) layoutRoot = filterCompletedTree(layoutRoot);

  const layoutResult = layoutEngine.calculate(layoutRoot, layoutConfig, validDirection);
  const pixelAlignedNodes = layoutResult.nodes.map((n) =>
    Number.isInteger(n.position.x) && Number.isInteger(n.position.y)
      ? n
      : { ...n, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } },
  );
  return { nodes: pixelAlignedNodes, edges: layoutResult.edges };
}

/** 计算新节点生长动画起点（父节点中心） */
export function computeNodeSpawnOrigin(
  node: Node,
  parentIdByNodeId: Map<string, string>,
  layoutNodeById: Map<string, Node>,
): { x: number; y: number } | undefined {
  if (node.className && /\bagent-(?:entering|exiting)\b/.test(node.className)) {
    return undefined;
  }
  const parentId = parentIdByNodeId.get(node.id);
  const parent = parentId ? layoutNodeById.get(parentId) : undefined;
  if (!parent) return undefined;
  const parentW = (parent.width as number | undefined) ?? parent.measured?.width ?? 100;
  const parentH = (parent.height as number | undefined) ?? parent.measured?.height ?? 36;
  const nodeW = (node.width as number | undefined) ?? node.measured?.width ?? 100;
  const nodeH = (node.height as number | undefined) ?? node.measured?.height ?? 36;
  return {
    x: parent.position.x + parentW / 2 - nodeW / 2,
    y: parent.position.y + parentH / 2 - nodeH / 2,
  };
}

/** 基于当前激活主题色板构建 MiniMap 分支配色表（自动同步暗色/主题切换） */
export function buildMinimapBranchColorMap(
  branchIndexById: Map<string, number>,
  palette: readonly string[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!palette || palette.length === 0) return map;
  branchIndexById.forEach((index, id) => {
    map.set(id, palette[index % palette.length]);
  });
  return map;
}

/** 视图根一级分支索引映射（供 BranchNode、彩虹分支连线与 MiniMap 复用，O(n) 单次构建） */
export function computeBranchIndexMap(
  root: MindMapNode,
  viewRootId: string | null,
): Map<string, number> {
  const map = new Map<string, number>();
  let branchRoot = root;
  if (viewRootId) {
    const focused = findNodeById(root, viewRootId);
    if (focused) branchRoot = focused;
  }
  branchRoot.children.forEach((branch, index) => {
    const stack: MindMapNode[] = [branch];
    while (stack.length > 0) {
      const current = stack.pop()!;
      map.set(current.id, index);
      for (const child of current.children) stack.push(child);
    }
  });
  return map;
}

/** Spotlight 分支演示模式激活节点集合（根节点 + 视图根 + 当前分支及其全部后代） */
export function computeSpotlightActiveIds(
  root: MindMapNode,
  viewRootId: string | null,
  presentationMode: boolean,
  presentationBranchId: string | null,
): Set<string> | null {
  if (!presentationMode || !presentationBranchId) return null;
  const branchNode = findNodeById(root, presentationBranchId);
  if (!branchNode) return null;
  const active = new Set<string>([root.id]);
  if (viewRootId) active.add(viewRootId);
  const stack: MindMapNode[] = [branchNode];
  while (stack.length > 0) {
    const current = stack.pop()!;
    active.add(current.id);
    for (const child of current.children) stack.push(child);
  }
  return active;
}

export interface BuildStyledCanvasEdgesParams {
  allEdges: Edge[];
  layoutNodeById: Map<string, Node>;
  ancestorPathEdgeKeys: Set<string> | null;
  focusedNodeId: string | null;
  useBranchPalette: boolean;
  branchIndexById: Map<string, number>;
  isDarkTheme: boolean;
  spotlightActiveIds: Set<string> | null;
}

/**
 * 构建画布最终边样式：
 * - 建筑感层级渐缩描边与透明度
 * - 焦点祖先路径高亮（.mm-edge-ancestor-path）+ 焦点出边强调（emphasized）
 * - 矿物彩虹分支连线（仅 colorful / colorful-dark 等 useBranchPalette 主题）
 * - CSS 变量回退槽位（--mm-hover-*），供零重渲染悬停路径类名直接覆盖
 * - Spotlight 演示模式非激活边淡化（.mm-spotlight-dimmed）
 */
export function buildStyledCanvasEdges({
  allEdges,
  layoutNodeById,
  ancestorPathEdgeKeys,
  focusedNodeId,
  useBranchPalette,
  branchIndexById,
  isDarkTheme,
  spotlightActiveIds,
}: BuildStyledCanvasEdgesParams): Edge[] {
  return allEdges.map((edge) => {
    const isAssociation = (edge.data as { kind?: string } | undefined)?.kind === 'association';
    const edgeKey = `${edge.source}->${edge.target}`;
    const sourceNode = layoutNodeById.get(edge.source);
    const sourceLevel = sourceNode
      ? sourceNode.type === 'rootNode' || sourceNode.type === 'root'
        ? 0
        : ((sourceNode.data as { level?: number } | undefined)?.level ?? 1)
      : 0;
    const taperedStrokeWidth = sourceLevel === 0 ? 1.8 : sourceLevel === 1 ? 1.35 : 1.05;
    const taperedOpacity = sourceLevel === 0 ? 0.92 : sourceLevel === 1 ? 0.78 : 0.65;
    const isAncestorPath = !isAssociation && !!ancestorPathEdgeKeys?.has(edgeKey);
    const isEmphasized =
      !isAssociation && !isAncestorPath && !!focusedNodeId && edge.source === focusedNodeId;

    let branchStroke: string | undefined;
    if (!isAssociation && !isAncestorPath && useBranchPalette) {
      const branchIdx = branchIndexById.get(edge.target) ?? branchIndexById.get(edge.source);
      if (branchIdx !== undefined) {
        branchStroke = getBranchColor(branchIdx, Math.max(0, sourceLevel), isDarkTheme);
      }
    }

    const isSpotlightDimmed =
      !!spotlightActiveIds &&
      !(spotlightActiveIds.has(edge.source) && spotlightActiveIds.has(edge.target));

    const classes: string[] = [];
    if (edge.className) classes.push(edge.className);
    if (isAncestorPath) classes.push('mm-edge-ancestor-path');
    if (isSpotlightDimmed) classes.push('mm-spotlight-dimmed');

    const baseStroke =
      branchStroke ?? (edge.style?.stroke as string | undefined) ?? 'var(--mm-edge)';

    return {
      ...edge,
      className: classes.length > 0 ? classes.join(' ') : undefined,
      data: isAssociation
        ? edge.data
        : {
            ...(edge.data as object | undefined),
            sourceLevel,
            ...(isEmphasized ? { emphasized: true } : {}),
          },
      style: {
        ...edge.style,
        ...(isAssociation
          ? { opacity: edge.selected ? 1 : 0.72 }
          : isAncestorPath
            ? {
                stroke: 'var(--mm-edge-active, var(--mm-primary))',
                strokeWidth: 2.25,
                opacity: 1,
              }
            : {
                stroke: `var(--mm-hover-stroke, ${baseStroke})`,
                strokeWidth: `var(--mm-hover-stroke-width, ${taperedStrokeWidth}px)`,
                opacity: `var(--mm-hover-opacity, ${taperedOpacity})` as unknown as number,
              }),
      },
    };
  });
}

/** 计算节点 → 根的祖先链树边键集合（"parent->child"） */
export function computeAncestorPathEdgeKeys(
  root: MindMapNode,
  nodeId: string | null,
): Set<string> | null {
  if (!nodeId) return null;
  const ancestors = getAncestors(root, nodeId);
  if (ancestors.length === 0) return null;
  const path = [...ancestors.map((n) => n.id), nodeId];
  const keys = new Set<string>();
  for (let i = 0; i < path.length - 1; i++) {
    keys.add(`${path[i]}->${path[i + 1]}`);
  }
  return keys;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface UseCanvasHoverPathOptions {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  root: MindMapNode;
  edges: Edge[];
  focusedNodeId: string | null;
  ancestorPathEdgeKeys: Set<string> | null;
  isCoarsePointer: boolean;
  isDragging: boolean;
}

export interface UseCanvasHoverPathResult {
  onNodeMouseEnter: (_: React.MouseEvent, node: Node) => void;
  onNodeMouseLeave: () => void;
  clearHoverPath: () => void;
}

/**
 * 零 React 重渲染的悬停祖先路径高亮：
 * 鼠标移入节点时，仅对 `node -> root` 链路上命中的 `.react-flow__edge[data-id="..."]`
 * DOM 元素直接增删 `.mm-edge-hover-path` 类（O(depth) DOM 操作，0 React state 更新，
 * 0 `styledEdges` 全量重建）。触屏（coarse pointer）与拖拽中自动跳过并清理。
 */
export function useCanvasHoverPath({
  canvasContainerRef,
  root,
  edges,
  focusedNodeId,
  ancestorPathEdgeKeys,
  isCoarsePointer,
  isDragging,
}: UseCanvasHoverPathOptions): UseCanvasHoverPathResult {
  const activeEdgeElsRef = useRef<Element[]>([]);

  const edgeIdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const edge of edges) {
      map.set(`${edge.source}->${edge.target}`, edge.id);
    }
    return map;
  }, [edges]);

  const clearHoverPath = useCallback(() => {
    const active = activeEdgeElsRef.current;
    if (active.length === 0) return;
    for (let i = 0; i < active.length; i++) {
      active[i].classList.remove(HOVER_PATH_CLASS);
    }
    activeEdgeElsRef.current = [];
  }, []);

  const onNodeMouseEnter = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (isCoarsePointer) return;
      clearHoverPath();
      if (isDragging || !node.id || node.id === focusedNodeId) return;

      const container = canvasContainerRef.current;
      if (!container) return;

      const ancestors = getAncestors(root, node.id);
      if (ancestors.length === 0) return;

      const path = [...ancestors.map((n) => n.id), node.id];
      const nextActive: Element[] = [];
      for (let i = 0; i < path.length - 1; i++) {
        const edgeKey = `${path[i]}->${path[i + 1]}`;
        // 焦点祖先链已处于更强高亮档位，不叠加悬停类
        if (ancestorPathEdgeKeys?.has(edgeKey)) continue;
        const edgeId = edgeIdByKey.get(edgeKey);
        if (!edgeId) continue;
        const el = container.querySelector(
          `.react-flow__edge[data-id="${escapeAttrValue(edgeId)}"]`,
        );
        if (el) {
          el.classList.add(HOVER_PATH_CLASS);
          nextActive.push(el);
        }
      }
      activeEdgeElsRef.current = nextActive;
    },
    [
      isCoarsePointer,
      isDragging,
      focusedNodeId,
      canvasContainerRef,
      root,
      ancestorPathEdgeKeys,
      edgeIdByKey,
      clearHoverPath,
    ],
  );

  const onNodeMouseLeave = useCallback(() => {
    clearHoverPath();
  }, [clearHoverPath]);

  // 拖拽开始、切换触屏或拓扑/焦点变更时清理悬停路径，防止残留高亮
  useEffect(() => {
    clearHoverPath();
  }, [isDragging, isCoarsePointer, focusedNodeId, edgeIdByKey, clearHoverPath]);

  useEffect(() => clearHoverPath, [clearHoverPath]);

  return {
    onNodeMouseEnter,
    onNodeMouseLeave,
    clearHoverPath,
  };
}
