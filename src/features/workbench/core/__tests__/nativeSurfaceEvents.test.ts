import { afterEach, describe, expect, it } from 'vitest';

import {
  dispatchNativeSurfaceLayout,
  resumeAllNativeSurfaces,
  resumeNativeSurface,
  suspendAllNativeSurfaces,
  suspendNativeSurface,
  syncNativeSurface,
  WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT,
  type NativeSurfaceLayoutEventDetail,
} from '../nativeSurfaceEvents';

describe('native surface layout events', () => {
  const received: NativeSurfaceLayoutEventDetail[] = [];
  const onLayout = (event: Event) => {
    received.push((event as CustomEvent<NativeSurfaceLayoutEventDetail>).detail);
  };

  window.addEventListener(WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT, onLayout);

  afterEach(() => {
    received.length = 0;
  });

  it('keeps per-window gesture events scoped to their owner', () => {
    suspendNativeSurface('notes');
    resumeNativeSurface('notes');
    syncNativeSurface('notes');

    expect(received).toEqual([
      { windowId: 'notes', phase: 'suspend', scope: 'window' },
      { windowId: 'notes', phase: 'resume', scope: 'window' },
      { windowId: 'notes', phase: 'sync', scope: 'window' },
    ]);
  });

  it('marks compositor-only FLIP animations as global surface suspensions', () => {
    suspendAllNativeSurfaces('notes');
    resumeAllNativeSurfaces('notes');

    expect(received).toEqual([
      { windowId: 'notes', phase: 'suspend', scope: 'all' },
      { windowId: 'notes', phase: 'resume', scope: 'all' },
    ]);
  });

  it('defaults manually dispatched events to the per-window scope', () => {
    dispatchNativeSurfaceLayout('notes', 'sync');

    expect(received).toEqual([
      { windowId: 'notes', phase: 'sync', scope: 'window' },
    ]);
  });
});
