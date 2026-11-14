/**
 * 旧注册表的订阅层（FRONTEND-PLUGINIZATION §1.2 不足 2、FE-B 的前置）。
 *
 * 命令面板、对话 block、工作台应用仍是全局单例注册表，`ctx.ui.commands / chat.registerBlock / workbench.registerApp`
 * 经适配器写入它们。这里给每个适配器补一层可订阅的视图，供 FE-B 把消费方改成订阅式：
 * - 经内核的登记与撤销（插件安装、卸载）总会通知订阅者——没有原生订阅的注册表（`blockRegistry`）也一样；
 * - 适配器提供原生 `subscribe` 时（`commandRegistry`、`appRegistry`、FE-B2 起的对话注册表），首个订阅者出现时转发、最后一个离开时断开，
 *   因此绕过内核的直接登记也会通知；
 * - `list()` 按版本缓存，无变化时引用稳定，可直接用于 `useSyncExternalStore`。
 */

export type UiRegistryKind = 'commands' | 'chatBlocks' | 'chatEvents' | 'chatModes' | 'workbenchApps';

/** 适配器可选的读取与订阅能力。 */
export interface UiRegistrySource<T> {
  subscribe?(listener: () => void): () => void;
  list?(): readonly T[];
  get?(key: string): T | undefined;
}

const EMPTY: readonly never[] = Object.freeze([] as never[]);

export class UiAdapterRegistry<T = unknown> {
  private readonly _listeners = new Set<() => void>();
  private _version = 0;
  private _snapshot: { version: number; list: readonly T[] } | undefined;
  private _offNative: (() => void) | undefined;
  /** 经内核的登记 / 撤销进行中：期间原生注册表的通知并入 track 自己的那一次。 */
  private _tracking = 0;

  constructor(readonly kind: UiRegistryKind, private readonly _source: UiRegistrySource<T> | undefined) {}

  /** 窗口是否装配了该注册表的适配器。 */
  get available(): boolean {
    return !!this._source;
  }

  /** 包装一次经内核的登记：登记与撤销都通知订阅者。 */
  track(register: () => () => void): () => void {
    const revoke = this._quiet(register);
    this._bump();
    let revoked = false;
    return () => {
      if (revoked) return;
      revoked = true;
      this._quiet(revoke);
      this._bump();
    };
  }

  private _quiet<R>(fn: () => R): R {
    this._tracking++;
    try {
      return fn();
    } finally {
      this._tracking--;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    if (this._listeners.size === 1 && this._source?.subscribe) this._offNative = this._source.subscribe(() => {
      if (!this._tracking) this._bump();
    });
    return () => {
      if (!this._listeners.delete(listener) || this._listeners.size) return;
      this._offNative?.();
      this._offNative = undefined;
    };
  };

  version = (): number => this._version;

  /** 注册表当前的全部条目（适配器未提供 `list` 时为空）。 */
  list = (): readonly T[] => {
    if (this._snapshot?.version === this._version) return this._snapshot.list;
    const list = this._source?.list ? Object.freeze([...this._source.list()]) : (EMPTY as readonly T[]);
    this._snapshot = { version: this._version, list };
    return list;
  };

  get(key: string): T | undefined {
    return this._source?.get?.(key);
  }

  private _bump(): void {
    this._version++;
    for (const fn of [...this._listeners]) fn();
  }
}
