/**
 * 会话与 webContents 的统一安全策略（`app.on('web-contents-created')` / `app.on('session-created')` 安装）。
 *
 * Tauri/wry 没有对应的集中入口，这里是 Electron 侧的加固，按 webContents 的角色区分：
 * - `app`：WindowManager 管理的应用窗口（main、pomodoro-mini 等，页面来自应用 origin）。
 * - `browser`：dstu-browser 的 `browser-content`（远程网页，可能处于 Agent 控制下）。
 * - 未登记的 webContents（如 DevTools）：只允许停留在当前 origin，其余一律拒绝。
 *
 * 规则：
 * - 新窗口：一律不创建（wry 未设置 `new_window_req_handler` 时 `window.open` 同样返回 null）。应用窗口内
 *   通过 opener 作用域（capability `opener:allow-open-url` / `opener:allow-default-urls`）的 URL 交给系统浏览器。
 * - 顶层导航：应用窗口只能停留在应用 origin，用户点到的外链按 opener 作用域交给系统浏览器，重定向到外部直接拒绝；
 *   `browser-content` 只允许 http(s) 且带主机（dstu-browser `policy::allow_navigation_with_options`
 *   在非 Agent 控制时的效果）。
 * - `<webview>`：一律拒绝挂载。
 * - 权限：默认拒绝。应用 origin 的帧放行前端实际用到的 {@link APP_FRAME_PERMISSIONS}（麦克风仅音频）；
 *   应用窗口里的第三方帧（如 B 站播放器）只放行全屏；`browser-content` 只放行全屏与剪贴板写入。
 */
import type { App, Event, HandlerDetails, Session, WebContents, WebContentsWillNavigateEventParams, WebContentsWillRedirectEventParams } from 'electron';
import { openerUrlAllowed, type OpenerUrlEntry } from './capabilities.ts';

export type ContentsRole = 'app' | 'browser';

export interface WebSecurityPolicy {
  /** 应用页面 origin：`tauri://localhost`、`http://tauri.localhost` 或开发服务器 origin。 */
  appOrigin: string;
  /** 由 main 持有的映射判定 webContents 角色；未登记的返回 null。 */
  roleOf(contents: WebContents): ContentsRole | null;
  openerUrlAllow: readonly OpenerUrlEntry[];
  openExternal(url: string): Promise<void>;
  log(message: string): void;
}

/** 应用 origin 帧可获得的权限：剪贴板（`clipboardUtils`、思维导图粘贴）、通知状态、全屏、麦克风（语音输入）、屏幕常亮（媒体播放）。 */
export const APP_FRAME_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
  'notifications',
  'screen-wake-lock',
]);
/** 应用窗口内第三方帧（受嵌入方 `allow` 属性约束）可获得的权限。 */
export const THIRD_PARTY_FRAME_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen']);
/** `browser-content` 远程页面可获得的权限。 */
export const BROWSER_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** 层级 URL 的 `scheme://host[:port]`；无主机的 URL（`mailto:`、`file:`、`blob:`、`data:`、`about:`）与非法 URL 返回 null。 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host === '') return null;
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

/** 用于日志：只保留 origin（或 scheme），不记录可能含令牌的路径与查询串。 */
export function describeUrl(url: string): string {
  const origin = originOf(url);
  if (origin !== null) return origin;
  const colon = url.indexOf(':');
  return colon > 0 && colon < 32 ? `${url.slice(0, colon + 1)}…` : '(invalid url)';
}

/** `browser-content` 顶层导航：只允许带主机的 http/https。 */
export function browserNavigationAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== '';
}

export type NavigationDecision = { allow: true } | { allow: false; openExternal: boolean };

export interface NavigationContext {
  appOrigin: string;
  openerUrlAllow: readonly OpenerUrlEntry[];
  /** 发起导航的 webContents 当前 URL（未登记角色时用于同 origin 判定）。 */
  currentUrl: string;
}

export function decideNavigation(
  role: ContentsRole | null,
  url: string,
  kind: 'navigate' | 'redirect',
  context: NavigationContext,
): NavigationDecision {
  if (role === 'browser') return browserNavigationAllowed(url) ? { allow: true } : { allow: false, openExternal: false };
  const target = originOf(url);
  if (role === 'app') {
    if (target !== null && target === context.appOrigin.toLowerCase()) return { allow: true };
    return { allow: false, openExternal: kind === 'navigate' && openerUrlAllowed(context.openerUrlAllow, url, null) };
  }
  const current = originOf(context.currentUrl);
  return target !== null && target === current ? { allow: true } : { allow: false, openExternal: false };
}

/** `window.open` / `target=_blank`：从不创建窗口；只有应用窗口内、opener 作用域内的 URL 交给系统浏览器。 */
export function windowOpenGoesExternal(role: ContentsRole | null, url: string, openerUrlAllow: readonly OpenerUrlEntry[]): boolean {
  return role === 'app' && openerUrlAllowed(openerUrlAllow, url, null);
}

export interface PermissionQuery {
  role: ContentsRole | null;
  permission: string;
  /** 发起请求的帧 URL 或 origin。 */
  requester: string | undefined;
  /** `media` 请求的媒体类型（请求为 `mediaTypes`，检查为单个 `mediaType`）。 */
  mediaTypes: readonly string[];
}

export function decidePermission(query: PermissionQuery, appOrigin: string): boolean {
  const { role, permission } = query;
  if (role === null) return false;
  let allowed: ReadonlySet<string>;
  if (role === 'browser') {
    allowed = BROWSER_PERMISSIONS;
  } else {
    const requester = query.requester === undefined ? null : originOf(query.requester);
    allowed = requester !== null && requester === appOrigin.toLowerCase() ? APP_FRAME_PERMISSIONS : THIRD_PARTY_FRAME_PERMISSIONS;
  }
  if (!allowed.has(permission)) return false;
  if (permission === 'media') return query.mediaTypes.length > 0 && query.mediaTypes.every((type) => type === 'audio');
  return true;
}

function safeRole(policy: WebSecurityPolicy, contents: WebContents | null): ContentsRole | null {
  if (contents === null || contents.isDestroyed()) return null;
  return policy.roleOf(contents);
}

function openExternally(policy: WebSecurityPolicy, url: string, origin: string): void {
  policy.log(`[security] ${origin}: opening ${describeUrl(url)} in the system browser`);
  void policy.openExternal(url).catch((error: unknown) => {
    policy.log(`[security] openExternal failed for ${describeUrl(url)}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 会话级默认拒绝的权限处理器（默认会话与 `session.fromPath()` 建的 browser-content 会话）。 */
export function installSessionPermissionGuards(ses: Session, policy: WebSecurityPolicy): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const role = safeRole(policy, contents);
    const granted = decidePermission({ role, permission, requester: details.requestingUrl, mediaTypes }, policy.appOrigin);
    if (!granted) policy.log(`[security] denied permission request ${permission} (${role ?? 'unmanaged'}) from ${describeUrl(details.requestingUrl ?? '')}`);
    callback(granted);
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType === undefined ? [] : [details.mediaType];
    return decidePermission(
      { role: safeRole(policy, contents), permission, requester: details.requestingUrl ?? requestingOrigin, mediaTypes },
      policy.appOrigin,
    );
  });
}

/** 单个 webContents 的新窗口、导航、重定向与 `<webview>` 拦截。角色在事件发生时再判定（创建时尚未登记）。 */
export function guardWebContents(contents: WebContents, policy: WebSecurityPolicy): void {
  const label = () => safeRole(policy, contents) ?? 'unmanaged';
  contents.setWindowOpenHandler((details: HandlerDetails) => {
    if (windowOpenGoesExternal(safeRole(policy, contents), details.url, policy.openerUrlAllow)) {
      openExternally(policy, details.url, label());
    } else {
      policy.log(`[security] ${label()}: blocked new window for ${describeUrl(details.url)}`);
    }
    return { action: 'deny' };
  });
  const onNavigation = (kind: 'navigate' | 'redirect') => (event: Event<WebContentsWillNavigateEventParams | WebContentsWillRedirectEventParams>) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    const decision = decideNavigation(safeRole(policy, contents), event.url, kind, {
      appOrigin: policy.appOrigin,
      openerUrlAllow: policy.openerUrlAllow,
      currentUrl: contents.isDestroyed() ? '' : contents.getURL(),
    });
    if (decision.allow) return;
    event.preventDefault();
    if (decision.openExternal) openExternally(policy, event.url, label());
    else policy.log(`[security] ${label()}: blocked ${kind} to ${describeUrl(event.url)}`);
  };
  contents.on('will-navigate', onNavigation('navigate'));
  contents.on('will-redirect', onNavigation('redirect'));
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    policy.log(`[security] ${label()}: blocked <webview> attachment`);
  });
}

/** 在创建任何窗口之前调用：覆盖默认会话、之后新建的会话与所有 webContents。 */
export function installWebSecurity(app: App, defaultSession: Session, policy: WebSecurityPolicy): void {
  installSessionPermissionGuards(defaultSession, policy);
  app.on('session-created', (ses) => installSessionPermissionGuards(ses, policy));
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, policy));
}
