/**
 * Learning OS 内置浏览器 — 公共出口（B2a）
 *
 * 仅导出 session API / 类型 / content 窗协调；勿经此拖入 chat store。
 */

export {
  BROWSER_APP_TYPE_ID,
  BROWSER_CONTENT_LABEL,
  type BrowserCommandName,
  type BrowserControlMode,
  type BrowserHistoryEntry,
  type BrowserLaunchPayload,
  type BrowserSessionSnapshot,
  type BrowserSessionState,
} from './types';

export {
  browserApi,
  BrowserApiError,
  closeSession as closeBrowserSessionApi,
  focusContent as focusBrowserContentApi,
  getState as getBrowserStateApi,
  goBack as browserGoBackApi,
  goForward as browserGoForwardApi,
  isCommandMissingError,
  navigate as navigateBrowserApi,
  normalizeNavigationInput,
  openSession as openBrowserSessionApi,
  parseBrowserSessionSnapshot,
  parseControlMode,
  reload as reloadBrowserApi,
  releaseSurfaceFocus as releaseBrowserSurfaceFocusApi,
  takeOver as takeOverBrowserApi,
  toBrowserApiError,
} from './browserApi';

export {
  BROWSER_CONTROL_MODE_CHANGED_EVENT,
  BROWSER_NAVIGATED_EVENT,
  BROWSER_NAVIGATION_BLOCKED_EVENT,
  BROWSER_TITLE_CHANGED_EVENT,
  BROWSER_CLOSED_EVENT,
  BROWSER_CONTENT_USER_INPUT_EVENT,
  ensureBrowserControlModeSync,
  type BrowserControlModeChangedPayload,
} from './controlModeSync';

export {
  closeBrowserContentWindow,
  ensureBrowserContentWindow,
  hideBrowserContentWindow,
  isBrowserContentWindowOpen,
  showBrowserContentWindow,
} from './contentWindow';

export {
  getBrowserSessionState,
  INITIAL_BROWSER_SESSION_STATE,
  useBrowserSessionStore,
  type BrowserSessionStore,
} from './sessionStore';

export { useBrowserSession } from './hooks/useBrowserSession';

export {
  allowNavigation,
  BROWSER_SETTING_KEYS,
  isBlockedForAgent,
  isLoopbackHost,
  type BrowserNetworkMode,
  type NavigationDecision,
  type NavigationDenyReason,
} from './navigationPolicy';
