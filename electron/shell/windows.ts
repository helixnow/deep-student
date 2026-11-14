/**
 * 窗口管理：Tauri window/webview label ↔ Electron BrowserWindow（每个窗口一个 webview，label 相同）。
 * 窗口事件按 tauri-2.11.5 `src/manager/window.rs` `on_window_event` 发射：
 * `tauri://resize`（PhysicalSize）、`tauri://move`（PhysicalPosition）、`tauri://close-requested`、
 * `tauri://destroyed`、`tauri://focus`/`tauri://blur`、`tauri://theme-changed`，目标过滤为
 * `Window{label}` / `WebviewWindow{label}`；创建后全局发射 `tauri://window-created` 与 `tauri://webview-created`。
 */
import { BrowserWindow, nativeTheme, screen, type WebContents } from 'electron';
import type { WindowLifecycle, WindowRef } from '../../host/kernel/protocol.ts';
import { ShellCommandError } from './errors.ts';
import { windowEventFilter, type TargetFilter } from './events.ts';
import type { ShellPlatform, TauriWindowConfig } from './tauri-config.ts';
import type { ShellWindowSnapshot } from '../api.ts';
import { INVALID_LABEL_MESSAGE, isLabelValid, mapWindowConfig } from './window-options.ts';

export interface WindowHooks {
  platform: ShellPlatform;
  debug: boolean;
  preloadPath: string;
  /** 把 Tauri `WebviewUrl`（相对路径 = 应用内页面，绝对 URL = 外部）解析成可加载的 URL。 */
  resolveUrl(url: string | undefined): string;
  /** 发射事件给 JS 监听者。payload 为已序列化的 JSON。 */
  emit(event: string, payloadJson: string, filter: TargetFilter | null): void;
  hasJsListener(event: string, filter: TargetFilter): boolean;
  lifecycle(ref: WindowRef, state: WindowLifecycle['state']): void;
  /** webview 的页面被销毁或重新加载（放弃该 webview 尚未返回的 invoke）。 */
  webviewGone(label: string, reason: 'window-closed' | 'reloaded'): void;
  /** 窗口创建后的平台特定处理（如 macOS 主窗口 vibrancy）。 */
  afterCreate?(window: ShellWindow): void;
  log(message: string): void;
}

export interface ShellWindow {
  readonly label: string;
  readonly browserWindow: BrowserWindow;
  readonly webContents: WebContents;
  readonly dragDropEnabled: boolean;
  /** Tauri `decorations` 配置（`is_decorated` 的返回值；`set_decorations` 会更新）。 */
  decorated: boolean;
  /** 由 `destroy` 或已放行的关闭触发，跳过 close-requested 拦截。 */
  destroying: boolean;
}

function physicalSize(win: BrowserWindow, size: [number, number]): { width: number; height: number } {
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  return { width: Math.round(size[0] * scale), height: Math.round(size[1] * scale) };
}

function physicalPosition(win: BrowserWindow, pos: [number, number]): { x: number; y: number } {
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  return { x: Math.round(pos[0] * scale), y: Math.round(pos[1] * scale) };
}

export class WindowManager {
  private readonly windows = new Map<string, ShellWindow>();
  private readonly byContentsId = new Map<number, ShellWindow>();
  private readonly hooks: WindowHooks;

  constructor(hooks: WindowHooks) {
    this.hooks = hooks;
    nativeTheme.on('updated', () => {
      const theme = JSON.stringify(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
      for (const label of this.windows.keys()) this.hooks.emit('tauri://theme-changed', theme, windowEventFilter(label));
    });
  }

  get(label: string): ShellWindow | undefined {
    return this.windows.get(label);
  }

  labels(): string[] {
    return [...this.windows.keys()];
  }

  all(): ShellWindow[] {
    return [...this.windows.values()];
  }

  /** Manager::webview_windows(): live application windows, not BrowserViews or a Host event cache. */
  listWindows(): ShellWindowSnapshot[] {
    return this.all().filter((win) => !win.browserWindow.isDestroyed() && !win.webContents.isDestroyed()).map((win) => ({
      label: win.label,
      isMain: win.label === 'main',
      focused: win.browserWindow.isFocused(),
    }));
  }

  getMainWindow(): ShellWindowSnapshot | null {
    return this.listWindows().find((win) => win.isMain) ?? null;
  }

  byWebContents(contents: WebContents): ShellWindow | undefined {
    return this.byContentsId.get(contents.id);
  }

  require(label: string): ShellWindow {
    const win = this.windows.get(label);
    if (!win) throw new ShellCommandError('window not found');
    return win;
  }

  create(config: TauriWindowConfig & { label: string }): ShellWindow {
    const label = config.label;
    if (!isLabelValid(label)) throw new ShellCommandError(INVALID_LABEL_MESSAGE);
    if (this.windows.has(label)) throw new ShellCommandError(`a window with label \`${label}\` already exists`);
    const mapped = mapWindowConfig(config, this.hooks.platform, this.hooks.debug);
    const parent = config.parent !== undefined ? this.windows.get(config.parent)?.browserWindow : undefined;
    const browserWindow = new BrowserWindow({
      // Tauri 的 width/height 与 min/max 都是客户区尺寸（tauri-runtime-wry-2.11.4 lib.rs:932、957-972）。
      useContentSize: true,
      width: mapped.width,
      height: mapped.height,
      ...(mapped.x !== undefined && mapped.y !== undefined ? { x: mapped.x, y: mapped.y } : {}),
      center: mapped.center,
      ...(mapped.minWidth !== undefined ? { minWidth: mapped.minWidth } : {}),
      ...(mapped.minHeight !== undefined ? { minHeight: mapped.minHeight } : {}),
      ...(mapped.maxWidth !== undefined ? { maxWidth: mapped.maxWidth } : {}),
      ...(mapped.maxHeight !== undefined ? { maxHeight: mapped.maxHeight } : {}),
      resizable: mapped.resizable,
      maximizable: mapped.maximizable,
      minimizable: mapped.minimizable,
      closable: mapped.closable,
      title: mapped.title,
      fullscreen: mapped.fullscreen,
      focusable: mapped.focusable,
      show: false,
      frame: mapped.frame,
      transparent: mapped.transparent,
      alwaysOnTop: mapped.alwaysOnTop,
      skipTaskbar: mapped.skipTaskbar,
      hasShadow: mapped.hasShadow,
      ...(mapped.titleBarStyle !== undefined ? { titleBarStyle: mapped.titleBarStyle } : {}),
      ...(mapped.trafficLightPosition !== undefined ? { trafficLightPosition: mapped.trafficLightPosition } : {}),
      ...(mapped.backgroundColor !== undefined ? { backgroundColor: mapped.backgroundColor } : {}),
      ...(mapped.acceptFirstMouse !== undefined ? { acceptFirstMouse: mapped.acceptFirstMouse } : {}),
      ...(mapped.tabbingIdentifier !== undefined ? { tabbingIdentifier: mapped.tabbingIdentifier } : {}),
      ...(parent !== undefined ? { parent } : {}),
      webPreferences: {
        preload: this.hooks.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: mapped.devtools,
      },
    });
    const shellWindow: ShellWindow = {
      label,
      browserWindow,
      webContents: browserWindow.webContents,
      dragDropEnabled: mapped.dragDropEnabled,
      decorated: config.decorations ?? true,
      destroying: false,
    };
    this.windows.set(label, shellWindow);
    this.byContentsId.set(browserWindow.webContents.id, shellWindow);
    if (mapped.contentProtected) browserWindow.setContentProtection(true);
    this.wire(shellWindow);
    this.hooks.afterCreate?.(shellWindow);

    if (mapped.show) {
      if (mapped.maximized) browserWindow.maximize();
      if (mapped.focus) browserWindow.show();
      else browserWindow.showInactive();
    } else if (mapped.maximized) {
      browserWindow.maximize();
      browserWindow.hide();
    }
    const url = this.hooks.resolveUrl(config.url);
    // 加载失败（开发服务器未启动、页面被导航拦截等）时窗口照常存在，与 Tauri 一样由页面自身呈现错误。
    void browserWindow.loadURL(url).catch((error: unknown) => {
      this.hooks.log(`[window ${label}] failed to load ${url}: ${error instanceof Error ? error.message : String(error)}`);
    });

    const ref: WindowRef = { window: label, webview: label };
    this.hooks.lifecycle(ref, 'created');
    this.hooks.emit('tauri://window-created', JSON.stringify({ label }), null);
    this.hooks.emit('tauri://webview-created', JSON.stringify({ label }), null);
    return shellWindow;
  }

  private wire(shellWindow: ShellWindow): void {
    const { label, browserWindow: win } = shellWindow;
    const contentsId = win.webContents.id;
    const filter = windowEventFilter(label);
    const ref: WindowRef = { window: label, webview: label };
    const emit = (event: string, payload: unknown) => this.hooks.emit(event, JSON.stringify(payload ?? null), filter);

    win.on('focus', () => {
      emit('tauri://focus', null);
      this.hooks.lifecycle(ref, 'focused');
    });
    win.on('blur', () => {
      emit('tauri://blur', null);
      this.hooks.lifecycle(ref, 'blurred');
    });
    win.on('resize', () => emit('tauri://resize', physicalSize(win, win.getContentSize() as [number, number])));
    win.on('move', () => emit('tauri://move', physicalPosition(win, win.getPosition() as [number, number])));
    win.on('close', (event) => {
      if (shellWindow.destroying) return;
      // Rust：有 JS 监听 close-requested 时阻止关闭，由前端决定是否 destroy。
      const intercepted = this.hooks.hasJsListener('tauri://close-requested', filter);
      if (intercepted) event.preventDefault();
      emit('tauri://close-requested', null);
      this.hooks.lifecycle(ref, 'close-requested');
      if (!intercepted) shellWindow.destroying = true;
    });
    win.on('closed', () => {
      this.windows.delete(label);
      this.byContentsId.delete(contentsId);
      this.hooks.webviewGone(label, 'window-closed');
      emit('tauri://destroyed', null);
      this.hooks.lifecycle(ref, 'destroyed');
    });
    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.hooks.webviewGone(label, 'reloaded');
    });
    // PageLoadEvent::Started 在 wry 中是主框架新文档提交（WebKitGTK Committed / WKWebView didCommit /
    // WebView2 ContentLoading）；Electron 的 did-navigate 同样只在主框架跨文档提交时触发，不含 hash/pushState、子 frame、204/下载。
    win.webContents.on('did-navigate', () => this.hooks.lifecycle(ref, 'page-load-started'));
  }

  /** 强制销毁（`destroy` 命令；不触发 close-requested）。 */
  destroy(label: string): void {
    const win = this.require(label);
    win.destroying = true;
    win.browserWindow.destroy();
  }
}
