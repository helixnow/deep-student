import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchSettingsSection } from '@/features/settings/components/WorkbenchSettingsSection';
// 深路径导入与被测组件保持一致（workbench index 聚合了 chat 等重量级 re-export）
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

const { invokeMock, settingsStore } = vi.hoisted(() => {
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
  return { invokeMock, settingsStore };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

describe('WorkbenchSettingsSection', () => {
  beforeEach(() => {
    settingsStore.clear();
    invokeMock.mockClear();
    workbenchBus.setEnabled(false);
    document.documentElement.removeAttribute('data-wb-material');
  });

  afterEach(() => {
    cleanup();
    workbenchBus.setEnabled(false);
  });

  it('persists the workbenchMode master switch, enables the bus and dispatches workbench:mode-changed', async () => {
    const modeEvents: Array<{ enabled: boolean }> = [];
    const onModeChanged = (event: Event) => {
      modeEvents.push((event as CustomEvent<{ enabled: boolean }>).detail);
    };
    window.addEventListener('workbench:mode-changed', onModeChanged);

    try {
      render(<WorkbenchSettingsSection />);

      const modeSwitch = await screen.findByRole('switch', { name: '启用学习桌面' });
      expect(modeSwitch).toHaveAttribute('aria-checked', 'false');
      expect(workbenchBus.isEnabled()).toBe(false);

      fireEvent.click(modeSwitch);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('save_setting', {
          key: 'desktop.workbenchMode',
          value: 'true',
        });
      });
      expect(settingsStore.get('desktop.workbenchMode')).toBe('true');
      await waitFor(() => expect(workbenchBus.isEnabled()).toBe(true));
      expect(modeEvents).toEqual([{ enabled: true }]);
    } finally {
      window.removeEventListener('workbench:mode-changed', onModeChanged);
    }
  });

  it('restores persisted values on a fresh mount (settings round-trip)', async () => {
    settingsStore.set('desktop.workbenchMode', 'true');
    settingsStore.set('desktop.workbenchDockAutohide', 'true');
    settingsStore.set('desktop.workbenchTileMargins', JSON.stringify({ enabled: false, px: 12 }));
    settingsStore.set('desktop.workbenchMaterialTier', 'reduced');

    render(<WorkbenchSettingsSection />);

    const modeSwitch = await screen.findByRole('switch', { name: '启用学习桌面' });
    expect(modeSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: '自动隐藏 Dock' })).toHaveAttribute('aria-checked', 'true');
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
      await screen.findByRole('switch', { name: '启用学习桌面' });

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

  it('applies performance profile levers (balanced → reduced / dock mag on)', async () => {
    render(<WorkbenchSettingsSection />);
    await screen.findByRole('switch', { name: '启用学习桌面' });

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
    expect(settingsStore.get('desktop.workbenchDockMagnification')).toBe('true');
    expect(document.documentElement.getAttribute('data-wb-material')).toBe('reduced');
    expect(screen.getByRole('switch', { name: 'Dock 邻近放大' })).toHaveAttribute('aria-checked', 'true');
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

  it('disables browser child controls when workbenchMode is off and shows the parent-gate hint', async () => {
    render(<WorkbenchSettingsSection />);

    await screen.findByRole('switch', { name: '启用学习桌面' });
    const browserSwitch = screen.getByRole('switch', { name: '内置浏览器' });
    const agentSwitch = screen.getByRole('switch', { name: '允许助手操控浏览器' });

    expect(browserSwitch).toBeDisabled();
    expect(agentSwitch).toBeDisabled();
    expect(
      screen.getAllByText('请先启用学习桌面，才能打开内置浏览器相关选项。').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: '本地与白名单' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '完整上网（需确认）' })).toBeDisabled();
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
    const modeSwitch = screen.getByRole('switch', { name: '启用学习桌面' });
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
    expect(screen.getByRole('radio', { name: '本地与白名单' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: '高级（浏览器）' }));
    expect(screen.getByRole('switch', { name: 'Windows CDP 加速（高级）' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: '完整上网（需确认）' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(settingsStore.get('desktop.workbenchBrowserNetworkMode')).toBe('local_whitelist');

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => {
      expect(settingsStore.get('desktop.workbenchBrowserNetworkMode')).toBe('full');
    });
  });
});
