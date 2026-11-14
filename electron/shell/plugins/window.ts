/**
 * `plugin:window|*`（tauri-2.11.5 `src/window/plugin.rs`）与 `plugin:webview|*`（`src/webview/plugin.rs`）。
 * 窗口由 label 定位：`label` 缺省或为空时为调用方窗口，找不到时报 `window not found` / `webview not found`。
 * 尺寸与位置的返回值为物理像素（`PhysicalSize<u32>` / `PhysicalPosition<i32>`）。
 */
import { app, nativeTheme, screen, type BrowserWindow, type Display } from 'electron';
import { optString, raw, reqBool, reqNumber, reqObject, type InvokeInput } from '../args.ts';
import { invalidArgs, missingKey, ShellCommandError } from '../errors.ts';
import type { TauriWindowConfig } from '../tauri-config.ts';
import { decodeWindowConfig } from '../window-config.ts';
import type { BuiltinCommand, BuiltinPlugin, CommandContext } from '../runtime.ts';
import { unsupported } from '../runtime.ts';
import type { ShellWindow } from '../windows.ts';
import { resolveImage } from '../images.ts';
import {
  setAlwaysOnBottom,
  setApplicationTheme,
  setDecorations,
  setTitleBarStyle,
  setWindowEffects,
  type NativeTitleBarStyle,
  type WindowEffectsConfig,
} from '../native-window.ts';

function target(input: InvokeInput, ctx: CommandContext, notFound = 'window not found'): ShellWindow {
  const label = optString(input, 'label');
  const resolved = label === null || label === '' ? ctx.windowLabel : label;
  const win = ctx.runtime.windows.get(resolved);
  if (!win) throw new ShellCommandError(notFound);
  return win;
}

function scaleOf(win: BrowserWindow): number {
  return screen.getDisplayMatching(win.getBounds()).scaleFactor;
}

function monitor(display: Display): unknown {
  const s = display.scaleFactor;
  return {
    name: display.label === '' ? null : display.label,
    size: { width: Math.round(display.bounds.width * s), height: Math.round(display.bounds.height * s) },
    position: { x: Math.round(display.bounds.x * s), y: Math.round(display.bounds.y * s) },
    workArea: {
      position: { x: Math.round(display.workArea.x * s), y: Math.round(display.workArea.y * s) },
      size: { width: Math.round(display.workArea.width * s), height: Math.round(display.workArea.height * s) },
    },
    scaleFactor: s,
  };
}

/** `Size` / `Position` 的 IPC 形状：`{ Logical: {...} }` 或 `{ Physical: {...} }`，返回逻辑像素。 */
function logicalSize(input: InvokeInput, value: unknown, win: BrowserWindow): { width: number; height: number } {
  if (value !== null && typeof value === 'object') {
    const v = value as { Logical?: { width: number; height: number }; Physical?: { width: number; height: number } };
    if (v.Logical) return { width: v.Logical.width, height: v.Logical.height };
    if (v.Physical) {
      const s = scaleOf(win);
      return { width: v.Physical.width / s, height: v.Physical.height / s };
    }
  }
  throw invalidArgs(input.command, 'value', 'unknown variant, expected `Physical` or `Logical`');
}

function logicalPosition(input: InvokeInput, value: unknown, win: BrowserWindow): { x: number; y: number } {
  if (value !== null && typeof value === 'object') {
    const v = value as { Logical?: { x: number; y: number }; Physical?: { x: number; y: number } };
    if (v.Logical) return { x: v.Logical.x, y: v.Logical.y };
    if (v.Physical) {
      const s = scaleOf(win);
      return { x: v.Physical.x / s, y: v.Physical.y / s };
    }
  }
  throw invalidArgs(input.command, 'value', 'unknown variant, expected `Physical` or `Logical`');
}

function value(input: InvokeInput): unknown {
  const v = raw(input, 'value');
  if (v === undefined) throw missingKey(input.command, 'value');
  return v;
}

function getter(fn: (w: BrowserWindow, sw: ShellWindow) => unknown): BuiltinCommand {
  return (input, ctx) => {
    const sw = target(input, ctx);
    return fn(sw.browserWindow, sw);
  };
}

function setter(fn: (w: BrowserWindow, input: InvokeInput, sw: ShellWindow, ctx: CommandContext) => void): BuiltinCommand {
  return (input, ctx) => {
    const sw = target(input, ctx);
    fn(sw.browserWindow, input, sw, ctx);
    return null;
  };
}

/** Tauri `start_dragging` 的等价：main 以光标位移移动窗口，直到页面松开鼠标（preload 回报）。 */
const activeDrags = new Map<string, { timer: NodeJS.Timeout; win: BrowserWindow; onBlur: () => void }>();

export function stopWindowDrag(label: string): void {
  const drag = activeDrags.get(label);
  if (!drag) return;
  clearInterval(drag.timer);
  activeDrags.delete(label);
  if (!drag.win.isDestroyed()) drag.win.removeListener('blur', drag.onBlur);
}

function startDragging(sw: ShellWindow, ctx: CommandContext): void {
  stopWindowDrag(sw.label);
  const win = sw.browserWindow;
  if (win.isMaximized() || win.isFullScreen()) return;
  const origin = screen.getCursorScreenPoint();
  const [startX, startY] = win.getPosition() as [number, number];
  ctx.runtime.sendToWebview(sw.label, { type: 'window-drag-start' });
  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      stopWindowDrag(sw.label);
      return;
    }
    const p = screen.getCursorScreenPoint();
    win.setPosition(Math.round(startX + p.x - origin.x), Math.round(startY + p.y - origin.y));
  }, 8);
  const onBlur = () => stopWindowDrag(sw.label);
  activeDrags.set(sw.label, { timer, win, onBlur });
  win.once('blur', onBlur);
}

function toggleMaximize(w: BrowserWindow): void {
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
}

/** Tauri `WindowMessage::SetDecorations` 在 fullscreen 时延迟到退出全屏后应用（tao window.rs:1356-1359）。 */
const pendingDecorations = new WeakMap<BrowserWindow, boolean>();

function applyDecorations(w: BrowserWindow, decorations: boolean): void {
  setDecorations(w, decorations, w.isResizable());
}

/** `TitleBarStyle` 的 serde 实现：大小写不敏感，未知值按 Visible。 */
function titleBarStyle(input: InvokeInput, value: unknown): NativeTitleBarStyle {
  if (typeof value !== 'string') throw invalidArgs(input.command, 'value', 'invalid type, expected a string');
  const normalized = value.toLowerCase();
  return normalized === 'transparent' ? 'Transparent' : normalized === 'overlay' ? 'Overlay' : 'Visible';
}

/** `Theme` 的 serde 实现：`dark`（大小写不敏感）→ Dark，其余字符串 → Light。 */
function themeValue(input: InvokeInput, value: unknown): 'dark' | 'light' | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalidArgs(input.command, 'value', 'invalid type, expected a string');
  return value.toLowerCase() === 'dark' ? 'dark' : 'light';
}

/** `create` / `create_webview_window` 的 `options: WindowConfig`。 */
function windowConfig(input: InvokeInput): TauriWindowConfig & { label: string } {
  const options = reqObject(input, 'options');
  if (typeof options.label !== 'string') throw invalidArgs(input.command, 'options', 'missing field `label`');
  try {
    return decodeWindowConfig(options) as TauriWindowConfig & { label: string };
  } catch (error) {
    throw invalidArgs(input.command, 'options', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 页面发起的建窗。正式版的 Tauri 不带 `devtools` 特性，webview 的检查器只在 debug 构建里编译
 * （tauri-runtime-wry 2.11.4 `lib.rs:5209-5212`），页面给的 `devtools` 在打包版里不起作用。
 * label 与在用的 browser-content 重名时按 Tauri 的 `WindowLabelAlreadyExists` / `WebviewLabelAlreadyExists` 报错。
 */
function createFromPage(input: InvokeInput, ctx: CommandContext): null {
  const config = windowConfig(input);
  const taken = ctx.runtime.browserLabelInUse(config.label);
  if (taken !== null) throw new ShellCommandError(`a ${taken} with label \`${config.label}\` already exists`);
  if (!ctx.runtime.debug) config.devtools = false;
  ctx.runtime.windows.create(config);
  return null;
}

export function windowPlugin(): BuiltinPlugin {
  const no = (command: string, reason: string) => unsupported('window', command, reason);
  return {
    get_all_windows: (_input, ctx) => ctx.runtime.windows.labels(),
    create: createFromPage,
    scale_factor: getter((w) => scaleOf(w)),
    inner_position: getter((w) => {
      const b = w.getContentBounds();
      const s = scaleOf(w);
      return { x: Math.round(b.x * s), y: Math.round(b.y * s) };
    }),
    outer_position: getter((w) => {
      const b = w.getBounds();
      const s = scaleOf(w);
      return { x: Math.round(b.x * s), y: Math.round(b.y * s) };
    }),
    inner_size: getter((w) => {
      const b = w.getContentBounds();
      const s = scaleOf(w);
      return { width: Math.round(b.width * s), height: Math.round(b.height * s) };
    }),
    outer_size: getter((w) => {
      const b = w.getBounds();
      const s = scaleOf(w);
      return { width: Math.round(b.width * s), height: Math.round(b.height * s) };
    }),
    is_fullscreen: getter((w) => w.isFullScreen() || w.isSimpleFullScreen()),
    is_minimized: getter((w) => w.isMinimized()),
    is_maximized: getter((w) => w.isMaximized()),
    is_focused: getter((w) => w.isFocused()),
    is_decorated: getter((_w, sw) => sw.decorated),
    is_resizable: getter((w) => w.isResizable()),
    is_maximizable: getter((w) => w.isMaximizable()),
    is_minimizable: getter((w) => w.isMinimizable()),
    is_closable: getter((w) => w.isClosable()),
    is_visible: getter((w) => w.isVisible()),
    is_enabled: getter((w) => w.isEnabled()),
    is_always_on_top: getter((w) => w.isAlwaysOnTop()),
    title: getter((w) => w.getTitle()),
    theme: getter(() => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')),
    current_monitor: getter((w) => monitor(screen.getDisplayMatching(w.getBounds()))),
    primary_monitor: getter(() => monitor(screen.getPrimaryDisplay())),
    available_monitors: getter(() => screen.getAllDisplays().map(monitor)),
    monitor_from_point: (input, ctx) => {
      target(input, ctx);
      const x = reqNumber(input, 'x');
      const y = reqNumber(input, 'y');
      const display = screen.getAllDisplays().find((d) => {
        const s = d.scaleFactor;
        const b = d.bounds;
        return x >= b.x * s && x < (b.x + b.width) * s && y >= b.y * s && y < (b.y + b.height) * s;
      });
      return display ? monitor(display) : null;
    },
    cursor_position: getter((w) => {
      const p = screen.getCursorScreenPoint();
      const s = scaleOf(w);
      return { x: p.x * s, y: p.y * s };
    }),
    center: setter((w) => w.center()),
    request_user_attention: setter((w, input) => {
      const v = raw(input, 'value');
      if (v === null || v === undefined) w.flashFrame(false);
      else w.flashFrame(true);
    }),
    set_resizable: setter((w, input) => w.setResizable(reqBool(input, 'value'))),
    set_maximizable: setter((w, input) => w.setMaximizable(reqBool(input, 'value'))),
    set_minimizable: setter((w, input) => w.setMinimizable(reqBool(input, 'value'))),
    set_closable: setter((w, input) => w.setClosable(reqBool(input, 'value'))),
    set_title: setter((w, input) => {
      const v = value(input);
      if (typeof v !== 'string') throw invalidArgs(input.command, 'value', 'invalid type, expected a string');
      w.setTitle(v);
    }),
    maximize: setter((w) => w.maximize()),
    unmaximize: setter((w) => w.unmaximize()),
    toggle_maximize: setter((w) => toggleMaximize(w)),
    internal_toggle_maximize: setter((w) => {
      if (w.isResizable() && w.isMaximizable()) toggleMaximize(w);
    }),
    minimize: setter((w) => w.minimize()),
    unminimize: setter((w) => w.restore()),
    show: setter((w) => w.show()),
    hide: setter((w) => w.hide()),
    close: setter((w) => w.close()),
    destroy: (input, ctx) => {
      const sw = target(input, ctx);
      ctx.runtime.windows.destroy(sw.label);
      return null;
    },
    set_shadow: setter((w, input) => w.setHasShadow(reqBool(input, 'value'))),
    set_always_on_top: setter((w, input) => w.setAlwaysOnTop(reqBool(input, 'value'))),
    set_content_protected: setter((w, input) => w.setContentProtection(reqBool(input, 'value'))),
    set_size: setter((w, input) => {
      const s = logicalSize(input, value(input), w);
      w.setContentSize(Math.round(s.width), Math.round(s.height));
    }),
    set_min_size: setter((w, input) => {
      const v = raw(input, 'value');
      if (v === null || v === undefined) w.setMinimumSize(0, 0);
      else {
        const s = logicalSize(input, v, w);
        w.setMinimumSize(Math.round(s.width), Math.round(s.height));
      }
    }),
    set_max_size: setter((w, input) => {
      const v = raw(input, 'value');
      if (v === null || v === undefined) w.setMaximumSize(0, 0);
      else {
        const s = logicalSize(input, v, w);
        w.setMaximumSize(Math.round(s.width), Math.round(s.height));
      }
    }),
    set_size_constraints: setter((w, input) => {
      const v = value(input) as Record<string, unknown> | null;
      const dim = (key: string): number => {
        const d = v?.[key];
        if (d === null || d === undefined) return 0;
        const px = d as { Logical?: number; Physical?: number };
        if (typeof px.Logical === 'number') return Math.round(px.Logical);
        if (typeof px.Physical === 'number') return Math.round(px.Physical / scaleOf(w));
        return 0;
      };
      w.setMinimumSize(dim('minWidth'), dim('minHeight'));
      w.setMaximumSize(dim('maxWidth'), dim('maxHeight'));
    }),
    set_position: setter((w, input) => {
      const p = logicalPosition(input, value(input), w);
      w.setPosition(Math.round(p.x), Math.round(p.y));
    }),
    set_fullscreen: setter((w, input) => w.setFullScreen(reqBool(input, 'value'))),
    set_simple_fullscreen: setter((w, input, _sw, ctx) => {
      const v = reqBool(input, 'value');
      if (ctx.runtime.platform === 'darwin') w.setSimpleFullScreen(v);
      else w.setFullScreen(v);
    }),
    set_focus: setter((w) => {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }),
    set_focusable: setter((w, input) => w.setFocusable(reqBool(input, 'value'))),
    set_skip_taskbar: setter((w, input) => w.setSkipTaskbar(reqBool(input, 'value'))),
    set_ignore_cursor_events: setter((w, input) => w.setIgnoreMouseEvents(reqBool(input, 'value'))),
    set_enabled: setter((w, input) => w.setEnabled(reqBool(input, 'value'))),
    set_visible_on_all_workspaces: setter((w, input) => w.setVisibleOnAllWorkspaces(reqBool(input, 'value'))),
    set_progress_bar: setter((w, input) => {
      const v = (value(input) ?? {}) as { status?: string; progress?: number };
      const mode = v.status === 'paused' ? 'paused' : v.status === 'error' ? 'error' : v.status === 'indeterminate' ? 'indeterminate' : 'normal';
      if (v.status === 'none') w.setProgressBar(-1);
      else w.setProgressBar(v.status === 'indeterminate' ? 2 : (v.progress ?? 0) / 100, { mode });
    }),
    set_badge_count: setter((_w, input) => {
      const v = raw(input, 'value');
      app.setBadgeCount(typeof v === 'number' ? v : 0);
    }),
    set_badge_label: setter((_w, input) => {
      const v = raw(input, 'value');
      if (process.platform !== 'darwin' || !app.dock) throw new ShellCommandError('[electron-shell] window.set_badge_label is macOS only');
      app.dock.setBadge(typeof v === 'string' ? v : '');
    }),
    set_background_color: (input, ctx) => {
      const v = raw(input, 'color') ?? raw(input, 'value');
      const sw = target(input, ctx);
      if (Array.isArray(v)) {
        const [r = 0, g = 0, b = 0, a = 255] = v as number[];
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        sw.browserWindow.setBackgroundColor(`#${hex(a)}${hex(r)}${hex(g)}${hex(b)}`);
      } else if (typeof v === 'string') {
        sw.browserWindow.setBackgroundColor(v);
      }
      return null;
    },
    start_dragging: (input, ctx) => {
      startDragging(target(input, ctx), ctx);
      return null;
    },
    set_decorations: (input, ctx) => {
      const sw = target(input, ctx);
      const value = reqBool(input, 'value');
      if (value === sw.decorated) return null;
      sw.decorated = value;
      if (ctx.runtime.platform !== 'darwin') {
        throw new ShellCommandError('[electron-shell] window.set_decorations is not supported: Electron cannot toggle the native frame on this platform');
      }
      if (sw.browserWindow.isFullScreen()) {
        pendingDecorations.set(sw.browserWindow, value);
        sw.browserWindow.once('leave-full-screen', () => {
          const pending = pendingDecorations.get(sw.browserWindow);
          pendingDecorations.delete(sw.browserWindow);
          if (pending !== undefined && !sw.browserWindow.isDestroyed()) applyDecorations(sw.browserWindow, pending);
        });
      } else {
        pendingDecorations.delete(sw.browserWindow);
        applyDecorations(sw.browserWindow, value);
      }
      return null;
    },
    set_always_on_bottom: (input, ctx) => {
      const sw = target(input, ctx);
      const value = reqBool(input, 'value');
      if (ctx.runtime.platform !== 'darwin') {
        throw new ShellCommandError('[electron-shell] window.set_always_on_bottom is not supported: Electron has no always-on-bottom window level on this platform');
      }
      setAlwaysOnBottom(sw.browserWindow, value);
      return null;
    },
    set_cursor_grab: no('set_cursor_grab', 'Electron has no cursor grab API'),
    set_cursor_visible: no('set_cursor_visible', 'Electron has no cursor visibility API'),
    set_cursor_icon: no('set_cursor_icon', 'Electron has no window-level cursor icon API'),
    set_cursor_position: no('set_cursor_position', 'Electron has no cursor warp API'),
    // tao macOS `drag_resize_window` 直接返回 `ExternalError::NotSupported`（window.rs:963-965）。
    start_resize_dragging: () => {
      throw new ShellCommandError('the requested operation is not supported by Tao');
    },
    set_overlay_icon: setter((w, input, _sw, ctx) => {
      const icon = raw(input, 'icon');
      const description = optString(input, 'description') ?? '';
      w.setOverlayIcon(icon == null ? null : resolveImage(icon, ctx).native(), description);
    }),
    set_icon: setter((w, input, _sw, ctx) => w.setIcon(resolveImage(raw(input, 'value'), ctx).native())),
    set_title_bar_style: (input, ctx) => {
      const sw = target(input, ctx);
      const style = titleBarStyle(input, raw(input, 'value'));
      if (ctx.runtime.platform === 'darwin') setTitleBarStyle(sw.browserWindow, style);
      return null;
    },
    set_theme: (input, ctx) => {
      const theme = themeValue(input, raw(input, 'value'));
      if (ctx.runtime.platform === 'darwin') setApplicationTheme(theme);
      else nativeTheme.themeSource = theme ?? 'system';
      return null;
    },
    set_effects: (input, ctx) => {
      const value = raw(input, 'value');
      if (value === null || value === undefined) {
        if (ctx.runtime.platform === 'darwin') setWindowEffects(target(input, ctx).browserWindow, null);
        return null;
      }
      if (ctx.runtime.platform !== 'darwin') {
        throw new ShellCommandError('[electron-shell] window.set_effects is not supported: Electron has no equivalent for this effect on this platform');
      }
      if (typeof value !== 'object' || Array.isArray(value)) throw invalidArgs(input.command, 'value', 'invalid type, expected struct WindowEffectsConfig');
      const config = value as WindowEffectsConfig;
      if (!Array.isArray(config.effects)) throw invalidArgs(input.command, 'value', 'missing field `effects`');
      setWindowEffects(target(input, ctx).browserWindow, config);
      return null;
    },
  };
}

export function webviewPlugin(): BuiltinPlugin {
  const no = (command: string, reason: string) => unsupported('webview', command, reason);
  const wv = (input: InvokeInput, ctx: CommandContext) => target(input, ctx, 'webview not found');
  return {
    create_webview_window: createFromPage,
    get_all_webviews: (_input, ctx) => ctx.runtime.windows.labels().map((label) => ({ windowLabel: label, label })),
    webview_close: (input, ctx) => {
      wv(input, ctx).browserWindow.close();
      return null;
    },
    webview_show: (input, ctx) => {
      wv(input, ctx).browserWindow.show();
      return null;
    },
    webview_hide: (input, ctx) => {
      wv(input, ctx).browserWindow.hide();
      return null;
    },
    set_webview_focus: (input, ctx) => {
      wv(input, ctx).webContents.focus();
      return null;
    },
    set_webview_zoom: (input, ctx) => {
      wv(input, ctx).webContents.setZoomFactor(reqNumber(input, 'value'));
      return null;
    },
    webview_position: (input, ctx) => {
      wv(input, ctx);
      return { x: 0, y: 0 };
    },
    webview_size: (input, ctx) => {
      const w = wv(input, ctx).browserWindow;
      const b = w.getContentBounds();
      const s = scaleOf(w);
      return { width: Math.round(b.width * s), height: Math.round(b.height * s) };
    },
    print: (input, ctx) => {
      wv(input, ctx).webContents.print();
      return null;
    },
    internal_toggle_devtools: (input, ctx) => {
      // 正式版 Tauri 不注册这条命令（tauri-2.11.5 `webview/plugin.rs`：`cfg(any(debug_assertions, feature = "devtools"))`）。
      if (!ctx.runtime.debug) throw new ShellCommandError('Command internal_toggle_devtools not found');
      wv(input, ctx).webContents.toggleDevTools();
      return null;
    },
    clear_all_browsing_data: async (input, ctx) => {
      await wv(input, ctx).webContents.session.clearData();
      return null;
    },
    set_webview_background_color: (input, ctx) => {
      const v = raw(input, 'color') ?? raw(input, 'value');
      if (Array.isArray(v)) {
        const [r = 0, g = 0, b = 0, a = 255] = v as number[];
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        wv(input, ctx).browserWindow.setBackgroundColor(`#${hex(a)}${hex(r)}${hex(g)}${hex(b)}`);
      }
      return null;
    },
    create_webview: no('create_webview', 'each window hosts exactly one webview in the Electron shell'),
    reparent: no('reparent', 'each window hosts exactly one webview in the Electron shell'),
    set_webview_size: no('set_webview_size', 'webview always fills its window in this shell'),
    set_webview_position: no('set_webview_position', 'webview always fills its window in this shell'),
    set_webview_auto_resize: no('set_webview_auto_resize', 'webview always fills its window in this shell'),
  };
}
