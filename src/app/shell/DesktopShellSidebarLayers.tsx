import React, { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type SidebarLayer = readonly [kind: string, content: React.ReactNode];

interface DesktopShellSidebarLayersProps {
  activeKind: string;
  layers: ReadonlyArray<SidebarLayer>;
}

const SidebarLayer = React.memo(function SidebarLayer({
  active,
  kind,
  children,
}: {
  active: boolean;
  kind: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    // React 18 does not support the boolean inert JSX prop. Set the DOM property
    // before paint so a kept-alive sidebar cannot retain focus or receive input.
    if (!active && layer.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    layer.inert = !active;
  }, [active]);

  return (
    <div
      ref={ref}
      hidden={!active}
      aria-hidden={!active}
      data-sidebar-layer={kind}
      className={cn('h-full w-full', active && 'desktop-shell-content-enter')}
      style={!active ? { contentVisibility: 'hidden' } : undefined}
    >
      {children}
    </div>
  );
});

/** Mount each sidebar on first visit, then keep its data and local UI state. */
export const DesktopShellSidebarLayers = React.memo(function DesktopShellSidebarLayers({
  activeKind,
  layers,
}: DesktopShellSidebarLayersProps) {
  const [visited, setVisited] = useState(() => new Set([activeKind]));
  // Local render-time adjustment avoids an effect causing a second App render.
  if (!visited.has(activeKind)) {
    setVisited(new Set([...visited, activeKind]));
  }

  return (
    <>
      {layers.map(([kind, content]) => (
        visited.has(kind) || kind === activeKind
          ? <SidebarLayer key={kind} kind={kind} active={kind === activeKind}>{content}</SidebarLayer>
          : null
      ))}
    </>
  );
});
