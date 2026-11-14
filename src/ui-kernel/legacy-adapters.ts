/**
 * 把应用现有的注册表适配为 `UiAdapters`（生产装配见 bootstrap.ts）。统一内核语义：
 * - 冲突即报错：同 key 已登记时拒绝，而不是旧注册表的“警告后覆盖”（插件只能新增条目，不能顶替别人的条目）；
 *   例外是登记与当前值同一个对象：这是官方插件认领模块导入时已登记的内置条目，不算冲突；
 * - 撤销只移除自己登记的那一份：若期间被别人覆盖，保留覆盖者；
 * - 提供 `list` / `get`，有原生订阅的转发 `subscribe`，供 `kernel.registries` 与 `useRegistry` 使用。
 *
 * 只依赖结构类型，不 import 业务模块，便于测试传入真实注册表实例。
 */
import type { UiAdapters, UiPluginOwner } from './kernel';

type Keyed<K extends string> = { [P in K]: string } & Record<string, unknown>;

export interface LegacyRegistries {
  commandRegistry: {
    register(command: never): () => void;
    unregister(id: string): void;
    getById(id: string): unknown;
    getAll(): readonly unknown[];
    subscribe(listener: (commands: readonly unknown[]) => void): () => void;
  };
  blockRegistry: KeyedLegacyRegistry;
  /** 对话事件处理器与模式（FE-B2）；缺省时 `ctx.ui.chat.registerEvent / registerMode` 不可用。 */
  eventRegistry?: KeyedLegacyRegistry;
  modeRegistry?: KeyedLegacyRegistry;
  appRegistry: {
    register(def: never): void;
    unregister(typeId: string, def?: never): boolean;
    get(typeId: string): unknown;
    list(): readonly unknown[];
    subscribe(listener: () => void): () => void;
  };
}

/** 对话注册表（`features/chat/registry/Registry.ts`）的结构。`register` 返回撤销函数且可订阅的是 FE-B2 起的实现。 */
export interface KeyedLegacyRegistry {
  register(key: string, plugin: never, owner?: string, origin?: UiPluginOwner['origin']): unknown;
  unregister(key: string): boolean;
  get(key: string): unknown;
  has(key: string): boolean;
  getAll(): Map<string, unknown>;
  subscribe?(listener: () => void): () => void;
}

const conflict = (what: string) => new Error(`${what} is already registered; use an id of your own`);

function keyedAdapter(registry: KeyedLegacyRegistry, what: string) {
  return {
    register: (key: string, value: unknown, owner?: UiPluginOwner) => {
      if (registry.has(key) && registry.get(key) !== value) throw conflict(`${what} "${key}"`);
      const revoke = registry.register(key, value as never, owner?.id, owner?.origin);
      return () => {
        if (typeof revoke === 'function') revoke();
        else if (registry.get(key) === value) registry.unregister(key);
      };
    },
    subscribe: registry.subscribe ? (listener: () => void) => registry.subscribe!(listener) : undefined,
    list: () => [...registry.getAll().values()],
    get: (key: string) => registry.get(key),
  };
}

export function createLegacyRegistryAdapters({ commandRegistry, blockRegistry, appRegistry, eventRegistry, modeRegistry }: LegacyRegistries): Required<Pick<UiAdapters, 'commands' | 'chatBlocks' | 'workbenchApps'>> & Pick<UiAdapters, 'chatEvents' | 'chatModes'> {
  return {
    commands: {
      register: (command: Keyed<'id'>) => {
        if (commandRegistry.getById(command.id)) throw conflict(`command "${command.id}"`);
        commandRegistry.register(command as never);
        return () => {
          if (commandRegistry.getById(command.id) === command) commandRegistry.unregister(command.id);
        };
      },
      subscribe: (listener) => commandRegistry.subscribe(() => listener()),
      list: () => commandRegistry.getAll() as readonly Keyed<'id'>[],
      get: (id) => commandRegistry.getById(id) as Keyed<'id'> | undefined,
    },
    chatBlocks: keyedAdapter(blockRegistry, 'chat block type'),
    ...(eventRegistry ? { chatEvents: keyedAdapter(eventRegistry, 'chat event type') } : {}),
    ...(modeRegistry ? { chatModes: keyedAdapter(modeRegistry, 'chat mode') } : {}),
    workbenchApps: {
      register: (def: Keyed<'typeId'>) => {
        if (appRegistry.get(def.typeId)) throw conflict(`workbench app "${def.typeId}"`);
        appRegistry.register(def as never);
        return () => void appRegistry.unregister(def.typeId, def as never);
      },
      subscribe: (listener) => appRegistry.subscribe(listener),
      list: () => appRegistry.list() as readonly Keyed<'typeId'>[],
      get: (typeId) => appRegistry.get(typeId) as Keyed<'typeId'> | undefined,
    },
  };
}
