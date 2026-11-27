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
  type BrowserRemoteInputEvent,
  type BrowserScreencastFrame,
  type BrowserSessionSnapshot,
  type BrowserSessionState,
  type BrowserSurfaceHostMode,
  type BrowserTabInfo,
} from './types';

export {
  browserApi,
  BrowserApiError,
  closeSession as closeBrowserSessionApi,
  closeTab as closeBrowserTabApi,
  focusContent as focusBrowserContentApi,
  getState as getBrowserStateApi,
  goBack as browserGoBackApi,
  goForward as browserGoForwardApi,
  isCommandMissingError,
  listTabs as listBrowserTabsApi,
  navigate as navigateBrowserApi,
  newTab as newBrowserTabApi,
  normalizeNavigationInput,
  openSession as openBrowserSessionApi,
  parseBrowserSessionSnapshot,
  parseBrowserSurfaceHostMode,
  parseBrowserTabInfo,
  parseControlMode,
  promoteToInteractive as promoteBrowserToInteractiveApi,
  reload as reloadBrowserApi,
  releaseSurfaceFocus as releaseBrowserSurfaceFocusApi,
  remoteInput as browserRemoteInputApi,
  switchTab as switchBrowserTabApi,
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
  BROWSER_SCREENCAST_FRAME_EVENT,
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
  isValidBrowserCdpUrl,
  type BrowserNetworkMode,
  type NavigationDecision,
  type NavigationDenyReason,
} from './navigationPolicy';

export {
  assertBrowserGatesOpen,
  BrowserGateClosedError,
  evaluateBrowserSettingsGates,
  interpretBrowserChildGateEnabled,
  peekBrowserParentGateFromCache,
  resolveBrowserGates,
  type BrowserGatesSnapshot,
} from './gates';
