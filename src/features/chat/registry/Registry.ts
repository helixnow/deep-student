/**
 * Chat V2 - 通用注册表基类
 *
 * 所有注册表（模式、块、事件）的基础实现：条目存放在 UI 内核的 slot 原语里（每个注册表一个 slot），
 * 带登记者（owner），可订阅。
 *
 * - 模块导入即登记的内置条目记在 `MODULE_OWNER` 名下；经 UI 内核（`ctx.ui.chat.*`）登记的条目记在插件 id 名下。
 * - 同一 key 可叠加多层，`get` 取最上层；撤销某一层后露出下层（插件卸载后回到内置实现）。
 * - `unregister(key)` 沿用旧语义：移除该 key 的全部层。
 */
import { SlotStore, type SlotEntry, type UiPluginOrigin } from '@/ui-kernel/slots';

interface RegistryOptions {
  warnOnOverwrite?: boolean;
}

/** 模块导入时直接登记（未经 UI 内核）的条目的 owner。 */
export const MODULE_OWNER = 'module';

/** 每个 key 当前生效的条目。 */
export interface RegistryEntry<T> {
  key: string;
  value: T;
  owner: string;
  origin: UiPluginOrigin;
}

/**
 * 通用注册表类
 * @template T 插件类型
 */
export class Registry<T> {
  private readonly slots = new SlotStore();
  private readonly slot: string;
  private readonly revokers = new Map<SlotEntry<T>, () => void>();
  private name: string;
  private warnOnOverwrite: boolean;
  private seq = 0;
  private index: Map<string, SlotEntry<T>> | undefined;
  private entryList: readonly RegistryEntry<T>[] | undefined;

  constructor(name: string, options: RegistryOptions = {}) {
    this.name = name;
    this.slot = name;
    this.warnOnOverwrite = options.warnOnOverwrite ?? true;
    this.slots.declare({ name: this.slot, cardinality: 'list' });
    this.slots.subscribe(() => {
      this.index = undefined;
      this.entryList = undefined;
    });
  }

  /** key → 最上层条目；插入顺序沿用 Map 语义（覆盖不改变位置）。 */
  private top(): Map<string, SlotEntry<T>> {
    if (!this.index) {
      const index = new Map<string, SlotEntry<T>>();
      for (const entry of this.slots.list<T>(this.slot)) index.set(entry.key!, entry);
      this.index = index;
    }
    return this.index;
  }

  /**
   * 注册插件
   * @param key 插件标识
   * @param plugin 插件实例
   * @param owner 登记者（插件 id）；缺省为模块导入登记
   * @returns 撤销函数：只移除本次登记的这一层
   */
  register(key: string, plugin: T, owner: string = MODULE_OWNER, origin: UiPluginOrigin = 'builtin'): () => void {
    const current = this.top().get(key);
    if (this.warnOnOverwrite && current && current.value !== plugin) {
      console.warn(`[${this.name}] Overwriting existing plugin: ${key}`);
    }
    const seq = ++this.seq;
    let entry: SlotEntry<T> | undefined;
    const revoke = this.slots.contribute<T>(this.slot, owner, { id: `${owner}#${seq}`, key, order: seq, value: plugin }, origin);
    entry = this.slots.list<T>(this.slot).find((e) => e.order === seq);
    if (entry) this.revokers.set(entry, revoke);
    return () => {
      if (!entry) return;
      const off = this.revokers.get(entry);
      this.revokers.delete(entry);
      entry = undefined;
      off?.();
    };
  }

  /**
   * 获取插件
   * @param key 插件标识
   * @returns 插件实例，不存在则返回 undefined
   */
  get(key: string): T | undefined {
    return this.top().get(key)?.value;
  }

  /**
   * 检查插件是否存在
   * @param key 插件标识
   */
  has(key: string): boolean {
    return this.top().has(key);
  }

  /**
   * 获取所有插件
   * @returns 插件 Map
   */
  getAll(): Map<string, T> {
    return new Map([...this.top()].map(([key, entry]) => [key, entry.value]));
  }

  /**
   * 获取所有插件键
   */
  keys(): string[] {
    return Array.from(this.top().keys());
  }

  /** 每个 key 当前生效的条目（含登记者）；无变化时引用稳定。 */
  entries(): readonly RegistryEntry<T>[] {
    if (!this.entryList) {
      this.entryList = Object.freeze([...this.top()].map(([key, { value, owner, origin }]) => ({ key, value, owner, origin })));
    }
    return this.entryList;
  }

  /** 订阅登记与撤销；返回取消函数。 */
  subscribe = (listener: () => void): (() => void) => {
    // 先让内部索引失效，再通知外部订阅者。
    const off = this.slots.subscribe(listener);
    return () => void off();
  };

  /**
   * 获取注册表名称
   */
  getName(): string {
    return this.name;
  }

  /**
   * 注销插件
   * @param key 插件标识
   * @returns 是否成功移除
   */
  unregister(key: string): boolean {
    const layers = this.slots.list<T>(this.slot).filter((e) => e.key === key);
    for (const entry of layers) {
      const off = this.revokers.get(entry);
      this.revokers.delete(entry);
      off?.();
    }
    return layers.length > 0;
  }

  /**
   * 清空注册表（仅用于测试）
   */
  clear(): void {
    for (const off of [...this.revokers.values()]) off();
    this.revokers.clear();
  }
}
