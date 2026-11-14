/**
 * `ctx.shell`：请 Electron main 代办只能在 main 完成的平台操作（窗口、原生对话框等）。
 * 请求与回复以 id 配对（protocol.ts `ShellRequest` / `ShellResponse`），每个请求有超时。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ShellBridge } from './api.ts';
import { assertKernelSurface, type KernelState } from './kernel.ts';
import type { ShellResponse } from './protocol.ts';
import { ShellError } from './shell-error.ts';

export { ShellError };

interface Pending {
  op: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ShellService extends Service implements ShellBridge {
  _kernel: KernelState;
  _pending = new Map<string, Pending>();

  constructor(ctx: Context, kernel: KernelState) {
    super(ctx, 'shell');
    this._kernel = kernel;
  }

  request<R = unknown>(op: string, args?: unknown): Promise<R> {
    if (typeof op !== 'string' || !op) return Promise.reject(new TypeError('ctx.shell.request: op must be a non-empty string'));
    try {
      assertKernelSurface(this._kernel, this.ctx.fiber, `ctx.shell.request("${op}")`);
    } catch (error) {
      return Promise.reject(error);
    }
    const outbound = this._kernel.outbound;
    if (!outbound) return Promise.reject(new ShellError(op, `shell request "${op}" failed: Host is not connected to Electron main`));
    const id = globalThis.crypto.randomUUID();
    const timeoutMs = this._kernel.shellTimeoutMs;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new ShellError(op, `shell request "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { op, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        outbound.send({ kind: 'shell-request', id, op, args: args === undefined ? null : args });
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error instanceof Error ? error : new ShellError(op, String(error)));
      }
    });
  }

  /** main 的回复。未知 id（已超时）返回 false。 */
  _resolve(response: ShellResponse): boolean {
    const pending = this._pending.get(response.id);
    if (!pending) return false;
    this._pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new ShellError(pending.op, response.error, response.errorData));
    return true;
  }

  /** 连接关闭时拒绝全部未决请求。 */
  _rejectAll(reason: string): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new ShellError(pending.op, `shell request "${pending.op}" failed: ${reason}`));
      this._pending.delete(id);
    }
  }
}
