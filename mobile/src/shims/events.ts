/** `node:events` 在 Worker / 页面中的实现：同步派发的 `EventEmitter`，外加 `once(emitter, name)` 与 `on` 别名。 */
type Listener = (...args: any[]) => unknown;

const ONCE = Symbol('once');
interface Wrapped extends Listener { [ONCE]?: Listener }

export class EventEmitter {
  static defaultMaxListeners = 10;
  static readonly errorMonitor: unique symbol = Symbol('events.errorMonitor');
  #listeners = new Map<string | symbol, Wrapped[]>();
  #maxListeners = EventEmitter.defaultMaxListeners;

  on(event: string | symbol, listener: Listener): this {
    return this.addListener(event, listener);
  }

  addListener(event: string | symbol, listener: Listener): this {
    if (this.#listeners.has('newListener') && event !== 'newListener') this.emit('newListener', event, listener);
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  prependListener(event: string | symbol, listener: Listener): this {
    this.#listeners.set(event, [listener, ...(this.#listeners.get(event) ?? [])]);
    return this;
  }

  once(event: string | symbol, listener: Listener): this {
    return this.on(event, this.#wrapOnce(event, listener));
  }

  prependOnceListener(event: string | symbol, listener: Listener): this {
    return this.prependListener(event, this.#wrapOnce(event, listener));
  }

  off(event: string | symbol, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeListener(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event);
    if (!list) return this;
    const index = list.findIndex(item => item === listener || item[ONCE] === listener);
    if (index < 0) return this;
    list.splice(index, 1);
    if (list.length === 0) this.#listeners.delete(event);
    if (this.#listeners.has('removeListener')) this.emit('removeListener', event, listener);
    return this;
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && this.#listeners.has(EventEmitter.errorMonitor)) {
      for (const listener of [...this.#listeners.get(EventEmitter.errorMonitor)!]) listener.apply(this, args);
    }
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) {
      if (event === 'error') throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${String(args[0])})`);
      return false;
    }
    for (const listener of [...list]) listener.apply(this, args);
    return true;
  }

  listeners(event: string | symbol): Listener[] {
    return (this.#listeners.get(event) ?? []).map(item => item[ONCE] ?? item);
  }

  rawListeners(event: string | symbol): Listener[] {
    return [...(this.#listeners.get(event) ?? [])];
  }

  listenerCount(event: string | symbol): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  eventNames(): (string | symbol)[] {
    return [...this.#listeners.keys()];
  }

  setMaxListeners(count: number): this {
    this.#maxListeners = count;
    return this;
  }

  getMaxListeners(): number {
    return this.#maxListeners;
  }

  #wrapOnce(event: string | symbol, listener: Listener): Wrapped {
    const wrapped: Wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      return listener.apply(this, args);
    };
    wrapped[ONCE] = listener;
    return wrapped;
  }
}

export const errorMonitor = EventEmitter.errorMonitor;

export function once(emitter: EventEmitter, event: string | symbol, options: { signal?: AbortSignal } = {}): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const onEvent = (...args: unknown[]) => {
      cleanup();
      resolve(args);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(options.signal!.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    const cleanup = () => {
      emitter.off(event, onEvent);
      if (event !== 'error') emitter.off('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
    };
    if (options.signal?.aborted) return onAbort();
    emitter.on(event, onEvent);
    if (event !== 'error') emitter.on('error', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function listenerCount(emitter: EventEmitter, event: string | symbol): number {
  return emitter.listenerCount(event);
}

export function setMaxListeners(): void {}

// CommonJS 风格：`require('events')` 本身就是构造函数，`EventEmitter.EventEmitter` 也是。
const events = Object.assign(EventEmitter, { EventEmitter, once, errorMonitor, listenerCount, setMaxListeners });
export default events;
