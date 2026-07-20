import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  DndContext,
  closestCenter,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  DragMoveEvent,
  DragOverlay,
  MeasuringStrategy,
  UniqueIdentifier,
  defaultDropAnimationSideEffects,
  DropAnimation,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import { useMindMapStore, useMindMapStoreApi } from '../store';
import { cn } from '@/lib/utils';
import { ListBullets } from '@phosphor-icons/react';
import type { MindMapNode } from '../types';
import { MindMapResourcePicker } from '../components/mindmap/MindMapResourcePicker';
import { findNodeById, isDescendantOf } from '../utils/node/find';
import {
  createOutlineCaretController,
  resolveGoalEntryOffset,
} from '../utils/outlineCaret';
import { collectTopLevelNodeIds, getAncestors } from '../utils/node/traverse';
import {
  flattenOutlineTree,
  resolveSearchPathIds,
} from '../utils/searchFilter';
import { resolveVisibleFocusId } from '../utils/hideCompleted';
import { writeMindMapClipboard } from '../utils/clipboardCodec';
import { useMindMapIsActive } from '../MindMapActiveContext';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import '../styles/outline-enhancements.css';
import type { MindMapDescriptionPreview, MindMapKeymap } from '../utils/mindmapPreferences';
import {
  LEVEL_INDENT,
  type DropPosition,
  type FlatNode,
} from './outline/outlineShared';
import {
  SortableOutlineNode,
  type OutlineNavigateDirection,
} from './outline/SortableOutlineNode';
import { OutlineBreadcrumb } from './outline/OutlineBreadcrumb';
import { OutlineMultiselectBar } from './outline/OutlineMultiselectBar';
import { OutlineDragOverlayContent } from './outline/OutlineDragOverlay';

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.4' } },
  }),
};

/** 基于当前可见 flat 列表做 Shift 范围选 */
function getVisibleRangeIds(
  flatNodes: FlatNode[],
  fromId: string,
  toId: string,
  options?: { excludeRoot?: boolean; indexById?: ReadonlyMap<string, number> }
): string[] {
  const fromIdx = options?.indexById?.get(fromId) ?? flatNodes.findIndex((n) => n.id === fromId);
  const toIdx = options?.indexById?.get(toId) ?? flatNodes.findIndex((n) => n.id === toId);
  if (fromIdx < 0 || toIdx < 0) return [toId];
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  return flatNodes
    .slice(start, end + 1)
    .filter((n) => !(options?.excludeRoot && n.level === 0))
    .map((n) => n.id);
}

// 获取从根节点到目标节点的路径（含目标节点自身）
function getPathToNode(root: MindMapNode, targetId: string): MindMapNode[] {
  const ancestors = getAncestors(root, targetId);
  const target = findNodeById(root, targetId);
  return target ? [...ancestors, target] : ancestors;
}

export interface OutlineViewHandle {
  getScrollTop: () => number;
  setScrollTop: (top: number) => void;
  scrollFocusedIntoView: () => void;
}

export interface OutlineViewProps {
  /** 切回大纲时恢复的 scrollTop；随后再把焦点行滚到中部 */
  initialScrollTop?: number | null;
  keymap?: MindMapKeymap;
  descriptionPreview?: MindMapDescriptionPreview;
}

export const OutlineView = React.forwardRef<OutlineViewHandle, OutlineViewProps>(
  function OutlineView({ initialScrollTop = null, keymap = 'deep-student', descriptionPreview = 'full' }, ref) {
  const { t } = useTranslation('mindmap');
  const storeApi = useMindMapStoreApi();
  // E01 B1：caret / goal column 状态按 store 实例隔离
  const caret = useMemo(() => createOutlineCaretController(storeApi), [storeApi]);
  const document = useMindMapStore(state => state.document);
  const hideCompleted = useMindMapStore(state => state.hideCompleted);
  const searchResults = useMindMapStore(state => state.searchResults);
  const searchQuery = useMindMapStore(state => state.searchQuery);
  const currentSearchIndex = useMindMapStore(state => state.currentSearchIndex);
  const searchFilterMode = useMindMapStore(state => state.searchFilterMode);
  const moveNodes = useMindMapStore(state => state.moveNodes);
  const addNode = useMindMapStore(state => state.addNode);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  const addNodeRef = useMindMapStore(state => state.addNodeRef);
  const selection = useMindMapStore(state => state.selection);
  const setSelection = useMindMapStore(state => state.setSelection);
  const focusedNodeId = useMindMapStore(state => state.focusedNodeId);
  const viewRootId = useMindMapStore(state => state.viewRootId);
  const setViewRootId = useMindMapStore(state => state.setViewRootId);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  /** ACR R2-02：与画布共用 agentEnteringIds，保证大纲同步入场动画 */
  const agentEnteringIds = useMindMapStore(state => state.agentEnteringIds);
  /** ACR 4.0 A4：delete 退场 / update 内容更新高亮（与画布同步） */
  const agentExitingIds = useMindMapStore(state => state.agentExitingIds);
  const agentUpdatedIds = useMindMapStore(state => state.agentUpdatedIds);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [dragGroupIds, setDragGroupIds] = useState<string[]>([]);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<DropPosition>('inside');
  const [resourcePickerNodeId, setResourcePickerNodeId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollRef = useRef(false);
  const pendingScrollTopRef = useRef<number | null>(
    initialScrollTop != null && initialScrollTop >= 0 ? initialScrollTop : null,
  );

  const sensors = useTouchFriendlyDndSensors();

  const scrollFocusedRowIntoView = useCallback(() => {
    const root = containerRef.current;
    const id = storeApi.getState().focusedNodeId;
    if (!root || !id) return;
    const escaped =
      typeof globalThis.CSS?.escape === 'function'
        ? globalThis.CSS.escape(id)
        : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const row = root.querySelector(
      `[data-node-id="${escaped}"]`,
    ) as HTMLElement | null;
    row?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [storeApi]);

  const restoreScrollIfNeeded = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || restoredScrollRef.current) return;
      restoredScrollRef.current = true;
      const top = pendingScrollTopRef.current;
      pendingScrollTopRef.current = null;
      if (top != null) el.scrollTop = top;
      // 仅当焦点行完全在视口外时再滚入，避免冲掉双模滚动保真
      requestAnimationFrame(() => {
        const id = storeApi.getState().focusedNodeId;
        if (!id || !containerRef.current) return;
        const escaped =
          typeof globalThis.CSS?.escape === 'function'
            ? globalThis.CSS.escape(id)
            : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const row = containerRef.current.querySelector(
          `[data-node-id="${escaped}"]`,
        ) as HTMLElement | null;
        if (!row) return;
        const rowRect = row.getBoundingClientRect();
        const viewRect = el.getBoundingClientRect();
        const fullyOutside =
          rowRect.bottom < viewRect.top || rowRect.top > viewRect.bottom;
        if (fullyOutside) {
          row.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      });
    },
    [storeApi],
  );

  const setScrollViewport = useCallback(
    (el: HTMLDivElement | null) => {
      scrollViewportRef.current = el;
      restoreScrollIfNeeded(el);
    },
    [restoreScrollIfNeeded],
  );

  React.useImperativeHandle(ref, () => ({
    getScrollTop: () => scrollViewportRef.current?.scrollTop ?? 0,
    setScrollTop: (top: number) => {
      const el = scrollViewportRef.current;
      if (el) el.scrollTop = top;
    },
    scrollFocusedIntoView: scrollFocusedRowIntoView,
  }), [scrollFocusedRowIntoView]);

  // 兜底：viewport 已就绪时再恢复一次（native ScrollArea 同步挂载路径）
  useEffect(() => {
    restoreScrollIfNeeded(scrollViewportRef.current);
  }, [restoreScrollIfNeeded]);

  // ★ 移动端虚拟键盘：键盘弹起（visualViewport 缩小）后，把正在编辑的
  // 输入框滚回可视区中部，避免被键盘遮挡
  useEffect(() => {
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      const active = globalThis.document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') &&
        containerRef.current?.contains(active)
      ) {
        active.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  const displayRoot = useMemo(() => {
    if (!viewRootId) return document.root;
    return findNodeById(document.root, viewRootId) || document.root;
  }, [document.root, viewRootId]);

  const breadcrumbPath = useMemo(() => {
    if (!viewRootId) return [];
    return getPathToNode(document.root, viewRootId);
  }, [document.root, viewRootId]);

  const searchPathIds = useMemo(() => {
    return resolveSearchPathIds(displayRoot, {
      enabled: searchFilterMode,
      query: searchQuery,
      matchIds: searchResults,
    });
  }, [searchFilterMode, searchQuery, searchResults, displayRoot]);

  const allFlatNodes = useMemo(
    () =>
      flattenOutlineTree(displayRoot, {
        hideCompleted,
        pathIds: searchPathIds,
      }),
    [displayRoot, hideCompleted, searchPathIds]
  );
  const allFlatNodeById = useMemo(
    () => new Map(allFlatNodes.map((node) => [node.id, node])),
    [allFlatNodes],
  );
  const allFlatNodeIndexById = useMemo(
    () => new Map(allFlatNodes.map((node, index) => [node.id, index])),
    [allFlatNodes],
  );

  // 焦点落在被隐藏的已完成节点时，上移到可见祖先
  useEffect(() => {
    if (!hideCompleted || searchPathIds !== null || !focusedNodeId) return;
    const next = resolveVisibleFocusId(document.root, focusedNodeId, true);
    if (next && next !== focusedNodeId) {
      setFocusedNodeId(next);
    }
  }, [hideCompleted, searchPathIds, focusedNodeId, document.root, setFocusedNodeId]);

  // 追踪新出现的节点（展开动画）+ ACR agentEnteringIds（R2-02 大纲同步）
  const isInitialRender = useRef(true);
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  // 专注切换（zoom in/out）会一次性显隐大量行：跳过差分入场，
  // 由容器级 WAAPI 过渡承担视觉反馈，避免整树逐行重放动画
  const enteringViewRootRef = useRef(viewRootId);
  const enteringNodeIds = useMemo(() => {
    const entering = new Set<string>();
    const zoomChanged = enteringViewRootRef.current !== viewRootId;
    if (!isInitialRender.current && !zoomChanged) {
      const prev = prevNodeIdsRef.current;
      allFlatNodes.forEach(fn => {
        if (!prev.has(fn.id)) entering.add(fn.id);
      });
    }
    // Agent 演出：即使差分未命中（如 update/move），也播 entering
    agentEnteringIds.forEach(id => entering.add(id));
    return entering;
  }, [allFlatNodes, agentEnteringIds, viewRootId]);

  useEffect(() => {
    isInitialRender.current = false;
    enteringViewRootRef.current = viewRootId;
    prevNodeIdsRef.current = new Set(allFlatNodes.map(fn => fn.id));
  }, [allFlatNodes, viewRootId]);

  // 拖拽时收集被拖节点（及多选组其它成员）的后代 ID，用于隐藏子树
  const dragHiddenIds = useMemo(() => {
    if (!activeId) return new Set<string>();
    const ids = new Set<string>();
    const collect = (n: MindMapNode) => {
      n.children?.forEach(child => { ids.add(child.id); collect(child); });
    };
    const group = dragGroupIds.length > 0 ? dragGroupIds : [String(activeId)];
    for (const gid of group) {
      const node = allFlatNodeById.get(gid)?.node;
      if (!node) continue;
      if (gid !== String(activeId)) ids.add(gid); // 隐藏组内其它顶层项
      collect(node);
    }
    return ids;
  }, [activeId, dragGroupIds, allFlatNodeById]);

  // 拖拽期间过滤掉后代/组内其它节点，使子树跟随父节点一起移动
  const flatNodes = useMemo(() => {
    if (dragHiddenIds.size === 0) return allFlatNodes;
    return allFlatNodes.filter(fn => !dragHiddenIds.has(fn.id));
  }, [allFlatNodes, dragHiddenIds]);

  const nodeIds = useMemo(() => flatNodes.map(n => n.id), [flatNodes]);
  const flatNodeById = useMemo(
    () => new Map(flatNodes.map((node) => [node.id, node])),
    [flatNodes],
  );
  const flatNodeIndexById = useMemo(
    () => new Map(flatNodes.map((node, index) => [node.id, index])),
    [flatNodes],
  );

  // ★ 行组件走 React.memo：事件回调一律通过 ref 读取最新列表，保持引用稳定
  const allFlatNodesRef = useRef(allFlatNodes);
  allFlatNodesRef.current = allFlatNodes;
  const allFlatNodeByIdRef = useRef(allFlatNodeById);
  allFlatNodeByIdRef.current = allFlatNodeById;
  const allFlatNodeIndexByIdRef = useRef(allFlatNodeIndexById);
  allFlatNodeIndexByIdRef.current = allFlatNodeIndexById;
  const flatNodesRef = useRef(flatNodes);
  flatNodesRef.current = flatNodes;
  const flatNodeIndexByIdRef = useRef(flatNodeIndexById);
  flatNodeIndexByIdRef.current = flatNodeIndexById;

  // ★ 无焦点节点时的键盘入口：↓/Enter 聚焦首行、↑ 聚焦末行。
  // 行级键盘处理都挂在行内 textarea 上，初次进入大纲（未点击任何行）时
  // 方向键会完全无响应；这里补上 document 级兜底（活跃实例门控）。
  const outlineKeyboardActive = useMindMapIsActive();
  useEffect(() => {
    if (!outlineKeyboardActive || reciteMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      if (storeApi.getState().focusedNodeId) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      const list = flatNodesRef.current;
      if (list.length === 0) return;
      e.preventDefault();
      const entry = e.key === 'ArrowUp' ? list[list.length - 1] : list[0];
      setFocusedNodeId(entry.id);
    };
    globalThis.document.addEventListener('keydown', handleKeyDown);
    return () => globalThis.document.removeEventListener('keydown', handleKeyDown);
  }, [outlineKeyboardActive, reciteMode, setFocusedNodeId, storeApi]);

  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const searchResultSet = useMemo(() => new Set(searchResults), [searchResults]);
  const currentSearchResultId =
    currentSearchIndex >= 0 ? (searchResults[currentSearchIndex] ?? null) : null;
  const isMultiSelectActive = selection.length > 1;

  // 搜索命中定位：当前命中变化时把对应行滚到视口中部。
  // 搜索期间焦点在搜索框里，行级聚焦 effect 不会接管滚动，这里补上。
  useEffect(() => {
    if (!currentSearchResultId) return;
    const raf = requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      const escaped =
        typeof globalThis.CSS?.escape === 'function'
          ? globalThis.CSS.escape(currentSearchResultId)
          : currentSearchResultId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const row = root.querySelector<HTMLElement>(`[data-node-id="${escaped}"]`);
      if (!row) return;
      const prefersReduced =
        !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({
        block: 'center',
        behavior: prefersReduced ? 'auto' : 'smooth',
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentSearchResultId]);

  // 专注模式 Esc 逐级返回：行级 Esc 已消化「退出编辑→清焦点」两段，
  // 焦点/选中都清空后再按 Esc 上移一层专注根，直至回到整棵树。
  useEffect(() => {
    if (!outlineKeyboardActive || reciteMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // 行级「Esc 清焦点」等已消费的按键不再叠加缩放返回
      if (e.defaultPrevented) return;
      const state = storeApi.getState();
      if (!state.viewRootId) return;
      if (state.focusedNodeId || state.selection.length > 0) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const parent = getAncestors(state.document.root, state.viewRootId).at(-1);
      state.setViewRootId(
        parent && parent.id !== state.document.root.id ? parent.id : null,
      );
    };
    globalThis.document.addEventListener('keydown', handleKeyDown);
    return () => globalThis.document.removeEventListener('keydown', handleKeyDown);
  }, [outlineKeyboardActive, reciteMode, storeApi]);

  const handleRowSelect = useCallback((nodeId: string, e: React.MouseEvent) => {
    const state = storeApi.getState();
    const flat = allFlatNodesRef.current;
    const isRootRow = allFlatNodeByIdRef.current.get(nodeId)?.level === 0;

    if (e.shiftKey) {
      const anchor = state.selectionAnchorId || state.focusedNodeId || nodeId;
      const rangeIds = getVisibleRangeIds(flat, anchor, nodeId, {
        excludeRoot: true,
        indexById: allFlatNodeIndexByIdRef.current,
      });
      state.setSelection(rangeIds.length > 0 ? rangeIds : (isRootRow ? [] : [nodeId]));
      state.setFocusedNodeId(nodeId);
      return;
    }

    if (e.metaKey || e.ctrlKey) {
      if (isRootRow) {
        state.setFocusedNodeId(nodeId);
        return;
      }
      const rootId = state.document.root.id;
      const next = state.selection.includes(nodeId)
        ? state.selection.filter((id) => id !== nodeId)
        : [...state.selection.filter((id) => id !== rootId), nodeId];
      state.setSelection(next);
      state.setSelectionAnchorId(nodeId);
      state.setFocusedNodeId(nodeId);
      return;
    }

    // 单击：单选并聚焦（保持可编辑）
    state.setSelection(isRootRow ? [] : [nodeId]);
    state.setSelectionAnchorId(nodeId);
    state.setFocusedNodeId(nodeId);
  }, [storeApi]);

  /** 当前多选的顶层节点（后代随父操作），按需计算避免订阅膨胀 */
  const getTopLevelSelectedIds = useCallback(() => {
    const state = storeApi.getState();
    return collectTopLevelNodeIds(state.document.root, state.selection, {
      excludeRoot: true,
    });
  }, [storeApi]);

  const handleBatchDelete = useCallback(() => {
    const ids = getTopLevelSelectedIds();
    if (ids.length === 0) return;
    const state = storeApi.getState();
    state.deleteNodes(ids);
    state.setSelection([]);
  }, [getTopLevelSelectedIds, storeApi]);

  const handleBatchIndent = useCallback(() => {
    storeApi.getState().indentNodes(getTopLevelSelectedIds());
  }, [getTopLevelSelectedIds, storeApi]);

  const handleBatchOutdent = useCallback(() => {
    storeApi.getState().outdentNodes(getTopLevelSelectedIds());
  }, [getTopLevelSelectedIds, storeApi]);

  const handleBatchComplete = useCallback(() => {
    const state = storeApi.getState();
    state.toggleCompleted(state.selection);
  }, [storeApi]);

  // 批量折叠选中节点（有子且未折叠的）；沿用 toggleCollapse 的单事务折叠模式
  const handleBatchCollapse = useCallback(() => {
    const state = storeApi.getState();
    const ids = getTopLevelSelectedIds().filter((id) => {
      const n = findNodeById(state.document.root, id);
      return !!n && (n.children?.length ?? 0) > 0 && !n.collapsed;
    });
    ids.forEach((id, i) => {
      state.toggleCollapse(id, {
        skipHistory: i > 0,
        skipSave: i < ids.length - 1,
      });
    });
  }, [getTopLevelSelectedIds, storeApi]);

  // 复制到内部剪贴板 + 系统剪贴板（与 useMindMapClipboard 的 Mod+C 行为对齐）
  const handleBatchCopy = useCallback(() => {
    const state = storeApi.getState();
    const ids = collectTopLevelNodeIds(state.document.root, state.selection, {
      excludeRoot: true,
    });
    if (ids.length === 0) return;
    state.copyNodes(ids);
    const nodes = ids
      .map((id) => findNodeById(state.document.root, id))
      .filter((n): n is MindMapNode => !!n);
    if (nodes.length > 0) void writeMindMapClipboard(nodes);
  }, [storeApi]);

  const handleClearSelection = useCallback(() => {
    setSelection([]);
  }, [setSelection]);

  // 多选时 document 级快捷键（退出编辑后焦点可能不在行内）
  useEffect(() => {
    if (!isMultiSelectActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;
      const isOutlineInput = target.dataset?.mmOutlineInput === 'true';
      // 搜索框等其它输入不劫持；大纲行内 input 仍走批量
      if (inEditable && !isOutlineInput) return;
      // 仅当事件来自大纲容器内，或焦点已离开可编辑区时处理
      const root = containerRef.current;
      if (root && inEditable && isOutlineInput && !root.contains(target)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSelection([]);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleBatchIndent();
        return;
      }
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleBatchOutdent();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        handleBatchDelete();
      }
    };

    globalThis.document.addEventListener('keydown', onKeyDown, true);
    return () => globalThis.document.removeEventListener('keydown', onKeyDown, true);
  }, [isMultiSelectActive, handleBatchIndent, handleBatchOutdent, handleBatchDelete, setSelection]);

  /** 行间垂直/水平导航（稳定引用；视觉列优先，CJK 混排不漂移） */
  const handleNavigate = useCallback((
    nodeId: string,
    direction: OutlineNavigateDirection,
    caretHint?: number,
  ) => {
    const list = flatNodesRef.current;
    const index = flatNodeIndexByIdRef.current.get(nodeId) ?? -1;
    if (index < 0) return;
    const focus = storeApi.getState().setFocusedNodeId;

    if (direction === 'up' || direction === 'down') {
      const target = direction === 'up' ? list[index - 1] : list[index + 1];
      if (!target) return;
      const visual = caret.getOutlineGoalVisual();
      const offset = resolveGoalEntryOffset(
        target.node.text || '',
        direction === 'up' ? 'last-line' : 'first-line',
        {
          column: caretHint ?? null,
          px: visual?.px ?? null,
          font: visual?.font ?? null,
        },
      );
      caret.requestOutlineCaret(target.id, offset);
      focus(target.id);
      return;
    }
    if (direction === 'prevEnd') {
      const prev = list[index - 1];
      if (!prev) return;
      caret.requestOutlineCaret(prev.id, (prev.node.text || '').length);
      focus(prev.id);
      return;
    }
    const next = list[index + 1];
    if (!next) return;
    caret.requestOutlineCaret(next.id, 0);
    focus(next.id);
  }, [storeApi, caret]);

  const handleZoomIn = useCallback((nodeId: string) => {
    storeApi.getState().setViewRootId(nodeId);
  }, [storeApi]);

  const handleZoomOut = useCallback(() => {
    const state = storeApi.getState();
    if (!state.viewRootId) return;
    const parent = getAncestors(state.document.root, state.viewRootId).at(-1);
    state.setViewRootId(
      parent && parent.id !== state.document.root.id ? parent.id : null,
    );
  }, [storeApi]);

  const handleOpenResourcePicker = useCallback((nodeId: string) => {
    setResourcePickerNodeId(nodeId);
  }, []);

  // Workflowy 式「幽灵新行」：点击列表底部空行在当前范围末尾新增同级
  const handleGhostRowClick = useCallback(() => {
    const state = storeApi.getState();
    const root = state.viewRootId
      ? findNodeById(state.document.root, state.viewRootId) || state.document.root
      : state.document.root;
    const newId = state.addNode(root.id, root.children.length);
    if (newId) state.setFocusedNodeId(newId);
  }, [storeApi]);

  // E01 C2.4：焦点节点子树的缩进线高亮（焦点路径）。
  // 仅焦点节点展开且有子时计算，重渲染范围限于该子树的行。
  const focusGuide = useMemo(() => {
    if (!focusedNodeId) return null;
    const entry = allFlatNodeById.get(focusedNodeId);
    if (!entry || entry.node.collapsed) return null;
    if ((entry.node.children?.length ?? 0) === 0) return null;
    const ids = new Set<string>();
    const walk = (n: MindMapNode) => {
      n.children?.forEach((child) => {
        ids.add(child.id);
        walk(child);
      });
    };
    walk(entry.node);
    return { ids, guideIndex: entry.level };
  }, [focusedNodeId, allFlatNodeById]);

  // E01 C3.1：专注模式切换不再 remount 整棵行列表（旧实现 key={viewRootId}
  // 会整树重放入场动画并重建 DOM），改为 WAAPI 播一次轻量容器过渡。
  const contentRef = useRef<HTMLDivElement | null>(null);
  const prevViewRootIdRef = useRef<string | null | undefined>(viewRootId);
  useEffect(() => {
    if (prevViewRootIdRef.current === viewRootId) return;
    prevViewRootIdRef.current = viewRootId;
    const el = contentRef.current;
    if (!el || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const durRaw = getComputedStyle(el).getPropertyValue('--mm-dur-enter').trim();
    const duration = durRaw.endsWith('ms')
      ? Number.parseFloat(durRaw)
      : durRaw.endsWith('s')
        ? Number.parseFloat(durRaw) * 1000
        : 150;
    el.animate(
      [
        { opacity: 0.35, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: Number.isFinite(duration) ? duration : 150, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }, [viewRootId]);

  const activeNode = useMemo(() => {
    if (!activeId) return null;
    return allFlatNodeById.get(String(activeId))?.node ?? null;
  }, [activeId, allFlatNodeById]);

  // 计算当前拖拽的预期层级，用于 UI 展示
  const activeFlatNode = useMemo(() =>
    activeId ? flatNodeById.get(String(activeId)) : undefined,
  [activeId, flatNodeById]);

  const overFlatNode = useMemo(() =>
    overId ? flatNodeById.get(String(overId)) : undefined,
  [overId, flatNodeById]);

  const calculateDropPosition = useCallback((event: DragOverEvent): DropPosition => {
    if (!event.over) return 'inside';

    const overRect = event.over.rect;
    const overTop = overRect?.top ?? 0;
    const overHeight = overRect?.height ?? 0;

    const activeRect = event.active.rect.current;
    const translated = (activeRect as any)?.translated;
    const pointerY = translated?.top ?? 0;
    const pointerMiddleY = pointerY + ((translated?.height ?? 0) / 2);

    const relativeY = pointerMiddleY - overTop;

    // 简化为 only before/after，通过水平拖拽决定层级
    if (relativeY < overHeight * 0.5) return 'before';
    return 'after';
  }, []);

  const [offsetLeft, setOffsetLeft] = useState(0);

  const getProjectedLevel = useCallback((
    activeNodeLevel: number,
    overNode: FlatNode,
    dropPosition: DropPosition,
    offset: number
  ) => {
    const dragDepth = Math.round(offset / LEVEL_INDENT);
    const projectedDepth = activeNodeLevel + dragDepth;

    // 确定“上一个节点”作为锚点
    // 如果是 after，锚点就是 overNode
    // 如果是 before，锚点是 overNode 的前一个节点
    let anchorNode: FlatNode | null = null;

    if (dropPosition === 'after') {
      anchorNode = overNode;
    } else {
      const overIndex = flatNodeIndexById.get(overNode.id) ?? -1;
      if (overIndex > 0) {
        anchorNode = flatNodes[overIndex - 1];
      }
    }

    // 如果没有锚点（比如插在第一个节点之前），只能是 level 0
    if (!anchorNode) return 0;

    const maxLevel = anchorNode.level + 1;
    const minLevel = 0; // 实际上可以更灵活，但 0 是安全的下限

    return Math.max(minLevel, Math.min(maxLevel, projectedDepth));
  }, [flatNodes, flatNodeIndexById]);

  const currentProjectedLevel = useMemo(() => {
    if (!activeFlatNode || !overFlatNode) return null;
    return getProjectedLevel(activeFlatNode.level, overFlatNode, dropPosition, offsetLeft);
  }, [activeFlatNode, overFlatNode, dropPosition, offsetLeft, getProjectedLevel]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveId(event.active.id);
    setOffsetLeft(0);
    // 若拖的是选中集之一，整组移动；按可见列表顺序（非点击序）
    const state = storeApi.getState();
    if (state.selection.includes(id) && state.selection.length > 1) {
      const top = collectTopLevelNodeIds(state.document.root, state.selection, {
        excludeRoot: true,
      });
      top.sort(
        (a, b) =>
          (allFlatNodeIndexByIdRef.current.get(a) ?? 0) -
          (allFlatNodeIndexByIdRef.current.get(b) ?? 0),
      );
      setDragGroupIds(top);
    } else {
      setDragGroupIds([id]);
    }
  }, [storeApi]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setOffsetLeft(event.delta.x);
  }, []);

  // 拖拽悬停折叠节点 ≈600ms 自动展开（Workflowy/Finder spring-loading），
  // 无需先放手展开再重新拖拽；skipHistory 不污染 undo 栈。
  const dragExpandRef = useRef<{ nodeId: string; timer: number } | null>(null);
  const clearDragExpandTimer = useCallback(() => {
    if (dragExpandRef.current) {
      window.clearTimeout(dragExpandRef.current.timer);
      dragExpandRef.current = null;
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverId(over?.id ?? null);
    if (over) {
      setDropPosition(calculateDropPosition(event));
    }

    const overNodeId = over ? String(over.id) : null;
    if (dragExpandRef.current?.nodeId === overNodeId) return;
    clearDragExpandTimer();
    if (!overNodeId || overNodeId === String(event.active.id)) return;
    const overNode = allFlatNodeByIdRef.current.get(overNodeId)?.node;
    if (!overNode?.collapsed || (overNode.children?.length ?? 0) === 0) return;
    dragExpandRef.current = {
      nodeId: overNodeId,
      timer: window.setTimeout(() => {
        dragExpandRef.current = null;
        const live = storeApi.getState();
        const liveNode = findNodeById(live.document.root, overNodeId);
        if (liveNode?.collapsed) {
          live.toggleCollapse(overNodeId, { skipHistory: true });
        }
      }, 600),
    };
  }, [calculateDropPosition, clearDragExpandTimer, storeApi]);

  const resolveDropTarget = useCallback((
    sourceId: string,
    targetId: string,
  ): { parentId: string; index: number } | null => {
    if (isDescendantOf(document.root, sourceId, targetId)) return null;

    const targetFlatNode = flatNodeById.get(targetId);
    const sourceFlatNode = flatNodeById.get(sourceId);
    if (!targetFlatNode || !sourceFlatNode) return null;

    const projectedLevel = getProjectedLevel(
      sourceFlatNode.level,
      targetFlatNode,
      dropPosition,
      offsetLeft
    );

    let anchorNode: FlatNode | null = null;
    if (dropPosition === 'after') {
      anchorNode = targetFlatNode;
    } else {
      const targetIndex = flatNodeIndexById.get(targetId) ?? -1;
      if (targetIndex > 0) {
        anchorNode = flatNodes[targetIndex - 1];
      }
    }

    // 专注模式下 level0 落点应是 displayRoot，而非整棵文档的 root
    const scopeRootId = displayRoot.id;

    if (!anchorNode) {
      return { parentId: scopeRootId, index: 0 };
    }

    if (projectedLevel === anchorNode.level + 1) {
      return { parentId: anchorNode.id, index: 0 };
    }
    if (projectedLevel === anchorNode.level) {
      if (anchorNode.parentId) {
        return { parentId: anchorNode.parentId, index: anchorNode.indexInParent + 1 };
      }
      // 锚点即专注根行：同级插入到专注根下
      if (anchorNode.id === scopeRootId || anchorNode.level === 0) {
        return { parentId: scopeRootId, index: 0 };
      }
      return null;
    }

    let current: FlatNode | undefined = anchorNode;
    while (current && current.level > projectedLevel) {
      const parent = current?.parentId ? flatNodeById.get(current.parentId) : undefined;
      current = parent;
    }

    if (current && current.parentId) {
      return { parentId: current.parentId, index: current.indexInParent + 1 };
    }
    if (current && (current.level === 0 || current.id === scopeRootId)) {
      return {
        parentId: scopeRootId,
        index: current.id === scopeRootId ? 0 : current.indexInParent + 1,
      };
    }
    return null;
  }, [document.root, displayRoot.id, flatNodes, flatNodeById, flatNodeIndexById, dropPosition, offsetLeft, getProjectedLevel]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const groupIds = dragGroupIds.length > 0 ? dragGroupIds : [String(active.id)];

    clearDragExpandTimer();
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    setDragGroupIds([]);

    if (!over || active.id === over.id) return;

    const sourceId = String(active.id);
    const targetId = String(over.id);
    const drop = resolveDropTarget(sourceId, targetId);
    if (!drop) return;

    const movingIds = groupIds.filter((id) => id !== document.root.id);
    if (movingIds.length === 0) return;

    // 若目标在移动集内，跳过
    if (movingIds.includes(targetId)) return;

    if (moveNodes(movingIds, drop.parentId, drop.index)) {
      setSelection(movingIds);
    }
  }, [dragGroupIds, resolveDropTarget, document.root, moveNodes, setSelection, clearDragExpandTimer]);

  const handleDragCancel = useCallback(() => {
    clearDragExpandTimer();
    setActiveId(null);
    setOverId(null);
    setDragGroupIds([]);
  }, [clearDragExpandTimer]);

  // 卸载兜底：拖拽悬停展开的 pending 定时器不得跨实例存活
  useEffect(() => () => clearDragExpandTimer(), [clearDragExpandTimer]);

  // 边缘自动滚动：阈值稍大、加速度稍高，长列表拖拽到视口边缘时提速更快
  const outlineAutoScroll = useMemo(
    () => ({
      ...SHELL_SAFE_AUTO_SCROLL,
      acceleration: 14,
      threshold: { x: 0.12, y: 0.22 },
    }),
    [],
  );

  // Empty state handling
  const hasOnlyRoot = document.root.children.length === 0;

  return (
    <div
      ref={containerRef}
      className="h-full w-full flex flex-col bg-[var(--mm-bg)] relative"
      onClick={(e) => {
        // 点在行外空白（含 ScrollArea padding）时清多选
        const target = e.target as HTMLElement;
        if (target.closest('[data-node-id]')) return;
        if (target.closest('.outline-multiselect-bar')) return;
        if (target.closest('.outline-breadcrumb')) return;
        setSelection([]);
      }}
    >
      <OutlineBreadcrumb
        path={breadcrumbPath}
        onNavigate={setViewRootId}
      />

      <CustomScrollArea
        className="flex-1"
        viewportClassName="p-4 md:px-12 md:py-8"
        viewportRef={setScrollViewport}
      >
        <DndContext
          sensors={sensors}
          autoScroll={outlineAutoScroll}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        >
          <SortableContext items={nodeIds} strategy={verticalListSortingStrategy}>
            <div
              ref={contentRef}
              className={cn(
                "max-w-3xl mx-auto pb-32 outline-content-enter",
                // 千级节点性能：视口外行跳过渲染；拖拽期间关闭以保测量精度
                !activeId && "outline-cv"
              )}
              onClick={(e) => {
                if (e.target === e.currentTarget) setSelection([]);
              }}
            >
              {flatNodes.map((flatNode, index) => (
                <SortableOutlineNode
                  key={flatNode.id}
                  flatNode={flatNode}
                  isRoot={flatNode.level === 0}
                  isDropTarget={overId === flatNode.id}
                  dropPosition={dropPosition}
                  isBeingDragged={activeId === flatNode.id}
                  projectedLevel={overId === flatNode.id ? currentProjectedLevel : null}
                  isEntering={enteringNodeIds.has(flatNode.id)}
                  isExiting={agentExitingIds.has(flatNode.id)}
                  isUpdated={agentUpdatedIds.has(flatNode.id)}
                  isSelected={selectionSet.has(flatNode.id)}
                  isMultiSelectActive={isMultiSelectActive}
                  isSearchMatch={searchResultSet.has(flatNode.id)}
                  isCurrentSearchMatch={currentSearchResultId === flatNode.id}
                  searchQuery={searchQuery}
                  nextVisibleNodeId={flatNodes[index + 1]?.id ?? null}
                  prevVisibleNodeId={index > 0 ? flatNodes[index - 1].id : null}
                  focusGuideIndex={
                    focusGuide && focusGuide.ids.has(flatNode.id)
                      ? focusGuide.guideIndex
                      : null
                  }
                  keymap={keymap}
                  descriptionPreview={descriptionPreview}
                  onRowSelect={handleRowSelect}
                  onNavigate={handleNavigate}
                  onZoomIn={handleZoomIn}
                  onZoomOut={handleZoomOut}
                  onOpenResourcePicker={handleOpenResourcePicker}
                  onBatchIndent={handleBatchIndent}
                  onBatchOutdent={handleBatchOutdent}
                  onBatchDelete={handleBatchDelete}
                />
              ))}

              {/* Workflowy 式幽灵新行：点击在当前范围末尾新增（拖拽/背诵时隐藏） */}
              {!hasOnlyRoot && !reciteMode && !activeId && (
                <div
                  className="outline-ghost-row"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleGhostRowClick();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleGhostRowClick();
                    }
                  }}
                  aria-label={t('outline.ghostNewLine', { defaultValue: '新增一行' })}
                >
                  <span className="outline-ghost-bullet" aria-hidden="true" />
                  <span className="outline-ghost-label">
                    {t('outline.ghostNewLine', { defaultValue: '新增一行' })}
                  </span>
                </div>
              )}

              {/* Click empty area to add node if empty */}
              {hasOnlyRoot && (
                <div
                  className="outline-empty-action"
                  onClick={() => {
                    const newNodeId = addNode(document.root.id, 0);
                    if (newNodeId) {
                      setFocusedNodeId(newNodeId);
                    }
                  }}
                >
                  <span className="outline-empty-icon" aria-hidden="true">
                    <ListBullets size={28} weight="light" />
                  </span>
                  <p>
                    {t('outline.emptyHint', {
                      defaultValue: '按 Enter 开始输入第一个节点',
                    })}
                  </p>
                </div>
              )}
            </div>
          </SortableContext>

          {createPortal(
            <DragOverlay dropAnimation={dropAnimationConfig}>
              {activeNode && (
                <OutlineDragOverlayContent
                  node={activeNode}
                  dragCount={dragGroupIds.length > 1 ? dragGroupIds.length : 1}
                />
              )}
            </DragOverlay>,
            globalThis.document.body
          )}
        </DndContext>
      </CustomScrollArea>

      {isMultiSelectActive && (
        <OutlineMultiselectBar
          count={selection.length}
          onComplete={handleBatchComplete}
          onIndent={handleBatchIndent}
          onOutdent={handleBatchOutdent}
          onCopy={handleBatchCopy}
          onCollapse={handleBatchCollapse}
          onDelete={handleBatchDelete}
          onClear={handleClearSelection}
        />
      )}

      <MindMapResourcePicker
        isOpen={!!resourcePickerNodeId}
        nodeId={resourcePickerNodeId || ''}
        existingRefs={resourcePickerNodeId ? findNodeById(document.root, resourcePickerNodeId)?.refs : undefined}
        onSelect={(ref) => {
          if (resourcePickerNodeId) addNodeRef(resourcePickerNodeId, ref);
        }}
        onClose={() => setResourcePickerNodeId(null)}
      />
    </div>
  );
});

OutlineView.displayName = 'OutlineView';
