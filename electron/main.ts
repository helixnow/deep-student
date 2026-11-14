/**
 * Electron main（F2 外壳）。由 `npm run dev:electron`（electron/scripts/dev.mjs）启动，Node 24 类型剥离直接运行。
 *
 * 环境变量（打包版只认 `DS_APP_DATA_DIR`、`DS_ELECTRON_USER_DATA`，其余在启动时删除，见 shell/launch-env.ts）：
 * - `DS_ELECTRON_DEV_URL`：前端开发服务器地址（dev.mjs 设为 tauri.conf.json 的 devUrl）；未设置时从 frontendDist 经 `tauri` 协议加载。
 * - `DS_HOST_ENTRY`：Host 入口（默认 `host/kernel/main.ts`）。
 * - `DS_HOST_PROFILE`：覆盖握手 profile（默认 `<appDataDir>/plugins/user.profile.json` 存在时用它，否则官方 profile）。
 * - `DS_ELECTRON_USER_DATA`：覆盖 Electron userData（同时决定单实例锁，测试用）。
 * - `DS_APP_DATA_DIR`：覆盖 appDataDir（冒烟测试用隔离目录，避免读写用户正式数据）；交给 Host 与 localStorage 迁移的
 *   home / dirs:: 目录同时换到 `<DS_APP_DATA_DIR>.os/home` 下（见 shell/os-dirs.ts）。
 * - `DS_ELECTRON_FRONTEND_DIST`：覆盖生产入口的 frontendDist 目录（未设置 `DS_ELECTRON_DEV_URL` 时生效）。
 * - `DS_ELECTRON_CAPTURE=<png 路径>`：主窗口加载完成后等待 `DS_ELECTRON_CAPTURE_DELAY_MS`（默认 4000）截图写入该路径。
 *
 * 写给 Host 的环境变量：`DS_MIGRATIONS_DIR`、`DS_SHELL_OS_DIRS`、`DS_APP_IDENTIFIER`（fork Host 之前写入）。
 *
 * 主进程日志：`log()` 同时写 stdout 与 `<app_log_dir>/electron-main.log`（shell/main-log.ts），Host 早期失败
 * （HostFatal、退出码 / 信号、最后一段 stderr）都在这里。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session, shell } from 'electron';
import { diagnosticRecord } from '../host/platform/log/incidents.ts';
import type { BackendEvent } from '../host/kernel/protocol.ts';
import { createAppLifecycle, type AppLifecycle } from './app-lifecycle.ts';
import { wireRendererIpc } from './renderer-ipc.ts';
import { handleShellRequest } from './shell-requests.ts';
import {
  migrationDialogPrompt,
  prepareMigration,
  startWebviewMigration,
  wireWebviewMigrationIpc,
  type ActiveWebviewMigration,
  type WebviewMigrationEnv,
} from './webview-migration-wiring.ts';
import { describeError, installProcessErrorLogging, runApp } from './shell/bootstrap.ts';
import { deriveScopes, type DerivedScopes } from './shell/capabilities.ts';
import { HOST_SERVICE_NAME, HostSupervisor } from './shell/host.ts';
import { MainLog, mainLogFile } from './shell/main-log.ts';
import { resolveHostProfile } from './shell/host-profile.ts';
import { dropDevOnlyEnv } from './shell/launch-env.ts';
import { installMenu } from './shell/menu.ts';
import { createPluginFileResolver } from './shell/plugin-lock.ts';
import { createStartupRecovery, isSafeMode, PluginStartupState, SAFE_MODE_ARG, SAFE_MODE_ENV, STARTUP_STATE_FILE, type RecoveryMessage } from './shell/safe-mode.ts';
import { resolveWindowsKnownFolders, shGetKnownFolderPath } from './shell/known-folders.ts';
import { hostPathEnv, resolveShellOsDirs, type ShellOsDirMap } from './shell/os-dirs.ts';
import type { PathEnvironment, PathResolver } from './shell/paths.ts';
import { PluginUiRegistry } from './shell/plugin-ui-protocol.ts';
import { dialogPlugin } from './shell/plugins/dialog.ts';
import { eventPlugin } from './shell/plugins/event.ts';
import { fsPlugin } from './shell/plugins/fs.ts';
import { httpPlugin } from './shell/plugins/http.ts';
import { appPlugin, pathPlugin, resourcesPlugin } from './shell/plugins/path-app.ts';
import {
  clipboardPlugin,
  forwardShortcutToHost,
  globalShortcutPlugin,
  notificationPlugin,
  openerPlugin,
  processPlugin,
  type ProcessHooks,
  updaterPlugin,
} from './shell/plugins/system.ts';
import { stopWindowDrag, webviewPlugin, windowPlugin } from './shell/plugins/window.ts';
import { installProtocols, registerSchemePrivileges } from './shell/protocols.ts';
import { ShellRuntime } from './shell/runtime.ts';
import { FsScope, fsScopeFromPatterns } from './shell/scope.ts';
import { loadTauriConfig, type ShellPlatform } from './shell/tauri-config.ts';
import { installWebSecurity } from './shell/web-security.ts';
import type { MigrationPrompt } from './shell/webview-migration.ts';
import { defaultWindowIcon } from './shell/window-options.ts';
import { WindowManager, type ShellWindow } from './shell/windows.ts';
import { BROWSER_CONTENT_LABEL, BrowserContentSurface } from './shell/browser-surface.ts';
import { AgentNavigationGuard } from './shell/browser-agent-guard.ts';
import { forwardBrowserContentEvents, nativeBrowserContentEvent } from './shell/browser-content-events.ts';
import { getAppVersion } from './build-info.ts';
import { imagePlugin } from './shell/images.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const tauriDir = join(repoRoot, 'resources/app');
const platform = process.platform as ShellPlatform;
const debug = !app.isPackaged;
const mainLog = new MainLog();
const log = (message: string) => {
  process.stdout.write(`[dstu-shell] ${message}\n`);
  mainLog.write(message);
};
const logElectronError = (operation: string, error: unknown) => {
  log('[diagnostic] ' + JSON.stringify(diagnosticRecord({ source: 'electron', operation, error })));
};
installProcessErrorLogging(process, message => logElectronError('electron.process', message));
const ignoredEnv = dropDevOnlyEnv(process.env, app.isPackaged);
if (ignoredEnv.length > 0) log(`[launch] packaged build: ignored development environment variables ${ignoredEnv.join(', ')}`);

const config = loadTauriConfig(tauriDir, platform, debug ? process.env.DS_ELECTRON_DEV_CONFIG : undefined);
/**
 * `resources/app/migrations/**` 在包内位于 `Contents/Resources/migrations`
 * （electron-builder `extraResources` 逐字节复制）。开发态直接用仓库目录；两者都通过
 * `DS_MIGRATIONS_DIR` 交给 Host 进程，F3 存储服务以它作为 `StorageServiceOptions.migrationsDir`。
 */
const migrationsDir = process.env.DS_MIGRATIONS_DIR
  ?? (app.isPackaged ? join(process.resourcesPath, 'migrations') : join(tauriDir, 'migrations'));
process.env.DS_MIGRATIONS_DIR = migrationsDir;
registerSchemePrivileges();

// Electron 自身的 userData（Chromium 配置、缓存）放在独立目录，不混入 Tauri 版的 app data。
app.setPath('userData', process.env.DS_ELECTRON_USER_DATA ?? join(app.getPath('appData'), `${config.identifier}.electron`));

/**
 * 测试入口可以 import 本模块并调用 {@link start} 注入最终不可逆的进程 hooks；
 * 直接运行 `electron/main.ts`（开发态）或打包态入口时仍走默认启动。
 */
const directEntry = app.isPackaged
  || (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename);

if (directEntry) {
  void runApp({
    app,
    dialog,
    launch: { argv: process.argv, defaultApp: process.defaultApp === true, platform, stderr: process.stderr },
    start: () => start(),
    log,
    productName: config.productName,
  });
}

export interface StartOptions {
  /**
   * 仅替换最终不可逆的 restart/exit hooks；Host 协议、shell-request 路由与错误出口保持生产实现。
   * 生产入口不传该选项，继续使用 app.relaunch()/app.exit()。
   */
  processHooks?: ProcessHooks;
  /** 仅替换安全策略把外链交给系统浏览器的出口（默认 `shell.openExternal`）；放行判定不变。 */
  openExternal?: (url: string) => Promise<void>;
  /** 仅替换 localStorage 迁移失败时的“重试 / 退出”对话框（默认 `dialog.showMessageBox`）；失败判定与阻断不变。 */
  migrationPrompt?: MigrationPrompt;
  /** 仅测试：读回与落盘确认通过之后、写 `done` 之前调用（模拟进程在这一刻被杀）。 */
  beforeMigrationComplete?: () => void;
  /**
   * 仅测试：替换启动恢复的原生对话框。生产入口不传，走 `dialog.showMessageBox`；
   * 恢复判定（阈值、备份、重启参数）不变。
   */
  startupRecoveryPrompt?: (message: RecoveryMessage) => Promise<{ response: number }>;
  /** 仅测试：内置插件注册完、窗口创建前读出 runtime 与作用域（核对 main 交给它们的值）。 */
  onRuntime?: (runtime: ShellRuntime, scopes: ShellScopes) => void;
}

function knownFolders(): NonNullable<PathEnvironment['windowsKnownFolders']> {
  if (platform !== 'win32') return {};
  return resolveWindowsKnownFolders({ query: shGetKnownFolderPath(), env: process.env, getPath: (name) => app.getPath(name), log });
}

/** 路径解析与 capability 派生的作用域（asset 协议、fs 插件、opener）。 */
export interface ShellScopes {
  paths: PathResolver;
  appDataDir: string;
  /** 交给 Host（`DS_SHELL_OS_DIRS`）、`app.dataDirs` 与 localStorage 迁移的同一份操作系统目录。 */
  osDirs: ShellOsDirMap;
  derived: DerivedScopes;
  assetScope: FsScope;
  fsGlobal: FsScope;
  /** 运行时追加的 fs 作用域（拖放进来的路径）。 */
  fsRuntime: FsScope;
  openerPaths: FsScope;
}

/** `userDataDir` 是 `app.getPath('userData')`：作用域条目里 `$ELECTRON_USERDATA/**` 的值（deny-webview-data）。 */
function resolveScopes(userDataDir: string): ShellScopes {
  const environment: PathEnvironment = {
    platform,
    env: { ...process.env },
    fallbackHome: homedir(),
    identifier: config.identifier,
    tempDir: tmpdir(),
    resourceDir: process.resourcesPath ?? null,
    windowsKnownFolders: knownFolders(),
  };
  const os = resolveShellOsDirs(environment, process.env.DS_APP_DATA_DIR);
  const { paths } = os;
  const appDataDir = paths.appDataDir();
  if (appDataDir === null) throw new Error('cannot resolve app data dir (unknown path)');
  if (os.isolatedRoot !== null) log(`[paths] DS_APP_DATA_DIR set: home, dirs:: and path plugin directories isolated under ${os.isolatedRoot}`);
  const derived = deriveScopes(join(tauriDir, 'capabilities'), platform);
  return {
    paths,
    appDataDir,
    osDirs: os.dirs,
    derived,
    assetScope: fsScopeFromPatterns(paths, platform, config.assetScope.allow, config.assetScope.deny, userDataDir),
    fsGlobal: fsScopeFromPatterns(paths, platform, derived.fsAllow, derived.fsDeny, userDataDir),
    fsRuntime: new FsScope({ platform }),
    openerPaths: fsScopeFromPatterns(paths, platform, derived.openerPathAllow.map((entry) => entry.path), [], userDataDir),
  };
}

/** 应用页面的基础 URL 与 origin：开发服务器，或生产的 `tauri://localhost` / Windows `http://tauri.localhost`。 */
function resolveAppLocation(): { appBase: string; windowOrigin: string } {
  const devUrl = process.env.DS_ELECTRON_DEV_URL;
  const appBase = devUrl ? new URL('/', devUrl).href : platform === 'win32' ? 'http://tauri.localhost/' : 'tauri://localhost/';
  const windowOrigin = new URL(appBase).protocol === 'tauri:' ? 'tauri://localhost' : new URL(appBase).origin;
  return { appBase, windowOrigin };
}

function registerBuiltinPlugins(runtime: ShellRuntime, scopes: ShellScopes, processHooks: ProcessHooks): void {
  const { derived } = scopes;
  runtime.registerPlugin('event', eventPlugin());
  runtime.registerPlugin('window', windowPlugin());
  runtime.registerPlugin('webview', webviewPlugin());
  runtime.registerPlugin('path', pathPlugin());
  runtime.registerPlugin('app', appPlugin());
  runtime.registerPlugin('resources', resourcesPlugin());
  runtime.registerPlugin('dialog', dialogPlugin());
  runtime.registerPlugin('fs', fsPlugin({ global: scopes.fsGlobal, runtime: scopes.fsRuntime }));
  runtime.registerPlugin('http', httpPlugin({ allow: derived.httpAllow, deny: derived.httpDeny }, (url) => session.defaultSession.resolveProxy(url)));
  runtime.registerPlugin('clipboard-manager', clipboardPlugin());
  runtime.registerPlugin('image', imagePlugin());
  runtime.registerPlugin('opener', openerPlugin({ urlAllow: derived.openerUrlAllow, paths: scopes.openerPaths, pathApps: derived.openerPathAllow.map((entry) => entry.app) }, process.platform));
  runtime.registerPlugin('notification', notificationPlugin());
  runtime.registerPlugin('process', processPlugin(processHooks));
  runtime.registerPlugin('updater', updaterPlugin({
    appName: app.getName(),
    execPath: process.execPath,
    argv: process.argv,
    env: process.env,
    exit: (code) => processHooks.exit(code),
  }));
  runtime.registerPlugin('global-shortcut', globalShortcutPlugin(platform, { pressed: forwardShortcutToHost(runtime) }));
}

/**
 * 载荷序列化失败的事件不投递（Rust `emit` 序列化失败即返回错误）。生产 Host 不检查载荷是否为纯 JSON（只在 debug 下），
 * 经结构化克隆到这里的循环引用、类实例里的 BigInt（toWireJson 不进入类实例）会让 stringify 抛错；
 * 抛出 MessagePort 监听会弹出主进程错误对话框。
 */
function eventPayloadJson(event: BackendEvent, log: (message: string) => void): string | null {
  if (event.payloadJson !== undefined) return event.payloadJson;
  try {
    return JSON.stringify(event.payload ?? null);
  } catch (error) {
    log(`[host] dropped event "${event.event}": payload is not JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function createHostSupervisor(
  runtime: ShellRuntime,
  scopes: ShellScopes,
  pluginUi: PluginUiRegistry,
  browserSurface: BrowserContentSurface,
  agentGuard: AgentNavigationGuard,
  safeMode: boolean,
  recovery: ReturnType<typeof createStartupRecovery>,
): { host: HostSupervisor; entry: string } {
  const { appDataDir } = scopes;
  const entry = process.env.DS_HOST_ENTRY ?? join(repoRoot, 'host', 'kernel', 'main.ts');
  // RUST-FIX(RF-W06-safe-mode): 只有官方 profile，且社区 UI/安装在整个会话内不可用。
  const hostProfile = resolveHostProfile({
    safeMode,
    override: process.env.DS_HOST_PROFILE,
    appDataDir,
    hostEntry: entry,
    exists: existsSync,
  });
  log(`[host] profile ${hostProfile}`);
  const ocrHelper = app.isPackaged
    ? join(process.resourcesPath, '..', 'MacOS', 'dstu-system-ocr')
    : join(repoRoot, 'electron', '.build', 'dstu-system-ocr');
  const host = new HostSupervisor({
    entry,
    // Host 的 CapabilityAcl 从这里加载 capabilities/ 与 permissions/；打包后位于 app/resources/app。
    // RUST-FIX(RF-W06-safe-mode): 把 --safe-mode 交给 Host，供 W01 拒绝社区安装/启用/重载。
    args: [`--tauri-dir=${tauriDir}`, ...(safeMode ? [SAFE_MODE_ARG] : []),
      ...(process.platform === 'darwin' && existsSync(ocrHelper) ? [`--system-ocr-helper=${ocrHelper}`] : [])],
    handshake: {
      appDataDir,
      appVersion: config.version,
      platform,
      debug,
      profile: hostProfile,
    } as ConstructorParameters<typeof HostSupervisor>[0]['handshake'],
    onEvent: (event) => {
      const payloadJson = eventPayloadJson(event, log);
      if (event.event === 'host://plugin-profile-failed') {
        const payload = (event.payload ?? {}) as { profile?: unknown; error?: unknown };
        const profile = typeof payload.profile === 'string' ? payload.profile : '(unknown profile)';
        const reason = typeof payload.error === 'string' ? payload.error : payloadJson ?? '(payload is not JSON)';
        log(`[host] plugin profile failed (${profile}): ${reason}`);
      } else if (event.event === 'host://ui-manifest') {
        try {
          pluginUi.update(event.payload);
        } catch (error) {
          log(`[host] invalid UI manifest: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (payloadJson !== null) runtime.emitTo(event.target, event.event, payloadJson);
    },
    onShellRequest: (request) => handleShellRequest({
      platform,
      identifier: config.identifier,
      appDataDir,
      osDirs: scopes.osDirs,
      migrationsDir,
      fullVersion: getAppVersion,
      windows: runtime.windows,
      paths: scopes.paths,
      browserSurface,
      onStartupReady: () => recovery.ready(),
      runBuiltin: (command, args, windowLabel) => runtime.runBuiltin(command, { json: args, raw: null, headers: {} }, { runtime, windowLabel, webviewLabel: windowLabel }),
    }, request),
    onUnavailable: (reason) => {
      // 只记录：invoke 继续以该原因 reject，前端按其自身的错误路径呈现（不弹模态框阻塞 main 事件循环）。
      pluginUi.invalidate();
      log(`[host] unavailable: ${reason}`);
    },
    // 新的 Host 里 browser 插件从“非 Agent 控制”开始，只在之后变化时推送。
    onProcessExit: () => agentGuard.reset(),
    // RUST-FIX(RF-W06-startup-recovery): 启动台账在每次 Host 启动前置 pending。
    onStartAttempt: () => recovery.beginStart(),
    onUnexpectedExit: () => recovery.unexpectedExit(),
    compileCacheDir: join(app.getPath('userData'), 'host-compile-cache'),
    log,
  });
  return { host, entry };
}

function createWindowManager(runtime: ShellRuntime, appBase: string, preloadPath: string, lifecycle: AppLifecycle): WindowManager {
  return new WindowManager({
    platform,
    debug,
    preloadPath,
    resolveUrl: (url) => new URL(url ?? 'index.html', appBase).href,
    emit: (event, payload, filter) => runtime.emitJs(event, payload, filter),
    hasJsListener: (event, filter) => runtime.listeners.hasListener(event, filter),
    lifecycle: (ref, state) => runtime.host.sendMessage({ kind: 'window', ref, state }),
    webviewGone: (label, reason) => runtime.webviewGone(label, reason),
    afterCreate: (win) => {
      // src-tauri/src/lib.rs setup：macOS 主窗口挂原生 Sidebar 材质。
      if (platform === 'darwin' && win.label === 'main') win.browserWindow.setVibrancy('sidebar');
      // lib.rs:1714-1783 主窗口 CloseRequested：后台驻留 / macOS 关窗即退出。
      lifecycle.windowCreated(win);
    },
    log,
  });
}

/**
 * browser-content 的原生回调以 frontend-event 交给 Host，来源为 content webview（插件只认这个来源），并带 `native: true`
 * （页面经 `plugin:event|emit` 转发的同名事件没有这个标记）。
 */
function sendBrowserContentEvent(runtime: ShellRuntime, windowLabel: string, event: string, payload: Record<string, unknown>): void {
  runtime.host.sendMessage(nativeBrowserContentEvent({ window: windowLabel, webview: BROWSER_CONTENT_LABEL }, event, payload));
}

/** 外壳拦下的 Agent 导航交给 browser 插件（Rust `on_navigation_blocked` → `BrowserService::record_navigation_blocked`）。 */
function createAgentGuard(runtime: ShellRuntime): AgentNavigationGuard {
  return new AgentNavigationGuard({
    fallbackSession: session.defaultSession,
    onBlocked: (url, reason, contents) => {
      log(`[browser] blocked agent navigation to ${url}: ${reason}`);
      const entry = contents === null || contents.isDestroyed() ? null : runtime.browserWebviewOf(contents);
      const windowLabel = entry?.windowLabel ?? (platform === 'linux' ? BROWSER_CONTENT_LABEL : 'main');
      sendBrowserContentEvent(runtime, windowLabel, 'dstu-browser://navigation-blocked', { url, reason });
    },
  });
}

function createBrowserSurface(runtime: ShellRuntime, preloadPath: string, agentGuard: AgentNavigationGuard): BrowserContentSurface {
  return new BrowserContentSurface({
    agentGuard,
    platform,
    preloadPath,
    getMainWindow: () => runtime.windows.get('main')?.browserWindow ?? null,
    registerWebview: (contents, label, windowLabel, initializationScript) => {
      runtime.registerBrowserWebview({ label, windowLabel, webContents: contents, initializationScript });
      // Tauri 的 on_page_load 对 add_child/detached 的 browser-content webview 同样生效；注销后不再通知。
      contents.on('did-navigate', () => {
        if (runtime.browserWebviewOf(contents) === null) return;
        runtime.host.sendMessage({ kind: 'window', ref: { window: windowLabel, webview: label }, state: 'page-load-started' });
      });
      forwardBrowserContentEvents(contents, (event, payload) => {
        if (runtime.browserWebviewOf(contents) === null) return;
        sendBrowserContentEvent(runtime, windowLabel, event, payload);
      });
    },
    unregisterWebview: (contents, reason) => {
      runtime.unregisterBrowserWebview(contents);
      runtime.webviewGone(BROWSER_CONTENT_LABEL, reason);
    },
    appWindowExists: (label) => runtime.windows.get(label) !== undefined,
    log,
  });
}

/** 会话级装配：安全策略（权限、新窗口、导航、`<webview>`）与自定义协议。必须在创建任何窗口之前调用。 */
function installSessionHandlers(
  runtime: ShellRuntime,
  scopes: ShellScopes,
  windowOrigin: string,
  pluginUi: PluginUiRegistry,
  openExternal: (url: string) => Promise<void>,
): void {
  installWebSecurity(app, session.defaultSession, {
    appOrigin: windowOrigin,
    roleOf: (contents) => {
      if (runtime.windows.byWebContents(contents) !== undefined) return 'app';
      return runtime.browserWebviewOf(contents) !== null ? 'browser' : null;
    },
    openerUrlAllow: scopes.derived.openerUrlAllow,
    openExternal,
    log,
  });
  installProtocols(session.defaultSession, {
    platform,
    host: runtime.host,
    assetScope: scopes.assetScope,
    assetEnabled: config.assetProtocolEnabled,
    windowOrigin: () => windowOrigin,
    frontendDist: process.env.DS_ELECTRON_FRONTEND_DIST ?? config.frontendDist,
    csp: config.csp,
    pluginUi,
    loadUiManifest: () => invokeHostCommand(runtime, 'plugin:ui|manifest', {}),
    // RUST-FIX(RF-W06-plugin-lock-integrity): ds-plugin 只按 plugins.lock.json 提供已登记且未篡改的文件。
    pluginFiles: createPluginFileResolver(join(scopes.appDataDir, 'plugins')),
    log,
  });
}

/** `url` 覆盖首次加载的地址（localStorage 迁移先加载空白迁移页）；其余窗口配置不变。 */
function openMainWindow(runtime: ShellRuntime, url?: string): ShellWindow {
  const mainConfig = config.windows[0] ?? {};
  const main = runtime.windows.create({ ...mainConfig, label: mainConfig.label ?? 'main', ...(url === undefined ? {} : { url }) });

  // 开发版把页面的 warning/error 输出到终端，便于排查（Tauri dev 中这些只在 Web Inspector 可见）。
  if (debug) {
    main.webContents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') log(`[renderer:${event.level}] ${event.message}`);
    });
  }

  const capture = process.env.DS_ELECTRON_CAPTURE;
  if (capture) {
    // 从窗口创建起计时（不依赖 did-finish-load：页面可能因 vite 依赖预构建而整页重载）。
    setTimeout(() => {
      void main.webContents.capturePage().then((image) => {
        mkdirSync(dirname(capture), { recursive: true });
        writeFileSync(capture, image.toPNG());
        log(`captured ${capture} (url ${main.webContents.getURL()})`);
      }).catch((error: unknown) => log(`capture failed: ${describeError(error)}`));
    }, Number(process.env.DS_ELECTRON_CAPTURE_DELAY_MS ?? 4000));
  }
  return main;
}

export async function start(options: StartOptions = {}): Promise<void> {
  const userDataDir = app.getPath('userData');
  const scopes = resolveScopes(userDataDir);
  const safeMode = isSafeMode(process.argv);
  // `DS_SAFE_MODE` 只由本次启动决定：安全模式写给 Host，其余启动删掉继承来的同名变量。
  if (safeMode) process.env[SAFE_MODE_ENV] = '1';
  else delete process.env[SAFE_MODE_ENV];
  if (safeMode) log('[startup] safe mode: official profile only, community plugin UI and installs disabled');
  const startupState = (() => {
    const file = join(userDataDir, STARTUP_STATE_FILE);
    try {
      return PluginStartupState.load(file, app.isPackaged);
    } catch (error) {
      log(`[startup] cannot read ${file}: ${describeError(error)}; starting with a fresh startup ledger`);
      return PluginStartupState.reset(file);
    }
  })();
  const recovery = createStartupRecovery({
    state: startupState,
    appDataDir: scopes.appDataDir,
    argv: process.argv,
    showMessageBox: options.startupRecoveryPrompt ?? ((message) => dialog.showMessageBox(message)),
    relaunch: (args) => {
      log(`[startup] restarting in safe mode: ${args.join(' ')}`);
      app.relaunch({ args });
      app.exit(0);
    },
    log,
  });
  const logFile = mainLogFile(platform, scopes.osDirs, config.identifier);
  if (logFile !== null) mainLog.open(logFile);
  // utilityProcess 在 fork 时继承 process.env；Host 的 resolveOsDirs 以它为准。
  Object.assign(process.env, hostPathEnv(scopes.osDirs, config.identifier));
  const { appBase, windowOrigin } = resolveAppLocation();
  const runtime = new ShellRuntime({
    platform,
    debug,
    config,
    paths: scopes.paths,
    assetScope: scopes.assetScope,
    fsScope: scopes.fsRuntime,
    appVersion: config.version,
    localOrigin: windowOrigin,
    userDataDir,
    log,
  });
  const lifecycle = createAppLifecycle({
    platform,
    app,
    powerMonitor,
    invokeHost: (cmd, args) => invokeHostCommand(runtime, cmd, args),
    shutdownHost: () => runtime.host.shutdown(),
    beforeExit: () => recovery.cleanExit(),
    killHost: () => runtime.host.forceKill(),
    allWindows: () => BrowserWindow.getAllWindows(),
    log,
  });
  const processHooks = options.processHooks ?? lifecycle.processHooks;
  registerBuiltinPlugins(runtime, scopes, processHooks);
  options.onRuntime?.(runtime, scopes);

  const pluginUi = new PluginUiRegistry(safeMode);
  const preloadPath = join(import.meta.dirname, '.build', 'preload.cjs');
  const agentGuard = createAgentGuard(runtime);
  const browserSurface = createBrowserSurface(runtime, preloadPath, agentGuard);
  const host = createHostSupervisor(runtime, scopes, pluginUi, browserSurface, agentGuard, safeMode, recovery);
  runtime.host = host.host;
  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_gone, detail) => {
      logElectronError('electron.renderer.gone', detail.reason + ' (exit ' + detail.exitCode + ')');
    });
    contents.on('preload-error', (_failed, _path, error) => logElectronError('electron.preload', error));
    contents.on('did-fail-load', (_failed, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) logElectronError('electron.window.load', description);
    });
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') logElectronError('electron.child.gone', details.type + ': ' + details.reason + ' (exit ' + details.exitCode + ')');
    if (details.type === 'Utility' && details.name === HOST_SERVICE_NAME) host.host.processGone(details);
  });
  const windowIcon = defaultWindowIcon(platform, join(import.meta.dirname, 'resources', 'icons'));
  if (windowIcon !== undefined) app.on('browser-window-created', (_event, window) => window.setIcon(windowIcon));
  runtime.windows = createWindowManager(runtime, appBase, preloadPath, lifecycle);

  installSessionHandlers(runtime, scopes, windowOrigin, pluginUi, options.openExternal ?? ((url) => shell.openExternal(url)));
  wireRendererIpc({
    platform,
    ipc: ipcMain,
    runtime,
    fsRuntime: scopes.fsRuntime,
    assetScope: scopes.assetScope,
    stopWindowDrag,
    log,
  });
  const migrationEnv: WebviewMigrationEnv = {
    platform,
    identifier: config.identifier,
    appDataDir: scopes.appDataDir,
    osDirs: scopes.osDirs,
    userDataDir,
    devUrl: process.env.DS_ELECTRON_DEV_URL,
    log,
  };
  let migration: ActiveWebviewMigration | null = null;
  wireWebviewMigrationIpc(ipcMain, () => migration);
  installMenu(process.platform, config.version, (event) => runtime.emitJs(event, 'null', null));
  lifecycle.install();

  // Linux 上 Tauri 的 WebView 目录就是 app data 根，Host 启动恢复会移动它，快照必须在 Host 启动之前完成。
  const prompt = options.migrationPrompt ?? migrationDialogPrompt(config.productName);
  const prepared = await prepareMigration(migrationEnv, prompt);
  if (prepared === null) {
    processHooks.exit(0);
    return;
  }

  if (!existsSync(host.entry)) runtime.host.markUnavailable(`Desktop Host entry not found: ${host.entry}`);
  else if (recovery.mayStartHost()) runtime.host.start();
  else runtime.host.markUnavailable('startup recovery required; Host not started');
  if (prepared.status === 'pending') {
    migration = startWebviewMigration({
      appBase,
      appUrl: config.windows[0]?.url,
      entries: prepared.entries,
      prompt,
      openMainWindow: (url) => openMainWindow(runtime, url),
      flushStorage: () => session.defaultSession.flushStorageData(),
      exit: () => processHooks.exit(0),
      beforeComplete: options.beforeMigrationComplete ?? (() => undefined),
      userDataDir,
      log,
    });
  } else openMainWindow(runtime);
}

/**
 * main 以 `main` 窗口身份调用 Host 命令（`plugin:ui|manifest` 等内核命令）。
 * 成功返回 Host 的 JSON 值；失败以 Error 形式拒绝，协议处理方转成 503。
 */
function invokeHostCommand(runtime: ShellRuntime, cmd: string, args: unknown): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    runtime.host.invoke(
      { cmd, args, source: { window: 'main', webview: 'main' } },
      {
        webview: 'main',
        resolve: (result) => {
          if (result.ok) {
            resolve(result.value);
            return;
          }
          const error = result.error;
          reject(new Error(typeof error === 'string' ? error : error === undefined ? 'Host command failed' : JSON.stringify(error)));
        },
      },
    );
  });
}
