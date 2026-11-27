/**
 * Browser session zustand store（B2a）
 *
 * - 历史权威在 Rust；本 store 仅为 chrome 镜像
 * - navigate / back / forward / takeOver 均先 invoke，再以回执 hydrate
 * - forceUserControl 路径同步调 browser_take_over（ACR R1-05 ControlMode 闭环）
 * - 禁止本地权威改写 history 栈
 */
import { create } from 'zustand';

import * as browserApi from './browserApi';
import { BrowserApiError } from './browserApi';
import { browserMessages } from './browserMessages';
import {
  closeBrowserContentWindow,
  ensureBrowserContentWindow,
  hideBrowserContentWindow,
  showBrowserContentWindow,
} from './contentWindow';
import type {
  BrowserControlMode,
  BrowserExtractContentOptions,
  BrowserExtractedContent,
  BrowserHistoryEntry,
  BrowserLaunchPayload,
  BrowserRemoteInputEvent,
  BrowserScreencastFrame,
  BrowserSessionSnapshot,
  BrowserSessionState,
  BrowserSurfaceHostMode,
  BrowserTabInfo,
} from './types';

export interface BrowserSessionStore extends BrowserSessionState {
  hydrateFromRust: (snapshot?: BrowserSessionSnapshot | unknown) => Promise<void>;
  applyLaunchPayload: (payload: unknown) => void;
  openSession: (url?: string) => Promise<void>;
  closeSession: () => Promise<void>;
  /**
   * @param opts.forceUserControl 默认 true（地址栏/用户手势）；
   *   agent app_command 应传 false，避免误打 user_takeover 闩锁（R2-10）
   */
  navigate: (
    url: string,
    opts?: { forceUserControl?: boolean; fromAgent?: boolean },
  ) => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  reload: () => Promise<void>;
  /**
   * 停止（放弃）进行中的导航命令：作废在途回执并立即解除 chrome 忙碌态
   * （地址栏 ✕ 停止钮 / loading 期再导航的前置动作）。
   * 原生页面可能仍在加载，后续 browser:navigated 事件会继续收敛镜像；
   * 这里只保证 chrome 立即恢复可交互（对齐常规浏览器的停止语义）。
   */
  stopLoading: () => void;
  takeOver: () => Promise<void>;
  setControlMode: (mode: BrowserControlMode) => void;
  setAddressDraft: (draft: string) => void;
  setLoading: (loading: boolean) => void;
  refreshTabs: () => Promise<void>;
  createTab: (url?: string) => Promise<void>;
  switchTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  sendRemoteInput: (event: BrowserRemoteInputEvent) => Promise<void>;
  extractCurrentPage: (options?: BrowserExtractContentOptions) => Promise<BrowserExtractedContent>;
  promoteToInteractive: () => Promise<BrowserSurfaceHostMode | null>;
  setScreencastFrame: (frame: BrowserScreencastFrame | null) => void;
  showContent: () => Promise<boolean>;
  hideContent: () => Promise<void>;
  ensureContent: () => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

const EMPTY_HISTORY: BrowserHistoryEntry[] = [];
const EMPTY_TABS: BrowserTabInfo[] = [];

interface PendingNavigation {
  key: string;
  promise: Promise<void>;
}

let pendingNavigation: PendingNavigation | null = null;
let snapshotGeneration = 0;
const CLOSED_SESSION_LIMIT = 512;
const closedSessionIds = new Set<string>();
const closedSessionOrder: string[] = [];

export function markBrowserSessionClosed(sessionId: string): void {
  if (!sessionId || closedSessionIds.has(sessionId)) return;
  closedSessionIds.add(sessionId);
  closedSessionOrder.push(sessionId);
  while (closedSessionOrder.length > CLOSED_SESSION_LIMIT) {
    const expired = closedSessionOrder.shift();
    if (expired) closedSessionIds.delete(expired);
  }
}

export function isBrowserSessionClosed(sessionId: string | null | undefined): boolean {
  return !!sessionId && closedSessionIds.has(sessionId);
}

export function hasPendingBrowserNavigation(): boolean {
  return pendingNavigation !== null;
}

/** Reject stale command snapshots after a native policy callback rolls navigation back. */
export function invalidateBrowserNavigationSnapshot(): void {
  snapshotGeneration += 1;
}

export function __resetClosedBrowserSessionsForTest(): void {
  closedSessionIds.clear();
  closedSessionOrder.length = 0;
}

export const INITIAL_BROWSER_SESSION_STATE: BrowserSessionState = {
  sessionId: null,
  currentUrl: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  controlMode: 'user',
  loading: false,
  history: EMPTY_HISTORY,
  historyIndex: -1,
  agentAutomationSupported: false,
  error: null,
  contentVisible: false,
  addressDraft: '',
  lastError: null,
  tabs: EMPTY_TABS,
  activeTabId: null,
  screencastFrame: null,
};

function parseLaunchPayload(payload: unknown): BrowserLaunchPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload as BrowserLaunchPayload;
}

function applySnapshot(
  snapshot: BrowserSessionSnapshot,
  patch?: Partial<BrowserSessionState>,
): Partial<BrowserSessionStore> {
  return {
    sessionId: snapshot.sessionId,
    currentUrl: snapshot.currentUrl,
    title: snapshot.title,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    controlMode: snapshot.controlMode,
    loading: snapshot.loading,
    // 历史镜像：整表替换，不在前端 push/pop
    history: snapshot.history,
    historyIndex: snapshot.historyIndex,
    agentAutomationSupported: snapshot.agentAutomationSupported,
    error: snapshot.error,
    addressDraft: snapshot.currentUrl || '',
    lastError: snapshot.error,
    ...patch,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof BrowserApiError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return browserMessages.operationFailed();
}

async function runNav(
  set: (partial: Partial<BrowserSessionStore>) => void,
  get: () => BrowserSessionStore,
  action: () => Promise<BrowserSessionSnapshot>,
  opts?: { forceUserControl?: boolean },
): Promise<boolean> {
  if (get().loading) {
    throw new BrowserApiError('browser_navigate', browserMessages.busy(), 'BROWSER_BUSY');
  }
  const generation = ++snapshotGeneration;
  // 导航期间用户可能继续编辑地址：记录起飞时草稿，回执时若草稿已变则保留输入
  const draftAtStart = get().addressDraft;
  set({ loading: true, lastError: null, error: null });
  try {
    // ACR R1-05：用户导航硬打断 agent — 同步权威侧 take_over（打 user_takeover_at）
    if (opts?.forceUserControl) {
      try {
        await browserApi.takeOver();
      } catch {
        /* 无 session / 命令未就绪时仍继续导航，本地强制 user */
      }
    }
    // Stop/reset/close may run while takeOver is awaiting its RPC. Do not
    // dispatch the abandoned navigation (discarding its reply is too late).
    if (generation !== snapshotGeneration) return false;
    const snapshot = await action();
    if (generation !== snapshotGeneration) return false;
    if (isBrowserSessionClosed(snapshot.sessionId)) {
      snapshotGeneration += 1;
      set({ ...INITIAL_BROWSER_SESSION_STATE });
      return false;
    }
    const draftNow = get().addressDraft;
    const userEditedInFlight = draftNow !== draftAtStart;
    set(
      applySnapshot(snapshot, {
        // Rust owns the page lifecycle: command completion only means the
        // native WebView accepted the navigation. Keep snapshot.loading=true
        // until browser:navigated reports PageLoadEvent::Finished (or the
        // user explicitly stops/redirects), otherwise the stop control
        // disappears as soon as invoke returns.
        ...(userEditedInFlight ? { addressDraft: draftNow } : {}),
        ...(opts?.forceUserControl ? { controlMode: 'user' as const } : {}),
      }),
    );
    return true;
  } catch (err) {
    if (generation === snapshotGeneration) {
      const message = errorMessage(err);
      set({
        loading: false,
        lastError: message,
        error: message,
        ...(opts?.forceUserControl ? { controlMode: 'user' as const } : {}),
      });
    }
    throw err;
  }
}

export const useBrowserSessionStore = create<BrowserSessionStore>((set, get) => ({
  ...INITIAL_BROWSER_SESSION_STATE,

  hydrateFromRust: async (snapshot) => {
    const generation = ++snapshotGeneration;
    if (snapshot !== undefined && snapshot !== null) {
      const parsed = browserApi.parseBrowserSessionSnapshot(snapshot);
      if (isBrowserSessionClosed(parsed.sessionId)) {
        set({ ...INITIAL_BROWSER_SESSION_STATE });
        return;
      }
      set(applySnapshot(parsed, { loading: false }));
      return;
    }
    // Hydration must not claim the navigation busy flag: a freshly mounted
    // fallbackLaunch can otherwise race its own app_command and fail as busy.
    set({ lastError: null });
    try {
      const state = await browserApi.getState();
      if (generation !== snapshotGeneration) return;
      if (isBrowserSessionClosed(state.sessionId)) {
        set({ ...INITIAL_BROWSER_SESSION_STATE });
        return;
      }
      set(applySnapshot(state, { loading: false }));
    } catch (err) {
      if (generation !== snapshotGeneration) return;
      const message = errorMessage(err);
      // 无 session / 命令未就绪：保持空镜像，记录友好错误
      set({
        ...INITIAL_BROWSER_SESSION_STATE,
        loading: false,
        lastError: message,
        error: message,
      });
    }
  },

  applyLaunchPayload: (payload) => {
    const parsed = parseLaunchPayload(payload);
    if (!parsed) return;
    void (async () => {
      if (parsed.takeOver) {
        await get().takeOver();
      }
      if (typeof parsed.url === 'string' && parsed.url.length > 0) {
        // Workbench 带 URL 的 launch 主要来自 Agent open_app/fallbackLaunch。
        // 来源缺失时 fail-safe 按 Agent 导航，避免私网策略被静默绕过。
        const fromAgent = parsed.fromAgent ?? !parsed.takeOver;
        await get().navigate(parsed.url, {
          forceUserControl: !fromAgent,
          fromAgent,
        });
      }
      if (parsed.showContent) {
        await get().showContent();
      }
    })().catch((err) => {
      console.warn('[BrowserSession] launch payload failed:', err);
    });
    if (parsed.focusAddress) {
      set({ addressDraft: get().currentUrl || parsed.url || get().addressDraft });
    }
  },

  openSession: async (url) => {
    const applied = await runNav(set, get, () =>
      browserApi.openSession(url, { fromAgent: false }),
    );
    if (!applied) return;
    const ok = await ensureBrowserContentWindow(get().sessionId);
    if (ok) set({ contentVisible: true });
  },

  closeSession: async () => {
    const inFlightNavigation = pendingNavigation?.promise;
    if (inFlightNavigation) {
      try {
        await inFlightNavigation;
      } catch {
        // Failed navigation may still have created a native window; cleanup continues.
      }
    }
    snapshotGeneration += 1;
    pendingNavigation = null;
    set({ loading: true, lastError: null });
    let closeError: unknown = null;
    try {
      await browserApi.closeSession(get().sessionId);
    } catch (err) {
      const message = errorMessage(err);
      // NOT_FOUND = 后端早已无此 session（幂等关闭），不算失败也不留横幅
      if (!message.startsWith('NOT_FOUND')) {
        // 仍尝试直接关闭 native content window，但保留失败供 canClose 决策。
        set({ lastError: message, error: message });
        closeError = err;
      }
    }
    try {
      await closeBrowserContentWindow();
    } catch {
      /* ignore */
    }
    set({
      ...INITIAL_BROWSER_SESSION_STATE,
      loading: false,
      lastError: get().lastError,
      error: get().error,
    });
    if (closeError) throw closeError;
  },

  navigate: async (url, opts) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const forceUserControl = opts?.forceUserControl !== false;
    const fromAgent = opts?.fromAgent ?? false;
    const key = `${forceUserControl ? 'user' : 'agent'}:${fromAgent}:${browserApi.normalizeNavigationInput(trimmed)}`;
    if (pendingNavigation) {
      if (pendingNavigation.key === key) return pendingNavigation.promise;
      throw new BrowserApiError('browser_navigate', browserMessages.busy(), 'BROWSER_BUSY');
    }

    const promise = (async () => {
      const sessionId = get().sessionId;
      // 无 session 时先 open（建库 + content 窗）；已有则 navigate
      if (!sessionId) {
        const applied = await runNav(
          set,
          get,
          () => browserApi.openSession(trimmed, { fromAgent }),
          { forceUserControl },
        );
        if (!applied) return;
        const ok = await ensureBrowserContentWindow(get().sessionId);
        if (ok) set({ contentVisible: true });
        return;
      }
      // 用户导航硬打断 agent（design §2 UX）；agent app_command 传 forceUserControl:false
      await runNav(
        set,
        get,
        () => browserApi.navigate(trimmed, sessionId, { fromAgent }),
        { forceUserControl },
      );
    })();
    pendingNavigation = { key, promise };
    try {
      await promise;
    } finally {
      if (pendingNavigation?.promise === promise) pendingNavigation = null;
    }
  },

  back: async () => {
    if (!get().canGoBack) return;
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await runNav(set, get, () => browserApi.goBack(sessionId), { forceUserControl: true });
  },

  forward: async () => {
    if (!get().canGoForward) return;
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await runNav(set, get, () => browserApi.goForward(sessionId), {
      forceUserControl: true,
    });
  },

  reload: async () => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await runNav(set, get, () => browserApi.reload(sessionId), { forceUserControl: true });
  },

  stopLoading: () => {
    if (!get().loading) return;
    // 作废在途 runNav 回执（generation 不匹配即丢弃），并释放导航去重锁，
    // 让停止后的下一次 back/forward/navigate 立即可用
    snapshotGeneration += 1;
    pendingNavigation = null;
    set({ loading: false });
  },

  takeOver: async () => {
    const generation = ++snapshotGeneration;
    set({ loading: true, lastError: null, error: null });
    try {
      const snapshot = await browserApi.takeOver();
      if (generation !== snapshotGeneration) return;
      if (isBrowserSessionClosed(snapshot.sessionId)) {
        snapshotGeneration += 1;
        set({ ...INITIAL_BROWSER_SESSION_STATE });
        return;
      }
      // 权威回执优先；本地强制 user 仅作兜底（与 Rust take_over 一致）
      set(
        applySnapshot(snapshot, {
          loading: false,
          controlMode: snapshot.controlMode || 'user',
        }),
      );
    } catch (err) {
      if (generation !== snapshotGeneration) throw err;
      // 命令未就绪时仍本地切到 user，保证 UX「接管」可点
      const message = errorMessage(err);
      set({
        loading: false,
        controlMode: 'user',
        lastError: message,
        error: message,
      });
      throw err;
    }
  },

  /**
   * 仅供权威事件 / 测试写入镜像。业务路径应走 takeOver / navigate(forceUserControl)
   * 或等待 browser:control-mode-changed，勿把前端当权威。
   */
  setControlMode: (mode) => set({ controlMode: mode }),

  setAddressDraft: (draft) => set({ addressDraft: draft }),

  setLoading: (loading) => set({ loading }),

  refreshTabs: async () => {
    const sessionId = get().sessionId;
    if (!sessionId) {
      set({ tabs: EMPTY_TABS, activeTabId: null });
      return;
    }
    try {
      const tabs = await browserApi.listTabs(sessionId);
      if (get().sessionId !== sessionId) return;
      const active = tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
      set({ tabs, activeTabId: active ? active.tabId : null });
    } catch {
      // Multi-tab API may be unsupported on legacy/single-view backends.
    }
  },

  createTab: async (url = 'about:blank') => {
    const sessionId = get().sessionId;
    if (!sessionId) {
      await get().openSession(url === 'about:blank' ? undefined : url);
      return;
    }
    try {
      const created = await browserApi.newTab(sessionId, url);
      if (get().sessionId !== sessionId) return;
      set({
        activeTabId: created.tabId,
        currentUrl: created.url,
        title: created.title,
        addressDraft: created.url === 'about:blank' ? '' : created.url,
        lastError: null,
        error: null,
      });
      await get().refreshTabs();
    } catch (err) {
      const message = errorMessage(err);
      set({ lastError: message, error: message });
      throw err;
    }
  },

  switchTab: async (tabId) => {
    const sessionId = get().sessionId;
    if (!sessionId || !tabId) return;
    try {
      const active = await browserApi.switchTab(sessionId, tabId);
      if (get().sessionId !== sessionId) return;
      const nextUrl = active.url ?? '';
      set({
        activeTabId: active.tabId,
        currentUrl: nextUrl,
        title: active.title ?? '',
        addressDraft: nextUrl === 'about:blank' ? '' : nextUrl,
        lastError: null,
        error: null,
      });
      await get().refreshTabs();
    } catch (err) {
      const message = errorMessage(err);
      set({ lastError: message, error: message });
      throw err;
    }
  },

  closeTab: async (tabId) => {
    const sessionId = get().sessionId;
    if (!sessionId || !tabId) return;
    try {
      const result = await browserApi.closeTab(sessionId, tabId);
      if (get().sessionId !== sessionId) return;
      const resultObj =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
      const remainingCount =
        typeof resultObj?.remainingCount === 'number'
          ? resultObj.remainingCount
          : typeof resultObj?.remaining_count === 'number'
            ? resultObj.remaining_count
            : undefined;
      const closed = resultObj?.closed === true;
      if (remainingCount === 0) {
        snapshotGeneration += 1;
        pendingNavigation = null;
        set({
          ...INITIAL_BROWSER_SESSION_STATE,
          sessionId: null,
          tabs: EMPTY_TABS,
          activeTabId: null,
          currentUrl: '',
          title: '',
          addressDraft: '',
        });
        return;
      }
      await get().refreshTabs();
      if (get().sessionId !== sessionId) return;
      const tabs = get().tabs;
      if (closed && tabs.length === 0) {
        snapshotGeneration += 1;
        pendingNavigation = null;
        set({
          ...INITIAL_BROWSER_SESSION_STATE,
          sessionId: null,
          tabs: EMPTY_TABS,
          activeTabId: null,
          currentUrl: '',
          title: '',
          addressDraft: '',
        });
        return;
      }
      const nextActive = tabs.find((tab) => tab.active) ?? tabs[0];
      if (nextActive) {
        const nextUrl = nextActive.url ?? '';
        set({
          activeTabId: nextActive.tabId,
          currentUrl: nextUrl,
          title: nextActive.title ?? '',
          addressDraft: nextUrl === 'about:blank' ? '' : nextUrl,
        });
      }
    } catch (err) {
      const message = errorMessage(err);
      set({ lastError: message, error: message });
      throw err;
    }
  },

  sendRemoteInput: async (event) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await browserApi.remoteInput(sessionId, event);
  },

  extractCurrentPage: async (options) => {
    const sessionId = get().sessionId;
    if (!sessionId) {
      throw new BrowserApiError(
        'browser_extract_content',
        browserMessages.operationFailed(),
        'BROWSER_NO_SESSION',
      );
    }
    return browserApi.extractContent(sessionId, options);
  },

  promoteToInteractive: async () => {
    const sessionId = get().sessionId;
    if (!sessionId) return null;
    try {
      const mode = await browserApi.promoteToInteractive(sessionId);
      if (get().sessionId !== sessionId) return mode;
      set({ contentVisible: true, lastError: null, error: null });
      return mode;
    } catch (err) {
      const message = errorMessage(err);
      set({ lastError: message, error: message });
      throw err;
    }
  },

  setScreencastFrame: (frame) => set({ screencastFrame: frame }),

  showContent: async () => {
    const ok = await showBrowserContentWindow(get().sessionId);
    set({ contentVisible: ok });
    return ok;
  },

  hideContent: async () => {
    await hideBrowserContentWindow(get().sessionId);
    set({ contentVisible: false });
  },

  ensureContent: async () => {
    const ok = await ensureBrowserContentWindow(get().sessionId);
    set({ contentVisible: ok });
    return ok;
  },

  clearError: () => set({ lastError: null, error: null }),

  reset: () => {
    snapshotGeneration += 1;
    pendingNavigation = null;
    set({ ...INITIAL_BROWSER_SESSION_STATE });
  },
}));

/** 非 hook 访问（register / canClose） */
export function getBrowserSessionState(): BrowserSessionStore {
  return useBrowserSessionStore.getState();
}
