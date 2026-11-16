/**
 * L1：引用跳转开出的资源窗开在来源窗旁边，不盖住刚点的回答。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { appRegistry } from '../appRegistry';
import { planBesidePlacement } from '../besidePlacement';
import { workbenchBus } from '../workbenchBus';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { computeTiledFrame, DEFAULT_TILE_MARGIN, tilingPairKey } from '../tiling';
import type { AppDefinition, Frame, WorkbenchWindow } from '../types';

const CHAT_MIN = { w: 640, h: 460 };
const READER_MIN = { w: 420, h: 320 };

function win(partial: Partial<WorkbenchWindow> & { frame: Frame }): WorkbenchWindow {
  return {
    id: 'anchor',
    typeId: 'beside-chat',
    instanceKey: null,
    title: '',
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    createdAt: 0,
    lastFocusedAt: 0,
    ...partial,
  };
}

const plan = (anchor: WorkbenchWindow | null, w: number, h = 900) =>
  planBesidePlacement({
    anchor,
    desktopSize: { w, h },
    resourceMinSize: READER_MIN,
    anchorMinSize: CHAT_MIN,
  });

describe('planBesidePlacement', () => {
  it('wide desktop + floating source straddling the middle → source left half, reader right half', () => {
    const result = plan(win({ frame: { x: 48, y: 48, w: 1080, h: 720 } }), 1920);
    expect(result).toEqual({ anchorMode: 'tiled-left', resourceMode: 'tiled-right' });
  });

  it('keeps the left half wide enough for the chat minimum when the desktop is just wide enough', () => {
    const result = plan(win({ frame: { x: 48, y: 48, w: 1080, h: 720 } }), 1180);
    expect(result?.anchorMode).toBe('tiled-left');
    const avail = 1180 - DEFAULT_TILE_MARGIN * 3;
    expect(result!.ratio! * avail).toBeGreaterThanOrEqual(CHAT_MIN.w - 0.5);
    expect((1 - result!.ratio!) * avail).toBeGreaterThanOrEqual(READER_MIN.w - 0.5);
  });

  it('respects a user-placed source that already sits in the left half: reader fills the space beside it', () => {
    const result = plan(win({ frame: { x: 20, y: 30, w: 760, h: 700 } }), 1920);
    expect(result?.anchorMode).toBeUndefined();
    expect(result?.resourceMode).toBe('floating');
    expect(result!.resourceFrame!.x).toBeGreaterThanOrEqual(780);
    expect(result!.resourceFrame!.x + result!.resourceFrame!.w).toBeLessThanOrEqual(1920);
  });

  it('respects a user-placed source in the right half: reader goes to its left, source untouched', () => {
    const result = plan(win({ frame: { x: 1100, y: 30, w: 760, h: 700 } }), 1920);
    expect(result?.anchorMode).toBeUndefined();
    expect(result!.resourceFrame!.x + result!.resourceFrame!.w).toBeLessThanOrEqual(1100);
  });

  it('snapped source: reader takes the complementary snap zone', () => {
    expect(plan(win({ frame: { x: 0, y: 0, w: 1, h: 1 }, displayMode: 'tiled-left' }), 1920))
      .toEqual({ resourceMode: 'tiled-right' });
    expect(plan(win({ frame: { x: 0, y: 0, w: 1, h: 1 }, displayMode: 'tiled-right' }), 1920))
      .toEqual({ resourceMode: 'tiled-left' });
    expect(plan(win({ frame: { x: 0, y: 0, w: 1, h: 1 }, displayMode: 'tiled-top' }), 1920))
      .toEqual({ resourceMode: 'tiled-bottom' });
  });

  it('user-maximised source on a wide desktop stays maximised; reader floats on the right half', () => {
    const result = plan(win({ frame: { x: 0, y: 0, w: 1, h: 1 }, displayMode: 'maximized' }), 1920);
    expect(result?.anchorMode).toBeUndefined();
    const half = computeTiledFrame('tiled-right', { desktopSize: { w: 1920, h: 900 }, margin: DEFAULT_TILE_MARGIN })!;
    expect(result?.resourceMode).toBe('floating');
    expect(result!.resourceFrame!.x).toBe(half.x);
    expect(result!.resourceFrame!.w).toBe(half.w);
  });

  it('auto-maximised source on a small desktop that still fits both → side by side', () => {
    const result = plan(win({ frame: { x: 0, y: 0, w: 1, h: 1 }, displayMode: 'maximized' }), 1200);
    expect(result?.anchorMode).toBe('tiled-left');
    expect(result?.resourceMode).toBe('tiled-right');
  });

  it('narrow desktop: reader docks on the roomier side of the source instead of the cascade slot', () => {
    const result = plan(win({ frame: { x: 0, y: 0, w: 640, h: 600 } }), 1000);
    expect(result?.anchorMode).toBeUndefined();
    expect(result?.resourceMode).toBe('floating');
    // 右侧 1000-640-16 = 344 < 420：贴右边缘取最小宽，尽量少压住来源窗
    expect(result!.resourceFrame!.w).toBe(READER_MIN.w);
    expect(result!.resourceFrame!.x + result!.resourceFrame!.w).toBe(1000 - DEFAULT_TILE_MARGIN);
  });

  it('no usable source window → default cascade', () => {
    expect(plan(null, 1920)).toBeNull();
    expect(plan(win({ frame: { x: 0, y: 0, w: 900, h: 600 }, minimized: true }), 1920)).toBeNull();
  });
});

const register = (typeId: string, minSize: { w: number; h: number }) => {
  if (appRegistry.get(typeId)) return;
  appRegistry.register({
    typeId,
    nameKey: `workbench:test.${typeId}`,
    icon: null,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 1080, h: 720 },
    minSize,
    render: null as unknown as AppDefinition['render'],
  });
};
register('beside-chat', CHAT_MIN);
register('beside-reader', READER_MIN);

describe('workbenchBus.launch placement:beside', () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1920, h: 1000 });
    workbenchBus.setEnabled(true);
  });

  const openChat = (frame?: Partial<Frame>) =>
    useWindowStore.getState().openWindow({ typeId: 'beside-chat', instanceKey: 'sess_1', initialFrame: frame });

  it('wide desktop: chat goes to the left half, the new reader to the right half', () => {
    const chatId = openChat({ x: 48, y: 48 });
    const readerId = workbenchBus.launch({
      typeId: 'beside-reader',
      instanceKey: 'file_paper',
      placement: { mode: 'beside', anchorWindowId: chatId },
      reason: 'api',
    })!;
    const { windows } = useWindowStore.getState();
    expect(windows[chatId].displayMode).toBe('tiled-left');
    expect(windows[chatId].restoreFrame).toEqual(expect.objectContaining({ x: 48, y: 48 }));
    expect(windows[readerId].displayMode).toBe('tiled-right');
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(readerId);
    expect(useWindowStore.getState().tilingRatios[tilingPairKey(chatId, readerId)]).toBeUndefined();
  });

  it('falls back to the focused window when no anchor id is given', () => {
    const chatId = openChat({ x: 48, y: 48 });
    const readerId = workbenchBus.launch({
      typeId: 'beside-reader', instanceKey: 'file_b', placement: { mode: 'beside' }, reason: 'api',
    })!;
    expect(useWindowStore.getState().windows[chatId].displayMode).toBe('tiled-left');
    expect(useWindowStore.getState().windows[readerId].displayMode).toBe('tiled-right');
  });

  it('an already open reader is only focused — never moved, and the chat is left alone', () => {
    const chatId = openChat({ x: 48, y: 48 });
    const readerId = useWindowStore.getState().openWindow({
      typeId: 'beside-reader', instanceKey: 'file_paper', initialFrame: { x: 300, y: 120, w: 700, h: 600 },
    });
    useWindowStore.getState().focusWindow(chatId);
    const before = useWindowStore.getState().windows[readerId].frame;
    const id = workbenchBus.launch({
      typeId: 'beside-reader', instanceKey: 'file_paper', placement: { mode: 'beside', anchorWindowId: chatId }, reason: 'api',
    });
    const { windows, focusStack } = useWindowStore.getState();
    expect(id).toBe(readerId);
    expect(windows[readerId].frame).toEqual(before);
    expect(windows[readerId].displayMode).toBe('floating');
    expect(windows[chatId].displayMode).toBe('floating');
    expect(focusStack.at(-1)).toBe(readerId);
  });

  it('a chat the user moved into the right half stays put; the reader opens to its left', () => {
    const chatId = openChat({ x: 1100, y: 40, w: 780, h: 800 });
    const readerId = workbenchBus.launch({
      typeId: 'beside-reader', instanceKey: 'file_c', placement: { mode: 'beside', anchorWindowId: chatId }, reason: 'api',
    })!;
    const { windows } = useWindowStore.getState();
    expect(windows[chatId].displayMode).toBe('floating');
    expect(windows[chatId].frame).toEqual({ x: 1100, y: 40, w: 780, h: 800 });
    expect(windows[readerId].displayMode).toBe('floating');
    expect(windows[readerId].frame.x + windows[readerId].frame.w).toBeLessThanOrEqual(1100);
  });

  it('a user-maximised chat is not un-maximised', () => {
    const chatId = openChat({ x: 48, y: 48 });
    useWindowStore.getState().setDisplayMode(chatId, 'maximized');
    const readerId = workbenchBus.launch({
      typeId: 'beside-reader', instanceKey: 'file_d', placement: { mode: 'beside', anchorWindowId: chatId }, reason: 'api',
    })!;
    const { windows } = useWindowStore.getState();
    expect(windows[chatId].displayMode).toBe('maximized');
    expect(windows[readerId].displayMode).toBe('floating');
    expect(windows[readerId].frame.x).toBeGreaterThan(900);
  });

  it('narrow desktop (windows auto-maximised): reader docks beside instead of covering everything', () => {
    resetWindowStoreForTests({ w: 1000, h: 760 });
    const chatId = openChat();
    expect(useWindowStore.getState().windows[chatId].displayMode).toBe('maximized');
    const readerId = workbenchBus.launch({
      typeId: 'beside-reader', instanceKey: 'file_e', placement: { mode: 'beside', anchorWindowId: chatId }, reason: 'api',
    })!;
    const reader = useWindowStore.getState().windows[readerId];
    expect(reader.displayMode).toBe('floating');
    expect(reader.frame.w).toBeLessThan(1000);
    expect(reader.frame.x + reader.frame.w).toBeLessThanOrEqual(1000);
  });
});
