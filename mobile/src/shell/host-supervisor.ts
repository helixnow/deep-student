/**
 * Host Worker 托管：移动端对应桌面 `electron/shell/host.ts` 的 `HostSupervisor`，策略与常量相同：
 * - 就绪超时 `STARTUP_READY_WAIT`（握手后迁移、插件装载与启动 finalizer 都在 HostReady 之前）；
 * - Worker 退出（Host 有序退出、fatal 后退出、Worker 未捕获错误、就绪超时）时进行中的 invoke 以退出原因结束；
 * - 非有序退出在 60 秒内最多重启 3 次，超过后停止重启，之后的 invoke 立即以该原因失败（外壳不退出）；
 * - fatal 之后给 Host 5 秒完成清理并退出，否则强制结束；有序退出等待 8 秒。
 *
 * Worker 没有退出事件：Host 退出时 Worker 在 Host 端口上发 `dstu-worker-exit`（`mobile/src/worker/exit-report.ts`）再 `self.close()`。
 */
import type { MobileShell } from './mobile-shell.ts';

/** 与 `electron/api.ts` 的 `STARTUP_READY_WAIT` 相同；该文件带桌面的 cordis 类型扩充，移动端不导入。 */
export const READY_TIMEOUT_MS = 120_000;
export const RESTART_WINDOW_MS = 60_000;
export const MAX_RESTARTS = 3;
export const FATAL_EXIT_GRACE_MS = 5_000;
/** 与桌面 `HOST_SHUTDOWN_BUDGET_MS` 相同：要大于 Host 关停时等后台任务的 5 秒，否则强制结束会吞掉存储关闭与最后的日志。 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/** `Worker` 中本模块用到的部分（测试用假 Worker 实现同样的形状）。 */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface HostWorkerSupervisorOptions {
  readonly createWorker: () => WorkerLike;
  readonly shell: MobileShell;
  readonly log: (message: string) => void;
  /** 重启次数用尽或 Host 已有序退出：之后的调用都以该原因失败。 */
  readonly onUnavailable?: (reason: string) => void;
  /** Worker 报告 Host 模块求值完成（主线程 `performance.now()`）。 */
  readonly onWorkerLoaded?: (atMs: number) => void;
}

interface WorkerMessage {
  kind?: unknown;
}

export class HostWorkerSupervisor {
  private readonly options: HostWorkerSupervisorOptions;
  private worker: WorkerLike | null = null;
  private ready = false;
  private fatalMessage: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private restarts: number[] = [];
  private stopping = false;
  private unavailableReason: string | null = null;
  private exitWaiters: Array<() => void> = [];

  constructor(options: HostWorkerSupervisorOptions) {
    this.options = options;
  }

  get available(): boolean {
    return this.unavailableReason === null;
  }

  start(): void {
    this.stopping = false;
    const worker = this.options.createWorker();
    this.worker = worker;
    this.ready = false;
    this.fatalMessage = null;
    worker.addEventListener('message', event => this.fromWorker(worker, event.data as WorkerMessage));
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      this.exited(worker, `worker error: ${event.message || 'unknown error'}`);
    });
    worker.addEventListener('messageerror', () => this.exited(worker, 'worker message could not be deserialized'));
    const channel = new MessageChannel();
    worker.postMessage({ kind: 'dstu-connect', port: channel.port2 }, [channel.port2]);
    this.options.shell.attach(channel.port1, {
      onReady: () => {
        if (this.worker === worker) this.ready = true;
      },
      onFatal: message => this.onFatal(worker, message),
      onExit: code => this.exited(worker, `code ${code}`),
    });
    this.after(READY_TIMEOUT_MS, () => {
      if (this.worker !== worker || this.ready) return;
      this.options.log(`[host] no ready message within ${READY_TIMEOUT_MS / 1000}s, terminating`);
      this.exited(worker, `no ready message within ${READY_TIMEOUT_MS / 1000}s`);
    });
  }

  /** 有序退出：发送 shutdown，等待 Host 退出，超时后强制结束 Worker。 */
  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    if (worker === null) return;
    const exited = new Promise<void>(resolve => this.exitWaiters.push(resolve));
    this.options.shell.sendShutdown();
    const timer = setTimeout(() => {
      this.options.log('[host] shutdown timed out, terminating');
      this.exited(worker, 'terminated after shutdown timeout');
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private fromWorker(worker: WorkerLike, data: WorkerMessage): void {
    if (data?.kind === 'dstu-worker-loaded') this.options.onWorkerLoaded?.(performance.now());
  }

  private onFatal(worker: WorkerLike, message: string): void {
    if (this.worker !== worker) return;
    this.fatalMessage = message;
    this.after(FATAL_EXIT_GRACE_MS, () => {
      if (this.worker !== worker) return;
      this.options.log(`[host] did not exit within ${FATAL_EXIT_GRACE_MS / 1000}s after fatal, terminating`);
      this.exited(worker, 'terminated after fatal');
    });
  }

  private exited(worker: WorkerLike, detail: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    worker.terminate();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    const reason = `Mobile Host exited (${detail})${this.fatalMessage === null ? '' : ` after fatal: ${this.fatalMessage}`}`;
    this.options.shell.detach(reason);
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();
    if (this.stopping) {
      this.giveUp(reason);
      return;
    }
    this.options.log(`[host] ${reason}`);
    const now = Date.now();
    this.restarts = this.restarts.filter(t => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.giveUp(`${reason}; restarted ${MAX_RESTARTS} times within ${RESTART_WINDOW_MS / 1000}s, giving up`);
      return;
    }
    this.restarts.push(now);
    this.options.log(`[host] restarting (${this.restarts.length}/${MAX_RESTARTS})`);
    this.start();
  }

  private giveUp(reason: string): void {
    this.unavailableReason = reason;
    this.options.shell.markUnavailable(reason);
    this.options.onUnavailable?.(reason);
  }
}
