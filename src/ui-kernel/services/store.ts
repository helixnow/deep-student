/**
 * 插件状态（FRONTEND-PLUGINIZATION §2.6）：`ctx.ui.createStore(init)` / SDK 的 `createPluginStore(ctx, init)`。
 *
 * 底层是 zustand 的 vanilla store，归插件作用域所有：卸载时先停止持久化，再把状态重置为初始值（通知一次），
 * 然后断开全部订阅；之后的写入被忽略并告警。需要跨重启保留的字段用 `persist` 经 `ctx.ui.storage` 写入。
 */
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla';
import type { UiPluginScope } from '../scope';
import type { PluginStorage } from './storage';

export interface PluginStore<T> extends StoreApi<T> {
  /** 插件已卸载：状态已重置，订阅已断开，写入被忽略。 */
  readonly disposed: boolean;
}

export interface PluginStoreOptions<T> {
  /** 经 `ctx.ui.storage` 持久化：创建时用存储值浅合并初始状态，之后每次变化写回 `pick(state)`（缺省为整个状态）。 */
  persist?: { key: string; pick?: (state: T) => unknown };
}

export type PluginStoreInit<T> = T | StateCreator<T>;

export function createScopedStore<T>(
  scope: UiPluginScope,
  init: PluginStoreInit<T>,
  options: PluginStoreOptions<T> = {},
  storage?: () => PluginStorage,
): PluginStore<T> {
  const creator: StateCreator<T> = typeof init === 'function' ? (init as StateCreator<T>) : () => init;
  const inner = createStore<T>()(creator);
  const initial = inner.getState();

  const persist = options.persist;
  const persisted = persist && storage ? storage() : undefined;
  let stopPersist: (() => void) | undefined;
  if (persist && persisted) {
    const stored = persisted.get<unknown>(persist.key);
    if (stored !== undefined) {
      const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
      inner.setState((isRecord(stored) && isRecord(initial) ? { ...initial, ...stored } : stored) as T, true);
    }
    const pick = persist.pick ?? ((state: T) => state);
    stopPersist = inner.subscribe((state) => persisted.set(persist.key, pick(state)));
  }

  const unsubscribers = new Set<() => void>();
  let disposed = false;
  let warned = false;

  const store: PluginStore<T> = {
    get disposed() {
      return disposed;
    },
    getState: inner.getState,
    getInitialState: () => initial,
    setState: ((partial: unknown, replace?: boolean) => {
      if (disposed) {
        if (!warned) console.warn(`[ui-kernel] plugin "${scope.id}" wrote to its store after unloading; ignored`);
        warned = true;
        return;
      }
      (inner.setState as (p: unknown, r?: boolean) => void)(partial, replace);
    }) as StoreApi<T>['setState'],
    subscribe: (listener) => {
      if (disposed) return () => {};
      const off = inner.subscribe(listener);
      const remove = () => {
        unsubscribers.delete(remove);
        off();
      };
      unsubscribers.add(remove);
      return remove;
    },
  };

  scope.track(() => {
    stopPersist?.();
    inner.setState(initial, true);
    for (const off of [...unsubscribers]) off();
    disposed = true;
  });
  return store;
}
