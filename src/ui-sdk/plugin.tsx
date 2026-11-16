/**
 * SDK 的定义与贡献辅助函数（零逻辑包装，行为全部在 ui-kernel）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Component as ReactComponent, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

/** A plugin-owned layer above the app for transient UI that no slot renders. */
export interface PluginOverlay {
  /** Replace the layer's content; `null` clears it. Ignored after the plugin unloaded. */
  render(node: ReactNode | null): void;
  /** Remove the layer now (it is also removed when the plugin unloads). */
  dispose(): void;
}

class OverlayBoundary extends ReactComponent<{ onError: (error: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { this.props.onError(error); }
  override render() { return this.state.failed ? null : this.props.children; }
}

/**
 * 插件自己的浮层：给没有槽位承载的临时界面用（选区旁的小卡片、一次性的提示）。内容用 `position: fixed` 自己定位；
 * 浮层本身不占位置、不拦截指针，所以不会挡住编辑器。内容带插件作用域（`useT` 等 hook 可用），渲染出错计入
 * 插件错误预算并清空浮层；插件卸载时浮层随之移除。
 */
export function createPluginOverlay(ctx: Context): PluginOverlay {
  const ui = ctx.ui;
  const plugin = ui.plugin;
  if (!plugin) throw new Error('createPluginOverlay: call it inside a UI plugin apply()');
  let host: HTMLDivElement | undefined;
  let root: Root | undefined;
  let closed = false;
  let generation = 0;
  const dispose = () => {
    closed = true;
    root?.unmount();
    host?.remove();
    root = undefined;
    host = undefined;
  };
  ctx.effect(() => dispose, 'ui.overlay');
  return {
    render(node) {
      if (closed) return;
      if (node === null) { root?.render(null); return; }
      if (!host) {
        host = document.createElement('div');
        host.dataset.pluginOverlay = plugin.id;
        // Zero-sized and above popovers: fixed-position children are placed against the viewport.
        host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:var(--z-popover, 3100);';
        document.body.appendChild(host);
        root = createRoot(host);
      }
      const onError = (error: unknown) => {
        // A fresh boundary for the next render; updates in between keep the content's state.
        generation++;
        root?.render(null);
        try { ui.reportError(error, { slot: 'overlay' }); }
        catch (reportFailure) { console.error('[ui-sdk] plugin overlay error after unload', reportFailure, error); }
      };
      // The layer is its own React root: `scoped` connects it to the kernel and to this plugin's scope.
      root!.render(ui.scoped(<OverlayBoundary key={generation} onError={onError}>{node}</OverlayBoundary>));
    },
    dispose,
  };
}
