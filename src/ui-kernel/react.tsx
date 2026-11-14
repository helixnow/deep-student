/**
 * slot 的 React 适配：官方界面里需要渲染扩展点的地方使用这些 hook / 组件。
 * 插件贡献的组件本身不需要用它们（只接收派生 props，见 FRONTEND.md §4）。
 *
 * v2 另提供插件组件可用的服务 hook（`useT`、`usePlatform`、`useNavigate`、`usePluginStorage`、`usePluginStore`）：
 * 它们经 `UiPluginScopeProvider` 找到组件所属的插件；`<SlotOutlet>` 会为每条贡献自动提供。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { SlotEntry } from './slots';
import type { SlotMap, SlotName } from './slot-map';
import type { UiKernel, UiPluginOrigin } from './kernel';
import type { UiPluginErrorReport } from './services/errors';
import { useScopedTranslator, type UiTranslate } from './services/i18n';
import type { UiPlatformInfo } from './services/platform';
import type { PluginStore } from './services/store';
import type { UiRegistryKind } from './registries';

const UiKernelContext = createContext<UiKernel | null>(null);

export function UiKernelProvider({ kernel, children }: { kernel: UiKernel; children: ReactNode }) {
  return <UiKernelContext.Provider value={kernel}>{children}</UiKernelContext.Provider>;
}

export function useUiKernel(): UiKernel {
  const kernel = useContext(UiKernelContext);
  if (!kernel) throw new Error('useUiKernel: missing <UiKernelProvider>');
  return kernel;
}

/** 无 Provider（轻量窗口）时为 null。 */
export function useOptionalUiKernel(): UiKernel | null {
  return useContext(UiKernelContext);
}

/** 订阅某个 slot 的全部贡献（按 order 排序；引用在无变化时稳定）。已登记在 SlotMap 的槽位按其值类型推断。 */
export function useSlot<K extends SlotName>(name: K): readonly SlotEntry<SlotMap[K]>[];
export function useSlot<T = unknown>(name: string): readonly SlotEntry<T>[];
export function useSlot(name: string): readonly SlotEntry<unknown>[] {
  const entries = useOptionalSlot(name);
  if (!entries) throw new Error('useUiKernel: missing <UiKernelProvider>');
  return entries;
}

const noSubscription = () => () => {};
const noKernelSnapshot = () => undefined;

/** F1 §6.1: lightweight windows use the same official static table when no Provider exists.
 * undefined means no Provider; an installed but empty slot remains [] (no fallback on unload).
 */
export function useOptionalSlot<K extends SlotName>(name: K): readonly SlotEntry<SlotMap[K]>[] | undefined;
export function useOptionalSlot<T = unknown>(name: string): readonly SlotEntry<T>[] | undefined;
export function useOptionalSlot(name: string): readonly SlotEntry<unknown>[] | undefined {
  const kernel = useContext(UiKernelContext);
  const subscribe = useSlotSubscription(kernel, name);
  const snapshot = kernel ? () => kernel.slots.list(name) : noKernelSnapshot;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** keyed slot 中某个 key 的贡献；同一 slot 里其他 key 的变化不会让它重渲染。 */
export function useSlotEntry<K extends SlotName>(name: K, key: string): SlotEntry<SlotMap[K]> | undefined;
export function useSlotEntry<T = unknown>(name: string, key: string): SlotEntry<T> | undefined;
export function useSlotEntry(name: string, key: string): SlotEntry<unknown> | undefined {
  const kernel = useContext(UiKernelContext);
  if (!kernel) throw new Error('useUiKernel: missing <UiKernelProvider>');
  const subscribe = useSlotSubscription(kernel, name);
  const snapshot = () => kernel.slots.get(name, key);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function useSlotSubscription(kernel: UiKernel | null, name: string): (fn: () => void) => () => void {
  return useCallback((fn: () => void) => (kernel ? kernel.slots.subscribe(name, fn) : noSubscription()), [kernel, name]);
}

// ------------------------------------------------------------------ 插件作用域与服务 hook

export interface UiPluginScopeValue {
  id: string;
  origin: UiPluginOrigin;
}

const UiPluginScopeContext = createContext<UiPluginScopeValue | null>(null);

/** 声明子树属于哪个插件。`<SlotOutlet>` 为每条贡献自动提供；插件自己渲染的子树可用 SDK 的 `withPluginScope`。 */
export function UiPluginScopeProvider({ value, children }: { value: UiPluginScopeValue; children: ReactNode }) {
  return <UiPluginScopeContext.Provider value={value}>{children}</UiPluginScopeContext.Provider>;
}

/** 当前组件所属的插件；不在插件子树内时为 null。 */
export function usePluginScope(): UiPluginScopeValue | null {
  return useContext(UiPluginScopeContext);
}

function useRequiredScope(hook: string): { kernel: UiKernel; pluginId: string } {
  const kernel = useContext(UiKernelContext);
  const scope = useContext(UiPluginScopeContext);
  if (!kernel) throw new Error(`${hook}: missing <UiKernelProvider>`);
  if (!scope) throw new Error(`${hook}: must be used inside a plugin contribution (<SlotOutlet>) or withPluginScope`);
  return { kernel, pluginId: scope.id };
}

/** 绑定所属插件命名空间的 `t`；语言或语言包变化时重渲染。插件卸载后返回键名。 */
export function useT(): UiTranslate {
  const { kernel, pluginId } = useRequiredScope('useT');
  return useScopedTranslator(kernel.i18n, kernel.scope(pluginId));
}

/** 当前平台（外壳补全 os / capabilities 时重渲染）。 */
export function usePlatform(): UiPlatformInfo {
  const kernel = useUiKernel();
  const subscribe = useCallback((fn: () => void) => kernel.platform.subscribe(fn), [kernel]);
  const snapshot = () => kernel.platform.current;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 以所属插件为来源的导航函数（不在插件子树内时来源为 `ui-kernel`）。 */
export function useNavigate(): (view: string, params?: Readonly<Record<string, unknown>>) => void {
  const kernel = useUiKernel();
  const source = useContext(UiPluginScopeContext)?.id ?? 'ui-kernel';
  return useCallback((view, params) => kernel.navigation.navigate(source, view, params), [kernel, source]);
}

/** 所属插件的一个持久化值：`[value, setValue]`，其他组件或 `ctx.ui.storage` 写入时同步更新。 */
export function usePluginStorage<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const { kernel, pluginId } = useRequiredScope('usePluginStorage');
  const scope = kernel.scope(pluginId);
  if (!scope) throw new Error(`usePluginStorage: plugin "${pluginId}" is not installed`);
  const cell = useMemo(() => kernel.storage.open(scope).json(key, initial), [kernel, scope, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const version = useRef(0);
  const subscribe = useCallback((fn: () => void) => cell.subscribe(() => {
    version.current++;
    fn();
  }), [cell]);
  const snapshot = () => version.current;
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const value = useMemo(() => cell.get(), [cell, current]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, cell.set];
}

/** 订阅插件 store（`ctx.ui.createStore` / `createPluginStore` 的返回值）。 */
export function usePluginStore<T>(store: PluginStore<T>): T;
export function usePluginStore<T, U>(store: PluginStore<T>, selector: (state: T) => U): U;
export function usePluginStore<T, U>(store: PluginStore<T>, selector?: (state: T) => U): T | U {
  return useStore(store, selector ?? ((state: T) => state as unknown as U));
}

const noRegistry: readonly never[] = Object.freeze([] as never[]);

/**
 * 订阅适配器背后的旧注册表（命令、对话 block、工作台应用），返回当前全部条目；经内核的登记与撤销、
 * 以及有原生订阅的注册表上的直接登记都会触发重渲染。无 Provider 时为空表。
 */
export function useRegistry<T = unknown>(kind: UiRegistryKind): readonly T[] {
  const kernel = useContext(UiKernelContext);
  const registry = kernel?.registries[kind];
  const subscribe = useCallback((fn: () => void) => (registry ? registry.subscribe(fn) : () => {}), [registry]);
  const snapshot = () => (registry ? (registry.list() as readonly T[]) : noRegistry);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 注册表中某个 key 的条目（如 block type → 渲染插件）；登记或撤销时重渲染。 */
export function useRegistryEntry<T = unknown>(kind: UiRegistryKind, key: string): T | undefined {
  const kernel = useContext(UiKernelContext);
  const registry = kernel?.registries[kind];
  const subscribe = useCallback((fn: () => void) => (registry ? registry.subscribe(fn) : () => {}), [registry]);
  const version = () => (registry ? registry.version() : 0);
  const current = useSyncExternalStore(subscribe, version, version);
  return useMemo(() => registry?.get(key) as T | undefined, [registry, key, current]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** 错误预算的报告（插件管理页用）；省略 pluginId 时为全部插件。 */
export function usePluginErrors(pluginId?: string): readonly UiPluginErrorReport[] {
  const kernel = useUiKernel();
  const version = useSyncExternalStore(kernel.errors.subscribe, kernel.errors.version, kernel.errors.version);
  return useMemo(() => kernel.errors.list(pluginId), [kernel, pluginId, version]); // eslint-disable-line react-hooks/exhaustive-deps
}
