/**
 * P2 — useWindowPointer hook 测试
 * 核心断言：拖动全程 0 次 React 重渲染；minSize 从 appRegistry 读取
 */
import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  useWindowPointer,
  type UseWindowPointerResult,
} from '@/features/workbench/components/window-shell/useWindowPointer';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import type { Frame, SnapZone, WindowPointerCallbacks } from '@/features/workbench/core/types';

const TEST_TYPE_ID = 'p2-pointer-test-app';

// ---- rAF 手动队列 ----
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafSeq: number;
function flushRaf(): void {
  const pending = Array.from(rafCallbacks.values());
  rafCallbacks.clear();
  for (const cb of pending) cb(performance.now());
}

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; button?: number },
): PointerEvent {
  const e = new MouseEvent(type, {
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    bubbles: true,
  }) as any;
  if (e.pointerId === undefined) {
    Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  }
  return e as PointerEvent;
}

/** 构造传给 hook 手柄的 React 合成事件替身 */
function fakeReactPointerEvent(
  el: Element,
  init: { clientX: number; clientY: number; pointerId?: number; button?: number },
): React.PointerEvent {
  return {
    nativeEvent: pointerEvent('pointerdown', init),
    currentTarget: el,
    pointerId: init.pointerId ?? 1,
  } as unknown as React.PointerEvent;
}

interface HarnessProps {
  callbacks: WindowPointerCallbacks;
  frame: Frame;
  apiRef: React.MutableRefObject<UseWindowPointerResult | null>;
  renderCount: { current: number };
}

const Harness: React.FC<HarnessProps> = ({ callbacks, frame, apiRef, renderCount }) => {
  renderCount.current += 1;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const pointer = useWindowPointer({
    typeId: TEST_TYPE_ID,
    getFrame: () => frameRef.current,
    callbacks,
  });
  apiRef.current = pointer;
  return <div data-testid="wb-test-titlebar" onPointerDown={pointer.startMove} />;
};

function setup() {
  const frames: Frame[] = [];
  const zones: SnapZone[] = [];
  const commits: Array<{ frame: Frame; zone: SnapZone }> = [];
  const callbacks: WindowPointerCallbacks = {
    onFrameChange: (f) => frames.push(f),
    onSnapZoneChange: (z) => zones.push(z),
    onCommit: (f, z) => commits.push({ frame: f, zone: z }),
  };
  const apiRef: React.MutableRefObject<UseWindowPointerResult | null> = { current: null };
  const renderCount = { current: 0 };
  const startFrame: Frame = { x: 100, y: 100, w: 600, h: 400 };
  const utils = render(
    <Harness callbacks={callbacks} frame={startFrame} apiRef={apiRef} renderCount={renderCount} />,
  );
  return { frames, zones, commits, apiRef, renderCount, startFrame, ...utils };
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafSeq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
  appRegistry.register({
    typeId: TEST_TYPE_ID,
    nameKey: 'workbench:apps.test',
    icon: null,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 600, h: 400 },
    minSize: { w: 444, h: 333 },
    render: React.lazy(async () => ({ default: () => null })),
  });
  useWindowStore.getState().setDesktopSize({ w: 1600, h: 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWindowPointer', () => {
  it('拖动全程（start→move×N→commit）0 次额外 React 重渲染', () => {
    const t = setup();
    expect(t.renderCount.current).toBe(1);
    const el = screen.getByTestId('wb-test-titlebar');

    t.apiRef.current!.startMove(fakeReactPointerEvent(el, { clientX: 400, clientY: 120 }));
    expect(t.apiRef.current!.isDragging()).toBe(true);
    expect(t.apiRef.current!.isArmed()).toBe(false);

    for (let i = 1; i <= 5; i++) {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 400 + i * 20, clientY: 120 + i * 10 }));
      flushRaf();
    }
    expect(t.apiRef.current!.isArmed()).toBe(true);
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 500, clientY: 170 }));

    expect(t.frames.length).toBeGreaterThanOrEqual(5);
    expect(t.commits).toHaveLength(1);
    expect(t.commits[0].frame).toEqual({ x: 200, y: 150, w: 600, h: 400 });
    // 核心 DoD：回调直写 DOM 路径，无任何 React state 参与
    expect(t.renderCount.current).toBe(1);
    expect(t.apiRef.current!.isDragging()).toBe(false);
  });

  it('未过阈值松手：不 commit、不武装', () => {
    const t = setup();
    const el = screen.getByTestId('wb-test-titlebar');
    t.apiRef.current!.startMove(fakeReactPointerEvent(el, { clientX: 400, clientY: 120 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 400.4, clientY: 120 }));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 400.4, clientY: 120 }));
    expect(t.frames).toHaveLength(0);
    expect(t.commits).toHaveLength(0);
    expect(t.renderCount.current).toBe(1);
  });

  it('minSize 从 appRegistry 按 typeId 读取', () => {
    const t = setup();
    const el = screen.getByTestId('wb-test-titlebar');
    t.apiRef.current!.startResize(fakeReactPointerEvent(el, { clientX: 700, clientY: 500 }), 'w');
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 5000, clientY: 500 }));
    flushRaf();
    expect(t.frames.at(-1)!.w).toBe(444); // 注册的 minSize.w 硬边界
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 5000, clientY: 500 }));
    expect(t.commits[0].frame.w).toBe(444);
    expect(t.renderCount.current).toBe(1);
  });

  it('desktopSize 从 windowStore 非响应式读取（吸附命中）', () => {
    useWindowStore.getState().setDesktopSize({ w: 800, h: 600 });
    const t = setup();
    const el = screen.getByTestId('wb-test-titlebar');
    t.apiRef.current!.startMove(fakeReactPointerEvent(el, { clientX: 400, clientY: 300 }));
    // x=795 对 800 宽桌面是右缘（>= 800-8）
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 795, clientY: 300 }));
    flushRaf();
    expect(t.zones).toEqual(['right']);
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 795, clientY: 300 }));
    expect(t.commits[0].zone).toBe('right');
    expect(t.renderCount.current).toBe(1);
  });

  it('disabled=true 时忽略手势', () => {
    const frames: Frame[] = [];
    const callbacks: WindowPointerCallbacks = {
      onFrameChange: (f) => frames.push(f),
      onSnapZoneChange: () => {},
      onCommit: () => {},
    };
    const apiRef: React.MutableRefObject<UseWindowPointerResult | null> = { current: null };
    const Disabled: React.FC = () => {
      const pointer = useWindowPointer({
        typeId: TEST_TYPE_ID,
        getFrame: () => ({ x: 0, y: 0, w: 600, h: 400 }),
        callbacks,
        disabled: true,
      });
      apiRef.current = pointer;
      return <div data-testid="disabled-bar" onPointerDown={pointer.startMove} />;
    };
    render(<Disabled />);
    const el = screen.getByTestId('disabled-bar');
    apiRef.current!.startMove(fakeReactPointerEvent(el, { clientX: 100, clientY: 100 }));
    expect(apiRef.current!.isDragging()).toBe(false);
  });

  it('卸载时自动取消进行中的手势（已武装则 commit 起始 frame）', () => {
    const t = setup();
    const el = screen.getByTestId('wb-test-titlebar');
    t.apiRef.current!.startMove(fakeReactPointerEvent(el, { clientX: 400, clientY: 120 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 500, clientY: 200 }));
    flushRaf();
    expect(t.apiRef.current!.isArmed()).toBe(true);
    t.unmount();
    expect(t.commits).toHaveLength(1);
    expect(t.commits[0]).toEqual({ frame: t.startFrame, zone: null });
    // 卸载后事件不再有任何回调
    const framesLen = t.frames.length;
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 900, clientY: 900 }));
    flushRaf();
    expect(t.frames).toHaveLength(framesLen);
  });

  it('Esc 取消回原位且不触发重渲染', () => {
    const t = setup();
    const el = screen.getByTestId('wb-test-titlebar');
    t.apiRef.current!.startMove(fakeReactPointerEvent(el, { clientX: 400, clientY: 120 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 600, clientY: 300 }));
    flushRaf();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(t.frames.at(-1)).toEqual(t.startFrame);
    expect(t.commits[0]).toEqual({ frame: t.startFrame, zone: null });
    expect(t.renderCount.current).toBe(1);
  });
});
