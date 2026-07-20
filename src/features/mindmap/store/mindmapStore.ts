/**
 * 统一的思维导图状态管理（替代旧 useMindMapStore）
 * 
 * 整合：文档状态、UI状态、历史记录、API调用
 */

import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapDocument, MindMapNode, MindMapNodeRef, MindMapAssociation, LayoutDirection, EdgeType, MindMapRenderConfig, LayoutConfig, UpdateNodeParams, BlankRange } from '../types';
import * as api from '../api/mindmapApi';
import type { VfsMindMap, MindMapViewType } from '../types';
import { PresetRegistry } from '../registry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById, findParentNode, isDescendantOf } from '../utils/node/find';
import {
  mergeRanges,
  validateRanges,
  remapRangesAfterTextEdit,
} from '../utils/node/blankRanges';
import {
  collectTopLevelNodeIds,
  flattenVisibleNodes,
  traverseDFS,
} from '../utils/node/traverse';
import { DEFAULT_LAYOUT_CONFIG } from '../constants';
import { markdownListToNodes } from '../utils/pasteMarkdown';
import {
  buildCompletedVisibilityIndex,
  resolveVisibleIdFromIndex,
} from '../utils/hideCompleted';
import {
  collectSearchPathIds,
  flattenOutlineTree,
  resolveSearchPathIds,
  searchMindMapNodeIds,
  type SearchOptions,
} from '../utils/searchFilter';
import { mergeMindMapViewport } from '../utils/viewport';

/** ACR R1-11：agentEnteringIds 使用 Set，需启用 Immer MapSet 插件 */
enableMapSet();

/** 大纲 / 导图双模视口状态（内存态，切视图时保留） */
export interface MindMapViewports {
  outline?: { scrollTop: number };
  mindmap?: { x: number; y: number; zoom: number };
}

export type MindMapViewportView = keyof MindMapViewports;

/** store.mergeWithPrevious 返回值（文档已在 store 内更新） */
export interface MergeWithPreviousResult {
  mergedIntoId: string;
  cursorOffset: number;
}

/**
 * U3/U6：history 条目附带的轻量 UI 快照（变更前的焦点/选中/专注根）。
 * 仅存引用，不深拷贝；undo/redo 恢复时会对新树做存在性校验。
 */
export interface MindMapHistoryUiSnapshot {
  focusedNodeId: string | null;
  selection: string[];
  viewRootId: string | null;
}

/** 历史条目：结构共享的文档引用 + 变更前 UI 快照 */
export interface MindMapHistoryEntry {
  document: MindMapDocument;
  ui?: MindMapHistoryUiSnapshot;
}

// ============================================================================
// M-070: 前端节点深度/数量限制（与后端保持一致）
// ============================================================================

export const MAX_MINDMAP_DEPTH = 100;
export const MAX_MINDMAP_NODES = 10000;

function getNodeDepth(root: MindMapNode, targetId: string, depth = 0): number {
  if (root.id === targetId) return depth;
  for (const child of root.children) {
    const found = getNodeDepth(child, targetId, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

function countNodes(node: MindMapNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function getSubtreeHeight(node: MindMapNode): number {
  let height = 0;
  for (const child of node.children) {
    height = Math.max(height, 1 + getSubtreeHeight(child));
  }
  return height;
}

function buildNodeIndex(root: MindMapNode): {
  nodeById: Map<string, MindMapNode>;
  parentById: Map<string, MindMapNode | null>;
  depthById: Map<string, number>;
  indexById: Map<string, number>;
} {
  const nodeById = new Map<string, MindMapNode>();
  const parentById = new Map<string, MindMapNode | null>();
  const depthById = new Map<string, number>();
  const indexById = new Map<string, number>();
  const stack: Array<{
    node: MindMapNode;
    parent: MindMapNode | null;
    depth: number;
    index: number;
  }> = [
    { node: root, parent: null, depth: 0, index: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeById.set(current.node.id, current.node);
    parentById.set(current.node.id, current.parent);
    depthById.set(current.node.id, current.depth);
    indexById.set(current.node.id, current.index);
    for (let i = current.node.children.length - 1; i >= 0; i--) {
      stack.push({
        node: current.node.children[i],
        parent: current.node,
        depth: current.depth + 1,
        index: i,
      });
    }
  }
  return { nodeById, parentById, depthById, indexById };
}

function collectNodeAndDescendantIds(root: MindMapNode, nodeIds: readonly string[]): Set<string> {
  const nodeById = buildNodeIndex(root).nodeById;
  const result = new Set<string>();
  const stack = nodeIds.flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [node] : [];
  });
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (result.has(node.id)) continue;
    result.add(node.id);
    stack.push(...node.children);
  }
  return result;
}

function removeNodesById(root: MindMapNode, ids: ReadonlySet<string>): void {
  root.children = root.children.filter((child) => !ids.has(child.id));
  for (const child of root.children) removeNodesById(child, ids);
}

/** 节点删除时级联清理关联线 */
function pruneAssociationsForRemovedNodes(
  document: MindMapDocument,
  removedIds: ReadonlySet<string>,
): void {
  if (!document.associations?.length) return;
  document.associations = document.associations.filter(
    (a) => !removedIds.has(a.source) && !removedIds.has(a.target),
  );
  if (document.associations.length === 0) {
    delete document.associations;
  }
}

/**
 * 节点从树中移除后的统一后置清理（deleteNodes / cutNodes / agentDeleteNode / merge 共用）：
 * 关联线剪枝、焦点回退、编辑态退出、选中/锚点过滤、viewRootId 失效退出。
 * 必须在节点已从 state.document 移除之后调用。
 */
function afterRemoveNodes(
  state: MindMapStoreState,
  removedIds: ReadonlySet<string>,
  fallbackFocusId?: string,
): void {
  pruneAssociationsForRemovedNodes(state.document, removedIds);
  if (!state.focusedNodeId || removedIds.has(state.focusedNodeId)) {
    state.focusedNodeId = fallbackFocusId ?? state.document.root.id;
  }
  if (state.editingNodeId && removedIds.has(state.editingNodeId)) {
    state.editingNodeId = null;
  }
  if (state.editingNoteNodeId && removedIds.has(state.editingNoteNodeId)) {
    state.editingNoteNodeId = null;
  }
  state.selection = state.selection.filter((id) => !removedIds.has(id));
  if (state.selectionAnchorId && removedIds.has(state.selectionAnchorId)) {
    state.selectionAnchorId = null;
  }
  // 专注根被删（或其祖先被删导致不可达）时退出专注，避免视图指向已删节点
  if (
    state.viewRootId &&
    (removedIds.has(state.viewRootId) ||
      !findNodeById(state.document.root, state.viewRootId))
  ) {
    state.viewRootId = null;
  }
}

function findAssociationPair(
  associations: MindMapAssociation[] | undefined,
  source: string,
  target: string,
): MindMapAssociation | undefined {
  if (!associations?.length) return undefined;
  return associations.find(
    (a) =>
      (a.source === source && a.target === target) ||
      (a.source === target && a.target === source),
  );
}

function createDefaultDocument(title?: string): MindMapDocument {
  const resolvedTitle = title || i18next.t('placeholder.root', { ns: 'mindmap' });
  return {
    version: '1.0',
    root: {
      id: `root_${nanoid(8)}`,
      text: resolvedTitle,
      children: [],
    },
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Store 状态定义
// ============================================================================

/**
 * A6-24: 保存冲突时暂存的本地未保存编辑快照，供用户"恢复我的修改"。
 * 冲突分支会先重载服务端版本，再把冲突前的本地文档存入此快照。
 */
export interface MindMapConflictSnapshot {
  mindmapId: string;
  document: MindMapDocument;
  currentView: MindMapViewType;
  focusedNodeId: string | null;
  layoutId: string;
  layoutDirection: LayoutDirection;
  styleId: string;
  edgeType: EdgeType;
}

export interface MindMapStoreState {
  // 元数据
  mindmapId: string | null;
  metadata: VfsMindMap | null;

  // 文档状态
  document: MindMapDocument;
  currentView: MindMapViewType;
  focusedNodeId: string | null;
  editingNodeId: string | null; // 当前正在编辑的节点 ID
  editingNoteNodeId: string | null; // 当前正在编辑备注的节点 ID
  selection: string[];
  /** Shift range selection anchor, shared across outline remounts/view switches. */
  selectionAnchorId: string | null;

  /**
   * ACR R1-11 / R2-02：Agent 演出入场节点（瞬态，不进 history/draft/持久化）。
   * 由 mindmapDriver mark/clear；画布读此集合追加 `agent-entering` className；
   * 大纲合并进 `isEntering`（不仅依赖本地 prev/next 差分）。
   */
  agentEnteringIds: Set<string>;
  markAgentEntering: (ids: string[]) => void;
  clearAgentEntering: (ids: string[]) => void;

  /**
   * ACR R2-02：Agent 批量演出结束时请求一次 fitView（画布订阅 nonce 变化）。
   * 不进 history / 不标脏。
   */
  agentFitViewNonce: number;
  requestAgentFitView: () => void;

  /**
   * ACR R1-11：agent 专用薄封装（skipHistory，不污染用户 undo 栈）。
   * 既有 addNode/deleteNode/moveNode 签名不变。
   */
  agentAddNode: (parentId: string, index?: number) => string;
  agentAddSubtree: (
    parentId: string,
    data: Omit<MindMapNode, 'id'>,
    index?: number,
  ) => string;
  agentDeleteNode: (nodeId: string) => void;
  agentMoveNode: (nodeId: string, newParentId: string, index: number) => boolean;
  /** 将完整子树插入 parent（delete 逆操作 / add 带 children 时用） */
  agentInsertSubtree: (parentId: string, node: MindMapNode, index?: number) => void;

  // 渲染配置状态
  layoutId: string;           // 当前布局ID，默认 'tree'
  layoutDirection: LayoutDirection; // 布局方向，默认 'right'
  styleId: string;            // 样式主题ID，默认 'default'
  edgeType: EdgeType;         // 边类型，默认 'bezier'
  measuredNodeHeights: Record<string, number>;

  // 历史记录（条目含文档引用与变更前 UI 快照）
  history: {
    past: MindMapHistoryEntry[];
    future: MindMapHistoryEntry[];
  };

  // 保存状态
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: number | null;
  /** 文档版本计数器（每次变更递增），用于 save 完成后的快速脏检查 */
  _documentVersion: number;
  /** 加载请求序列号，防止快速切换时旧请求覆盖新数据 (M-066) */
  _loadSeq: number;

  // 背诵模式
  reciteMode: boolean;
  revealedBlanks: Record<string, Record<number, boolean>>;
  setReciteMode: (enabled: boolean) => void;
  revealBlank: (nodeId: string, rangeIndex: number) => void;
  revealAllBlanks: () => void;
  resetAllBlanks: () => void;
  addBlankRange: (nodeId: string, range: BlankRange) => void;
  removeBlankRange: (nodeId: string, rangeIndex: number) => void;
  clearNodeBlanks: (nodeId: string) => void;

  /** 大纲/画布：隐藏已完成且无未完成后代的节点（内存 UI 状态） */
  hideCompleted: boolean;
  setHideCompleted: (hide: boolean) => void;

  /**
   * 双模共享的分支专注根：仅渲染该节点子树（null = 整棵树）。
   * 大纲与画布共用，切换视图不清除。
   */
  viewRootId: string | null;
  setViewRootId: (nodeId: string | null) => void;

  // 搜索状态
  searchQuery: string;
  /** W08：当前搜索匹配选项（大小写敏感/全词）；文档变更重算结果时沿用 */
  searchOptions: SearchOptions;
  searchResults: string[];
  currentSearchIndex: number;
  /** 为 true 时 UI 应按搜索结果过滤视图（search 仍只维护结果列表） */
  searchFilterMode: boolean;
  setSearchFilterMode: (enabled: boolean) => void;

  /** 双模视口：切视图时保留各自滚动/平移缩放 */
  viewports: MindMapViewports;
  setViewViewport: {
    (view: 'outline', partial: Partial<{ scrollTop: number }>): void;
    (view: 'mindmap', partial: Partial<{ x: number; y: number; zoom: number }>): void;
  };

  // 导出状态
  isExporting: boolean;
  exportProgress: number;
  setIsExporting: (isExporting: boolean) => void;
  setExportProgress: (progress: number) => void;

  clipboard: {
    nodes: MindMapNode[];
    sourceOperation: 'copy' | 'cut';
    /** C4：写入内部剪贴板的时间戳（ms），供与系统剪贴板比较新旧 */
    copiedAt?: number;
  } | null;

  // 初始化/加载
  /**
   * @param opts.preserveViewports 为 true 时保留 viewports / currentView
   *（供外部 watch 检测到变更后的静默重载，避免视口跳回默认）。
   */
  loadMindMap: (
    mindmapId: string,
    opts?: { preserveViewports?: boolean },
  ) => Promise<void>;
  createNewMindMap: (title: string, folderId?: string) => Promise<string>;
  reset: () => void;
  /**
   * 清全部 pending 定时器（draft/save/retry/measured），幂等。
   * 宿主替换 store 实例（resourceId 切换 / ErrorBoundary 重建）前调用，
   * 防止旧实例的 debounce 保存写到已卸载的文档。不重置状态字段。
   */
  destroy: () => void;
  /** 公开草稿清除：删除当前导图的 localStorage/sessionStorage 草稿（Discard 关闭用） */
  clearDraft: () => void;

  // 文档操作
  setDocument: (doc: MindMapDocument) => void;
  setCurrentView: (view: MindMapViewType) => void;
  setFocusedNodeId: (nodeId: string | null) => void;
  setEditingNodeId: (nodeId: string | null) => void;
  setEditingNoteNodeId: (nodeId: string | null) => void;
  setSelection: (nodeIds: string[]) => void;
  setSelectionAnchorId: (nodeId: string | null) => void;
  /**
   * 全选当前视图可见节点（尊重 viewRoot / 折叠 / 搜索过滤 / 隐藏已完成）。
   * 不含视图根自身；纯 UI 状态，不进 history、不标脏。
   */
  selectAllVisible: () => void;

  // 节点操作
  updateNode: (
    nodeId: string,
    patch: UpdateNodeParams,
    options?: {
      skipHistory?: boolean;
      skipSave?: boolean;
      markDirty?: boolean;
      /** 文本变更时保留 blankedRanges（选区挖空前先 commit 文本用） */
      preserveBlankedRanges?: boolean;
      /**
       * U5：历史合并键。text/note/style 补丁默认按「节点+字段」自动合并
       * （时间窗内同键连续变更只占一个 undo 步）；显式传 null 可禁用本次合并。
       */
      coalesceKey?: string | null;
    }
  ) => void;
  addNode: (parentId: string, index?: number) => string;
  /**
   * 在各节点原位置之后插入其深拷贝（全部重新生成 id；style/refs/blankedRanges 深拷贝）。
   * 传入集合先做祖先/后代去重，仅复制顶层节点。
   * @returns 新顶层节点 id 数组（与去重后的输入顺序一致）；无可复制节点或超限时返回 null。
   * 单 history 步；聚焦第一个新节点。
   */
  duplicateNodes: (nodeIds: string[]) => string[] | null;
  deleteNode: (nodeId: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  moveNode: (nodeId: string, newParentId: string, index: number) => void;
  moveNodes: (nodeIds: string[], newParentId: string, index: number) => boolean;
  toggleCollapse: (
    nodeId: string,
    options?: {
      skipHistory?: boolean;
      skipSave?: boolean;
      markDirty?: boolean;
    }
  ) => void;
  /** 折叠全部（根节点保持展开） */
  collapseAll: () => void;
  /** 展开全部 */
  expandAll: () => void;
  /**
   * 折叠整个子树（nodeId 及其所有有子节点的后代），单 history 步。
   * nodeId 为文档根时根自身保持展开。替代 UI 层 forEach toggleCollapse 拼事务。
   */
  collapseSubtree: (nodeId: string) => void;
  /** 展开整个子树（nodeId 及其所有后代），单 history 步。 */
  expandSubtree: (nodeId: string) => void;
  /**
   * 折叠到指定深度（0=根）。
   * maxDepth=N：深度 < N 展开，深度 >= N 且有子节点则折叠。
   * 例：maxDepth=1 只展开根的直接子，更深全折叠。
   */
  collapseToDepth: (maxDepth: number) => void;
  indentNode: (nodeId: string) => void;
  outdentNode: (nodeId: string) => void;
  indentNodes: (nodeIds: string[]) => void;
  outdentNodes: (nodeIds: string[]) => void;

  /**
   * Workflowy 惯例：当前节点保留光标前文本，光标后文本成为下方新同级节点；子树留在原节点。
   * @returns 新节点 id，失败返回 null
   */
  splitNode: (
    nodeId: string,
    cursorOffset: number,
    textOverride?: string
  ) => string | null;
  /**
   * 行首合并到上一同级（无同级则上一可见节点）；根不可合并。
   * @param scopeRootId 分支专注（viewRootId）场景传入专注根：
   *「上一可见」在该子树的 flattenVisibleNodes 内解析，不会合并到专注范围外的节点。
   * @returns 合并目标与光标位置，供 UI 恢复
   */
  mergeWithPrevious: (
    nodeId: string,
    textOverride?: string,
    scopeRootId?: string,
  ) => MergeWithPreviousResult | null;
  /** 行末 Forward Delete：把下一可见节点合并进当前节点。 */
  mergeNextIntoCurrent: (
    nodeId: string,
    textOverride?: string,
    nextVisibleNodeId?: string | null,
  ) => MergeWithPreviousResult | null;
  /** 批量切换完成状态（一次 history） */
  toggleCompleted: (nodeIds: string[]) => void;

  // 节点资源引用
  addNodeRef: (nodeId: string, ref: MindMapNodeRef) => void;
  removeNodeRef: (nodeId: string, sourceId: string) => void;

  // 跨分支关联线（Xmind 式「关联」）
  addAssociation: (source: string, target: string, label?: string) => string | null;
  updateAssociationLabel: (id: string, label: string) => void;
  removeAssociation: (id: string) => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /**
   * P2：全图查找替换（默认大小写不敏感、含备注）。
   * @param options.nodeIds 限定只替换这些节点（精确匹配，不含后代）
   * @returns 实际发生替换的节点数；0 表示未产生 history 条目
   */
  replaceInMindMap: (
    query: string,
    replacement: string,
    options?: {
      nodeIds?: string[];
      caseSensitive?: boolean;
      includeNotes?: boolean;
    }
  ) => number;

  // 搜索
  /** W08 契约：options 可选（大小写敏感/全词匹配），缺省行为与旧版一致 */
  search: (query: string, options?: SearchOptions) => void;
  nextSearchResult: () => void;
  prevSearchResult: () => void;
  clearSearch: () => void;
  expandToNode: (
    nodeId: string,
    options?: {
      silent?: boolean;
    }
  ) => void;

  copyNodes: (nodeIds: string[]) => void;
  cutNodes: (nodeIds: string[]) => void;
  /**
   * 粘贴内部剪贴板。
   * @param mode 'child'（默认）贴为 target 子节点；'sibling-after' 贴到 target 后面的同级位置
   *（target 为根时自动回退为 child）。
   */
  pasteNodes: (targetId: string, mode?: 'child' | 'sibling-after') => void;
  /** 将普通多行文本作为同级子节点一次性粘贴（单 history）。 */
  pasteTextChildren: (targetId: string, lines: string[]) => void;
  /**
   * 将 Markdown 列表解析为层级森林一次 undo 粘贴。
   * @param options.position 'child'（默认）贴为 targetId 的子节点；
   * 'sibling-after' 贴到 targetId 之后的同级位置（targetId 为根时回退为 child）。
   * @param options.currentText 同一事务内先把 targetId 标题更新为该值（未保存草稿）。
   */
  pasteMarkdownChildren: (
    targetId: string,
    markdown: string,
    options?: { currentText?: string; position?: 'child' | 'sibling-after' },
  ) => void;

  // 保存
  /** 将当前脏文档刷新到后端；返回本次保存是否成功。 */
  /** source 标记保存来源：防抖自动保存传 'auto'，显式保存缺省 'manual'（后端按来源分别做版本合并窗口） */
  save: (options?: { source?: 'auto' | 'manual' }) => Promise<boolean>;
  markDirty: () => void;
  /** M-069: 同步写入 localStorage 草稿，用于组件卸载/关闭时防止异步 save 未完成导致丢失 */
  saveDraftSync: () => void;

  // A6-24: 保存冲突时暂存的本地编辑快照 + 恢复/忽略入口
  conflictSnapshot: MindMapConflictSnapshot | null;
  /** 把暂存的本地快照重新应用为当前文档（标脏，下次保存以最新基线覆盖服务端） */
  restoreConflictSnapshot: () => void;
  /** 放弃暂存的本地快照（采用已重载的服务端版本） */
  dismissConflictSnapshot: () => void;

  // 布局和样式切换
  setLayoutId: (layoutId: string) => void;
  setLayoutDirection: (direction: LayoutDirection) => void;
  setStyleId: (styleId: string) => void;
  setEdgeType: (edgeType: EdgeType) => void;
  setMeasuredNodeHeight: (nodeId: string, height: number) => void;
  applyPreset: (presetId: string) => void;
  getRenderConfig: () => MindMapRenderConfig;

  // ReactFlow 实例注册（用于图片导出）
  _reactFlowGetter: (() => { getNodes: () => unknown[] }) | null;
  setReactFlowGetter: (getter: (() => { getNodes: () => unknown[] }) | null) => void;
}

const MAX_HISTORY = 50;
/** U5：同一 coalesceKey 在该时间窗内的连续变更合并为一个 undo 步 */
export const HISTORY_COALESCE_WINDOW_MS = 800;
const DRAFT_KEY_PREFIX = 'mindmap:draft:';

interface MindMapDraftPayload {
  mindmapId: string;
  document: MindMapDocument;
  currentView: MindMapViewType;
  focusedNodeId: string | null;
  savedAt: string;
  layoutId?: string;
  layoutDirection?: LayoutDirection;
  styleId?: string;
  edgeType?: EdgeType;
}

/** 访问 storage 本身也可能抛 SecurityError（隐私模式等），统一吞掉 */
const getDraftStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const getDraftSessionStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const getDraftKey = (mindmapId: string): string => `${DRAFT_KEY_PREFIX}${mindmapId}`;

const readDraftFromStorage = (
  storage: Storage | null,
  mindmapId: string,
): MindMapDraftPayload | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(getDraftKey(mindmapId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MindMapDraftPayload;
    if (!parsed?.document?.root?.id || !Array.isArray(parsed.document.root.children)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

/**
 * 读取草稿：localStorage 与 sessionStorage（写失败时的降级目标）都读，
 * 取 savedAt 更新的一份——否则降级写入的新草稿会被旧的 localStorage 草稿盖掉。
 */
const readDraft = (mindmapId: string): MindMapDraftPayload | null => {
  const local = readDraftFromStorage(getDraftStorage(), mindmapId);
  const session = readDraftFromStorage(getDraftSessionStorage(), mindmapId);
  if (!local) return session;
  if (!session) return local;
  const localAt = Date.parse(local.savedAt || '');
  const sessionAt = Date.parse(session.savedAt || '');
  if (Number.isNaN(sessionAt)) return local;
  if (Number.isNaN(localAt)) return session;
  return sessionAt > localAt ? session : local;
};

const writeDraft = (payload: MindMapDraftPayload): void => {
  const storage = getDraftStorage();
  const key = getDraftKey(payload.mindmapId);
  const serialized = JSON.stringify(payload);
  if (storage) {
    try {
      storage.setItem(key, serialized);
      // 主通道成功后清掉降级副本，避免残留旧 sessionStorage 草稿参与新旧比较
      try {
        getDraftSessionStorage()?.removeItem(key);
      } catch {
        // ignore
      }
      return;
    } catch (error) {
      console.error('[MindMapStore] Failed to write draft to localStorage:', error);
    }
  }
  // 尝试降级到 sessionStorage
  try {
    const session = getDraftSessionStorage();
    if (!session) throw new Error('sessionStorage unavailable');
    session.setItem(key, serialized);
  } catch (sessionError) {
    console.error('[MindMapStore] Failed to write draft to sessionStorage as well:', sessionError);
    // 打破用户的安全幻觉，通知用户草稿保存失败
    showGlobalNotification('error', i18next.t('mindmap:store.draftSaveFailed'));
  }
};

const removeDraftFromStorage = (mindmapId: string): void => {
  const key = getDraftKey(mindmapId);
  try {
    getDraftStorage()?.removeItem(key);
  } catch {
    // ignore
  }
  try {
    getDraftSessionStorage()?.removeItem(key);
  } catch {
    // ignore
  }
};

// ============================================================================
// Store 创建
// ============================================================================

export type MindMapStoreApi = StoreApi<MindMapStoreState>;

export function createMindMapStore(): MindMapStoreApi {
  return createStore<MindMapStoreState>()(
    immer((set, get) => {
    let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retrySaveTimer: ReturnType<typeof setTimeout> | null = null;
    /** save() 在保存中被调用时置位，当前保存结束后自动补一次保存（可见性 flush 不再空跑） */
    let pendingSaveRequested = false;
    /** 非结构性保存失败的自动重试计数（成功或用户新编辑周期后清零） */
    let saveRetryCount = 0;
    const MAX_SAVE_AUTO_RETRIES = 3;
    const SAVE_RETRY_BASE_DELAY_MS = 5000;
    let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
    let measuredFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const measuredHeightsQueue = new Map<string, number>();
    const lastDraftVersionByMindmap = new Map<string, number>();
    /**
     * U5：最近一次进入 history 的合并键与时间。同键且在时间窗内的下一次变更
     * 不再 pushHistory（沿用上一个快照），使连续打字/调样式只占一个 undo 步。
     */
    let lastCoalesce: { key: string; at: number } | null = null;

    const flushMeasuredNodeHeights = () => {
      if (measuredHeightsQueue.size === 0) return;
      const entries = Array.from(measuredHeightsQueue.entries());
      measuredHeightsQueue.clear();

      set((state) => {
        for (const [nodeId, height] of entries) {
          const prev = state.measuredNodeHeights[nodeId];
          if (prev && Math.abs(prev - height) < 1) continue;
          state.measuredNodeHeights[nodeId] = height;
        }
      });
    };

    const persistDraftNow = (force = false) => {
      const s = get();
      if (!s.isDirty || !s.mindmapId) return;

      const lastVersion = lastDraftVersionByMindmap.get(s.mindmapId);
      if (!force && lastVersion === s._documentVersion) return;

      const draft = buildDraftPayload();
      if (!draft) return;
      writeDraft(draft);
      lastDraftVersionByMindmap.set(s.mindmapId, s._documentVersion);
    };

    const scheduleDraftPersist = () => {
      if (draftPersistTimer) {
        clearTimeout(draftPersistTimer);
      }
      draftPersistTimer = setTimeout(() => {
        draftPersistTimer = null;
        persistDraftNow();
      }, 240);
    };

    const clearPendingTimers = () => {
      if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
      }
      if (retrySaveTimer) {
        clearTimeout(retrySaveTimer);
        retrySaveTimer = null;
      }
      saveRetryCount = 0;
      if (draftPersistTimer) {
        clearTimeout(draftPersistTimer);
        draftPersistTimer = null;
      }
      if (measuredFlushTimer) {
        clearTimeout(measuredFlushTimer);
        measuredFlushTimer = null;
      }
      measuredHeightsQueue.clear();
      lastCoalesce = null;
    };

    /** 捕获变更前的轻量 UI 快照（存引用，不深拷贝） */
    const captureUiSnapshot = (s: MindMapStoreState): MindMapHistoryUiSnapshot => ({
      focusedNodeId: s.focusedNodeId,
      selection: s.selection,
      viewRootId: s.viewRootId,
    });

    const pushHistory = (doc: MindMapDocument, ui?: MindMapHistoryUiSnapshot) => {
      set((state) => {
        // ★ 性能：store 经 immer 中间件，document 是 frozen 不可变树，
        // 每次 mutation 产生结构共享的新树。历史栈直接存引用即可，
        // 全量深克隆（旧实现）在大导图上每次编辑都有明显开销且浪费内存。
        state.history.past.push({ document: doc, ui });
        if (state.history.past.length > MAX_HISTORY) {
          state.history.past.shift();
        }
        state.history.future = [];
      });
    };

    /** 构建草稿 payload（含布局字段），避免 7 处 writeDraft 重复 */
    const buildDraftPayload = (overrides?: Partial<MindMapDraftPayload>): MindMapDraftPayload | null => {
      const s = get();
      if (!s.mindmapId) return null;
      return {
        mindmapId: s.mindmapId,
        // frozen 树可直接被 JSON.stringify 序列化写入草稿，无需先深克隆
        document: overrides?.document ?? s.document,
        currentView: overrides?.currentView ?? s.currentView,
        focusedNodeId: overrides?.focusedNodeId ?? s.focusedNodeId,
        savedAt: new Date().toISOString(),
        layoutId: s.layoutId,
        layoutDirection: s.layoutDirection,
        styleId: s.styleId,
        edgeType: s.edgeType,
      };
    };

    const debounceSave = () => {
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      if (retrySaveTimer) {
        clearTimeout(retrySaveTimer);
        retrySaveTimer = null;
      }
      // 用户新编辑触发的保存周期：重置自动重试计数
      saveRetryCount = 0;
      saveDebounceTimer = setTimeout(() => {
        void get().save({ source: 'auto' });
      }, 1500);
    };

    /**
     * D1：布局/主题等渲染配置变更。不进 history（撤销栈只管文档结构），
     * 但必须标脏 + 草稿落盘 + 调度保存——save() 会把当前布局字段拼进
     * meta.renderConfig，纯改布局后关闭不再丢失。
     */
    const applyRenderConfigChange = (mutate: (state: MindMapStoreState) => void) => {
      set((state) => {
        mutate(state);
        state.isDirty = true;
        state._documentVersion += 1;
      });
      if (get().mindmapId) {
        scheduleDraftPersist();
      }
      debounceSave();
    };

    const refreshSearchResults = (state: MindMapStoreState) => {
      if (!state.searchQuery.trim()) return;
      const currentId = state.searchResults[state.currentSearchIndex] ?? null;
      const results = searchMindMapNodeIds(state.document.root, state.searchQuery, state.searchOptions);
      state.searchResults = results;
      const retainedIndex = currentId ? results.indexOf(currentId) : -1;
      state.currentSearchIndex = retainedIndex >= 0 ? retainedIndex : (results.length > 0 ? 0 : -1);
    };

    const applyMutation = (
      mutate: (state: MindMapStoreState) => void,
      options?: {
        skipHistory?: boolean;
        skipSave?: boolean;
        markDirty?: boolean;
        /** U5：同键且时间窗内的连续变更合并为一个 undo 步 */
        coalesceKey?: string | null;
      }
    ) => {
      const before = get();
      if (!options?.skipHistory) {
        const now = Date.now();
        const key = options?.coalesceKey ?? null;
        const canCoalesce =
          key !== null &&
          lastCoalesce !== null &&
          lastCoalesce.key === key &&
          now - lastCoalesce.at <= HISTORY_COALESCE_WINDOW_MS &&
          before.history.past.length > 0 &&
          before.history.future.length === 0;
        if (canCoalesce) {
          // 沿用上一个快照：本次不 pushHistory，undo 一次回到合并组之前
          lastCoalesce = { key: key!, at: now };
        } else {
          pushHistory(before.document, captureUiSnapshot(before));
          lastCoalesce = key !== null ? { key, at: now } : null;
        }
      } else {
        // skipHistory 变更（agent 演出等）不在合并组快照内，
        // 之后若继续合并会把这些变更一起吞进 undo，故打断合并链
        lastCoalesce = null;
      }
      set((state) => {
        mutate(state);
        refreshSearchResults(state);
        reconcileFilteredInteractionState(state);
        if (options?.markDirty !== false) {
          state.isDirty = true;
          state._documentVersion += 1;
        }
      });

      const nextState = get();
      if (nextState.mindmapId && nextState.isDirty) {
        scheduleDraftPersist();
      }

      if (!options?.skipSave) {
        debounceSave();
      }
    };

    function reconcileFilteredInteractionState(state: MindMapStoreState) {
      if (state.searchFilterMode && state.searchQuery.trim()) {
        const allowedIds = collectSearchPathIds(state.document.root, state.searchResults);
        state.selection = state.selection.filter((id) => allowedIds.has(id));
        if (state.editingNodeId && !allowedIds.has(state.editingNodeId)) {
          state.editingNodeId = null;
        }
        if (state.focusedNodeId && !allowedIds.has(state.focusedNodeId)) {
          state.focusedNodeId = state.searchResults.find((id) => allowedIds.has(id)) ?? null;
        }
        return;
      }

      if (!state.hideCompleted) return;
      const visibility = buildCompletedVisibilityIndex(state.document.root);
      state.selection = state.selection.filter((id) => visibility.visibleIds.has(id));
      state.focusedNodeId = resolveVisibleIdFromIndex(
        visibility,
        state.focusedNodeId,
        state.document.root.id,
      );
      if (state.editingNodeId && !visibility.visibleIds.has(state.editingNodeId)) {
        state.editingNodeId = null;
      }
      if (state.editingNoteNodeId && !visibility.visibleIds.has(state.editingNoteNodeId)) {
        state.editingNoteNodeId = null;
      }
    }

    /**
     * D5：undo/redo 恢复文档后校正 revealedBlanks——节点已不存在、挖空被清除
     * 或区间数变少时，丢弃越界的揭示状态，避免索引错位揭示到别的空。
     */
    function reconcileRevealedBlanks(state: MindMapStoreState) {
      const nodeIds = Object.keys(state.revealedBlanks);
      if (nodeIds.length === 0) return;
      const nodeById = buildNodeIndex(state.document.root).nodeById;
      for (const nodeId of nodeIds) {
        const node = nodeById.get(nodeId);
        if (!node?.blankedRanges?.length) {
          delete state.revealedBlanks[nodeId];
          continue;
        }
        const rangeCount = mergeRanges(
          validateRanges(node.blankedRanges, node.text.length),
        ).length;
        const next: Record<number, boolean> = {};
        for (const [key, value] of Object.entries(state.revealedBlanks[nodeId])) {
          const index = Number(key);
          if (index >= 0 && index < rangeCount) next[index] = value;
        }
        if (Object.keys(next).length > 0) {
          state.revealedBlanks[nodeId] = next;
        } else {
          delete state.revealedBlanks[nodeId];
        }
      }
    }

    /**
     * U3/U6：undo/redo 恢复 history 条目的 UI 快照。
     * 所有 ID 先对已恢复的 state.document 做存在性校验（复用 reconcile 思路），
     * 旧条目（无 ui 字段）退化为「清理不存在的 ID + meta.lastFocusId 兜底」。
     */
    function restoreUiSnapshot(state: MindMapStoreState, entry: MindMapHistoryEntry) {
      const nodeById = buildNodeIndex(state.document.root).nodeById;
      if (entry.ui) {
        state.selection = entry.ui.selection.filter((id) => nodeById.has(id));
        state.viewRootId =
          entry.ui.viewRootId &&
          entry.ui.viewRootId !== state.document.root.id &&
          nodeById.has(entry.ui.viewRootId)
            ? entry.ui.viewRootId
            : null;
        if (entry.ui.focusedNodeId && nodeById.has(entry.ui.focusedNodeId)) {
          state.focusedNodeId = entry.ui.focusedNodeId;
        }
      } else {
        state.selection = state.selection.filter((id) => nodeById.has(id));
        if (state.viewRootId && !nodeById.has(state.viewRootId)) {
          state.viewRootId = null;
        }
      }
      // 焦点兜底链：快照 → 文档 meta.lastFocusId → 根
      if (!state.focusedNodeId || !nodeById.has(state.focusedNodeId)) {
        const metaFocusId = state.document.meta?.lastFocusId;
        state.focusedNodeId =
          metaFocusId && nodeById.has(metaFocusId) ? metaFocusId : state.document.root.id;
      }
      if (state.selectionAnchorId && !nodeById.has(state.selectionAnchorId)) {
        state.selectionAnchorId = null;
      }
    }

    return {
      // 初始状态
      mindmapId: null,
      metadata: null,
      document: createDefaultDocument(),
      currentView: 'mindmap',
      focusedNodeId: null,
      editingNodeId: null,
      editingNoteNodeId: null,
      selection: [],
      selectionAnchorId: null,
      agentEnteringIds: new Set<string>(),
      agentFitViewNonce: 0,

      // 渲染配置初始状态
      layoutId: 'tree',
      layoutDirection: 'right' as LayoutDirection,
      styleId: 'default',
      edgeType: 'bezier' as EdgeType,
      measuredNodeHeights: {},

      history: { past: [], future: [] },
      isDirty: false,
      isSaving: false,
      lastSavedAt: null,
      _documentVersion: 0,
      _loadSeq: 0,
      conflictSnapshot: null,
      reciteMode: false,
      revealedBlanks: {},
      hideCompleted: false,
      viewRootId: null,
      searchQuery: '',
      searchOptions: {},
      searchResults: [],
      currentSearchIndex: -1,
      searchFilterMode: true,
      viewports: {},
      isExporting: false,
      exportProgress: 0,
      setIsExporting: (isExporting: boolean) => set({ isExporting }),
      setExportProgress: (progress: number) => set({ exportProgress: progress }),
      clipboard: null,
      _reactFlowGetter: null,

      // 加载知识导图（修复: 完整重置所有状态字段）
      loadMindMap: async (mindmapId: string, opts?: { preserveViewports?: boolean }) => {
        // 清除 pending timer，防止跨文档保存/重试
        clearPendingTimers();
        pendingSaveRequested = false;

        // M-066: 递增加载序列号，防止快速切换时旧请求覆盖新数据
        let seq: number;
        set((state) => {
          seq = ++state._loadSeq;
        });

        try {
          const [metadata, contentStr] = await Promise.all([
            api.getMindMap(mindmapId),
            api.getMindMapContent(mindmapId),
          ]);

          // M-066: 请求返回后检查序列号，若已有更新的请求发出则丢弃旧结果
          if (get()._loadSeq !== seq!) return;

          if (!metadata) {
            throw new Error(`MindMap not found: ${mindmapId}`);
          }

          let document: MindMapDocument;
          if (contentStr) {
            try {
              const parsed = JSON.parse(contentStr) as MindMapDocument;
              if (!parsed?.root || !parsed.root.id || !Array.isArray(parsed.root.children)) {
                throw new Error('Invalid mindmap document structure');
              }
              document = parsed;
            } catch (parseError) {
              throw new Error(i18next.t('store.contentCorrupted', { ns: 'mindmap', error: parseError instanceof Error ? parseError.message : 'parse error' }));
            }
          } else {
            document = createDefaultDocument(metadata.title);
          }

          let recoveredDraft = false;
          const localDraft = readDraft(mindmapId);
          if (localDraft) {
            const serverUpdatedAt = Date.parse(metadata.updatedAt || '');
            const draftSavedAt = Date.parse(localDraft.savedAt || '');
            if (!Number.isNaN(draftSavedAt) && (Number.isNaN(serverUpdatedAt) || draftSavedAt >= serverUpdatedAt)) {
              document = localDraft.document;
              recoveredDraft = true;
            }
          }

          set((state) => {
            state.mindmapId = mindmapId;
            state.metadata = metadata;
            state.document = document;
            if (!opts?.preserveViewports) {
              state.currentView =
                (recoveredDraft ? localDraft?.currentView : undefined) ||
                metadata.defaultView ||
                'mindmap';
            }
            state.focusedNodeId =
              (recoveredDraft ? localDraft?.focusedNodeId : undefined) ||
              document.meta?.lastFocusId ||
              null;
            state.editingNodeId = null; // 修复: 重置编辑状态
            state.editingNoteNodeId = null;
            state.selection = [];
            state.selectionAnchorId = null;
            state.history = { past: [], future: [] };
            state.isDirty = recoveredDraft;
            state.isSaving = false; // 修复: 重置保存状态
            state.lastSavedAt = null; // 修复: 重置最后保存时间
            state._documentVersion = recoveredDraft ? 1 : 0;
            state.measuredNodeHeights = {};
            // P1-3: 恢复布局/样式配置（优先草稿 > 文档 meta > 默认值）
            const rc = recoveredDraft ? localDraft : undefined;
            state.layoutId = rc?.layoutId || document.meta?.renderConfig?.layoutId || 'tree';
            state.layoutDirection = (rc?.layoutDirection || document.meta?.renderConfig?.direction || 'right') as LayoutDirection;
            state.styleId = rc?.styleId || document.meta?.renderConfig?.styleId || 'default';
            state.edgeType = (rc?.edgeType || document.meta?.renderConfig?.edgeType || 'bezier') as EdgeType;
            // 修复: 重置搜索状态
            state.searchQuery = '';
            state.searchOptions = {};
            state.searchResults = [];
            state.currentSearchIndex = -1;
            // 修复: 重置背诵模式状态
            state.reciteMode = false;
            state.revealedBlanks = {};
            // ACR 瞬态入场标记随文档重载清除
            state.agentEnteringIds = new Set();
            // 分支专注 / 视口保真为会话级，换图时重置；
            // preserveViewports（外部 watch 静默重载）时保留视口与当前视图
            state.viewRootId = null;
            if (!opts?.preserveViewports) {
              state.viewports = {};
            }
            // hideCompleted / searchFilterMode 为会话级 UI 偏好，切换导图时保留
          });

          if (recoveredDraft) {
            lastDraftVersionByMindmap.set(mindmapId, 1);
            showGlobalNotification('info', i18next.t('store.draftRecovered', { ns: 'mindmap' }));
            debounceSave();
          } else {
            lastDraftVersionByMindmap.delete(mindmapId);
          }
        } catch (error) {
          console.error('[MindMapStore] loadMindMap failed:', error);
          throw error;
        }
      },

      // 创建新知识导图（B13：重置字段与 loadMindMap / reset 对齐）
      createNewMindMap: async (title: string, folderId?: string) => {
        const doc = createDefaultDocument(title);

        const result = await api.createMindMap({
          title,
          content: JSON.stringify(doc),
          defaultView: 'mindmap',
          folderId,
        });

        // 与 loadMindMap 一致：切文档前清 pending 定时器，防止旧文档的 debounce 保存串扰
        clearPendingTimers();
        pendingSaveRequested = false;
        lastDraftVersionByMindmap.delete(result.id);
        lastCoalesce = null;
        set((state) => {
          state.mindmapId = result.id;
          state.metadata = result;
          state.document = doc;
          state.currentView = 'mindmap';
          state.focusedNodeId = doc.root.id;
          state.editingNodeId = null;
          state.editingNoteNodeId = null;
          state.selection = [];
          state.selectionAnchorId = null;
          state.agentEnteringIds = new Set();
          state.history = { past: [], future: [] };
          state.isDirty = false;
          state.isSaving = false;
          state.lastSavedAt = null;
          state._documentVersion = 0;
          state.conflictSnapshot = null;
          state.measuredNodeHeights = {};
          // 新文档回到默认渲染配置（与 reset 一致）
          state.layoutId = 'tree';
          state.layoutDirection = 'right';
          state.styleId = 'default';
          state.edgeType = 'bezier';
          state.viewRootId = null;
          state.viewports = {};
          state.reciteMode = false;
          state.revealedBlanks = {};
          state.searchQuery = '';
          state.searchOptions = {};
          state.searchResults = [];
          state.currentSearchIndex = -1;
        });

        return result.id;
      },

      // 清全部 pending 定时器（宿主换 store 实例前调用）；幂等，不重置状态
      destroy: () => {
        pendingSaveRequested = false;
        clearPendingTimers();
      },

      // 公开草稿清除（Discard 关闭：调用后再卸载即可跳过 saveDraftSync 残留）
      clearDraft: () => {
        const currentId = get().mindmapId;
        if (!currentId) return;
        clearDraft(currentId);
        lastDraftVersionByMindmap.delete(currentId);
      },

      // 重置状态（修复: 补全所有遗漏字段）
      reset: () => {
        // 清除 pending timer
        clearPendingTimers();
        pendingSaveRequested = false;
        const currentId = get().mindmapId;
        if (currentId) {
          clearDraft(currentId);
          lastDraftVersionByMindmap.delete(currentId);
        }
        set((state) => {
          state.mindmapId = null;
          state.metadata = null;
          state.document = createDefaultDocument();
          state.currentView = 'mindmap';
          state.focusedNodeId = null;
          state.editingNodeId = null; // 修复: 重置编辑状态
          state.editingNoteNodeId = null;
          state.selection = [];
          state.selectionAnchorId = null;
          state.agentEnteringIds = new Set(); // ACR R1-11 瞬态
          state.agentFitViewNonce = 0; // ACR R2-02
          state.layoutId = 'tree';
          state.layoutDirection = 'right';
          state.styleId = 'default';
          state.edgeType = 'bezier';
          state.history = { past: [], future: [] };
          state.isDirty = false;
          state.isSaving = false;
          state.lastSavedAt = null; // 修复: 重置最后保存时间
          state._documentVersion = 0;
          state.conflictSnapshot = null; // A6-24: 切换/重置导图时清除暂存冲突快照
          state.measuredNodeHeights = {};
          // 修复: 重置搜索状态
          state.searchQuery = '';
          state.searchOptions = {};
          state.searchResults = [];
          state.currentSearchIndex = -1;
          // 修复: 重置背诵模式状态
          state.reciteMode = false;
          state.revealedBlanks = {};
          state.viewRootId = null;
          // hideCompleted / searchFilterMode 为会话级 UI 偏好，reset 时保留
          state.viewports = {};
          state.isExporting = false;
          state.exportProgress = 0;
          state._reactFlowGetter = null;
        });
      },

      // 设置文档
      setDocument: (doc: MindMapDocument) => {
        const current = get();
        pushHistory(current.document, captureUiSnapshot(current));
        lastCoalesce = null;
        set((state) => {
          state.document = doc;
          state.isDirty = true;
          state._documentVersion += 1;
        });

        const nextState = get();
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }

        debounceSave();
      },

      // 设置视图（仅切换投影；defaultView 随下次内容保存写入，避免纯切换标脏轰炸）
      setCurrentView: (view: MindMapViewType) => {
        const prev = get().currentView;
        if (prev === view) return;
        set((state) => {
          state.currentView = view;
        });
      },

      // 设置焦点节点
      // B4/性能：不再把 lastFocusId 写进 document.meta——immer 下每次点击都会产生
      // 新的 document 引用，导致订阅 document 的大纲/画布整体重渲染。
      // 持久化的 lastFocusId 由 save()/splitNode/merge* 从 focusedNodeId 写入。
      setFocusedNodeId: (nodeId: string | null) => {
        set((state) => {
          state.focusedNodeId = nodeId;
        });
      },

      // 分支专注根（大纲/画布共享）
      setViewRootId: (nodeId: string | null) => {
        set((state) => {
          const nodeIndex = buildNodeIndex(state.document.root);
          if (!nodeId) {
            state.viewRootId = null;
          } else if (nodeId === state.document.root.id) {
            // 根节点等同于退出专注
            state.viewRootId = null;
          } else {
            const node = nodeIndex.nodeById.get(nodeId);
            state.viewRootId = node ? nodeId : null;
          }

          // 清理不在当前可见子树内的选中，避免批量操作改到屏外节点
          const rootId = state.viewRootId;
          if (!rootId) return;
          const scopeRoot = nodeIndex.nodeById.get(rootId);
          if (!scopeRoot) return;
          const scopeIds = new Set<string>();
          const stack = [scopeRoot];
          while (stack.length > 0) {
            const current = stack.pop()!;
            scopeIds.add(current.id);
            stack.push(...current.children);
          }
          state.selection = state.selection.filter((id) => scopeIds.has(id));
          if (state.focusedNodeId && !scopeIds.has(state.focusedNodeId)) {
            state.focusedNodeId = scopeRoot.id;
          }
        });
      },

      // 设置正在编辑的节点
      setEditingNodeId: (nodeId: string | null) => {
        set((state) => {
          state.editingNodeId = nodeId;
          // 进入标题编辑时退出备注编辑
          if (nodeId) state.editingNoteNodeId = null;
        });
      },

      // 设置正在编辑备注的节点
      setEditingNoteNodeId: (nodeId: string | null) => {
        set((state) => {
          state.editingNoteNodeId = nodeId;
          // 进入备注编辑时退出标题编辑
          if (nodeId) state.editingNodeId = null;
        });
      },

      // 设置选中节点
      setSelection: (nodeIds: string[]) => {
        set((state) => {
          state.selection = nodeIds;
        });
      },

      setSelectionAnchorId: (nodeId: string | null) => {
        set((state) => {
          state.selectionAnchorId = nodeId;
        });
      },

      // 全选当前视图可见节点（mod+a）：与大纲的可见性计算保持一致
      selectAllVisible: () => {
        const s = get();
        const displayRoot = s.viewRootId
          ? findNodeById(s.document.root, s.viewRootId) ?? s.document.root
          : s.document.root;
        // 搜索过滤模式优先（与 OutlineView 的 resolveSearchPathIds 相同语义）
        const pathIds = resolveSearchPathIds(displayRoot, {
          enabled: s.searchFilterMode,
          query: s.searchQuery,
          matchIds: s.searchResults,
        });
        const flat = flattenOutlineTree(displayRoot, {
          hideCompleted: s.hideCompleted,
          pathIds,
        });
        // 视图根自身不入选：根不可删除/移动，作为标题行不参与批量操作
        const visibleIds = flat
          .filter((row) => row.id !== displayRoot.id)
          .map((row) => row.id);
        set((state) => {
          state.selection = visibleIds;
          state.selectionAnchorId = visibleIds[0] ?? null;
        });
      },

      // ACR R1-11：瞬态入场标记（不进 history / 不标脏 / 不触发保存）
      markAgentEntering: (ids: string[]) => {
        if (ids.length === 0) return;
        set((state) => {
          const next = new Set(state.agentEnteringIds);
          for (const id of ids) next.add(id);
          state.agentEnteringIds = next;
        });
      },

      clearAgentEntering: (ids: string[]) => {
        if (ids.length === 0) return;
        set((state) => {
          const next = new Set(state.agentEnteringIds);
          for (const id of ids) next.delete(id);
          state.agentEnteringIds = next;
        });
      },

      // ACR R2-02：演出结束一次 fitView 信号
      requestAgentFitView: () => {
        set((state) => {
          state.agentFitViewNonce += 1;
        });
      },

      // ACR R1-11：等价 addNode + applyMutation({ skipHistory: true })
      agentAddNode: (parentId: string, index?: number) => {
        return get().agentAddSubtree(parentId, { text: '', children: [] }, index);
      },

      // Agent 外层节点及其 children 单事务插入，避免半棵树与重复保存调度。
      agentAddSubtree: (parentId, data, index) => {
        const state = get();
        const parentDepth = getNodeDepth(state.document.root, parentId);
        if (parentDepth < 0) return '';

        const clonedData = JSON.parse(JSON.stringify(data)) as Omit<MindMapNode, 'id'>;
        let newId = `node_${nanoid(10)}`;
        while (findNodeById(state.document.root, newId)) {
          newId = `node_${nanoid(10)}`;
        }
        const newNode: MindMapNode = { ...clonedData, id: newId };

        if (parentDepth + 1 + getSubtreeHeight(newNode) >= MAX_MINDMAP_DEPTH) {
          if (parentDepth >= 0) {
            showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          }
          return '';
        }
        if (countNodes(state.document.root) + countNodes(newNode) > MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return '';
        }

        let inserted = false;
        applyMutation((s) => {
          const parent = findNodeById(s.document.root, parentId);
          if (parent) {
            // 仅在确为折叠时展开，避免写入 collapsed:false 污染树快照
            if (parent.collapsed === true) parent.collapsed = false;
            const insertIndex = Math.max(
              0,
              Math.min(index ?? parent.children.length, parent.children.length),
            );
            parent.children.splice(insertIndex, 0, newNode);
            inserted = true;
            // ACR R2-02：不在此设 focusedNodeId——由 mindmapDriver 视口节流统一控制
          }
        }, { skipHistory: true });

        return inserted ? newId : '';
      },

      agentDeleteNode: (nodeId: string) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, [nodeId], { excludeRoot: true });
        if (normalizedIds.length === 0) return;
        const removedIds = collectNodeAndDescendantIds(document.root, normalizedIds);

        let nextFocusedNodeId = document.root.id;
        for (const id of normalizedIds) {
          const parent = findParentNode(document.root, id);
          if (parent) {
            nextFocusedNodeId = parent.id;
            break;
          }
        }

        applyMutation((state) => {
          removeNodesById(state.document.root, new Set(normalizedIds));
          afterRemoveNodes(state, removedIds, nextFocusedNodeId);
        }, { skipHistory: true });
      },

      agentMoveNode: (nodeId: string, newParentId: string, index: number) => {
        const { document } = get();
        if (document.root.id === nodeId) return false;
        if (nodeId === newParentId) return false;
        if (isDescendantOf(document.root, nodeId, newParentId)) return false;

        const movingNode = findNodeById(document.root, nodeId);
        const currentParent = findParentNode(document.root, nodeId);
        const nextParent = findNodeById(document.root, newParentId);
        const nextParentDepth = getNodeDepth(document.root, newParentId);
        if (!movingNode || !currentParent || !nextParent || nextParentDepth < 0) return false;
        if (nextParentDepth + 1 + getSubtreeHeight(movingNode) >= MAX_MINDMAP_DEPTH) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          return false;
        }

        let moved = false;
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          const currentParent = findParentNode(state.document.root, nodeId);
          const nextParent = findNodeById(state.document.root, newParentId);
          if (!node || !currentParent || !nextParent) {
            return;
          }

          const sourceIndex = currentParent.children.findIndex((child) => child.id === nodeId);
          if (sourceIndex === -1) {
            return;
          }

          const [detachedNode] = currentParent.children.splice(sourceIndex, 1);
          if (!detachedNode) {
            return;
          }

          let targetIndex = index;
          if (currentParent.id === nextParent.id && sourceIndex < targetIndex) {
            targetIndex -= 1;
          }

          const boundedIndex = Math.max(0, Math.min(targetIndex, nextParent.children.length));
          nextParent.children.splice(boundedIndex, 0, detachedNode);
          moved = true;
        }, { skipHistory: true });
        return moved;
      },

      agentInsertSubtree: (parentId: string, node: MindMapNode, index?: number) => {
        applyMutation((state) => {
          const parent = findNodeById(state.document.root, parentId);
          if (!parent) return;
          if (parent.collapsed) parent.collapsed = false;
          const insertIndex = index ?? parent.children.length;
          const bounded = Math.max(0, Math.min(insertIndex, parent.children.length));
          // 深拷贝，避免 immer/外部引用共享
          parent.children.splice(bounded, 0, JSON.parse(JSON.stringify(node)) as MindMapNode);
          state.focusedNodeId = node.id;
        }, { skipHistory: true });
      },

      // 更新节点（patch 中显式 undefined 的键会 delete，便于移除任务 completed 等可选字段）
      updateNode: (nodeId: string, patch: UpdateNodeParams, options) => {
        // U5：文本/备注/样式补丁默认按「节点+字段集」合并 history，
        // 连续打字/连点样式不再逐击键占用 undo 步；结构性字段（collapsed 等）不合并
        const patchKeys = Object.keys(patch).sort();
        const autoCoalescible =
          patchKeys.length > 0 &&
          patchKeys.every((key) => key === 'text' || key === 'note' || key === 'style');
        const coalesceKey =
          options?.coalesceKey !== undefined
            ? options.coalesceKey
            : autoCoalescible
              ? `update:${nodeId}:${patchKeys.join(',')}`
              : null;
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (node) {
            // 文本变更时对挖空区间做编辑重映射（替代旧「一改就全清」）；
            // 无法映射（区间文本被改写/删除）的区间被丢弃，全部失效才清除。
            // 挖空前 commit 文本走 preserveBlankedRanges 原样保留。
            if (
              patch.text !== undefined &&
              patch.text !== node.text &&
              !options?.preserveBlankedRanges
            ) {
              if (node.blankedRanges?.length) {
                const prevRanges = mergeRanges(
                  validateRanges(node.blankedRanges, node.text.length),
                );
                const remapped = remapRangesAfterTextEdit(
                  node.text,
                  patch.text,
                  prevRanges,
                );
                if (remapped.length === 0) {
                  delete node.blankedRanges;
                  delete state.revealedBlanks[nodeId];
                } else {
                  node.blankedRanges = remapped;
                  // 区间数变化时索引不再可靠，丢弃揭示状态；数目不变则保留
                  if (remapped.length !== prevRanges.length) {
                    delete state.revealedBlanks[nodeId];
                  }
                }
              }
            }
            for (const key of Object.keys(patch) as Array<keyof UpdateNodeParams>) {
              const value = patch[key];
              const record = node as unknown as Record<string, unknown>;
              if (value === undefined) {
                delete record[key];
              } else {
                record[key] = value;
              }
            }
          }
        }, { ...options, coalesceKey });
      },

      // 添加节点（M-070: 前端深度/节点数限制）
      addNode: (parentId: string, index?: number) => {
        const state = get();

        // M-070: 深度限制
        const parentDepth = getNodeDepth(state.document.root, parentId);
        if (parentDepth < 0 || parentDepth >= MAX_MINDMAP_DEPTH - 1) {
          if (parentDepth >= 0) {
            showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          }
          return '';
        }

        // M-070: 节点数限制
        const totalNodes = countNodes(state.document.root);
        if (totalNodes >= MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return '';
        }

        const newId = `node_${nanoid(10)}`;
        const newNode: MindMapNode = {
          id: newId,
          text: '',
          children: [],
        };
        applyMutation((s) => {
          const parent = findNodeById(s.document.root, parentId);
          if (parent) {
            // 折叠父下新建时自动展开，避免节点存在但不可见
            if (parent.collapsed) parent.collapsed = false;
            const insertIndex = index ?? parent.children.length;
            parent.children.splice(insertIndex, 0, newNode);
            s.focusedNodeId = newId;
          }
        });

        return newId;
      },

      // 复制节点（在原位置后插入深拷贝；全部重新生成 id；单 history 步）
      duplicateNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
          excludeRoot: true,
        });
        if (normalizedIds.length === 0) return null;

        const treeIndex = buildNodeIndex(document.root);
        const sources = normalizedIds
          .map((id) => treeIndex.nodeById.get(id))
          .filter((node): node is MindMapNode => Boolean(node));
        if (sources.length !== normalizedIds.length) return null;

        const pendingCount = sources.reduce((sum, node) => sum + countNodes(node), 0);
        if (countNodes(document.root) + pendingCount > MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return null;
        }

        const usedIds = new Set(treeIndex.nodeById.keys());
        const nextNodeId = () => {
          let id = `node_${nanoid(10)}`;
          while (usedIds.has(id)) id = `node_${nanoid(10)}`;
          usedIds.add(id);
          return id;
        };
        // JSON 克隆深拷贝 style/refs/blankedRanges 等嵌套对象，再全量重生成 id
        const regenerateIds = (node: MindMapNode): MindMapNode => ({
          ...node,
          id: nextNodeId(),
          children: node.children.map(regenerateIds),
        });
        const plans = normalizedIds.map((sourceId, index) => ({
          sourceId,
          clone: regenerateIds(JSON.parse(JSON.stringify(sources[index])) as MindMapNode),
        }));

        const newIds: string[] = [];
        applyMutation((state) => {
          for (const plan of plans) {
            const liveParent = findParentNode(state.document.root, plan.sourceId);
            if (!liveParent) continue;
            const sourceIndex = liveParent.children.findIndex(
              (child) => child.id === plan.sourceId,
            );
            if (sourceIndex === -1) continue;
            liveParent.children.splice(sourceIndex + 1, 0, plan.clone);
            newIds.push(plan.clone.id);
          }
          if (newIds.length > 0) {
            state.focusedNodeId = newIds[0];
            state.selection = [...newIds];
            state.selectionAnchorId = newIds[0];
          }
        });

        return newIds.length > 0 ? newIds : null;
      },

      // 删除节点
      deleteNode: (nodeId: string) => {
        get().deleteNodes([nodeId]);
      },

      deleteNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, { excludeRoot: true });
        if (normalizedIds.length === 0) return;
        const removedIds = collectNodeAndDescendantIds(document.root, normalizedIds);

        let nextFocusedNodeId = document.root.id;
        for (const nodeId of normalizedIds) {
          const parent = findParentNode(document.root, nodeId);
          if (parent) {
            nextFocusedNodeId = parent.id;
            break;
          }
        }

        applyMutation((state) => {
          removeNodesById(state.document.root, new Set(normalizedIds));
          afterRemoveNodes(state, removedIds, nextFocusedNodeId);
        });
      },

      // 移动节点
      moveNode: (nodeId: string, newParentId: string, index: number) => {
        get().moveNodes([nodeId], newParentId, index);
      },

      moveNodes: (nodeIds: string[], newParentId: string, index: number) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
          excludeRoot: true,
        });
        if (normalizedIds.length === 0) return false;

        const treeIndex = buildNodeIndex(document.root);
        const nextParent = treeIndex.nodeById.get(newParentId);
        const nextParentDepth = treeIndex.depthById.get(newParentId);
        if (!nextParent || nextParentDepth === undefined) return false;

        for (const nodeId of normalizedIds) {
          let currentId: string | null = newParentId;
          while (currentId) {
            if (currentId === nodeId) return false;
            currentId = treeIndex.parentById.get(currentId)?.id ?? null;
          }
          const node = treeIndex.nodeById.get(nodeId);
          if (!node || nextParentDepth + 1 + getSubtreeHeight(node) >= MAX_MINDMAP_DEPTH) {
            showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
            return false;
          }
        }

        const requestedIndex = Math.max(0, Math.floor(index));
        let removedBeforeTarget = 0;
        for (const nodeId of normalizedIds) {
          const parent = treeIndex.parentById.get(nodeId);
          if (parent?.id !== newParentId) continue;
          const sourceIndex = parent.children.findIndex((child) => child.id === nodeId);
          if (sourceIndex >= 0 && sourceIndex < requestedIndex) removedBeforeTarget += 1;
        }
        const adjustedIndex = requestedIndex - removedBeforeTarget;

        let moved = false;
        applyMutation((state) => {
          const liveIndex = buildNodeIndex(state.document.root);
          const movingNodes = normalizedIds.flatMap((nodeId) => {
            const node = liveIndex.nodeById.get(nodeId);
            return node ? [node] : [];
          });
          if (movingNodes.length !== normalizedIds.length) return;

          const movingIdSet = new Set(normalizedIds);
          const touchedParents = new Set<MindMapNode>();
          for (const nodeId of normalizedIds) {
            const parent = liveIndex.parentById.get(nodeId);
            if (parent) touchedParents.add(parent);
          }
          for (const parent of touchedParents) {
            parent.children = parent.children.filter((child) => !movingIdSet.has(child.id));
          }

          const liveNextParent = liveIndex.nodeById.get(newParentId);
          if (!liveNextParent) return;
          const boundedIndex = Math.max(
            0,
            Math.min(adjustedIndex, liveNextParent.children.length),
          );
          liveNextParent.children.splice(boundedIndex, 0, ...movingNodes);
          if (liveNextParent.collapsed === true) liveNextParent.collapsed = false;
          moved = true;
        });

        return moved;
      },

      // 切换折叠
      toggleCollapse: (nodeId: string, options) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (node) {
            node.collapsed = !node.collapsed;
          }
        }, options);
      },

      collapseAll: () => {
        applyMutation((state) => {
          traverseDFS(state.document.root, (node, parent) => {
            // 根不折叠；有子节点的非根节点全部折叠
            node.collapsed = parent !== null && node.children.length > 0;
          });
        });
      },

      expandAll: () => {
        applyMutation((state) => {
          traverseDFS(state.document.root, (node) => {
            node.collapsed = false;
          });
        });
      },

      // 折叠整个子树（单 history 步；替代 UI 层 forEach toggleCollapse + skipHistory 拼事务）
      collapseSubtree: (nodeId: string) => {
        const { document } = get();
        if (!findNodeById(document.root, nodeId)) return;
        applyMutation((state) => {
          const target = findNodeById(state.document.root, nodeId);
          if (!target) return;
          const isDocRoot = nodeId === state.document.root.id;
          traverseDFS(target, (node) => {
            // 文档根保持展开；叶子不写 collapsed，避免污染树快照
            if (isDocRoot && node.id === nodeId) return;
            if (node.children.length > 0) node.collapsed = true;
          });
        });
      },

      // 展开整个子树（单 history 步）
      expandSubtree: (nodeId: string) => {
        const { document } = get();
        if (!findNodeById(document.root, nodeId)) return;
        applyMutation((state) => {
          const target = findNodeById(state.document.root, nodeId);
          if (!target) return;
          traverseDFS(target, (node) => {
            // 仅在确为折叠时展开，不给未折叠节点写入 collapsed:false
            if (node.collapsed === true) node.collapsed = false;
          });
        });
      },

      collapseToDepth: (depth: number) => {
        const targetDepth = Math.max(0, Math.floor(depth));
        applyMutation((state) => {
          traverseDFS(state.document.root, (node, _parent, _index, currentDepth) => {
            node.collapsed = currentDepth >= targetDepth && node.children.length > 0;
          });
        });
      },

      // 缩进节点
      indentNode: (nodeId: string) => {
        get().indentNodes([nodeId]);
      },

      indentNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
          excludeRoot: true,
        });
        if (normalizedIds.length === 0) return;

        const selectedIds = new Set(normalizedIds);
        const treeIndex = buildNodeIndex(document.root);

        const plans: Array<{ parentId: string; targetId: string; nodeIds: string[] }> = [];
        let exceedsDepth = false;
        traverseDFS(document.root, (parent) => {
          let index = 0;
          while (index < parent.children.length) {
            if (!selectedIds.has(parent.children[index].id)) {
              index += 1;
              continue;
            }
            const start = index;
            const blockIds: string[] = [];
            while (index < parent.children.length && selectedIds.has(parent.children[index].id)) {
              blockIds.push(parent.children[index].id);
              index += 1;
            }
            if (start === 0) continue;

            const target = parent.children[start - 1];
            const targetDepth = treeIndex.depthById.get(target.id) ?? -1;
            const blockFits = blockIds.every((id) => {
              const node = treeIndex.nodeById.get(id);
              return node && targetDepth + 1 + getSubtreeHeight(node) < MAX_MINDMAP_DEPTH;
            });
            if (!blockFits) {
              exceedsDepth = true;
              continue;
            }
            plans.push({ parentId: parent.id, targetId: target.id, nodeIds: blockIds });
          }
        });

        if (exceedsDepth) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          return;
        }
        if (plans.length === 0) return;

        applyMutation((state) => {
          const liveNodeById = buildNodeIndex(state.document.root).nodeById;
          for (const plan of plans) {
            const parent = liveNodeById.get(plan.parentId);
            const target = liveNodeById.get(plan.targetId);
            if (!parent || !target) continue;
            const movingIds = new Set(plan.nodeIds);
            const movingNodes = parent.children.filter((child) => movingIds.has(child.id));
            if (movingNodes.length === 0) continue;
            parent.children = parent.children.filter((child) => !movingIds.has(child.id));
            target.children.push(...movingNodes);
            if (target.collapsed === true) target.collapsed = false;
          }
        });
      },

      // 反缩进节点
      outdentNode: (nodeId: string) => {
        get().outdentNodes([nodeId]);
      },

      outdentNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
          excludeRoot: true,
        });
        if (normalizedIds.length === 0) return;

        const selectedIds = new Set(normalizedIds);
        const plans: Array<{
          parentId: string;
          grandParentId: string;
          nodeIds: string[];
          /** Workflowy/幕布语义：原后续同级被最后一个反缩进节点收养为子树 */
          adoptIds: string[];
        }> = [];
        const visit = (parent: MindMapNode, grandParent: MindMapNode | null) => {
          if (grandParent) {
            const movingIds = parent.children
              .filter((child) => selectedIds.has(child.id))
              .map((child) => child.id);
            if (movingIds.length > 0) {
              let lastSelectedIndex = -1;
              parent.children.forEach((child, index) => {
                if (selectedIds.has(child.id)) lastSelectedIndex = index;
              });
              const adoptIds = parent.children
                .slice(lastSelectedIndex + 1)
                .filter((child) => !selectedIds.has(child.id))
                .map((child) => child.id);
              plans.push({
                parentId: parent.id,
                grandParentId: grandParent.id,
                nodeIds: movingIds,
                adoptIds,
              });
            }
          }
          for (const child of parent.children) visit(child, parent);
        };
        visit(document.root, null);
        if (plans.length === 0) return;

        applyMutation((state) => {
          const liveNodeById = buildNodeIndex(state.document.root).nodeById;
          for (const plan of plans) {
            const parent = liveNodeById.get(plan.parentId);
            const grandParent = liveNodeById.get(plan.grandParentId);
            if (!parent || !grandParent) continue;
            const movingIds = new Set(plan.nodeIds);
            const movingNodes = parent.children.filter((child) => movingIds.has(child.id));
            if (movingNodes.length === 0) continue;

            // 收养后续同级：深度不变（parent+1 → grandParent+2），无需重查深度限制
            const adoptIdSet = new Set(plan.adoptIds);
            const adoptedNodes = parent.children.filter((child) => adoptIdSet.has(child.id));

            parent.children = parent.children.filter(
              (child) => !movingIds.has(child.id) && !adoptIdSet.has(child.id),
            );
            const parentIndex = grandParent.children.findIndex((child) => child.id === parent.id);
            if (parentIndex < 0) {
              // 目标位置丢失时回滚本计划的收养，避免节点凭空消失
              parent.children.push(...adoptedNodes);
              continue;
            }
            grandParent.children.splice(parentIndex + 1, 0, ...movingNodes);

            if (adoptedNodes.length > 0) {
              const adopter = movingNodes[movingNodes.length - 1];
              adopter.children.push(...adoptedNodes);
              if (adopter.collapsed === true) adopter.collapsed = false;
            }
          }
        });
      },


      splitNode: (nodeId: string, cursorOffset: number, textOverride?: string) => {
        const { document } = get();
        const node = findNodeById(document.root, nodeId);
        if (!node) return null;

        const parent = findParentNode(document.root, nodeId);
        // 根节点：拆成「根保留前半 + 新子节点后半」不合适；根无同级，拆为根下第一个子
        const text = textOverride ?? node.text ?? '';
        const offset = Math.max(0, Math.min(Math.floor(cursorOffset), text.length));
        const before = text.slice(0, offset);
        const after = text.slice(offset);

        // 节点数限制
        if (countNodes(document.root) >= MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return null;
        }

        const newId = `node_${nanoid(10)}`;
        const newNode: MindMapNode = {
          id: newId,
          text: after,
          children: [],
        };

        applyMutation((state) => {
          const current = findNodeById(state.document.root, nodeId);
          if (!current) return;
          current.text = before;
          delete current.blankedRanges;
          delete state.revealedBlanks[nodeId];

          if (!parent) {
            // 根：后半成为第一个子节点（行业折中；Workflowy 根通常不可拆同级）
            current.children.unshift(newNode);
          } else {
            const liveParent = findParentNode(state.document.root, nodeId);
            if (!liveParent) return;
            const idx = liveParent.children.findIndex((c) => c.id === nodeId);
            if (idx === -1) return;
            liveParent.children.splice(idx + 1, 0, newNode);
          }

          const focusOriginal = offset === 0 && text.length > 0;
          const focusId = focusOriginal ? nodeId : newId;
          state.focusedNodeId = focusId;
          if (state.document.meta) {
            state.document.meta.lastFocusId = focusId;
          }
        });

        return newId;
      },

      mergeWithPrevious: (nodeId: string, textOverride?: string, scopeRootId?: string) => {
        const { document } = get();
        if (document.root.id === nodeId) return null;

        const parent = findParentNode(document.root, nodeId);
        if (!parent) return null;

        const idx = parent.children.findIndex((c) => c.id === nodeId);
        if (idx === -1) return null;

        let mergeTarget: MindMapNode | null = null;

        if (idx > 0) {
          mergeTarget = parent.children[idx - 1];
        } else {
          // 无上一同级：取可见列表中的上一节点（通常是父）。
          // E01 B7：分支专注时传入 scopeRootId，以专注子树为界解析「上一可见」，
          // 避免行首 Backspace 合并到专注范围外（UI 不可见）的节点。
          const scopeRoot =
            (scopeRootId ? findNodeById(document.root, scopeRootId) : null) ??
            document.root;
          const visible = flattenVisibleNodes(scopeRoot);
          const visIdx = visible.findIndex((n) => n.node.id === nodeId);
          if (visIdx > 0) {
            mergeTarget = visible[visIdx - 1].node;
          }
        }

        if (!mergeTarget || mergeTarget.id === nodeId) return null;

        const current = findNodeById(document.root, nodeId);
        if (!current) return null;

        const cursorOffset = (mergeTarget.text ?? '').length;
        const mergedIntoId = mergeTarget.id;
        const appendedText = textOverride ?? current.text ?? '';

        applyMutation((state) => {
          const liveParent = findParentNode(state.document.root, nodeId);
          const liveCurrent = findNodeById(state.document.root, nodeId);
          const target = findNodeById(state.document.root, mergedIntoId);
          if (!liveParent || !liveCurrent || !target) return;

          const liveIdx = liveParent.children.findIndex((c) => c.id === nodeId);
          if (liveIdx === -1) return;

          target.text = (target.text ?? '') + appendedText;
          delete target.blankedRanges;
          delete state.revealedBlanks[mergedIntoId];
          delete state.revealedBlanks[nodeId];

          // 合并元数据：备注拼接；样式/refs 仅目标缺失时继承
          if (liveCurrent.note) {
            target.note = target.note
              ? `${target.note}\n${liveCurrent.note}`
              : liveCurrent.note;
          }
          if (!target.style && liveCurrent.style) {
            target.style = { ...liveCurrent.style };
          }
          if (liveCurrent.refs?.length) {
            const existing = new Set((target.refs ?? []).map((r) => r.sourceId));
            const incoming = liveCurrent.refs.filter((r) => !existing.has(r.sourceId));
            if (incoming.length) {
              target.refs = [...(target.refs ?? []), ...incoming];
            }
          }
          if (liveCurrent.completed && !target.completed) {
            target.completed = true;
          }

          const movingChildren = [...liveCurrent.children];
          liveCurrent.children = [];

          if (target.id === liveParent.id) {
            // 并入父：子树占据原节点槽位（与 splitMerge util 一致）
            liveParent.children.splice(liveIdx, 1, ...movingChildren);
          } else {
            // 并入上一同级：子树接到目标末尾，再删当前
            target.children.push(...movingChildren);
            liveParent.children.splice(liveIdx, 1);
          }
          // 被合并节点已从树中移除，清理指向它的关联线（与 mergeNextIntoCurrent 对称）
          pruneAssociationsForRemovedNodes(state.document, new Set([nodeId]));
          // 专注根被合并时专注点跟随合并目标（目标为文档根则退出专注）
          if (state.viewRootId === nodeId) {
            state.viewRootId =
              mergedIntoId === state.document.root.id ? null : mergedIntoId;
          }

          state.focusedNodeId = mergedIntoId;
          if (state.document.meta) {
            state.document.meta.lastFocusId = mergedIntoId;
          }
          if (state.editingNodeId === nodeId) {
            state.editingNodeId = mergedIntoId;
          }
          if (state.editingNoteNodeId === nodeId) {
            state.editingNoteNodeId = null;
          }
          // U7：被合并节点在选中集内时改指向 merged 节点（旧实现先 filter 再 map，映射永不生效）
          const mappedSelection = state.selection.map((id) =>
            id === nodeId ? mergedIntoId : id,
          );
          state.selection = Array.from(new Set(mappedSelection));
        });

        return { mergedIntoId, cursorOffset };
      },

      mergeNextIntoCurrent: (nodeId: string, textOverride?: string, nextVisibleNodeId?: string | null) => {
        const { document } = get();
        const current = findNodeById(document.root, nodeId);
        if (!current) return null;

        const visible = flattenVisibleNodes(document.root);
        const currentIndex = visible.findIndex((entry) => entry.node.id === nodeId);
        const source = nextVisibleNodeId === undefined
          ? (currentIndex >= 0 ? visible[currentIndex + 1]?.node : null)
          : (nextVisibleNodeId ? findNodeById(document.root, nextVisibleNodeId) : null);
        if (!source || source.id === nodeId || !findParentNode(document.root, source.id)) return null;

        const cursorOffset = (textOverride ?? current.text ?? '').length;
        const sourceId = source.id;

        applyMutation((state) => {
          const target = findNodeById(state.document.root, nodeId);
          const liveSource = findNodeById(state.document.root, sourceId);
          const liveSourceParent = findParentNode(state.document.root, sourceId);
          if (!target || !liveSource || !liveSourceParent) return;

          const sourceIndex = liveSourceParent.children.findIndex((child) => child.id === sourceId);
          if (sourceIndex === -1) return;

          target.text = (textOverride ?? target.text ?? '') + (liveSource.text ?? '');
          delete target.blankedRanges;
          delete state.revealedBlanks[nodeId];
          delete state.revealedBlanks[sourceId];

          if (liveSource.note) {
            target.note = target.note ? `${target.note}\n${liveSource.note}` : liveSource.note;
          }
          if (!target.style && liveSource.style) target.style = { ...liveSource.style };
          if (liveSource.refs?.length) {
            const existing = new Set((target.refs ?? []).map((ref) => ref.sourceId));
            const incoming = liveSource.refs.filter((ref) => !existing.has(ref.sourceId));
            if (incoming.length) target.refs = [...(target.refs ?? []), ...incoming];
          }
          if (liveSource.completed && !target.completed) target.completed = true;

          const movingChildren = [...liveSource.children];
          liveSource.children = [];
          if (target.id === liveSourceParent.id) {
            liveSourceParent.children.splice(sourceIndex, 1, ...movingChildren);
          } else {
            target.children.push(...movingChildren);
            liveSourceParent.children.splice(sourceIndex, 1);
          }
          pruneAssociationsForRemovedNodes(state.document, new Set([sourceId]));
          // 专注根被合并进当前节点时专注点跟随目标（目标为文档根则退出专注）
          if (state.viewRootId === sourceId) {
            state.viewRootId = nodeId === state.document.root.id ? null : nodeId;
          }

          state.focusedNodeId = nodeId;
          if (state.document.meta) state.document.meta.lastFocusId = nodeId;
          if (state.editingNodeId === sourceId) state.editingNodeId = nodeId;
          if (state.editingNoteNodeId === sourceId) state.editingNoteNodeId = null;
          state.selection = state.selection.filter((id) => id !== sourceId);
        });

        return { mergedIntoId: nodeId, cursorOffset };
      },

      toggleCompleted: (nodeIds: string[]) => {
        const { document } = get();
        const nodeIndex = buildNodeIndex(document.root);
        const uniqueIds = Array.from(new Set(nodeIds)).filter((id) => nodeIndex.nodeById.has(id));
        if (uniqueIds.length === 0) return;
        const markCompleted = !uniqueIds.every(
          (id) => nodeIndex.nodeById.get(id)?.completed === true,
        );

        applyMutation((state) => {
          const liveNodeById = buildNodeIndex(state.document.root).nodeById;
          for (const id of uniqueIds) {
            const node = liveNodeById.get(id);
            if (node) {
              node.completed = markCompleted;
            }
          }
        });
      },

      setViewViewport: ((view: MindMapViewportView, partial: Record<string, number>) => {
        set((state) => {
          if (view === 'outline') {
            const prev = state.viewports.outline ?? { scrollTop: 0 };
            state.viewports.outline = {
              scrollTop: partial.scrollTop ?? prev.scrollTop,
            };
            return;
          }
          const prev = state.viewports.mindmap ?? { x: 0, y: 0, zoom: 1 };
          state.viewports.mindmap = mergeMindMapViewport(prev, partial);
        });
      }) as MindMapStoreState['setViewViewport'],

      // 节点资源引用
      addNodeRef: (nodeId: string, ref: MindMapNodeRef) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node) return;
          if (!node.refs) {
            node.refs = [];
          }
          // 去重：同一 sourceId 不重复添加
          if (node.refs.some((r) => r.sourceId === ref.sourceId)) return;
          node.refs.push(ref);
        });
      },

      removeNodeRef: (nodeId: string, sourceId: string) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node?.refs) return;
          node.refs = node.refs.filter((r) => r.sourceId !== sourceId);
          if (node.refs.length === 0) {
            delete node.refs;
          }
        });
      },

      // 跨分支关联线
      addAssociation: (source: string, target: string, label?: string) => {
        if (!source || !target || source === target) return null;
        const { document } = get();
        if (!findNodeById(document.root, source) || !findNodeById(document.root, target)) {
          return null;
        }
        if (findAssociationPair(document.associations, source, target)) {
          return null;
        }

        const id = `assoc_${nanoid(10)}`;
        const association: MindMapAssociation = {
          id,
          source,
          target,
          ...(label != null && label !== '' ? { label } : {}),
        };

        applyMutation((state) => {
          if (!state.document.associations) {
            state.document.associations = [];
          }
          state.document.associations.push(association);
        });

        return id;
      },

      updateAssociationLabel: (id: string, label: string) => {
        const { document } = get();
        const existing = document.associations?.find((a) => a.id === id);
        if (!existing) return;

        applyMutation((state) => {
          const assoc = state.document.associations?.find((a) => a.id === id);
          if (!assoc) return;
          const trimmed = label.trim();
          if (trimmed) {
            assoc.label = trimmed;
          } else {
            delete assoc.label;
          }
        });
      },

      removeAssociation: (id: string) => {
        const { document } = get();
        if (!document.associations?.some((a) => a.id === id)) return;

        applyMutation((state) => {
          if (!state.document.associations) return;
          state.document.associations = state.document.associations.filter((a) => a.id !== id);
          if (state.document.associations.length === 0) {
            delete state.document.associations;
          }
        });
      },

      // Undo（恢复文档 + 条目附带的 UI 快照，并对新树做存在性校验）
      undo: () => {
        const current = get();
        if (current.history.past.length === 0) return;
        // undo 后继续输入应开启新的 undo 步
        lastCoalesce = null;
        // document 为 immer frozen 树，直接存引用（见 pushHistory）
        const currentEntry: MindMapHistoryEntry = {
          document: current.document,
          ui: captureUiSnapshot(current),
        };

        let restoredFocusId: string | null = null;
        set((state) => {
          const entry = state.history.past.pop();
          if (!entry) return;
          state.history.future.push(currentEntry);
          state.document = entry.document;
          restoreUiSnapshot(state, entry);
          refreshSearchResults(state);
          reconcileFilteredInteractionState(state);
          reconcileRevealedBlanks(state);
          state.isDirty = true;
          state._documentVersion += 1;
          // ★ 2026-02 修复：退出编辑模式，防止 OutlineView 的 localText 与撤销后的文档不一致
          state.editingNodeId = null;
          state.editingNoteNodeId = null;
          restoredFocusId = state.focusedNodeId;
        });

        const nextState = get();
        if (restoredFocusId) {
          nextState.expandToNode(restoredFocusId, { silent: true });
        }
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }

        debounceSave();
      },

      // Redo（对称恢复 undo 前的文档与 UI 状态）
      redo: () => {
        const current = get();
        if (current.history.future.length === 0) return;
        lastCoalesce = null;
        // document 为 immer frozen 树，直接存引用（见 pushHistory）
        const currentEntry: MindMapHistoryEntry = {
          document: current.document,
          ui: captureUiSnapshot(current),
        };

        let restoredFocusId: string | null = null;
        set((state) => {
          const entry = state.history.future.pop();
          if (!entry) return;
          state.history.past.push(currentEntry);
          state.document = entry.document;
          restoreUiSnapshot(state, entry);
          refreshSearchResults(state);
          reconcileFilteredInteractionState(state);
          reconcileRevealedBlanks(state);
          state.isDirty = true;
          state._documentVersion += 1;
          state.editingNodeId = null;
          state.editingNoteNodeId = null;
          restoredFocusId = state.focusedNodeId;
        });

        const nextState = get();
        if (restoredFocusId) {
          nextState.expandToNode(restoredFocusId, { silent: true });
        }
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }

        debounceSave();
      },

      canUndo: () => get().history.past.length > 0,
      canRedo: () => get().history.future.length > 0,

      // P2：查找替换。先在当前树上规划补丁，再单次 applyMutation（一次 undo）
      replaceInMindMap: (query, replacement, options) => {
        if (!query) return 0;
        const caseSensitive = options?.caseSensitive ?? false;
        const includeNotes = options?.includeNotes ?? true;
        const scope = options?.nodeIds ? new Set(options.nodeIds) : null;

        /** 大小写不敏感时手动扫描替换（避免动态 RegExp 的转义问题） */
        const replaceAllOccurrences = (source: string): string => {
          if (caseSensitive) return source.split(query).join(replacement);
          const haystack = source.toLowerCase();
          const needle = query.toLowerCase();
          let result = '';
          let cursor = 0;
          while (cursor <= source.length - needle.length) {
            const idx = haystack.indexOf(needle, cursor);
            if (idx === -1) break;
            result += source.slice(cursor, idx) + replacement;
            cursor = idx + needle.length;
          }
          return result + source.slice(cursor);
        };

        const { document } = get();
        const plans: Array<{ id: string; text?: string; note?: string }> = [];
        traverseDFS(document.root, (node) => {
          if (scope && !scope.has(node.id)) return;
          const nextText = replaceAllOccurrences(node.text ?? '');
          const nextNote =
            includeNotes && node.note ? replaceAllOccurrences(node.note) : undefined;
          const textChanged = nextText !== (node.text ?? '');
          const noteChanged = nextNote !== undefined && nextNote !== node.note;
          if (!textChanged && !noteChanged) return;
          plans.push({
            id: node.id,
            ...(textChanged ? { text: nextText } : {}),
            ...(noteChanged ? { note: nextNote } : {}),
          });
        });
        if (plans.length === 0) return 0;

        applyMutation((state) => {
          const liveNodeById = buildNodeIndex(state.document.root).nodeById;
          for (const plan of plans) {
            const node = liveNodeById.get(plan.id);
            if (!node) continue;
            if (plan.text !== undefined) {
              node.text = plan.text;
              // 文本变更后挖空字符索引失效（与 updateNode 语义一致）
              delete node.blankedRanges;
              delete state.revealedBlanks[plan.id];
            }
            if (plan.note !== undefined) {
              node.note = plan.note;
            }
          }
        });
        return plans.length;
      },

      // 保存（防竞态 + 冲突检测 + 自动重试）
      save: async (options) => {
        const saveSource = options?.source ?? 'manual';
        const { mindmapId, metadata, document, currentView, focusedNodeId, isDirty, isSaving, _documentVersion } = get();
        if (!mindmapId) return false;
        if (!isDirty) return true;
        if (isSaving) {
          // 保存进行中：登记补存请求，当前保存结束后自动再保存一次
          pendingSaveRequested = true;
          return false;
        }

        // 捕获保存开始时的版本号，防止竞态（替代 JSON.stringify 全量比较，O(1) 性能）
        const savingMindmapId = mindmapId;
        const savingVersion = _documentVersion;
        const expectedUpdatedAt = metadata?.updatedAt;

        if (saveDebounceTimer) {
          clearTimeout(saveDebounceTimer);
          saveDebounceTimer = null;
        }
        if (retrySaveTimer) {
          clearTimeout(retrySaveTimer);
          retrySaveTimer = null;
        }
        // 超限后的再次保存（通常为手动）：开启新一轮自动重试额度
        if (saveRetryCount > MAX_SAVE_AUTO_RETRIES) {
          saveRetryCount = 0;
        }

        set((state) => {
          state.isSaving = true;
        });

        try {
          const { layoutId: savingLayoutId, layoutDirection: savingLayoutDirection, styleId: savingStyleId, edgeType: savingEdgeType } = get();
          const docWithViewState = {
            ...document,
            meta: {
              ...document.meta,
              lastFocusId: focusedNodeId || undefined,
              updatedAt: new Date().toISOString(),
              renderConfig: {
                layoutId: savingLayoutId,
                direction: savingLayoutDirection,
                styleId: savingStyleId,
                edgeType: savingEdgeType,
                layoutConfig: { ...DEFAULT_LAYOUT_CONFIG, direction: savingLayoutDirection },
              },
            },
          };

          const updated = await api.updateMindMap(savingMindmapId, {
            content: JSON.stringify(docWithViewState),
            defaultView: currentView,
            expectedUpdatedAt,
            versionSource: saveSource,
          });

          set((state) => {
            state.isSaving = false;
            state.lastSavedAt = Date.now();
            state.conflictSnapshot = null; // A6-24: 保存成功后清除暂存的冲突快照
            if (state.mindmapId === savingMindmapId) {
              state.metadata = updated;
            }
            // ★ 2026-02 优化：用版本号比较替代 JSON.stringify，O(1) 复杂度
            if (state.mindmapId === savingMindmapId &&
              state._documentVersion === savingVersion) {
              state.isDirty = false;
            }
          });

          // 保存成功：重置自动重试计数
          saveRetryCount = 0;

          const nextState = get();
          if (nextState.mindmapId === savingMindmapId) {
            if (!nextState.isDirty) {
              pendingSaveRequested = false;
              clearDraft(savingMindmapId);
              lastDraftVersionByMindmap.delete(savingMindmapId);
            } else if (pendingSaveRequested) {
              // 保存期间有显式 save() 请求（如可见性 flush）：立即补存而非等 debounce
              pendingSaveRequested = false;
              persistDraftNow(true);
              void get().save();
            } else {
              persistDraftNow(true);
              // 保存期间若继续编辑，重排一次自动保存，避免漏存
              debounceSave();
            }
          }
          return true;
        } catch (error) {
          console.error('[MindMapStore] save failed:', error);
          // 失败路径交给重试/冲突流程处理，避免补存请求造成额外循环
          pendingSaveRequested = false;
          set((state) => {
            state.isSaving = false;
          });

          const errorMessage =
            typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : '';

          // M-074 / A6-24: 冲突时自动重载服务端版本，并暂存本地未保存编辑供"恢复我的修改"
          if (errorMessage.includes('MINDMAP_UPDATE_CONFLICT')) {
            saveRetryCount = 0;
            // A6-24: 先捕获冲突前的本地文档快照（含视图/渲染配置），避免被服务端重载静默覆盖
            const localSnapshot: MindMapConflictSnapshot | null = savingMindmapId
              ? {
                  mindmapId: savingMindmapId,
                  document: get().document,
                  currentView: get().currentView,
                  focusedNodeId: get().focusedNodeId,
                  layoutId: get().layoutId,
                  layoutDirection: get().layoutDirection,
                  styleId: get().styleId,
                  edgeType: get().edgeType,
                }
              : null;
            // 清除过期本地草稿，避免 loadMindMap 恢复出冲突的旧版本
            if (savingMindmapId) {
              clearDraft(savingMindmapId);
            }
            // 自动重新加载服务端最新版本
            if (get().mindmapId === savingMindmapId) {
              try {
                await get().loadMindMap(savingMindmapId);
                // ★ A6-24: 重载完成后再写入快照（避免被 loadMindMap 的状态重置覆盖）
                if (localSnapshot && get().mindmapId === savingMindmapId) {
                  set((state) => {
                    state.conflictSnapshot = localSnapshot;
                  });
                  showGlobalNotification('warning', i18next.t('store.conflictSnapshotKept', { ns: 'mindmap' }));
                } else {
                  showGlobalNotification('success', i18next.t('store.conflictResolved', { ns: 'mindmap' }));
                }
              } catch (reloadError) {
                console.error('[MindMapStore] conflict auto-reload failed:', reloadError);
                showGlobalNotification('error', i18next.t('store.conflictReloadFailed', { ns: 'mindmap' }));
              }
            }
            return false;
          }

          const isStructuralError =
            errorMessage.includes('depth exceeds') ||
            errorMessage.includes('node count exceeds') ||
            errorMessage.includes('Invalid JSON') ||
            errorMessage.includes('VALIDATION') ||
            errorMessage.includes('too large') ||
            errorMessage.includes('size exceeds');

          let userMessage = i18next.t('store.saveFailed', { ns: 'mindmap' });
          if (errorMessage.includes('Mindmap depth exceeds limit')) {
            userMessage = i18next.t('store.depthExceeded', { ns: 'mindmap' });
          } else if (errorMessage.includes('Mindmap node count exceeds limit')) {
            userMessage = i18next.t('store.nodeCountExceeded', { ns: 'mindmap' });
          } else if (errorMessage.includes('Invalid JSON')) {
            userMessage = i18next.t('store.invalidContent', { ns: 'mindmap' });
          }

          const nextRetry = saveRetryCount + 1;
          const canAutoRetry = !isStructuralError && nextRetry <= MAX_SAVE_AUTO_RETRIES;

          // 首次失败提示一次；自动重试过程中不再刷 toast；超限后改提示需手动保存
          if (isStructuralError) {
            showGlobalNotification('error', userMessage, i18next.t('store.saveFailedTitle', { ns: 'mindmap' }));
            saveRetryCount = nextRetry;
          } else if (canAutoRetry) {
            if (saveRetryCount === 0) {
              showGlobalNotification('error', userMessage, i18next.t('store.saveFailedTitle', { ns: 'mindmap' }));
            }
            saveRetryCount = nextRetry;
            if (!retrySaveTimer) {
              const delayMs = SAVE_RETRY_BASE_DELAY_MS * nextRetry; // 5s / 10s / 15s
              retrySaveTimer = setTimeout(() => {
                retrySaveTimer = null;
                void get().save();
              }, delayMs);
            }
          } else {
            saveRetryCount = nextRetry;
            showGlobalNotification(
              'error',
              i18next.t('store.saveRetryExhausted', { ns: 'mindmap' }),
              i18next.t('store.saveFailedTitle', { ns: 'mindmap' })
            );
          }
          return false;
        }
      },

      // A6-24: 把暂存的本地冲突快照重新应用为当前文档
      restoreConflictSnapshot: () => {
        const snap = get().conflictSnapshot;
        if (!snap) return;
        // 仅当仍停留在同一导图时才恢复，避免把快照写到别的导图
        if (get().mindmapId !== snap.mindmapId) {
          set((state) => {
            state.conflictSnapshot = null;
          });
          return;
        }
        pushHistory(get().document, captureUiSnapshot(get()));
        lastCoalesce = null;
        set((state) => {
          state.document = snap.document;
          state.currentView = snap.currentView;
          state.focusedNodeId = snap.focusedNodeId;
          state.layoutId = snap.layoutId;
          state.layoutDirection = snap.layoutDirection;
          state.styleId = snap.styleId;
          state.edgeType = snap.edgeType;
          state.isDirty = true;
          state._documentVersion += 1;
          state.conflictSnapshot = null;
        });
        const nextState = get();
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }
        // 以重载后的最新基线保存，使"我的修改"覆盖服务端
        debounceSave();
      },

      // A6-24: 放弃暂存快照，采用已重载的服务端版本
      dismissConflictSnapshot: () => {
        set((state) => {
          state.conflictSnapshot = null;
        });
      },

      markDirty: () => {
        set((state) => {
          state.isDirty = true;
          state._documentVersion += 1;
        });
        scheduleDraftPersist();
        debounceSave();
      },

      // M-069: 同步写入 localStorage 草稿（组件卸载 / beforeunload / pagehide 时调用）
      saveDraftSync: () => {
        persistDraftNow();
      },

      // 设置布局
      // D1：布局/样式变更需要标脏并触发保存，否则「只改主题/方向后切走」会丢失渲染配置
      setLayoutId: (layoutId: string) => {
        if (get().layoutId === layoutId) return;
        applyRenderConfigChange((state) => {
          state.layoutId = layoutId;
        });
      },

      // 设置布局方向
      setLayoutDirection: (direction: LayoutDirection) => {
        if (get().layoutDirection === direction) return;
        applyRenderConfigChange((state) => {
          state.layoutDirection = direction;
        });
      },

      // 设置样式主题
      setStyleId: (styleId: string) => {
        if (get().styleId === styleId) return;
        applyRenderConfigChange((state) => {
          state.styleId = styleId;
        });
      },

      // 设置边类型
      setEdgeType: (edgeType: EdgeType) => {
        if (get().edgeType === edgeType) return;
        applyRenderConfigChange((state) => {
          state.edgeType = edgeType;
        });
      },

      // 记录节点实测高度
      setMeasuredNodeHeight: (nodeId: string, height: number) => {
        if (!nodeId || !Number.isFinite(height) || height <= 0) {
          return;
        }
        measuredHeightsQueue.set(nodeId, height);
        if (measuredFlushTimer) {
          return;
        }
        measuredFlushTimer = setTimeout(() => {
          measuredFlushTimer = null;
          flushMeasuredNodeHeights();
        }, 16);
      },

      // 应用预设（D1：同 setLayoutId，需持久化渲染配置）
      applyPreset: (presetId: string) => {
        const preset = PresetRegistry.get(presetId);
        if (!preset) return;
        const s = get();
        const nextStyleId = preset.styleId || 'default';
        const nextEdgeType = (preset.edgeType || 'bezier') as EdgeType;
        if (
          s.layoutId === preset.layoutId &&
          s.layoutDirection === preset.layoutDirection &&
          s.styleId === nextStyleId &&
          s.edgeType === nextEdgeType
        ) {
          return;
        }
        applyRenderConfigChange((state) => {
          state.layoutId = preset.layoutId;
          state.layoutDirection = preset.layoutDirection as LayoutDirection;
          state.styleId = nextStyleId;
          state.edgeType = nextEdgeType;
        });
      },

      // 获取当前渲染配置
      getRenderConfig: (): MindMapRenderConfig => {
        const state = get();
        return {
          layoutId: state.layoutId,
          direction: state.layoutDirection,
          styleId: state.styleId,
          edgeType: state.edgeType,
          layoutConfig: { ...DEFAULT_LAYOUT_CONFIG, direction: state.layoutDirection },
        };
      },

      // 注册 ReactFlow 实例（用于图片导出）
      setReactFlowGetter: (getter) => {
        set((state) => {
          state._reactFlowGetter = getter as typeof state._reactFlowGetter;
        });
      },

      // 背诵模式
      setReciteMode: (enabled: boolean) => {
        set((state) => {
          state.reciteMode = enabled;
          if (!enabled) {
            state.revealedBlanks = {};
          }
          // 进入背诵模式时退出编辑状态
          if (enabled) {
            state.editingNodeId = null;
            state.editingNoteNodeId = null;
          }
        });
      },

      setHideCompleted: (hide: boolean) => {
        set((state) => {
          state.hideCompleted = hide;
          if (hide) reconcileFilteredInteractionState(state);
        });
      },

      revealBlank: (nodeId: string, rangeIndex: number) => {
        set((state) => {
          if (!state.revealedBlanks[nodeId]) {
            state.revealedBlanks[nodeId] = {};
          }
          state.revealedBlanks[nodeId][rangeIndex] = true;
        });
      },

      revealAllBlanks: () => {
        set((state) => {
          const allBlanks: Record<string, Record<number, boolean>> = {};
          const collect = (node: MindMapNode) => {
            if (node.blankedRanges && node.blankedRanges.length > 0) {
              const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
              const revealed: Record<number, boolean> = {};
              for (let i = 0; i < merged.length; i++) {
                revealed[i] = true;
              }
              allBlanks[node.id] = revealed;
            }
            node.children.forEach(collect);
          };
          collect(state.document.root);
          state.revealedBlanks = allBlanks;
        });
      },

      resetAllBlanks: () => {
        set((state) => {
          state.revealedBlanks = {};
        });
      },

      addBlankRange: (nodeId: string, range: BlankRange) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node) return;
          const existing = node.blankedRanges || [];
          node.blankedRanges = mergeRanges(validateRanges([...existing, range], node.text.length));
        });
      },

      removeBlankRange: (nodeId: string, rangeIndex: number) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node || !node.blankedRanges) return;
          const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
          merged.splice(rangeIndex, 1);
          node.blankedRanges = merged.length > 0 ? merged : undefined;
          // 重建 revealed 索引映射：splice 后索引整体前移
          const oldRevealed = state.revealedBlanks[nodeId];
          if (oldRevealed) {
            if (merged.length === 0) {
              delete state.revealedBlanks[nodeId];
            } else {
              const newRevealed: Record<number, boolean> = {};
              for (const [key, val] of Object.entries(oldRevealed)) {
                const oldIdx = Number(key);
                if (oldIdx < rangeIndex) {
                  newRevealed[oldIdx] = val;
                } else if (oldIdx > rangeIndex) {
                  newRevealed[oldIdx - 1] = val;
                }
                // oldIdx === rangeIndex 的条目被删除，不保留
              }
              if (Object.keys(newRevealed).length > 0) {
                state.revealedBlanks[nodeId] = newRevealed;
              } else {
                delete state.revealedBlanks[nodeId];
              }
            }
          }
        });
      },

      clearNodeBlanks: (nodeId: string) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (node) {
            delete node.blankedRanges;
          }
          delete state.revealedBlanks[nodeId];
        });
      },

      // 搜索节点
      search: (query: string, options?: SearchOptions) => {
        const searchOptions = options ?? {};
        if (!query.trim()) {
          set((state) => {
            state.searchQuery = '';
            state.searchOptions = searchOptions;
            state.searchResults = [];
            state.currentSearchIndex = -1;
          });
          return;
        }

        const { document } = get();
        const results = searchMindMapNodeIds(document.root, query, searchOptions);

        set((state) => {
          state.searchQuery = query;
          state.searchOptions = searchOptions;
          state.searchResults = results;
          state.currentSearchIndex = results.length > 0 ? 0 : -1;
          reconcileFilteredInteractionState(state);
        });

        if (results.length > 0) {
          get().expandToNode(results[0], { silent: true });
          set((state) => {
            state.focusedNodeId = results[0];
          });
        }
      },

      // 下一个搜索结果
      nextSearchResult: () => {
        const { searchResults, currentSearchIndex } = get();
        if (searchResults.length === 0) return;

        const nextIndex = (currentSearchIndex + 1) % searchResults.length;
        const nodeId = searchResults[nextIndex];

        get().expandToNode(nodeId, { silent: true });
        set((state) => {
          state.currentSearchIndex = nextIndex;
          state.focusedNodeId = nodeId;
        });
      },

      // 上一个搜索结果
      prevSearchResult: () => {
        const { searchResults, currentSearchIndex } = get();
        if (searchResults.length === 0) return;

        const prevIndex =
          currentSearchIndex <= 0 ? searchResults.length - 1 : currentSearchIndex - 1;
        const nodeId = searchResults[prevIndex];

        get().expandToNode(nodeId, { silent: true });
        set((state) => {
          state.currentSearchIndex = prevIndex;
          state.focusedNodeId = nodeId;
        });
      },

      // 清除搜索
      clearSearch: () => {
        set((state) => {
          state.searchQuery = '';
          state.searchOptions = {};
          state.searchResults = [];
          state.currentSearchIndex = -1;
        });
      },

      setSearchFilterMode: (enabled: boolean) => {
        set((state) => {
          state.searchFilterMode = enabled;
          if (enabled) reconcileFilteredInteractionState(state);
        });
      },

      // 展开到指定节点
      expandToNode: (nodeId: string, options) => {
        const { document } = get();

        const findPath = (
          node: MindMapNode,
          targetId: string,
          path: string[]
        ): string[] | null => {
          if (node.id === targetId) return path;
          for (const child of node.children) {
            const result = findPath(child, targetId, [...path, node.id]);
            if (result) return result;
          }
          return null;
        };

        const path = findPath(document.root, nodeId, []);
        if (!path) return;

        applyMutation((state) => {
          for (const id of path) {
            const node = findNodeById(state.document.root, id);
            if (node) {
              node.collapsed = false;
            }
          }
        }, {
          skipHistory: options?.silent ?? false,
          skipSave: options?.silent ?? false,
          markDirty: !(options?.silent ?? false),
        });
      },

      copyNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds);
        const nodeById = buildNodeIndex(document.root).nodeById;
        const copiedNodes: MindMapNode[] = [];

        for (const nodeId of normalizedIds) {
          const node = nodeById.get(nodeId);
          if (node) {
            copiedNodes.push(JSON.parse(JSON.stringify(node)));
          }
        }

        if (copiedNodes.length > 0) {
          set((state) => {
            state.clipboard = {
              nodes: copiedNodes,
              sourceOperation: 'copy',
              copiedAt: Date.now(),
            };
          });
        }
      },

      cutNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, { excludeRoot: true });
        if (normalizedIds.length === 0) return;
        const treeIndex = buildNodeIndex(document.root);
        const removedIds = collectNodeAndDescendantIds(document.root, normalizedIds);

        const copiedNodes: MindMapNode[] = [];
        for (const nodeId of normalizedIds) {
          const node = treeIndex.nodeById.get(nodeId);
          if (node) {
            copiedNodes.push(JSON.parse(JSON.stringify(node)));
          }
        }

        if (copiedNodes.length === 0) return;

        let nextFocusedNodeId = document.root.id;
        for (const nodeId of normalizedIds) {
          const parent = treeIndex.parentById.get(nodeId);
          if (parent) {
            nextFocusedNodeId = parent.id;
            break;
          }
        }

        applyMutation((state) => {
          state.clipboard = {
            nodes: copiedNodes,
            sourceOperation: 'cut',
            copiedAt: Date.now(),
          };

          removeNodesById(state.document.root, new Set(normalizedIds));
          afterRemoveNodes(state, removedIds, nextFocusedNodeId);
        });
      },

      pasteNodes: (targetId: string, mode: 'child' | 'sibling-after' = 'child') => {
        const { clipboard, document } = get();
        if (!clipboard || clipboard.nodes.length === 0) return;

        // C4：sibling-after 贴到 target 的父节点内、target 之后；target 为根时回退为 child
        const siblingParent =
          mode === 'sibling-after' ? findParentNode(document.root, targetId) : null;
        const effectiveMode: 'child' | 'sibling-after' =
          mode === 'sibling-after' && siblingParent ? 'sibling-after' : 'child';
        const insertParentId = effectiveMode === 'sibling-after' ? siblingParent!.id : targetId;

        const parentDepth = getNodeDepth(document.root, insertParentId);
        if (parentDepth < 0) return;
        const pendingCount = clipboard.nodes.reduce((sum, node) => sum + countNodes(node), 0);
        if (countNodes(document.root) + pendingCount > MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return;
        }
        const pendingHeight = Math.max(...clipboard.nodes.map(getSubtreeHeight));
        if (parentDepth + 1 + pendingHeight >= MAX_MINDMAP_DEPTH) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          return;
        }

        const usedIds = new Set(buildNodeIndex(document.root).nodeById.keys());
        const nextNodeId = () => {
          let id = `node_${nanoid(10)}`;
          while (usedIds.has(id)) id = `node_${nanoid(10)}`;
          usedIds.add(id);
          return id;
        };
        function regenerateIds(node: MindMapNode): MindMapNode {
          return {
            ...node,
            id: nextNodeId(),
            children: node.children.map(child => regenerateIds(child)),
          };
        }
        const sourceForest = JSON.parse(JSON.stringify(clipboard.nodes)) as MindMapNode[];
        const forest = sourceForest.map(regenerateIds);
        const clearClipboard = clipboard.sourceOperation === 'cut';

        applyMutation((state) => {
          const parentNode = findNodeById(state.document.root, insertParentId);
          if (!parentNode) return;
          if (effectiveMode === 'sibling-after') {
            const targetIndex = parentNode.children.findIndex((child) => child.id === targetId);
            const insertAt = targetIndex >= 0 ? targetIndex + 1 : parentNode.children.length;
            parentNode.children.splice(insertAt, 0, ...forest);
          } else {
            // 与 addNode 一致：折叠父下粘贴时自动展开，避免节点存在但不可见
            if (parentNode.collapsed === true) parentNode.collapsed = false;
            parentNode.children.push(...forest);
          }
          state.focusedNodeId = forest[0].id;
          if (clearClipboard) state.clipboard = null;
        });
      },

      pasteTextChildren: (targetId: string, lines: string[]) => {
        const texts = lines.map((line) => line.trim()).filter(Boolean);
        if (texts.length === 0) return;

        const { document } = get();
        const parentDepth = getNodeDepth(document.root, targetId);
        if (parentDepth < 0) return;
        if (parentDepth + 1 >= MAX_MINDMAP_DEPTH) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          return;
        }
        if (countNodes(document.root) + texts.length > MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return;
        }

        const usedIds = new Set(buildNodeIndex(document.root).nodeById.keys());
        const nodes = texts.map((text) => {
          let id = `node_${nanoid(10)}`;
          while (usedIds.has(id)) id = `node_${nanoid(10)}`;
          usedIds.add(id);
          return { id, text, children: [] } satisfies MindMapNode;
        });

        applyMutation((state) => {
          const parentNode = findNodeById(state.document.root, targetId);
          if (!parentNode) return;
          // 与 addNode 一致：折叠父下粘贴时自动展开
          if (parentNode.collapsed === true) parentNode.collapsed = false;
          parentNode.children.push(...nodes);
          state.focusedNodeId = nodes[0].id;
        });
      },

      pasteMarkdownChildren: (
        targetId: string,
        markdown: string,
        options?: { currentText?: string; position?: 'child' | 'sibling-after' },
      ) => {
        let forest: MindMapNode[];
        try {
          forest = markdownListToNodes(markdown);
        } catch (error) {
          console.error('[MindMapStore] pasteMarkdownChildren parse failed:', error);
          return;
        }
        if (forest.length === 0) return;

        const { document } = get();
        // C0.2：'sibling-after' 把森林插到 targetId 之后同级；target 为根时回退为 child
        const siblingParent =
          options?.position === 'sibling-after'
            ? findParentNode(document.root, targetId)
            : null;
        const effectivePosition: 'child' | 'sibling-after' =
          options?.position === 'sibling-after' && siblingParent
            ? 'sibling-after'
            : 'child';
        const insertParentId =
          effectivePosition === 'sibling-after' ? siblingParent!.id : targetId;
        const parentDepth = getNodeDepth(document.root, insertParentId);
        if (parentDepth < 0) return;

        const totalNodes = countNodes(document.root);
        const pendingCount = forest.reduce((sum, n) => sum + countNodes(n), 0);

        if (totalNodes + pendingCount > MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return;
        }

        const maxExtraDepth = (nodes: MindMapNode[], depth = 1): number => {
          let max = depth;
          for (const n of nodes) {
            if (n.children.length > 0) {
              max = Math.max(max, maxExtraDepth(n.children, depth + 1));
            } else {
              max = Math.max(max, depth);
            }
          }
          return max;
        };
        if (parentDepth + maxExtraDepth(forest) >= MAX_MINDMAP_DEPTH) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          return;
        }

        applyMutation((state) => {
          const targetNode = findNodeById(state.document.root, targetId);
          if (!targetNode) return;

          if (options && Object.prototype.hasOwnProperty.call(options, 'currentText')) {
            const nextText = options.currentText ?? '';
            if (nextText !== targetNode.text) {
              targetNode.text = nextText;
              // Text offsets are no longer valid after an actual title edit.
              delete targetNode.blankedRanges;
              delete state.revealedBlanks[targetId];
            }
          }

          if (effectivePosition === 'sibling-after') {
            const liveParent = findParentNode(state.document.root, targetId);
            if (!liveParent) return;
            const targetIndex = liveParent.children.findIndex(
              (child) => child.id === targetId,
            );
            const insertAt =
              targetIndex >= 0 ? targetIndex + 1 : liveParent.children.length;
            liveParent.children.splice(insertAt, 0, ...forest);
          } else {
            // 与 addNode 一致：折叠父下粘贴时自动展开
            if (targetNode.collapsed === true) targetNode.collapsed = false;
            targetNode.children.push(...forest);
          }
          if (forest[0]) {
            state.focusedNodeId = forest[0].id;
          }
        });
      },
    };
    })
  );
}

export const defaultMindMapStore = createMindMapStore();

/**
 * MindMapContentView 为每个资源实例提供独立 store；未挂 Provider 的旧入口继续
 * 使用 defaultMindMapStore，保持既有 API 兼容。
 */
export const MindMapStoreContext = createContext<MindMapStoreApi | null>(null);

export function useMindMapStoreApi(): MindMapStoreApi {
  return useContext(MindMapStoreContext) ?? defaultMindMapStore;
}

type MindMapStoreHook = {
  <T>(selector: (state: MindMapStoreState) => T): T;
} & MindMapStoreApi;

const useMindMapStoreSelector = <T,>(selector: (state: MindMapStoreState) => T): T => {
  return useStore(useMindMapStoreApi(), selector);
};

export const useMindMapStore = Object.assign(
  useMindMapStoreSelector,
  defaultMindMapStore,
) as MindMapStoreHook;

const registeredStores = new Map<string, MindMapStoreApi[]>();
const registeredStoresByInstance = new Map<
  string,
  { resourceId: string; store: MindMapStoreApi }
>();
interface MindMapStoreReadyWaiter {
  instanceId?: string;
  windowId?: string;
  callback: (store: MindMapStoreApi) => void;
}
const readyWaiters = new Map<string, Set<MindMapStoreReadyWaiter>>();

function flushReadyWaiters(resourceId: string): void {
  const waiters = readyWaiters.get(resourceId);
  if (!waiters || waiters.size === 0) return;
  for (const waiter of [...waiters]) {
    const store = waiter.instanceId
      ? getMindMapStoreForInstance(waiter.instanceId, resourceId)
      : waiter.windowId
        ? getMindMapStoreForWindow(waiter.windowId, resourceId)
      : getMindMapStoreForResource(resourceId);
    if (!store || store.getState().mindmapId !== resourceId) continue;
    waiters.delete(waiter);
    waiter.callback(store);
  }
  if (waiters.size === 0) readyWaiters.delete(resourceId);
}

/** 注册一个已挂载的资源实例；同资源多实例时最近注册者优先。 */
export function registerMindMapStore(
  resourceId: string,
  store: MindMapStoreApi,
  instanceId?: string,
): () => void {
  const current = registeredStores.get(resourceId) ?? [];
  registeredStores.set(resourceId, [...current.filter((item) => item !== store), store]);
  if (instanceId) registeredStoresByInstance.set(instanceId, { resourceId, store });
  const unsubscribeStore = store.subscribe(() => flushReadyWaiters(resourceId));
  flushReadyWaiters(resourceId);
  return () => {
    unsubscribeStore();
    const next = (registeredStores.get(resourceId) ?? []).filter((item) => item !== store);
    if (next.length > 0) registeredStores.set(resourceId, next);
    else registeredStores.delete(resourceId);
    if (instanceId && registeredStoresByInstance.get(instanceId)?.store === store) {
      registeredStoresByInstance.delete(instanceId);
    }
    flushReadyWaiters(resourceId);
  };
}

/** Agent/Workbench 按资源定位实例；默认 store 仅作为旧入口兼容回退。 */
export function getMindMapStoreForResource(resourceId: string): MindMapStoreApi | null {
  const stores = registeredStores.get(resourceId);
  if (stores && stores.length > 0) return stores[stores.length - 1] ?? null;
  return defaultMindMapStore.getState().mindmapId === resourceId
    ? defaultMindMapStore
    : null;
}

/** Workbench activation 按窗口实例精确定位，避免同资源多宿主时命中最近注册者。 */
export function getMindMapStoreForInstance(
  instanceId: string,
  resourceId?: string,
): MindMapStoreApi | null {
  const entry = registeredStoresByInstance.get(instanceId);
  if (!entry || (resourceId && entry.resourceId !== resourceId)) return null;
  return entry.store;
}

/** Resolve a resource instance owned by a Workbench window, including nested pane ids. */
export function getMindMapStoreForWindow(
  windowId: string,
  resourceId: string,
): MindMapStoreApi | null {
  let matched: MindMapStoreApi | null = null;
  const panePrefix = `${windowId}:`;
  for (const [instanceId, entry] of registeredStoresByInstance) {
    if (
      entry.resourceId === resourceId
      && (instanceId === windowId || instanceId.startsWith(panePrefix))
    ) {
      matched = entry.store;
    }
  }
  return matched;
}

/** 在指定资源的实例完成加载后执行一次；返回取消等待的清理函数。 */
export function subscribeMindMapStoreReady(
  resourceId: string,
  callback: (store: MindMapStoreApi) => void,
  instanceId?: string,
): () => void {
  const readyStore = instanceId
    ? getMindMapStoreForInstance(instanceId, resourceId)
    : getMindMapStoreForResource(resourceId);
  if (readyStore?.getState().mindmapId === resourceId) {
    callback(readyStore);
    return () => undefined;
  }

  const waiters = readyWaiters.get(resourceId) ?? new Set<MindMapStoreReadyWaiter>();
  const waiter = { instanceId, callback };
  waiters.add(waiter);
  readyWaiters.set(resourceId, waiters);
  return () => {
    const current = readyWaiters.get(resourceId);
    if (!current) return;
    current.delete(waiter);
    if (current.size === 0) readyWaiters.delete(resourceId);
  };
}

/** Wait for a resource surface belonging to one Workbench window or nested pane. */
export function subscribeMindMapStoreReadyForWindow(
  resourceId: string,
  windowId: string,
  callback: (store: MindMapStoreApi) => void,
): () => void {
  const readyStore = getMindMapStoreForWindow(windowId, resourceId);
  if (readyStore?.getState().mindmapId === resourceId) {
    callback(readyStore);
    return () => undefined;
  }

  const waiters = readyWaiters.get(resourceId) ?? new Set<MindMapStoreReadyWaiter>();
  const waiter = { windowId, callback };
  waiters.add(waiter);
  readyWaiters.set(resourceId, waiters);
  return () => {
    const current = readyWaiters.get(resourceId);
    if (!current) return;
    current.delete(waiter);
    if (current.size === 0) readyWaiters.delete(resourceId);
  };
}

/** 仅供测试清理资源实例注册表。 */
export function __resetMindMapStoreRegistry(): void {
  registeredStores.clear();
  registeredStoresByInstance.clear();
  readyWaiters.clear();
}
