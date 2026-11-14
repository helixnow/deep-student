/**
 * `views` 槽位的两种贡献（`contracts/shell.ts`）：普通视图直接带 `component`，懒视图带 `load()`。
 * W38 消费时用 {@link resolveShellViewComponent} 取组件，不要再维护 `contentKey` → 内容的静态映射。
 */
import { lazy, type ComponentType } from 'react';
import type { LazyShellView, ShellViewContribution, ShellViewModule, ShellViewProps } from './contracts/shell';
import type { SlotEntry } from './slots';

/** 是否是首次激活才加载的视图。 */
export function isLazyShellView(view: ShellViewContribution): view is LazyShellView {
  return typeof (view as LazyShellView | undefined)?.load === 'function';
}

/** 同一个 `load` 恒等返回同一个组件：重复渲染不会重建 `React.lazy`（否则每次都是新的 Suspense 边界）。 */
const lazyComponents = new WeakMap<LazyShellView['load'], ComponentType<ShellViewProps>>();

/** 懒视图的组件：按 `load` 缓存的 `React.lazy`，宿主放在 `<Suspense>` 里渲染。 */
export function lazyShellViewComponent(load: LazyShellView['load']): ComponentType<ShellViewProps> {
  const existing = lazyComponents.get(load);
  if (existing) return existing;
  const component = lazy(async () => {
    const module = await load();
    if (!module || typeof module.default !== 'function' && typeof module.default !== 'object') {
      throw new TypeError('lazy view module must default-export a React component');
    }
    return module as ShellViewModule;
  });
  lazyComponents.set(load, component);
  return component;
}

/**
 * `views` 条目的组件：普通视图原样返回 `view.component`；懒视图返回缓存的 `React.lazy`。
 * 宿主在 `<Suspense fallback={…}>` 内渲染它即可，视觉与今天的 `PageLoadingFallback` 一致。
 */
export function resolveShellViewComponent(view: ShellViewContribution): ComponentType<ShellViewProps> {
  return isLazyShellView(view) ? lazyShellViewComponent(view.load) : view.component;
}

/**
 * 用户重试时撤销该 load 的 React.lazy 缓存（包括缓存的 rejection）。同步、不调用 load、不影响其它视图；
 * 宿主随后重新 resolve 并渲染新组件。普通视图无操作，同一 load 的多个条目共享失效。
 */
export function invalidateShellViewComponent(view: ShellViewContribution): void {
  if (isLazyShellView(view)) lazyComponents.delete(view.load);
}

/**
 * 一组 `views` 条目 → 视图 id 到组件的映射（按 order 无关；同 id 由槽位自身的覆盖规则决定）。
 * 只给需要按 id 查找组件的宿主使用，不产生新的订阅。
 */
export function shellViewComponents(entries: readonly SlotEntry<ShellViewContribution>[]): Map<string, ComponentType<ShellViewProps>> {
  return new Map(entries.map((entry) => [entry.key ?? entry.value.id, resolveShellViewComponent(entry.value)]));
}
