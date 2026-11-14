/**
 * Tauri `WindowConfig` → Electron `BrowserWindowConstructorOptions` 的映射（纯函数，便于测试）。
 * 默认值取自 tauri-utils-2.9.3 `config.rs` 的 `WindowConfig::default`。
 */
import type { TauriWindowConfig, ShellPlatform } from './tauri-config.ts';

export interface MappedWindowOptions {
  width: number;
  height: number;
  x?: number;
  y?: number;
  center: boolean;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable: boolean;
  maximizable: boolean;
  minimizable: boolean;
  closable: boolean;
  title: string;
  fullscreen: boolean;
  focusable: boolean;
  show: boolean;
  frame: boolean;
  transparent: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  hasShadow: boolean;
  titleBarStyle?: 'hidden' | 'default';
  trafficLightPosition?: { x: number; y: number };
  backgroundColor?: string;
  acceptFirstMouse?: boolean;
  tabbingIdentifier?: string;
  /** 以下由调用方在创建后应用。 */
  maximized: boolean;
  focus: boolean;
  contentProtected: boolean;
  dragDropEnabled: boolean;
  devtools: boolean;
}

/** RGBA → Electron's `#AARRGGBB`. */
function colorToCss(color: TauriWindowConfig['backgroundColor']): string | undefined {
  if (color === undefined) return undefined;
  const [r, g, b, a] = color;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(a)}${hex(r)}${hex(g)}${hex(b)}`;
}

export function mapWindowConfig(config: TauriWindowConfig, platform: ShellPlatform, debug: boolean): MappedWindowOptions {
  const decorations = config.decorations ?? true;
  const out: MappedWindowOptions = {
    width: config.width ?? 800,
    height: config.height ?? 600,
    center: config.center ?? false,
    resizable: config.resizable ?? true,
    maximizable: config.maximizable ?? true,
    minimizable: config.minimizable ?? true,
    closable: config.closable ?? true,
    title: config.title ?? 'Tauri App',
    fullscreen: config.fullscreen ?? false,
    focusable: config.focusable ?? true,
    show: config.visible ?? true,
    frame: decorations,
    transparent: config.transparent ?? false,
    alwaysOnTop: config.alwaysOnTop ?? false,
    skipTaskbar: config.skipTaskbar ?? false,
    hasShadow: config.shadow ?? true,
    maximized: config.maximized ?? false,
    focus: config.focus ?? true,
    contentProtected: config.contentProtected ?? false,
    dragDropEnabled: config.dragDropEnabled ?? true,
    devtools: config.devtools ?? debug,
  };
  if (config.x !== undefined && config.y !== undefined) {
    out.x = config.x;
    out.y = config.y;
  }
  if (config.minWidth !== undefined) out.minWidth = config.minWidth;
  if (config.minHeight !== undefined) out.minHeight = config.minHeight;
  if (config.maxWidth !== undefined) out.maxWidth = config.maxWidth;
  if (config.maxHeight !== undefined) out.maxHeight = config.maxHeight;
  const bg = colorToCss(config.backgroundColor);
  if (bg !== undefined) out.backgroundColor = bg;
  else if (out.transparent) out.backgroundColor = '#00000000';
  if (platform === 'darwin') {
    // Tauri macOS：decorations=true 且 titleBarStyle=Overlay/Transparent 时内容延伸到标题栏，保留红绿灯；
    // Electron 对应 `titleBarStyle: 'hidden'`（全尺寸内容视图 + 系统红绿灯，默认位置）。
    if (decorations && (config.titleBarStyle === 'Overlay' || config.titleBarStyle === 'Transparent')) {
      out.titleBarStyle = 'hidden';
      out.frame = true;
    }
    const tl = config.trafficLightPosition;
    if (tl !== undefined) out.trafficLightPosition = { x: tl.x, y: tl.y };
    if (config.acceptFirstMouse !== undefined) out.acceptFirstMouse = config.acceptFirstMouse;
    if (config.tabbingIdentifier !== undefined) out.tabbingIdentifier = config.tabbingIdentifier;
  }
  return out;
}

/**
 * Tauri 给每个桌面窗口设默认图标：`bundle.icon` 里第一张 PNG（`icons/32x32.png`）。Electron 只有 Linux 需要显式设置：
 * Windows 窗口取 exe 内的图标资源，macOS 窗口没有图标。`iconDir` 是 `electron/resources/icons`。
 */
export function defaultWindowIcon(platform: ShellPlatform, iconDir: string): string | undefined {
  return platform === 'linux' ? `${iconDir}/png/32x32.png` : undefined;
}

/** Tauri `is_label_valid`：字母数字、`-` `/` `:` `_`。 */
export function isLabelValid(label: string): boolean {
  return /^[A-Za-z0-9\-/:_]+$/.test(label);
}

export const INVALID_LABEL_MESSAGE = 'Window labels must only include alphanumeric characters, `-`, `/`, `:` and `_`.';
