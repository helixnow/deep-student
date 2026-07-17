/**
 * WorkbenchModeSwitchRow — 侧边栏「学习桌面」快捷开关测试
 *
 * 契约：get_setting 读初始态；点击 → save_setting → bus.setEnabled →
 * workbench:mode-changed 广播；关闭时联动 browser_close；失败回滚；
 * 外部 mode-changed 事件同步行状态。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const { invokeMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _payload?: Record<string, unknown>) => null as unknown),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => notifyMock(...args),
}));

import { WorkbenchModeSwitchRow } from '../WorkbenchModeSwitchRow';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

const MODE_KEY = 'desktop.workbenchMode';

function mockReadMode(value: string | null) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_setting') return value;
    return null;
  });
}

describe('WorkbenchModeSwitchRow', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notifyMock.mockReset();
    workbenchBus.setEnabled(false);
    mockReadMode(null);
  });

  it('初始读 false；点击后持久化 true、bus 开启、广播 mode-changed', async () => {
    render(<WorkbenchModeSwitchRow />);
    const row = await screen.findByRole('switch');
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'false'));

    const events: boolean[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail.enabled);
    window.addEventListener('workbench:mode-changed', listener);

    fireEvent.click(row);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: MODE_KEY, value: 'true' }),
    );
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(workbenchBus.isEnabled()).toBe(true);
    expect(events).toEqual([true]);

    window.removeEventListener('workbench:mode-changed', listener);
  });

  it('初始读 true；点击后持久化 false 并联动 browser_close', async () => {
    mockReadMode('true');
    render(<WorkbenchModeSwitchRow />);
    const row = await screen.findByRole('switch');
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(row);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: MODE_KEY, value: 'false' }),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('browser_close', {}));
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(workbenchBus.isEnabled()).toBe(false);
  });

  it('持久化失败：回滚乐观态并通知', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_setting') return null;
      if (cmd === 'save_setting') throw new Error('disk full');
      return null;
    });
    render(<WorkbenchModeSwitchRow />);
    const row = await screen.findByRole('switch');
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(row);
    await waitFor(() => expect(notifyMock).toHaveBeenCalled());
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(workbenchBus.isEnabled()).toBe(false);
  });

  it('外部 workbench:mode-changed 事件同步行状态', async () => {
    render(<WorkbenchModeSwitchRow />);
    const row = await screen.findByRole('switch');
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'false'));

    act(() => {
      window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled: true } }));
    });
    expect(row).toHaveAttribute('aria-checked', 'true');
  });
});
