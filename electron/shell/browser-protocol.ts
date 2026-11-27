/**
 * browser 窗口面的纯协议层：桥脚本、信封解析、CSS 遮挡脚本与 `browser.*` shell 分派。
 *
 * 不导入 `electron`，便于在 Node/vitest 下直接测试；原生窗口实现见 `browser-surface.ts`。
 * 行为对应 Rust：
 * - `crates/dstu-browser/src/browser/bridge.rs`：脚本构造、信封解析、错误文案
 * - `crates/dstu-browser/src/browser/window/macos_surface_clip.rs`：even-odd 挖洞
 */
import type { ShellErrorData } from '../../host/kernel/api.ts';

/** Only a decoded bridge error body supplies structured data to the shell reply. */
export class BrowserBridgeError extends Error {
  readonly data: ShellErrorData;

  constructor(data: ShellErrorData) {
    super(`bridge error ${data.code}: ${data.message}`);
    this.data = data;
  }
}

export const BROWSER_CONTENT_LABEL = 'browser-content';
export const MAIN_WINDOW_LABEL = 'main';
export const SURFACE_HOST_EMBEDDED = 'embedded';
export const SURFACE_HOST_DETACHED = 'detached';
export const SURFACE_HOST_HEADLESS = 'headless';
export const SURFACE_HOST_UNSUPPORTED = 'unsupported';

export const DEFAULT_READY_TIMEOUT_MS = 2_000;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 3_000;
export const DEFAULT_FILE_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_EVAL_TIMEOUT_MS = 10_000;

export const BRIDGE_GLOBAL = '__dsBrowserBridge';

/** WKWebView 默认 UA 缺少 Safari 产品标记，部分桌面站点会降级到 HTTP。 */
export const MACOS_DESKTOP_SAFARI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserCreateOptions {
  url: string;
  title: string;
  width: number;
  height: number;
  focused: boolean;
  profileDir: string;
  initializationScript: string;
  headless?: boolean;
}

export interface BrowserTabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  isLoading?: boolean;
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

export interface BrowserNetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status: number;
  statusText: string;
  resourceType: string;
  failed: boolean;
  errorText?: string;
  timestamp: number;
}

export interface BrowserScreenshotOptions {
  fullPage?: boolean;
  annotate?: boolean;
  maxWidth?: number;
  quality?: number;
}

export interface BrowserWaitOptions {
  text?: string;
  selector?: string;
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
}

export interface BrowserCloseTabResult {
  closed: boolean;
  activeTabId: string | null;
  remainingCount: number;
  activeTab: BrowserTabInfo | null;
}

export interface BrowserDownloadPolicy {
  agentOwned: boolean;
  artifactDir: string | null;
}

export interface BrowserExtractOptions {
  maxChars?: number;
  startIndex?: number;
}

export interface BrowserSnapshotOptions {
  interactiveOnly: boolean;
  maxChars?: number;
  diff?: boolean;
  selector?: string;
}

export interface BrowserClickOptions {
  ref?: string;
  x?: number;
  y?: number;
  doubleClick?: boolean;
  button?: 'left' | 'right' | 'middle';
}

export interface BrowserTypeOptions {
  clear?: boolean;
  submit?: boolean;
}

export interface BrowserHoverOptions {
  ref?: string;
  x?: number;
  y?: number;
}

export interface BrowserPressKeyOptions {
  key: string;
  modifiers?: string[];
}

export interface BrowserSelectOptionOptions {
  ref: string;
  values: string[];
}

export interface BrowserRemoteInputOptions {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'insertText';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  modifiers?: string[];
  text?: string;
}

/**
 * `browser.screenshot` 的结果。成功时是 browser-content surface 的真实可见像素
 * （PNG/JPEG base64，不含窗口装饰）；无可见像素/平台 API 不可用时保持 Rust
 * `browser_screenshot` 的 `PLATFORM_API_UNAVAILABLE` 形状，绝不用 DOM 快照或合成图代替。
 */
export type BrowserScreenshotResult =
  | {
      available: true;
      capability: 'browser_visible_webview_screenshot';
      mimeType: 'image/png' | 'image/jpeg';
      dataBase64: string;
      width: number;
      height: number;
      annotated?: boolean;
    }
  | {
      available: false;
      capability: 'browser_visible_webview_screenshot';
      reasonCode: 'PLATFORM_API_UNAVAILABLE';
      reason: string;
    };

/** `BrowserContentSurface` 中 `browser.*` 分派实际使用的方法子集（测试可传替身）。 */
export interface BrowserSurfaceLike {
  hostMode(): string;
  createContentWindow(options: BrowserCreateOptions): Promise<void>;
  destroyContentWindow(): Promise<boolean>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  focusContentWindow(): Promise<void>;
  releaseContentFocus(): Promise<void>;
  mainViewportSize(): Promise<{ width: number; height: number }>;
  setContentBounds(bounds: PhysicalRect): Promise<void>;
  setContentOcclusions(
    occlusions: readonly PhysicalRect[],
    inputOcclusions: readonly PhysicalRect[],
  ): Promise<void>;
  setContentVisibility(visible: boolean, focus: boolean): Promise<void>;
  /** 原生 surface 截图；不可用时返回 `PLATFORM_API_UNAVAILABLE` 形状，不伪造 DOM 快照。 */
  screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>;
  snapshot(options: BrowserSnapshotOptions): Promise<unknown>;
  click(target: string | BrowserClickOptions): Promise<unknown>;
  typeText(ref: string, text: string, options?: BrowserTypeOptions): Promise<unknown>;
  setInputFiles(ref: string, files: unknown): Promise<unknown>;
  scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<unknown>;
  hover?(options: BrowserHoverOptions): Promise<unknown>;
  pressKey?(options: BrowserPressKeyOptions): Promise<unknown>;
  selectOption?(options: BrowserSelectOptionOptions): Promise<unknown>;
  waitFor?(options: BrowserWaitOptions): Promise<unknown>;
  extractContent?(options: BrowserExtractOptions): Promise<unknown>;
  listTabs?(): Promise<BrowserTabInfo[]>;
  newTab?(options: { url?: string; active?: boolean }): Promise<BrowserTabInfo>;
  switchTab?(tabId: string): Promise<BrowserTabInfo>;
  closeTab?(tabId: string): Promise<BrowserCloseTabResult | boolean>;
  consoleLogs?(options: { level?: string; limit?: number }): Promise<BrowserConsoleEntry[]>;
  networkLogs?(options: { statusMin?: number; limit?: number }): Promise<BrowserNetworkEntry[]>;
  promoteToInteractive?(): Promise<{ promoted: boolean; headless: boolean }>;
  remoteInput?(options: BrowserRemoteInputOptions): Promise<unknown>;
  setDownloadPolicy?(policy: BrowserDownloadPolicy): void;
  /** browser 插件推送的 Agent 控制开关与 http 策略（形状非法时抛错）。 */
  setAgentNavigationPolicy(policy: unknown): void;
  /** 插件侧 preflight 的 DNS：与外壳导航拦截共用同一解析器、超时与 busy 语义。 */
  resolveAgentHost(host: string): Promise<{ addresses: string[] } | { error: string }>;
}

/** 将 `browser.scroll` 的 `{ direction, amount, ref }` 参数转换为 `ax-lite` 桥脚本期望的 `{ to | dx | dy, ref }`。 */
export function translateAxLiteScrollOptions(options: {
  direction: string | null;
  amount: number | null;
  ref: string | null;
}): { to?: 'top' | 'bottom'; dx?: number; dy?: number; ref?: string } {
  const direction = (options.direction ?? 'down').trim().toLowerCase();
  const amount =
    typeof options.amount === 'number' && Number.isFinite(options.amount)
      ? Math.abs(options.amount)
      : 480;
  const refPart = typeof options.ref === 'string' && options.ref !== '' ? { ref: options.ref } : {};
  if (direction === 'top') return { to: 'top', ...refPart };
  if (direction === 'bottom') return { to: 'bottom', ...refPart };
  if (direction === 'up') return { dx: 0, dy: -amount, ...refPart };
  if (direction === 'left') return { dx: -amount, dy: 0, ...refPart };
  if (direction === 'right') return { dx: amount, dy: 0, ...refPart };
  return { dx: 0, dy: amount, ...refPart };
}

const WINDOWS_RESERVED_FILENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 清洗下载文件名：去掉路径分隔符、控制字符、前导点与非法字符，避免路径穿越或平台非法名。 */
export function sanitizeDownloadFilename(rawFilename: string): string {
  const segment = rawFilename.split(/[/\\]/).pop() ?? '';
  let cleaned = '';
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      cleaned += '_';
      continue;
    }
    const ch = segment[i]!;
    if ('<>:"/\\|?*'.includes(ch)) {
      cleaned += '_';
    } else {
      cleaned += ch;
    }
  }
  cleaned = cleaned.replace(/^\.+/, '').replace(/[\s.]+$/, '').replace(/\s+/g, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'download';
  }
  if (WINDOWS_RESERVED_FILENAME_RE.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  if (cleaned.length > 120) {
    const dotIdx = cleaned.lastIndexOf('.');
    const ext = dotIdx > 0 && cleaned.length - dotIdx <= 16 ? cleaned.slice(dotIdx) : '';
    const stem = cleaned.slice(0, 120 - ext.length).replace(/[\s.]+$/, '');
    cleaned = (stem || 'download') + ext;
  }
  return cleaned;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `Duration` 的 Debug 输出（`3s`、`1.5s`、`100ms`）。 */
export function durationDebug(milliseconds: number): string {
  if (milliseconds >= 1_000) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * `bridge.rs::parse_bridge_json` + `BridgeEnvelope::into_result`。
 * WebView2/WKWebView 对字符串结果会再编码一层，因此字符串结果要解套一次。
 */
export function parseBridgeEnvelope(raw: unknown): unknown {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('invalid JSON from bridge: empty script result');

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`invalid JSON from bridge: ${messageOf(error)}; raw=${truncate(trimmed, 200)}`);
  }
  if (typeof value === 'string') {
    const nested = value;
    try {
      value = JSON.parse(nested);
    } catch (error) {
      throw new Error(`invalid JSON from bridge: nested string parse: ${messageOf(error)}; inner=${truncate(nested, 200)}`);
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid JSON from bridge: expected an envelope object');
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.ok !== 'boolean') {
    throw new Error("invalid JSON from bridge: missing boolean field 'ok'");
  }
  if (envelope.ok) return envelope.data ?? null;

  const body = envelope.error;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('bridge error UNKNOWN: bridge returned ok=false without error');
  }
  const record = body as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
  const message = typeof record.message === 'string' ? record.message : 'bridge returned ok=false without error';
  if (typeof record.code === 'string' && typeof record.message === 'string') {
    // Rust Option<Value>: absent and null are None; false/0/empty and nested values are Some.
    throw new BrowserBridgeError({ code, message, ...(record.details == null ? {} : { details: record.details }) });
  }
  throw new Error(`bridge error ${code}: ${message}`);
}

/** `bridge.rs::call_script`（同步方法；Promise 结果视为桥实现错误）。 */
export function buildCallScript(method: string, argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.${method} !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'${BRIDGE_GLOBAL} missing or ${method} not a function'}
      });
    }
    var result = b.${method}(${argsJson});
    if (result && typeof result.then === 'function') {
      throw new Error('async bridge methods are not supported in sync eval path');
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

/** `bridge.rs::BridgeClient::type_text` 的多位置参数脚本。 */
export function buildTypeScript(argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.type !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'bridge type missing'}
      });
    }
    var args = ${argsJson};
    var result = b.type(args[0], args[1], args[2] || {});
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

/** `bridge.rs::BridgeClient::set_input_files` 的多位置参数脚本。 */
export function buildSetInputFilesScript(argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.setInputFiles !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'bridge setInputFiles missing'}
      });
    }
    var args = ${argsJson};
    return JSON.stringify(b.setInputFiles(args[0], args[1]));
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

function cssNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('browser surface occlusion coordinate must be finite');
  return String(Math.round(value * 1_000) / 1_000);
}

/** 生成 even-odd 的 CSS `path()`：外框为可见区域，每个 rect 挖一个洞。 */
export function buildEvenOddClipPath(
  width: number,
  height: number,
  rects: readonly LogicalRect[],
): string {
  const data = [`M0 0 L${cssNumber(width)} 0 L${cssNumber(width)} ${cssNumber(height)} L0 ${cssNumber(height)} Z`];
  for (const rect of rects) {
    const x = cssNumber(rect.x);
    const y = cssNumber(rect.y);
    const right = cssNumber(rect.x + rect.width);
    const bottom = cssNumber(rect.y + rect.height);
    data.push(`M${x} ${y} L${right} ${y} L${right} ${bottom} L${x} ${bottom} Z`);
  }
  return `path(evenodd, '${data.join(' ')}')`;
}

/**
 * content 页内执行：保存原始背景、铺一层等效背景、把画布设为透明、用 even-odd
 * clip-path 挖洞。清空 rects 时恢复原始内联样式并移除背景层。
 */
export function buildOcclusionScript(
  rects: readonly LogicalRect[],
  width: number,
  height: number,
): string {
  const path = rects.length === 0 ? '' : buildEvenOddClipPath(width, height, rects);
  return `(function(rects, width, height, clipPath) {
  var KEY = '__dsBrowserOcclusions';
  var html = document.documentElement;
  var body = document.body;
  if (!html || !body) return { ok: false, error: 'document has no root or body' };
  var state = window[KEY];
  if (!state) {
    state = {
      htmlBackground: html.style.background,
      bodyBackground: body.style.background,
      clipPath: html.style.clipPath,
      background: null,
      layer: null
    };
    window[KEY] = state;
  }
  function restore() {
    html.style.background = state.htmlBackground;
    body.style.background = state.bodyBackground;
    html.style.clipPath = state.clipPath;
    if (state.layer && state.layer.parentNode) state.layer.parentNode.removeChild(state.layer);
    try { delete window[KEY]; } catch (error) { window[KEY] = undefined; }
    return { ok: true, applied: false };
  }
  if (rects.length === 0) return restore();

  function hasPaint(style) {
    if (style.backgroundImage && style.backgroundImage !== 'none') return true;
    var color = style.backgroundColor || '';
    if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return false;
    var rgba = /rgba\\(([^)]+)\\)/.exec(color);
    if (rgba) {
      var parts = rgba[1].split(',');
      if (parts.length === 4 && Number(parts[3]) === 0) return false;
    }
    return color !== '';
  }

  if (!state.background) {
    var htmlStyle = window.getComputedStyle(html);
    var bodyStyle = window.getComputedStyle(body);
    var source = hasPaint(htmlStyle) ? htmlStyle : (hasPaint(bodyStyle) ? bodyStyle : null);
    state.background = source === null
      ? { backgroundColor: '#ffffff' }
      : {
          backgroundColor: source.backgroundColor,
          backgroundImage: source.backgroundImage,
          backgroundRepeat: source.backgroundRepeat,
          backgroundPosition: source.backgroundPosition,
          backgroundSize: source.backgroundSize,
          backgroundAttachment: source.backgroundAttachment,
          backgroundOrigin: source.backgroundOrigin,
          backgroundClip: source.backgroundClip
        };
  }
  if (!state.layer || !state.layer.parentNode) {
    var layer = document.createElement('div');
    layer.setAttribute('data-ds-browser-occlusion-layer', '');
    layer.style.position = 'fixed';
    layer.style.left = '0';
    layer.style.top = '0';
    layer.style.width = '100vw';
    layer.style.height = '100vh';
    layer.style.zIndex = '-2147483648';
    layer.style.pointerEvents = 'none';
    var background = state.background;
    var names = Object.keys(background);
    for (var i = 0; i < names.length; i += 1) layer.style[names[i]] = background[names[i]];
    body.appendChild(layer);
    state.layer = layer;
  }
  html.style.background = 'transparent';
  body.style.background = 'transparent';
  html.style.clipPath = clipPath;
  return { ok: true, applied: true };
})(${JSON.stringify(rects)}, ${cssNumber(width)}, ${cssNumber(height)}, ${JSON.stringify(path)})`;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Error(`browser shell op argument ${name} must be a string`);
  return value;
}

function requireRect(value: unknown, name: string): PhysicalRect {
  if (typeof value !== 'object' || value === null) throw new Error(`browser shell op argument ${name} must be a rectangle`);
  const rect = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const item = rect[key];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error(`browser shell op argument ${name}.${key} must be a finite number`);
    }
  }
  return rect as unknown as PhysicalRect;
}

function requireRects(value: unknown, name: string): PhysicalRect[] {
  if (!Array.isArray(value)) throw new Error(`browser shell op argument ${name} must be an array`);
  return value.map((item, index) => requireRect(item, `${name}[${index}]`));
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`browser shell op argument ${name} must be a finite number`);
  }
  return value;
}

function parseMouseButton(value: unknown): 'left' | 'right' | 'middle' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'left' || value === 'right' || value === 'middle') return value;
  throw new Error('browser shell op argument button must be left, right, or middle');
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`browser shell op argument ${name} must be an array of strings`);
  }
  return value as string[];
}

function parseScreenshotOptions(args: Record<string, unknown>): BrowserScreenshotOptions | undefined {
  const options: BrowserScreenshotOptions = {};
  let hasOption = false;
  if (typeof args.fullPage === 'boolean') {
    options.fullPage = args.fullPage;
    hasOption = true;
  }
  if (typeof args.annotate === 'boolean') {
    options.annotate = args.annotate;
    hasOption = true;
  }
  if (typeof args.maxWidth === 'number' && Number.isFinite(args.maxWidth)) {
    options.maxWidth = args.maxWidth;
    hasOption = true;
  }
  if (typeof args.quality === 'number' && Number.isFinite(args.quality)) {
    options.quality = args.quality;
    hasOption = true;
  }
  return hasOption ? options : undefined;
}

function requireCapability<T>(fn: T | undefined, op: string): T {
  if (fn === undefined) throw new Error(`browser surface does not support ${op}`);
  return fn;
}

/**
 * `ctx.shell.request` 的 `browser.*` 分派（op 名与参数形状来自 L19 `surface-host.ts`）。
 * 数值坐标统一为物理像素；`setContentBounds` 的 args 本身就是矩形。
 */
export async function handleBrowserShellRequest(
  surface: BrowserSurfaceLike,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (op) {
    case 'browser.hostMode':
      return surface.hostMode();
    case 'browser.createContentWindow': {
      const options: BrowserCreateOptions = {
        url: requireString(args, 'url'),
        title: typeof args.title === 'string' ? args.title : 'Browser',
        width: typeof args.width === 'number' ? args.width : 960,
        height: typeof args.height === 'number' ? args.height : 720,
        focused: args.focused !== false,
        profileDir: requireString(args, 'profileDir'),
        initializationScript: typeof args.initializationScript === 'string' ? args.initializationScript : '',
        ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
      };
      await surface.createContentWindow(options);
      return null;
    }
    case 'browser.destroyContentWindow':
      return surface.destroyContentWindow();
    case 'browser.navigate':
      await surface.navigate(requireString(args, 'url'));
      return null;
    case 'browser.goBack':
      await surface.goBack();
      return null;
    case 'browser.goForward':
      await surface.goForward();
      return null;
    case 'browser.reload':
      await surface.reload();
      return null;
    case 'browser.focusContentWindow':
      await surface.focusContentWindow();
      return null;
    case 'browser.releaseContentFocus':
      await surface.releaseContentFocus();
      return null;
    case 'browser.mainViewportSize':
      return surface.mainViewportSize();
    case 'browser.setContentBounds':
      await surface.setContentBounds(requireRect(args, 'bounds'));
      return null;
    case 'browser.setContentOcclusions':
      await surface.setContentOcclusions(
        requireRects(args.occlusions, 'occlusions'),
        requireRects(args.inputOcclusions, 'inputOcclusions'),
      );
      return null;
    case 'browser.setContentVisibility':
      await surface.setContentVisibility(args.visible === true, args.focus === true);
      return null;
    case 'browser.screenshot': {
      const options = parseScreenshotOptions(args);
      return options === undefined ? surface.screenshot() : surface.screenshot(options);
    }
    case 'browser.snapshot': {
      const options: BrowserSnapshotOptions = { interactiveOnly: args.interactiveOnly !== false };
      if (typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)) options.maxChars = args.maxChars;
      if (typeof args.diff === 'boolean') options.diff = args.diff;
      if (typeof args.selector === 'string' && args.selector.trim() !== '') options.selector = args.selector;
      return surface.snapshot(options);
    }
    case 'browser.click': {
      const hasRef = typeof args.ref === 'string';
      const hasCoords = args.x !== undefined || args.y !== undefined;
      const hasExtra = args.doubleClick !== undefined || args.button !== undefined;
      if (hasRef && !hasCoords && !hasExtra) {
        return surface.click(args.ref as string);
      }
      const clickOptions: BrowserClickOptions = {};
      if (hasRef) {
        clickOptions.ref = args.ref as string;
      } else if (hasCoords) {
        clickOptions.x = requireFiniteNumber(args.x, 'x');
        clickOptions.y = requireFiniteNumber(args.y, 'y');
      } else {
        throw new Error('browser shell op argument ref must be a string or x/y must be finite numbers');
      }
      if (typeof args.doubleClick === 'boolean') clickOptions.doubleClick = args.doubleClick;
      const button = parseMouseButton(args.button);
      if (button !== undefined) clickOptions.button = button;
      return surface.click(clickOptions);
    }
    case 'browser.typeText': {
      const ref = requireString(args, 'ref');
      const text = requireString(args, 'text');
      const typeOptions: BrowserTypeOptions = {
        clear: typeof args.clear === 'boolean' ? args.clear : false,
      };
      if (typeof args.submit === 'boolean') typeOptions.submit = args.submit;
      return surface.typeText(ref, text, typeOptions);
    }
    case 'browser.setInputFiles':
      return surface.setInputFiles(requireString(args, 'ref'), args.files);
    case 'browser.scroll':
      return surface.scroll({
        direction: typeof args.direction === 'string' ? args.direction : null,
        amount: typeof args.amount === 'number' ? args.amount : null,
        ref: typeof args.ref === 'string' ? args.ref : null,
      });
    case 'browser.hover': {
      const hover = requireCapability(surface.hover, op).bind(surface);
      const hoverOptions: BrowserHoverOptions = {};
      if (typeof args.ref === 'string') {
        hoverOptions.ref = args.ref;
      } else {
        hoverOptions.x = requireFiniteNumber(args.x, 'x');
        hoverOptions.y = requireFiniteNumber(args.y, 'y');
      }
      return hover(hoverOptions);
    }
    case 'browser.pressKey': {
      const pressKey = requireCapability(surface.pressKey, op).bind(surface);
      const pressOptions: BrowserPressKeyOptions = {
        key: requireString(args, 'key'),
        ...(args.modifiers !== undefined ? { modifiers: parseStringArray(args.modifiers, 'modifiers') } : {}),
      };
      return pressKey(pressOptions);
    }
    case 'browser.selectOption': {
      const selectOption = requireCapability(surface.selectOption, op).bind(surface);
      const rawValues = args.values !== undefined
        ? parseStringArray(args.values, 'values')
        : typeof args.value === 'string'
          ? [args.value]
          : (() => {
              throw new Error('browser shell op argument values must be an array of strings');
            })();
      return selectOption({ ref: requireString(args, 'ref'), values: rawValues });
    }
    case 'browser.waitFor': {
      const waitFor = requireCapability(surface.waitFor, op).bind(surface);
      const waitOptions: BrowserWaitOptions = {};
      if (typeof args.text === 'string') waitOptions.text = args.text;
      if (typeof args.selector === 'string') waitOptions.selector = args.selector;
      if (args.loadState === 'load' || args.loadState === 'domcontentloaded' || args.loadState === 'networkidle') {
        waitOptions.loadState = args.loadState;
      } else if (args.loadState !== undefined) {
        throw new Error('browser shell op argument loadState must be load, domcontentloaded, or networkidle');
      }
      if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
        waitOptions.timeoutMs = args.timeoutMs;
      }
      return waitFor(waitOptions);
    }
    case 'browser.extractContent': {
      const extractContent = requireCapability(surface.extractContent, op).bind(surface);
      const extractOptions: BrowserExtractOptions = {};
      if (typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)) {
        extractOptions.maxChars = args.maxChars;
      }
      if (typeof args.startIndex === 'number' && Number.isFinite(args.startIndex)) {
        extractOptions.startIndex = args.startIndex;
      }
      return extractContent(extractOptions);
    }
    case 'browser.listTabs': {
      const listTabs = requireCapability(surface.listTabs, op).bind(surface);
      return listTabs();
    }
    case 'browser.newTab': {
      const newTab = requireCapability(surface.newTab, op).bind(surface);
      const options: { url?: string; active?: boolean } = {};
      if (typeof args.url === 'string') options.url = args.url;
      if (typeof args.active === 'boolean') options.active = args.active;
      return newTab(options);
    }
    case 'browser.switchTab': {
      const switchTab = requireCapability(surface.switchTab, op).bind(surface);
      return switchTab(requireString(args, 'tabId'));
    }
    case 'browser.closeTab': {
      const closeTab = requireCapability(surface.closeTab, op).bind(surface);
      return closeTab(requireString(args, 'tabId'));
    }
    case 'browser.consoleLogs': {
      const consoleLogs = requireCapability(surface.consoleLogs, op).bind(surface);
      const options: { level?: string; limit?: number } = {};
      if (typeof args.level === 'string') options.level = args.level;
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) options.limit = args.limit;
      return consoleLogs(options);
    }
    case 'browser.networkLogs': {
      const networkLogs = requireCapability(surface.networkLogs, op).bind(surface);
      const options: { statusMin?: number; limit?: number } = {};
      if (typeof args.statusMin === 'number' && Number.isFinite(args.statusMin)) options.statusMin = args.statusMin;
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) options.limit = args.limit;
      return networkLogs(options);
    }
    case 'browser.promoteToInteractive': {
      const promoteToInteractive = requireCapability(surface.promoteToInteractive, op).bind(surface);
      return promoteToInteractive();
    }
    case 'browser.remoteInput': {
      const remoteInput = requireCapability(surface.remoteInput, op).bind(surface);
      const inputType = requireString(args, 'type');
      const allowedTypes = ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel', 'keyDown', 'keyUp', 'insertText'] as const;
      if (!(allowedTypes as readonly string[]).includes(inputType)) {
        throw new Error(`browser shell op argument type is invalid: ${inputType}`);
      }
      const remoteOptions: BrowserRemoteInputOptions = {
        type: inputType as BrowserRemoteInputOptions['type'],
      };
      if (typeof args.x === 'number' && Number.isFinite(args.x)) remoteOptions.x = args.x;
      if (typeof args.y === 'number' && Number.isFinite(args.y)) remoteOptions.y = args.y;
      const button = parseMouseButton(args.button);
      if (button !== undefined) remoteOptions.button = button;
      if (typeof args.clickCount === 'number' && Number.isFinite(args.clickCount)) remoteOptions.clickCount = args.clickCount;
      if (typeof args.deltaX === 'number' && Number.isFinite(args.deltaX)) remoteOptions.deltaX = args.deltaX;
      if (typeof args.deltaY === 'number' && Number.isFinite(args.deltaY)) remoteOptions.deltaY = args.deltaY;
      if (typeof args.key === 'string') remoteOptions.key = args.key;
      if (args.modifiers !== undefined) remoteOptions.modifiers = parseStringArray(args.modifiers, 'modifiers');
      if (typeof args.text === 'string') remoteOptions.text = args.text;
      return remoteInput(remoteOptions);
    }
    case 'browser.setDownloadPolicy': {
      if (typeof args.agentOwned !== 'boolean') {
        throw new Error('browser shell op argument agentOwned must be a boolean');
      }
      let artifactDir: string | null;
      if (args.artifactDir === undefined || args.artifactDir === null) {
        artifactDir = null;
      } else if (typeof args.artifactDir === 'string') {
        artifactDir = args.artifactDir.trim() !== '' ? args.artifactDir : null;
      } else {
        throw new Error('browser shell op argument artifactDir must be a string or null');
      }
      surface.setDownloadPolicy?.({ agentOwned: args.agentOwned, artifactDir });
      return null;
    }
    case 'browser.setAgentNavigationPolicy':
      surface.setAgentNavigationPolicy(args);
      return null;
    case 'browser.resolveAgentHost':
      return surface.resolveAgentHost(requireString(args, 'host'));
    default:
      throw new Error(`unknown shell op: ${op}`);
  }
}
