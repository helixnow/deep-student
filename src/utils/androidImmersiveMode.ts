import { invoke } from '@tauri-apps/api/core';

import { isAndroid } from './platform';
import { getSetting, saveSetting } from './settingsApi';
import { isTauriRuntime } from './shared';

/**
 * #472: Android 沉浸式全屏（隐藏状态栏 + 导航栏，边缘滑动临时呼出）。
 *
 * 设置库是权威来源；原生侧（MainActivity）另存一份，仅用于冷启动时先于前端生效。
 * 启动时 {@link syncAndroidImmersiveModeFromSettings} 把设置库的值下发一次，
 * 覆盖数据恢复 / 导入备份等原生缓存与设置库不一致的情况。
 */
export const ANDROID_IMMERSIVE_MODE_KEY = 'android.immersive_mode';

export function parseImmersiveModeSetting(raw: string | null | undefined): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

export function isAndroidImmersiveModeSupported(): boolean {
  return isTauriRuntime && isAndroid();
}

async function applyAndroidImmersiveMode(enabled: boolean): Promise<void> {
  if (!isAndroidImmersiveModeSupported()) return;
  await invoke<void>('set_android_immersive_mode', { enabled });
}

export async function loadAndroidImmersiveMode(): Promise<boolean> {
  return parseImmersiveModeSetting(await getSetting(ANDROID_IMMERSIVE_MODE_KEY));
}

/** 设置页开关：先切原生（失败即抛错、不落库），再持久化。 */
export async function setAndroidImmersiveMode(enabled: boolean): Promise<void> {
  await applyAndroidImmersiveMode(enabled);
  try {
    await saveSetting(ANDROID_IMMERSIVE_MODE_KEY, enabled ? 'true' : 'false');
  } catch (error: unknown) {
    // 落库失败时回滚原生状态，避免界面开关与实际显隐不一致
    await applyAndroidImmersiveMode(!enabled).catch(() => undefined);
    throw error;
  }
}

/** 启动时同步一次；非 Android 直接跳过，失败只记日志（不影响启动）。 */
export async function syncAndroidImmersiveModeFromSettings(): Promise<void> {
  if (!isAndroidImmersiveModeSupported()) return;
  try {
    await applyAndroidImmersiveMode(await loadAndroidImmersiveMode());
  } catch (error: unknown) {
    console.warn('[Platform] sync immersive mode failed:', error);
  }
}
