/**
 * P2 — core/pointerEngine.ts 引擎测试
 * 覆盖：rAF 合帧拖动、八向缩放 + minSize clamp、吸附回调、
 *       Esc / pointercancel / lostpointercapture / blur 回退、边界 clamp
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MOVE_ARM_THRESHOLD_PX,
  WindowPointerEngine,
  resetPrefersReducedMotionCacheForTests,
  type ResizeEdge,
} from '@/features/workbench/core/pointerEngine';
import type { Frame, SnapZone } from '@/features/workbench/core/types';

// ---------------------------------------------------------------------------
// 手动 rAF 队列（确定性合帧）
// ---------------------------------------------------------------------------
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafSeq: number;

function flushRaf(): void {
  const pending = Array.from(rafCallbacks.values());
  rafCallbacks.clear();
  for (const cb of pending) cb(performance.now());
}

function expectFrameCloseTo(actual: Frame, expected: Frame): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.w).toBeCloseTo(expected.w, 6);
  expect(actual.h).toBeCloseTo(expected.h, 6);
}

// jsdom 无 PointerEvent 构造器时回退 MouseEvent + 手工 pointerId
function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; button?: number },
): PointerEvent {
  const base: MouseEventInit = {
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    bubbles: true,
  };
  const Ctor = (globalThis as any).PointerEvent as typeof PointerEvent | undefined;
  const e = Ctor ? new Ctor(type, { ...base, pointerId: init.pointerId ?? 1 }) : new MouseEvent(type, base);
  if (!('pointerId' in e) || (e as any).pointerId === undefined) {
    Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  }
  return e as PointerEvent;
}

function movePointer(x: number, y: number, pointerId = 1): void {
  window.dispatchEvent(pointerEvent('pointermove', { clientX: x, clientY: y, pointerId }));
}

function releasePointer(x: number, y: number, pointerId = 1): void {
  window.dispatchEvent(pointerEvent('pointerup', { clientX: x, clientY: y, pointerId }));
}

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------
interface Harness {
  engine: WindowPointerEngine;
  target: HTMLElement;
  frames: Frame[];
  zones: SnapZone[];
  commits: Array<{ frame: Frame; zone: SnapZone }>;
  startFrame: Frame;
}

function createHarness(overrides?: {
  startFrame?: Frame;
  minSize?: { w: number; h: number };
  desktop?: { w: number; h: number };
  enableSnap?: boolean;
  onMoveArmed?: (point: { x: number; y: number }) => void;
  /** 动态 frame（tear-out 后 getFrame 返回新值） */
  getFrame?: () => Frame;
}): Harness {
  const startFrame = overrides?.startFrame ?? { x: 100, y: 100, w: 600, h: 400 };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const frames: Frame[] = [];
  const zones: SnapZone[] = [];
  const commits: Array<{ frame: Frame; zone: SnapZone }> = [];
  const engine = new WindowPointerEngine({
    getFrame: overrides?.getFrame ?? (() => startFrame),
    getDesktopSize: () => overrides?.desktop ?? { w: 1600, h: 1000 },
    getMinSize: () => overrides?.minSize ?? { w: 320, h: 240 },
    getCallbacks: () => ({
      onFrameChange: (f) => frames.push(f),
      onSnapZoneChange: (z) => zones.push(z),
      onCommit: (f, z) => commits.push({ frame: f, zone: z }),
    }),
    enableSnap: overrides?.enableSnap,
    onMoveArmed: overrides?.onMoveArmed,
  });
  return { engine, target, frames, zones, commits, startFrame };
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafSeq = 0;
  resetPrefersReducedMotionCacheForTests();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPrefersReducedMotionCacheForTests();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
describe('WindowPointerEngine — 拖动', () => {
  it('拖动按 delta 更新 frame，且同帧多次 move 只回调一次（rAF 合帧）', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    expect(h.engine.isActive()).toBe(true);
    expect(h.engine.currentGesture()).toBe('move');

    movePointer(410, 130);
    movePointer(430, 150);
    expect(h.frames).toHaveLength(0); // 未 flush 不回调
    flushRaf();
    expect(h.frames).toHaveLength(1); // 两次 move 合并为一帧
    expect(h.frames[0]).toEqual({ x: 130, y: 130, w: 600, h: 400 });

    movePointer(500, 220);
    flushRaf();
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]).toEqual({ x: 200, y: 200, w: 600, h: 400 });
  });

  it('松手 commit 最终 frame（含未 flush 的最后一个点），zone=null', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(450, 170);
    releasePointer(450, 170); // rAF 未 flush，up 内同步补算
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].frame).toEqual({ x: 150, y: 150, w: 600, h: 400 });
    expect(h.commits[0].zone).toBeNull();
    expect(h.engine.isActive()).toBe(false);
  });

  it('拖动 y 不出上界，且底部保留可见带', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(400, -500);
    flushRaf();
    expect(h.frames.at(-1)!.y).toBe(0);
    movePointer(400, 5000);
    flushRaf();
    expect(h.frames.at(-1)!.y).toBe(1000 - 40); // MOVE_KEEP_VISIBLE_Y 硬边界
  });

  it('拖动 x 两侧各保留可抓回宽度', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(-5000, 120);
    flushRaf();
    expect(h.frames.at(-1)!.x).toBe(80 - 600); // MOVE_KEEP_VISIBLE_X - w 硬边界
    movePointer(5000, 120);
    flushRaf();
    expect(h.frames.at(-1)!.x).toBe(1600 - 80);
  });

  it('非主键按下不启动手势', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120, button: 2 }), h.target);
    expect(h.engine.isActive()).toBe(false);
  });

  it('手势进行中重复 start 被忽略', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }), 'se', h.target);
    expect(h.engine.currentGesture()).toBe('move');
  });

  it('其他 pointerId 的事件不影响当前手势', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120, pointerId: 1 }), h.target);
    movePointer(999, 999, 7);
    flushRaf();
    expect(h.frames).toHaveLength(0);
    releasePointer(999, 999, 7);
    expect(h.commits).toHaveLength(0);
    expect(h.engine.isActive()).toBe(true);
    h.engine.cancel();
  });

  it(`未过 ${MOVE_ARM_THRESHOLD_PX}px 阈值的松手视为纯点击（不 commit）`, () => {
    const armed = vi.fn();
    const h = createHarness({ onMoveArmed: armed });
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    expect(h.engine.isActive()).toBe(true);
    expect(h.engine.isArmed()).toBe(false);
    movePointer(402, 122); // 位移 ≈ 2.83px < MOVE_ARM_THRESHOLD_PX（3px）
    flushRaf();
    expect(armed).not.toHaveBeenCalled();
    expect(h.frames).toHaveLength(0);
    releasePointer(402, 121);
    expect(h.commits).toHaveLength(0);
    expect(h.engine.isActive()).toBe(false);
  });

  it('过阈值后触发 onMoveArmed 并开始跟手', () => {
    const armed = vi.fn();
    const h = createHarness({ onMoveArmed: armed });
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(404, 123); // 位移 5px > MOVE_ARM_THRESHOLD_PX（3px）
    flushRaf();
    expect(armed).toHaveBeenCalledTimes(1);
    expect(h.engine.isArmed()).toBe(true);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toEqual({ x: 104, y: 103, w: 600, h: 400 });
    releasePointer(404, 123);
    expect(h.commits).toHaveLength(1);
  });

  it(`位移恰为 ${MOVE_ARM_THRESHOLD_PX}px（等于阈值）即武装`, () => {
    const armed = vi.fn();
    const h = createHarness({ onMoveArmed: armed });
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(400 + MOVE_ARM_THRESHOLD_PX, 120);
    flushRaf();
    expect(armed).toHaveBeenCalledTimes(1);
    expect(h.engine.isArmed()).toBe(true);
  });

  it('零位移松手不 commit（避免无谓 store 写）', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    releasePointer(400, 120);
    expect(h.commits).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
  });
});

describe('WindowPointerEngine — 吸附', () => {
  it('拖到左缘触发 onSnapZoneChange(left)，commit 携带 zone', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 500 }), h.target);
    movePointer(5, 500);
    flushRaf();
    expect(h.zones).toEqual(['left']);
    releasePointer(5, 500);
    expect(h.commits[0].zone).toBe('left');
    // commit 前清理预览
    expect(h.zones).toEqual(['left', null]);
  });

  it('zone 变化才回调（去重），离开热区回调 null', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 500 }), h.target);
    movePointer(5, 500);
    flushRaf();
    movePointer(10, 480);
    flushRaf();
    expect(h.zones).toEqual(['left']); // 仍是 left，不重复回调
    movePointer(800, 500);
    flushRaf();
    expect(h.zones).toEqual(['left', null]);
    movePointer(20, 20);
    flushRaf();
    expect(h.zones).toEqual(['left', null, 'tl']);
    releasePointer(30, 30);
    expect(h.commits[0].zone).toBe('tl');
  });

  it('enableSnap=false 时不做命中检测', () => {
    const h = createHarness({ enableSnap: false });
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 500 }), h.target);
    movePointer(5, 500);
    flushRaf();
    expect(h.zones).toHaveLength(0);
    releasePointer(5, 500);
    h.engine.cancel(); // finalize resize settle
    expect(h.commits[0].zone).toBeNull();
  });

  it('resize 手势永不吸附', () => {
    const h = createHarness();
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 700, clientY: 500 }), 'e', h.target);
    movePointer(5, 500);
    flushRaf();
    expect(h.zones).toHaveLength(0);
    releasePointer(5, 500);
    h.engine.cancel(); // finalize resize settle
    expect(h.commits[0].zone).toBeNull();
  });
});

describe('WindowPointerEngine — 八向缩放', () => {
  // startFrame: x=100,y=100,w=600,h=400；起点 (400,300)，移动 delta (+50,+30)
  const cases: Array<[ResizeEdge, Frame]> = [
    ['e', { x: 100, y: 100, w: 650, h: 400 }],
    ['w', { x: 150, y: 100, w: 550, h: 400 }],
    ['s', { x: 100, y: 100, w: 600, h: 430 }],
    ['n', { x: 100, y: 130, w: 600, h: 370 }],
    ['se', { x: 100, y: 100, w: 650, h: 430 }],
    ['sw', { x: 150, y: 100, w: 550, h: 430 }],
    ['ne', { x: 100, y: 130, w: 650, h: 370 }],
    ['nw', { x: 150, y: 130, w: 550, h: 370 }],
  ];

  it.each(cases)('edge=%s 几何正确（对边固定）', (edge, expected) => {
    const h = createHarness();
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 400, clientY: 300 }), edge, h.target);
    expect(h.engine.currentGesture()).toBe('resize');
    movePointer(450, 330);
    flushRaf();
    expect(h.frames.at(-1)).toEqual(expected);
    releasePointer(450, 330);
    expect(h.commits[0].frame).toEqual(expected);
  });

  it('缩小不越过 minSize（右缘固定的 w 向缩放）', () => {
    const h = createHarness({ minSize: { w: 400, h: 300 } });
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 100, clientY: 300 }), 'w', h.target);
    movePointer(2000, 300); // 向右狂拖，理论宽度为负
    flushRaf();
    const f = h.frames.at(-1)!;
    expect(f.w).toBe(400);
    expect(f.x + f.w).toBe(100 + 600); // 右缘保持不动
  });

  it('nw 缩放 clamp 时下缘/右缘均固定', () => {
    const h = createHarness({ minSize: { w: 400, h: 300 } });
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }), 'nw', h.target);
    movePointer(3000, 3000);
    flushRaf();
    const f = h.frames.at(-1)!;
    expectFrameCloseTo(f, { x: 700 - 400, y: 500 - 300, w: 400, h: 300 });
  });
});

describe('WindowPointerEngine — 取消与回退', () => {
  function startedHarness(): Harness {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(5, 500); // 移到左缘：产生 frame 变化 + snap zone
    flushRaf();
    expect(h.zones).toEqual(['left']);
    return h;
  }

  function expectRolledBack(h: Harness): void {
    // 回原位 + 清理预览 + commit 起始 frame（zone=null）
    expect(h.frames.at(-1)).toEqual(h.startFrame);
    expect(h.zones.at(-1)).toBeNull();
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]).toEqual({ frame: h.startFrame, zone: null });
    expect(h.engine.isActive()).toBe(false);
  }

  it('Esc 取消回原位', () => {
    const h = startedHarness();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expectRolledBack(h);
  });

  it('pointercancel 回原位', () => {
    const h = startedHarness();
    window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }));
    expectRolledBack(h);
  });

  it('lostpointercapture（窗外释放/捕获丢失）回原位', () => {
    const h = startedHarness();
    const e = new Event('lostpointercapture');
    Object.defineProperty(e, 'pointerId', { value: 1 });
    h.target.dispatchEvent(e);
    expectRolledBack(h);
  });

  it('window blur（Alt+Tab 等）回原位', () => {
    const h = startedHarness();
    window.dispatchEvent(new Event('blur'));
    expectRolledBack(h);
  });

  it('取消后事件监听已卸载，后续 move/up 无副作用', () => {
    const h = startedHarness();
    h.engine.cancel();
    const framesLen = h.frames.length;
    movePointer(700, 700);
    flushRaf();
    releasePointer(700, 700);
    expect(h.frames).toHaveLength(framesLen);
    expect(h.commits).toHaveLength(1);
  });

  it('正常松手后 Esc 无副作用', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(450, 170);
    releasePointer(450, 170);
    expect(h.commits).toHaveLength(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.commits).toHaveLength(1);
  });

  it('未武装时 Esc 取消不 commit', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.commits).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
    expect(h.engine.isActive()).toBe(false);
  });

  it('拖入顶部 40px 菜单栏带仍稳定命中 top-maximize，不会闪烁丢失', () => {
    const startFrame: Frame = { x: 200, y: 120, w: 600, h: 400 };
    const target = document.createElement('div');
    document.body.appendChild(target);
    const zones: SnapZone[] = [];
    const commits: Array<{ frame: Frame; zone: SnapZone }> = [];
    const engine = new WindowPointerEngine({
      getFrame: () => startFrame,
      getDesktopSize: () => ({ w: 1600, h: 960 }),
      getMinSize: () => ({ w: 320, h: 240 }),
      getDesktopOffset: () => ({ x: 0, y: 40 }),
      getCallbacks: () => ({
        onFrameChange: () => {},
        onSnapZoneChange: (z) => zones.push(z),
        onCommit: (f, z) => commits.push({ frame: f, zone: z }),
      }),
    });

    engine.startMove(pointerEvent('pointerdown', { clientX: 500, clientY: 140 }), target);
    // clientY = 12 位于顶部 40px 菜单栏内（localY = -28），仍应稳定命中 top-maximize
    movePointer(800, 12);
    flushRaf();
    expect(zones).toEqual(['top-maximize']);
    releasePointer(800, 12);
    expect(commits[0].zone).toBe('top-maximize');
  });

  it('四向缩放到达桌面边缘硬钳位，北边不钻入菜单栏、右/下边不出桌面', () => {
    const h = createHarness({ startFrame: { x: 200, y: 120, w: 600, h: 400 } });
    // 北边狂拖向上：y 必须停在 0，底边保持 520
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), 'n', h.target);
    movePointer(400, -300);
    flushRaf();
    expect(h.frames.at(-1)).toEqual({ x: 200, y: 0, w: 600, h: 520 });
    releasePointer(400, -300);

    // 东边狂拖向右：右边停在 1600
    h.engine.startResize(pointerEvent('pointerdown', { clientX: 800, clientY: 300 }), 'e', h.target);
    movePointer(2500, 300);
    flushRaf();
    expect(h.frames.at(-1)).toEqual({ x: 200, y: 120, w: 1400, h: 400 });
    releasePointer(2500, 300);
  });

  it('tear-out 后按 Esc 取消回退到受管原位并调用 onMoveCancelled（不提交 floating）', () => {
    let currentFrame: Frame = { x: 0, y: 0, w: 1600, h: 1000 };
    const target = document.createElement('div');
    document.body.appendChild(target);
    const frames: Frame[] = [];
    const commits: Array<{ frame: Frame; zone: SnapZone }> = [];
    const onMoveCancelled = vi.fn();
    const engine = new WindowPointerEngine({
      getFrame: () => currentFrame,
      getDesktopSize: () => ({ w: 1600, h: 1000 }),
      getMinSize: () => ({ w: 320, h: 240 }),
      getCallbacks: () => ({
        onFrameChange: (f) => frames.push(f),
        onSnapZoneChange: () => {},
        onCommit: (f, z) => commits.push({ frame: f, zone: z }),
      }),
      onMoveArmed: () => {
        currentFrame = { x: 400, y: 20, w: 720, h: 520 };
      },
      onMoveCancelled,
    });

    engine.startMove(pointerEvent('pointerdown', { clientX: 800, clientY: 20 }), target);
    movePointer(820, 40);
    flushRaf();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(frames.at(-1)).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
    expect(onMoveCancelled).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(0);
  });

  it('拖拽到顶缘静止时按下/松开 Alt 即时切换 top-maximize 与 top-half', () => {
    const h = createHarness();
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 800, clientY: 120 }), h.target);
    movePointer(800, 5);
    flushRaf();
    expect(h.zones).toEqual(['top-maximize']);

    // 指针不移动，直接按住 Alt → 即时切到 top-half
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    flushRaf();
    expect(h.zones).toEqual(['top-maximize', 'top-half']);

    // 指针不移动，松开 Alt → 即时切回 top-maximize
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    flushRaf();
    expect(h.zones).toEqual(['top-maximize', 'top-half', 'top-maximize']);

    releasePointer(800, 5);
    expect(h.commits[0].zone).toBe('top-maximize');
  });

  it('邻窗边缘磁吸不会把窗口标题栏拉到 y < 0（顶部菜单栏下方）', () => {
    const startFrame: Frame = { x: 200, y: 4, w: 600, h: 970 };
    const target = document.createElement('div');
    document.body.appendChild(target);
    const frames: Frame[] = [];
    const engine = new WindowPointerEngine({
      getFrame: () => startFrame,
      getDesktopSize: () => ({ w: 1600, h: 960 }),
      getMinSize: () => ({ w: 320, h: 240 }),
      getEdgeSnapCandidates: () => ({ vertical: [0, 1600], horizontal: [0, 960] }),
      getCallbacks: () => ({
        onFrameChange: (f) => frames.push(f),
        onSnapZoneChange: () => {},
        onCommit: () => {},
      }),
    });

    engine.startMove(pointerEvent('pointerdown', { clientX: 500, clientY: 20 }), target);
    // 拖至 y=0 附近，窗口底边 970 接近桌面底边 960（差 10px 触发磁吸），但 y 不得跌破 0
    movePointer(520, 16);
    flushRaf();
    expect(frames.at(-1)!.y).toBeGreaterThanOrEqual(0);
    engine.cancel();
  });

  it('最大化窗 tear-out 向下微拖松手不会被立即吸回 top-maximize；离开后重新拖回顶缘可正常吸附', () => {
    let currentFrame: Frame = { x: 0, y: 0, w: 1600, h: 960 };
    const target = document.createElement('div');
    document.body.appendChild(target);
    const zones: SnapZone[] = [];
    const commits: Array<{ frame: Frame; zone: SnapZone }> = [];
    const engine = new WindowPointerEngine({
      getFrame: () => currentFrame,
      getDesktopSize: () => ({ w: 1600, h: 960 }),
      getMinSize: () => ({ w: 320, h: 240 }),
      getDesktopOffset: () => ({ x: 0, y: 40 }),
      getCallbacks: () => ({
        onFrameChange: () => {},
        onSnapZoneChange: (z) => zones.push(z),
        onCommit: (f, z) => commits.push({ frame: f, zone: z }),
      }),
      onMoveArmed: () => {
        currentFrame = { x: 400, y: 4, w: 720, h: 520 };
      },
    });

    // 标题栏中线按下（localY = 18 <= 24），向下撕出至 localY = 30 并松手：不应被吸回
    engine.startMove(pointerEvent('pointerdown', { clientX: 800, clientY: 58 }), target);
    movePointer(800, 62); // localY = 22：触发 tear-out
    flushRaf();
    movePointer(800, 70); // localY = 30：以前会被滞回锁死在 top-maximize
    flushRaf();
    expect(zones).toEqual([]);
    releasePointer(800, 70);
    expect(commits).toHaveLength(1);
    expect(commits[0].zone).toBeNull();

    // 再次从顶部撕出并拖离顶缘后再主动推回顶缘：应正常命中 top-maximize
    currentFrame = { x: 0, y: 0, w: 1600, h: 960 };
    engine.startMove(pointerEvent('pointerdown', { clientX: 800, clientY: 58 }), target);
    movePointer(800, 62);
    flushRaf();
    movePointer(800, 90); // localY = 50 > 24，解除顶缘抑制
    flushRaf();
    movePointer(800, 52); // localY = 12 <= 24，重新命中 top-maximize
    flushRaf();
    expect(zones).toEqual(['top-maximize']);
    releasePointer(800, 52);
    expect(commits[1].zone).toBe('top-maximize');
  });

  it('贴顶浮动窗横向拖动不会误触发 top-maximize；主动上推到顶缘仍可最大化', () => {
    const h = createHarness({ startFrame: { x: 200, y: 0, w: 600, h: 400 } });
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 18 }), h.target);
    movePointer(700, 18); // 纯横向移动，localY 保持 18
    flushRaf();
    expect(h.zones).toEqual([]);
    releasePointer(700, 18);
    expect(h.commits[0].zone).toBeNull();
    expect(h.commits[0].frame.x).toBe(500);

    // 同一位置按下并主动向上推至屏顶（y <= 4）：应解除抑制并命中 top-maximize
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 18 }), h.target);
    movePointer(400, 2);
    flushRaf();
    expect(h.zones).toEqual(['top-maximize']);
    releasePointer(400, 2);
    expect(h.commits[1].zone).toBe('top-maximize');
  });

  it('子元素对 pointerup stopPropagation 时，window 捕获期仍正常 commit，不被 lostpointercapture 吸回', () => {
    const h = createHarness();
    h.target.addEventListener('pointerup', (ev) => ev.stopPropagation());
    h.engine.startMove(pointerEvent('pointerdown', { clientX: 400, clientY: 120 }), h.target);
    movePointer(560, 240);
    flushRaf();
    // 在 target 上派发 pointerup（target 冒泡拦截）：window 捕获监听必须抢先 commit
    h.target.dispatchEvent(pointerEvent('pointerup', { clientX: 560, clientY: 240, pointerId: 1 }));
    // 随后即使浏览器派发 lostpointercapture，手势已结束，不再回退
    const lost = new Event('lostpointercapture');
    Object.defineProperty(lost, 'pointerId', { value: 1 });
    h.target.dispatchEvent(lost);

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].frame).toEqual({ x: 260, y: 220, w: 600, h: 400 });
    expect(h.engine.isActive()).toBe(false);
  });

  it('鼠标丢失 pointerup 后，后续 buttons=0 的 pointermove 自动落位结束，不永久卡死拖拽', () => {
    const h = createHarness();
    const makeMousePtr = (type: string, x: number, y: number, buttons: number): PointerEvent => {
      const ev = pointerEvent(type, { clientX: x, clientY: y, pointerId: 1 });
      Object.defineProperty(ev, 'buttons', { value: buttons });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      return ev;
    };
    h.engine.startMove(makeMousePtr('pointerdown', 400, 120, 1), h.target);
    window.dispatchEvent(makeMousePtr('pointermove', 520, 200, 1));
    flushRaf();
    expect(h.engine.isActive()).toBe(true);

    // 模拟在视口外松手丢掉 pointerup，鼠标回到页面时 buttons=0
    window.dispatchEvent(makeMousePtr('pointermove', 520, 200, 0));
    expect(h.engine.isActive()).toBe(false);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].frame).toEqual({ x: 220, y: 180, w: 600, h: 400 });
  });
});
