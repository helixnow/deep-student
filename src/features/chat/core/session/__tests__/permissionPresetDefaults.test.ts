/**
 * 新会话默认权限档位记忆测试
 *
 * 契约（与 docs/user-guide/02-AI对话与会话管理.md 一致）：
 * - 安全档（cautious / relaxed）被记住，作为新会话默认；
 * - 高权限档（full_access / danger_full_access）绝不跨会话记忆；
 * - 无记录 / 记录非法回退 relaxed。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_PERMISSION_PRESET_STORAGE_KEY,
  getDefaultPermissionPreset,
  rememberPermissionPreset,
} from '../permissionPresetDefaults';

describe('permissionPresetDefaults', () => {
  beforeEach(() => {
    localStorage.removeItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY);
  });

  it('defaults to relaxed when nothing is remembered', () => {
    expect(getDefaultPermissionPreset()).toBe('relaxed');
  });

  it('remembers safe presets as the new-session default', () => {
    rememberPermissionPreset('cautious');
    expect(getDefaultPermissionPreset()).toBe('cautious');

    rememberPermissionPreset('relaxed');
    expect(getDefaultPermissionPreset()).toBe('relaxed');
  });

  it('never remembers privileged presets and keeps the previous safe default', () => {
    rememberPermissionPreset('cautious');

    rememberPermissionPreset('full_access');
    expect(getDefaultPermissionPreset()).toBe('cautious');

    rememberPermissionPreset('danger_full_access');
    expect(getDefaultPermissionPreset()).toBe('cautious');
    expect(localStorage.getItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY)).toBe('cautious');
  });

  it('falls back to relaxed on a corrupted stored value', () => {
    localStorage.setItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY, 'full_access');
    expect(getDefaultPermissionPreset()).toBe('relaxed');

    localStorage.setItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY, 'garbage');
    expect(getDefaultPermissionPreset()).toBe('relaxed');
  });
});
