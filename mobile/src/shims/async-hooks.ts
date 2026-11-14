/**
 * `node:async_hooks` 占位：只给 `AsyncLocalStorage` 同步作用域（`run` 回调同步执行期间 `getStore()` 有值，await 之后丢失）。
 *
 * 唯一用户是 `host/kernel/plugin-execution.ts`，它只由桌面插件管理器（`PluginAdmin`，`connection.ts` 的 profile 启动分支）装上；
 * 移动端 Host 走 `installs`，不经过这条分支，`kernel.execution` 不被设置。即使被用到，丢失作用域时 `getStore()` 为 undefined，
 * 调用方（`plugin-installer.ts`）按“不是本插件”拒绝，不会放宽权限。
 */
export class AsyncLocalStorage<T> {
  #store: T | undefined;
  #enabled = true;

  getStore(): T | undefined {
    return this.#enabled ? this.#store : undefined;
  }

  run<R>(store: T, callback: (...args: any[]) => R, ...args: unknown[]): R {
    const previous = this.#store;
    this.#store = store;
    try {
      return callback(...args);
    } finally {
      this.#store = previous;
    }
  }

  exit<R>(callback: (...args: any[]) => R, ...args: unknown[]): R {
    const previous = this.#store;
    this.#store = undefined;
    try {
      return callback(...args);
    } finally {
      this.#store = previous;
    }
  }

  enterWith(store: T): void {
    this.#store = store;
  }

  disable(): void {
    this.#enabled = false;
    this.#store = undefined;
  }

  static bind<F extends (...args: any[]) => unknown>(fn: F): F {
    return fn;
  }

  static snapshot(): <R>(fn: (...args: any[]) => R, ...args: unknown[]) => R {
    return (fn, ...args) => fn(...args);
  }
}

export default { AsyncLocalStorage };
