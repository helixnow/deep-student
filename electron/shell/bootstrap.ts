/**
 * main 进程启动兜底。
 *
 * 启动在拿到单实例锁之后进行；启动失败若既不提示也不退出，进程会一直持有锁，用户之后每次启动都会
 * 被当成第二实例直接退出。这里统一：失败时写日志、弹出错误框、`app.exit(1)`。
 *
 * 单实例锁之前先识别 Windows 本地 shell 沙箱 helper 的自调用（Rust `src-tauri/src/main.rs`：
 * `shell_sandbox::maybe_run_helper()` 先于 `run()`）。
 */
import type { ShellPlatform } from './tauri-config.ts';

/** 与 `host/plugins/agent-workspace/src/tools/shell-sandbox-windows.ts` 的 `HELPER_ARG` 相同。 */
export const SHELL_SANDBOX_HELPER_ARG = '--deep-student-shell-sandbox-helper';
/** helper 失败的退出码（Rust `maybe_run_helper`：把原因写到 stderr 后返回 126）。 */
export const SHELL_SANDBOX_HELPER_FAILURE_CODE = 126;
export const SHELL_SANDBOX_HELPER_UNAVAILABLE =
  'Windows local shell sandbox failed: the AppContainer helper requires the F7 native runtime, which this Electron shell does not provide';
/** macOS / Linux 的本地 shell 沙箱不自调用应用，这个开关只会被手工传入。 */
export const SHELL_SANDBOX_HELPER_WINDOWS_ONLY =
  `${SHELL_SANDBOX_HELPER_ARG} is the internal Windows shell sandbox helper flag; the app is not started`;

/** 启动参数：`process.argv`、`process.defaultApp`（开发态 `electron main.ts …` 时 argv[1] 是脚本路径）。 */
export interface LaunchArguments {
  argv: readonly string[];
  defaultApp: boolean;
  platform: ShellPlatform;
  /** helper 自调用的拒绝原因写到这里（Host 经管道读取 helper 的 stderr）；回调在写完后调用。 */
  stderr: { write(text: string, callback: (error?: Error | null) => void): unknown };
}

/**
 * Rust `maybe_run_helper` 只看 `args().nth(1)`。返回 Rust 形状的 argv（`[可执行文件, 开关, payload…]`，开发态去掉脚本路径），
 * 不是 helper 调用时返回 null。
 */
export function shellSandboxHelperArgv(launch: Pick<LaunchArguments, 'argv' | 'defaultApp'>): string[] | null {
  // RUST-FIX(RF-W06-shell-sandbox-helper-flag-all-platforms): Rust 只在 Windows 拦截，macOS/Linux 带这个内部开关会照常启动应用（或唤起已运行的实例）。
  const [executable = '', ...rest] = launch.argv;
  const appArgs = launch.defaultApp ? rest.slice(1) : rest;
  return appArgs[0] === SHELL_SANDBOX_HELPER_ARG ? [executable, ...appArgs] : null;
}

export interface BootstrapApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<unknown>;
  exit(code: number): void;
}

export interface BootstrapDialog {
  showErrorBox(title: string, content: string): void;
}

export interface RunAppOptions {
  app: BootstrapApp;
  dialog: BootstrapDialog;
  launch: LaunchArguments;
  start(): Promise<void>;
  log(message: string): void;
  productName: string;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * 沙箱 helper 自调用：不申请单实例锁（否则已运行的实例会收到 second-instance 并唤起主窗口）、不启动应用，
 * 写明原因后以 {@link SHELL_SANDBOX_HELPER_FAILURE_CODE} 退出。原生 helper（F7）接入前一律拒绝。
 * 第二实例直接退出；首个实例在 ready 后启动，失败时提示并以退出码 1 结束进程（释放单实例锁）。
 */
export function runApp(options: RunAppOptions): Promise<void> {
  const { app, dialog, log } = options;
  if (shellSandboxHelperArgv(options.launch) !== null) {
    return new Promise<void>((resolve) => {
      const exit = () => {
        app.exit(SHELL_SANDBOX_HELPER_FAILURE_CODE);
        resolve();
      };
      try {
        const reason = options.launch.platform === 'win32' ? SHELL_SANDBOX_HELPER_UNAVAILABLE : SHELL_SANDBOX_HELPER_WINDOWS_ONLY;
        options.launch.stderr.write(`${reason}\n`, exit);
      } catch {
        exit();
      }
    });
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return Promise.resolve();
  }
  return app
    .whenReady()
    .then(() => options.start())
    .catch((error: unknown) => {
      const detail = describeError(error);
      try {
        log(`[startup] failed: ${detail}`);
        dialog.showErrorBox(`${options.productName} failed to start`, detail);
      } catch (reportError) {
        log(`[startup] cannot show the error box: ${describeError(reportError)}`);
      } finally {
        app.exit(1);
      }
    });
}

interface ProcessEvents {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtExceptionMonitor', listener: (error: unknown, origin: string) => void): unknown;
}

/**
 * 主进程未处理的 Promise 拒绝与异常写日志。异常用 `uncaughtExceptionMonitor` 只做观察：
 * 注册 `uncaughtException` 会取消 Electron 默认的“主进程 JavaScript 错误”提示框。
 */
export function installProcessErrorLogging(proc: ProcessEvents, log: (message: string) => void): void {
  proc.on('unhandledRejection', (reason) => log(`[process] unhandled rejection: ${describeError(reason)}`));
  proc.on('uncaughtExceptionMonitor', (error, origin) => log(`[process] uncaught exception (${origin}): ${describeError(error)}`));
}
