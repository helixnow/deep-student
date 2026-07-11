/**
 * Browser Rust 权威运行时事件同步（ACR R2-10）
 *
 * Rust 为权威：`browser:control-mode-changed`（agent_claim / user_takeover / password_blocked）。
 * 本模块经 workbench eventHub 单订阅，把 controlMode / URL / title / history / close
 * 写回 sessionStore，避免 chrome 与 content Webview / Rust 权威漂移。
 */
import { hubListen } from '@/features/workbench/core/eventHub';
import { getState as getBrowserState, parseControlMode } from './browserApi';
import {
  __resetClosedBrowserSessionsForTest,
  hasPendingBrowserNavigation,
  isBrowserSessionClosed,
  markBrowserSessionClosed,
  useBrowserSessionStore,
} from './sessionStore';

/** 与 Rust `events::EVT_CONTROL_MODE_CHANGED` 对齐 */
export const BROWSER_CONTROL_MODE_CHANGED_EVENT = 'browser:control-mode-changed';
export const BROWSER_NAVIGATED_EVENT = 'browser:navigated';
export const BROWSER_TITLE_CHANGED_EVENT = 'browser:title-changed';
export const BROWSER_CLOSED_EVENT = 'browser:closed';

export interface BrowserControlModeChangedPayload {
  sessionId?: string;
  session_id?: string;
  label?: string;
  controlMode?: string;
  control_mode?: string;
  reason?: string;
  at?: string;
}

interface BrowserRuntimePayload {
  sessionId?: string;
  session_id?: string;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  can_go_back?: boolean;
  canGoForward?: boolean;
  can_go_forward?: boolean;
  loading?: boolean;
}

let unlisteners: Array<() => void> = [];
let refCount = 0;
let refreshGeneration = 0;

function payloadSessionId(payload: BrowserRuntimePayload): string | undefined {
  return payload.sessionId ?? payload.session_id;
}

function matchesCurrentSession(sessionId: string | undefined): boolean {
  const current = useBrowserSessionStore.getState().sessionId;
  return !sessionId || !current || sessionId === current;
}

async function refreshRuntimeSnapshot(sessionId: string): Promise<void> {
  const generation = ++refreshGeneration;
  try {
    const snapshot = await getBrowserState(sessionId);
    if (generation !== refreshGeneration) return;
    if (isBrowserSessionClosed(snapshot.sessionId)) return;
    const current = useBrowserSessionStore.getState();
    if (current.sessionId && current.sessionId !== sessionId) return;
    const syncAddressDraft = !current.addressDraft || current.addressDraft === current.currentUrl;
    useBrowserSessionStore.setState({
      sessionId: snapshot.sessionId,
      currentUrl: snapshot.currentUrl,
      title: snapshot.title,
      canGoBack: snapshot.canGoBack,
      canGoForward: snapshot.canGoForward,
      controlMode: snapshot.controlMode,
      loading: snapshot.loading,
      history: snapshot.history,
      historyIndex: snapshot.historyIndex,
      agentAutomationSupported: snapshot.agentAutomationSupported,
      ...(snapshot.sessionId ? {} : { contentVisible: false }),
      ...(syncAddressDraft ? { addressDraft: snapshot.currentUrl } : {}),
    });
  } catch {
    // close / gate 变化可能先于刷新返回；closed 事件或下一次 hydrate 负责收敛。
  }
}

function applyControlModePayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as BrowserControlModeChangedPayload;
  const modeRaw = p.controlMode ?? p.control_mode;
  const mode = parseControlMode(modeRaw);
  const sessionId = p.sessionId ?? p.session_id;
  if (isBrowserSessionClosed(sessionId)) return;

  const state = useBrowserSessionStore.getState();
  // 无活跃 session 时仍接受权威态（开窗瞬间 claim 可能早于 hydrate）
  if (sessionId && state.sessionId && sessionId !== state.sessionId) {
    return;
  }

  if (state.controlMode === mode) return;
  useBrowserSessionStore.setState({ controlMode: mode });
}

function applyNavigatedPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as BrowserRuntimePayload;
  const sessionId = payloadSessionId(p);
  if (!sessionId && !useBrowserSessionStore.getState().sessionId) return;
  if (isBrowserSessionClosed(sessionId)) return;
  if (!matchesCurrentSession(sessionId)) return;

  const state = useBrowserSessionStore.getState();
  const nextUrl = typeof p.url === 'string' ? p.url : state.currentUrl;
  const syncAddressDraft = !state.addressDraft || state.addressDraft === state.currentUrl;
  useBrowserSessionStore.setState({
    ...(sessionId ? { sessionId } : {}),
    currentUrl: nextUrl,
    title: typeof p.title === 'string' ? p.title : state.title,
    canGoBack: p.canGoBack ?? p.can_go_back ?? state.canGoBack,
    canGoForward: p.canGoForward ?? p.can_go_forward ?? state.canGoForward,
    loading: typeof p.loading === 'boolean' ? p.loading : state.loading,
    ...(syncAddressDraft ? { addressDraft: nextUrl } : {}),
  });
  if (sessionId) void refreshRuntimeSnapshot(sessionId);
}

function applyTitlePayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as BrowserRuntimePayload;
  const sessionId = payloadSessionId(p);
  if (!sessionId && !useBrowserSessionStore.getState().sessionId) return;
  if (isBrowserSessionClosed(sessionId)) return;
  if (!matchesCurrentSession(sessionId)) return;
  if (typeof p.title === 'string') {
    const state = useBrowserSessionStore.getState();
    const history = state.history.map((entry, index) =>
      index === state.historyIndex ? { ...entry, title: p.title } : entry,
    );
    useBrowserSessionStore.setState({ title: p.title, history });
  }
}

function applyClosedPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const sessionId = payloadSessionId(payload as BrowserRuntimePayload);
  if (!sessionId) return;
  markBrowserSessionClosed(sessionId);

  const currentSessionId = useBrowserSessionStore.getState().sessionId;
  if (!currentSessionId && hasPendingBrowserNavigation()) {
    // An open_session may not have returned its ID yet. Do not let an old
    // session's delayed close cancel that request; runNav matches the eventual
    // response against the closed-ID registry before applying it.
    return;
  }
  if (!currentSessionId) return;
  if (sessionId !== currentSessionId) return;
  refreshGeneration += 1;
  useBrowserSessionStore.getState().reset();
}

/**
 * 订阅 ControlMode 权威事件。可重入：挂载计数，末次 dispose 才拆监听。
 */
export function ensureBrowserControlModeSync(): () => void {
  refCount += 1;
  if (unlisteners.length === 0) {
    unlisteners = [
      hubListen(BROWSER_CONTROL_MODE_CHANGED_EVENT, applyControlModePayload),
      hubListen(BROWSER_NAVIGATED_EVENT, applyNavigatedPayload),
      hubListen(BROWSER_TITLE_CHANGED_EVENT, applyTitlePayload),
      hubListen(BROWSER_CLOSED_EVENT, applyClosedPayload),
    ];
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && unlisteners.length > 0) {
      for (const dispose of unlisteners) dispose();
      unlisteners = [];
    }
  };
}

/** 单测：直接喂事件载荷 */
export function __applyControlModePayloadForTest(payload: unknown): void {
  applyControlModePayload(payload);
}

export function __applyNavigatedPayloadForTest(payload: unknown): void {
  applyNavigatedPayload(payload);
}

export function __applyTitlePayloadForTest(payload: unknown): void {
  applyTitlePayload(payload);
}

export function __applyClosedPayloadForTest(payload: unknown): void {
  applyClosedPayload(payload);
}

/** 单测：重置订阅计数 */
export function __resetControlModeSyncForTest(): void {
  for (const dispose of unlisteners) dispose();
  unlisteners = [];
  refCount = 0;
  refreshGeneration = 0;
  __resetClosedBrowserSessionsForTest();
}
