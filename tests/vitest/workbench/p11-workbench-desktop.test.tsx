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

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  onCloseRequested: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: tauriMocks.onCloseRequested,
  }),
}));
vi.mock('@/features/chat/core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: vi.fn(async () => ({ id: 'sess_test' })),
}));
// 壁纸管理面板由并行任务实现：总装冒烟只依赖事件常量契约，用最小 mock 隔离其内部实现
vi.mock('@/features/workbench/components/WallpaperManagerDialog', () => ({
  OPEN_WALLPAPER_MANAGER_EVENT: 'workbench:open-wallpaper-manager',
  WallpaperManagerDialog: () => null,
}));

import {
  WorkbenchDesktop,
  migrateLegacyNotesSnapshotWindows,
} from '@/features/workbench/components/WorkbenchDesktop';
import { getDockPinned, setDockPinned } from '@/features/workbench/components/Dock';
import { closeAppsPanel, openAppsPanel } from '@/features/workbench/components/appsPanelStore';
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
    tauriMocks.invoke.mockReset().mockResolvedValue(null);
    tauriMocks.onCloseRequested.mockReset();
    localStorage.clear();
    resetWindowStoreForTests();
    setDockPinned([]);
    closeAppsPanel();
    workbenchBus.setEnabled(true);
    ensureTestApp();
  });

  afterEach(() => {
    cleanup();
    closeAppsPanel();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
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

  it('窗口工作区从顶栏下缘开始，最大化只占用工作区', async () => {
    render(<WorkbenchDesktop />);
    await waitFor(() => expect(document.querySelector('[data-wb-workarea]')).toBeTruthy());

    const workArea = document.querySelector<HTMLElement>('[data-wb-workarea]')!;
    const windowLayer = document.querySelector<HTMLElement>('[data-wb-window-layer]')!;
    expect(workArea.style.top).toBe('var(--wb-workarea-top)');
    expect(windowLayer.parentElement).toBe(workArea);

    let windowId: string | null = null;
    act(() => {
      useWindowStore.getState().setDesktopSize({ w: 1600, h: 860 });
      windowId = workbenchBus.launch({ typeId: TEST_TYPE_ID, reason: 'api' });
      useWindowStore.getState().setDisplayMode(windowId!, 'maximized');
    });

    await waitFor(() => {
      const shell = document.querySelector<HTMLElement>(`[data-wb-window-id="${windowId}"]`);
      expect(shell).toBeTruthy();
      expect(shell?.style.top).toBe('0px');
      expect(shell?.style.height).toBe('860px');
    });
  });

  it('全部应用面板也约束在顶栏下方的工作区内', async () => {
    render(<WorkbenchDesktop />);
    await waitFor(() => expect(document.querySelector('[data-wb-workarea]')).toBeTruthy());

    act(() => openAppsPanel());
    await waitFor(() => expect(screen.getByTestId('wb-apps-panel')).toBeTruthy());

    const workArea = document.querySelector<HTMLElement>('[data-wb-workarea]')!;
    expect(screen.getByTestId('wb-apps-panel').parentElement).toBe(workArea);
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

  it('升级旧快照时将多个 note/mindmap 窗口折叠成 Notes 单例', () => {
    const makeWindow = (id: string, typeId: string, lastFocusedAt: number) => ({
      id,
      typeId,
      instanceKey: `${typeId}_${id}`,
      title: typeId,
      frame: { x: 60, y: 40, w: 400, h: 300 },
      restoreFrame: null,
      displayMode: 'floating' as const,
      minimized: false,
      zIndex: 10,
      createdAt: lastFocusedAt,
      lastFocusedAt,
    });
    const migrated = migrateLegacyNotesSnapshotWindows([
      makeWindow('old-note', 'note', 1),
      makeWindow('old-map', 'mindmap', 2),
      makeWindow('files', 'files', 3),
    ]);

    expect(migrated.map((win) => win.typeId)).toEqual(['notes', 'files']);
    expect(migrated[0]).toMatchObject({ id: 'old-map', instanceKey: null, title: '' });
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

  it('不拦截 Tauri 原生关闭请求，卸载时仅尽力保存快照', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { unmount } = render(<WorkbenchDesktop />);
    await waitFor(() => expect(document.querySelector('.wb-empty-desktop')).toBeTruthy());

    act(() => {
      workbenchBus.launch({ typeId: TEST_TYPE_ID, instanceKey: 'close-contract', reason: 'api' });
    });
    unmount();

    expect(tauriMocks.onCloseRequested).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        'save_setting',
        expect.objectContaining({ key: WORKBENCH_SNAPSHOT_KEY }),
      );
    });
  });
});
