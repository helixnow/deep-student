/**
 * R1-19 — pacing 规格测试（DESIGN §4.3 + types.ts Pacer）
 *
 * 三档参数暴露、instant 立即 resolve、normal 时序（fake timers + mock rAF）、
 * reduced-motion 强制 instant、dispose 后挂起 tick 不悬挂。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPacer, forcePacerInstant, listTickCost, LIST_INTERVAL_MS, PACING_PROFILES } from '../pacing';

describe('ACR pacing — DESIGN §4.3', () => {
  let rafCbs: FrameRequestCallback[];
  let rafId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    rafCbs = [];
    rafId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafId += 1;
        rafCbs.push(cb);
        return rafId;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        // 简化：清空队列（单测串行，足够）
        void id;
        rafCbs = [];
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // 恢复 vitest.setup 的 matchMedia 默认（matches: false）
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  function flushRaf(): void {
    const cbs = rafCbs.splice(0, rafCbs.length);
    for (const cb of cbs) cb(performance.now());
  }

  it('三档参数正确暴露', () => {
    expect(PACING_PROFILES.fast).toMatchObject({
      name: 'fast',
      opIntervalMs: 0,
      instant: true,
    });
    expect(PACING_PROFILES.normal).toMatchObject({
      name: 'normal',
      opIntervalMs: 300,
      typeBatchMin: 8,
      typeBatchMax: 40,
      typeIntervalMs: 24,
      instant: false,
    });
    expect(PACING_PROFILES.demo).toMatchObject({
      name: 'demo',
      opIntervalMs: 600,
      typeBatchMin: 4,
      typeBatchMax: 16,
      typeIntervalMs: 48,
      instant: false,
    });
    expect(Object.keys(PACING_PROFILES).sort()).toEqual(['demo', 'fast', 'normal']);
  });

  it('R3-03：列表间隔与 listTickCost 对齐 DESIGN §4.3', () => {
    expect(LIST_INTERVAL_MS.normal).toBe(150);
    expect(LIST_INTERVAL_MS.demo).toBe(300);
    expect(LIST_INTERVAL_MS.fast).toBe(0);
    expect(listTickCost(PACING_PROFILES.normal)).toBeCloseTo(0.5, 5);
    expect(listTickCost(PACING_PROFILES.demo)).toBeCloseTo(0.5, 5);
    expect(listTickCost(PACING_PROFILES.fast)).toBe(0);
  });

  it('instant（fast）档 tick 立即 resolve', async () => {
    const pacer = createPacer('fast');
    expect(pacer.profile.instant).toBe(true);
    const t0 = Date.now();
    await pacer.tick();
    expect(Date.now() - t0).toBe(0);
    expect(rafCbs).toHaveLength(0);
    pacer.dispose();
  });

  it('normal 档 tick 时序：opIntervalMs 后再经 rAF 对齐', async () => {
    const pacer = createPacer('normal');
    expect(pacer.profile.instant).toBe(false);
    expect(pacer.profile.opIntervalMs).toBe(300);

    let done = false;
    const p = pacer.tick().then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    expect(rafCbs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(false);
    expect(rafCbs).toHaveLength(1);

    flushRaf();
    await p;
    expect(done).toBe(true);
    pacer.dispose();
  });

  it('normal 档 cost 放大间隔', async () => {
    const pacer = createPacer('normal');
    let done = false;
    const p = pacer.tick(2).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(599);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rafCbs).toHaveLength(1);
    flushRaf();
    await p;
    expect(done).toBe(true);
    pacer.dispose();
  });

  it('reduced-motion 强制 instant', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const pacer = createPacer('normal');
    expect(pacer.profile.instant).toBe(true);
    // 保留请求档位名，参数走 fast
    expect(pacer.profile.name).toBe('normal');
    expect(pacer.profile.opIntervalMs).toBe(0);

    await pacer.tick();
    expect(rafCbs).toHaveLength(0);
    pacer.dispose();
  });

  it('dispose 后挂起 tick 不悬挂', async () => {
    const pacer = createPacer('normal');
    const p = pacer.tick();
    await vi.advanceTimersByTimeAsync(100);
    pacer.dispose();
    await expect(p).resolves.toBeUndefined();
  });

  it('forcePacerInstant：运行中降为 instant，保留档位名，后续 tick 立即返回', async () => {
    const pacer = createPacer('normal');
    expect(pacer.profile.instant).toBe(false);
    forcePacerInstant(pacer, 'test');
    expect(pacer.profile.instant).toBe(true);
    expect(pacer.profile.name).toBe('normal');
    expect(pacer.profile.opIntervalMs).toBe(0);
    const t0 = Date.now();
    await pacer.tick();
    expect(Date.now() - t0).toBe(0);
    expect(rafCbs).toHaveLength(0);
    // 幂等
    forcePacerInstant(pacer, 'again');
    expect(pacer.profile.instant).toBe(true);
    pacer.dispose();
  });
});
