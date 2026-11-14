/**
 * 启动收尾钩子（D2）：数据空间初始化 / 启动清理 / 迁移完成后，由组合根统一执行。
 *
 * Rust 的等价阶段是 `lib.rs` setup 里 `initialize_with_report`（迁移）之后、
 * `finalize_restore_activation`、启动删除恢复等收尾动作。F3 只提供注册、拓扑排序与执行，
 * 不 import 任何业务插件；L21 恢复收尾、F2 startupGate 由各自插件在 apply 中注册。
 *
 * 插件可以卸载再重装（V09 P1-3）：`register()` 返回 disposer，`signal` 选项在 abort 时
 * 做同样的事（包装层丢弃返回值时也能注销）；`late` 选项决定 finalizer 已开始或已结束后
 * 再注册时的处理，默认仍抛 `FINALIZER_LATE_REGISTRATION`。
 */
import {
  StartupFinalizerError,
  StorageError,
  type StartupFinalizerOptions,
  type StartupFinalizerReport,
} from './api.ts';

/**
 * 注册时 `runStartupFinalizers()` 已开始（running / failed / done）的处理：
 * - `throw`（默认）：抛 `FINALIZER_LATE_REGISTRATION`，不登记；
 * - `skip`：什么都不做，返回空 disposer（只在启动时才有意义的钩子）；
 * - `run`：同名钩子已完成过、或整轮已结束时立即同步执行；否则登记为待执行，
 *   在本轮（running）剩余部分或下一次重试（failed）中执行。
 */
export type StartupFinalizerLatePolicy = 'throw' | 'skip' | 'run';

export interface StartupFinalizerRegistration extends StartupFinalizerOptions {
  readonly late?: StartupFinalizerLatePolicy;
  /** abort 时等同调用 `register()` 返回的 disposer；注册时已 abort 则不登记。 */
  readonly signal?: AbortSignal;
}

export interface StartupFinalizerRegistryOptions {
  /**
   * `late: 'run'` 立即执行的钩子返回的 promise 被拒绝时调用，缺省时以未处理拒绝抛出；
   * 执行中被同名新注册替换的旧实例失败时也调用（不判本轮失败），缺省时丢弃。
   */
  readonly onLateError?: (error: StartupFinalizerError) => void;
}

interface FinalizerEntry {
  readonly name: string;
  /** 整轮成功后置空，已卸载插件的闭包不再被 registry 持有。 */
  fn: (() => void | Promise<void>) | null;
  readonly after: readonly string[];
}

type State = 'open' | 'running' | 'done' | 'failed';

const LATE_POLICIES: readonly StartupFinalizerLatePolicy[] = ['throw', 'skip', 'run'];
const NOOP = (): void => {};

export class StartupFinalizerRegistry {
  private readonly entries = new Map<string, FinalizerEntry>();
  private readonly completed: string[] = [];
  private state: State = 'open';
  private readonly onLateError: ((error: StartupFinalizerError) => void) | undefined;

  constructor(options: StartupFinalizerRegistryOptions = {}) {
    this.onLateError = options.onLateError;
  }

  register(name: string, fn: () => void | Promise<void>, options: StartupFinalizerRegistration = {}): () => void {
    const late = options.late ?? 'throw';
    if (!LATE_POLICIES.includes(late)) {
      throw new StorageError('FINALIZER_INVALID', `startup finalizer "${name}" has an invalid late policy`);
    }
    if (this.state !== 'open' && late === 'throw') {
      throw new StorageError(
        'FINALIZER_LATE_REGISTRATION',
        `startup finalizer "${name}" registered after runStartupFinalizers() started`,
      );
    }
    if (typeof name !== 'string' || name.length === 0 || typeof fn !== 'function') {
      throw new StorageError('FINALIZER_INVALID', 'startup finalizer requires a non-empty name and a function');
    }
    const after = options.after ?? [];
    if (after.some((dependency) => typeof dependency !== 'string' || dependency.length === 0)) {
      throw new StorageError('FINALIZER_INVALID', `startup finalizer "${name}" has an invalid after entry`);
    }
    const signal = options.signal;
    if (signal?.aborted) return NOOP;
    if (this.state !== 'open') {
      if (late === 'skip') return NOOP;
      if (this.state === 'done' || this.completed.includes(name)) {
        this.runLate(name, fn, after);
        return NOOP;
      }
    }
    if (this.entries.has(name)) {
      throw new StorageError('FINALIZER_DUPLICATE', `startup finalizer "${name}" is already registered`);
    }
    const entry: FinalizerEntry = { name, fn, after: [...after] };
    this.entries.set(name, entry);
    const dispose = (): void => {
      signal?.removeEventListener('abort', dispose);
      if (this.entries.get(name) === entry) this.entries.delete(name);
    };
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  names(): readonly string[] {
    return [...this.entries.keys()];
  }

  async run(): Promise<StartupFinalizerReport> {
    if (this.state === 'done') {
      return { completed: [...this.completed], skipped: [] };
    }
    this.state = 'running';
    const alreadyDone = new Set(this.completed);
    let skipped: string[] | undefined;
    // Hooks registered with `late: 'run'` while this loop runs join a later pass.
    for (;;) {
      let order: string[];
      try {
        order = this.executionOrder();
      } catch (error) {
        // Unknown dependencies/cycles fail the run too: keep the registry failed and
        // the completed list intact. A caller may retry explicitly; there is no
        // automatic retry, and registration stays frozen after the first run.
        this.state = 'failed';
        throw error;
      }
      skipped ??= order.filter((name) => alreadyDone.has(name));
      const pending = order.filter((name) => !alreadyDone.has(name));
      if (pending.length === 0) break;
      for (const name of pending) {
        const entry = this.entries.get(name);
        if (entry === undefined || entry.fn === null) continue;
        const replaced = (): boolean => this.entries.has(name) && this.entries.get(name) !== entry;
        try {
          await entry.fn();
        } catch (error) {
          const failure = new StartupFinalizerError(name, [...this.completed], error);
          // An unloaded instance commonly fails on its closed resources; it no longer owns the
          // name, so it is reported like a late error and the new instance runs in the next pass.
          if (replaced()) {
            this.onLateError?.(failure);
            continue;
          }
          this.state = 'failed';
          throw failure;
        }
        // Unloaded and re-registered while this hook was awaiting: the new instance runs in the next pass.
        if (replaced()) continue;
        this.completed.push(name);
        alreadyDone.add(name);
      }
    }
    this.state = 'done';
    for (const entry of this.entries.values()) entry.fn = null;
    return { completed: [...this.completed], skipped };
  }

  private runLate(name: string, fn: () => void | Promise<void>, after: readonly string[]): void {
    const unknown = after.find((dependency) => !this.completed.includes(dependency));
    if (unknown !== undefined) {
      throw new StorageError(
        'FINALIZER_UNKNOWN_DEPENDENCY',
        `startup finalizer "${name}" depends on unknown finalizer "${unknown}"`,
      );
    }
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (error) {
      throw new StartupFinalizerError(name, [...this.completed], error);
    }
    if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).then(undefined, (error: unknown) => {
        const failure = new StartupFinalizerError(name, [...this.completed], error);
        if (this.onLateError === undefined) throw failure;
        this.onLateError(failure);
      });
    }
  }

  /**
   * DFS 拓扑排序；无依赖的钩子保持注册顺序。缺失依赖与环在真正执行前报错。
   * 已完成且已注销的钩子仍算作满足依赖（重试时其插件可能已卸载）。
   */
  private executionOrder(): string[] {
    const completed = new Set(this.completed);
    for (const entry of this.entries.values()) {
      for (const dependency of entry.after) {
        if (!this.entries.has(dependency) && !completed.has(dependency)) {
          throw new StorageError(
            'FINALIZER_UNKNOWN_DEPENDENCY',
            `startup finalizer "${entry.name}" depends on unknown finalizer "${dependency}"`,
          );
        }
      }
    }

    const result: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (name: string, path: string[]): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        const cycle = [...path.slice(path.indexOf(name)), name].join(' -> ');
        throw new StorageError('FINALIZER_CYCLE', `startup finalizer dependency cycle: ${cycle}`);
      }
      const entry = this.entries.get(name);
      if (entry === undefined) return;
      visiting.add(name);
      for (const dependency of entry.after) visit(dependency, [...path, name]);
      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (const name of this.entries.keys()) visit(name, []);
    return result;
  }
}
