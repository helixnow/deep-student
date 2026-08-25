/**
 * builtinStorage 用户可见错误 i18n key-echo 测试
 *
 * mock @/i18n 为 key-echo（t 直接返回 key），并保证运行时探测为非 Tauri
 * （jsdom 下清空 window.__TAURI_INTERNALS__），断言两条 throw 走 skills:storage 键。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}));

import {
  resetBuiltinSkillCustomization,
  saveBuiltinSkillCustomization,
} from '../builtinStorage';

describe('builtinStorage user-facing errors go through skills:storage i18n keys', () => {
  beforeEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('saveBuiltinSkillCustomization throws skills:storage.save_requires_tauri outside Tauri', async () => {
    await expect(
      saveBuiltinSkillCustomization('deep-student', { name: 'custom' })
    ).rejects.toMatchObject({ message: 'skills:storage.save_requires_tauri' });
  });

  it('resetBuiltinSkillCustomization throws skills:storage.reset_requires_tauri outside Tauri', async () => {
    await expect(
      resetBuiltinSkillCustomization('deep-student')
    ).rejects.toMatchObject({ message: 'skills:storage.reset_requires_tauri' });
  });
});
