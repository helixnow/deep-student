/**
 * Desktop Host 进程托管：`utilityProcess.fork(host/kernel/main.ts)`（Node 24 类型剥离直接运行 .ts），
 * 经 `MessageChannelMain` 建立 MessagePort 连接，按 host/kernel/protocol.ts 收发消息。
 *
 * 端口交付约定：fork 后 main 通过 `child.postMessage({ kind: 'connect', protocol }, [port])`
 * 把端口交给 Host（Host 侧 `process.parentPort.on('message', e => e.ports[0])`），随后在端口上发送 Handshake。
 * Host 发出 `ready` 前收到的请求先排队。
 *
 * 崩溃处理：进行中的 invoke 以错误结束、流式协议响应中止；60 秒内最多自动重启 3 次，超过后停止重启并
 * 通过 `onUnavailable` 报告（invoke 继续以错误返回，外壳不退出）。
 */
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STARTUP_READY_WAIT } from '../api.ts';
import { BrowserBridgeError } from './browser-protocol.ts';
import { describeHostGone, OutputTail } from './host-output.ts';
import {
  HOST_PROTOCOL_VERSION,
  type Handshake,
  type HostToMain,
  type InvokeRequest,
  type MainToHost,
  type ProtocolChunk,
  type ProtocolResponse,
  type ShellRequest,
  type ShellResponse,
  type BackendEvent,
} from '../../host/kernel/protocol.ts';

/** protocol.ts 增补的有序退出请求（`{ kind: 'shutdown' }`）。 */
interface ShutdownMessage {
  kind: 'shutdown';
}

type Outgoing = MainToHost | ShellResponse | ShutdownMessage;

export interface PendingInvoke {
  resolve(result: { ok: true; value: unknown; json?: string } | { ok: false; error: unknown; json?: string; diagnosticId?: string }): void;
  webview: string;
}

export interface ProtocolSink {
  head(response: ProtocolResponse): void;
  chunk(chunk: ProtocolChunk): void;
  fail(message: string): void;
}

export interface HostOptions {
  entry: string;
  /** 传给 Host 进程的额外参数（如 `--profile=<path>`）。 */
  args: string[];
  handshake: Omit<Handshake, 'kind' | 'protocol'>;
  onEvent(event: BackendEvent): void;
  onShellRequest(request: ShellRequest): Promise<unknown>;
  onUnavailable(reason: string): void;
  /** 每次 Host 进程退出（含异常与有序退出）；Host 插件的内存状态随之失效。 */
  onProcessExit?(): void;
  // RUST-FIX(RF-W06-startup-recovery): 每次启动尝试与未就绪退出交给 shell 侧台账。
  onStartAttempt?(): void;
  /**
   * Host 自行退出（非有序 shutdown）。`ready` 表示本次进程是否已发过 HostReady。
   * 返回 false 时不自动重启（原生启动恢复接管），请求以 unavailable 结束。
   */
  onUnexpectedExit?(ready: boolean): boolean;
  /**
   * Host 的 Node 编译缓存目录（`host/kernel/compile-cache.ts` 经 `NODE_COMPILE_CACHE` 读取），main 给 userData 下的目录。
   * 不给时 Node 用 `os.tmpdir()`：Linux 上 /tmp 为所有用户共享，系统清理临时目录也会让缓存失效。
   * 环境里已有 `NODE_COMPILE_CACHE`（只有开发态会保留，见 launch-env.ts）时沿用它。
   */
  compileCacheDir?: string;
  log(message: string): void;
}

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
// HostReady follows profile installation and startup migrations/finalizers, not just
// the MessagePort handshake. Allow the same slow-start budget as the startup gate.
const READY_TIMEOUT_MS = STARTUP_READY_WAIT;
/** `utilityProcess.fork` 的 serviceName；`child-process-gone` 的 `details.name` 与之相同。 */
export const HOST_SERVICE_NAME = 'Deep Student Host';
const STDERR_TAIL_BYTES = 16 * 1024;
const STDERR_DRAIN_MS = 500;
const FATAL_EXIT_GRACE_MS = 5_000;
/**
 * Host 内部关停合计 ≤ 5500 ms（`host/kernel/API.md`「关停」：在途命令 2000 ms、插件 dispose 3000 ms，其中后台任务先 abort
 * 再最多等 1000 ms，`exitSoon` 500 ms）。预算必须大于它并留出进程退出与日志落盘的余量，否则强杀会吞掉最后的日志
 * （`electron/tests/host-shutdown-budget.test.ts` 读 `host/kernel/runtime.ts` 的常量核对）。
 */
export const HOST_SHUTDOWN_BUDGET_MS = 8_000;
/**
 * 退出的绝对上限。超过 {@link HOST_SHUTDOWN_BUDGET_MS} 时 `shutdown()` 只是 `kill()`，POSIX 上是 SIGTERM，而 Host 接管了
 * SIGTERM（`host/kernel/main.ts`），卡住时不一定退出；到这个时间外壳 {@link HostSupervisor.forceKill} 后自己退出。
 */
export const HOST_QUIT_DEADLINE_MS = HOST_SHUTDOWN_BUDGET_MS + 3_000;

export class HostSupervisor {
  private readonly options: HostOptions;
  private child: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private ready = false;
  private queue: Outgoing[] = [];
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly pendingProtocols = new Map<string, ProtocolSink>();
  private restarts: number[] = [];
  private startedAt = 0;
  private isolatedUserPlugins = false;
  private stopping = false;
  private unavailableReason: string | null = null;
  private nextId = 1;
  private exitWaiters: Array<() => void> = [];
  private readonly stderrTails = new Map<UtilityProcess, { tail: OutputTail; ended: Promise<void> }>();

  constructor(options: HostOptions) {
    this.options = options;
  }

  get available(): boolean {
    return this.unavailableReason === null;
  }

  /** Recovery is session-local: the user profile is never rewritten or deleted. */
  get userPluginsIsolated(): boolean {
    return this.isolatedUserPlugins;
  }

  /** 不启动 Host（如入口不存在）：之后所有请求立即以该原因失败。 */
  markUnavailable(reason: string): void {
    this.unavailableReason = reason;
    this.options.log(`[host] ${reason}`);
  }

  newId(prefix: string): string {
    const id = `${prefix}-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  start(): void {
    this.stopping = false;
    this.startedAt = Date.now();
    this.options.onStartAttempt?.();
    // stderr 走 pipe：原样转发到 main 的 stderr（pipe() 自带背压：目标写不动时暂停读取，与 inherit 时 Host 写阻塞等价），
    // 同时保留最后一段供异常退出时写进主进程日志（日志插件装载前的失败只在这里留下文字）。
    const { compileCacheDir } = this.options;
    // Reuse the Host's official-only startup path. Unlike filtering individual
    // entries, safe mode never imports user code (including full-trust modules).
    const args = this.isolatedUserPlugins ? [...this.options.args, '--safe-mode'] : this.options.args;
    // Windows GUI apps launched from Explorer lack a console stdout handle; passing
    // 'inherit' crashes Chromium launch_win.cc with ERROR_INVALID_HANDLE (0x6).
    const child = utilityProcess.fork(this.options.entry, args, {
      serviceName: HOST_SERVICE_NAME,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(compileCacheDir === undefined || process.env.NODE_COMPILE_CACHE !== undefined
        ? {}
        : { env: { ...process.env, NODE_COMPILE_CACHE: compileCacheDir } }),
    });
    const forward = (stream: NodeJS.ReadableStream | null | undefined, target: NodeJS.WritableStream, onChunk?: (chunk: Buffer) => void) => {
      if (stream == null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stream.on('data', (chunk: Buffer) => {
          onChunk?.(chunk);
          try { target.write(chunk); } catch { /* boundary-allow empty-catch: Ignore detached GUI stdio errors */ }
        });
        stream.once('end', () => resolve());
        stream.once('close', () => resolve());
        stream.once('error', () => resolve());
      });
    };
    void forward(child.stdout, process.stdout);
    const tail = new OutputTail(STDERR_TAIL_BYTES);
    const stderrEnded = forward(child.stderr, process.stderr, (chunk) => tail.push(chunk));
    this.stderrTails.set(child, { tail, ended: stderrEnded });
    const { port1, port2 } = new MessageChannelMain();
    this.child = child;
    this.port = port1;
    this.ready = false;
    port1.on('message', (event) => this.onMessage(event.data as HostToMain));
    port1.start();
    child.postMessage({ kind: 'connect', protocol: HOST_PROTOCOL_VERSION }, [port2]);
    const handshake: Handshake = { kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, ...this.options.handshake };
    port1.postMessage(handshake);
    child.on('exit', (code) => this.onExit(child, code));
    const readyTimer = setTimeout(() => {
      if (this.child === child && !this.ready) {
        this.options.log(`[host] no ready message within ${READY_TIMEOUT_MS / 1000}s, killing`);
        if (child.pid !== undefined) {
          try { process.kill(child.pid, 'SIGKILL'); }
          catch (error) { this.options.log(`[host] failed to kill unresponsive Host: ${String(error)}`); }
        } else {
          child.kill();
        }
      }
    }, READY_TIMEOUT_MS);
    child.once('exit', () => clearTimeout(readyTimer));
  }

  /** Electron `child-process-gone`（晚于 `exit`）：区分信号终止与普通退出码，非正常退出时写日志。 */
  processGone(details: { reason: string; exitCode: number }): void {
    if (details.reason === 'clean-exit') return;
    this.options.log(`[host] Desktop Host process gone: ${describeHostGone(details)}`);
  }

  private logStderrTail(child: UtilityProcess): void {
    const entry = this.stderrTails.get(child);
    if (entry === undefined) return;
    this.stderrTails.delete(child);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, STDERR_DRAIN_MS).unref());
    void Promise.race([entry.ended, timeout]).then(() => {
      const text = entry.tail.text().replace(/\n$/, '');
      this.options.log(text === '' ? '[host] no stderr output before exit' : `[host] last stderr before exit:\n${text}`);
    });
  }

  private onExit(child: UtilityProcess, code: number): void {
    const abnormal = !this.stopping || code !== 0;
    if (abnormal) this.logStderrTail(child);
    else this.stderrTails.delete(child);
    if (this.child !== child) return;
    const wasReady = this.ready;
    this.child = null;
    this.port?.close();
    this.port = null;
    this.ready = false;
    this.options.onProcessExit?.();
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();
    const reason = `Desktop Host exited (code ${code})`;
    this.failInFlight(reason);
    if (this.stopping) return;
    const now = Date.now();
    const isolate = !this.isolatedUserPlugins && !this.options.args.includes('--safe-mode') && process.env.DS_SAFE_MODE !== '1'
      && (!wasReady || now - this.startedAt < RESTART_WINDOW_MS)
      && existsSync(join(this.options.handshake.appDataDir, 'plugins', 'user.profile.json'));
    if (isolate) {
      // Recover on the first startup crash, before the native crash-loop gate
      // can stop spawning. This also covers process.exit()/native crashes that
      // cannot be caught by per-plugin lifecycle isolation in the Host.
      this.isolatedUserPlugins = true;
      this.options.log('[host] startup crash: automatically isolating user plugins; restarting with official plugins only (user profile preserved)');
    }
    if (!isolate && this.options.onUnexpectedExit?.(wasReady) === false) {
      this.markUnavailable(`${reason}; startup recovery required`);
      this.queue = [];
      this.options.onUnavailable(this.unavailableReason!);
      return;
    }
    this.options.log(`[host] ${reason}`);
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.unavailableReason = `${reason}; restarted ${MAX_RESTARTS} times within ${RESTART_WINDOW_MS / 1000}s, giving up`;
      this.queue = [];
      this.options.onUnavailable(this.unavailableReason);
      return;
    }
    this.restarts.push(now);
    this.options.log(`[host] restarting (${this.restarts.length}/${MAX_RESTARTS})`);
    this.start();
  }

  private failInFlight(reason: string): void {
    for (const [id, pending] of this.pendingInvokes) pending.resolve({ ok: false, error: reason, diagnosticId: id });
    this.pendingInvokes.clear();
    for (const sink of this.pendingProtocols.values()) sink.fail(reason);
    this.pendingProtocols.clear();
  }

  private send(message: Outgoing): void {
    if (!this.ready && message.kind !== 'handshake') {
      this.queue.push(message);
      return;
    }
    this.port?.postMessage(message);
  }

  private onMessage(message: HostToMain): void {
    switch (message.kind) {
      case 'ready': {
        if (message.protocol !== HOST_PROTOCOL_VERSION) {
          this.options.log(`[host] protocol mismatch: host=${message.protocol} shell=${HOST_PROTOCOL_VERSION}`);
          this.unavailableReason = `Desktop Host protocol ${message.protocol} is incompatible with shell protocol ${HOST_PROTOCOL_VERSION}`;
          this.stopping = true;
          this.child?.kill();
          this.options.onUnavailable(this.unavailableReason);
          return;
        }
        this.ready = true;
        if (this.isolatedUserPlugins) {
          this.options.onEvent({
            kind: 'event', event: 'host://plugin-profile-failed', target: { kind: 'Any' },
            payload: {
              profile: join(this.options.handshake.appDataDir, 'plugins', 'user.profile.json'),
              error: '检测到插件异常，系统已自动隔离用户插件以保护主程序稳定运行',
              isolated: true,
            },
          });
        }
        const queued = this.queue;
        this.queue = [];
        for (const item of queued) this.port?.postMessage(item);
        return;
      }
      case 'result': {
        const pending = this.pendingInvokes.get(message.id);
        if (!pending) return;
        this.pendingInvokes.delete(message.id);
        const json = message.json === undefined ? {} : { json: message.json };
        pending.resolve(message.ok ? { ok: true, value: message.value, ...json } : { ok: false, error: message.error, diagnosticId: message.id, ...json });
        return;
      }
      case 'event':
        this.options.onEvent(message);
        return;
      case 'shell-request':
        this.options.onShellRequest(message).then(
          (value) => this.send({ kind: 'shell-result', id: message.id, ok: true, value: value ?? null }),
          (error: unknown) =>
            this.send({
              kind: 'shell-result', id: message.id, ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...(error instanceof BrowserBridgeError ? { errorData: error.data } : {}),
            }),
        );
        return;
      case 'protocol-result': {
        const sink = this.pendingProtocols.get(message.id);
        if (!sink) return;
        if (message.final) this.pendingProtocols.delete(message.id);
        sink.head(message);
        return;
      }
      case 'protocol-chunk': {
        const sink = this.pendingProtocols.get(message.id);
        if (!sink) return;
        if (message.final) this.pendingProtocols.delete(message.id);
        sink.chunk(message);
        return;
      }
      case 'fatal': {
        this.options.log(`[host] fatal: ${message.message}${message.stack ? `\n${message.stack}` : ''}`);
        // Host 发完 fatal 会先释放运行时再以 1 退出（host/kernel/main.ts、connection.ts）；立即 kill 会打断清理，
        // 且被 kill 的子进程在 `exit` 里报告退出码 0，日志就成了“正常退出”。只在它没按时退出时才强制结束。
        const child = this.child;
        if (child === null) return;
        const timer = setTimeout(() => {
          if (this.child !== child) return;
          this.options.log(`[host] did not exit within ${FATAL_EXIT_GRACE_MS / 1000}s after fatal, killing`);
          child.kill();
        }, FATAL_EXIT_GRACE_MS);
        child.once('exit', () => clearTimeout(timer));
        return;
      }
    }
  }

  invoke(request: Omit<InvokeRequest, 'kind' | 'id'>, pending: PendingInvoke): string {
    const id = this.newId('invoke') + '-' + globalThis.crypto.randomUUID();
    if (this.unavailableReason !== null) {
      pending.resolve({ ok: false, error: this.unavailableReason, diagnosticId: id });
      return id;
    }
    this.pendingInvokes.set(id, pending);
    this.send({ kind: 'invoke', id, ...request });
    return id;
  }

  /** 页面关闭/重载时放弃该 webview 的所有进行中调用。 */
  abandonWebview(webview: string, reason: 'window-closed' | 'reloaded'): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.webview !== webview) continue;
      this.pendingInvokes.delete(id);
      this.send({ kind: 'abandon', id, reason });
    }
  }

  sendMessage(message: MainToHost): void {
    if (this.unavailableReason !== null) return;
    this.send(message);
  }

  protocol(request: { scheme: string; url: string; method: string; headers: Record<string, string>; body?: Uint8Array }, sink: ProtocolSink): void {
    if (this.unavailableReason !== null) {
      sink.fail(this.unavailableReason);
      return;
    }
    const id = this.newId('protocol');
    this.pendingProtocols.set(id, sink);
    this.send({ kind: 'protocol', id, ...request });
  }

  /** 有序退出：发送 shutdown，等待进程退出，超时后强制结束。 */
  async shutdown(timeoutMs = HOST_SHUTDOWN_BUDGET_MS): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    if (this.port) this.port.postMessage({ kind: 'shutdown' } satisfies ShutdownMessage);
    const timer = setTimeout(() => {
      this.options.log('[host] shutdown timed out, killing');
      child.kill();
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  /** SIGKILL 还没退出的 Host（Windows 上同为 TerminateProcess）：Host 不理 shutdown 也不理 SIGTERM 时用。 */
  forceKill(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    this.options.log('[host] still running at the quit deadline, sending SIGKILL');
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      this.options.log(`[host] SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
