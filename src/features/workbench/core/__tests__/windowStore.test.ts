/**
 * P1 — windowStore 状态机单测（O11 扩展）
 * 覆盖：cascade 回卷与分布感知、focusStack/zIndex 不变量、focus no-op 短路、
 * zIndex 紧凑重排、瞬态进出场标记、restoreFrame 往返、hydrate zIndex 归一化 /
 * 分层唤醒初值 / 跨分辨率自适应、desktopSize 钳制、single/multi 去重。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  WINDOW_Z_COMPACT_THRESHOLD,
  resetWindowStoreForTests,
  setPendingRestoreDesktopSize,
  useWindowStore,
} from '../windowStore';
import { makeWin, registerTestApp } from './testUtils';
import type { WorkbenchWindow } from '../types';

registerTestApp('test-app');
registerTestApp('test-single', { instanceMode: 'single' });

function store() {
  return useWindowStore.getState();
}

/** 不变量断言：focusStack = 非 minimized 按 zIndex 升序；栈顶 zIndex 最高 */
function expectFocusInvariant(): void {
  const s = store();
  const expected = Object.values(s.windows)
    .filter((w) => !w.minimized)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((w) => w.id);
  expect(s.focusStack).toEqual(expected);
  const topId = s.focusStack[s.focusStack.length - 1];
  if (topId) {
    const topZ = s.windows[topId].zIndex;
    for (const w of Object.values(s.windows)) {
      if (!w.minimized) expect(w.zIndex).toBeLessThanOrEqual(topZ);
    }
  }
}

describe('windowStore — 打开与级联', () => {
  beforeEach(() => resetWindowStoreForTests({ w: 1400, h: 500 }));

  it('新窗按 +24 级联偏移落位', () => {
    const a = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    const b = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    expect(store().windows[a].frame).toMatchObject({ x: 48, y: 48 });
    expect(store().windows[b].frame).toMatchObject({ x: 72, y: 72 });
  });

  it('级联超出桌面边界时回卷到起点（不叠死在边缘）', () => {
    // h=500，窗高 300：offset > 200（即第 8 个槽位 216）越界 → 回卷
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } }));
    }
    expect(store().windows[ids[6]].frame).toMatchObject({ x: 192, y: 192 });
    expect(store().windows[ids[7]].frame).toMatchObject({ x: 48, y: 48 });
  });

  it('显式 initialFrame x/y 不消耗级联槽位', () => {
    store().openWindow({ typeId: 'test-app', initialFrame: { x: 500, y: 100, w: 400, h: 300 } });
    const b = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    expect(store().windows[b].frame).toMatchObject({ x: 48, y: 48 });
  });

  it('dropPoint 以最终窗口尺寸居中落位', () => {
    const id = store().openWindow({
      typeId: 'test-app',
      dropPoint: { x: 700, y: 250 },
      initialFrame: { w: 400, h: 300 },
    });
    expect(store().windows[id].frame).toEqual({ x: 500, y: 100, w: 400, h: 300 });
  });

  it('dropPoint 在桌面四边完整钳制窗口', () => {
    const points = [
      [{ x: 0, y: 0 }, { x: 0, y: 0 }],
      [{ x: 1400, y: 0 }, { x: 1000, y: 0 }],
      [{ x: 0, y: 500 }, { x: 0, y: 200 }],
      [{ x: 1400, y: 500 }, { x: 1000, y: 200 }],
    ] as const;
    for (const [dropPoint, expected] of points) {
      const id = store().openWindow({
        typeId: 'test-app',
        dropPoint,
        initialFrame: { w: 400, h: 300 },
      });
      expect(store().windows[id].frame).toMatchObject(expected);
    }
  });

  it('非法 dropPoint 忽略并回退 cascade', () => {
    const id = store().openWindow({
      typeId: 'test-app',
      dropPoint: { x: Number.NaN, y: 100 },
      initialFrame: { w: 400, h: 300 },
    });
    expect(store().windows[id].frame).toMatchObject({ x: 48, y: 48 });
  });

  it('小桌面（<1280px）新窗默认 maximized', () => {
    resetWindowStoreForTests({ w: 1000, h: 700 });
    const id = store().openWindow({ typeId: 'test-app' });
    expect(store().windows[id].displayMode).toBe('maximized');
  });

  it('O11：关窗空出的级联槽位被新窗复用（感知已有窗分布）', () => {
    const a = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    const b = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    expect(store().windows[b].frame).toMatchObject({ x: 72, y: 72 });
    store().closeWindow(a);
    const c = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    expect(store().windows[c].frame).toMatchObject({ x: 48, y: 48 });
  });

  it('O11：已有窗被拖离槽位后该槽位重新可用', () => {
    const a = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    store().moveWindow(a, { x: 600, y: 150, w: 400, h: 300 });
    const b = store().openWindow({ typeId: 'test-app', initialFrame: { w: 400, h: 300 } });
    expect(store().windows[b].frame).toMatchObject({ x: 48, y: 48 });
  });

  it('multi 同 typeId+instanceKey 去重为 focus', () => {
    const a = store().openWindow({ typeId: 'test-app', instanceKey: 'res_1' });
    store().openWindow({ typeId: 'test-app', instanceKey: 'res_2' });
    const again = store().openWindow({ typeId: 'test-app', instanceKey: 'res_1' });
    expect(again).toBe(a);
    expect(Object.keys(store().windows)).toHaveLength(2);
    expect(store().focusStack[store().focusStack.length - 1]).toBe(a);
  });

  it('dropPoint 命中已有 instanceKey 时只聚焦，不移动原窗口', () => {
    const id = store().openWindow({
      typeId: 'test-app',
      instanceKey: 'same',
      initialFrame: { x: 120, y: 80, w: 400, h: 300 },
    });
    const again = store().openWindow({
      typeId: 'test-app',
      instanceKey: 'same',
      dropPoint: { x: 1300, y: 450 },
    });
    expect(again).toBe(id);
    expect(store().windows[id].frame).toEqual({ x: 120, y: 80, w: 400, h: 300 });
  });

  it('single 应用只保留一个实例', () => {
    const a = store().openWindow({ typeId: 'test-single' });
    const again = store().openWindow({ typeId: 'test-single' });
    expect(again).toBe(a);
    expect(Object.keys(store().windows)).toHaveLength(1);
  });

});

describe('windowStore — focusStack / zIndex 不变量', () => {
  beforeEach(() => resetWindowStoreForTests({ w: 1600, h: 900 }));

  it('focusWindow 把窗口提到栈顶且 zIndex 全局最高', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    const c = store().openWindow({ typeId: 'test-app' });
    store().focusWindow(a);
    expect(store().focusStack).toEqual([b, c, a]);
    expectFocusInvariant();
  });

  it('open/focus/minimize/close 任意序列后不变量保持', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    const c = store().openWindow({ typeId: 'test-app' });
    store().focusWindow(a);
    expectFocusInvariant();
    store().minimizeWindow(c);
    expectFocusInvariant();
    store().focusWindow(b);
    expectFocusInvariant();
    store().closeWindow(a);
    expectFocusInvariant();
    store().minimizeWindow(c, false);
    expectFocusInvariant();
  });

  it('最小化移出焦点栈，焦点回落到下一个窗口', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    store().minimizeWindow(b);
    expect(store().focusStack).toEqual([a]);
  });

  it('反最小化按自身 zIndex 回到原栈位，不抢焦点', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    store().minimizeWindow(a);
    store().minimizeWindow(a, false);
    // a 的 zIndex 低于 b → 回到栈底，b 仍是焦点
    expect(store().focusStack).toEqual([a, b]);
    expectFocusInvariant();
  });

  it('focusWindow 同时解除最小化', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    store().openWindow({ typeId: 'test-app' });
    store().minimizeWindow(a);
    store().focusWindow(a);
    expect(store().windows[a].minimized).toBe(false);
    expect(store().focusStack[store().focusStack.length - 1]).toBe(a);
    expectFocusInvariant();
  });

  it('closeWindow 清理 launchPayload 与 lifecycle', () => {
    const a = store().openWindow({ typeId: 'test-app', payload: { foo: 1 } });
    store().setLifecycles({ [a]: 'focused' });
    store().closeWindow(a);
    expect(store().windows[a]).toBeUndefined();
    expect(store().launchPayloads[a]).toBeUndefined();
    expect(store().lifecycles[a]).toBeUndefined();
  });

  it('O11：聚焦已是焦点的窗口为 no-op（引用不变、zIndex 不 bump，无重渲染闪烁）', () => {
    store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    const windowsRef = store().windows;
    const zBefore = store().windows[b].zIndex;
    store().focusWindow(b);
    expect(store().windows).toBe(windowsRef);
    expect(store().windows[b].zIndex).toBe(zBefore);
    expectFocusInvariant();
  });

  it('O11：zTop 越过阈值时同次提交内紧凑重排（相对序不变、数值回落）', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    const c = store().openWindow({ typeId: 'test-app' });
    for (let i = 0; i < WINDOW_Z_COMPACT_THRESHOLD; i++) {
      store().focusWindow(i % 2 === 0 ? a : b);
    }
    const s = store();
    const zs = [a, b, c].map((id) => s.windows[id].zIndex);
    expect(Math.max(...zs)).toBeLessThan(WINDOW_Z_COMPACT_THRESHOLD);
    // 最后一次聚焦的是 b（i=1999 奇数）→ b 仍是栈顶，c 在 a 之上历史序保持
    expect(s.focusStack[s.focusStack.length - 1]).toBe(b);
    expectFocusInvariant();
  });
});

describe('windowStore — 瞬态进出场标记（O11，供 O9 动画消费）', () => {
  beforeEach(() => resetWindowStoreForTests({ w: 1600, h: 900 }));

  it('openWindow 自动标记 opening；setWindowTransient 可改写与清除', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    expect(store().transientPhases?.[a]).toBe('opening');
    store().setWindowTransient!(a, 'closing');
    expect(store().transientPhases?.[a]).toBe('closing');
    store().setWindowTransient!(a, null);
    expect(store().transientPhases?.[a]).toBeUndefined();
  });

  it('未知 windowId 忽略；重复设置同值不产生新状态', () => {
    const before = store().transientPhases;
    store().setWindowTransient!('ghost', 'opening');
    expect(store().transientPhases).toBe(before);
    const a = store().openWindow({ typeId: 'test-app' });
    const ref = store().transientPhases;
    store().setWindowTransient!(a, 'opening');
    expect(store().transientPhases).toBe(ref);
  });

  it('close / minimize 提交时自动清理标记', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    store().setWindowTransient!(a, 'minimizing');
    store().minimizeWindow(a);
    expect(store().transientPhases?.[a]).toBeUndefined();
    store().setWindowTransient!(b, 'closing');
    store().closeWindow(b);
    expect(store().transientPhases?.[b]).toBeUndefined();
  });

  it('反最小化标记 restoring（focusWindow 与 minimizeWindow(id,false) 两条路径）', () => {
    const a = store().openWindow({ typeId: 'test-app' });
    const b = store().openWindow({ typeId: 'test-app' });
    store().minimizeWindow(a);
    store().minimizeWindow(a, false);
    expect(store().transientPhases?.[a]).toBe('restoring');
    store().minimizeWindow(b);
    store().focusWindow(b);
    expect(store().transientPhases?.[b]).toBe('restoring');
  });

  it('hydrate 清空全部瞬态标记（快照白名单外，绝不持久化）', () => {
    store().openWindow({ typeId: 'test-app' });
    store().hydrate([makeWin({ id: 'x' })], {});
    expect(store().transientPhases).toEqual({});
  });
});

describe('windowStore — restoreFrame 恢复语义', () => {
  beforeEach(() => resetWindowStoreForTests({ w: 1600, h: 900 }));

  it('floating→tiled→floating 往返恢复原 frame', () => {
    const id = store().openWindow({
      typeId: 'test-app',
      initialFrame: { x: 120, y: 80, w: 640, h: 480 },
    });
    const original = { ...store().windows[id].frame };
    store().setDisplayMode(id, 'tiled-left');
    expect(store().windows[id].restoreFrame).toEqual(original);
    store().setDisplayMode(id, 'floating');
    expect(store().windows[id].frame).toEqual(original);
    expect(store().windows[id].restoreFrame).toBeNull();
  });

  it('tiled↔maximized 互切保留最初的 restoreFrame', () => {
    const id = store().openWindow({
      typeId: 'test-app',
      initialFrame: { x: 100, y: 100, w: 500, h: 400 },
    });
    const original = { ...store().windows[id].frame };
    store().setDisplayMode(id, 'tiled-right');
    store().setDisplayMode(id, 'maximized');
    store().setDisplayMode(id, 'tiled-bl');
    expect(store().windows[id].restoreFrame).toEqual(original);
    store().setDisplayMode(id, 'floating');
    expect(store().windows[id].frame).toEqual(original);
  });

  it('关窗或离开对应平铺侧会清理失效 pair ratio', () => {
    const left = store().openWindow({ typeId: 'test-app' });
    const right = store().openWindow({ typeId: 'test-app' });
    store().setDisplayMode(left, 'tiled-left');
    store().setDisplayMode(right, 'tiled-right');
    const key = `${left}:${right}`;
    store().setTilingRatio(key, 0.7);
    store().setDisplayMode(right, 'floating');
    expect(store().tilingRatios[key]).toBeUndefined();

    store().setDisplayMode(right, 'tiled-right');
    store().setTilingRatio(key, 0.6);
    store().closeWindow(left);
    expect(store().tilingRatios[key]).toBeUndefined();
  });
});

describe('windowStore — hydrate 与 desktopSize', () => {
  beforeEach(() => resetWindowStoreForTests({ w: 1600, h: 900 }));

  it('hydrate 把 zIndex 归一化为紧凑序列且不变量成立', () => {
    const wins: WorkbenchWindow[] = [
      makeWin({ id: 'a', zIndex: 500, lastFocusedAt: 30, displayMode: 'tiled-left' }),
      makeWin({ id: 'b', zIndex: 5, lastFocusedAt: 10, displayMode: 'tiled-right' }),
      makeWin({ id: 'c', zIndex: 42, lastFocusedAt: 20 }),
    ];
    store().hydrate(wins, { 'a:b': 0.6 });
    const s = store();
    // 紧凑序列：按原 z 序 b(5) < c(42) < a(500) → 10/11/12
    expect(s.windows['b'].zIndex).toBe(10);
    expect(s.windows['c'].zIndex).toBe(11);
    expect(s.windows['a'].zIndex).toBe(12);
    expect(s.focusStack).toEqual(['b', 'c', 'a']);
    expect(s.tilingRatios).toEqual({ 'a:b': 0.6 });
    expectFocusInvariant();
  });

  it('hydrate 后新开窗口 zIndex 继续递增（不与旧窗冲突）', () => {
    store().hydrate([makeWin({ id: 'a', zIndex: 999 })], {});
    const b = store().openWindow({ typeId: 'test-app' });
    expect(store().windows[b].zIndex).toBeGreaterThan(store().windows['a'].zIndex);
  });

  it('启动恢复 preserveExisting：live 窗覆盖同实例快照、保持 payload 且位于栈顶', () => {
    const liveId = store().openWindow({
      typeId: 'test-app',
      instanceKey: 'live',
      payload: { from: 'startup' },
    });
    store().hydrate(
      [
        makeWin({ id: 'snapshot-duplicate', typeId: 'test-app', instanceKey: 'live', zIndex: 999 }),
        makeWin({ id: 'snapshot-other', typeId: 'test-app', instanceKey: 'other', zIndex: 5 }),
      ],
      {},
      { preserveExisting: true },
    );
    const s = store();
    expect(s.windows['snapshot-duplicate']).toBeUndefined();
    expect(s.windows['snapshot-other']).toBeDefined();
    expect(s.windows[liveId]).toBeDefined();
    expect(s.launchPayloads[liveId]).toEqual({ from: 'startup' });
    expect(s.focusStack.at(-1)).toBe(liveId);
  });

  it('hydrate 清空瞬态 launchPayloads，lifecycles 重置为分层唤醒初值', () => {
    const a = store().openWindow({ typeId: 'test-app', payload: { p: 1 } });
    store().setLifecycles({ [a]: 'focused' });
    store().hydrate([makeWin({ id: 'x' })], {});
    // 旧窗口的 lifecycle / payload 不残留；新集合只含派生初值（栈顶 focused）
    expect(store().lifecycles).toEqual({ x: 'focused' });
    expect(store().launchPayloads).toEqual({});
  });

  it('O11：hydrate 初始 lifecycles 只让栈顶 focused，其余 background（首帧只渲染焦点窗）', () => {
    store().hydrate(
      [
        makeWin({ id: 'a', zIndex: 1 }),
        makeWin({ id: 'b', zIndex: 2 }),
        makeWin({ id: 'c', zIndex: 3, minimized: true }),
      ],
      {},
    );
    expect(store().lifecycles).toEqual({ a: 'background', b: 'focused', c: 'background' });
  });

  it('O11：hydrate 把屏外窗口钳回可视区（无快照桌面尺寸时的兜底）', () => {
    store().hydrate([makeWin({ id: 'far', frame: { x: 3000, y: 2000, w: 400, h: 300 } })], {});
    const f = store().windows['far'].frame;
    expect(f.x).toBe(1600 - 48); // 至少露出 48px 边缘
    expect(f.y).toBe(900 - 38); // 标题栏保持可见
  });

  it('O11：停放快照桌面尺寸后 hydrate 按比例缩放位置（消费一次即清空）', () => {
    setPendingRestoreDesktopSize({ w: 3200, h: 1800 });
    store().hydrate([makeWin({ id: 'a', frame: { x: 1600, y: 900, w: 400, h: 300 } })], {});
    expect(store().windows['a'].frame).toMatchObject({ x: 800, y: 450, w: 400, h: 300 });
    // 第二次 hydrate 无停放尺寸 → 不再缩放
    store().hydrate([makeWin({ id: 'b', frame: { x: 800, y: 450, w: 400, h: 300 } })], {});
    expect(store().windows['b'].frame).toMatchObject({ x: 800, y: 450 });
  });

  it('O11：超出新桌面的窗口等比收缩（保持宽高比），restoreFrame 同步自适应', () => {
    setPendingRestoreDesktopSize({ w: 3200, h: 1800 });
    store().hydrate(
      [
        makeWin({
          id: 'big',
          displayMode: 'tiled-left',
          frame: { x: 200, y: 100, w: 3200, h: 1200 },
          restoreFrame: { x: 200, y: 100, w: 3200, h: 1200 },
        }),
      ],
      {},
    );
    const win = store().windows['big'];
    // 位置：x 200→100，y 100→50；尺寸 fit = min(1600/3200, 900/1200) = 0.5 → 1600×600
    expect(win.restoreFrame).toMatchObject({ w: 1600, h: 600 });
    expect(win.frame).toMatchObject({ w: 1600, h: 600 });
    // 钳回可视区：x ∈ [min(0, 48-1600), 1552] → 100 保留
    expect(win.frame.x).toBe(100);
    expect(win.frame.y).toBe(50);
  });

  it('hydrate 的 minimized 窗口不进 focusStack', () => {
    store().hydrate(
      [makeWin({ id: 'a', zIndex: 1 }), makeWin({ id: 'b', zIndex: 2, minimized: true })],
      {},
    );
    expect(store().focusStack).toEqual(['a']);
  });

  it('desktopSize 缩小时 floating 窗钳回可视区，tiled/maximized frame 不动', () => {
    const floatId = store().openWindow({
      typeId: 'test-app',
      initialFrame: { x: 1400, y: 850, w: 400, h: 300 },
    });
    const tiledId = store().openWindow({
      typeId: 'test-app',
      initialFrame: { x: 1200, y: 700, w: 400, h: 300 },
    });
    store().setDisplayMode(tiledId, 'tiled-right');
    const tiledFrameBefore = { ...store().windows[tiledId].frame };

    store().setDesktopSize({ w: 800, h: 600 });
    const f = store().windows[floatId].frame;
    expect(f.x).toBe(800 - 48); // 至少露出 48px 边缘
    expect(f.y).toBe(600 - 38); // 标题栏保持可见
    expect(store().windows[tiledId].frame).toEqual(tiledFrameBefore);
  });

  it('desktopSize 缩小时比桌面还大的 floating 窗同步收缩适配（内容不再被截断）', () => {
    // 桌面 1600x1200 时摆下的浮窗；原生窗口随后缩到 800x600
    const floatId = store().openWindow({
      typeId: 'test-app',
      initialFrame: { x: 60, y: 40, w: 1400, h: 1000 },
    });

    store().setDesktopSize({ w: 800, h: 600 });
    const f = store().windows[floatId].frame;
    // 等比收缩到放得下（fit = min(800/1400, 600/1000) = 0.571）
    expect(f.w).toBe(800);
    expect(f.h).toBeCloseTo(1000 * (800 / 1400), 5);
    // 尺寸收缩后仍钳在可视区内
    expect(f.x).toBeGreaterThanOrEqual(Math.min(0, 48 - f.w));
    expect(f.x).toBeLessThanOrEqual(Math.max(0, 800 - 48));
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeLessThanOrEqual(Math.max(0, 600 - 38));
    expect(f.x + f.w).toBeLessThanOrEqual(800);
    expect(f.y + f.h).toBeLessThanOrEqual(600);
  });
});
