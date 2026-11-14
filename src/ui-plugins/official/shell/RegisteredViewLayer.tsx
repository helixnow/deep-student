import React, { Suspense, useMemo } from 'react';
import { ViewLayerRenderer, type ViewLayerRendererProps } from '@/app/components/ViewLayerRenderer';
import type { ShellView, ShellViewContribution, ShellViewProps } from '@/ui-kernel/contracts/shell';

/**
 * Keep children identity stable just as the original memoized App contents did.
 *
 * W38: 宿主把 `resolveShellViewComponent(entry)` 的结果经 `component` 传入（普通视图与
 * W17 的 `load()` 懒视图都归一成组件，同一 `load` 恒等）。插件目录因此不引用宿主或
 * SDK 运行时；不传 `component` 的旧用法（测试/急切条目）仍落到 `entry.component`。
 * 宿主提供 Suspense fallback，但边界位于层的显隐容器内，避免隐藏视图 pending 时覆盖当前页。
 */
export function RegisteredViewLayer({ entry, component, content, suspenseFallback, footerOverlay, ...props }: Omit<ViewLayerRendererProps, 'children'> & {
  entry: ShellViewContribution;
  /** 宿主已解析的组件；省略时使用急切条目的 `component`。 */
  component?: React.ComponentType<ShellViewProps>;
  content?: React.ReactNode;
  suspenseFallback?: React.ReactNode;
  footerOverlay?: React.ReactNode;
}) {
  const Component = component ?? (entry as ShellView).component;
  const children = useMemo(() => {
    const body = suspenseFallback === undefined
      ? <Component content={content} />
      : <Suspense fallback={suspenseFallback}><Component content={content} /></Suspense>;
    return footerOverlay ? (
      <div className="relative h-full min-h-0 flex-1 overflow-auto">
        {body}
        {footerOverlay}
      </div>
    ) : body;
  }, [Component, content, footerOverlay, suspenseFallback]);
  // ViewLayerRenderer already isolates errors for every view, including community ones.
  return <ViewLayerRenderer {...props}>{children}</ViewLayerRenderer>;
}
