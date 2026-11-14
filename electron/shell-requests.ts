/**
 * Host 代办请求（`ShellRequest`）在 main 侧的实现：`op` 为内置插件命令（如 `plugin:window|show`、
 * `plugin:webview|create_webview_window`），`args` 为其参数，另可带 `__window`（作为调用方窗口，默认 `main`）；
 * 其余是 main 独有的查询（`app.*`、`window.*`、`browser.*`）。
 */
import { join } from 'node:path';
import type { ShellRequest } from '../host/kernel/protocol.ts';
import { handleBrowserShellRequest, type BrowserSurfaceLike } from './shell/browser-protocol.ts';
import { ShellCommandError } from './shell/errors.ts';
import { setWindowAppearance, syncTitlebarSidebarMaterial } from './shell/native-window.ts';
import type { ShellOsDirMap } from './shell/os-dirs.ts';
import { BaseDirectory, UnknownPathError, type PathResolver } from './shell/paths.ts';
import { resolveShellOp } from './shell/shell-ops.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';
import type { WindowManager } from './shell/windows.ts';

export interface ShellRequestDeps {
  platform: ShellPlatform;
  /** 应用标识（`tauri.conf.json` `identifier`）：app_local_data_dir / app_cache_dir 的末级目录。 */
  identifier: string;
  /** Host 握手的 appDataDir（含 `DS_APP_DATA_DIR` 覆盖）。 */
  appDataDir: string;
  /** 与 Host 启动时继承的 `DS_SHELL_OS_DIRS` 同源。 */
  osDirs: Pick<ShellOsDirMap, 'dataLocal' | 'cache'>;
  migrationsDir: string;
  fullVersion(): string;
  windows: Pick<WindowManager, 'get' | 'listWindows' | 'getMainWindow'>;
  paths: Pick<PathResolver, 'resolveDirectory'>;
  browserSurface: BrowserSurfaceLike;
  /**
   * Host 的 dstu.shell startupGate 首次 `markStartupReady()` 时经 Host 私有 MessagePort 发来的
   * `app.startupReady`（`{}`，只发一次）。只在 Host 通道上生效，渲染进程无法触发。
   */
  onStartupReady?(): void;
  /** 以 `windowLabel` 为调用方窗口执行内置插件命令；没有这个命令时返回 `undefined`。 */
  runBuiltin(command: string, args: Record<string, unknown>, windowLabel: string): Promise<unknown> | undefined;
}

export async function handleShellRequest(deps: ShellRequestDeps, request: Pick<ShellRequest, 'op' | 'args'>): Promise<unknown> {
  const { platform, windows } = deps;
  const args = (request.args ?? {}) as Record<string, unknown>;
  if (request.op === 'app.fullVersion') return deps.fullVersion();
  if (request.op === 'app.startupReady') {
    // RUST-FIX(RF-W06-startup-recovery): 就绪信号只来自 Host 私有 MessagePort。
    // Host 就绪（不是 HostReady/握手/首帧）；重置连续未就绪失败并清 pending。
    deps.onStartupReady?.();
    return null;
  }
  if (request.op === 'app.migrationsDir') return deps.migrationsDir;
  if (request.op === 'window.listWindows') return windows.listWindows();
  if (request.op === 'window.getMainWindow') return windows.getMainWindow();
  if (request.op.startsWith('browser.')) {
    return handleBrowserShellRequest(deps.browserSurface, request.op, args);
  }
  const withId = (base: string | null) => (base === null ? null : join(base, deps.identifier));
  if (request.op === 'app.dataDirs') {
    // data 与 Host 握手的 appDataDir 相同（含 DS_APP_DATA_DIR 覆盖）；localData / cache 为 Tauri app_local_data_dir /
    // app_cache_dir；dataLocalDir 为 dirs::data_local_dir()。三者与 Host 启动时继承的 DS_SHELL_OS_DIRS 同源
    // （scopes.osDirs），Host 侧同步需要的目录应直接读 `ctx.paths.os`。
    return {
      data: deps.appDataDir,
      localData: withId(deps.osDirs.dataLocal),
      cache: withId(deps.osDirs.cache),
      dataLocalDir: deps.osDirs.dataLocal,
    };
  }
  const windowLabel = typeof args.__window === 'string' ? args.__window : 'main';
  if (request.op === 'window.setVibrancy') {
    const label = typeof args.label === 'string' ? args.label : windowLabel;
    const win = windows.get(label);
    if (!win) throw new Error('window not found');
    if (platform !== 'darwin') return false;
    win.browserWindow.setVibrancy(args.enabled === true ? 'sidebar' : null);
    return args.enabled === true;
  }
  if (request.op === 'window.setAppearance') {
    const win = windows.get(windowLabel);
    if (!win) throw new Error('window not found');
    if (platform !== 'darwin') return null;
    setWindowAppearance(win.browserWindow, args.dark === true);
    return null;
  }
  if (request.op === 'window.syncTitlebarSidebarMaterial') {
    const win = windows.get(windowLabel);
    if (!win) throw new Error('window not found');
    if (platform !== 'darwin') return null;
    syncTitlebarSidebarMaterial(win.browserWindow, args.enabled === true, typeof args.width === 'number' ? args.width : 0);
    return null;
  }
  if (request.op === 'app.mainWindowActive') {
    // Rust `automations.rs::main_window_is_active`：focused && visible && !minimized。
    const win = windows.get('main');
    if (!win || win.browserWindow.isDestroyed()) return false;
    return win.browserWindow.isFocused() && win.browserWindow.isVisible() && !win.browserWindow.isMinimized();
  }
  if (request.op === 'app.pdfStreamAllowedDirs') {
    const dirs = new Set<string>();
    const add = (dir: string | null) => { if (dir !== null && dir !== '') dirs.add(dir); };
    add(deps.appDataDir);
    add(withId(deps.osDirs.dataLocal));
    add(withId(deps.osDirs.cache));
    for (const directory of [BaseDirectory.Document, BaseDirectory.Download, BaseDirectory.Temp, BaseDirectory.Resource, BaseDirectory.Desktop, BaseDirectory.Picture]) {
      try { add(deps.paths.resolveDirectory(directory)); }
      catch (error) { if (!(error instanceof UnknownPathError)) throw error; }
    }
    return [...dirs];
  }
  const builtin = deps.runBuiltin(resolveShellOp(request.op), args, windowLabel);
  if (builtin === undefined) throw new Error(`unknown shell op: ${request.op}`);
  try {
    return await builtin;
  } catch (error) {
    if (error instanceof ShellCommandError) throw new Error(typeof error.value === 'string' ? error.value : JSON.stringify(error.value));
    throw error;
  }
}
