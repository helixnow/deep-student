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
 *
 * 视觉遮挡的 Electron 实现说明：Chromium 合成器直接绘制 `WebContentsViewCocoa`，父视图的
 * CAShapeLayer mask 不影响其像素输出。macOS 下改为在 content 页注入根元素 `clip-path`
 * （even-odd 挖洞）+ 透明画布 + 背景层，主页面即可从洞中透出；输入遮挡由
 * `MacInputOcclusionHost` 负责。Windows/Linux 与 Rust 一样不应用遮挡。
 */
import { mkdirSync } from 'node:fs';
import {
  BrowserWindow,
  screen,
  session as electronSession,
  WebContentsView,
  type NativeImage,
  type Session,
  type WebContents,
} from 'electron';
import type { AgentHostAnswer, AgentNavigationGuard } from './browser-agent-guard.ts';
import { MacInputOcclusionHost } from './browser-occlusion.ts';
import {
  BROWSER_CONTENT_LABEL,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_FILE_ACTION_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  MAIN_WINDOW_LABEL,
  MACOS_DESKTOP_SAFARI_USER_AGENT,
  SURFACE_HOST_DETACHED,
  SURFACE_HOST_EMBEDDED,
  SURFACE_HOST_UNSUPPORTED,
  buildCallScript,
  buildOcclusionScript,
  buildSetInputFilesScript,
  buildTypeScript,
  durationDebug,
  messageOf,
  parseBridgeEnvelope,
  type BrowserCreateOptions,
  type BrowserScreenshotResult,
  type LogicalRect,
  type PhysicalRect,
} from './browser-protocol.ts';
import type { ShellPlatform } from './tauri-config.ts';

/** 截图空图重试：3 次 × 100ms，覆盖导航刚完成/合成器繁忙的短暂空帧。 */
const SCREENSHOT_ATTEMPTS = 3;
const SCREENSHOT_RETRY_MS = 100;

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
  SURFACE_HOST_UNSUPPORTED,
  handleBrowserShellRequest,
} from './browser-protocol.ts';
export type { LogicalRect, PhysicalRect, BrowserCreateOptions } from './browser-protocol.ts';

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
  log(message: string): void;
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

export class BrowserContentSurface {
  private view: WebContentsView | null = null;
  private detached: BrowserWindow | null = null;
  private inputHost: MacInputOcclusionHost | null = null;
  private resizeListener: (() => void) | null = null;
  private visualLogical: LogicalRect[] = [];
  private inputLogical: LogicalRect[] = [];

  private readonly options: BrowserSurfaceOptions;

  constructor(options: BrowserSurfaceOptions) {
    this.options = options;
  }

  hostMode(): string {
    if (this.options.platform === 'darwin' || this.options.platform === 'win32') return SURFACE_HOST_EMBEDDED;
    if (this.options.platform === 'linux') return SURFACE_HOST_DETACHED;
    return SURFACE_HOST_UNSUPPORTED;
  }

  hasContentWindow(): boolean {
    return (this.view !== null && !this.view.webContents.isDestroyed())
      || (this.detached !== null && !this.detached.isDestroyed());
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
      throw new Error(this.hostMode() === SURFACE_HOST_DETACHED
        ? `failed to create detached browser-content window: a window with label \`${BROWSER_CONTENT_LABEL}\` already exists`
        : `failed to create embedded browser-content webview: a webview with label \`${BROWSER_CONTENT_LABEL}\` already exists`);
    }
    if (this.hostMode() === SURFACE_HOST_DETACHED) {
      this.createDetached(options);
      return;
    }
    this.createEmbedded(options);
  }

  private createEmbedded(options: BrowserCreateOptions): void {
    const mainWindow = this.options.getMainWindow();
    if (mainWindow === null) throw new Error(`parent window ${MAIN_WINDOW_LABEL} not found`);
    let browserSession: Session;
    try {
      browserSession = electronSession.fromPath(options.profileDir);
      this.options.agentGuard.installSession(browserSession);
    } catch (error) {
      throw new Error(`failed to create embedded browser-content webview: ${messageOf(error)}`);
    }
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
    this.view = view;
    try {
      view.setBackgroundColor('#ffffff');
      mainWindow.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      view.setVisible(false);
      if (this.options.platform === 'darwin') {
        view.webContents.setUserAgent(MACOS_DESKTOP_SAFARI_USER_AGENT);
      }
    } catch (error) {
      this.disposeFailedEmbedded();
      throw new Error(`failed to initialize embedded browser-content webview visibility: ${messageOf(error)}`);
    }

    if (this.options.platform === 'darwin') {
      try {
        this.inputHost = MacInputOcclusionHost.install(mainWindow);
      } catch (error) {
        this.disposeFailedEmbedded();
        throw new Error(`failed to install browser-content native occlusion host: ${messageOf(error)}`);
      }
      this.resizeListener = () => this.inputHost?.raise();
      mainWindow.on('resize', this.resizeListener);
    }

    this.options.agentGuard.attachContents(view.webContents);
    this.options.registerWebview(
      view.webContents,
      BROWSER_CONTENT_LABEL,
      MAIN_WINDOW_LABEL,
      options.initializationScript,
    );
    view.webContents.on('did-finish-load', () => {
      if (this.visualLogical.length === 0) return;
      void this.applyVisualOcclusions().catch((error: unknown) => {
        this.options.log(`[browser] failed to reapply browser-content occlusions: ${messageOf(error)}`);
      });
    });
    view.webContents.once('destroyed', () => {
      this.inputHost?.remove();
      this.inputHost = null;
      this.removeResizeListener();
      this.options.unregisterWebview(view.webContents, 'window-closed');
      if (this.view === view) this.view = null;
      this.visualLogical = [];
      this.inputLogical = [];
    });
    void view.webContents.loadURL(options.url).catch((error: unknown) => {
      this.options.log(`[browser] failed to load browser-content url ${options.url}: ${messageOf(error)}`);
    });
    this.options.log(
      `[browser] created ${SURFACE_HOST_EMBEDDED} content host label=${BROWSER_CONTENT_LABEL} url=${options.url} profile=${options.profileDir}`,
    );
  }

  private createDetached(options: BrowserCreateOptions): void {
    let browserSession: Session;
    try {
      browserSession = electronSession.fromPath(options.profileDir);
      this.options.agentGuard.installSession(browserSession);
    } catch (error) {
      throw new Error(`failed to create detached browser-content window: ${messageOf(error)}`);
    }
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
    this.detached = window;
    this.options.agentGuard.attachContents(window.webContents);
    this.options.registerWebview(
      window.webContents,
      BROWSER_CONTENT_LABEL,
      BROWSER_CONTENT_LABEL,
      options.initializationScript,
    );
    window.webContents.once('destroyed', () => {
      this.options.unregisterWebview(window.webContents, 'window-closed');
      if (this.detached === window) this.detached = null;
    });
    if (options.focused) window.show();
    else window.showInactive();
    void window.loadURL(options.url).catch((error: unknown) => {
      this.options.log(`[browser] failed to load browser-content url ${options.url}: ${messageOf(error)}`);
    });
    this.options.log(
      `[browser] created ${SURFACE_HOST_DETACHED} content host label=${BROWSER_CONTENT_LABEL} url=${options.url} profile=${options.profileDir}`,
    );
  }

  private disposeFailedEmbedded(): void {
    const view = this.view;
    this.view = null;
    if (this.inputHost !== null) {
      try {
        this.inputHost.remove();
      } catch (error) {
        this.options.log(`[browser] failed to clean up unacknowledged content host: ${messageOf(error)}`);
      }
      this.inputHost = null;
    }
    this.removeResizeListener();
    if (view === null) return;
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

  private removeResizeListener(): void {
    if (this.resizeListener === null) return;
    this.options.getMainWindow()?.off('resize', this.resizeListener);
    this.resizeListener = null;
  }

  async destroyContentWindow(): Promise<boolean> {
    if (this.detached !== null) {
      const window = this.detached;
      this.detached = null;
      this.options.unregisterWebview(window.webContents, 'window-closed');
      try {
        if (!window.isDestroyed()) window.close();
      } catch (error) {
        throw new Error(`failed to close browser-content: ${messageOf(error)}`);
      }
      this.options.log(`[browser] destroyed content host ${BROWSER_CONTENT_LABEL}`);
      return true;
    }

    const view = this.view;
    this.view = null;
    if (this.inputHost !== null) {
      try {
        this.inputHost.remove();
      } catch (error) {
        this.options.log(`[browser] failed to remove native occlusion host: ${messageOf(error)}`);
      }
      this.inputHost = null;
    }
    this.removeResizeListener();
    this.visualLogical = [];
    this.inputLogical = [];
    if (view === null) {
      this.options.log(`[browser] destroyed content host ${BROWSER_CONTENT_LABEL}`);
      return true;
    }
    this.options.unregisterWebview(view.webContents, 'window-closed');
    try {
      this.options.getMainWindow()?.contentView.removeChildView(view);
    } catch (error) {
      this.options.log(`[browser] failed to remove browser-content view: ${messageOf(error)}`);
    }
    try {
      view.webContents.close();
    } catch (error) {
      throw new Error(`failed to close browser-content: ${messageOf(error)}`);
    }
    this.options.log(`[browser] destroyed content host ${BROWSER_CONTENT_LABEL}`);
    return true;
  }

  private contents(error = 'browser-content webview not found'): WebContents {
    if (this.view !== null && !this.view.webContents.isDestroyed()) return this.view.webContents;
    if (this.detached !== null && !this.detached.isDestroyed() && !this.detached.webContents.isDestroyed()) {
      return this.detached.webContents;
    }
    throw new Error(error);
  }

  async navigate(url: string): Promise<void> {
    const contents = this.contents();
    try {
      void contents.loadURL(url).catch((error: unknown) => {
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
    if (this.detached !== null) {
      if (this.detached.isDestroyed()) throw new Error('browser-content window not found');
      try {
        this.detached.focus();
      } catch (error) {
        throw new Error(`failed to focus browser-content: ${messageOf(error)}`);
      }
      return;
    }
    const contents = this.contents();
    try {
      contents.focus();
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
    if (this.hostMode() !== SURFACE_HOST_EMBEDDED) return;
    if (this.view === null) throw new Error('browser-content webview not found');
    const main = this.options.getMainWindow();
    if (main === null) throw new Error(`parent window ${MAIN_WINDOW_LABEL} not found`);
    const scale = windowScale(main);
    try {
      this.view.setBounds({
        x: bounds.x / scale,
        y: bounds.y / scale,
        width: bounds.width / scale,
        height: bounds.height / scale,
      });
      this.inputHost?.raise();
    } catch (error) {
      throw new Error(`failed to set browser-content bounds: ${messageOf(error)}`);
    }
  }

  async setContentOcclusions(
    occlusions: readonly PhysicalRect[],
    inputOcclusions: readonly PhysicalRect[],
  ): Promise<void> {
    if (this.options.platform !== 'darwin') return;
    if (this.view === null) throw new Error('browser-content webview not found');
    if (this.inputHost === null) throw new Error('browser input host was not installed');
    const scale = this.inputHost.scaleFactor();
    this.visualLogical = occlusions.map((rect) => toLogical(rect, scale));
    this.inputLogical = inputOcclusions.map((rect) => toLogical(rect, scale));
    this.inputHost.setInputOcclusions(this.inputLogical);
    try {
      await this.applyVisualOcclusions();
    } catch (error) {
      throw new Error(`failed to set browser-content occlusion mask: ${messageOf(error)}`);
    }
  }

  private async applyVisualOcclusions(): Promise<void> {
    if (this.view === null) throw new Error('browser-content webview not found');
    const contents = this.view.webContents;
    const zoom = contents.getZoomFactor() > 0 ? contents.getZoomFactor() : 1;
    const bounds = this.view.getBounds();
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
    this.view.setBackgroundColor(this.visualLogical.length > 0 ? '#00000000' : '#ffffff');
  }

  async setContentVisibility(visible: boolean, focus: boolean): Promise<void> {
    if (this.detached !== null) {
      if (this.detached.isDestroyed()) throw new Error('browser-content window not found');
      try {
        if (visible) {
          this.detached.show();
          if (focus) this.detached.focus();
        } else {
          this.detached.hide();
        }
      } catch (error) {
        throw new Error(`failed to ${visible ? 'show' : 'hide'} browser-content: ${messageOf(error)}`);
      }
      return;
    }
    if (this.view === null) throw new Error('browser-content webview not found');
    try {
      this.view.setVisible(visible);
      if (visible) {
        this.inputHost?.raise();
        if (focus) this.view.webContents.focus();
      }
    } catch (error) {
      throw new Error(`failed to ${visible ? 'show' : 'hide'} browser-content: ${messageOf(error)}`);
    }
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    const contents = this.contents('webview not found: browser-content');
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

  async snapshot(options: { interactiveOnly: boolean; maxChars?: number }): Promise<unknown> {
    return this.callBridge('snapshot', JSON.stringify(options), DEFAULT_SNAPSHOT_TIMEOUT_MS);
  }

  async click(ref: string): Promise<unknown> {
    return this.callBridge('click', JSON.stringify({ ref }), DEFAULT_ACTION_TIMEOUT_MS);
  }

  async typeText(ref: string, text: string): Promise<unknown> {
    const args = JSON.stringify([ref, text, { clear: true }]);
    return this.evalScript(buildTypeScript(args), DEFAULT_ACTION_TIMEOUT_MS);
  }

  async setInputFiles(ref: string, files: unknown): Promise<unknown> {
    const args = JSON.stringify([ref, files]);
    return this.evalScript(buildSetInputFilesScript(args), DEFAULT_FILE_ACTION_TIMEOUT_MS);
  }

  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<unknown> {
    return this.callBridge('scroll', JSON.stringify(options), DEFAULT_ACTION_TIMEOUT_MS);
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
