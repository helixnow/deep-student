/**
 * P11 总装冒烟测试 — WorkbenchDesktop 装配链路
 *
 * 覆盖：桌面挂载（壁纸 / Dock / 空桌面引导）、应用注册装配、
 * Dock pinned 默认值、bus.launch 开窗（WindowShell 带 data-wb-window-id）、
 * 快照保存（flushSnapshot → localStorage + workbench:snapshot-saved 事件）、
 * legacy 降级映射（translateLegacyNavigation）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
// 避免把 chat 重 UI / 会话核心拖进冒烟测试
vi.mock('@/features/chat/components/AnkiPanelHost', () => ({
  AnkiPanelHost: () => null,
  default: () => null,
}));
vi.mock('@/features/chat/core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: vi.fn(async () => ({ id: 'sess_test' })),
}));

import { WorkbenchDesktop } from '@/features/workbench/components/WorkbenchDesktop';
import { getDockPinned, setDockPinned } from '@/features/workbench/components/Dock';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useWindowStore, resetWindowStoreForTests } from '@/features/workbench/core/windowStore';
import { flushSnapshot, WORKBENCH_SNAPSHOT_KEY } from '@/features/workbench/core/snapshot';
import { translateLegacyNavigation } from '@/features/workbench/core/legacyNavigationMap';

const TEST_TYPE_ID = 'p11-smoke';

function ensureTestApp(): void {
  if (appRegistry.get(TEST_TYPE_ID)) return;
  appRegistry.register({
    typeId: TEST_TYPE_ID,
    nameKey: 'workbench:apps.files',
    icon: null,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({
      default: () => <div data-testid="p11-smoke-app" />,
    })),
  });
}

describe('P11 WorkbenchDesktop 总装', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWindowStoreForTests();
    setDockPinned([]);
    workbenchBus.setEnabled(true);
    ensureTestApp();
  });

  afterEach(() => {
    cleanup();
    workbenchBus.setEnabled(false);
  });

  it('挂载后渲染壁纸 + Dock，水合完成后显示空桌面引导，pinned 应用注册齐全', async () => {
    render(<WorkbenchDesktop />);

    await waitFor(() => {
      expect(screen.getByTestId('wb-dock')).toBeTruthy();
    });
    // 水合完成（无快照 → 空桌面）
    await waitFor(() => {
      expect(document.querySelector('.wb-empty-desktop')).toBeTruthy();
    });
    expect(document.querySelector('.wb-wallpaper')).toBeTruthy();

    // Dock pinned 默认值
    expect(getDockPinned()).toEqual(['chat', 'files', 'settings', 'todo']);
    // registerAll 装配：默认固定的四个应用全部已注册
    for (const typeId of getDockPinned()) {
      expect(appRegistry.get(typeId), `app not registered: ${typeId}`).toBeTruthy();
    }
  });

  it('bus.launch 开窗：WindowShell 携带 data-wb-window-id，空桌面引导消失', async () => {
    render(<WorkbenchDesktop />);
    await waitFor(() => expect(document.querySelector('.wb-empty-desktop')).toBeTruthy());

    let windowId: string | null = null;
    act(() => {
      windowId = workbenchBus.launch({ typeId: TEST_TYPE_ID, reason: 'api' });
    });
    expect(windowId).toBeTruthy();

    await waitFor(() => {
      const el = document.querySelector(`[data-wb-window-id="${windowId}"]`);
      expect(el).toBeTruthy();
    });
    expect(document.querySelector('.wb-empty-desktop')).toBeNull();
  });

  it('快照落盘：flushSnapshot 写 localStorage 并派发 workbench:snapshot-saved', async () => {
    render(<WorkbenchDesktop />);
    await waitFor(() => expect(document.querySelector('.wb-empty-desktop')).toBeTruthy());

    act(() => {
      workbenchBus.launch({ typeId: TEST_TYPE_ID, instanceKey: 'smoke-1', reason: 'api' });
    });

    const savedEvents: number[] = [];
    const onSaved = (e: Event) => {
      savedEvents.push((e as CustomEvent<{ at: number }>).detail.at);
    };
    window.addEventListener('workbench:snapshot-saved', onSaved);
    await flushSnapshot();
    window.removeEventListener('workbench:snapshot-saved', onSaved);

    const raw = localStorage.getItem(WORKBENCH_SNAPSHOT_KEY);
    expect(raw).toBeTruthy();
    const snapshot = JSON.parse(raw as string);
    expect(snapshot.version).toBe(1);
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0].typeId).toBe(TEST_TYPE_ID);
    expect(snapshot.windows[0].instanceKey).toBe('smoke-1');
    expect(snapshot.dockPinned).toEqual(['chat', 'files', 'settings', 'todo']);
    expect(savedEvents).toHaveLength(1);
  });

  it('快照恢复：挂载前写入快照 → hydrate 后窗口恢复', async () => {
    const snapshot = {
      version: 1,
      windows: [
        {
          id: 'w-restored',
          typeId: TEST_TYPE_ID,
          instanceKey: 'smoke-2',
          title: '恢复窗',
          frame: { x: 60, y: 40, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 10,
          createdAt: 1,
          lastFocusedAt: 1,
        },
      ],
      dockPinned: ['files'],
      tilingRatios: {},
    };
    localStorage.setItem(WORKBENCH_SNAPSHOT_KEY, JSON.stringify(snapshot));

    render(<WorkbenchDesktop />);

    await waitFor(() => {
      expect(document.querySelector('[data-wb-window-id="w-restored"]')).toBeTruthy();
    });
    const win = useWindowStore.getState().windows['w-restored'];
    expect(win.frame).toEqual({ x: 60, y: 40, w: 400, h: 300 });
    expect(win.displayMode).toBe('floating');
    // 快照 dockPinned 非空 → 原样恢复（不套默认值）
    expect(getDockPinned()).toEqual(['files']);
  });

  it('legacy 降级映射：chat / 资源 / 系统视图翻译为现有 CustomEvent', () => {
    const events: Array<{ name: string; detail: unknown }> = [];
    const listener = (e: Event) => {
      events.push({ name: e.type, detail: (e as CustomEvent).detail });
    };
    window.addEventListener('NAVIGATE_TO_VIEW', listener);

    translateLegacyNavigation({ typeId: 'chat', reason: 'api' }, 'launch');
    translateLegacyNavigation(
      { typeId: 'note', instanceKey: 'note_1', reason: 'api' },
      'launch',
    );
    translateLegacyNavigation({ typeId: 'settings', reason: 'api' }, 'launch');

    window.removeEventListener('NAVIGATE_TO_VIEW', listener);

    expect(events.map((e) => (e.detail as { view: string }).view)).toEqual([
      'chat-v2',
      'learning-hub',
      'settings',
    ]);
    expect((events[1].detail as { openResource: string }).openResource).toBe('/note_1');
  });
});
