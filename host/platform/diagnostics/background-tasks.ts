import { Service, type Context } from '@deepseek-ai/cordis';
import type { BackgroundTaskOptions, BackgroundTasks } from './api.ts';

export interface BackgroundTasksLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** shutdown abort 全部任务后最多再等这么久；Host 关停总预算见 host/kernel/API.md「关停」。 */
export const BACKGROUND_SHUTDOWN_GRACE_MS = 1000;

const silent: BackgroundTasksLogger = { info: () => undefined, warn: () => undefined };

type Fiber = Context['fiber'];

interface Entry {
  readonly controller: AbortController;
  readonly handle: Promise<unknown>;
  settled: boolean;
  release?: () => unknown;
}

function lineage(fiber: Fiber | undefined): Set<Fiber> {
  const chain = new Set<Fiber>();
  for (let current = fiber; current && !chain.has(current); current = current.parent?.fiber) chain.add(current);
  return chain;
}

/**
 * dstu-platform/background_tasks.rs：shutdown 先关准入再等待，超时不再等。
 * 与 Rust 不同（Rust 没有插件卸载）：任务归属提交方 fiber，归属卸载时 abort 并移出集合；shutdown 先 abort 再等，
 * 等待上限 {@link BACKGROUND_SHUTDOWN_GRACE_MS}，给其后的 storage / log 清理留出外壳关停预算。
 *
 * 归属从调用方上下文推断：返回的对象带 Cordis tracker，经 `ctx.backgroundTasks` / `ctx.get('backgroundTasks')`
 * 取到的是追踪代理，方法里的 `this.ctx` 即调用方上下文。`provider` 是提供方上下文；它及其祖先（根）不算归属。
 */
export function createBackgroundTasks(log: BackgroundTasksLogger = silent, provider?: Context): BackgroundTasks {
  let accepting = true;
  const tasks = new Map<Promise<unknown>, Entry>();
  const unowned = lineage(provider?.fiber);

  const detach = (entry: Entry, reason: Error) => {
    if (entry.settled) return;
    entry.controller.abort(reason);
    tasks.delete(entry.handle);
  };

  const service = {
    get size() { return tasks.size; },
    spawn<T>(this: { ctx?: Context } | undefined, task: (signal: AbortSignal) => Promise<T>, options: BackgroundTaskOptions = {}): Promise<T> | null {
      const label = options.name ? ` "${options.name}"` : '';
      if (!accepting) {
        // Rust `spawn`（78）：拒绝准入时记录警告，调用方不得假定任务已提交。
        log.warn(`[background_tasks] spawn${label} rejected: shutdown in progress`);
        return null;
      }
      const owner = options.owner ?? this?.ctx;
      const ownerFiber = owner?.fiber;
      const controller = new AbortController();
      let resolveStart!: () => void;
      const started = new Promise<void>(resolve => (resolveStart = resolve));
      const handle = started.then(() => task(controller.signal));
      const entry: Entry = { controller, handle, settled: false };
      if (owner && ownerFiber && !unowned.has(ownerFiber)) {
        try {
          entry.release = owner.effect(() => () => detach(entry, new Error(`[background_tasks] task${label} cancelled: its owner was unloaded`)), 'backgroundTasks.spawn');
        } catch {
          log.warn(`[background_tasks] spawn${label} rejected: the submitting plugin is unloading`);
          void handle.catch(() => undefined);
          return null;
        }
      }
      if (options.signal) {
        const external = options.signal;
        const onAbort = () => controller.abort(external.reason);
        if (external.aborted) onAbort();
        else {
          external.addEventListener('abort', onAbort, { once: true });
          void handle.finally(() => external.removeEventListener('abort', onAbort)).catch(() => undefined);
        }
      }
      tasks.set(handle, entry);
      const finish = () => {
        entry.settled = true;
        tasks.delete(handle);
        void entry.release?.();
      };
      void handle.then(finish, finish);
      resolveStart();
      return handle;
    },
    async shutdown() {
      accepting = false;
      if (tasks.size === 0) return;
      const pending = [...tasks.values()];
      for (const entry of pending) entry.controller.abort(new Error('[background_tasks] Host is shutting down'));
      log.info(`[background_tasks] shutdown: aborted ${pending.length} pending task(s), waiting up to ${BACKGROUND_SHUTDOWN_GRACE_MS}ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await Promise.race([
          Promise.allSettled(pending.map(entry => entry.handle)),
          new Promise<void>(resolve => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, BACKGROUND_SHUTDOWN_GRACE_MS);
          }),
        ]);
      } finally { clearTimeout(timer); }
      if (timedOut) {
        log.warn(`[background_tasks] shutdown: timed out after ${BACKGROUND_SHUTDOWN_GRACE_MS}ms, ${tasks.size} task(s) ignored the abort and may still be running`);
      } else {
        log.info('[background_tasks] shutdown: all background tasks finished');
      }
    },
  };
  Object.defineProperty(service, Service.tracker, { value: { associate: 'backgroundTasks', property: 'ctx' } });
  return service as BackgroundTasks;
}
