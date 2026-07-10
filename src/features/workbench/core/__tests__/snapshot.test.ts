/**
 * P1 — snapshot 持久化与 sanitizer 单测（O11 扩展）
 * 覆盖：白名单剥离（注入字段/lifecycle/payload）、坏 JSON 恢复、版本迁移容错、
 * 分层防抖写盘与内容去重、save→load→hydrate 往返一致性（DoD）、
 * 跨分辨率自适应恢复、恢复后逐帧唤醒。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_META_SAVE_DEBOUNCE_MS,
  SNAPSHOT_SAVE_DEBOUNCE_MS,
  WORKBENCH_SNAPSHOT_KEY,
  buildSnapshot,
  flushSnapshot,
  loadSnapshot,
  registerDockPinnedProvider,
  sanitizeSnapshot,
  saveSnapshot,
} from '../snapshot';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { makeWin, registerTestApp } from './testUtils';

registerTestApp('snap-app');

function store() {
  return useWindowStore.getState();
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1600, h: 900 });
  localStorage.clear();
  registerDockPinnedProvider(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('sanitizeSnapshot — 白名单剥离', () => {
  it('剥离窗口记录上的 lifecycle / payload / 未知注入字段', () => {
    const result = sanitizeSnapshot({
      version: 1,
      windows: [
        {
          ...makeWin({ id: 'a' }),
          lifecycle: 'focused',
          payload: { secret: true },
          injected: '<script>alert(1)</script>',
        },
      ],
      dockPinned: [],
      tilingRatios: {},
      unknownTopLevel: 'x',
    });
    expect(result).not.toBeNull();
    const win = result!.windows[0] as unknown as Record<string, unknown>;
    expect(win.id).toBe('a');
    expect('lifecycle' in win).toBe(false);
    expect('payload' in win).toBe(false);
    expect('injected' in win).toBe(false);
    expect('unknownTopLevel' in (result as unknown as Record<string, unknown>)).toBe(false);
  });

  it('结构性坏窗口记录被丢弃，合法记录保留', () => {
    const good = makeWin({ id: 'good' });
    const result = sanitizeSnapshot({
      version: 1,
      windows: [
        good,
        { id: 'no-frame', typeId: 't' }, // 缺 frame
        { ...makeWin({ id: 'bad-frame' }), frame: { x: 0, y: 0, w: -5, h: 100 } },
        { ...makeWin({ id: 'nan' }), frame: { x: Number.NaN, y: 0, w: 100, h: 100 } },
        'not-an-object',
      ],
      dockPinned: [],
      tilingRatios: {},
    });
    expect(result!.windows.map((w) => w.id)).toEqual(['good']);
  });

  it('重复窗口 id 只保留第一条', () => {
    const result = sanitizeSnapshot({
      version: 1,
      windows: [makeWin({ id: 'dup', title: 'first' }), makeWin({ id: 'dup', title: 'second' })],
      dockPinned: [],
      tilingRatios: {},
    });
    expect(result!.windows).toHaveLength(1);
    expect(result!.windows[0].title).toBe('first');
  });

  it('字段级坏值兜底：非法 displayMode→floating，非法 minimized→false', () => {
    const result = sanitizeSnapshot({
      version: 1,
      windows: [{ ...makeWin({ id: 'a' }), displayMode: 'evil-mode', minimized: 'yes' }],
      dockPinned: [],
      tilingRatios: {},
    });
    expect(result!.windows[0].displayMode).toBe('floating');
    expect(result!.windows[0].minimized).toBe(false);
  });

  it('结构性坏数据 → null + console.warn', () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot('str')).toBeNull();
    expect(sanitizeSnapshot({ version: 'evil', windows: [] })).toBeNull();
    expect(sanitizeSnapshot({ version: 1.5, windows: [] })).toBeNull();
    expect(sanitizeSnapshot({ version: 2, windows: 'not-array' })).toBeNull();
    expect(sanitizeSnapshot({ version: 1, windows: 'not-array' })).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('O11 版本迁移：version 缺失但形状可用 → 按 v1 容错解析 + warn', () => {
    const result = sanitizeSnapshot({
      windows: [makeWin({ id: 'a' })],
      dockPinned: ['chat'],
      tilingRatios: {},
    });
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.windows.map((w) => w.id)).toEqual(['a']);
    expect(console.warn).toHaveBeenCalled();
  });

  it('O11 版本迁移：未来版本（应用降级场景）→ 白名单 best-effort + warn', () => {
    const result = sanitizeSnapshot({
      version: 2,
      windows: [{ ...makeWin({ id: 'a' }), futureField: { deep: true } }],
      dockPinned: [],
      tilingRatios: {},
    });
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.windows).toHaveLength(1);
    expect('futureField' in (result!.windows[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('O11：desktopSize 合法保留、非法丢弃', () => {
    const ok = sanitizeSnapshot({
      version: 1,
      windows: [],
      dockPinned: [],
      tilingRatios: {},
      desktopSize: { w: 1920, h: 1080 },
    });
    expect(ok!.desktopSize).toEqual({ w: 1920, h: 1080 });

    const bad = sanitizeSnapshot({
      version: 1,
      windows: [],
      dockPinned: [],
      tilingRatios: {},
      desktopSize: { w: -1, h: Number.NaN },
    });
    expect(bad!.desktopSize).toBeUndefined();
  });

  it('tilingRatios 只保留 (0,1) 区间的有限数值；dockPinned 只保留字符串', () => {
    const result = sanitizeSnapshot({
      version: 1,
      windows: [],
      dockPinned: ['chat', 42, null, 'files'],
      tilingRatios: { 'a:b': 0.62, 'c:d': 1.5, 'e:f': Number.NaN, 'g:h': 0 },
    });
    expect(result!.dockPinned).toEqual(['chat', 'files']);
    expect(result!.tilingRatios).toEqual({ 'a:b': 0.62 });
  });

  it('wallpaper / materialTier 合法保留、非法丢弃', () => {
    const ok = sanitizeSnapshot({
      version: 1,
      windows: [],
      dockPinned: [],
      tilingRatios: {},
      wallpaper: { kind: 'image', value: '/path/a.jpg' },
      materialTier: 'reduced',
    });
    expect(ok!.wallpaper).toEqual({ kind: 'image', value: '/path/a.jpg' });
    expect(ok!.materialTier).toBe('reduced');

    const bad = sanitizeSnapshot({
      version: 1,
      windows: [],
      dockPinned: [],
      tilingRatios: {},
      wallpaper: { kind: 'video', value: 'x' },
      materialTier: 'ultra',
    });
    expect(bad!.wallpaper).toBeUndefined();
    expect(bad!.materialTier).toBeUndefined();
  });
});

describe('loadSnapshot — 坏数据恢复', () => {
  it('无快照 → null（不 warn 不抛）', async () => {
    await expect(loadSnapshot()).resolves.toBeNull();
  });

  it('坏 JSON → null + console.warn，绝不抛出', async () => {
    localStorage.setItem(WORKBENCH_SNAPSHOT_KEY, '{broken json!!');
    await expect(loadSnapshot()).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('合法 JSON 但校验不过（version 非法且不可迁移）→ null + warn', async () => {
    localStorage.setItem(
      WORKBENCH_SNAPSHOT_KEY,
      JSON.stringify({ version: 'corrupt', windows: [] }),
    );
    await expect(loadSnapshot()).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('O11：未来版本快照 best-effort 恢复而非整体丢弃', async () => {
    localStorage.setItem(
      WORKBENCH_SNAPSHOT_KEY,
      JSON.stringify({ version: 99, windows: [makeWin({ id: 'kept' })] }),
    );
    const snap = await loadSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.windows.map((w) => w.id)).toEqual(['kept']);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('saveSnapshot — 防抖与采集', () => {
  it('2s 防抖合并：多次调用只落盘一次', async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    store().openWindow({ typeId: 'snap-app' });
    saveSnapshot();
    await vi.advanceTimersByTimeAsync(1000);
    saveSnapshot(); // 重新计时
    await vi.advanceTimersByTimeAsync(SNAPSHOT_SAVE_DEBOUNCE_MS - 1);
    expect(setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(WORKBENCH_SNAPSHOT_KEY, expect.any(String));
  });

  it('buildSnapshot 只含壳字段，且带 dockPinned provider 数据与桌面尺寸', () => {
    registerDockPinnedProvider(() => ['chat', 'files']);
    store().openWindow({ typeId: 'snap-app', payload: { transient: true } });
    const snap = buildSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.dockPinned).toEqual(['chat', 'files']);
    expect(snap.desktopSize).toEqual({ w: 1600, h: 900 });
    const win = snap.windows[0] as unknown as Record<string, unknown>;
    expect(Object.keys(win).sort()).toEqual(
      [
        'createdAt',
        'displayMode',
        'frame',
        'id',
        'instanceKey',
        'lastFocusedAt',
        'minimized',
        'restoreFrame',
        'title',
        'typeId',
        'zIndex',
      ].sort(),
    );
    // 瞬态进出场标记（O11）绝不进快照
    expect(JSON.stringify(snap)).not.toContain('opening');
  });

  it('O11 分层保存：meta 层 10s 首次请求优先，不被后续 meta 顺延', async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    store().openWindow({ typeId: 'snap-app' });
    saveSnapshot('meta');
    await vi.advanceTimersByTimeAsync(SNAPSHOT_SAVE_DEBOUNCE_MS);
    expect(setItem).not.toHaveBeenCalled(); // 2s 时元数据层还没到期
    saveSnapshot('meta'); // 搭车既有排队，不重置计时
    await vi.advanceTimersByTimeAsync(SNAPSHOT_META_SAVE_DEBOUNCE_MS - SNAPSHOT_SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('O11 分层保存：layout 请求接管排队中的 meta（提前到 2s 落盘）', async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    store().openWindow({ typeId: 'snap-app' });
    saveSnapshot('meta');
    saveSnapshot(); // layout 接管
    await vi.advanceTimersByTimeAsync(SNAPSHOT_SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    // 反向：layout 排队时 meta 请求直接搭车，不追加写盘
    store().moveWindow(Object.keys(store().windows)[0], { x: 10, y: 10, w: 400, h: 300 });
    saveSnapshot();
    saveSnapshot('meta');
    await vi.advanceTimersByTimeAsync(SNAPSHOT_META_SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('O11 写盘去重：内容未变的防抖保存跳过 IO（flush 强制写）', async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const id = store().openWindow({ typeId: 'snap-app' });
    saveSnapshot();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    saveSnapshot(); // 状态没变 → 跳过写盘
    await vi.advanceTimersByTimeAsync(SNAPSHOT_SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    store().moveWindow(id, { x: 5, y: 5, w: 400, h: 300 });
    saveSnapshot(); // 内容变化 → 正常落盘
    await vi.advanceTimersByTimeAsync(SNAPSHOT_SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(2);
    await flushSnapshot(); // flush 跳过去重强制写
    expect(setItem).toHaveBeenCalledTimes(3);
  });
});

describe('快照往返（DoD）', () => {
  it('save→load→hydrate 后 frame / displayMode / restoreFrame / ratio 完全一致', async () => {
    const a = store().openWindow({
      typeId: 'snap-app',
      title: 'floating 窗',
      initialFrame: { x: 120, y: 80, w: 640, h: 480 },
    });
    const b = store().openWindow({
      typeId: 'snap-app',
      instanceKey: 'res_9',
      title: 'tiled 窗',
      initialFrame: { x: 300, y: 200, w: 500, h: 400 },
    });
    store().setDisplayMode(b, 'tiled-left');
    store().setTilingRatio(`${b}:${a}`, 0.62);
    store().minimizeWindow(a);

    const before = {
      windows: Object.fromEntries(
        Object.values(store().windows).map((w) => [
          w.id,
          {
            frame: w.frame,
            restoreFrame: w.restoreFrame,
            displayMode: w.displayMode,
            minimized: w.minimized,
            title: w.title,
            instanceKey: w.instanceKey,
          },
        ]),
      ),
      tilingRatios: { ...store().tilingRatios },
    };

    await flushSnapshot();
    resetWindowStoreForTests({ w: 1600, h: 900 });
    expect(store().windows).toEqual({});

    const snap = await loadSnapshot();
    expect(snap).not.toBeNull();
    store().hydrate(snap!.windows, snap!.tilingRatios);

    const s = store();
    expect(s.tilingRatios).toEqual(before.tilingRatios);
    for (const [id, expected] of Object.entries(before.windows)) {
      const win = s.windows[id];
      expect(win).toBeDefined();
      expect(win.frame).toEqual(expected.frame);
      expect(win.restoreFrame).toEqual(expected.restoreFrame);
      expect(win.displayMode).toBe(expected.displayMode);
      expect(win.minimized).toBe(expected.minimized);
      expect(win.title).toBe(expected.title);
      expect(win.instanceKey).toBe(expected.instanceKey);
    }
    // snapshot 不持久化 lifecycle；hydrate 会按当前窗口栈重建运行态档位
    const topId = s.focusStack.at(-1);
    expect(s.lifecycles).toEqual(
      Object.fromEntries(
        Object.keys(s.windows).map((id) => [id, id === topId ? 'focused' : 'background']),
      ),
    );
    expect(s.launchPayloads).toEqual({});
    expect(s.transientPhases).toEqual({});
  });
});
