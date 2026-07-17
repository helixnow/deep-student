import { invoke } from '@tauri-apps/api/core';

export const QUICK_ASSISTANT_CONFIG_CHANGED = 'quick-assistant-config-changed';
export const QUICK_ASSISTANT_ENABLED_KEY = 'quick_assistant.enabled';
export const QUICK_ASSISTANT_BACKGROUND_KEY = 'quick_assistant.background_enabled';
export const QUICK_ASSISTANT_CLIPBOARD_KEY = 'quick_assistant.read_clipboard';
export const QUICK_ASSISTANT_PINNED_KEY = 'quick_assistant.pinned';
export const QUICK_ASSISTANT_SHORTCUT = 'CommandOrControl+Shift+Space';

export interface QuickAssistantConfig {
  enabled: boolean;
  backgroundEnabled: boolean;
  readClipboard: boolean;
}

async function readBoolean(key: string, fallback: boolean): Promise<boolean> {
  try {
    const value = await invoke<string | null>('get_setting', { key });
    return value == null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

export async function getQuickAssistantConfig(): Promise<QuickAssistantConfig> {
  const [enabled, backgroundEnabled, readClipboard] = await Promise.all([
    readBoolean(QUICK_ASSISTANT_ENABLED_KEY, true),
    readBoolean(QUICK_ASSISTANT_BACKGROUND_KEY, false),
    readBoolean(QUICK_ASSISTANT_CLIPBOARD_KEY, true),
  ]);
  return { enabled, backgroundEnabled, readClipboard };
}

export async function saveQuickAssistantSetting(key: string, value: boolean): Promise<void> {
  await invoke('save_setting', { key, value: String(value) });
  window.dispatchEvent(new CustomEvent(QUICK_ASSISTANT_CONFIG_CHANGED, { detail: { key, value } }));
}

export async function readQuickAssistantPinned(): Promise<boolean> {
  return readBoolean(QUICK_ASSISTANT_PINNED_KEY, false);
}

export async function saveQuickAssistantPinned(value: boolean): Promise<void> {
  try {
    await invoke('save_setting', { key: QUICK_ASSISTANT_PINNED_KEY, value: String(value) });
  } catch {
    // 固定状态属于易失偏好，持久化失败不影响当前会话内的行为。
  }
}
