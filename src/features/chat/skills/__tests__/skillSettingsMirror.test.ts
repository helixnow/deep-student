/**
 * Skills UI 状态镜像：localStorage 仍是同步读源，settings 只在启动时对齐、每次写入后异步上送。
 * 这里锁定四个键的映射、后端优先的 hydration、首次迁移方向，以及非 Tauri / 失败的静默降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  hydrateSkillUiSettings, isTauriRuntimeAvailable, readLocalSkillUiValue, saveSkillUiSetting,
  SKILL_UI_LOCAL_KEYS, SKILL_UI_SETTING_KEYS,
} from '../skillSettingsMirror';

function enterTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  enterTauri();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('skillSettingsMirror', () => {
  it('maps the four localStorage stores to their settings keys', () => {
    expect(SKILL_UI_LOCAL_KEYS).toEqual({
      enable: 'deep-student.skill-enable-overrides',
      trust: 'deep-student.skill-trust-overrides',
      favorites: 'dstu-skill-favorites',
      bundles: 'skills.bundles.v1',
    });
    expect(SKILL_UI_SETTING_KEYS).toEqual({
      enable: 'skill.ui.enable_overrides',
      trust: 'skill.ui.trust_overrides',
      favorites: 'skill.ui.favorites',
      bundles: 'skill.ui.bundles',
    });
  });

  it('mirrors a write to save_setting and tolerates a non-promise or throwing invoke', async () => {
    invokeMock.mockResolvedValue(undefined);
    saveSkillUiSetting('enable', '{"demo":true}');
    expect(invokeMock).toHaveBeenCalledWith('save_setting', {
      key: 'skill.ui.enable_overrides', value: '{"demo":true}',
    });

    invokeMock.mockReturnValue(undefined);
    expect(() => saveSkillUiSetting('trust', '{}')).not.toThrow();

    invokeMock.mockImplementation(() => { throw new Error('ipc down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => saveSkillUiSetting('bundles', '[]')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('keeps a failed mirror asynchronous and never rejects into the caller', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => saveSkillUiSetting('favorites', '["a"]')).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it('applies backend values first and uploads local values when the backend is empty', async () => {
    const remote: Record<string, string> = {
      [SKILL_UI_SETTING_KEYS.enable]: '{"remote":true}',
      [SKILL_UI_SETTING_KEYS.favorites]: '["favorite"]',
    };
    invokeMock.mockImplementation((command: string, args: { key: string }) => {
      if (command !== 'get_setting') return Promise.resolve(undefined);
      return Promise.resolve(remote[args.key] ?? null);
    });
    localStorage.setItem(SKILL_UI_LOCAL_KEYS.enable, '{"local":true}');
    localStorage.setItem(SKILL_UI_LOCAL_KEYS.trust, '{"trusted":"a"}');
    localStorage.setItem(SKILL_UI_LOCAL_KEYS.favorites, '["local-favorite"]');
    localStorage.setItem(SKILL_UI_LOCAL_KEYS.bundles, '[]');

    await expect(hydrateSkillUiSettings()).resolves.toBe(true);
    expect(localStorage.getItem(SKILL_UI_LOCAL_KEYS.enable)).toBe('{"remote":true}');
    expect(localStorage.getItem(SKILL_UI_LOCAL_KEYS.favorites)).toBe('["favorite"]');
    const saved = invokeMock.mock.calls.filter(([command]) => command === 'save_setting').map(([, args]) => args);
    expect(saved).toEqual([
      { key: SKILL_UI_SETTING_KEYS.trust, value: '{"trusted":"a"}' },
      { key: SKILL_UI_SETTING_KEYS.bundles, value: '[]' },
    ]);
  });

  it('is inert outside Tauri and exposes the raw local value for diagnostics', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(isTauriRuntimeAvailable()).toBe(false);
    saveSkillUiSetting('enable', '{}');
    localStorage.setItem(SKILL_UI_LOCAL_KEYS.trust, '{"x":1}');
    await expect(hydrateSkillUiSettings()).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(readLocalSkillUiValue('trust')).toBe('{"x":1}');
  });
});
