import React, { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/styles/motion-springs';

type SidebarLayer = readonly [kind: string, content: React.ReactNode];

interface DesktopShellSidebarLayersProps {
  activeKind: string;
  layers: ReadonlyArray<SidebarLayer>;
}

const SidebarLayer = React.memo(function SidebarLayer({
  active,
  phase,
  onExit,
  kind,
  children,
}: {
  active: boolean;
  phase?: 'enter' | 'exit';
  onExit?: () => void;
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
      hidden={!active && phase !== 'exit'}
      aria-hidden={!active}
      data-sidebar-layer={kind}
      className={cn('absolute inset-0 h-full w-full', active ? 'z-[1]' : 'pointer-events-none')}
      data-sidebar-phase={phase}
      onAnimationEnd={onExit ? (event) => { if (event.target === event.currentTarget) onExit(); } : undefined}
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
  const [transition, setTransition] = useState({ current: activeKind, previous: '', exiting: '' });
  if (transition.current !== activeKind) {
    const previous = transition.current;
    setTransition({ current: activeKind, previous, exiting: prefersReducedMotion() ? '' : previous });
  }
  if (!visited.has(activeKind)) {
    setVisited(new Set([...visited, activeKind]));
  }

  // The home sidebar is level zero; settings, tasks and the resource sidebar
  // are sibling destinations one level down.
  const depth = (kind: string) => Number(kind !== 'main');
  const direction = Math.sign(depth(activeKind) - depth(transition.previous));

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ '--sidebar-nav-direction': direction } as React.CSSProperties}
    >
      {layers.map(([kind, content]) => {
        if (!visited.has(kind) && kind !== activeKind) return null;
        const active = kind === activeKind;
        const exiting = kind === transition.exiting && !active;
        return (
          <SidebarLayer
            key={kind}
            kind={kind}
            active={active}
            phase={exiting ? 'exit' : active && transition.previous ? 'enter' : undefined}
            onExit={exiting ? () => setTransition((value) =>
              value.exiting === kind ? { ...value, exiting: '' } : value) : undefined}
          >
            {content}
          </SidebarLayer>
        );
      })}
    </div>
  );
});
