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
  code?: string;
  hint?: string;
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
  instanceMode: 'single' | 'multi';
  /** 调度器内存预算权重：PDF/教材=3，编辑器/Chat/思维导图=2，纯展示=1 */
  memoryWeight: 1 | 2 | 3;
  defaultFrame: Size;
  minSize: Size;
  render: React.LazyExoticComponent<React.FC<AppWindowProps>>;
  /** 一次性指令送达（scrollToMessage / gotoPage 等）；可返回结构化回执 */
  onActivation?: (ctx: ActivationContext) => void | ActivationResult;
  /** Dock 角标数据源（拉模式，Dock 轮询/订阅由 Dock 实现决定） */
  badgeSource?: () => AppBadge | null;
  /** 关闭拦截（未保存提示）；返回 false 阻止关闭。缺省 = 直接关 */
  canClose?: (instanceKey: string | null) => boolean | Promise<boolean>;
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
  hydrate: (windows: WorkbenchWindow[], tilingRatios: Record<string, number>) => void;

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
