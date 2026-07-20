/**
 * 学习桌面快捷方式图标层（DesktopShortcuts）测试
 *
 * 覆盖：
 * - 图标层渲染 desktopStore（与资源库桌面共库）中的快捷方式；
 * - 双击资源图标 → workbenchBus.launch 打开内容窗口；
 * - 双击文件夹图标 → activate('openFolder') 定位资源库窗口；
 * - 拖放资源/文件夹到桌面 → 创建快捷方式（认领 drop，不再兜底开窗）；
 * - 图标右键菜单「从桌面移除」。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { DesktopShortcutsLayer } from '@/features/workbench/components/DesktopShortcuts';
import {
  clearDesktopResourceDropHandler,
  handleDesktopResourceDrop,
} from '@/features/workbench/apps/files/desktopDragBridge';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useDesktopStore } from '@/features/learning-hub/stores/desktopStore';

// 注意：不能用 vi.restoreAllMocks()——会把 vitest.setup 里 vi.fn 实现的
// window.matchMedia 一并重置掉；逐个 mockRestore 本文件创建的 spy。
const spies: Array<{ mockRestore: () => void }> = [];

function spyLaunch() {
  const spy = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win_x');
  spies.push(spy);
  return spy;
}

function spyActivate() {
  const spy = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
  spies.push(spy);
  return spy;
}

function seedShortcuts(): void {
  useDesktopStore.setState({
    shortcuts: [
      {
        id: 's_exam',
        name: '期末卷',
        type: 'resource',
        target: { resourceId: 'exam_1', resourceType: 'exam' },
        position: 0,
        createdAt: new Date().toISOString(),
      },
      {
        id: 's_folder',
        name: '资料夹',
        type: 'folder',
        target: { folderId: 'folder_1' },
        position: 1,
        createdAt: new Date().toISOString(),
      },
    ],
  });
}

describe('学习桌面快捷方式图标层', () => {
  beforeEach(() => {
    localStorage.clear();
    seedShortcuts();
  });

  afterEach(() => {
    cleanup();
    clearDesktopResourceDropHandler();
    useDesktopStore.setState({ shortcuts: [] });
    while (spies.length > 0) spies.pop()?.mockRestore();
  });

  it('渲染 desktopStore 中的快捷方式图标', () => {
    render(<DesktopShortcutsLayer />);
    expect(screen.getByRole('button', { name: '期末卷' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '资料夹' })).toBeTruthy();
  });

  it('双击资源图标 → launch 内容窗口；双击文件夹图标 → activate openFolder', () => {
    const launchSpy = spyLaunch();
    const activateSpy = spyActivate();
    render(<DesktopShortcutsLayer />);

    fireEvent.doubleClick(screen.getByRole('button', { name: '期末卷' }));
    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ typeId: 'exam', instanceKey: 'exam_1' }),
    );

    fireEvent.doubleClick(screen.getByRole('button', { name: '资料夹' }));
    expect(activateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        typeId: 'files',
        action: 'openFolder',
        payload: { folderId: 'folder_1' },
      }),
    );
  });

  it('拖放资源/文件夹到桌面 → 创建快捷方式而非开窗', async () => {
    const launchSpy = spyLaunch();
    render(<DesktopShortcutsLayer />);

    const claimedNote = await handleDesktopResourceDrop({
      resource: { resourceId: 'note_9', resourceType: 'note', title: '随手记' },
    });
    expect(claimedNote).toBe(true);

    const claimedFolder = await handleDesktopResourceDrop({
      resource: { resourceId: 'folder_9', resourceType: 'folder', title: '新文件夹' },
    });
    expect(claimedFolder).toBe(true);

    const state = useDesktopStore.getState();
    expect(state.hasResourceShortcut('note_9')).toBe(true);
    expect(state.hasFolderShortcut('folder_9')).toBe(true);
    // drop 被图标层认领：不走「落点开窗」兜底
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('图标右键菜单：从桌面移除', async () => {
    render(<DesktopShortcutsLayer />);

    fireEvent.contextMenu(screen.getByRole('button', { name: '期末卷' }), {
      clientX: 100,
      clientY: 100,
    });
    const removeItem = await screen.findByText('从桌面移除');
    fireEvent.click(removeItem);

    await waitFor(() => {
      expect(useDesktopStore.getState().hasResourceShortcut('exam_1')).toBe(false);
    });
  });
});
