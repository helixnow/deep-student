/**
 * workbenchMode 默认值迁移：缺失键 → true + 哨兵；显式 false 不翻转。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _payload?: Record<string, unknown>) => null as unknown),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => notifyMock(...args),
}));

import {
  WORKBENCH_MODE_MIGRATED_KEY,
  WORKBENCH_MODE_SETTING_KEY,
  __resetWorkbenchModeCacheForTest,
  getCachedWorkbenchModeEnabled,
  interpretWorkbenchModeEnabled,
  parseWorkbenchModeRaw,
  resolveWorkbenchModeEnabled,
} from '../workbenchMode';

describe('resolveWorkbenchModeEnabled', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notifyMock.mockReset();
    __resetWorkbenchModeCacheForTest();
  });

  it('parse / interpret：缺失按默认 true，显式 false 保留', () => {
    expect(parseWorkbenchModeRaw(null)).toBeNull();
    expect(parseWorkbenchModeRaw('')).toBeNull();
    expect(parseWorkbenchModeRaw('true')).toBe(true);
    expect(parseWorkbenchModeRaw('false')).toBe(false);
    expect(interpretWorkbenchModeEnabled(null)).toBe(true);
    expect(interpretWorkbenchModeEnabled('false')).toBe(false);
  });

  it('键缺失 → 迁移后 enabled=true，并写入 mode 与哨兵', async () => {
    const store = new Map<string, string>();
    invokeMock.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'get_setting') {
        return store.get(String(payload?.key)) ?? null;
      }
      if (cmd === 'save_setting') {
        store.set(String(payload?.key), String(payload?.value));
        return null;
      }
      return null;
    });

    const result = await resolveWorkbenchModeEnabled();

    expect(result.enabled).toBe(true);
    expect(result.migratedNow).toBe(true);
    expect(store.get(WORKBENCH_MODE_SETTING_KEY)).toBe('true');
    expect(store.get(WORKBENCH_MODE_MIGRATED_KEY)).toBe('true');
    expect(getCachedWorkbenchModeEnabled()).toBe(true);
    expect(notifyMock).toHaveBeenCalledWith(
      'info',
      expect.stringMatching(/学习桌面|Study Desktop/),
    );

    // 再次解析不重复迁移 / 不重复提示
    notifyMock.mockClear();
    const second = await resolveWorkbenchModeEnabled();
    expect(second.enabled).toBe(true);
    expect(second.migratedNow).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('显式 false 不被迁移翻转', async () => {
    const store = new Map<string, string>([[WORKBENCH_MODE_SETTING_KEY, 'false']]);
    invokeMock.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'get_setting') {
        return store.get(String(payload?.key)) ?? null;
      }
      if (cmd === 'save_setting') {
        store.set(String(payload?.key), String(payload?.value));
        return null;
      }
      return null;
    });

    const result = await resolveWorkbenchModeEnabled();

    expect(result.enabled).toBe(false);
    expect(result.migratedNow).toBe(false);
    expect(store.get(WORKBENCH_MODE_SETTING_KEY)).toBe('false');
    expect(store.has(WORKBENCH_MODE_MIGRATED_KEY)).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(
      'save_setting',
      expect.objectContaining({ key: WORKBENCH_MODE_SETTING_KEY }),
    );
  });

  it('显式 true 保持开启且不写哨兵迁移', async () => {
    invokeMock.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'get_setting' && payload?.key === WORKBENCH_MODE_SETTING_KEY) {
        return 'true';
      }
      return null;
    });

    const result = await resolveWorkbenchModeEnabled();
    expect(result).toEqual({ enabled: true, migratedNow: false });
    expect(invokeMock).not.toHaveBeenCalledWith('save_setting', expect.anything());
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
