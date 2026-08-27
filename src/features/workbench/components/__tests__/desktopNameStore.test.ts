/**
 * Wave2-B r5 — desktopNameStore：持久化 + 'workbench:settings-changed' 热更新
 * （jsdom 非 Tauri 环境走 localStorage 回退，与 snapshot.test 同口径）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_NAME_SETTING_KEY,
  ensureDesktopNameSync,
  persistDesktopName,
  resetDesktopNameForTests,
  useDesktopNameStore,
} from '../desktopNameStore';

function currentName(): string | null {
  return useDesktopNameStore.getState().name;
}

function dispatchSettingsChanged(value: unknown): void {
  window.dispatchEvent(
    new CustomEvent('workbench:settings-changed', {
      detail: { key: DESKTOP_NAME_SETTING_KEY, value },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetDesktopNameForTests();
  ensureDesktopNameSync();
});

afterEach(() => {
  localStorage.clear();
  resetDesktopNameForTests();
});

describe('desktopNameStore', () => {
  it('persistDesktopName 清洗后写 localStorage 并即时更新 store', async () => {
    await persistDesktopName('  考研冲刺  ');
    expect(localStorage.getItem(DESKTOP_NAME_SETTING_KEY)).toBe('考研冲刺');
    expect(currentName()).toBe('考研冲刺');
  });

  it('空输入 = 清除命名：落盘空串、store 回 null（展示回退默认名）', async () => {
    await persistDesktopName('旧名字');
    await persistDesktopName('   ');
    expect(localStorage.getItem(DESKTOP_NAME_SETTING_KEY)).toBe('');
    expect(currentName()).toBeNull();
  });

  it('settings-changed 热更新：其他入口改名即时生效', () => {
    dispatchSettingsChanged('新桌面名');
    expect(currentName()).toBe('新桌面名');
    dispatchSettingsChanged('');
    expect(currentName()).toBeNull();
  });

  it('settings-changed 坏值（非字符串）按未命名处理', () => {
    dispatchSettingsChanged('好名字');
    expect(currentName()).toBe('好名字');
    dispatchSettingsChanged({ evil: true });
    expect(currentName()).toBeNull();
  });

  it('不相关设置键不影响桌面名', () => {
    dispatchSettingsChanged('保持');
    window.dispatchEvent(
      new CustomEvent('workbench:settings-changed', {
        detail: { key: 'desktop.workbenchWallpaper', value: 'x' },
      }),
    );
    expect(currentName()).toBe('保持');
  });
});
