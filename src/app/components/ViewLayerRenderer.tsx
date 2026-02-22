import React from 'react';
import { cn } from '@/lib/utils';
import type { CurrentView } from '@/types/navigation';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export interface ViewLayerRendererProps {
  view: CurrentView;
  currentView: CurrentView;
  visitedViews: { has(view: CurrentView): boolean };
  children: React.ReactNode;
  extraClass?: string;
  extraStyle?: React.CSSProperties;
  errorBoundaryName?: string;
}

export function ViewLayerRenderer({
  view,
  currentView,
  visitedViews,
  children,
  extraClass,
  extraStyle,
  errorBoundaryName,
}: ViewLayerRendererProps) {
  if (!visitedViews.has(view)) {
    return null;
  }

  const content = errorBoundaryName ? (
    <ErrorBoundary name={errorBoundaryName}>
      {children}
    </ErrorBoundary>
  ) : children;

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
      {content}
    </div>
  );
}
