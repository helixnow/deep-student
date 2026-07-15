/**
 * Learning OS 内置浏览器 — 前端类型契约（B2a）
 *
 * 历史权威在 Rust；本模块类型描述 chrome 镜像与 launch 载荷。
 * content 窗 label 一期固定，见 design §1.1。
 */

export const BROWSER_APP_TYPE_ID = 'browser' as const;

/** 独立 content WebviewWindow 固定 label（不进 windowStore） */
export const BROWSER_CONTENT_LABEL = 'browser-content' as const;

export type BrowserControlMode = 'user' | 'agent';

/** Native page host selected by Rust for the current platform. */
export type BrowserSurfaceHostMode = 'embedded' | 'detached' | 'unsupported';

/** A CSS-pixel rectangle where the native browser surface must yield to DOM UI. */
export interface BrowserSurfaceOcclusion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Logical (CSS-pixel) bounds of the page slot inside the main window. */
export interface BrowserSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Non-overlapping DOM regions that sit above this native surface. */
  occlusions?: BrowserSurfaceOcclusion[];
  /**
   * Regions where pointer input must return to the DOM even if the browser
   * remains visually visible. This preserves modal/menu outside-click
   * behavior without hiding the whole native page.
   */
  inputOcclusions?: BrowserSurfaceOcclusion[];
}

/** Workbench launch / Agent open 载荷 */
export interface BrowserLaunchPayload {
  /** 打开或导航到的 URL */
  url?: string;
  /** chrome 挂载后聚焦地址栏 */
  focusAddress?: boolean;
  /** 显示/聚焦 content 浮窗 */
  showContent?: boolean;
  /** 立即接管控制权（打断 agent） */
  takeOver?: boolean;
  /**
   * 导航是否来自 Agent。未显式标记的带 URL Workbench launch 按 Agent 处理，
   * 防止 open_app/fallbackLaunch 丢失来源后绕过私网策略。
   */
  fromAgent?: boolean;
}

/** 历史栈条目（Rust 镜像；前端不权威写入） */
export interface BrowserHistoryEntry {
  url: string;
  title?: string | null;
  visitedAt?: string | null;
  seq?: number;
}

/**
 * `browser_get_state` / 导航回执的归一化快照。
 * 字段同时兼容 camelCase / snake_case 原始载荷（见 browserApi.parse）。
 */
export interface BrowserSessionSnapshot {
  sessionId: string | null;
  currentUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  controlMode: BrowserControlMode;
  loading: boolean;
  history: BrowserHistoryEntry[];
  historyIndex: number;
  /** 当前平台是否支持带结果回执的 Agent 浏览器自动化。 */
  agentAutomationSupported: boolean;
  error: string | null;
}

export interface BrowserSessionState extends BrowserSessionSnapshot {
  /** content 窗是否视为可见（TS 侧协调；真源仍在 Rust 窗生命周期） */
  contentVisible: boolean;
  /** 地址栏草稿（仅 UI；提交后走 navigate） */
  addressDraft: string;
  /** 最近一次 API/导航错误（友好文案） */
  lastError: string | null;
}

export type BrowserCommandName =
  | 'browser_open_session'
  | 'browser_close'
  | 'browser_navigate'
  | 'browser_back'
  | 'browser_forward'
  | 'browser_reload'
  | 'browser_get_state'
  | 'browser_focus'
  | 'browser_release_surface_focus'
  | 'browser_take_over'
  | 'browser_set_surface_bounds'
  | 'browser_set_surface_visibility'
  | 'browser_get_surface_host_mode'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_scroll';
