/**
 * Workbench 壳层交互修复回归测试
 *
 * 覆盖本轮修复的可观察契约：
 * 1) 菜单栏关窗走 requestCloseAnimated（canClose guard 生效，不再绕过 store）
 * 2) 单独按 `/` 不再命中速查表；`?` / Shift+/ 照常命中
 * 3) 桌面右键菜单 / 品牌菜单可打开速查表
 * 4) 空态与 tour 解耦：跳过 tour 后主 CTA 仍在；「重新查看引导」可复活
 * 5) 桌面组件（日程小组件）可关；WorkbenchDesktop 根节点 isolation
 * 6) 沉浸模式提供可见退出提示与退出按钮
 * 7) 俯瞰打开时窗口层 inert + aria-hidden
 * 8) 空桌面「恢复上次桌面」CTA（仅在有快照且未开自动恢复时出现）
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent, within } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@/features/chat/core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: vi.fn(async () => ({ id: 'sess_test' })),
}));
vi.mock('@/features/workbench/components/WallpaperManagerDialog', () => ({
  OPEN_WALLPAPER_MANAGER_EVENT: 'workbench:open-wallpaper-manager',
  WallpaperManagerDialog: () => null,
}));

import { WorkbenchDesktop } from '@/features/workbench/components/WorkbenchDesktop';
import { StatusBar } from '@/features/workbench/components/StatusBar';
import { ImmersiveHint } from '@/features/workbench/components/ImmersiveHint';
import { EmptyDesktop, EMPTY_DESKTOP_ONBOARDING_KEY } from '@/features/workbench/components/EmptyDesktop';
import { setDockPinned } from '@/features/workbench/components/Dock';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useWindowStore, resetWindowStoreForTests } from '@/features/workbench/core/windowStore';
import {
  matchWorkbenchShortcut,
  useWorkbenchOverlay,
} from '@/features/workbench/core/shortcuts';
import {
  enterImmersive,
  resetImmersiveModeForTests,
} from '@/features/workbench/core/immersiveMode';

const TEST_TYPE_ID = 'shell-ux-smoke';
const GUARDED_TYPE_ID = 'shell-ux-guarded';

/** canClose 返回值由测试逐例改写；默认放行 */
let guardAllows = true;
const guardCalls: string[] = [];

function ensureTestApps(): void {
  if (!appRegistry.get(TEST_TYPE_ID)) {
    appRegistry.register({
      typeId: TEST_TYPE_ID,
      nameKey: 'workbench:apps.files',
      icon: null,
      instanceMode: 'multi',
      memoryWeight: 1,
      defaultFrame: { w: 400, h: 300 },
      minSize: { w: 200, h: 150 },
      render: React.lazy(async () => ({ default: () => <div data-testid="shell-ux-app" /> })),
    });
  }
  if (!appRegistry.get(GUARDED_TYPE_ID)) {
    appRegistry.register({
      typeId: GUARDED_TYPE_ID,
      nameKey: 'workbench:apps.files',
      icon: null,
      instanceMode: 'multi',
      memoryWeight: 1,
      defaultFrame: { w: 400, h: 300 },
      minSize: { w: 200, h: 150 },
      canClose: (instanceKey?: string) => {
        guardCalls.push(instanceKey ?? '');
        return guardAllows;
      },
      render: React.lazy(async () => ({ default: () => <div data-testid="shell-ux-guarded-app" /> })),
    });
  }
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

function getDesktopRoot(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-wb-desktop]');
  if (!el) throw new Error('desktop root not mounted');
  return el;
}

async function mountDesktop(): Promise<HTMLElement> {
  render(<WorkbenchDesktop />);
  await waitFor(() => {
    expect(document.querySelector('.wb-empty-desktop')).toBeTruthy();
  });
  return getDesktopRoot();
}

function openDesktopMenu(root: HTMLElement): HTMLElement {
  fireEvent.contextMenu(root, { clientX: 120, clientY: 140 });
  const menu = document.querySelector<HTMLElement>('[data-wb-desk-menu]');
  if (!menu) throw new Error('desktop context menu did not open');
  return menu;
}

beforeEach(() => {
  localStorage.clear();
  guardAllows = true;
  guardCalls.length = 0;
  resetWindowStoreForTests();
  resetImmersiveModeForTests();
  useWorkbenchOverlay.getState().closeCheatsheet();
  setDockPinned([]);
  workbenchBus.setEnabled(true);
  ensureTestApps();
});

afterEach(() => {
  cleanup();
  workbenchBus.setEnabled(false);
  resetImmersiveModeForTests();
});

// ---------------------------------------------------------------------------
// 1) 菜单栏关窗统一走 requestCloseAnimated
// ---------------------------------------------------------------------------

describe('菜单栏关窗走 close guard', () => {
  it('「关闭窗口」被 canClose 拒绝时窗口留下；放行时才移除', async () => {
    render(<StatusBar />);
    let winId = '';
    act(() => {
      winId = useWindowStore.getState().openWindow({
        typeId: GUARDED_TYPE_ID,
        instanceKey: 'guarded-1',
      });
    });

    guardAllows = false;
    fireEvent.click(screen.getByTestId('wb-menubar-appmenu'));
    fireEvent.click(await screen.findByTestId('wb-menubar-app-close-window'));
    await waitFor(() => {
      expect(guardCalls).toContain('guarded-1');
    });
    // guard 拒绝 → 既不进 closing 相位也不落库删除
    expect(useWindowStore.getState().windows[winId]).toBeTruthy();
    expect(useWindowStore.getState().transientPhases?.[winId]).not.toBe('closing');

    guardAllows = true;
    fireEvent.click(screen.getByTestId('wb-menubar-appmenu'));
    fireEvent.click(await screen.findByTestId('wb-menubar-app-close-window'));
    await waitFor(() => {
      expect(useWindowStore.getState().windows[winId]).toBeUndefined();
    });
  });

  it('「全部关闭」逐窗过 guard：被拒的窗口全部留在桌面上', async () => {
    render(<StatusBar />);
    act(() => {
      useWindowStore.getState().openWindow({ typeId: GUARDED_TYPE_ID, instanceKey: 'g-a' });
      useWindowStore.getState().openWindow({ typeId: GUARDED_TYPE_ID, instanceKey: 'g-b' });
    });

    guardAllows = false;
    fireEvent.click(screen.getByTestId('wb-menubar-appmenu'));
    fireEvent.click(await screen.findByTestId('wb-menubar-app-close-all'));

    await waitFor(() => {
      expect(guardCalls.sort()).toEqual(['g-a', 'g-b']);
    });
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(2);

    guardAllows = true;
    fireEvent.click(screen.getByTestId('wb-menubar-appmenu'));
    fireEvent.click(await screen.findByTestId('wb-menubar-app-close-all'));
    await waitFor(() => {
      expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2/3) 速查表：`/` 不再误触 + 菜单入口
// ---------------------------------------------------------------------------

describe('速查表可发现性', () => {
  it('单独 `/` 不命中任何快捷键；`?` 与 Shift+/ 仍命中速查表', () => {
    expect(matchWorkbenchShortcut(keydown({ key: '/', code: 'Slash' }))).toBeNull();
    expect(matchWorkbenchShortcut(keydown({ key: '/', code: 'Slash', shiftKey: true }))).toBeNull();
    expect(matchWorkbenchShortcut(keydown({ key: '?', code: 'Slash' }))?.id).toBe('cheatsheet');
    expect(
      matchWorkbenchShortcut(keydown({ key: '?', code: 'Slash', shiftKey: true }))?.id,
    ).toBe('cheatsheet');
  });

  it('桌面右键菜单「键盘快捷键」打开速查表', async () => {
    const root = await mountDesktop();
    const menu = openDesktopMenu(root);
    fireEvent.click(within(menu).getByTestId('wb-desk-menu-shortcuts'));

    expect(useWorkbenchOverlay.getState().cheatsheetOpen).toBe(true);
    await waitFor(() => {
      expect(document.querySelector('[data-wb-desk-menu]')).toBeNull();
    });
  });

  it('品牌菜单「键盘快捷键」打开速查表', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-brand'));
    fireEvent.click(await screen.findByTestId('wb-menubar-brand-shortcuts'));
    expect(useWorkbenchOverlay.getState().cheatsheetOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4) 空态与引导解耦
// ---------------------------------------------------------------------------

describe('空桌面与引导解耦', () => {
  it('跳过 tour 后主 CTA 仍在；「重新查看引导」可复活 tour', () => {
    render(<EmptyDesktop />);
    expect(screen.getByTestId('wb-empty-tour')).toBeTruthy();

    fireEvent.click(screen.getByTestId('wb-empty-tour-skip'));
    expect(screen.queryByTestId('wb-empty-tour')).toBeNull();
    // 主 CTA 不随 tour 一起消失
    expect(screen.getByText('打开资源库')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent('workbench:empty-desktop-replay-tour'));
    });
    expect(screen.getByTestId('wb-empty-tour')).toBeTruthy();
  });

  it('「不再显示」永久消隐 tour，主 CTA 与卡片仍渲染；重播清掉持久标记', () => {
    render(<EmptyDesktop />);
    fireEvent.click(screen.getByTestId('wb-empty-tour-dont-show'));

    expect(localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY)).toBe('1');
    expect(screen.queryByTestId('wb-empty-tour')).toBeNull();
    expect(screen.getByText('打开资源库')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent('workbench:empty-desktop-replay-tour'));
    });
    expect(localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY)).toBeNull();
    expect(screen.getByTestId('wb-empty-tour')).toBeTruthy();
  });

  it('「恢复上次桌面」次级 CTA 仅在有快照时出现', () => {
    const onRestore = vi.fn();
    const { rerender } = render(<EmptyDesktop />);
    expect(screen.queryByTestId('wb-empty-restore-session')).toBeNull();

    rerender(<EmptyDesktop restoreAvailable onRestoreSession={onRestore} />);
    fireEvent.click(screen.getByTestId('wb-empty-restore-session'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5/6) 根节点 isolation + 桌面组件可关
// ---------------------------------------------------------------------------

describe('桌面根节点与桌面组件', () => {
  it('根节点自成 stacking context（isolation: isolate）', async () => {
    await mountDesktop();
    const rootEl = document.querySelector<HTMLElement>('[data-wb-workbench-root]');
    expect(rootEl).toBeTruthy();
    expect(rootEl!.style.isolation).toBe('isolate');
  });

  it('桌面右键菜单可关掉桌面组件，并写入 desktop.* 设置通道', async () => {
    const root = await mountDesktop();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="wb-agenda-widget"]')).toBeTruthy();
    });

    const menu = openDesktopMenu(root);
    const toggle = within(menu).getByTestId('wb-desk-menu-widgets');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="wb-agenda-widget"]')).toBeNull();
    });
    expect(localStorage.getItem('desktop.workbenchDesktopWidgets')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// 7) 沉浸模式可见退出
// ---------------------------------------------------------------------------

describe('沉浸模式退出提示', () => {
  it('非沉浸时不渲染；进入沉浸后给出提示与退出按钮，点击即退出', async () => {
    let winId = '';
    act(() => {
      winId = useWindowStore.getState().openWindow({ typeId: TEST_TYPE_ID });
    });

    render(<ImmersiveHint />);
    expect(screen.queryByTestId('wb-immersive-hint')).toBeNull();

    act(() => {
      enterImmersive(winId);
    });

    const hint = await screen.findByTestId('wb-immersive-hint');
    expect(hint.getAttribute('data-visible')).toBe('true');
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.textContent).toContain('Esc');

    fireEvent.click(screen.getByTestId('wb-immersive-hint-exit'));
    await waitFor(() => {
      expect(screen.queryByTestId('wb-immersive-hint')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 8) 俯瞰打开时窗口层 inert
// ---------------------------------------------------------------------------

describe('俯瞰期间窗口层 inert', () => {
  it('Exposé 打开 → 窗口层 inert + aria-hidden；关闭后复原', async () => {
    await mountDesktop();
    act(() => {
      workbenchBus.launch({ typeId: TEST_TYPE_ID, instanceKey: 'expose-1', reason: 'api' });
    });

    const layer = document.querySelector<HTMLElement>('[data-wb-window-layer]');
    expect(layer).toBeTruthy();
    expect(layer!.hasAttribute('inert')).toBe(false);

    act(() => {
      useWorkbenchOverlay.getState().openExpose();
    });
    await waitFor(() => {
      expect(layer!.hasAttribute('inert')).toBe(true);
    });
    expect(layer!.getAttribute('aria-hidden')).toBe('true');

    act(() => {
      useWorkbenchOverlay.getState().closeExpose();
    });
    await waitFor(() => {
      expect(layer!.hasAttribute('inert')).toBe(false);
    });
    expect(layer!.hasAttribute('aria-hidden')).toBe(false);
  });
});
