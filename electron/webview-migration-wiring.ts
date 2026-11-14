/**
 * Tauri 版 localStorage 迁移在 main 的装配（DESIGN.md §8.2）：Host 启动前准备快照（第 1、2 步），首个主窗口先加载空白迁移页，
 * 写入、flush、读回与落盘确认、标记完成之后才加载应用入口（第 3、4 步）。
 */
import { join } from 'node:path';
import { dialog, type IpcMain, type IpcMainEvent } from 'electron';
import {
  completeWebviewMigration,
  prepareWebviewMigration,
  WEBVIEW_MIGRATION_APPLIED_CHANNEL,
  WEBVIEW_MIGRATION_PENDING_CHANNEL,
  WEBVIEW_MIGRATION_VERIFIED_CHANNEL,
  WebviewMigrationError,
  type PreparedWebviewMigration,
} from './storage-migration/index.ts';
import { describeError } from './shell/bootstrap.ts';
import type { ShellOsDirMap } from './shell/os-dirs.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';
import {
  prepareWebviewMigrationGate,
  waitForPersistedLocalStorage,
  WEBVIEW_MIGRATION_PAGE_PATH,
  WebviewMigrationApplier,
  type MigrationPrompt,
} from './shell/webview-migration.ts';
import type { ShellWindow } from './shell/windows.ts';

export interface WebviewMigrationEnv {
  platform: ShellPlatform;
  identifier: string;
  appDataDir: string;
  osDirs: Pick<ShellOsDirMap, 'home' | 'dataLocal'>;
  /** Electron userData：目标 `Local Storage/leveldb` 与迁移状态文件所在目录。 */
  userDataDir: string;
  /** `DS_ELECTRON_DEV_URL`。 */
  devUrl: string | undefined;
  log(message: string): void;
}

/** 迁移进行中：preload 的同步 IPC 只对迁移页回条目、收报告。 */
export interface ActiveWebviewMigration {
  applier: WebviewMigrationApplier;
  isPage(event: IpcMainEvent): boolean;
}

/** 迁移失败时的“重试 / 退出”对话框。 */
export function migrationDialogPrompt(productName: string): MigrationPrompt {
  return async (message, detail) => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: productName,
      message,
      detail,
      buttons: ['重试', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return response === 0 ? 'retry' : 'exit';
  };
}

/**
 * Host 启动前准备迁移；返回 `null` 表示用户选择退出。
 * 开发服务器模式不迁移：页面 origin 不是 Tauri 版的 `tauri://localhost`，写进去再标记完成会让正式入口永远拿不到旧数据。
 */
export async function prepareMigration(env: WebviewMigrationEnv, prompt: MigrationPrompt): Promise<PreparedWebviewMigration | null> {
  const { log } = env;
  if (env.devUrl) {
    log('[webview-migration] dev server origin is not the Tauri origin; migration not attempted and its state left untouched');
    return { status: 'done' };
  }
  const { home, dataLocal } = env.osDirs;
  return prepareWebviewMigrationGate({
    prepare: async () => {
      if (home === null || dataLocal === null) {
        throw new WebviewMigrationError('SOURCE_UNREADABLE', `无法解析 home（${String(home)}）或 data_local_dir（${String(dataLocal)}）`);
      }
      return prepareWebviewMigration({
        platform: env.platform,
        homeDir: home,
        dataLocalDir: dataLocal,
        appDataDir: env.appDataDir,
        identifier: env.identifier,
        userDataDir: env.userDataDir,
        log,
      });
    },
    prompt,
    log,
  });
}

/** preload 领取 / 回报迁移条目的同步 IPC。没有迁移进行时一律回 `'null'`（preload 每个文档都会问一次）。 */
export function wireWebviewMigrationIpc(ipc: Pick<IpcMain, 'on'>, current: () => ActiveWebviewMigration | null): void {
  ipc.on(WEBVIEW_MIGRATION_PENDING_CHANNEL, (event) => {
    const migration = current();
    event.returnValue = migration === null ? 'null' : migration.applier.pending(migration.isPage(event));
  });
  ipc.on(WEBVIEW_MIGRATION_APPLIED_CHANNEL, (event, report: unknown) => {
    event.returnValue = null;
    const migration = current();
    migration?.applier.applied(migration.isPage(event), report);
  });
  ipc.on(WEBVIEW_MIGRATION_VERIFIED_CHANNEL, (event, report: unknown) => {
    event.returnValue = null;
    const migration = current();
    migration?.applier.verified(migration.isPage(event), report);
  });
}

export interface StartWebviewMigrationOptions extends Pick<WebviewMigrationEnv, 'userDataDir' | 'log'> {
  /** 应用页面的基础 URL（迁移页与应用入口都相对它）。 */
  appBase: string;
  /** 主窗口配置的入口（`url`，缺省 `index.html`）。 */
  appUrl: string | undefined;
  entries: ReadonlyArray<readonly [string, string]>;
  prompt: MigrationPrompt;
  /** 以 `url` 作为首次加载地址建主窗口，其余窗口配置不变。 */
  openMainWindow(url: string): ShellWindow;
  /** Electron 的 `flushStorageData()`：同步返回、只是把 DOMStorage 写盘任务排进队列，没有完成回调。 */
  flushStorage(): void;
  exit(): void;
  /** 仅测试：读回与落盘确认通过之后、写 `done` 之前调用。 */
  beforeComplete(): void;
}

/** 首个主窗口先加载空白迁移页；写入、flush、标记完成之后才加载应用入口。 */
export function startWebviewMigration(options: StartWebviewMigrationOptions): ActiveWebviewMigration {
  const { appBase, log } = options;
  const pageUrl = new URL(WEBVIEW_MIGRATION_PAGE_PATH, appBase).href;
  const appUrl = new URL(options.appUrl ?? 'index.html', appBase).href;
  let main: ShellWindow | null = null;
  const load = (url: string) => {
    if (main === null || main.browserWindow.isDestroyed()) return;
    void main.browserWindow.loadURL(url).catch((error: unknown) => log(`[window ${main?.label}] failed to load ${url}: ${describeError(error)}`));
  };
  const applier = new WebviewMigrationApplier({
    entries: options.entries,
    prompt: options.prompt,
    flush: async () => { options.flushStorage(); },
    confirmPersisted: (expected) => {
      const base = new URL(appBase);
      return waitForPersistedLocalStorage({
        dir: join(options.userDataDir, 'Local Storage', 'leveldb'),
        // 自定义 scheme 的 WHATWG `URL.origin` 是 "null"；Chromium 对已注册为 standard 的 scheme 记作 `tauri://localhost`。
        origin: `${base.protocol}//${base.host}`,
        expected,
      });
    },
    complete: (report) => {
      options.beforeComplete();
      completeWebviewMigration({ userDataDir: options.userDataDir, log }, report);
    },
    loadMigrationPage: () => {
      if (main !== null) {
        load(pageUrl);
        return;
      }
      const created = options.openMainWindow(pageUrl);
      main = created;
      created.webContents.on('did-finish-load', () => applier.pageLoaded(created.webContents.getURL() === pageUrl));
      created.webContents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
        if (isMainFrame && url === pageUrl) applier.pageLoaded(true);
      });
    },
    loadApp: () => load(appUrl),
    exit: options.exit,
    log,
  });
  const isPage = (event: IpcMainEvent) =>
    main !== null && event.sender === main.webContents && event.senderFrame?.url === pageUrl;
  applier.start();
  return { applier, isPage };
}
