/**
 * mindmapStore 公共类型：状态形状、历史条目、冲突快照、视口。
 * 独立成模块，供 store 入口、runtime 与各 slice 引用（避免循环依赖）。
 */

import type {
  MindMapDocument,
  MindMapNode,
  MindMapNodeRef,
  LayoutDirection,
  EdgeType,
  MindMapRenderConfig,
  UpdateNodeParams,
  BlankRange,
  VfsMindMap,
  MindMapViewType,
} from '../types';
import type { SearchOptions } from '../utils/searchFilter';
import type { ReciteReviewItem, ReciteSessionLog } from '../utils/reciteStats';

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
   * ACR 4.0 A4：Agent 删除演出的退场节点（瞬态，不进 history/draft/持久化）。
   * mindmapDriver 在真正删除前 mark，画布/大纲追加 `agent-exiting` className
   * 播 150-200ms opacity+translateY 退场动画，动画结束后 driver 再删除并 clear。
   */
  agentExitingIds: Set<string>;
  markAgentExiting: (ids: string[]) => void;
  clearAgentExiting: (ids: string[]) => void;

  /**
   * ACR 4.0 A4：Agent update_node 的内容更新高亮（瞬态）。
   * 与 entering（新增=滑入）区分语义：updated=背景一次渐隐 flash，不做位移。
   */
  agentUpdatedIds: Set<string>;
  markAgentUpdated: (ids: string[]) => void;
  clearAgentUpdated: (ids: string[]) => void;

  /**
   * ACR R2-02：Agent 批量演出结束时请求一次 fitView（画布订阅 nonce 变化）。
   * 不进 history / 不标脏。
   */
  agentFitViewNonce: number;
  requestAgentFitView: () => void;

  /**
   * 引用回链定位（瞬态，不进 history/draft/持久化）：聊天引用 / 知识库命中
   * 打开导图后请求「展开祖先 + 选中 + 居中」某节点。画布/大纲订阅 nonce，
   * requestedAt 用于过期判断（切视图重挂载不重放陈旧请求）。
   */
  nodeLocateRequest: { nodeId: string; nonce: number; requestedAt: number } | null;
  /** 展开祖先、退出不含该节点的分支专注、选中并聚焦，再发出居中请求；节点不存在返回 false */
  locateNode: (nodeId: string) => boolean;

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
  /**
   * 本会话背诵事件日志（粘性，只置位）：翻开 = miss、遮盖态呈现、显示全部。
   * 退出背诵时据此提交统计——只有实际呈现/作答的空才进入历史，
   * 重新遮盖不会抹掉已发生的 miss（记录的是会话事件，不是退出瞬间的 UI 状态）。
   */
  reciteSessionLog: ReciteSessionLog;
  setReciteMode: (enabled: boolean) => void;
  revealBlank: (nodeId: string, rangeIndex: number) => void;
  /** 遮盖态挖空实际渲染进视口时上报（BlankedText 的 IntersectionObserver 驻留信号） */
  markBlanksPresented: (nodeId: string, rangeIndices: number[]) => void;
  revealAllBlanks: () => void;
  resetAllBlanks: () => void;
  /**
   * 难点优先复习队列（按历史错误率排序，非 SRS——无 due/间隔调度）：
   * 带挖空节点列表；null = 未在复习流程中。退出背诵模式自动清空。
   */
  reciteReviewQueue: ReciteReviewItem[] | null;
  reciteReviewIndex: number;
  /**
   * 开始难点优先复习：从持久化统计构建队列（专注分支时限定 viewRoot 子树），
   * 聚焦第一个节点并进入背诵模式。返回队列长度（0 = 范围内无挖空）。
   */
  startReciteReview: () => number;
  /** 复习队列前进/后退（越界钳制），并聚焦目标节点 */
  stepReciteReview: (delta: number) => void;
  /** 退出复习流程（保留背诵模式本身） */
  stopReciteReview: () => void;
  addBlankRange: (nodeId: string, range: BlankRange) => void;
  removeBlankRange: (nodeId: string, rangeIndex: number) => void;
  clearNodeBlanks: (nodeId: string) => void;
  /**
   * 按分支批量挖空：对 nodeId 子树内所有非空文本节点整行挖空（含自身），
   * 已有挖空区间的节点合并为整行。返回受影响节点数（单次 undo 还原整批）。
   */
  blankBranchNodes: (nodeId: string) => number;
  /**
   * 背诵一键遮住要点：保留中心主题与一级分支作提示，第 2 层起非空节点整行挖空
   * （整图只有一层时遮一级分支）。返回受影响节点数（单次 undo 还原整批）。
   */
  blankOutlineForRecite: () => number;
  /** 清除 nodeId 子树（含自身）的全部挖空与揭示状态。返回受影响节点数。 */
  clearBranchBlanks: (nodeId: string) => number;

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
    opts?: { preserveViewports?: boolean; preserveLocalChanges?: boolean },
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
   * 拆分行惯例：当前节点保留光标前文本，光标后文本成为下方新同级节点；子树留在原节点。
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
   * @param prevVisibleNodeId 大纲传入其可见列表中的上一行（额外尊重
   * hideCompleted / 搜索过滤）。显式传 null 表示视图内无上一行 → 拒绝合并；
   * 缺省（undefined）保持旧解析逻辑。无效 id 回落旧解析。
   * @returns 合并目标与光标位置，供 UI 恢复
   */
  mergeWithPrevious: (
    nodeId: string,
    textOverride?: string,
    scopeRootId?: string,
    prevVisibleNodeId?: string | null,
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

  // 跨分支关联线
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
