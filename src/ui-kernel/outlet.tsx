/**
 * `<SlotOutlet name="…">`：框架插件渲染槽位的统一组件（FRONTEND-PLUGINIZATION §2.3）。
 *
 * - 按槽位顺序渲染；值本身是组件、或带 `component` 字段时可直接渲染，否则传 `render`；
 * - 每条贡献单独包一层错误边界：出错只把它自己替换为 `fallback`，兄弟条目照常渲染，并上报内核错误预算；
 * - 社区贡献外包 `<div data-ds-plugin=<id> style="display: contents">` 作为样式作用域；官方贡献不加任何 DOM；
 * - 每条贡献外提供插件作用域，组件内的 `useT` / `usePluginStorage` 等 hook 据此找到所属插件；
 * - 无 Provider 的轻量窗口渲染 `entries` 静态表（F1 §6.1）。
 */
import React, { createElement, Suspense, useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import type { SlotEntry } from './slots';
import type { SlotValue } from './slot-map';
import type { UiKernel } from './kernel';
import { UiPluginScopeProvider, useOptionalSlot, useOptionalUiKernel, type UiPluginScopeValue } from './react';

export interface SlotOutletErrorInfo<V> {
  entry: SlotEntry<V>;
  error: unknown;
  phase: 'render' | 'filter';
}

export interface SlotOutletProps<K extends string> {
  name: K;
  /** 渲染一条贡献；缺省时渲染值本身（组件）或值的 `component` 字段，并传入 `props`。 */
  render?: (entry: SlotEntry<SlotValue<K>>, index: number) => ReactNode;
  /** 缺省渲染时传给贡献组件的 props。 */
  props?: object;
  /** 可见性过滤；对某条贡献抛错时该条被隐藏并上报。 */
  filter?: (entry: SlotEntry<SlotValue<K>>) => boolean;
  /** 单条贡献渲染失败时的替代内容，缺省为空。 */
  fallback?: ReactNode | ((info: SlotOutletErrorInfo<SlotValue<K>>) => ReactNode);
  /** 没有可显示的贡献时渲染。 */
  empty?: ReactNode;
  /** 给出时每条贡献包一层 Suspense（懒加载组件）。 */
  suspense?: ReactNode;
  /** 无 `<UiKernelProvider>` 时使用的静态条目（轻量窗口）。 */
  entries?: readonly SlotEntry<SlotValue<K>>[];
  onError?: (info: SlotOutletErrorInfo<SlotValue<K>>) => void;
}

const EMPTY: readonly SlotEntry<never>[] = Object.freeze([] as SlotEntry<never>[]);
const COMMUNITY_SCOPE_STYLE = { display: 'contents' } as const;
const scopeValues = new WeakMap<SlotEntry<unknown>, UiPluginScopeValue>();

function scopeValueOf(entry: SlotEntry<unknown>): UiPluginScopeValue {
  let value = scopeValues.get(entry);
  if (!value) scopeValues.set(entry, (value = { id: entry.owner, origin: entry.origin }));
  return value;
}

function isComponent(value: unknown): value is ComponentType<object> {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

function renderDefault(slot: string, entry: SlotEntry<unknown>, props: object | undefined): ReactNode {
  const value = entry.value;
  if (isComponent(value)) return createElement(value, props);
  const component = (value as { component?: unknown } | null)?.component;
  if (isComponent(component)) return createElement(component, props);
  throw new Error(`SlotOutlet: entry "${entry.id}" in "${slot}" is not renderable; pass a render prop`);
}

function report(kernel: UiKernel | null, slot: string, entry: SlotEntry<unknown>, phase: 'render' | 'filter', error: unknown): void {
  if (kernel) kernel.errors.report({ pluginId: entry.owner, origin: entry.origin, phase, slot, entryId: entry.id, error });
  else console.error(`[ui-plugins] ${entry.owner} failed (${phase} in ${slot}):`, error);
}

interface BoundaryProps {
  slot: string;
  entry: SlotEntry<unknown>;
  kernel: UiKernel | null;
  fallback?: SlotOutletProps<string>['fallback'];
  onError?: SlotOutletProps<string>['onError'];
  children: ReactNode;
}

interface BoundaryState {
  entry: SlotEntry<unknown>;
  failure: { error: unknown } | null;
}

class ContributionBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { entry: props.entry, failure: null };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.entry !== state.entry ? { entry: props.entry, failure: null } : null;
  }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failure: { error } };
  }

  componentDidCatch(error: unknown): void {
    const { slot, entry, kernel, onError } = this.props;
    report(kernel, slot, entry, 'render', error);
    onError?.({ entry, error, phase: 'render' });
  }

  render(): ReactNode {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    const { fallback, entry } = this.props;
    return typeof fallback === 'function' ? fallback({ entry, error: failure.error, phase: 'render' }) : fallback ?? null;
  }
}

function EntryContent({ slot, entry, index, render, props }: {
  slot: string;
  entry: SlotEntry<unknown>;
  index: number;
  render?: (entry: SlotEntry<unknown>, index: number) => ReactNode;
  props?: object;
}): ReactNode {
  return render ? render(entry, index) : renderDefault(slot, entry, props);
}

export function SlotOutlet<K extends string>(outlet: SlotOutletProps<K>): ReactNode {
  const { name, filter, empty, suspense, onError } = outlet;
  const kernel = useOptionalUiKernel();
  const live = useOptionalSlot(name) as readonly SlotEntry<unknown>[] | undefined;
  const entries = live ?? (outlet.entries as readonly SlotEntry<unknown>[] | undefined) ?? EMPTY;

  const failedFilters: { entry: SlotEntry<unknown>; error: unknown }[] = [];
  const visible = filter
    ? entries.filter((entry) => {
        try {
          return (filter as (e: SlotEntry<unknown>) => boolean)(entry);
        } catch (error) {
          failedFilters.push({ entry, error });
          return false;
        }
      })
    : entries;

  // 过滤器的错误在提交后上报（渲染期间不触发其他组件更新），同一条目每个 outlet 实例只报一次。
  const reported = useRef(new WeakSet<SlotEntry<unknown>>());
  useEffect(() => {
    for (const { entry, error } of failedFilters) {
      if (reported.current.has(entry)) continue;
      reported.current.add(entry);
      report(kernel, name, entry, 'filter', error);
      (onError as SlotOutletProps<string>['onError'])?.({ entry, error, phase: 'filter' });
    }
  });

  if (!visible.length) return empty ?? null;
  return visible.map((entry, index) => {
    let node: ReactNode = (
      <EntryContent slot={name} entry={entry} index={index} render={outlet.render as never} props={outlet.props} />
    );
    if (suspense !== undefined) node = <Suspense fallback={suspense}>{node}</Suspense>;
    node = (
      <ContributionBoundary slot={name} entry={entry} kernel={kernel} fallback={outlet.fallback as never} onError={onError as never}>
        {node}
      </ContributionBoundary>
    );
    if (entry.origin !== 'builtin') {
      node = <div data-ds-plugin={entry.owner} data-ds-slot={name} style={COMMUNITY_SCOPE_STYLE}>{node}</div>;
    }
    return (
      <UiPluginScopeProvider key={`${entry.owner}\u0000${entry.id}`} value={scopeValueOf(entry)}>
        {node}
      </UiPluginScopeProvider>
    );
  });
}
