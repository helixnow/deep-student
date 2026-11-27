/**
 * dstu-browser 的原生窗口面（Electron 实现）。
 *
 * 对应 Rust：
 * - `crates/dstu-browser/src/browser/window.rs`：`browser-content` 创建/销毁/焦点/尺寸/可见性/遮挡
 * - `crates/dstu-browser/src/browser/bridge.rs`：把 `__dsBrowserBridge` 方法调用送到 content 页并解析信封
 * - `crates/dstu-browser/src/browser/window/macos_surface_clip.rs`：macOS 输入遮挡（见 browser-occlusion.ts）
 *
 * macOS / Windows：`WebContentsView` 嵌入主窗口，固定 label `browser-content`。
 * Linux：独立 `BrowserWindow` fallback（Rust `SURFACE_HOST_DETACHED`）。
 * Headless：隐藏 `BrowserWindow({ show: false, webPreferences: { offscreen: true } })`，可随时
 * `promoteToInteractive()` 切换到可见交互窗口。
 *
 * 视觉遮挡的 Electron 实现说明：Chromium 合成器直接绘制 `WebContentsViewCocoa`，父视图的
 * CAShapeLayer mask 不影响其像素输出。macOS 下改为在 content 页注入根元素 `clip-path`
 * （even-odd 挖洞）+ 透明画布 + 背景层，主页面即可从洞中透出；输入遮挡由
 * `MacInputOcclusionHost` 负责。Windows/Linux 与 Rust 一样不应用遮挡。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  BrowserWindow,
  nativeImage,
  screen,
  session as electronSession,
  WebContentsView,
  type NativeImage,
  type Session,
  type WebContents,
} from 'electron';
import type { AgentHostAnswer, AgentNavigationGuard } from './browser-agent-guard.ts';
import { BrowserCdpSession, type CdpBase64FilePayload, type CdpImageResizeResult } from './browser-cdp.ts';
import { MacInputOcclusionHost } from './browser-occlusion.ts';
import {
  BROWSER_CONTENT_LABEL,
  BrowserBridgeError,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_FILE_ACTION_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  MAIN_WINDOW_LABEL,
  MACOS_DESKTOP_SAFARI_USER_AGENT,
  SURFACE_HOST_DETACHED,
  SURFACE_HOST_EMBEDDED,
  SURFACE_HOST_HEADLESS,
  SURFACE_HOST_UNSUPPORTED,
  buildCallScript,
  buildOcclusionScript,
  buildSetInputFilesScript,
  buildTypeScript,
  durationDebug,
  messageOf,
  parseBridgeEnvelope,
  sanitizeDownloadFilename,
  translateAxLiteScrollOptions,
  type BrowserClickOptions,
  type BrowserCloseTabResult,
  type BrowserConsoleEntry,
  type BrowserCreateOptions,
  type BrowserDownloadPolicy,
  type BrowserExtractOptions,
  type BrowserHoverOptions,
  type BrowserNetworkEntry,
  type BrowserPressKeyOptions,
  type BrowserRemoteInputOptions,
  type BrowserScreenshotOptions,
  type BrowserScreenshotResult,
  type BrowserSelectOptionOptions,
  type BrowserSnapshotOptions,
  type BrowserSurfaceLike,
  type BrowserTabInfo,
  type BrowserTypeOptions,
  type BrowserWaitOptions,
  type LogicalRect,
  type PhysicalRect,
} from './browser-protocol.ts';
import type { ShellPlatform } from './tauri-config.ts';

/** 截图空图重试：3 次 × 100ms，覆盖导航刚完成/合成器繁忙的短暂空帧。 */
const SCREENSHOT_ATTEMPTS = 3;
const SCREENSHOT_RETRY_MS = 100;

export const DOWNLOAD_STARTED_EVENT = 'dstu-browser://download-started';
export const DOWNLOAD_FINISHED_EVENT = 'dstu-browser://download-finished';

export {
  BROWSER_CONTENT_LABEL,
  BRIDGE_GLOBAL,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_FILE_ACTION_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  MAIN_WINDOW_LABEL,
  MACOS_DESKTOP_SAFARI_USER_AGENT,
  SURFACE_HOST_DETACHED,
  SURFACE_HOST_EMBEDDED,
  SURFACE_HOST_HEADLESS,
  SURFACE_HOST_UNSUPPORTED,
  handleBrowserShellRequest,
} from './browser-protocol.ts';
export type {
  BrowserClickOptions,
  BrowserCloseTabResult,
  BrowserConsoleEntry,
  BrowserCreateOptions,
  BrowserDownloadPolicy,
  BrowserExtractOptions,
  BrowserHoverOptions,
  BrowserNetworkEntry,
  BrowserPressKeyOptions,
  BrowserRemoteInputOptions,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserSelectOptionOptions,
  BrowserSnapshotOptions,
  BrowserTabInfo,
  BrowserTypeOptions,
  BrowserWaitOptions,
  LogicalRect,
  PhysicalRect,
} from './browser-protocol.ts';

export interface BrowserSurfaceOptions {
  platform: ShellPlatform;
  preloadPath: string;
  getMainWindow(): BrowserWindow | null;
  registerWebview(
    contents: WebContents,
    label: string,
    windowLabel: string,
    initializationScript: string,
  ): void;
  unregisterWebview(contents: WebContents, reason: 'window-closed' | 'reloaded'): void;
  /** 页面建的应用窗口是否占用了该 label。 */
  appWindowExists(label: string): boolean;
  /** Agent 控制时的私网防护；装在每个 browser-content 会话与 webContents 上。 */
  agentGuard: AgentNavigationGuard;
  /** 可选：发送 native 事件给 Host（如下载开始/完成）。 */
  emitNativeEvent?: (windowLabel: string, event: string, payload: Record<string, unknown>) => void;
  log(message: string): void;
}

type TabHostMode = 'embedded' | 'detached' | 'headless';

interface TabState {
  readonly id: string;
  readonly mode: TabHostMode;
  readonly view: WebContentsView | null;
  readonly window: BrowserWindow | null;
  readonly webContents: WebContents;
  readonly cdp: BrowserCdpSession;
  url: string;
  title: string;
}

function windowScale(window: BrowserWindow): number {
  const factor = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function toLogical(rect: PhysicalRect, scale: number): LogicalRect {
  return {
    x: rect.x / scale,
    y: rect.y / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

function toRoundedLogicalBounds(rect: PhysicalRect, scale: number): LogicalRect {
  return {
    x: Math.round(rect.x / scale),
    y: Math.round(rect.y / scale),
    width: Math.max(0, Math.round(rect.width / scale)),
    height: Math.max(0, Math.round(rect.height / scale)),
  };
}

function resizeCapturedImage(
  buffer: Buffer,
  mimeType: 'image/png' | 'image/jpeg',
  maxWidth: number,
  quality: number,
): CdpImageResizeResult {
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    return {
      dataBase64: buffer.toString('base64'),
      width: 0,
      height: 0,
      mimeType,
    };
  }
  const originalSize = image.getSize();
  if (maxWidth > 0 && originalSize.width > maxWidth) {
    image = image.resize({ width: maxWidth });
  }
  const size = image.getSize();
  const encoded = mimeType === 'image/png' ? image.toPNG() : image.toJPEG(Math.max(1, Math.min(100, Math.round(quality))));
  return {
    dataBase64: encoded.toString('base64'),
    width: size.width,
    height: size.height,
    mimeType,
  };
}

function extractCanonicalFilePaths(files: unknown): string[] | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const paths: string[] = [];
  for (const item of files) {
    if (typeof item === 'string' && item.trim() !== '') {
      paths.push(item);
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const candidate = (item as { path?: unknown }).path;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        paths.push(candidate);
        continue;
      }
    }
    return null;
  }
  return paths;
}

function extractBase64FilePayloads(files: unknown): CdpBase64FilePayload[] | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const payloads: CdpBase64FilePayload[] = [];
  for (const item of files) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as { name?: unknown; base64?: unknown; mimeType?: unknown; lastModified?: unknown };
    if (typeof record.name !== 'string' || typeof record.base64 !== 'string') return null;
    payloads.push({
      name: record.name,
      base64: record.base64,
      ...(typeof record.mimeType === 'string' && record.mimeType !== '' ? { mimeType: record.mimeType } : {}),
      ...(typeof record.lastModified === 'number' && Number.isFinite(record.lastModified)
        ? { lastModified: record.lastModified }
        : {}),
    });
  }
  return payloads;
}

export class BrowserContentSurface implements BrowserSurfaceLike {
  private readonly tabs = new Map<string, TabState>();
  private activeTabId: string | null = null;
  private tabSequence = 0;
  private headless = false;
  private lastCreateOptions: BrowserCreateOptions | null = null;
  private lastPhysicalBounds: PhysicalRect | null = null;
  private contentVisible = false;
  private inputHost: MacInputOcclusionHost | null = null;
  private resizeListener: (() => void) | null = null;
  private visualLogical: LogicalRect[] = [];
  private inputLogical: LogicalRect[] = [];
  private readonly downloadSessions = new WeakSet<Session>();
  private downloadPolicy: BrowserDownloadPolicy = { agentOwned: false, artifactDir: null };
  private downloadSequence = 0;

  private readonly options: BrowserSurfaceOptions;

  constructor(options: BrowserSurfaceOptions) {
    this.options = options;
  }

  private platformHostMode(): string {
    if (this.options.platform === 'darwin' || this.options.platform === 'win32') return SURFACE_HOST_EMBEDDED;
    if (this.options.platform === 'linux') return SURFACE_HOST_DETACHED;
    return SURFACE_HOST_UNSUPPORTED;
  }

  hostMode(): string {
    if (this.headless && this.hasContentWindow()) return SURFACE_HOST_HEADLESS;
    return this.platformHostMode();
  }

  hasContentWindow(): boolean {
    for (const tab of this.tabs.values()) {
      if (this.isTabAlive(tab)) return true;
    }
    return false;
  }

  isActiveWebContents(contents: WebContents): boolean {
    if (this.activeTabId === null) return false;
    const active = this.tabs.get(this.activeTabId);
    if (active === undefined || !this.isTabAlive(active)) return false;
    return active.webContents === contents;
  }

  setDownloadPolicy(policy: BrowserDownloadPolicy): void {
    this.downloadPolicy = {
      agentOwned: policy.agentOwned === true,
      artifactDir:
        typeof policy.artifactDir === 'string' && policy.artifactDir.trim() !== ''
          ? policy.artifactDir
          : null,
    };
  }

  private allocateAgentDownloadPath(downloadsDir: string, rawFilename: string, url: string): string {
    const safeName = sanitizeDownloadFilename(rawFilename);
    const resolvedDir = resolve(downloadsDir);
    const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      this.downloadSequence += 1;
      const hash8 = createHash('sha256')
        .update(`${this.downloadSequence}\0${url}\0${safeName}`)
        .digest('hex')
        .slice(0, 8);
      const candidate = join(resolvedDir, `${hash8}-${safeName}`);
      const resolvedCandidate = resolve(candidate);
      if (!resolvedCandidate.startsWith(dirPrefix)) {
        throw new Error('resolved download target escaped artifactDir');
      }
      if (!existsSync(resolvedCandidate)) {
        return resolvedCandidate;
      }
    }
    throw new Error('unable to allocate unique download path');
  }

  private isTabAlive(tab: TabState): boolean {
    if (tab.window !== null && tab.window.isDestroyed()) return false;
    return !tab.webContents.isDestroyed();
  }

  private activeTab(error = 'browser-content webview not found'): TabState {
    if (this.activeTabId !== null) {
      const active = this.tabs.get(this.activeTabId);
      if (active !== undefined && this.isTabAlive(active)) return active;
    }
    for (const tab of this.tabs.values()) {
      if (this.isTabAlive(tab)) {
        this.activeTabId = tab.id;
        return tab;
      }
    }
    throw new Error(error);
  }

  private tabInfoOf(tab: TabState): BrowserTabInfo {
    const destroyed = tab.webContents.isDestroyed();
    const url = destroyed ? tab.url : (tab.webContents.getURL() || tab.url);
    const title = destroyed ? tab.title : (tab.webContents.getTitle() || tab.title);
    return {
      tabId: tab.id,
      url,
      title,
      active: tab.id === this.activeTabId,
      isLoading: destroyed ? false : tab.webContents.isLoading(),
    };
  }

  private nextTabId(): string {
    this.tabSequence += 1;
    return `tab-${this.tabSequence}`;
  }

  private ensureMacOcclusionHost(mainWindow: BrowserWindow): void {
    if (this.options.platform !== 'darwin' || this.inputHost !== null) return;
    this.inputHost = MacInputOcclusionHost.install(mainWindow);
    this.resizeListener = () => this.inputHost?.raise();
    mainWindow.on('resize', this.resizeListener);
  }

  private installDownloadBridge(browserSession: Session): void {
    if (this.downloadSessions.has(browserSession)) return;
    this.downloadSessions.add(browserSession);
    browserSession.on('will-download', (_event, item, webContents) => {
      const ownsWebContents = [...this.tabs.values()].some((tab) => tab.webContents === webContents);
      if (!ownsWebContents && this.tabs.size > 0) return;

      const url = item.getURL();
      const filename = item.getFilename();
      const mimeType = item.getMimeType();
      const totalBytes = item.getTotalBytes();
      const windowLabel = this.platformHostMode() === SURFACE_HOST_DETACHED ? BROWSER_CONTENT_LABEL : MAIN_WINDOW_LABEL;

      let targetPath: string | null = null;
      if (this.downloadPolicy.agentOwned && this.downloadPolicy.artifactDir !== null) {
        try {
          const downloadsDir = join(this.downloadPolicy.artifactDir, 'browser-downloads');
          mkdirSync(downloadsDir, { recursive: true });
          targetPath = this.allocateAgentDownloadPath(downloadsDir, filename, url);
          item.setSavePath(targetPath);
        } catch (error) {
          this.options.log(`[browser] failed to stage agent download inside artifactDir: ${messageOf(error)}`);
          item.cancel();
          return;
        }
      }

      const startedSavePath = targetPath ?? (item.getSavePath() || null);
      this.options.emitNativeEvent?.(windowLabel, DOWNLOAD_STARTED_EVENT, {
        url,
        filename,
        mimeType,
        totalBytes,
        savePath: startedSavePath,
      });

      item.once('done', (_doneEvent, state) => {
        const finalPath = targetPath ?? (item.getSavePath() || null);
        this.options.emitNativeEvent?.(windowLabel, DOWNLOAD_FINISHED_EVENT, {
          url,
          filename,
          path: finalPath,
          savePath: finalPath,
          state,
          success: state === 'completed',
          receivedBytes: item.getReceivedBytes(),
        });
      });
    });
  }

  private prepareSession(profileDir: string, contextLabel: string): Session {
    try {
      const browserSession = electronSession.fromPath(profileDir);
      this.options.agentGuard.installSession(browserSession);
      this.installDownloadBridge(browserSession);
      return browserSession;
    } catch (error) {
      throw new Error(`failed to create ${contextLabel}: ${messageOf(error)}`);
    }
  }

  private createCdpSession(contents: WebContents): BrowserCdpSession {
    return new BrowserCdpSession({
      webContents: contents,
      platform: this.options.platform,
      log: this.options.log,
      resizeImage: resizeCapturedImage,
    });
  }

  async createContentWindow(options: BrowserCreateOptions): Promise<void> {
    if (this.hasContentWindow()) return;
    try {
      mkdirSync(options.profileDir, { recursive: true });
    } catch (error) {
      throw new Error(`failed to create browser profile dir ${options.profileDir}: ${messageOf(error)}`);
    }
    // RUST-FIX(RF-W06-browser-content-label-taken)：Rust 会把这个窗口当作已有的 browser-content 交给 Agent
    // （dstu-browser window.rs:413），这里按 Tauri 建 webview / 窗口撞 label 的报错拒绝（tauri-2.11.5 error.rs:38-42）。
    if (this.options.appWindowExists(BROWSER_CONTENT_LABEL)) {
      throw new Error(this.platformHostMode() === SURFACE_HOST_DETACHED
        ? `failed to create detached browser-content window: a window with label \`${BROWSER_CONTENT_LABEL}\` already exists`
        : `failed to create embedded browser-content webview: a webview with label \`${BROWSER_CONTENT_LABEL}\` already exists`);
    }
    this.lastCreateOptions = { ...options };
    this.headless = options.headless === true;
    const tab = this.headless
      ? this.createHeadlessTab(options)
      : this.platformHostMode() === SURFACE_HOST_DETACHED
        ? this.createDetachedTab(options, options.focused)
        : this.createEmbeddedTab(options, false);
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
  }

  private createEmbeddedTab(options: BrowserCreateOptions, visible: boolean): TabState {
    const mainWindow = this.options.getMainWindow();
    if (mainWindow === null) throw new Error(`parent window ${MAIN_WINDOW_LABEL} not found`);
    const browserSession = this.prepareSession(options.profileDir, 'embedded browser-content webview');
    let view: WebContentsView;
    try {
      view = new WebContentsView({
        webPreferences: {
          session: browserSession,
          preload: this.options.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
    } catch (error) {
      throw new Error(`failed to create embedded browser-content webview: ${messageOf(error)}`);
    }
    try {
      view.setBackgroundColor('#ffffff');
      mainWindow.contentView.addChildView(view);
      if (this.lastPhysicalBounds !== null) {
        const scale = windowScale(mainWindow);
        view.setBounds(toRoundedLogicalBounds(this.lastPhysicalBounds, scale));
      } else {
        view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      }
      view.setVisible(visible);
      if (this.options.platform === 'darwin') {
        view.webContents.setUserAgent(MACOS_DESKTOP_SAFARI_USER_AGENT);
      }
    } catch (error) {
      this.disposeFailedEmbeddedView(view);
      throw new Error(`failed to initialize embedded browser-content webview visibility: ${messageOf(error)}`);
    }

    if (this.options.platform === 'darwin') {
      try {
        this.ensureMacOcclusionHost(mainWindow);
      } catch (error) {
        this.disposeFailedEmbeddedView(view);
        throw new Error(`failed to install browser-content native occlusion host: ${messageOf(error)}`);
      }
    }

    const tabId = this.nextTabId();
    const tab: TabState = {
      id: tabId,
      mode: 'embedded',
      view,
      window: null,
      webContents: view.webContents,
      cdp: this.createCdpSession(view.webContents),
      url: options.url,
      title: options.title,
    };

    this.options.agentGuard.attachContents(view.webContents);
    this.options.registerWebview(
      view.webContents,
      BROWSER_CONTENT_LABEL,
      MAIN_WINDOW_LABEL,
      options.initializationScript,
    );
    view.webContents.on('did-finish-load', () => {
      if (!view.webContents.isDestroyed()) {
        tab.url = view.webContents.getURL() || tab.url;
        tab.title = view.webContents.getTitle() || tab.title;
      }
      if (this.activeTabId !== tab.id || this.visualLogical.length === 0) return;
      void this.applyVisualOcclusions(tab).catch((error: unknown) => {
        this.options.log(`[browser] failed to reapply browser-content occlusions: ${messageOf(error)}`);
      });
    });
    view.webContents.once('destroyed', () => {
      tab.cdp.detach();
      this.tabs.delete(tab.id);
      this.options.unregisterWebview(view.webContents, 'window-closed');
      if (this.activeTabId === tab.id) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
      if (this.tabs.size === 0) {
        this.cleanupOcclusionHost();
        this.visualLogical = [];
        this.inputLogical = [];
        this.contentVisible = false;
      }
    });
    void view.webContents.loadURL(options.url).catch((error: unknown) => {
      this.options.log(`[browser] failed to load browser-content url ${options.url}: ${messageOf(error)}`);
    });
    this.options.log(
      `[browser] created ${SURFACE_HOST_EMBEDDED} content host label=${BROWSER_CONTENT_LABEL} tab=${tabId} url=${options.url} profile=${options.profileDir}`,
    );
    return tab;
  }

  private createDetachedTab(options: BrowserCreateOptions, showFocused: boolean, show = true): TabState {
    const browserSession = this.prepareSession(options.profileDir, 'detached browser-content window');
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        title: options.title,
        // dstu-browser window.rs:523 `inner_size`：客户区尺寸。
        useContentSize: true,
        width: options.width,
        height: options.height,
        resizable: true,
        show: false,
        webPreferences: {
          session: browserSession,
          preload: this.options.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
    } catch (error) {
      throw new Error(`failed to create detached browser-content window: ${messageOf(error)}`);
    }

    const tabId = this.nextTabId();
    const tab: TabState = {
      id: tabId,
      mode: 'detached',
      view: null,
      window,
      webContents: window.webContents,
      cdp: this.createCdpSession(window.webContents),
      url: options.url,
      title: options.title,
    };

    this.options.agentGuard.attachContents(window.webContents);
    this.options.registerWebview(
      window.webContents,
      BROWSER_CONTENT_LABEL,
      BROWSER_CONTENT_LABEL,
      options.initializationScript,
    );
    window.webContents.on('did-finish-load', () => {
      if (!window.webContents.isDestroyed()) {
        tab.url = window.webContents.getURL() || tab.url;
        tab.title = window.webContents.getTitle() || tab.title;
      }
    });
    window.webContents.once('destroyed', () => {
      tab.cdp.detach();
      this.tabs.delete(tab.id);
      this.options.unregisterWebview(window.webContents, 'window-closed');
      if (this.activeTabId === tab.id) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
    });
    if (show) {
      if (showFocused) window.show();
      else window.showInactive();
      this.contentVisible = true;
    }
    void window.loadURL(options.url).catch((error: unknown) => {
      this.options.log(`[browser] failed to load browser-content url ${options.url}: ${messageOf(error)}`);
    });
    this.options.log(
      `[browser] created ${SURFACE_HOST_DETACHED} content host label=${BROWSER_CONTENT_LABEL} tab=${tabId} url=${options.url} profile=${options.profileDir}`,
    );
    return tab;
  }

  private createHeadlessTab(options: BrowserCreateOptions): TabState {
    const browserSession = this.prepareSession(options.profileDir, 'headless browser-content window');
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        title: options.title,
        useContentSize: true,
        width: options.width,
        height: options.height,
        show: false,
        webPreferences: {
          offscreen: true,
          session: browserSession,
          preload: this.options.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
    } catch (error) {
      throw new Error(`failed to create headless browser-content window: ${messageOf(error)}`);
    }

    const tabId = this.nextTabId();
    const tab: TabState = {
      id: tabId,
      mode: 'headless',
      view: null,
      window,
      webContents: window.webContents,
      cdp: this.createCdpSession(window.webContents),
      url: options.url,
      title: options.title,
    };

    this.options.agentGuard.attachContents(window.webContents);
    this.options.registerWebview(
      window.webContents,
      BROWSER_CONTENT_LABEL,
      this.platformHostMode() === SURFACE_HOST_DETACHED ? BROWSER_CONTENT_LABEL : MAIN_WINDOW_LABEL,
      options.initializationScript,
    );
    window.webContents.on('did-finish-load', () => {
      if (!window.webContents.isDestroyed()) {
        tab.url = window.webContents.getURL() || tab.url;
        tab.title = window.webContents.getTitle() || tab.title;
      }
    });
    window.webContents.once('destroyed', () => {
      tab.cdp.detach();
      this.tabs.delete(tab.id);
      this.options.unregisterWebview(window.webContents, 'window-closed');
      if (this.activeTabId === tab.id) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
    });
    void window.loadURL(options.url).catch((error: unknown) => {
      this.options.log(`[browser] failed to load headless browser-content url ${options.url}: ${messageOf(error)}`);
    });
    this.options.log(
      `[browser] created headless content host label=${BROWSER_CONTENT_LABEL} tab=${tabId} url=${options.url} profile=${options.profileDir}`,
    );
    return tab;
  }

  private disposeFailedEmbeddedView(view: WebContentsView): void {
    if (this.tabs.size === 0) {
      this.cleanupOcclusionHost();
    }
    try {
      this.options.getMainWindow()?.contentView.removeChildView(view);
    } catch (error) {
      this.options.log(`[browser] failed to clean up unacknowledged content host: ${messageOf(error)}`);
    }
    try {
      view.webContents.close();
    } catch (error) {
      this.options.log(`[browser] failed to clean up unacknowledged content host: ${messageOf(error)}`);
    }
  }

  private cleanupOcclusionHost(): void {
    if (this.inputHost !== null) {
      try {
        this.inputHost.remove();
      } catch (error) {
        this.options.log(`[browser] failed to remove native occlusion host: ${messageOf(error)}`);
      }
      this.inputHost = null;
    }
    this.removeResizeListener();
  }

  private removeResizeListener(): void {
    if (this.resizeListener === null) return;
    this.options.getMainWindow()?.off('resize', this.resizeListener);
    this.resizeListener = null;
  }

  private disposeTab(tab: TabState): void {
    tab.cdp.detach();
    this.tabs.delete(tab.id);
    if (this.activeTabId === tab.id) {
      this.activeTabId = null;
    }
    this.options.unregisterWebview(tab.webContents, 'window-closed');
    if (tab.window !== null) {
      try {
        if (!tab.window.isDestroyed()) tab.window.close();
      } catch (error) {
        throw new Error(`failed to close browser-content: ${messageOf(error)}`);
      }
      return;
    }
    if (tab.view !== null) {
      try {
        this.options.getMainWindow()?.contentView.removeChildView(tab.view);
      } catch (error) {
        this.options.log(`[browser] failed to remove browser-content view: ${messageOf(error)}`);
      }
      try {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      } catch (error) {
        throw new Error(`failed to close browser-content: ${messageOf(error)}`);
      }
    }
  }

  async destroyContentWindow(): Promise<boolean> {
    const existing = [...this.tabs.values()];
    this.tabs.clear();
    this.activeTabId = null;
    this.headless = false;
    this.contentVisible = false;
    this.cleanupOcclusionHost();
    this.visualLogical = [];
    this.inputLogical = [];

    for (const tab of existing) {
      this.disposeTab(tab);
    }
    this.options.log(`[browser] destroyed content host ${BROWSER_CONTENT_LABEL}`);
    return true;
  }

  private contents(error = 'browser-content webview not found'): WebContents {
    return this.activeTab(error).webContents;
  }

  async navigate(url: string): Promise<void> {
    const tab = this.activeTab();
    tab.url = url;
    try {
      void tab.webContents.loadURL(url).catch((error: unknown) => {
        this.options.log(`[browser] navigation failed for ${url}: ${messageOf(error)}`);
      });
    } catch (error) {
      throw new Error(`navigate failed: ${messageOf(error)}`);
    }
  }

  async goBack(): Promise<void> {
    const contents = this.contents();
    try {
      contents.navigationHistory.goBack();
    } catch (error) {
      throw new Error(`navigate failed: ${messageOf(error)}`);
    }
  }

  async goForward(): Promise<void> {
    const contents = this.contents();
    try {
      contents.navigationHistory.goForward();
    } catch (error) {
      throw new Error(`navigate failed: ${messageOf(error)}`);
    }
  }

  async reload(): Promise<void> {
    const contents = this.contents();
    try {
      contents.reload();
    } catch (error) {
      throw new Error(`reload failed: ${messageOf(error)}`);
    }
  }

  async focusContentWindow(): Promise<void> {
    const tab = this.activeTab();
    if (tab.mode === 'headless') return;
    if (tab.window !== null) {
      if (tab.window.isDestroyed()) throw new Error('browser-content window not found');
      try {
        tab.window.focus();
      } catch (error) {
        throw new Error(`failed to focus browser-content: ${messageOf(error)}`);
      }
      return;
    }
    try {
      tab.webContents.focus();
    } catch (error) {
      throw new Error(`failed to focus browser-content: ${messageOf(error)}`);
    }
  }

  async releaseContentFocus(): Promise<void> {
    if (this.options.platform !== 'darwin') return;
    const main = this.options.getMainWindow();
    if (main === null) throw new Error(`main React webview ${MAIN_WINDOW_LABEL} not found`);
    try {
      main.webContents.focus();
    } catch (error) {
      throw new Error(`failed to focus main React webview: ${messageOf(error)}`);
    }
  }

  async mainViewportSize(): Promise<{ width: number; height: number }> {
    const main = this.options.getMainWindow();
    if (main === null) throw new Error(`parent window ${MAIN_WINDOW_LABEL} not found`);
    const size = main.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    const scale = windowScale(main);
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  }

  async setContentBounds(bounds: PhysicalRect): Promise<void> {
    this.lastPhysicalBounds = { ...bounds };
    if (this.headless) return;
    if (this.platformHostMode() !== SURFACE_HOST_EMBEDDED) return;
    const tab = this.activeTab('browser-content webview not found');
    if (tab.view === null) throw new Error('browser-content webview not found');
    const main = this.options.getMainWindow();
    if (main === null) throw new Error(`parent window ${MAIN_WINDOW_LABEL} not found`);
    const scale = windowScale(main);
    try {
      tab.view.setBounds(toRoundedLogicalBounds(bounds, scale));
      this.inputHost?.raise();
    } catch (error) {
      throw new Error(`failed to set browser-content bounds: ${messageOf(error)}`);
    }
  }

  async setContentOcclusions(
    occlusions: readonly PhysicalRect[],
    inputOcclusions: readonly PhysicalRect[],
  ): Promise<void> {
    if (this.options.platform !== 'darwin' || this.headless) return;
    const tab = this.activeTab('browser-content webview not found');
    if (tab.view === null) throw new Error('browser-content webview not found');
    if (this.inputHost === null) throw new Error('browser input host was not installed');
    const scale = this.inputHost.scaleFactor();
    this.visualLogical = occlusions.map((rect) => toLogical(rect, scale));
    this.inputLogical = inputOcclusions.map((rect) => toLogical(rect, scale));
    this.inputHost.setInputOcclusions(this.inputLogical);
    try {
      await this.applyVisualOcclusions(tab);
    } catch (error) {
      throw new Error(`failed to set browser-content occlusion mask: ${messageOf(error)}`);
    }
  }

  private async applyVisualOcclusions(tab: TabState): Promise<void> {
    if (tab.view === null) throw new Error('browser-content webview not found');
    const contents = tab.view.webContents;
    const zoom = contents.getZoomFactor() > 0 ? contents.getZoomFactor() : 1;
    const bounds = tab.view.getBounds();
    const rects = this.visualLogical.map((rect) => ({
      x: (rect.x - bounds.x) / zoom,
      y: (rect.y - bounds.y) / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
    }));
    const script = buildOcclusionScript(rects, bounds.width / zoom, bounds.height / zoom);
    const result: unknown = await contents.executeJavaScript(script);
    if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== true) {
      const detail = typeof result === 'object' && result !== null && typeof (result as { error?: unknown }).error === 'string'
        ? (result as { error: string }).error
        : 'unknown occlusion script failure';
      throw new Error(detail);
    }
    tab.view.setBackgroundColor(this.visualLogical.length > 0 ? '#00000000' : '#ffffff');
  }

  async setContentVisibility(visible: boolean, focus: boolean): Promise<void> {
    this.contentVisible = visible;
    if (this.headless) return;
    const tab = this.activeTab('browser-content webview not found');
    if (tab.window !== null) {
      if (tab.window.isDestroyed()) throw new Error('browser-content window not found');
      try {
        if (visible) {
          tab.window.show();
          if (focus) tab.window.focus();
        } else {
          tab.window.hide();
        }
      } catch (error) {
        throw new Error(`failed to ${visible ? 'show' : 'hide'} browser-content: ${messageOf(error)}`);
      }
      return;
    }
    if (tab.view === null) throw new Error('browser-content webview not found');
    try {
      tab.view.setVisible(visible);
      if (visible) {
        this.inputHost?.raise();
        if (focus) tab.view.webContents.focus();
      }
    } catch (error) {
      throw new Error(`failed to ${visible ? 'show' : 'hide'} browser-content: ${messageOf(error)}`);
    }
  }

  async screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const tab = this.activeTab('webview not found: browser-content');
    // Use CDP screenshot when options are specified or headless; fall back cleanly to capturePage() if CDP fails.
    try {
      const cdpShot = await tab.cdp.screenshot(options ?? { quality: 100 });
      if (cdpShot.available) return cdpShot;
    } catch (error) {
      this.options.log(`[browser.cdp] screenshot failed, falling back to capturePage: ${messageOf(error)}`);
    }

    const contents = tab.webContents;
    // `capturePage()` 在页面刚导航完成或合成器负载高时可能短暂返回空图；
    // 重试仍为空才按 PLATFORM_API_UNAVAILABLE 处理，绝不用 DOM 快照冒充。
    for (let attempt = 1; attempt <= SCREENSHOT_ATTEMPTS; attempt += 1) {
      let image: NativeImage;
      try {
        image = await contents.capturePage();
      } catch (error) {
        throw new Error(`failed to capture browser-content screenshot: ${messageOf(error)}`);
      }
      if (!image.isEmpty()) {
        const size = image.getSize();
        return {
          available: true,
          capability: 'browser_visible_webview_screenshot',
          mimeType: 'image/png',
          dataBase64: image.toPNG().toString('base64'),
          width: size.width,
          height: size.height,
        };
      }
      if (attempt < SCREENSHOT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_RETRY_MS));
      }
    }
    return {
      available: false,
      capability: 'browser_visible_webview_screenshot',
      reasonCode: 'PLATFORM_API_UNAVAILABLE',
      reason: 'browser-content surface has no visible pixels',
    };
  }

  async snapshot(options: BrowserSnapshotOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    try {
      return await tab.cdp.snapshot(options);
    } catch (error) {
      if (error instanceof BrowserBridgeError) throw error;
      this.options.log(`[browser.cdp] snapshot failed, falling back to ax-lite bridge: ${messageOf(error)}`);
      return this.callBridge('snapshot', JSON.stringify(options), DEFAULT_SNAPSHOT_TIMEOUT_MS);
    }
  }

  async click(target: string | BrowserClickOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    const normalized: BrowserClickOptions = typeof target === 'string' ? { ref: target } : target;
    if (normalized.ref !== undefined && !tab.cdp.hasRef(normalized.ref) && tab.cdp.getEpoch() === 0) {
      return this.callBridge('click', JSON.stringify(normalized), DEFAULT_ACTION_TIMEOUT_MS);
    }
    try {
      return await tab.cdp.click(normalized);
    } catch (error) {
      if (error instanceof BrowserBridgeError) throw error;
      this.options.log(`[browser.cdp] click failed, falling back to ax-lite bridge: ${messageOf(error)}`);
      return this.callBridge('click', JSON.stringify(normalized), DEFAULT_ACTION_TIMEOUT_MS);
    }
  }

  async typeText(ref: string, text: string, options?: BrowserTypeOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    const clear = options?.clear ?? false;
    const submit = options?.submit ?? false;
    if (!tab.cdp.hasRef(ref) && tab.cdp.getEpoch() === 0) {
      const args = JSON.stringify([ref, text, { clear, ...(submit ? { submit: true } : {}) }]);
      return this.evalScript(buildTypeScript(args), DEFAULT_ACTION_TIMEOUT_MS);
    }
    try {
      return await tab.cdp.typeText({ ref, text, clear, submit });
    } catch (error) {
      if (error instanceof BrowserBridgeError) throw error;
      this.options.log(`[browser.cdp] typeText failed, falling back to ax-lite bridge: ${messageOf(error)}`);
      const args = JSON.stringify([ref, text, { clear, ...(submit ? { submit: true } : {}) }]);
      return this.evalScript(buildTypeScript(args), DEFAULT_ACTION_TIMEOUT_MS);
    }
  }

  async setInputFiles(ref: string, files: unknown): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    if (tab.cdp.hasRef(ref)) {
      const filePaths = extractCanonicalFilePaths(files);
      const base64Files = filePaths === null ? extractBase64FilePayloads(files) : null;
      const cdpFiles = filePaths ?? base64Files;
      if (cdpFiles !== null) {
        try {
          return await tab.cdp.setInputFiles(ref, cdpFiles);
        } catch (error) {
          if (error instanceof BrowserBridgeError) throw error;
          this.options.log(`[browser.cdp] setInputFiles failed, falling back to ax-lite bridge: ${messageOf(error)}`);
        }
      }
    }
    const args = JSON.stringify([ref, files]);
    return this.evalScript(buildSetInputFilesScript(args), DEFAULT_FILE_ACTION_TIMEOUT_MS);
  }

  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    try {
      return await tab.cdp.scroll(options);
    } catch (error) {
      if (error instanceof BrowserBridgeError) throw error;
      this.options.log(`[browser.cdp] scroll failed, falling back to ax-lite bridge: ${messageOf(error)}`);
      return this.callBridge('scroll', JSON.stringify(translateAxLiteScrollOptions(options)), DEFAULT_ACTION_TIMEOUT_MS);
    }
  }

  async hover(options: BrowserHoverOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.hover(options);
  }

  async pressKey(options: BrowserPressKeyOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.pressKey(options);
  }

  async selectOption(options: BrowserSelectOptionOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.selectOption(options);
  }

  async waitFor(options: BrowserWaitOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.waitFor(options);
  }

  async extractContent(options: BrowserExtractOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.extractContent(options);
  }

  async consoleLogs(options: { level?: string; limit?: number }): Promise<BrowserConsoleEntry[]> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.consoleLogs(options);
  }

  async networkLogs(options: { statusMin?: number; limit?: number }): Promise<BrowserNetworkEntry[]> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.networkLogs(options);
  }

  async remoteInput(options: BrowserRemoteInputOptions): Promise<unknown> {
    const tab = this.activeTab('webview not found: browser-content');
    return tab.cdp.remoteInput(options);
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    const list: BrowserTabInfo[] = [];
    for (const tab of this.tabs.values()) {
      if (this.isTabAlive(tab)) list.push(this.tabInfoOf(tab));
    }
    return list;
  }

  async newTab(options: { url?: string; active?: boolean } = {}): Promise<BrowserTabInfo> {
    if (this.lastCreateOptions === null || !this.hasContentWindow()) {
      throw new Error('browser-content webview not found');
    }
    const targetUrl = options.url ?? 'about:blank';
    const activate = options.active !== false;
    const createOpts: BrowserCreateOptions = {
      ...this.lastCreateOptions,
      url: targetUrl,
      focused: activate && this.contentVisible,
    };

    const previous = this.activeTabId !== null ? this.tabs.get(this.activeTabId) ?? null : null;
    const tab = this.headless
      ? this.createHeadlessTab(createOpts)
      : this.platformHostMode() === SURFACE_HOST_DETACHED
        ? this.createDetachedTab(createOpts, activate, activate && this.contentVisible)
        : this.createEmbeddedTab(createOpts, activate && this.contentVisible);

    this.tabs.set(tab.id, tab);
    if (activate) {
      if (previous !== null && previous.id !== tab.id) {
        this.hideTabVisual(previous);
      }
      this.activeTabId = tab.id;
      await this.syncActiveTabPresentation(tab, false);
    }
    return this.tabInfoOf(tab);
  }

  async switchTab(tabId: string): Promise<BrowserTabInfo> {
    const target = this.tabs.get(tabId);
    if (target === undefined || !this.isTabAlive(target)) {
      throw new Error(`browser tab not found: ${tabId}`);
    }
    if (this.activeTabId !== tabId) {
      const previous = this.activeTabId !== null ? this.tabs.get(this.activeTabId) ?? null : null;
      if (previous !== null) this.hideTabVisual(previous);
      this.activeTabId = tabId;
      await this.syncActiveTabPresentation(target, false);
    }
    return this.tabInfoOf(target);
  }

  async closeTab(tabId: string): Promise<BrowserCloseTabResult> {
    const target = this.tabs.get(tabId);
    if (target === undefined) {
      const remaining = await this.listTabs();
      const current = this.activeTabId !== null ? this.tabs.get(this.activeTabId) : undefined;
      const activeTab = current !== undefined && this.isTabAlive(current) ? this.tabInfoOf(current) : null;
      return {
        closed: false,
        activeTabId: activeTab?.tabId ?? null,
        remainingCount: remaining.length,
        activeTab,
      };
    }
    if (this.tabs.size <= 1) {
      await this.destroyContentWindow();
      return {
        closed: true,
        activeTabId: null,
        remainingCount: 0,
        activeTab: null,
      };
    }
    const wasActive = this.activeTabId === tabId;
    this.disposeTab(target);
    if (wasActive) {
      let next: TabState | undefined;
      for (const candidate of this.tabs.values()) {
        if (this.isTabAlive(candidate)) {
          next = candidate;
          break;
        }
      }
      if (next !== undefined) {
        this.activeTabId = next.id;
        await this.syncActiveTabPresentation(next, false);
      }
    }
    const remaining = await this.listTabs();
    const current = this.activeTabId !== null ? this.tabs.get(this.activeTabId) : undefined;
    const activeTab = current !== undefined && this.isTabAlive(current) ? this.tabInfoOf(current) : null;
    return {
      closed: true,
      activeTabId: activeTab?.tabId ?? null,
      remainingCount: remaining.length,
      activeTab,
    };
  }

  async promoteToInteractive(): Promise<{ promoted: boolean; headless: boolean }> {
    if (!this.headless) {
      return { promoted: false, headless: false };
    }
    if (this.lastCreateOptions === null || !this.hasContentWindow()) {
      throw new Error('browser-content webview not found');
    }

    const existingTabs = [...this.tabs.values()];
    const capturedTabs = existingTabs
      .filter((tab) => this.isTabAlive(tab))
      .map((tab) => ({
        url: tab.webContents.getURL() || tab.url,
        title: tab.webContents.getTitle() || tab.title,
        active: tab.id === this.activeTabId,
      }));
    const baseOptions = { ...this.lastCreateOptions, headless: false };
    const targetMode = this.platformHostMode();

    // Create and register new interactive tabs BEFORE disposing old headless tabs so
    // `browserLabelInUse('browser-content')` never drops to null mid-promotion.
    const promotedTabs: TabState[] = [];
    let promotedActive: TabState | null = null;
    try {
      for (const item of capturedTabs) {
        const opts: BrowserCreateOptions = { ...baseOptions, url: item.url, title: item.title, focused: item.active };
        const tab = targetMode === SURFACE_HOST_DETACHED
          ? this.createDetachedTab(opts, item.active, item.active)
          : this.createEmbeddedTab(opts, item.active);
        this.tabs.set(tab.id, tab);
        promotedTabs.push(tab);
        if (item.active || promotedActive === null) {
          promotedActive = tab;
        }
      }
    } catch (error) {
      for (const tab of promotedTabs) {
        this.disposeTab(tab);
      }
      throw error;
    }

    this.headless = false;
    this.lastCreateOptions = baseOptions;
    this.contentVisible = true;
    if (promotedActive !== null) {
      this.activeTabId = promotedActive.id;
    }

    for (const oldTab of existingTabs) {
      this.disposeTab(oldTab);
    }

    if (promotedActive !== null) {
      await this.syncActiveTabPresentation(promotedActive, true);
    }

    this.options.log('[browser] promoted headless browser session to interactive mode');
    return { promoted: true, headless: false };
  }

  /**
   * Controlled `window.open` / `target="_blank"` callback from `web-security.ts`.
   * Opens a managed tab if the source belongs to this surface and passes `agentGuard` precheck.
   */
  handleWindowOpen(source: WebContents, url: string): boolean {
    const owned = [...this.tabs.values()].some((tab) => tab.webContents === source);
    if (!owned) return false;
    const verdict = this.options.agentGuard.precheck(url);
    if ('block' in verdict) {
      this.options.log(`[browser] refused window.open tab for ${url}: ${verdict.block}`);
      const windowLabel = this.platformHostMode() === SURFACE_HOST_DETACHED
        ? BROWSER_CONTENT_LABEL
        : MAIN_WINDOW_LABEL;
      this.options.emitNativeEvent?.(windowLabel, 'dstu-browser://navigation-blocked', {
        url,
        reason: verdict.block,
      });
      return false;
    }
    void this.newTab({ url, active: true }).catch((error: unknown) => {
      this.options.log(`[browser] failed to open managed tab for ${url}: ${messageOf(error)}`);
    });
    return true;
  }

  private hideTabVisual(tab: TabState): void {
    if (tab.mode === 'headless' || !this.isTabAlive(tab)) return;
    if (tab.view !== null) {
      tab.view.setVisible(false);
    } else if (tab.window !== null) {
      tab.window.hide();
    }
  }

  private async syncActiveTabPresentation(tab: TabState, focus: boolean): Promise<void> {
    if (tab.mode === 'headless' || !this.isTabAlive(tab)) return;
    if (tab.view !== null) {
      const main = this.options.getMainWindow();
      if (main !== null && this.lastPhysicalBounds !== null) {
        const scale = windowScale(main);
        tab.view.setBounds(toRoundedLogicalBounds(this.lastPhysicalBounds, scale));
      }
      tab.view.setVisible(this.contentVisible);
      if (this.contentVisible) {
        this.inputHost?.raise();
        if (focus) tab.view.webContents.focus();
        if (this.options.platform === 'darwin' && this.visualLogical.length > 0) {
          void this.applyVisualOcclusions(tab).catch((error: unknown) => {
            this.options.log(`[browser] failed to apply occlusions on tab switch: ${messageOf(error)}`);
          });
        }
      }
      return;
    }
    if (tab.window !== null) {
      if (this.contentVisible) {
        if (focus) {
          tab.window.show();
          tab.window.focus();
        } else {
          tab.window.showInactive();
        }
      } else {
        tab.window.hide();
      }
    }
  }

  setAgentNavigationPolicy(policy: unknown): void {
    this.options.agentGuard.setPolicy(policy);
    this.options.log(`[browser] agent navigation policy ${JSON.stringify(this.options.agentGuard.policy)}`);
  }

  resolveAgentHost(host: string): Promise<AgentHostAnswer> {
    return this.options.agentGuard.resolveHost(host);
  }

  private async callBridge(method: string, argsJson: string, timeoutMs: number): Promise<unknown> {
    const script = buildCallScript(method, argsJson);
    try {
      return await this.evalScript(script, timeoutMs);
    } catch (error) {
      this.options.log(`[browser.bridge] bridge call failed method=${method} error=${messageOf(error)}`);
      throw error;
    }
  }

  private async evalScript(script: string, timeoutMs: number): Promise<unknown> {
    const contents = this.contents('webview not found: browser-content');
    let evaluation: Promise<{ outcome: 'value'; value: unknown } | { outcome: 'error'; error: unknown }>;
    try {
      evaluation = contents.executeJavaScript(script).then(
        (value: unknown) => ({ outcome: 'value' as const, value }),
        (error: unknown) => ({ outcome: 'error' as const, error }),
      );
    } catch (error) {
      throw new Error(`eval failed: ${messageOf(error)}`);
    }

    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`bridge call timed out after ${durationDebug(timeoutMs)}`));
      }, timeoutMs);
    });
    try {
      const settled = await Promise.race([evaluation, timeout]);
      if (settled.outcome === 'error') throw new Error(`eval failed: ${messageOf(settled.error)}`);
      return parseBridgeEnvelope(settled.value);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
