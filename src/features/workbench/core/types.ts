/**
 * Workbench 冻结契约（P0 — 所有子代理只读）
 *
 * 本文件是学习 OS（Workbench）模块的唯一类型真相源。
 * 任何子代理不得修改本文件中已有的导出签名；如确需扩展，
 * 只能【新增】可选字段/新导出，并在 PR 描述中说明。
 *
 * 设计文档：docs/dev/learning-os-workbench-design.md
 * 编排文档：docs/dev/learning-os-10-agent-parallel-prompts.md
 */
import type React from 'react';

// ============================================================================
// 几何与窗口
// ============================================================================

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export type DisplayMode =
  | 'floating'
  | 'maximized'
  | 'tiled-left'
  | 'tiled-right'
  | 'tiled-tl'
  | 'tiled-tr'
  | 'tiled-bl'
  | 'tiled-br';

/** 由 scheduler 派生，绝不持久化 */
export type WindowLifecycle = 'focused' | 'visible' | 'background' | 'frozen';

export interface WorkbenchWindow {
  /** 壳身份（nanoid） */
  id: string;
  typeId: string;
  /** 业务身份，如 'note_xxx' / 'sess_xxx'；single 应用为 null */
  instanceKey: string | null;
  title: string;
  /** floating 时的位置尺寸；tiled/maximized 时为落位前快照的冗余（渲染以 computeTiledFrame 为准） */
  frame: Frame;
  /** 进入 tiled/maximized 前的原始 frame（macOS 恢复语义） */
  restoreFrame: Frame | null;
  displayMode: DisplayMode;
  minimized: boolean;
  zIndex: number;
  createdAt: number;
  lastFocusedAt: number;
}

// ============================================================================
// 应用契约
// ============================================================================

export interface ActivationContext {
  windowId: string;
  instanceKey: string | null;
  action: string;
  payload?: unknown;
}

/**
 * onActivation 可选结构化回执（ACR R2-10）。
 * 缺省 / void = 视为 handled:true（窗已命中且指令已送达）。
 */
export interface ActivationResult {
  handled: boolean;
  /** Set only after an activation receives an authoritative domain/UI acknowledgement. */
  acknowledged?: boolean;
  code?: string;
  hint?: string;
  message?: string;
}

export type ActivationHandlerResult = void | boolean | ActivationResult;

// ============================================================================
// Agent-native application contract (ACR 2.0)
// ============================================================================

/** JSON-only value used by schemas, observations, and persistent inverse actions. */
export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

/** Small JSON Schema subset. Unknown standard keywords are preserved for discovery clients. */
export interface AgentJsonSchema {
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object'
    | Array<'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object'>;
  title?: string;
  description?: string;
  properties?: Record<string, AgentJsonSchema>;
  required?: string[];
  items?: AgentJsonSchema;
  enum?: AgentJsonValue[];
  const?: AgentJsonValue;
  additionalProperties?: boolean | AgentJsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  oneOf?: AgentJsonSchema[];
  anyOf?: AgentJsonSchema[];
  [keyword: string]: unknown;
}

export type AgentCapabilityRisk = 'read' | 'low' | 'medium' | 'high';

/** One semantic action an application deliberately exposes to the Agent. */
export interface AgentCapability {
  name: string;
  description: string;
  inputSchema: AgentJsonSchema;
  outputSchema?: AgentJsonSchema;
  risk: AgentCapabilityRisk;
  mutates: boolean;
  reversible: boolean;
  idempotent: boolean;
  requiresFocus?: boolean;
  /** Optional affordance kinds this action can target (for example `todo-item`). */
  targetKinds?: string[];
  /** targetKinds normally requires targetRef; set only for genuinely global/bulk actions. */
  targetOptional?: boolean;
  /** Optional args path that must contain the exact same stable ref as targetRef. */
  targetRefPath?: string;
  /** Optional args path that must match the final id segment of targetRef. */
  targetIdPath?: string;
}

/** Opaque, domain-stable reference such as `todo:item:123`; never a DOM selector or coordinate. */
export type AgentStableRef = string;

export interface AgentEntitySummary {
  ref: AgentStableRef;
  kind: string;
  label?: string;
  description?: string;
  actions: string[];
  state?: Record<string, AgentJsonValue>;
}

/** Bounded semantic UI tree. It intentionally contains no DOM nodes, selectors, or coordinates. */
export interface AgentAffordanceNode {
  ref: AgentStableRef;
  kind: string;
  label?: string;
  description?: string;
  actions: string[];
  disabled?: boolean;
  selected?: boolean;
  value?: AgentJsonValue;
  children?: AgentAffordanceNode[];
}

export interface AgentAffordanceTree {
  roots: AgentAffordanceNode[];
  nodeCount: number;
  maxDepth: number;
  truncated: boolean;
}

export interface AgentDialogSummary {
  ref: AgentStableRef;
  kind: string;
  title?: string;
  message?: string;
  actions: string[];
}

/** State contributed by an app; the runtime adds authoritative window metadata and revision. */
export interface AgentObservationPatch {
  /** App/domain revision. The runtime folds this into the final composite revision. */
  revision?: string;
  route?: string;
  mode?: string;
  busy?: boolean;
  selection?: AgentStableRef[];
  availableActions?: string[];
  entities?: AgentEntitySummary[];
  affordances?: AgentAffordanceNode[];
  pendingDialog?: AgentDialogSummary;
  state?: Record<string, AgentJsonValue>;
}

export interface AgentObservation {
  version: 1;
  revision: string;
  observedAt: number;
  windowId: string;
  typeId: string;
  instanceKey: string | null;
  title: string;
  route?: string;
  mode?: string;
  focused: boolean;
  dirty: boolean;
  busy: boolean;
  selection: AgentStableRef[];
  availableActions: string[];
  entities: AgentEntitySummary[];
  affordances: AgentAffordanceTree;
  pendingDialog?: AgentDialogSummary;
  state: Record<string, AgentJsonValue>;
}

export type AgentObservationCondition =
  | { kind: 'revision_changed'; from?: string }
  | { kind: 'ref_exists'; ref: AgentStableRef }
  | { kind: 'ref_absent'; ref: AgentStableRef }
  | { kind: 'selection_includes'; ref: AgentStableRef }
  | { kind: 'action_available'; action: string; ref?: AgentStableRef }
  | { kind: 'state_equals'; path: string; value: AgentJsonValue };

export interface AgentActionCall {
  id?: string;
  name: string;
  args?: unknown;
  targetRef?: AgentStableRef;
  expect?: AgentObservationCondition[];
}

/** Serializable inverse actions can be recovered after reload and replayed by the manifest. */
export interface AgentUndoDescriptor {
  inverse: AgentActionCall | AgentActionCall[];
  label?: string;
}

export interface AgentActionResult extends ActivationResult {
  changed?: boolean;
  /** True only after the handler awaited an authoritative domain/UI acknowledgement. */
  acknowledged?: boolean;
  entityRefs?: AgentStableRef[];
  details?: Record<string, AgentJsonValue>;
  /** Result-specific postconditions used when the caller did not supply expect. */
  postconditions?: AgentObservationCondition[];
  undo?: AgentUndoDescriptor;
}

export interface AgentAppContext {
  windowId: string;
  typeId: string;
  instanceKey: string | null;
  runId?: string;
  sessionId?: string;
  /** Cooperative bridge cancellation for handlers that can stop in-flight work. */
  signal?: AbortSignal;
  /** Present for act only; records a session-memory closure in the existing run ledger. */
  registerUndo?: (invert: () => Promise<void> | void, label: string) => void;
  /** The fresh observation against which an action was validated. */
  observation?: AgentObservation;
}

export type AgentManifestHandlerResult =
  | ActivationHandlerResult
  | AgentActionResult;

export interface AppAgentManifest {
  version: string | number;
  description?: string;
  capabilities: readonly AgentCapability[];
  observe?: (
    ctx: AgentAppContext,
  ) => AgentObservationPatch | Promise<AgentObservationPatch>;
  execute?: (
    ctx: AgentAppContext,
    action: AgentActionCall,
  ) => AgentManifestHandlerResult | Promise<AgentManifestHandlerResult>;
}

export interface AgentWindowTarget {
  windowId?: string;
  typeId?: string;
  instanceKey?: string;
}

export interface AgentAppCapabilities {
  typeId: string;
  windowId?: string;
  instanceKey?: string | null;
  manifestVersion: string | number;
  description?: string;
  capabilities: AgentCapability[];
}

export interface AgentCapabilitiesResult {
  apps: AgentAppCapabilities[];
}

export interface AgentActRequest extends AgentWindowTarget {
  /** Required optimistic-concurrency token returned by observe. */
  observationRevision: string;
  /** Trusted bridge injection; omitted callers default to medium for compatibility. */
  approvalRiskCeiling?: AgentCapabilityRisk;
  actions: AgentActionCall[];
  expect?: AgentObservationCondition[];
  /** Defaults to true. */
  stopOnFailure?: boolean;
}

export interface AgentConditionFailure {
  condition: AgentObservationCondition;
  message: string;
}

export interface AgentActionOutcome {
  id?: string;
  index: number;
  name: string;
  targetRef?: AgentStableRef;
  handled: boolean;
  changed?: boolean;
  code?: string;
  hint?: string;
  message?: string;
  entityRefs?: AgentStableRef[];
  details?: Record<string, AgentJsonValue>;
  verified: boolean;
  verificationSource:
    | 'caller-postcondition'
    | 'result-postcondition'
    | 'handler-ack'
    | 'revision-change'
    | 'read-only-observation'
    | 'unverified';
  failedConditions: AgentConditionFailure[];
}

export type AgentUndoDurability = 'persistent' | 'session';

export interface AgentActReceipt {
  status: 'completed' | 'partial' | 'failed';
  windowId: string;
  typeId: string;
  beforeRevision: string;
  afterRevision: string;
  results: AgentActionOutcome[];
  verified: boolean;
  failedConditions: AgentConditionFailure[];
  undoToken?: string;
  undoDurability?: AgentUndoDurability;
  observation: AgentObservation;
}

export interface AgentWaitForRequest extends AgentWindowTarget {
  condition?: AgentObservationCondition;
  conditions?: AgentObservationCondition[];
  timeoutMs?: number;
  intervalMs?: number;
}

export interface AgentWaitForResult {
  matched: boolean;
  timedOut: boolean;
  elapsedMs: number;
  failedConditions: AgentConditionFailure[];
  observation: AgentObservation;
}

export interface AgentUndoResult {
  reverted: boolean;
  undoToken: string;
  durability: AgentUndoDurability;
  observation?: AgentObservation;
  code?: string;
  retryable?: boolean;
  message?: string;
}

export interface AppBadge {
  kind: 'count' | 'dot';
  value?: number;
}

export interface AppWindowProps {
  windowId: string;
  instanceKey: string | null;
  /** launch 时的瞬态载荷，绝不进快照 */
  launchPayload: unknown;
  /** lifecycle === 'focused' */
  isActive: boolean;
  /** lifecycle === 'focused' | 'visible'（降频渲染判断依据） */
  isVisible: boolean;
  /**
   * scheduler 渲染节流建议（ms）；0 = 全速。
   * ANTI-REGRESSION：Chat / PDF / 导图等重应用必须消费本字段
   * （流式降档或 useDragRenderPause）；声明却忽略会在拖窗时抢帧。
   */
  renderThrottleMs?: number;
  onTitleChange: (title: string) => void;
  /** 请求关闭：壳会先询问 AppDefinition.canClose */
  requestClose: () => void;
}

export interface AppDefinition {
  typeId: string;
  /** i18n key（namespace: workbench） */
  nameKey: string;
  icon: React.ReactNode;
  /** false when the window requires resource context and cannot be launched on its own. */
  showInLauncher?: boolean;
  instanceMode: 'single' | 'multi';
  /** 调度器内存预算权重：PDF/教材=3，编辑器/Chat/思维导图=2，纯展示=1 */
  memoryWeight: 1 | 2 | 3;
  /**
   * Keep the app mounted and visually present while another internal window
   * covers it. Native child surfaces need this so the platform clip host can
   * yield only the covered pixels instead of hiding the entire surface.
   */
  keepAliveWhenOccluded?: boolean;
  defaultFrame: Size;
  minSize: Size;
  render: React.LazyExoticComponent<React.FC<AppWindowProps>>;
  /** 一次性指令送达（scrollToMessage / gotoPage 等）；可返回结构化回执 */
  onActivation?: (
    ctx: ActivationContext,
  ) => ActivationHandlerResult | Promise<ActivationHandlerResult>;
  /** Optional, self-describing semantic control surface for ACR 2.0. */
  agentManifest?: AppAgentManifest;
  /** Dock 角标数据源（拉模式，Dock 轮询/订阅由 Dock 实现决定） */
  badgeSource?: () => AppBadge | null;
  /** 关闭拦截（未保存提示）；返回 false 阻止关闭。缺省 = 直接关 */
  canClose?: (instanceKey: string | null) => boolean | Promise<boolean>;
  /**
   * Ctrl+W is normally owned by the workbench window manager. Tabbed apps can
   * opt in to receive it themselves, for example to close their active tab.
   */
  handlesCloseShortcut?: boolean;
}

// ============================================================================
// Bus 请求
// ============================================================================

export type LaunchReason = 'dock' | 'api' | 'shortcut' | 'files' | 'command';

export interface LaunchRequest {
  typeId: string;
  instanceKey?: string;
  /** 瞬态，不进快照 */
  payload?: unknown;
  /** 桌面坐标系落点；仅新建窗口生效，窗口以该点为中心并钳制进桌面。 */
  dropPoint?: { x: number; y: number };
  reason: LaunchReason;
}

export interface ActivateRequest {
  typeId: string;
  instanceKey: string;
  action: string;
  payload?: unknown;
  /** 目标窗口不存在时的兜底 launch */
  fallbackLaunch?: LaunchRequest;
}

export interface ProjectRequest {
  typeId: string;
  instanceKey: string;
  title: string;
  initialFrame?: Partial<Frame>;
}

// ============================================================================
// 快照（白名单字段，sanitizer 依据）
// ============================================================================

export interface WorkbenchSnapshotV1 {
  version: 1;
  windows: WorkbenchWindow[];
  dockPinned: string[];
  /** key: `${leftWindowId}:${rightWindowId}`，value: 左侧占比 0–1 */
  tilingRatios: Record<string, number>;
  wallpaper?: { kind: 'theme' | 'image'; value: string };
  materialTier?: MaterialTier;
  /**
   * O11 追加（可选）：快照保存时的桌面尺寸。
   * 恢复时若与当前桌面不一致，hydrate 按比例缩放窗口位置并钳回可视区
   * （多显示器 / 分辨率变化自适应）。旧快照无此字段 → 仅做钳制兜底。
   */
  desktopSize?: Size;
}

// ============================================================================
// 视觉材质
// ============================================================================

/** full=玻璃全效果；reduced=无 backdrop-filter；minimal=不透明+无动效 */
export type MaterialTier = 'full' | 'reduced' | 'minimal';

// ============================================================================
// windowStore 冻结 API（P1 实现；其余代理只消费）
// ============================================================================

export interface OpenWindowInput {
  typeId: string;
  instanceKey?: string | null;
  title?: string;
  payload?: unknown;
  initialFrame?: Partial<Frame>;
  /** 桌面坐标系落点；仅新建窗口生效。非法坐标忽略并回退级联落位。 */
  dropPoint?: { x: number; y: number };
}

export interface WorkbenchStoreState {
  windows: Record<string, WorkbenchWindow>;
  /** 后 = 最近聚焦 */
  focusStack: string[];
  /** windowId -> lifecycle（scheduler 写入） */
  lifecycles: Record<string, WindowLifecycle>;
  /** windowId -> launch payload（瞬态） */
  launchPayloads: Record<string, unknown>;
  tilingRatios: Record<string, number>;
  desktopSize: Size;

  openWindow: (input: OpenWindowInput) => string;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  minimizeWindow: (id: string, minimized?: boolean) => void;
  moveWindow: (id: string, frame: Frame) => void;
  setDisplayMode: (id: string, mode: DisplayMode) => void;
  /**
   * 批量切换 displayMode（单次 set，供 tileAll 等避免 N 次订阅/强制布局）。
   * 语义与逐次 setDisplayMode 一致（restoreFrame 进出 floating 规则相同）。
   */
  batchSetDisplayModes?: (entries: ReadonlyArray<{ id: string; mode: DisplayMode }>) => void;
  setTitle: (id: string, title: string) => void;
  setLifecycles: (map: Record<string, WindowLifecycle>) => void;
  setTilingRatio: (key: string, ratio: number) => void;
  setDesktopSize: (size: Size) => void;
  /** 快照恢复：整体替换窗口集合 */
  hydrate: (
    windows: WorkbenchWindow[],
    tilingRatios: Record<string, number>,
    options?: { preserveExisting?: boolean },
  ) => void;

  // —— O11 追加（可选字段，冻结部分之外的扩展；实现始终提供）——
  /**
   * windowId -> 进出场瞬态阶段（绝不持久化，快照白名单外）。
   * 供 O9 生命周期动画消费；条目只存在于动画期间，close/minimize 提交时自动清理。
   */
  transientPhases?: Record<string, WindowTransientPhase>;
  /** 设置（phase）或清除（null）窗口瞬态阶段；未知 windowId 忽略 */
  setWindowTransient?: (id: string, phase: WindowTransientPhase | null) => void;
}

// ============================================================================
// O11 追加：窗口进出场瞬态标记（供 O9 生命周期动画消费）
// ============================================================================

/**
 * 窗口进出场的瞬态阶段（派生 UI 状态，绝不进快照）：
 * - 'opening'    openWindow 时由 store 自动标记；O9 播放开窗动画后清除
 * - 'closing'    O9 在真正 closeWindow 前显式标记，播放消散动画后再关
 * - 'minimizing' O9 在真正 minimizeWindow 前显式标记，播放 genie 后再最小化
 * - 'restoring'  反最小化（focusWindow / minimizeWindow(id,false)）时自动标记
 *
 * 消费方式：`useWindowStore((s) => s.transientPhases?.[id])` 或
 * windowStore 导出的 `useWindowTransientPhase(id)`；动画结束由 O9 调
 * `setWindowTransient(id, null)` 清除（残留标记无害，close/minimize 提交时兜底清理）。
 */
export type WindowTransientPhase = 'opening' | 'closing' | 'minimizing' | 'restoring';

// ============================================================================
// 指针引擎冻结接口（P2 实现；WindowShell 消费）
// ============================================================================

export type SnapZone =
  | 'left' | 'right'
  | 'tl' | 'tr' | 'bl' | 'br'
  | 'top-maximize'
  | null;

export interface WindowPointerCallbacks {
  /** 拖动/缩放过程回调（rAF 合帧后），直接操作 DOM，不进 React state */
  onFrameChange: (frame: Frame) => void;
  /** 拖动中命中吸附区变化（渲染 SnapPreview 用） */
  onSnapZoneChange: (zone: SnapZone) => void;
  /** 松手提交：最终 frame + 命中的吸附区 */
  onCommit: (frame: Frame, zone: SnapZone) => void;
}

// ============================================================================
// 平铺几何冻结接口（P2 实现；Desktop/WindowShell/TileMenu 消费）
// ============================================================================

export interface TilingContext {
  desktopSize: Size;
  /** 平铺间距（px）；0 = 关闭 margins */
  margin: number;
  /** 左右平铺分割比（0–1），缺省 0.5 */
  ratio?: number;
}
