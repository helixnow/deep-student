/**
 * 后端 Sentry：`init_backend_sentry_client` / `set_backend_sentry_enabled`（src-tauri/src/lib.rs:291-363）、
 * 启动读授权（lib.rs:1322-1335），以及 crash_logger.rs:40-61 panic hook 里的上报。
 *
 * 跑在 Host 进程（`dstu.shell` 插件）：Rust 后端的命令与业务代码都在这里，授权开关命令与启动读授权也在这里。
 * Rust 关掉默认集成（`default_integrations: false`），只显式上报 panic（Fatal）与 tokio 饥饿（anr_watchdog）。
 * Host 里对应 panic 的是没有人处理的异常：`uncaughtExceptionMonitor`（随后 Host 退出）与 `unhandledRejection`
 * （Host 继续运行，同 tokio 任务里 panic 后进程照常运行）。anr_watchdog 没有移植到 Host，没有对应的上报。
 */
import { createRequire } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError } from '../host/kernel/api.ts';
import { scrubPii } from '../host/platform/log/redact.ts';

export const BACKEND_SENTRY_SETTING = 'sentry_error_reporting_enabled';

/** sentry-rust `ClientOptions::shutdown_timeout` 的默认值，crash_logger 的 flush 也等 2 s。 */
const FLUSH_TIMEOUT_MS = 2000;
/** Host 关停时每个插件的 dispose 上限是 1500 ms（W01），给 flush 留 1000 ms。 */
const DISPOSE_FLUSH_TIMEOUT_MS = 1000;

export type CrashOrigin = 'uncaughtException' | 'unhandledRejection';

/** crash_logger.rs:51-57 的 `Event { message, level: Fatal, fingerprint }`；release 由客户端选项带上。 */
export interface CrashEvent {
  message: string;
  level: 'fatal';
  fingerprint: [string, string];
}

/** Rust `ClientInitGuard`：存在即已启用。 */
export interface SentryGuard {
  capture(event: CrashEvent): void;
  close(timeoutMs: number): void | Promise<void>;
}

export type SentryLog = (level: 'info' | 'warn', message: string) => void;

export interface BackendSentryDeps {
  settings: { save(key: string, value: string): void };
  log: SentryLog;
  /** 返回 null 表示 DSN 缺失/非法或 SDK 不可用（Rust 同样保持 disabled）。 */
  init(): Promise<SentryGuard | null> | SentryGuard | null;
  /** `scrub_pii` 的路径规则按平台（`cfg!(windows)`）。 */
  platform: string;
  /** 栈帧路径按它取相对路径：指纹不随安装位置变化，也不带用户目录。 */
  appRoot: string;
}

export interface BackendSentry {
  setEnabled(enabled: boolean): Promise<boolean>;
  /**
   * 启动时按已保存的授权初始化（Rust setup，src-tauri/src/lib.rs:1322-1332）：值为 `"true"` 才初始化，读取失败按未授权，
   * 不写回设置。返回是否已启用。
   */
  restore(read: () => string | null): Promise<boolean>;
  /** panic hook 的上报：未启用时什么也不做。同步执行，`uncaughtExceptionMonitor` 之后 Host 马上退出。 */
  captureCrash(error: unknown, origin: CrashOrigin): void;
  /** 插件卸载（Host 退出）：Rust 进程退出时 drop `ClientInitGuard`，先 flush 再关。 */
  dispose(): Promise<void>;
}

export function createBackendSentry(deps: BackendSentryDeps): BackendSentry {
  let guard: SentryGuard | null = null;
  // Rust 在 spawn_blocking 内持有 `Mutex<Option<ClientInitGuard>>`；Host 命令可并发 invoke，
  // 用 promise 串行链复刻同一把锁的临界区。
  let serial = Promise.resolve();
  const closeGuard = async (timeoutMs: number) => {
    const previous = guard;
    guard = null;
    try {
      await previous?.close(timeoutMs);
    } catch (error) {
      // Rust `drop(previous)` 不能失败；关闭异常只记录，不改变返回值。
      deps.log('warn', `[Sentry] backend error reporting close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const persist = (enabled: boolean): void => {
    try {
      deps.settings.save(BACKEND_SENTRY_SETTING, String(enabled));
    } catch (error) {
      throw new CommandError(`保存错误报告授权失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const set = async (enabled: boolean): Promise<boolean> => {
    persist(enabled);
    if (!enabled) {
      await closeGuard(FLUSH_TIMEOUT_MS);
      deps.log('info', '[Sentry] backend error reporting disabled');
      return false;
    }
    if (guard === null) {
      try {
        guard = await deps.init();
      } catch (error) {
        deps.log('warn', `[Sentry] backend SDK initialization failed; error reporting remains disabled: ${error instanceof Error ? error.message : String(error)}`);
        guard = null;
      }
    }
    if (guard !== null) return true;
    // init 返回 null / 抛错时不能把授权留在 'true'，否则下次启动会误以为已启用。
    try {
      persist(false);
    } catch (error) {
      deps.log('warn', `[Sentry] could not roll back backend error reporting consent: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  };
  const restore = async (read: () => string | null): Promise<boolean> => {
    let consented: boolean;
    try {
      consented = read() === 'true';
    } catch {
      consented = false;
    }
    if (consented && guard === null) guard = await deps.init();
    return guard !== null;
  };
  const locked = <T>(task: () => Promise<T>): Promise<T> => {
    const result = serial.then(task);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    setEnabled: (enabled) => locked(() => set(enabled)),
    restore: (read) => locked(() => restore(read)),
    captureCrash(error, origin) {
      if (guard === null) return;
      try {
        guard.capture(crashEvent(error, origin, deps));
      } catch (error) {
        // panic hook 里的上报包在 catch_unwind 中，失败不影响原有的崩溃处理。
        deps.log('warn', `[Sentry] backend crash report failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    dispose: () => locked(() => closeGuard(DISPOSE_FLUSH_TIMEOUT_MS)),
  };
}

type CrashEmitter = Pick<NodeJS.EventEmitter, 'on' | 'off'>;

/** 把 Host 进程的未处理异常接到 {@link BackendSentry.captureCrash}；返回撤销函数。 */
export function installCrashCapture(sentry: Pick<BackendSentry, 'captureCrash'>, proc: CrashEmitter = process): () => void {
  const onException = (error: unknown) => sentry.captureCrash(error, 'uncaughtException');
  const onRejection = (reason: unknown) => sentry.captureCrash(reason, 'unhandledRejection');
  proc.on('uncaughtExceptionMonitor', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtExceptionMonitor', onException);
    proc.off('unhandledRejection', onRejection);
  };
}

const STACK_FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;

/**
 * crash_logger.rs:41-57：消息是 `PanicHookInfo` 的 Display（`panicked at <file>:<line>:<col>:\n<payload>`）经
 * `scrub_pii`，指纹是 `["rust-panic", "<file>:<line>"]`。这里取异常栈的第一帧，应用内的文件写成相对应用根的路径
 * （Rust 的 `loc.file()` 同样是源码相对路径）。
 */
export function crashEvent(error: unknown, origin: CrashOrigin, where: { platform: string; appRoot: string }): CrashEvent {
  let frame: { file: string; line: string; column: string } | null = null;
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  for (const line of stack.split('\n').slice(1)) {
    const match = STACK_FRAME.exec(line);
    if (match) {
      frame = { file: appRelative(match[1]!, where.appRoot), line: match[2]!, column: match[3]! };
      break;
    }
  }
  const what = origin === 'uncaughtException' ? 'uncaught exception' : 'unhandled rejection';
  const at = frame === null ? '' : ` at ${frame.file}:${frame.line}:${frame.column}`;
  const location = frame === null ? 'unknown' : `${frame.file}:${frame.line}`;
  return {
    message: scrubPii(`${what}${at}:\n${describe(error)}`, where.platform),
    level: 'fatal',
    fingerprint: [origin === 'uncaughtException' ? 'host-uncaught-exception' : 'host-unhandled-rejection', scrubPii(location, where.platform)],
  };
}

function appRelative(file: string, appRoot: string): string {
  let path = file;
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path); } catch { return file; }
  }
  if (!path.startsWith(appRoot + sep)) return path;
  return relative(appRoot, path).split(sep).join('/');
}

function describe(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * `sentry::types::Dsn::from_str`（sentry-types-0.32.3/src/dsn.rs:163-213）：
 * URL 可解析 → scheme 为 http/https → username（public key）非空 → host 存在 →
 * path 不是 `/`（项目 ID 非空）。Rust 用 `?` 把任一失败都归到同一条 invalid 日志。
 */
export function isSentryDsn(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username === '') return false;
  if (url.hostname === '') return false;
  if (url.pathname === '/' || url.pathname === '') return false;
  // ProjectId::from_str：trim('/') 后最后一段必须非空。
  const projectId = url.pathname.replace(/^\/+|\/+$/g, '').split('/').pop() ?? '';
  return projectId !== '';
}

interface SentryNodeClient {
  getDsn(): unknown;
  captureEvent(event: CrashEvent): unknown;
  flush(timeout?: number): PromiseLike<boolean>;
  close(timeout?: number): PromiseLike<boolean>;
}

/** 用到的 `@sentry/node` 接口。 */
export interface SentryNodeSdk {
  init(options: Record<string, unknown>): SentryNodeClient | undefined;
  getCurrentScope(): { getClient(): unknown; setClient(client: undefined): void };
}

export interface BackendSentryInitOptions {
  log: SentryLog;
  /** Rust `env!("SENTRY_RELEASE")`（build-info.ts `sentryRelease`）。 */
  release: string;
  /** `cfg!(debug_assertions)`：sentry-rust `apply_defaults` 在没有 `SENTRY_ENVIRONMENT` 时据此取 environment。 */
  debug: boolean;
  /** 打包时写入的 DSN（Rust `option_env!("SENTRY_DSN")`，build-info.ts `bundledSentryDsn`）。 */
  bundledDsn: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  loadSdk?: () => SentryNodeSdk;
  /** 只给测试：替换 HTTP 发送（`@sentry/node` 的 `transport` 选项）。 */
  transport?: unknown;
}

const loadSentry = (): SentryNodeSdk => createRequire(import.meta.url)('@sentry/node') as SentryNodeSdk;

/** Rust `init_backend_sentry_client`：DSN 缺失/非法返回 None，合法时初始化 SDK 并绑定为当前客户端。 */
export function defaultSentryInit(options: BackendSentryInitOptions): () => SentryGuard | null {
  const { log } = options;
  return () => {
    const env = options.env ?? process.env;
    // `std::env::var("SENTRY_DSN").ok().or_else(|| option_env!("SENTRY_DSN"))`：运行时变量存在（哪怕是空串）就不再看构建时的值。
    const configured = env.SENTRY_DSN ?? options.bundledDsn;
    if (configured === undefined || configured.trim() === '') {
      log('warn', '[Sentry] user consent is enabled, but backend DSN is not configured');
      return null;
    }
    const dsn = configured.trim();
    if (!isSentryDsn(dsn)) {
      log('warn', '[Sentry] backend DSN is invalid; error reporting remains disabled');
      return null;
    }
    let sdk: SentryNodeSdk;
    let client: SentryNodeClient | undefined;
    try {
      sdk = (options.loadSdk ?? loadSentry)();
      // RUST-FIX(RF-W06-backend-sentry-rust-no-transport): Rust 的 sentry crate 没编进任何 transport，有 DSN 时 sentry::init 直接 panic；
      // @sentry/node 自带 HTTP transport，这里真正发送。
      client = sdk.init({
        dsn,
        release: options.release,
        environment: env.SENTRY_ENVIRONMENT ?? (options.debug ? 'development' : 'production'),
        sendDefaultPii: false,
        // Rust 只显式上报 panic/ANR：不装任何默认集成，也不要它们隐含的会话、客户端报告、OpenTelemetry 与 Spotlight。
        defaultIntegrations: false,
        autoSessionTracking: false,
        sendClientReports: false,
        skipOpenTelemetrySetup: true,
        registerEsmLoaderHooks: false,
        spotlight: false,
        // sentry-rust 的 server_name 只由 ContextIntegration（默认集成）填写；Node 客户端默认取主机名。
        beforeSend: (event: { server_name?: string }) => {
          delete event.server_name;
          return event;
        },
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      });
    } catch (error) {
      // Rust `sentry::init` 不会失败；JS SDK 加载或初始化抛错时按"尽力而为 + warn"处理，不能让授权开关本身失败。
      log('warn', `[Sentry] backend SDK initialization failed; error reporting remains disabled: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (client === undefined) return null;
    const active = client;
    const unbind = () => {
      if (sdk.getCurrentScope().getClient() === active) sdk.getCurrentScope().setClient(undefined);
    };
    if (active.getDsn() === undefined) {
      // Dsn::from_str 接受、JS SDK 却解析不了的 DSN（客户端会静默丢弃事件）：按 Rust 的 invalid 分支处理。
      unbind();
      void active.close(0);
      log('warn', '[Sentry] backend DSN is invalid; error reporting remains disabled');
      return null;
    }
    log('info', '[Sentry] backend error reporting enabled by user consent');
    return {
      capture(event) {
        active.captureEvent(event);
        void active.flush(FLUSH_TIMEOUT_MS);
      },
      async close(timeoutMs) {
        // `Hub::main().bind_client(None)` 后 drop guard（flush 后关闭）。
        unbind();
        await active.close(timeoutMs);
      },
    };
  };
}
