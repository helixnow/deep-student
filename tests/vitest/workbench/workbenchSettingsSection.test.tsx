import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchSettingsSection } from '@/features/settings/components/WorkbenchSettingsSection';
// 深路径导入与被测组件保持一致（workbench index 聚合了 chat 等重量级 re-export）
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

const { importWallpaperToLibraryMock, invokeMock, settingsStore, showGlobalNotificationMock } = vi.hoisted(() => {
  const settingsStore = new Map<string, string>();
  const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_setting') {
      return settingsStore.get(String(args?.key)) ?? null;
    }
    if (command === 'save_setting') {
      settingsStore.set(String(args?.key), String(args?.value));
      return null;
    }
    return null;
  });
  return {
    importWallpaperToLibraryMock: vi.fn(),
    invokeMock,
    settingsStore,
    showGlobalNotificationMock: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/features/settings/components/wallpaperLibrary', () => ({
  importWallpaperToLibrary: importWallpaperToLibraryMock,
}));

// 面板由代理 B 实现，本测试只依赖事件常量契约
vi.mock('@/features/workbench/components/WallpaperManagerDialog', () => ({
  OPEN_WALLPAPER_MANAGER_EVENT: 'workbench:open-wallpaper-manager',
  WallpaperManagerDialog: () => null,
}));

describe('WorkbenchSettingsSection', () => {
  beforeEach(() => {
    settingsStore.clear();
    invokeMock.mockClear();
    importWallpaperToLibraryMock.mockReset();
    importWallpaperToLibraryMock.mockResolvedValue({ status: 'cancelled' });
    showGlobalNotificationMock.mockReset();
    workbenchBus.setEnabled(false);
    document.documentElement.removeAttribute('data-wb-material');
  });

  afterEach(() => {
    cleanup();
    workbenchBus.setEnabled(false);
  });

  it('persists the workbenchMode master switch off, disables the bus and dispatches workbench:mode-changed', async () => {
    settingsStore.set('desktop.workbenchMode', 'true');
    const modeEvents: Array<{ enabled: boolean }> = [];
    const onModeChanged = (event: Event) => {
      modeEvents.push((event as CustomEvent<{ enabled: boolean }>).detail);
    };
    window.addEventListener('workbench:mode-changed', onModeChanged);

    try {
      render(<WorkbenchSettingsSection />);

      const modeSwitch = await screen.findByRole('switch', { name: '学习桌面（默认）' });
      await waitFor(() => expect(modeSwitch).toHaveAttribute('aria-checked', 'true'));
      expect(workbenchBus.isEnabled()).toBe(false);

      fireEvent.click(modeSwitch);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('save_setting', {
          key: 'desktop.workbenchMode',
          value: 'false',
        });
      });
      expect(settingsStore.get('desktop.workbenchMode')).toBe('false');
      await waitFor(() => expect(workbenchBus.isEnabled()).toBe(false));
      expect(modeEvents).toEqual([{ enabled: false }]);
    } finally {
      window.removeEventListener('workbench:mode-changed', onModeChanged);
    }
  });

  it('restores persisted values on a fresh mount (settings round-trip)', async () => {
    settingsStore.set('desktop.workbenchMode', 'true');
    settingsStore.set('desktop.workbenchDockAutohide', 'true');
    settingsStore.set('desktop.workbenchDockSize', '120');
    settingsStore.set('desktop.workbenchTileMargins', JSON.stringify({ enabled: false, px: 12 }));
    settingsStore.set('desktop.workbenchMaterialTier', 'reduced');

    render(<WorkbenchSettingsSection />);

    const modeSwitch = await screen.findByRole('switch', { name: '学习桌面（默认）' });
    expect(modeSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: '自动隐藏 Dock' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('slider', { name: 'Dock 大小' })).toHaveValue('120');
    expect(screen.getByRole('switch', { name: '平铺间距' })).toHaveAttribute('aria-checked', 'false');
    // tileMargins 关闭时数值行隐藏
    expect(screen.queryByText('间距（px）')).not.toBeInTheDocument();
    // materialTier 恢复为 reduced
    expect(screen.getByRole('radio', { name: '降透明' })).toHaveAttribute('aria-checked', 'true');
  });

  it('persists material tier, applies data-wb-material and dispatches workbench:settings-changed', async () => {
    const changedEvents: Array<{ key: string; value: unknown }> = [];
    const onChanged = (event: Event) => {
      changedEvents.push((event as CustomEvent<{ key: string; value: unknown }>).detail);
    };
    window.addEventListener('workbench:settings-changed', onChanged);

    try {
      render(<WorkbenchSettingsSection />);
      await screen.findByRole('switch', { name: '学习桌面（默认）' });

      // 先选画质预设，再单独改材质 → 应切回自定义
      fireEvent.click(screen.getByRole('radio', { name: '画质' }));
      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchPerformanceProfile')).toBe('quality');
      });

      fireEvent.click(screen.getByRole('radio', { name: '降透明' }));

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('save_setting', {
          key: 'desktop.workbenchMaterialTier',
          value: 'reduced',
        });
      });
      expect(document.documentElement.getAttribute('data-wb-material')).toBe('reduced');
      await waitFor(() => {
        expect(changedEvents).toContainEqual({
          key: 'desktop.workbenchMaterialTier',
          value: 'reduced',
        });
      });
      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchPerformanceProfile')).toBe('custom');
      });
    } finally {
      window.removeEventListener('workbench:settings-changed', onChanged);
    }
  });

  it('applies performance profile levers (balanced → reduced)', async () => {
    render(<WorkbenchSettingsSection />);
    await screen.findByRole('switch', { name: '学习桌面（默认）' });

    fireEvent.click(screen.getByRole('radio', { name: '均衡' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_setting', {
        key: 'desktop.workbenchPerformanceProfile',
        value: 'balanced',
      });
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_setting', {
        key: 'desktop.workbenchMaterialTier',
        value: 'reduced',
      });
    });
    expect(document.documentElement.getAttribute('data-wb-material')).toBe('reduced');
    // Dock 邻近放大已移除：不再有对应设置项
    expect(screen.queryByRole('switch', { name: 'Dock 邻近放大' })).not.toBeInTheDocument();
  });

  it('persists tile margins as JSON and keeps px when toggling', async () => {
    settingsStore.set('desktop.workbenchTileMargins', JSON.stringify({ enabled: true, px: 16 }));

    render(<WorkbenchSettingsSection />);
    const marginsSwitch = await screen.findByRole('switch', { name: '平铺间距' });
    expect(marginsSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('间距（px）')).toBeInTheDocument();

    fireEvent.click(marginsSwitch);

    await waitFor(() => {
      expect(settingsStore.get('desktop.workbenchTileMargins')).toBe(
        JSON.stringify({ enabled: false, px: 16 }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('间距（px）')).not.toBeInTheDocument();
    });
  });

  it('persists Dock size changes and dispatches the live settings event', async () => {
    const changedEvents: Array<{ key: string; value: unknown }> = [];
    const onChanged = (event: Event) => {
      changedEvents.push((event as CustomEvent<{ key: string; value: unknown }>).detail);
    };
    window.addEventListener('workbench:settings-changed', onChanged);

    try {
      render(<WorkbenchSettingsSection />);
      const slider = await screen.findByRole('slider', { name: 'Dock 大小' });

      fireEvent.change(slider, { target: { value: '115' } });

      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchDockSize')).toBe('115');
      });
      expect(changedEvents).toContainEqual({
        key: 'desktop.workbenchDockSize',
        value: 115,
      });
      expect(screen.getByText('115%')).toBeInTheDocument();
    } finally {
      window.removeEventListener('workbench:settings-changed', onChanged);
    }
  });

  it('falls back to defaults on corrupted JSON settings', async () => {
    settingsStore.set('desktop.workbenchTileMargins', '{not-json');
    settingsStore.set('desktop.workbenchWallpaper', '[1,2,3');
    settingsStore.set('desktop.workbenchMaterialTier', 'bogus');

    render(<WorkbenchSettingsSection />);

    const marginsSwitch = await screen.findByRole('switch', { name: '平铺间距' });
    // 默认 { enabled: true, px: 8 }
    expect(marginsSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('间距（px）')).toBeInTheDocument();
    // materialTier 非法值回退 auto
    expect(screen.getByRole('radio', { name: '跟随平台' })).toHaveAttribute('aria-checked', 'true');
  });

  it('opens the custom wallpaper picker without exposing an editable path', async () => {
    render(<WorkbenchSettingsSection />);
    await screen.findByRole('switch', { name: '学习桌面（默认）' });

    expect(screen.queryByRole('textbox', { name: '图片路径' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '自定义图片' }));

    await waitFor(() => expect(importWallpaperToLibraryMock).toHaveBeenCalledTimes(1));
    expect(importWallpaperToLibraryMock).toHaveBeenCalledWith(
      expect.objectContaining({ pickerTitle: '选择壁纸图片' }),
    );
    expect(screen.getByRole('radio', { name: '内置壁纸' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('persists the imported library wallpaper and dispatches the settings event', async () => {
    const managedPath = 'C:/AppData/DeepStudent/workbench-wallpapers/wallpaper-new.png';
    importWallpaperToLibraryMock.mockResolvedValue({
      status: 'success',
      entry: { path: managedPath, fileName: 'wallpaper-new.png' },
    });
    const changedEvents: Array<{ key: string; value: unknown }> = [];
    const onChanged = (event: Event) => {
      changedEvents.push((event as CustomEvent<{ key: string; value: unknown }>).detail);
    };
    window.addEventListener('workbench:settings-changed', onChanged);

    try {
      render(<WorkbenchSettingsSection />);
      await screen.findByRole('switch', { name: '学习桌面（默认）' });
      fireEvent.click(screen.getByRole('radio', { name: '自定义图片' }));

      const expected = { kind: 'image', value: managedPath };
      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchWallpaper')).toBe(JSON.stringify(expected));
      });
      expect(screen.getByRole('radio', { name: '自定义图片' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('button', { name: '更换图片' })).toBeInTheDocument();
      expect(changedEvents).toContainEqual({
        key: 'desktop.workbenchWallpaper',
        value: expected,
      });
    } finally {
      window.removeEventListener('workbench:settings-changed', onChanged);
    }
  });

  it('blocks concurrent custom wallpaper imports', async () => {
    let resolveImport!: (value: { status: 'cancelled' }) => void;
    importWallpaperToLibraryMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    render(<WorkbenchSettingsSection />);
    await screen.findByRole('switch', { name: '学习桌面（默认）' });

    const customOption = screen.getByRole('radio', { name: '自定义图片' });
    fireEvent.click(customOption);
    fireEvent.click(customOption);

    await waitFor(() => expect(importWallpaperToLibraryMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('正在导入…')).toBeInTheDocument();
    resolveImport({ status: 'cancelled' });
    await waitFor(() => expect(screen.queryByText('正在导入…')).not.toBeInTheDocument());
  });

  it('preserves the current wallpaper and notifies when replacement fails', async () => {
    const current = {
      kind: 'image',
      value: 'C:/AppData/DeepStudent/workbench-wallpapers/wallpaper-current.jpg',
    };
    settingsStore.set('desktop.workbenchWallpaper', JSON.stringify(current));
    const error = new Error('copy failed');
    importWallpaperToLibraryMock.mockResolvedValue({ status: 'error', error });
    render(<WorkbenchSettingsSection />);

    const changeButton = await screen.findByRole('button', { name: '更换图片' });
    fireEvent.click(changeButton);

    await waitFor(() => {
      expect(showGlobalNotificationMock).toHaveBeenCalledWith('error', 'copy failed');
    });
    expect(settingsStore.get('desktop.workbenchWallpaper')).toBe(JSON.stringify(current));
    expect(screen.getByRole('radio', { name: '自定义图片' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('notifies without persisting when the wallpaper library is full', async () => {
    importWallpaperToLibraryMock.mockResolvedValue({ status: 'limit-exceeded', limit: 24 });
    render(<WorkbenchSettingsSection />);
    await screen.findByRole('switch', { name: '学习桌面（默认）' });

    fireEvent.click(screen.getByRole('radio', { name: '自定义图片' }));

    await waitFor(() => {
      expect(showGlobalNotificationMock).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('24'),
      );
    });
    expect(settingsStore.get('desktop.workbenchWallpaper')).toBeUndefined();
  });

  it('dispatches the wallpaper manager open event from the manage button', async () => {
    const openHandler = vi.fn();
    window.addEventListener('workbench:open-wallpaper-manager', openHandler);

    try {
      render(<WorkbenchSettingsSection />);
      await screen.findByRole('switch', { name: '学习桌面（默认）' });

      fireEvent.click(screen.getByRole('button', { name: '管理壁纸' }));

      expect(openHandler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('workbench:open-wallpaper-manager', openHandler);
    }
  });

  it('explains the assistant capability surface and its explicit learning safeguards', async () => {
    render(<WorkbenchSettingsSection />);
    await screen.findByRole('switch', { name: '学习桌面（默认）' });

    expect(screen.getByText('助手可以做什么')).toBeInTheDocument();
    expect(document.querySelectorAll('.wb-agent-capability-row')).toHaveLength(8);
    expect(
      screen.getByText(/不会替你答题、提交考试或给闪卡评分/),
    ).toBeInTheDocument();
  });

  it('disables browser child controls when workbenchMode is off and shows the parent-gate hint', async () => {
    settingsStore.set('desktop.workbenchMode', 'false');
    render(<WorkbenchSettingsSection />);

    const modeSwitch = await screen.findByRole('switch', { name: '学习桌面（默认）' });
    await waitFor(() => expect(modeSwitch).toHaveAttribute('aria-checked', 'false'));
    const browserSwitch = screen.getByRole('switch', { name: '内置浏览器' });
    const agentSwitch = screen.getByRole('switch', { name: '允许助手操控浏览器' });

    expect(browserSwitch).toBeDisabled();
    expect(agentSwitch).toBeDisabled();
    expect(
      screen.getAllByText('请先启用学习桌面，才能打开内置浏览器相关选项。').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: '仅 HTTPS 公网' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '允许公网 HTTP（需确认）' })).toBeDisabled();
    expect(screen.queryByRole('switch', { name: 'Windows CDP 加速（高级）' })).not.toBeInTheDocument();
  });

  it('persists browser settings and settings-changed when workbenchMode is on', async () => {
    settingsStore.set('desktop.workbenchMode', 'true');
    const changedEvents: Array<{ key: string; value: unknown }> = [];
    const onChanged = (event: Event) => {
      changedEvents.push((event as CustomEvent<{ key: string; value: unknown }>).detail);
    };
    window.addEventListener('workbench:settings-changed', onChanged);

    try {
      render(<WorkbenchSettingsSection />);

      const browserSwitch = await screen.findByRole('switch', { name: '内置浏览器' });
      expect(browserSwitch).not.toBeDisabled();
      expect(browserSwitch).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(browserSwitch);
      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchBrowserEnabled')).toBe('true');
      });
      await waitFor(() => {
        expect(changedEvents).toContainEqual({
          key: 'desktop.workbenchBrowserEnabled',
          value: true,
        });
      });

      fireEvent.click(screen.getByRole('switch', { name: '允许助手操控浏览器' }));
      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchBrowserAgentControl')).toBe('true');
      });

      fireEvent.click(screen.getByRole('button', { name: '高级（浏览器）' }));
      const cdpSwitch = await screen.findByRole('switch', { name: 'Windows CDP 加速（高级）' });
      expect(cdpSwitch).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(cdpSwitch);
      await waitFor(() => {
        expect(settingsStore.get('desktop.workbenchBrowserCdpWindows')).toBe('true');
      });
    } finally {
      window.removeEventListener('workbench:settings-changed', onChanged);
    }
  });

  it('closes native browser content when either settings gate is disabled', async () => {
    settingsStore.set('desktop.workbenchMode', 'true');
    settingsStore.set('desktop.workbenchBrowserEnabled', 'true');
    render(<WorkbenchSettingsSection />);

    const browserSwitch = await screen.findByRole('switch', { name: '内置浏览器' });
    fireEvent.click(browserSwitch);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_close', {});
    });

    invokeMock.mockClear();
    const modeSwitch = screen.getByRole('switch', { name: '学习桌面（默认）' });
    fireEvent.click(modeSwitch);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_close', {});
    });
  });

  it('restores browser settings and uses a modal confirmation before switching network mode to full', async () => {
    settingsStore.set('desktop.workbenchMode', 'true');
    settingsStore.set('desktop.workbenchBrowserEnabled', 'true');
    settingsStore.set('desktop.workbenchBrowserNetworkMode', 'local_whitelist');
    settingsStore.set('desktop.workbenchBrowserAgentControl', 'true');
    settingsStore.set('desktop.workbenchBrowserCdpWindows', 'true');

    render(<WorkbenchSettingsSection />);

    expect(await screen.findByRole('switch', { name: '内置浏览器' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: '允许助手操控浏览器' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: '仅 HTTPS 公网' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: '高级（浏览器）' }));
    expect(screen.getByRole('switch', { name: 'Windows CDP 加速（高级）' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: '允许公网 HTTP（需确认）' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(settingsStore.get('desktop.workbenchBrowserNetworkMode')).toBe('local_whitelist');

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => {
      expect(settingsStore.get('desktop.workbenchBrowserNetworkMode')).toBe('full');
    });
  });
});
