import { afterEach, describe, expect, it } from 'vitest';

import {
  addNativeSurfaceLayoutListener,
  dispatchNativeSurfaceLayout,
  resumeAllNativeSurfaces,
  resumeNativeSurface,
  suspendAllNativeSurfaces,
  suspendNativeSurface,
  syncNativeSurface,
  type NativeSurfaceLayoutEventDetail,
} from '../nativeSurfaceEvents';

describe('native surface layout events', () => {
  const received: NativeSurfaceLayoutEventDetail[] = [];
  const disposers: Array<() => void> = [];
  const listen = () => {
    const dispose = addNativeSurfaceLayoutListener((detail) => {
      received.push(detail);
    });
    disposers.push(dispose);
    return dispose;
  };

  afterEach(() => {
    received.length = 0;
    while (disposers.length > 0) disposers.pop()?.();
  });

  it('keeps per-window gesture events scoped to their owner', () => {
    listen();
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
    listen();
    suspendAllNativeSurfaces('notes');
    resumeAllNativeSurfaces('notes');

    expect(received).toEqual([
      { windowId: 'notes', phase: 'suspend', scope: 'all' },
      { windowId: 'notes', phase: 'resume', scope: 'all' },
    ]);
  });

  it('defaults manually dispatched events to the per-window scope', () => {
    listen();
    dispatchNativeSurfaceLayout('notes', 'sync');

    expect(received).toEqual([
      { windowId: 'notes', phase: 'sync', scope: 'window' },
    ]);
  });

  it('无注册消费者时 sync 短路（拖拽每帧热路径不派发事件）', () => {
    // 用旁路 addEventListener 观察 window 上是否真的派发了事件
    const raw: NativeSurfaceLayoutEventDetail[] = [];
    const onRaw = (event: Event) => {
      raw.push((event as CustomEvent<NativeSurfaceLayoutEventDetail>).detail);
    };
    window.addEventListener('workbench:native-surface-layout', onRaw);
    try {
      syncNativeSurface('notes');
      expect(raw).toEqual([]);

      // suspend/resume 非每帧路径，不受计数门控
      suspendNativeSurface('notes');
      expect(raw).toHaveLength(1);
    } finally {
      window.removeEventListener('workbench:native-surface-layout', onRaw);
    }
  });

  it('注销幂等：重复调用 dispose 不会把计数减到负数', () => {
    const dispose = listen();
    dispose();
    dispose();
    syncNativeSurface('notes');
    expect(received).toEqual([]);

    // 再注册的消费者仍能正常收到 sync
    listen();
    syncNativeSurface('notes');
    expect(received).toEqual([{ windowId: 'notes', phase: 'sync', scope: 'window' }]);
  });
});
