/**
 * SDK 的定义与贡献辅助函数（零逻辑包装，行为全部在 ui-kernel）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import { defineUiPlugin, type UiPlugin, type UiPluginMeta } from '../ui-kernel/kernel';
import type { OpenSlotName, SlotMap, SlotName, SlotValue } from '../ui-kernel/slot-map';
import type { SlotCardinality, SlotContribution, SlotDefinition } from '../ui-kernel/slots';
import { UiPluginScopeProvider } from '../ui-kernel/react';
import type { PluginStore, PluginStoreInit, PluginStoreOptions } from '../ui-kernel/services/store';

export interface PluginSpec<C = void> extends Omit<UiPlugin<C>, 'name' | 'meta'> {
  name?: string;
  /** v2 meta；`apiVersion` 缺省为 2。 */
  meta: Omit<UiPluginMeta, 'apiVersion'> & { apiVersion?: 2 };
}

/** v2 插件入口：等同 `defineUiPlugin`，并把 `meta.apiVersion` 缺省为 2。 */
export function definePlugin<C = void>(spec: PluginSpec<C>): UiPlugin<C> {
  return defineUiPlugin<C>({ ...spec, meta: { apiVersion: 2, ...spec.meta } });
}

/** 框架插件声明槽位：`ctx.ui.declareSlot(defineSlot('dashboard.widgets', 'list', '仪表盘小部件'))`。 */
export function defineSlot<K extends string>(name: K, cardinality: SlotCardinality, description?: string): SlotDefinition & { name: K } {
  return { name, cardinality, description };
}

/** 一条带槽位名的贡献（静态表用）；已登记在 SlotMap 的槽位在定义处就做形状检查。 */
export interface SlotContributionOf<K extends string> {
  slot: K;
  contribution: SlotContribution<SlotValue<K>>;
}

export function contribution<K extends SlotName>(slot: K, value: SlotContribution<SlotMap[K]>): SlotContributionOf<K>;
export function contribution<T = unknown, S extends string = string>(slot: OpenSlotName<S>, value: SlotContribution<T>): SlotContributionOf<S>;
export function contribution(slot: string, value: SlotContribution<unknown>): SlotContributionOf<string> {
  return { slot, contribution: value };
}

/** 在 `apply` 里登记一组贡献；它们随插件卸载撤销。 */
export function contributeAll(ctx: Context, items: readonly SlotContributionOf<string>[]): void {
  for (const { slot, contribution: value } of items) ctx.ui.contribute(slot as OpenSlotName<string>, value);
}

/** 插件状态（zustand store），归插件所有：卸载即重置并断开订阅。等同 `ctx.ui.createStore`。 */
export function createPluginStore<T>(ctx: Context, init: PluginStoreInit<T>, options?: PluginStoreOptions<T>): PluginStore<T> {
  return ctx.ui.createStore(init, options);
}

/**
 * 把组件标记为属于调用方插件，使其中的 `useT` / `usePluginStorage` 等 hook 可用。
 * 由 `<SlotOutlet>` 渲染的贡献已自动具备；交给不经 SlotOutlet 的官方消费方（例如视图层）时用它包一层。
 */
export function withPluginScope<P extends object>(ctx: Context, Component: ComponentType<P>): ComponentType<P> {
  const plugin = ctx.ui.plugin;
  if (!plugin) throw new Error('withPluginScope: call it inside a UI plugin apply()');
  const value = { id: plugin.id, origin: plugin.origin };
  function Scoped(props: P) {
    return (
      <UiPluginScopeProvider value={value}>
        <Component {...props} />
      </UiPluginScopeProvider>
    );
  }
  Scoped.displayName = `withPluginScope(${Component.displayName ?? Component.name ?? 'Component'})`;
  return Scoped;
}
