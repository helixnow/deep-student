/**
 * 类型化 slot：UI 扩展点的通用原语（docs/plugins/FRONTEND.md §4）。
 *
 * - `list`：多个贡献按 order（同序号再按 id 的码点顺序，与系统 locale 无关）排序后全部渲染，例如侧栏导航项。
 * - `keyed`：每个 key 至多一个贡献，例如"某种 block type 的渲染器"。同一个 key 由两个插件贡献会直接报错：
 *   插件只能新增，不能在 slot 层抢占别人的 key（社区插件也不能用官方插件的 id 顶替它）。
 * - `single`：整个 slot 至多一个贡献，例如"主页"。
 *
 * slot 本身与 React 无关；订阅接口供 `useSlot` 等适配层使用。快照按版本缓存，引用稳定。
 */
import type { SlotMap, SlotName } from './slot-map';

export type SlotCardinality = 'list' | 'keyed' | 'single';
/** Installation provenance, independent of a reusable plugin id (F1 §6.2). */
export type UiPluginOrigin = 'builtin' | 'community';

export interface SlotDefinition {
  name: string;
  cardinality: SlotCardinality;
  /** 给插件作者看的一句话说明。 */
  description?: string;
}

export interface SlotContribution<T> {
  /** 贡献 id（插件内唯一即可，建议 `<插件 id>/<名字>`）。 */
  id: string;
  /** keyed slot 的 key。 */
  key?: string;
  /** 越小越靠前，默认 0。 */
  order?: number;
  value: T;
}

export interface SlotEntry<T> extends Required<Omit<SlotContribution<T>, 'key'>> {
  key?: string;
  /** 贡献者插件 id。 */
  owner: string;
  /** Set by the installing kernel fiber, not by contribution metadata. */
  origin: UiPluginOrigin;
}

export class SlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotError';
  }
}

type Listener = () => void;

/**
 * Orders two strings by code point. Ties in `order` are broken with this rather than `localeCompare`, whose result
 * follows the system locale, so a slot lists the same entries in the same order on every machine.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

export class SlotStore {
  private readonly defs = new Map<string, SlotDefinition>();
  private readonly entries = new Map<string, SlotEntry<unknown>[]>();
  private readonly snapshots = new Map<string, { version: number; list: readonly SlotEntry<unknown>[] }>();
  /** 每个 slot 自己的版本：别的 slot 变化时快照引用不变，订阅方不必重渲染。 */
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly slotListeners = new Map<string, Set<Listener>>();

  declare(def: SlotDefinition): void {
    const existing = this.defs.get(def.name);
    if (existing && existing.cardinality !== def.cardinality) {
      throw new SlotError(`slot "${def.name}" is already declared as ${existing.cardinality}, cannot redeclare as ${def.cardinality}`);
    }
    this.defs.set(def.name, def);
  }

  definition(name: string): SlotDefinition | undefined {
    return this.defs.get(name);
  }

  definitions(): SlotDefinition[] {
    return [...this.defs.values()].sort((a, b) => compareCodePoints(a.name, b.name));
  }

  /** 添加贡献，返回撤销函数。 */
  contribute<T>(name: string, owner: string, contribution: SlotContribution<T>, origin: UiPluginOrigin = 'community'): () => void {
    const def = this.defs.get(name);
    if (!def) throw new SlotError(`slot "${name}" is not declared`);
    if (def.cardinality === 'keyed' && !contribution.key) throw new SlotError(`slot "${name}" is keyed: contribution "${contribution.id}" needs a key`);
    const list = this.entries.get(name) ?? [];
    if (list.some((e) => e.id === contribution.id && e.owner === owner)) {
      throw new SlotError(`slot "${name}": "${owner}" already contributed "${contribution.id}"`);
    }
    if (def.cardinality === 'keyed') {
      const clash = list.find((e) => e.key === contribution.key);
      if (clash) throw new SlotError(`slot "${name}" key "${contribution.key}" is already provided by "${clash.owner}" (${clash.id}); use a key of your own`);
    }
    if (def.cardinality === 'single' && list.length) {
      throw new SlotError(`slot "${name}" accepts a single contribution and already has one from "${list[0]!.owner}"`);
    }
    const entry: SlotEntry<T> = { id: contribution.id, key: contribution.key, order: contribution.order ?? 0, value: contribution.value, owner, origin };
    list.push(entry as SlotEntry<unknown>);
    list.sort((a, b) => a.order - b.order || compareCodePoints(a.id, b.id));
    this.entries.set(name, list);
    this.bump(name);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const cur = this.entries.get(name) ?? [];
      const i = cur.indexOf(entry as SlotEntry<unknown>);
      if (i >= 0) cur.splice(i, 1);
      this.bump(name);
    };
  }

  /** 按顺序的全部贡献；引用在无变化时保持稳定。已登记在 SlotMap 的槽位按其值类型推断。 */
  list<K extends SlotName>(name: K): readonly SlotEntry<SlotMap[K]>[];
  list<T = unknown>(name: string): readonly SlotEntry<T>[];
  list(name: string): readonly SlotEntry<unknown>[] {
    const version = this.versions.get(name) ?? 0;
    const cached = this.snapshots.get(name);
    if (cached && cached.version === version) return cached.list;
    const list = Object.freeze([...(this.entries.get(name) ?? [])]);
    this.snapshots.set(name, { version, list });
    return list;
  }

  get<K extends SlotName>(name: K, key: string): SlotEntry<SlotMap[K]> | undefined;
  get<T = unknown>(name: string, key: string): SlotEntry<T> | undefined;
  get(name: string, key: string): SlotEntry<unknown> | undefined {
    return this.list(name).find((e) => e.key === key);
  }

  /** 订阅全部 slot 的变化；给出 slot 名时只在该 slot 变化时通知（渲染层应使用这一种）。 */
  subscribe(fn: Listener): () => void;
  subscribe(name: string, fn: Listener): () => void;
  subscribe(nameOrFn: string | Listener, maybeFn?: Listener): () => void {
    if (typeof nameOrFn === 'function') {
      this.listeners.add(nameOrFn);
      return () => this.listeners.delete(nameOrFn);
    }
    const fn = maybeFn!;
    let set = this.slotListeners.get(nameOrFn);
    if (!set) this.slotListeners.set(nameOrFn, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size && this.slotListeners.get(nameOrFn) === set) this.slotListeners.delete(nameOrFn);
    };
  }

  private bump(name: string): void {
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
    const scoped = this.slotListeners.get(name);
    if (scoped) for (const fn of [...scoped]) fn();
    for (const fn of [...this.listeners]) fn();
  }
}
