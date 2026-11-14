/**
 * 进程生命周期：有序退出、关闭主窗口时的后台驻留、第二实例唤回、显式退出与最后一个窗口关闭。对应 Rust：
 * - `src-tauri/src/lib.rs:1714-1783` 主窗口 `CloseRequested`（判定与动作在 W23 的 `shell/background-residency.ts`）；
 * - `lib.rs:3249-3268` `ExitRequested`：先 `mark_automation_app_exiting()`，再关停插件与后台任务；
 * - `lib.rs:3270-3285` macOS `Reopen`；`lib.rs:695-701` single-instance 回调。
 */
import {
  BackgroundResidency,
  countShownWindows,
  queryResidencyState,
  type HostInvoke,
  type ResidencyMainWindow,
  type ResidencyPowerMonitor,
} from './shell/background-residency.ts';
import { HOST_QUIT_DEADLINE_MS } from './shell/host.ts';
import type { NotificationHooks, ProcessHooks } from './shell/plugins/system.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';

/** Fits inside the existing absolute quit deadline, leaving the Host its shutdown budget. */
export const SNAPSHOT_QUIT_BUDGET_MS = 2_000;
interface SnapshotWindow {
  isDestroyed(): boolean;
  webContents?: { executeJavaScript(script: string): Promise<unknown> };
}
const FLUSH_SNAPSHOT_SCRIPT = `(async () => {
  const detail = { pending: [] };
  window.dispatchEvent(new CustomEvent('workbench:before-quit', { detail }));
  await Promise.all(Array.isArray(detail.pending) ? detail.pending : [detail.pending]);
})()`;

/** 用到的 `app` 方法与事件（Electron `App` 满足）。 */
export interface LifecycleApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  on(event: 'second-instance' | 'window-all-closed' | 'activate', listener: () => void): unknown;
  focus(options?: { steal: boolean }): void;
  relaunch(): void;
  exit(exitCode?: number): void;
}

export interface AppLifecycleOptions {
  /** Synchronous ledger finalization before every ordered exit, including the hard deadline. */
  beforeExit?(): void;
  platform: ShellPlatform;
  app: LifecycleApp;
  /** Electron 只允许在 `app.whenReady()` 之后访问，{@link AppLifecycle.install} 之前不会用到。 */
  powerMonitor: ResidencyPowerMonitor;
  /** main 以 `main` 窗口身份调用 Host 命令，用于询问驻留条件。 */
  invokeHost: HostInvoke;
  /** Host 有序关停（`HostSupervisor.shutdown`）。 */
  shutdownHost(): Promise<void>;
  /** 到退出上限 Host 仍没退出时强制结束它（`HostSupervisor.forceKill`）。 */
  killHost(): void;
  /** 缺省 {@link HOST_QUIT_DEADLINE_MS}。 */
  quitDeadlineMs?: number;
  /** 当前全部窗口（`BrowserWindow.getAllWindows()`），用于判断主窗口关闭后是否只剩隐藏窗口。 */
  allWindows(): Iterable<SnapshotWindow & { isVisible(): boolean; isMinimized(): boolean }>;
  log(message: string): void;
  /** 缺省为 Electron Notification。 */
  notification?: NotificationHooks;
  residencyQueryTimeoutMs?: number;
}

export interface AppLifecycle {
  /** 有序退出：先让 Host 关停，再 `app.exit`（重启时先 `app.relaunch()`）；重复请求只生效一次。 */
  quit(code: number): void;
  isQuitting(): boolean;
  /** `process` 插件的 exit / restart。 */
  readonly processHooks: ProcessHooks;
  readonly residency: BackgroundResidency;
  /** WindowManager 的 `afterCreate`：此时它自己的 `close` 监听已注册，主窗口在其后挂上驻留判定。 */
  windowCreated(win: ResidencyMainWindow & { readonly label: string; readonly browserWindow: SnapshotWindow }): void;
  /** app 级事件，须在 `app.whenReady()` 之后调用。 */
  install(): void;
}

export function createAppLifecycle(options: AppLifecycleOptions): AppLifecycle {
  const { app, log } = options;
  let quitting = false;
  let restartRequested = false;

  const residency = new BackgroundResidency({
    platform: options.platform,
    queryState: () => queryResidencyState(options.invokeHost, log),
    quit: () => quit(0),
    log,
    shownWindowCount: () => countShownWindows(options.allWindows()),
    ...(options.notification === undefined ? {} : { notification: options.notification }),
    ...(options.residencyQueryTimeoutMs === undefined ? {} : { queryTimeoutMs: options.residencyQueryTimeoutMs }),
  });

  async function flushWindows(windows: Iterable<SnapshotWindow>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(Array.from(windows, async (win) => {
          try {
            if (!win.isDestroyed()) await win.webContents?.executeJavaScript(FLUSH_SNAPSHOT_SCRIPT);
          } catch (error) {
            // One closing auxiliary renderer must not short-circuit the main save.
            log(`[lifecycle] snapshot flush failed: ${String(error)}`);
          }
        })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('snapshot flush timed out')), SNAPSHOT_QUIT_BUDGET_MS);
        }),
      ]);
    } catch (error) {
      log(`[lifecycle] snapshot flush failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function quit(code: number): void {
    if (quitting) return;
    quitting = true;
    // ExitRequested 先标记退出（lib.rs:3250-3251）：此后主窗口的关闭不再拦截，尚未执行的驻留判定作废。
    residency.markExiting();
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      clearTimeout(deadline);
      options.beforeExit?.();
      if (restartRequested) app.relaunch();
      app.exit(code);
    };
    // RUST-FIX(RF-W06-quit-hard-deadline): before-quit 一律拦下，Host 关停卡住时用户再按退出也没用，这里兜底。
    const deadlineMs = options.quitDeadlineMs ?? HOST_QUIT_DEADLINE_MS;
    const deadline = setTimeout(() => {
      log(`[lifecycle] Host shutdown did not finish within ${deadlineMs}ms, exiting anyway`);
      options.killHost();
      exit();
    }, deadlineMs);
    void flushWindows(options.allWindows()).then(() => {
      if (!exited) return options.shutdownHost();
    }).catch((error) => log(`[lifecycle] shutdown failed: ${String(error)}`)).finally(exit);
  }

  return {
    quit,
    isQuitting: () => quitting,
    processHooks: {
      exit: (code) => quit(code),
      restart: () => {
        restartRequested = true;
        quit(0);
      },
    },
    residency,
    windowCreated: (win) => {
      if (win.label !== 'main') return;
      residency.attachMainWindow(win);
      let flushingClose = false;
      let flushedClose = false;
      // Runs after residency: only a released close (not a hide or page-owned close)
      // needs to wait. Keep the renderer alive during explicit quit as well.
      win.browserWindow.on('close', (event) => {
        if (quitting) { event.preventDefault(); return; }
        if (!win.destroying || flushedClose) return;
        event.preventDefault();
        if (flushingClose) return;
        flushingClose = true;
        void flushWindows([win.browserWindow]).then(() => {
          flushedClose = true;
          if (!quitting && !win.browserWindow.isDestroyed()) win.browserWindow.close();
          flushedClose = false;
          flushingClose = false;
        });
      });
    },
    install: () => {
      app.on('second-instance', () => residency.showFromSecondInstance());
      // before-quit、关机（powerMonitor / Windows session-end）标记退出；macOS activate 即 Reopen。
      residency.install(app, options.powerMonitor);
      // 关停进行中再次 quit（连按 Cmd+Q）也要拦下：放行的话 Electron 会自己结束进程，打断 Host 关停。
      // Rust 在 ExitRequested 回调里同步等关停完成（lib.rs:3256-3267），期间不会处理第二次退出。
      app.on('before-quit', (event) => {
        event.preventDefault();
        quit(0);
      });
      // Tauri：最后一个窗口关闭时退出事件循环（所有平台）。
      app.on('window-all-closed', () => quit(0));
    },
  };
}
