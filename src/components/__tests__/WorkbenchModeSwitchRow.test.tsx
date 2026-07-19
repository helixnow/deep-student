/**
 * WorkbenchModeSwitchRow — 侧边栏「学习桌面」快捷开关测试
 *
 * 契约：resolveWorkbenchModeEnabled 读初始态（缺失键迁移为 true）；
 * 点击 → save_setting → bus.setEnabled → workbench:mode-changed 广播；
 * 关闭时联动 browser_close；失败回滚；外部 mode-changed 事件同步行状态。
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
import {
  WORKBENCH_MODE_MIGRATED_KEY,
  WORKBENCH_MODE_SETTING_KEY,
} from '@/features/settings/components/workbenchMode';

const MODE_KEY = WORKBENCH_MODE_SETTING_KEY;

function mockSettingsStore(initial: Record<string, string | null> = {}) {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(initial)) {
    if (value != null) store.set(key, value);
  }
  invokeMock.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
    if (cmd === 'get_setting') {
      return store.get(String(payload?.key)) ?? null;
    }
    if (cmd === 'save_setting') {
      store.set(String(payload?.key), String(payload?.value));
      return null;
    }
    if (cmd === 'browser_close') return null;
    return null;
  });
  return store;
}

describe('WorkbenchModeSwitchRow', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notifyMock.mockReset();
    workbenchBus.setEnabled(false);
    mockSettingsStore();
  });

  it('键缺失时迁移为 true；点击后持久化 false 并联动 browser_close', async () => {
    const store = mockSettingsStore();
    render(<WorkbenchModeSwitchRow />);
    const row = await screen.findByRole('switch');
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'true'));
    await waitFor(() => expect(store.get(MODE_KEY)).toBe('true'));
    expect(store.get(WORKBENCH_MODE_MIGRATED_KEY)).toBe('true');

    fireEvent.click(row);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: MODE_KEY, value: 'false' }),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('browser_close', {}));
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(workbenchBus.isEnabled()).toBe(false);
  });

  it('显式 false 不被迁移翻转；点击后持久化 true、bus 开启、广播 mode-changed', async () => {
    mockSettingsStore({ [MODE_KEY]: 'false' });
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

  it('持久化失败：回滚乐观态并通知', async () => {
    invokeMock.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'get_setting') {
        if (payload?.key === MODE_KEY) return 'false';
        return null;
      }
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
    mockSettingsStore({ [MODE_KEY]: 'false' });
    render(<WorkbenchModeSwitchRow />);
    const row = await screen.findByRole('switch');
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'false'));

    act(() => {
      window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled: true } }));
    });
    expect(row).toHaveAttribute('aria-checked', 'true');
  });
});
