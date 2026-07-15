export const WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT = 'workbench:native-surface-layout' as const;

export type NativeSurfaceLayoutPhase = 'suspend' | 'resume' | 'sync';
export type NativeSurfaceLayoutScope = 'window' | 'all';

export interface NativeSurfaceLayoutEventDetail {
  windowId: string;
  phase: NativeSurfaceLayoutPhase;
  scope: NativeSurfaceLayoutScope;
}

export function dispatchNativeSurfaceLayout(
  windowId: string,
  phase: NativeSurfaceLayoutPhase,
  scope: NativeSurfaceLayoutScope = 'window',
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<NativeSurfaceLayoutEventDetail>(WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT, {
      detail: { windowId, phase, scope },
    }),
  );
}

export function suspendNativeSurface(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'suspend');
}

export function resumeNativeSurface(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'resume');
}

/**
 * A compositor-only FLIP animation cannot be mirrored into a native child at
 * every animation frame. Temporarily yield every native surface until it ends.
 */
export function suspendAllNativeSurfaces(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'suspend', 'all');
}

export function resumeAllNativeSurfaces(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'resume', 'all');
}

export function syncNativeSurface(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'sync');
}
