import React from 'react';
import { cn } from '@/lib/utils';
import type { CurrentView } from '@/types/navigation';

/**
 * ViewLayerRenderer Props
 */
export interface ViewLayerRendererProps {
  view: CurrentView;
  currentView: CurrentView;
  /** 已访问视图集合（Set 或 Map 均可，仅需 .has() 方法） */
  visitedViews: { has(view: CurrentView): boolean };
  children: React.ReactNode;
  extraClass?: string;
  extraStyle?: React.CSSProperties;
}

/**
 * ViewLayerRenderer 组件
 * 用于渲染单个视图层，支持 keep-alive 和性能优化
 * 从 App.tsx 抽取
 */
export function ViewLayerRenderer({
  view,
  currentView,
  visitedViews,
  children,
  extraClass,
  extraStyle,
}: ViewLayerRendererProps) {
  // 🚀 性能优化：只渲染已访问过的页面，未访问的页面完全不挂载
  if (!visitedViews.has(view)) {
    return null;
  }

  return (
    <div
      className={cn(
        'page-container absolute inset-0 flex flex-col',
        extraClass,
        currentView === view ? 'opacity-100 z-10 pointer-events-auto' : 'opacity-0 z-0 pointer-events-none'
      )}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        ...extraStyle,
        ...(currentView !== view ? {
          visibility: 'hidden' as const,
          contentVisibility: 'hidden',
        } : {})
      }}
    >
      {children}
    </div>
  );
}
