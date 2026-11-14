/** Cross-lane browser contracts (dstu-browser session/service/bridge). */
export type {
  BrowserStateResult, BrowserSnapshotResult, BrowserDownloadObservation,
  BrowserDownloadState, ControlMode, HistoryEntry, SurfaceCssOcclusion,
} from '../../../contracts/ipc/generated/L19-mcp-browser.ts';

import type { JsonValue } from '../mcp/api.ts';
import type { BrowserSessionState } from '../../../contracts/ipc/generated/L19-mcp-browser.ts';
import type { BrowserToolPolicy } from './src/tool-executor.ts';
import type { IndexWebpageToolPolicy } from './src/index-webpage.ts';
import type { IpAddress } from '../../platform/net-policy/api.ts';
import type { WebSearchFallback } from '../llm/api.ts';

/** Settings-side gate used by other lanes (Rust `assert_settings_gates_open`). */
export { assertSettingsGatesOpen } from './src/service.ts';

/**
 * `BrowserToolExecutor` / `IndexWebpageToolExecutor` 的无副作用策略面。
 * L04 的 `ToolExecutorRegistry` 组装执行器时复用这里的判定，本 lane 的
 * TESTMAP 用例直接覆盖这些生产函数。
 */
export { BrowserToolPolicy, browserToolPolicy } from './src/tool-executor.ts';
export { IndexWebpageToolPolicy, indexWebpageToolPolicy } from './src/index-webpage.ts';
export { BrowserToolExecutor } from './src/browser-tool-executor.ts';
export { IndexWebpageToolExecutor } from './src/index-webpage-executor.ts';
export type { BrowserToolExecutorPorts, BrowserToolService } from './src/browser-tool-executor.ts';
export type {
  IndexStatusSummary, IndexWebpageExecutorPorts,
} from './src/index-webpage-executor.ts';

export const browserToolPolicyService = { name: 'browserToolPolicy', version: '1.0.0' } as const;
export const webpageToolPolicyService = { name: 'webpageToolPolicy', version: '1.0.0' } as const;

export interface OpenSessionOptions {
  url: string; displayName?: string | null; chatSessionId?: string | null;
  width?: number | null; height?: number | null; focused?: boolean | null;
  reuseExisting?: boolean | null; fromAgent?: boolean | null;
}

/**
 * Native browser surface provided by F2 (Electron main `WebContentsView`) or by the
 * platform test double. The browser lane owns every policy/state transition; this
 * interface is the only native boundary (Rust `window.rs` + `bridge.rs`).
 */
export interface BrowserSurfaceCreateOptions {
  url: string;
  title: string;
  width: number;
  height: number;
  focused: boolean;
  profileDir: string;
  initializationScript: string;
}

export interface SurfaceEventCallbacks {
  /** Rust `ContentWindowHooks::on_page_finished`. */
  pageFinished(url: string): void;
  /** Rust `ContentWindowHooks::on_title_changed`. */
  titleChanged(title: string, url: string | null): void;
  /** Rust `ContentWindowHooks::on_navigation_blocked`. */
  navigationBlocked(url: string, reason: string): void;
}

/**
 * `window.rs::NavigationPolicyState`：Agent 控制态私网防护与明文 HTTP 放行，由服务随控制态切换。
 * 原生窗口在每次顶层导航（含页面发起的导航与 redirect）上按它判定，见 `navigation_allowed`。
 */
export interface AgentNavigationPolicy {
  agentPrivateNetworkGuard: boolean;
  agentAllowInsecureHttp: boolean;
}

export interface BrowserSurfaceHost {
  /** `window.rs::surface_host_mode`: embedded / detached / unsupported. */
  hostMode(): string;
  /** Whether the fixed-label content window still exists. */
  hasContentWindow(): boolean;
  createContentWindow(options: BrowserSurfaceCreateOptions): Promise<void>;
  /** Optional native creation acknowledgement (`window.rs::confirm_native_webview_created`). */
  waitForReady?(): Promise<void>;
  destroyContentWindow(): Promise<boolean>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  focusContentWindow(): Promise<void>;
  releaseContentFocus(): Promise<void>;
  /** Main window physical inner size. */
  mainViewportSize(): Promise<{ width: number; height: number }>;
  setContentBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  setContentOcclusions(
    occlusions: readonly { x: number; y: number; width: number; height: number }[],
    inputOcclusions: readonly { x: number; y: number; width: number; height: number }[],
  ): Promise<void>;
  setContentVisibility(visible: boolean, focus: boolean): Promise<void>;
  snapshot(options: { interactiveOnly: boolean; maxChars?: number }): Promise<JsonValue>;
  click(ref: string): Promise<JsonValue>;
  typeText(ref: string, text: string): Promise<JsonValue>;
  setInputFiles(ref: string, files: JsonValue): Promise<JsonValue>;
  scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<JsonValue>;
  /** Subscribe to native callbacks; returns the disposer. */
  subscribe(callbacks: SurfaceEventCallbacks): () => void;
  /** Mirror of the shared `NavigationPolicyHandle` state for the native navigation hooks. */
  setAgentNavigationPolicy?(policy: AgentNavigationPolicy): Promise<void>;
  /** `BoundedDnsResolver::resolve`: addresses, or the Rust failure reason (`DNS resolution timed out`, ...). */
  resolveAgentHost?(host: string, port: number): Promise<IpAddress[] | string>;
}

export const browserService = { name: 'browser', version: '1.0.0' } as const;

/** Browser service surface consumed by the browser tool executor and other lanes. */
export interface BrowserService {
  syncNetworkModeValue(value: string): void;
  /** Service-side UI/workbench gates (`browser_open_session` and bridge calls). */
  assertGatesOpen(): Promise<void>;
  /** Active session, or null when no content window is open. */
  getActiveState(): BrowserSessionState | null;
  openSession(options: OpenSessionOptions): Promise<BrowserSessionState>;
  navigate(sessionId: string, url: string, replace: boolean, fromAgent: boolean): Promise<BrowserSessionState>;
  back(sessionId: string): Promise<BrowserSessionState>;
  getState(sessionId: string | null): BrowserSessionState | null;
  getHistory(sessionId: string): { url: string; title: string; visitedAt: string }[];
  close(sessionId: string | null): Promise<void>;
  closeSession(): Promise<void>;
  focus(sessionId: string | null): Promise<void>;
  snapshot(sessionId: string, maxChars: number | null, interactiveOnly?: boolean): Promise<{
    sessionId: string; url: string; title: string; snapshot: string; epoch?: JsonValue;
  }>;
  click(sessionId: string, ref: string): Promise<JsonValue>;
  type(sessionId: string, ref: string, text: string, submit: boolean): Promise<JsonValue>;
  setInputFiles(sessionId: string, ref: string, files: JsonValue): Promise<JsonValue>;
  scroll(sessionId: string, direction: string | null, amount: number | null, ref: string | null): Promise<JsonValue>;
  listDownloads(sessionId: string): import('../../../contracts/ipc/generated/L19-mcp-browser.ts').BrowserDownloadObservation[];
  listTaskDownloads(chatSessionId: string): import('../../../contracts/ipc/generated/L19-mcp-browser.ts').BrowserDownloadObservation[];
  takeOver(): Promise<BrowserSessionState>;
  takeOverWithReason(reason: string): BrowserSessionState;
  setAgentControl(): BrowserSessionState;
  isBlockedByUserTakeover(): boolean;
  consumeTakeoverNotice(sessionId: string): boolean;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserService;
    browserToolPolicy: BrowserToolPolicy;
    webpageToolPolicy: IndexWebpageToolPolicy;
    /** Read by llm (non-strict) for supports_tools=false web search injection. */
    llmWebSearchFallback: WebSearchFallback;
    /** Optional: F2 registers the native surface; commands fail closed without it. */
    browserSurface?: BrowserSurfaceHost;
  }
}
