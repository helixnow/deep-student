import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { isWebUiShell } from './platform';
import { isTauriRuntime } from './shared';

interface DsHistoryState {
  __dsNav: true;
  view: string;
  index: number;
}

let trackedHistoryView = 'chat-v2';
let trackedHistoryIndex = 0;
let pageHistoryStepBackCount = 0;
let handlingBrowserPopState = false;

/** 是否启用浏览器 History API 协同（WebUI / PWA 及普通浏览器；原生 Tauri 壳走系统返回桥）。 */
export function isBrowserHistorySyncEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.history?.pushState !== 'function') {
    return false;
  }
  return isWebUiShell() || !isTauriRuntime;
}

/** 当前是否正处于浏览器 popstate 回退调度内（用于跳过 UI 按钮防抖）。 */
export function isHandlingBrowserPopState(): boolean {
  return handlingBrowserPopState;
}

export function setHandlingBrowserPopState(active: boolean): void {
  handlingBrowserPopState = active;
}

export function getBrowserHistoryTracking(): {
  view: string;
  index: number;
  stepBackCount: number;
} {
  return {
    view: trackedHistoryView,
    index: trackedHistoryIndex,
    stepBackCount: pageHistoryStepBackCount,
  };
}

export function setBrowserHistoryTracking(view: string, index: number): void {
  trackedHistoryView = view;
  trackedHistoryIndex = Math.max(0, index);
}

/** 同步当前应用历史位置到浏览器 History 栈（仅 Web / PWA 环境生效）。 */
export function syncBrowserHistoryState(
  action: 'replace' | 'push',
  view: string,
  index: number,
): void {
  trackedHistoryView = view;
  trackedHistoryIndex = Math.max(0, index);
  if (!isBrowserHistorySyncEnabled()) return;
  try {
    const existing = window.history.state;
    const baseState =
      action === 'replace' && existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    const nextState: Record<string, unknown> & DsHistoryState = {
      ...baseState,
      __dsNav: true,
      view,
      index: trackedHistoryIndex,
    };
    if (action === 'push') {
      window.history.pushState(nextState, '');
    } else {
      window.history.replaceState(nextState, '');
    }
  } catch (err) {
    debugLog.warn('[AndroidBack] syncBrowserHistoryState failed:', err);
  }
}

/** 应用级页面历史发生后退时通知协调器更新追踪指针。 */
export function notifyPageHistoryStepBack(nextView: string, nextIndex: number): void {
  pageHistoryStepBackCount += 1;
  trackedHistoryView = nextView;
  trackedHistoryIndex = Math.max(0, nextIndex);
}

/** 应用级页面历史发生前进时更新追踪指针。 */
export function notifyPageHistoryStepForward(nextView: string, nextIndex: number): void {
  trackedHistoryView = nextView;
  trackedHistoryIndex = Math.max(0, nextIndex);
}
