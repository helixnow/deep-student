import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  saveSetting: vi.fn(),
  isAndroid: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../settingsApi', () => ({ getSetting: mocks.getSetting, saveSetting: mocks.saveSetting }));
vi.mock('../platform', () => ({ isAndroid: mocks.isAndroid }));
vi.mock('../shared', () => ({ isTauriRuntime: true }));

import {
  ANDROID_IMMERSIVE_MODE_KEY,
  parseImmersiveModeSetting,
  setAndroidImmersiveMode,
  syncAndroidImmersiveModeFromSettings,
} from '../androidImmersiveMode';

describe('androidImmersiveMode (#472)', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.getSetting.mockReset().mockResolvedValue(null);
    mocks.saveSetting.mockReset().mockResolvedValue(undefined);
    mocks.isAndroid.mockReset().mockReturnValue(true);
  });

  it('parses the stored setting conservatively (default off)', () => {
    expect(parseImmersiveModeSetting('true')).toBe(true);
    expect(parseImmersiveModeSetting(' 1 ')).toBe(true);
    expect(parseImmersiveModeSetting('false')).toBe(false);
    expect(parseImmersiveModeSetting(null)).toBe(false);
    expect(parseImmersiveModeSetting('yes')).toBe(false);
  });

  it('applies natively before persisting the setting', async () => {
    await setAndroidImmersiveMode(true);
    expect(mocks.invoke).toHaveBeenCalledWith('set_android_immersive_mode', { enabled: true });
    expect(mocks.saveSetting).toHaveBeenCalledWith(ANDROID_IMMERSIVE_MODE_KEY, 'true');
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveSetting.mock.invocationCallOrder[0]);
  });

  it('does not persist when the native call fails', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('plugin missing'));
    await expect(setAndroidImmersiveMode(true)).rejects.toThrow('plugin missing');
    expect(mocks.saveSetting).not.toHaveBeenCalled();
  });

  it('rolls the native state back when persisting fails', async () => {
    mocks.saveSetting.mockRejectedValueOnce(new Error('db locked'));
    await expect(setAndroidImmersiveMode(true)).rejects.toThrow('db locked');
    expect(mocks.invoke).toHaveBeenLastCalledWith('set_android_immersive_mode', { enabled: false });
  });

  it('syncs the stored preference on startup', async () => {
    mocks.getSetting.mockResolvedValueOnce('true');
    await syncAndroidImmersiveModeFromSettings();
    expect(mocks.invoke).toHaveBeenCalledWith('set_android_immersive_mode', { enabled: true });
  });

  it('is a no-op off Android and never throws during startup sync', async () => {
    mocks.isAndroid.mockReturnValue(false);
    await syncAndroidImmersiveModeFromSettings();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.isAndroid.mockReturnValue(true);
    mocks.invoke.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(syncAndroidImmersiveModeFromSettings()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
