/**
 * `workbenchMode` (settings api.ts) is the plugin-facing write path of the 学习桌面 switch: before the settings feature
 * loads, calls wait for it; once loaded, they run `persistWorkbenchModeEnabled` itself (persist, broadcast, failures).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENTS, addAppEventListener } from '@/events';

const { invokeMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _payload?: Record<string, unknown>) => null as unknown),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/utils/settingsApi', () => ({
  getSetting: (key: string) => invokeMock('get_setting', { key }),
  saveSetting: (key: string, value: string) => invokeMock('save_setting', { key, value }),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => notifyMock(...args),
}));

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  notifyMock.mockReset();
});

describe('settings api: workbenchMode', () => {
  it('holds calls made before the settings feature provides the service and hands them over in order', async () => {
    const { workbenchMode, provideWorkbenchModeService } = await import('./api');
    const seen: boolean[] = [];
    const first = workbenchMode.setEnabled(false);
    const second = workbenchMode.setEnabled(true);
    await Promise.resolve();
    expect(seen).toEqual([]);

    provideWorkbenchModeService({ setEnabled: async (enabled) => { seen.push(enabled); return enabled; } });
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(seen).toEqual([false, true]);

    await expect(workbenchMode.setEnabled(true)).resolves.toBe(true);
    expect(seen).toEqual([false, true, true]);
  });

  describe('through the settings feature', () => {
    let events: boolean[];
    let dispose: () => void;
    beforeEach(() => {
      events = [];
      dispose = addAppEventListener(APP_EVENTS.WORKBENCH_MODE_CHANGED, (detail) => { events.push(detail.enabled); });
    });
    afterEach(() => dispose());

    it('persists the switch and broadcasts workbench:mode-changed, like persistWorkbenchModeEnabled', async () => {
      const { workbenchMode } = await import('./api');
      const pending = workbenchMode.setEnabled(true);
      const { WORKBENCH_MODE_SETTING_KEY, getCachedWorkbenchModeEnabled } = await import('@/features/settings/components/workbenchMode');

      await expect(pending).resolves.toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: WORKBENCH_MODE_SETTING_KEY, value: 'true' });
      expect(getCachedWorkbenchModeEnabled()).toBe(true);
      expect(events).toEqual([true]);
    });

    it('resolves false, tells the user and broadcasts nothing when saving fails', async () => {
      const { WORKBENCH_MODE_SETTING_KEY } = await import('@/features/settings/components/workbenchMode');
      const { workbenchMode } = await import('./api');
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'save_setting') throw new Error('disk full');
        return null;
      });

      await expect(workbenchMode.setEnabled(true)).resolves.toBe(false);
      expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: WORKBENCH_MODE_SETTING_KEY, value: 'true' });
      expect(notifyMock).toHaveBeenCalledWith('error', expect.stringContaining('disk full'));
      expect(events).toEqual([]);
    });
  });
});
