/**
 * 插件私有持久化（FRONTEND-PLUGINIZATION §2.6）：`ctx.ui.storage`。
 *
 * - 键自动加 `ds:plugin:<encodeURIComponent(id)>:` 前缀，插件之间互不可见（与 W07 的 localStorage 迁移同一存储）；
 * - 值按 JSON 存取；读到损坏的值时回落到默认值并告警，不抛错；
 * - 订阅与句柄随插件卸载撤销；数据本身保留，插件被卸载移除时由管理方调用 `kernel.storage.clear(id)`。
 */
import type { UiPluginScope } from '../scope';

export interface UiStorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export interface PluginStorageCell<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  /** 删除持久化的值，回到初始值。 */
  reset(): void;
  subscribe(listener: (value: T) => void): () => void;
}

export interface PluginStorage {
  /** 本插件键的完整前缀。 */
  readonly prefix: string;
  get<T = unknown>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  /** 写入可 JSON 序列化的值；`undefined` 等同 remove。 */
  set(key: string, value: unknown): void;
  remove(key: string): void;
  keys(): string[];
  /** 删除本插件的全部键。 */
  clear(): void;
  subscribe<T = unknown>(key: string, listener: (value: T | undefined) => void): () => void;
  json<T>(key: string, initial: T): PluginStorageCell<T>;
}

export const PLUGIN_STORAGE_PREFIX = 'ds:plugin:';

export function pluginStoragePrefix(pluginId: string): string {
  return `${PLUGIN_STORAGE_PREFIX}${encodeURIComponent(pluginId)}:`;
}

export function webStorageBackend(storage: Storage): UiStorageBackend {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    keys: () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => k !== null),
  };
}

export function memoryStorageBackend(initial: Record<string, string> = {}): UiStorageBackend & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
    dump: () => Object.fromEntries(data),
  };
}

function defaultBackend(): UiStorageBackend {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
    if (storage && typeof storage.getItem === 'function') return webStorageBackend(storage);
  } catch {
    // 受限环境（隐私模式、无 DOM 的测试宿主）读 localStorage 会抛错，回落到内存实现。
  }
  return memoryStorageBackend();
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('ctx.ui.storage: key must be a non-empty string');
}

export class UiStorageService {
  private _backend: UiStorageBackend | undefined;
  private readonly _listeners = new Map<string, Set<(value: unknown) => void>>();

  constructor(backend?: UiStorageBackend) {
    this._backend = backend;
  }

  private get backend(): UiStorageBackend {
    return (this._backend ??= defaultBackend());
  }

  /** 删除某个插件的全部持久化数据（插件被卸载移除时使用），返回删除的键数。 */
  clear(pluginId: string): number {
    const prefix = pluginStoragePrefix(pluginId);
    const keys = this.backend.keys().filter((k) => k.startsWith(prefix));
    for (const key of keys) this._write(key, undefined);
    return keys.length;
  }

  /** 绑定到某次安装的句柄：作用域撤销后所有操作抛 `UiPluginDisposedError`。 */
  open(scope: UiPluginScope): PluginStorage {
    const prefix = pluginStoragePrefix(scope.id);
    const live = (key?: string) => {
      scope.assertActive('storage');
      if (key !== undefined) assertKey(key);
    };
    const storage: PluginStorage = {
      prefix,
      get: <T>(key: string, fallback?: T) => {
        live(key);
        return this._read<T>(prefix + key, fallback as T);
      },
      set: (key, value) => {
        live(key);
        this._write(prefix + key, value);
      },
      remove: (key) => {
        live(key);
        this._write(prefix + key, undefined);
      },
      keys: () => {
        live();
        return this.backend.keys().filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
      },
      clear: () => {
        live();
        for (const key of storage.keys()) this._write(prefix + key, undefined);
      },
      subscribe: <T>(key: string, listener: (value: T | undefined) => void) => {
        live(key);
        const full = prefix + key;
        const set = this._listeners.get(full) ?? new Set();
        this._listeners.set(full, set);
        const fn = listener as (value: unknown) => void;
        set.add(fn);
        return scope.track(() => {
          set.delete(fn);
          if (!set.size) this._listeners.delete(full);
        });
      },
      json: <T>(key: string, initial: T): PluginStorageCell<T> => {
        live(key);
        return {
          get: () => storage.get<T>(key, initial),
          set: (next) => storage.set(key, typeof next === 'function' ? (next as (prev: T) => T)(storage.get<T>(key, initial)) : next),
          reset: () => storage.remove(key),
          subscribe: (listener) => storage.subscribe<T>(key, (value) => listener(value === undefined ? initial : value)),
        };
      },
    };
    return storage;
  }

  private _read<T>(full: string, fallback: T): T {
    const raw = this.backend.getItem(full);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      console.warn(`[ui-kernel] storage key "${full}" holds an unreadable value; using the default`);
      return fallback;
    }
  }

  private _write(full: string, value: unknown): void {
    if (value === undefined) {
      this.backend.removeItem(full);
    } else {
      const raw = JSON.stringify(value);
      if (raw === undefined) throw new TypeError(`ctx.ui.storage: value for "${full}" is not JSON-serializable`);
      this.backend.setItem(full, raw);
    }
    const listeners = this._listeners.get(full);
    if (!listeners) return;
    const parsed = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    for (const fn of [...listeners]) fn(parsed);
  }
}
