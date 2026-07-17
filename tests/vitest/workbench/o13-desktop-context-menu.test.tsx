/**
 * O13 — 桌面右键菜单 / 桌面手势冒烟测试
 *
 * 覆盖：空白区右键开菜单（非空白不开）、Esc 关闭、平铺全部、整理窗口、
 * 双击空白 show desktop 往返、壁纸预设切换（settings-changed 热更新 + localStorage 兜底持久化）。
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

import { WorkbenchDesktop } from '@/features/workbench/components/WorkbenchDesktop';
import { setDockPinned } from '@/features/workbench/components/Dock';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useWindowStore, resetWindowStoreForTests } from '@/features/workbench/core/windowStore';

const TEST_TYPE_ID = 'o13-desk-smoke';

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
      default: () => <div data-testid="o13-smoke-app" />,
    })),
  });
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

function launchWindows(count: number): string[] {
  const ids: string[] = [];
  act(() => {
    for (let i = 0; i < count; i++) {
      const id = workbenchBus.launch({
        typeId: TEST_TYPE_ID,
        instanceKey: `o13-${i}`,
        reason: 'api',
      });
      if (id) ids.push(id);
    }
  });
  expect(ids).toHaveLength(count);
  return ids;
}

function openDesktopMenu(root: HTMLElement): HTMLElement {
  fireEvent.contextMenu(root, { clientX: 120, clientY: 140 });
  const menu = document.querySelector<HTMLElement>('[data-wb-desk-menu]');
  if (!menu) throw new Error('desktop context menu did not open');
  return menu;
}

describe('O13 桌面右键菜单 / 手势', () => {
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

  it('空白区右键打开菜单；点在非空白元素（Dock）不打开；Esc 关闭', async () => {
    const root = await mountDesktop();

    // 事件 target 非桌面根节点（Dock 区域）→ 不打开
    fireEvent.contextMenu(screen.getByTestId('wb-dock'));
    expect(document.querySelector('[data-wb-desk-menu]')).toBeNull();

    const menu = openDesktopMenu(root);
    expect(menu.getAttribute('role')).toBe('menu');
    // 基础项齐全（scope 到菜单内：空桌面引导卡等外部元素可能含同名文案）
    const m = within(menu);
    expect(m.getByText('新建对话')).toBeTruthy();
    expect(m.getByText('打开资源库')).toBeTruthy();
    expect(m.getByText('全部应用…')).toBeTruthy();
    expect(m.getByText('整理窗口')).toBeTruthy();
    expect(m.getByText('平铺全部窗口')).toBeTruthy();
    expect(m.getByText('窗口俯瞰')).toBeTruthy();
    expect(m.getByText('桌面壁纸')).toBeTruthy();
    expect(m.getByText('视觉材质')).toBeTruthy();

    // 无窗口时批量操作禁用
    expect((m.getByText('整理窗口').closest('button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(document.querySelector('[data-wb-desk-menu]')).toBeNull();
    });
  });

  it('平铺全部：两窗 → 左右分屏；整理窗口：恢复 floating 级联', async () => {
    const root = await mountDesktop();
    const [a, b] = launchWindows(2);

    openDesktopMenu(root);
    fireEvent.click(screen.getByText('平铺全部窗口'));

    const s1 = useWindowStore.getState();
    const modes = [s1.windows[a].displayMode, s1.windows[b].displayMode].sort();
    expect(modes).toEqual(['tiled-left', 'tiled-right']);
    // 菜单触发后自动关闭（离场动画播完才卸载）
    await waitFor(() => {
      expect(document.querySelector('[data-wb-desk-menu]')).toBeNull();
    });

    openDesktopMenu(root);
    fireEvent.click(screen.getByText('整理窗口'));

    const s2 = useWindowStore.getState();
    expect(s2.windows[a].displayMode).toBe('floating');
    expect(s2.windows[b].displayMode).toBe('floating');
    const frames = [s2.windows[a].frame, s2.windows[b].frame];
    // 级联：两窗位置错开
    expect(frames[0].x).not.toBe(frames[1].x);
  });

  it('双击空白 show desktop：全部最小化，再次双击恢复并聚焦原栈顶', async () => {
    const root = await mountDesktop();
    const [a, b] = launchWindows(2);

    act(() => {
      fireEvent.doubleClick(root);
    });
    // O9：逐窗 genie 编排；测试环境手动 animationend 收尾
    await act(async () => {
      document.querySelectorAll('[data-wb-window-id]').forEach((el) => {
        fireEvent.animationEnd(el);
      });
      await Promise.resolve();
    });
    const s1 = useWindowStore.getState();
    expect(s1.windows[a].minimized).toBe(true);
    expect(s1.windows[b].minimized).toBe(true);
    expect(s1.focusStack).toEqual([]);

    act(() => {
      fireEvent.doubleClick(root);
    });
    // restoring 相位同样需 animationend 清标记（反最小化本身已同步）
    await act(async () => {
      document.querySelectorAll('[data-wb-window-id]').forEach((el) => {
        fireEvent.animationEnd(el);
      });
      await Promise.resolve();
    });
    const s2 = useWindowStore.getState();
    expect(s2.windows[a].minimized).toBe(false);
    expect(s2.windows[b].minimized).toBe(false);
    // b 后开（zIndex 更高）→ 恢复后重新成为焦点栈顶
    expect(s2.focusStack[s2.focusStack.length - 1]).toBe(b);
  });

  it('壁纸预设切换：菜单选择 → 桌面热更新 data-wb-wallpaper + localStorage 持久化', async () => {
    const root = await mountDesktop();

    openDesktopMenu(root);
    // 打开壁纸子菜单（无 i18n 资源时预设名回退为 id）
    fireEvent.click(screen.getByText('桌面壁纸'));
    fireEvent.click(await screen.findByText('horizon'));

    await waitFor(() => {
      expect(
        document.querySelector('.wb-wallpaper-pane')?.getAttribute('data-wb-wallpaper-preset'),
      ).toBe('horizon');
    });
    expect(localStorage.getItem('desktop.workbenchWallpaper')).toBe(
      JSON.stringify({ kind: 'theme', value: 'horizon' }),
    );
  });

  it('二级菜单脱离一级 backdrop root，并复用同款玻璃材质', async () => {
    const root = await mountDesktop();

    const mainMenu = openDesktopMenu(root);
    fireEvent.click(screen.getByText('桌面壁纸'));

    const submenu = await screen.findByRole('menu', { name: '桌面壁纸' });
    expect(submenu).toHaveClass('wb-desk-menu', 'wb-glass-lens', 'wb-desk-menu-sub');
    expect(mainMenu.contains(submenu)).toBe(false);
    expect(submenu.parentElement).toBe(document.body);
  });

});
