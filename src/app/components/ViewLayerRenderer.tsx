import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { CurrentView } from '@/types/navigation';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ViewErrorFallback } from '@/components/ViewErrorFallback';
import { prefersReducedMotion } from '@/styles/motion-springs';
import { readCssDurationMs } from '@/hooks/useMotionPresence';

export interface ViewLayerRendererProps {
  view: CurrentView;
  currentView: CurrentView;
  visitedViews: { has(view: CurrentView): boolean };
  children: React.ReactNode;
  extraClass?: string;
  extraStyle?: React.CSSProperties;
  errorBoundaryName?: string;
  /** Keep the view visible as a non-interactive backdrop while settings is open. */
  isBackdrop?: boolean;
  /** Skip the enter animation once (legacy; prefer paired enter/exit). */
  suppressEnterAnimation?: boolean;
}

export const ViewLayerRenderer = React.memo(function ViewLayerRenderer({
  view,
  currentView,
  visitedViews,
  children,
  extraClass,
  extraStyle,
  errorBoundaryName,
  isBackdrop = false,
  suppressEnterAnimation = false,
}: ViewLayerRendererProps) {
  const isActive = currentView === view;
  const visited = visitedViews.has(view);
  const [exiting, setExiting] = useState(false);
  const wasActiveRef = useRef(isActive);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (wasActive && !isActive && !isBackdrop) {
      if (prefersReducedMotion()) {
        setExiting(false);
        return;
      }
      setExiting(true);
      const ms = readCssDurationMs('--page-slide-dur', 200);
      const timer = window.setTimeout(() => setExiting(false), ms);
      return () => window.clearTimeout(timer);
    }
    if (isActive) {
      setExiting(false);
    }
    return undefined;
  }, [isActive, isBackdrop]);

  if (!visited) {
    return null;
  }

  const content = errorBoundaryName ? (
    <ErrorBoundary
      name={errorBoundaryName}
      fallback={(error, _componentStack, reset) => (
        <ViewErrorFallback error={error} onRetry={reset} viewName={errorBoundaryName} />
      )}
    >
      {children}
    </ErrorBoundary>
  ) : children;
  const isVisible = isActive || isBackdrop || exiting;

  return (
    <div
      data-view-layer-shell={view}
      className={cn(
        'page-container desktop-shell-view-layer absolute inset-0 flex flex-col',
        extraClass,
        isActive
          ? `${suppressEnterAnimation ? '' : 'desktop-shell-content-enter'} opacity-100 z-10 pointer-events-auto`
          : isBackdrop
          ? 'opacity-100 z-0 pointer-events-none'
          : exiting
            ? 'desktop-shell-content-exit z-[9] pointer-events-none'
            : 'opacity-0 z-0 pointer-events-none'
      )}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        ...extraStyle,
        ...(!isVisible ? {
          visibility: 'hidden' as const,
          contentVisibility: 'hidden',
        } : {})
      }}
    >
      {content}
    </div>
  );
}, (prev, next) => {
  const prevActive = prev.currentView === prev.view;
  const nextActive = next.currentView === next.view;
  if (prevActive !== nextActive) return false;

  if (prev.isBackdrop !== next.isBackdrop) return false;
  if (prev.suppressEnterAnimation !== next.suppressEnterAnimation) return false;

  const prevVisited = prev.visitedViews.has(prev.view);
  const nextVisited = next.visitedViews.has(next.view);
  if (prevVisited !== nextVisited) return false;

  if (prev.children !== next.children) return false;
  if (prev.extraClass !== next.extraClass) return false;
  if (prev.extraStyle !== next.extraStyle) return false;

  return true;
});
