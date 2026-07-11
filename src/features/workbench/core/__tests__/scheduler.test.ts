/**
 * P1 — scheduler 生命周期调度单测（O10 扩展）
 * 覆盖：四档判定、预算冻结（focused/visible 永不冻结）、唤醒解冻、
 * macOS 预算、防抖订阅。
 * O10 新增：冻结宽限（即将冻结）、唤醒预取、渲染提示（visible 细分档 /
 * 失焦过渡 / 活动降频）、瞬态定时器自动推进。
 *
 * 说明：原有预算用例统一 setFreezeGraceOverride(0) 保持「立即冻结」语义；
 * 宽限行为由 O10 专属用例覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_BUDGET,
  FOCUS_TRANSITION_MS,
  MACOS_MEMORY_BUDGET,
  RENDER_THROTTLE_FOCUSED,
  RENDER_THROTTLE_PAUSED,
  RENDER_THROTTLE_TRANSITION,
  RENDER_THROTTLE_VISIBLE_FULL,
  RENDER_THROTTLE_VISIBLE_PARTIAL,
  beginSchedulerDragActivity,
  getMemoryBudget,
  getSchedulerActivity,
  getWindowRenderHint,
  isFreezeImminent,
  recomputeLifecycles,
  reportSchedulerActivity,
  requestWakePrefetch,
  resetSchedulerTransientsForTests,
  RENDER_THROTTLE_DRAG_FOCUSED,
  setFreezeGraceOverride,
  setMemoryBudgetOverride,
  setSchedulerNowForTests,
  startScheduler,
  subscribeRenderHints,
} from '../scheduler';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { registerTestApp } from './testUtils';

registerTestApp('sched-light', { memoryWeight: 1 });
registerTestApp('sched-heavy', { memoryWeight: 3 });

function store() {
  return useWindowStore.getState();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** 开 count 个 weight=3 完全重叠的窗口（LRU 顺序 = 打开顺序） */
function openHeavyStack(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      store().openWindow({
        typeId: 'sched-heavy',
        initialFrame: { x: 100, y: 100, w: 400, h: 300 },
      }),
    );
  }
  return ids;
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1600, h: 900 });
  setMemoryBudgetOverride(null);
  setFreezeGraceOverride(0);
  setSchedulerNowForTests(null);
  resetSchedulerTransientsForTests();
});

afterEach(() => {
  setMemoryBudgetOverride(null);
  setFreezeGraceOverride(null);
  setSchedulerNowForTests(null);
});

describe('recomputeLifecycles — 四档判定', () => {
  it('栈顶 = focused，其余可见窗口 = visible', () => {
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    recomputeLifecycles();
    expect(store().lifecycles[b]).toBe('focused');
    expect(store().lifecycles[a]).toBe('visible');
  });

  it('minimized → background', () => {
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    store().openWindow({ typeId: 'sched-light', initialFrame: { x: 400, y: 0, w: 300, h: 300 } });
    store().minimizeWindow(a);
    recomputeLifecycles();
    expect(store().lifecycles[a]).toBe('background');
  });

  it('被完全遮挡 → background；部分遮挡 → visible', () => {
    const covered = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 100, y: 100, w: 200, h: 200 },
    });
    const peeking = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 350, y: 100, w: 300, h: 200 },
    });
    store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 50, y: 50, w: 500, h: 400 },
    });
    recomputeLifecycles();
    expect(store().lifecycles[covered]).toBe('background');
    expect(store().lifecycles[peeking]).toBe('visible'); // 右侧露出 100px
  });

  it('左右平铺遮挡使用当前 pair ratio，而非固定 50/50', () => {
    const left = store().openWindow({ typeId: 'sched-light' });
    const right = store().openWindow({ typeId: 'sched-light' });
    const cover = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 320, h: 900 },
    });
    store().setDisplayMode(left, 'tiled-left');
    store().setDisplayMode(right, 'tiled-right');
    store().setTilingRatio(`${left}:${right}`, 0.2);
    store().focusWindow(cover);
    recomputeLifecycles();
    expect(store().lifecycles[left]).toBe('background');
    expect(store().lifecycles[right]).toBe('visible');
  });

  it('全空桌面 → 空 lifecycles', () => {
    recomputeLifecycles();
    expect(store().lifecycles).toEqual({});
  });

  it('幂等：无变化时不写 store（引用不变）', () => {
    store().openWindow({ typeId: 'sched-light' });
    recomputeLifecycles();
    const ref = store().lifecycles;
    recomputeLifecycles();
    expect(store().lifecycles).toBe(ref);
  });

  it('连续重算（遮挡增量路径）与四档判定一致', () => {
    const covered = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 100, y: 100, w: 200, h: 200 },
    });
    const top = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 50, y: 50, w: 500, h: 400 },
    });
    recomputeLifecycles();
    expect(store().lifecycles[covered]).toBe('background');
    // 移走上层窗口 → 下层恢复 visible（增量重算必须捕捉旧矩形释放）
    store().moveWindow(top, { x: 900, y: 500, w: 500, h: 400 });
    recomputeLifecycles();
    expect(store().lifecycles[covered]).toBe('visible');
  });
});

describe('recomputeLifecycles — 预算冻结', () => {
  it('DoD：超预算只冻 background，按 lastFocusedAt LRU 最旧优先', () => {
    setMemoryBudgetOverride(12);
    // 5 个 weight=3 完全重叠的窗口 = 15 点 > 12 → 冻 1 个最旧的
    const ids = openHeavyStack(5);
    recomputeLifecycles();
    const lc = store().lifecycles;
    expect(lc[ids[4]]).toBe('focused');
    expect(lc[ids[0]]).toBe('frozen'); // 最旧的 background
    expect(lc[ids[1]]).toBe('background');
    expect(lc[ids[2]]).toBe('background');
    expect(lc[ids[3]]).toBe('background');
  });

  it('focused / visible 永不冻结（即使仍超预算）', () => {
    setMemoryBudgetOverride(1);
    // 三窗互不重叠 → 全部 focused/visible；预算 1 点被远超也不得冻结
    const a = store().openWindow({
      typeId: 'sched-heavy',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'sched-heavy',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    const c = store().openWindow({
      typeId: 'sched-heavy',
      initialFrame: { x: 800, y: 0, w: 300, h: 300 },
    });
    recomputeLifecycles();
    const lc = store().lifecycles;
    expect(lc[a]).toBe('visible');
    expect(lc[b]).toBe('visible');
    expect(lc[c]).toBe('focused');
    expect(Object.values(lc)).not.toContain('frozen');
  });

  it('DoD：唤醒（focus）后立即解冻', () => {
    setMemoryBudgetOverride(12);
    const ids = openHeavyStack(5);
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('frozen');

    store().focusWindow(ids[0]);
    recomputeLifecycles();
    const lc = store().lifecycles;
    expect(lc[ids[0]]).toBe('focused'); // 解冻并聚焦
    expect(lc[ids[1]]).toBe('frozen'); // 预算压力转移到新的 LRU 最旧者
  });

  it('回到预算内即停止冻结（只冻必要数量）', () => {
    setMemoryBudgetOverride(9);
    // 4 窗 × 3 = 12 点，预算 9 → 只需冻 1 个（12-3=9）
    openHeavyStack(4);
    recomputeLifecycles();
    const frozen = Object.values(store().lifecycles).filter((v) => v === 'frozen');
    expect(frozen).toHaveLength(1);
  });
});

describe('getMemoryBudget — 平台预算', () => {
  it('默认 12 点；macOS（navigator.platform）9 点', () => {
    expect(getMemoryBudget()).toBe(DEFAULT_MEMORY_BUDGET);
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    try {
      expect(getMemoryBudget()).toBe(MACOS_MEMORY_BUDGET);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).platform;
    }
    expect(getMemoryBudget()).toBe(DEFAULT_MEMORY_BUDGET);
  });
});

describe('startScheduler — 订阅与防抖', () => {
  it('store 变化后防抖 1 帧重算；同帧多次变更只算一轮', async () => {
    const stop = startScheduler();
    try {
      const a = store().openWindow({
        typeId: 'sched-light',
        initialFrame: { x: 0, y: 0, w: 300, h: 300 },
      });
      const b = store().openWindow({
        typeId: 'sched-light',
        initialFrame: { x: 400, y: 0, w: 300, h: 300 },
      });
      store().focusWindow(a);
      // 尚未到帧回调：lifecycles 还是空
      expect(store().lifecycles).toEqual({});
      await nextFrame();
      await nextFrame();
      expect(store().lifecycles[a]).toBe('focused');
      expect(store().lifecycles[b]).toBe('visible');
    } finally {
      stop();
    }
  });

  it('stop 之后不再响应变化', async () => {
    const stop = startScheduler();
    await nextFrame();
    await nextFrame();
    stop();
    store().openWindow({ typeId: 'sched-light' });
    await nextFrame();
    await nextFrame();
    expect(store().lifecycles).toEqual({});
  });
});

// ============================================================================
// O10 新增行为
// ============================================================================

describe('O10 — 预算冻结宽限（即将冻结）', () => {
  it('候选先保持 background 并标记 freezeImminent，宽限满后才冻结', () => {
    setMemoryBudgetOverride(12);
    setFreezeGraceOverride(1000);
    let t = 10_000;
    setSchedulerNowForTests(() => t);
    const ids = openHeavyStack(5);

    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('background');
    expect(isFreezeImminent(ids[0])).toBe(true);
    expect(getWindowRenderHint(ids[0]).freezeImminent).toBe(true);

    t += 500;
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('background'); // 仍在宽限内

    t += 600; // 累计 1100 ≥ 1000
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('frozen');
    expect(isFreezeImminent(ids[0])).toBe(false);
  });

  it('宽限期内被聚焦 → 取消候选（focused 永不冻结），压力转移给下一个 LRU', () => {
    setMemoryBudgetOverride(12);
    setFreezeGraceOverride(1000);
    let t = 20_000;
    setSchedulerNowForTests(() => t);
    const ids = openHeavyStack(5);

    recomputeLifecycles();
    expect(isFreezeImminent(ids[0])).toBe(true);

    store().focusWindow(ids[0]);
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('focused');
    // 新候选 ids[1] 拿到全新宽限，不继承 ids[0] 的计时
    expect(store().lifecycles[ids[1]]).toBe('background');
    expect(isFreezeImminent(ids[1])).toBe(true);

    t += 2000;
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('focused');
    expect(store().lifecycles[ids[1]]).toBe('frozen');
  });

  it('宽限期内预算压力解除 → 候选取消且不再冻结', () => {
    setMemoryBudgetOverride(12);
    setFreezeGraceOverride(1000);
    let t = 30_000;
    setSchedulerNowForTests(() => t);
    const ids = openHeavyStack(5);

    recomputeLifecycles();
    expect(isFreezeImminent(ids[0])).toBe(true);

    store().closeWindow(ids[1]); // 15 → 12 点，回到预算内
    recomputeLifecycles();
    expect(isFreezeImminent(ids[0])).toBe(false);

    t += 5000;
    recomputeLifecycles();
    expect(Object.values(store().lifecycles)).not.toContain('frozen');
  });
});

describe('O10 — 唤醒预取', () => {
  it('frozen 窗预取回 background（DOM 预建、不抢焦点），过期后重新冻结', () => {
    setMemoryBudgetOverride(12);
    setFreezeGraceOverride(0);
    let t = 50_000;
    setSchedulerNowForTests(() => t);
    const ids = openHeavyStack(5);

    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('frozen');

    requestWakePrefetch(ids[0], 1000); // 无调度循环 → 同步重算
    expect(store().lifecycles[ids[0]]).toBe('background'); // 预取豁免
    expect(store().lifecycles[ids[4]]).toBe('focused'); // 不抢焦点
    expect(store().lifecycles[ids[1]]).toBe('frozen'); // 压力转移到下一个 LRU

    t += 1500; // 预取豁免过期
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('frozen');
    expect(store().lifecycles[ids[1]]).toBe('background');
  });
});

describe('O10 — 渲染提示 render hints', () => {
  it('focused 全速；完全可见 visible=250；部分遮挡 visible=500；background 暂停', () => {
    const covered = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 210, y: 10, w: 100, h: 100 },
    });
    const partial = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 400, h: 300 },
    });
    const isolated = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 900, y: 500, w: 300, h: 200 },
    });
    const top = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 200, y: 0, w: 400, h: 300 },
    });
    recomputeLifecycles();

    const hintTop = getWindowRenderHint(top);
    expect(hintTop.lifecycle).toBe('focused');
    expect(hintTop.throttleMs).toBe(RENDER_THROTTLE_FOCUSED);

    const hintIsolated = getWindowRenderHint(isolated);
    expect(hintIsolated.visibility).toBe('full');
    expect(hintIsolated.throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL);
    expect(hintIsolated.visibleRatio).toBe(1);

    const hintPartial = getWindowRenderHint(partial);
    expect(hintPartial.lifecycle).toBe('visible');
    expect(hintPartial.visibility).toBe('partial');
    expect(hintPartial.throttleMs).toBe(RENDER_THROTTLE_VISIBLE_PARTIAL);
    expect(hintPartial.visibleRatio).toBeCloseTo(0.5, 3); // 右半被 top 覆盖

    const hintCovered = getWindowRenderHint(covered);
    expect(hintCovered.lifecycle).toBe('background');
    expect(hintCovered.visibility).toBe('hidden');
    expect(hintCovered.throttleMs).toBe(RENDER_THROTTLE_PAUSED);
  });

  it('焦点切换：原焦点窗进入 defocus 过渡（节流收窄），过期后回落目标档', () => {
    let t = 0;
    setSchedulerNowForTests(() => t);
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    recomputeLifecycles(); // top = b

    store().focusWindow(a);
    recomputeLifecycles(); // 焦点 b → a，b 获得过渡宽限
    const hintB = getWindowRenderHint(b);
    expect(hintB.lifecycle).toBe('visible');
    expect(hintB.transition).toBe('defocus');
    expect(hintB.throttleMs).toBe(RENDER_THROTTLE_TRANSITION);

    t += FOCUS_TRANSITION_MS + 1;
    recomputeLifecycles();
    const hintB2 = getWindowRenderHint(b);
    expect(hintB2.transition).toBeNull();
    expect(hintB2.throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL);
  });

  it('reportSchedulerActivity：活动期内非焦点 visible 窗节流加倍，衰减后恢复', async () => {
    let t = 0;
    setSchedulerNowForTests(() => t);
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    recomputeLifecycles();
    expect(getWindowRenderHint(a).throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL);

    reportSchedulerActivity('scroll', 1000);
    await nextFrame(); // hint 刷新按 rAF 防抖合并
    expect(getWindowRenderHint(a).throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL * 2);
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_FOCUSED); // scroll 不压 focused

    t += 1500; // 活动衰减
    recomputeLifecycles();
    expect(getWindowRenderHint(a).throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL);
  });

  it('beginSchedulerDragActivity：默认不刷 hint；长拖靠深度计数；release 后恢复', async () => {
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    recomputeLifecycles();
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_FOCUSED);

    const release = beginSchedulerDragActivity();
    // ANTI-REGRESSION：起拖默认不 scheduleHintRefresh，避免跟手中途唤醒 WindowBody
    expect(getSchedulerActivity()?.kind).toBe('drag');
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_FOCUSED);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    await nextFrame();
    // 默认路径：hint 仍保持静止档（降频由 shellGestureFlags / CSS / 流式 imperative 承担）
    expect(getWindowRenderHint(a).throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL);
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_FOCUSED);

    release();
    await nextFrame();
    expect(getSchedulerActivity()).toBeNull();
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_FOCUSED);
    expect(getWindowRenderHint(a).throttleMs).toBe(RENDER_THROTTLE_VISIBLE_FULL);
  });

  it('beginSchedulerDragActivity({ refreshHints: true })：显式刷 hint 时 focused 降频', async () => {
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    recomputeLifecycles();

    const release = beginSchedulerDragActivity({ refreshHints: true });
    expect(getSchedulerActivity()?.kind).toBe('drag');

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    await nextFrame();
    expect(getWindowRenderHint(a).throttleMs).toBe(
      Math.min(RENDER_THROTTLE_VISIBLE_FULL * 2, 1000),
    );
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_DRAG_FOCUSED);

    release();
    await nextFrame();
    expect(getWindowRenderHint(b).throttleMs).toBe(RENDER_THROTTLE_FOCUSED);
  });

  it('subscribeRenderHints：提示变化时收到通知；退订后停止', () => {
    let calls = 0;
    const unsubscribe = subscribeRenderHints(() => {
      calls += 1;
    });
    store().openWindow({ typeId: 'sched-light', initialFrame: { x: 0, y: 0, w: 300, h: 300 } });
    recomputeLifecycles();
    expect(calls).toBeGreaterThan(0);

    const seen = calls;
    unsubscribe();
    store().openWindow({ typeId: 'sched-light', initialFrame: { x: 400, y: 0, w: 300, h: 300 } });
    recomputeLifecycles();
    expect(calls).toBe(seen);
  });

  it('scheduler 未重算时返回焦点栈派生的兜底提示（引用稳定）', () => {
    const a = store().openWindow({
      typeId: 'sched-light',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const h1 = getWindowRenderHint(a);
    const h2 = getWindowRenderHint(a);
    expect(h1).toBe(h2); // useSyncExternalStore 安全
    expect(h1.lifecycle).toBe('focused');
  });
});

describe('O10 — startScheduler 瞬态定时器', () => {
  it('冻结宽限到期后自动补一轮重算完成冻结（无需外部事件）', async () => {
    setMemoryBudgetOverride(12);
    setFreezeGraceOverride(40);
    const stop = startScheduler();
    try {
      const ids = openHeavyStack(5);
      await nextFrame();
      await nextFrame();
      expect(store().lifecycles[ids[0]]).toBe('background');
      expect(isFreezeImminent(ids[0])).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));
      await nextFrame();
      await nextFrame();
      expect(store().lifecycles[ids[0]]).toBe('frozen');
    } finally {
      stop();
    }
  });
});
