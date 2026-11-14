import type { ComponentType, ReactNode } from 'react';

export interface ShellVisibilityContext {
  dev: boolean;
  uiLabEnabled: boolean;
}

export interface ViewShell {
  sidebarKind?: 'main' | 'settings' | 'todo' | 'desktop-page';
  pageBackButton?: boolean;
  sidebarOwnsBackNavigation?: boolean;
  hideExpandedSidebarToggle?: boolean;
  toolbarSlot?: string;
  chatHeader?: boolean;
  cardsHubTabs?: boolean;
  contentClass?: string;
  mobileBackToHome?: boolean;
}

/** Official contents retain their existing memoized elements and lazy boundaries. */
export interface ShellViewProps { content?: ReactNode }

export interface ShellView {
  id: string;
  titleKey: string;
  component: ComponentType<ShellViewProps>;
  contentKey?: string;
  order?: number;
  keepAlive?: boolean;
  extraClass?: string;
  visible?: (context: ShellVisibilityContext) => boolean;
  allowInDemo?: boolean;
  shell?: ViewShell;
}

/** What a lazy view's `load()` resolves to (the same shape as a dynamic import). */
export interface ShellViewModule {
  default: ComponentType<ShellViewProps>;
}

/**
 * A view whose component loads on first activation (W38). Hosts render it wherever they render
 * `ShellView.component`, inside a `<Suspense>` boundary; `load` is called at most once per entry.
 */
export interface LazyShellView extends Omit<ShellView, 'component'> {
  component?: never;
  load(): Promise<ShellViewModule>;
}

/** What the `views` slot holds: an eager view, or the same view with a lazy component factory. */
export type ShellViewContribution = ShellView | LazyShellView;

export interface ShellNavLabel { key: string; fallback: string }

export interface ShellNavItem {
  id: string;
  viewId: string;
  order?: number;
  labelKey: string;
  fallback?: string;
  icon?: ComponentType<any>;
  visible?: (context: ShellVisibilityContext) => boolean;
  desktop?: {
    placement?: 'primary' | 'settings';
    chatScope?: boolean;
    action?: 'new-session';
    /** Desktop chat deliberately translates without the factory fallback. */
    omitFallback?: boolean;
  };
  mobile?: {
    placement?: 'launcher' | 'settings';
    label?: ShellNavLabel;
    ariaLabel?: ShellNavLabel;
    icon?: ComponentType<any>;
  };
}

declare module '../slot-map' {
  interface SlotMap {
    views: ShellViewContribution;
    nav: ShellNavItem;
  }
}
