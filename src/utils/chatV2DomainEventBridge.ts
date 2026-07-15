import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import i18n from '@/i18n';

const SETTINGS_CHANGED_EVENT = 'chat_v2://settings_changed';
const MODEL_ASSIGNMENTS_CHANGED_EVENT = 'chat_v2://model_assignments_changed';

type SettingsChangedPayload = {
  action?: string;
  key?: string;
};

type ModelAssignmentsChangedPayload = {
  action?: string;
  slot?: string;
};

type BridgeWindow = Window & {
  __deepStudentChatV2DomainEventBridgeInstalled?: boolean;
};

const dispatch = (name: string, detail: unknown) => {
  window.dispatchEvent(new CustomEvent(name, { detail }));
};

async function refreshChangedSetting(payload: SettingsChangedPayload): Promise<void> {
  const key = payload.key?.trim();
  dispatch('settings_changed', payload);
  if (!key) return;

  try {
    const value = await invoke<string | null>('get_setting', { key });
    const detail: Record<string, unknown> = { settingKey: key, value };

    if (key === 'markdownRendererMode') {
      detail.markdownRendererMode = value === 'enhanced' ? 'enhanced' : 'legacy';
    }
    if (key === 'ui.pointer_cursor') {
      detail.pointerCursor = true;
    }
    dispatch('systemSettingsChanged', detail);

    if (key === 'theme' && ['light', 'dark', 'auto'].includes(String(value))) {
      localStorage.setItem('dstu-theme-mode', String(value));
      dispatch('dstu-theme-mode-changed', { mode: value });
    } else if (key === 'theme_palette') {
      localStorage.setItem('dstu-theme-palette', String(value));
      dispatch('dstu-theme-palette-changed', { palette: value });
    } else if (key === 'language' && (value === 'zh-CN' || value === 'en-US')) {
      await i18n.changeLanguage(value);
    }
  } catch (error) {
    console.warn('[chat-v2-domain-events] failed to refresh changed setting', { key, error });
  }
}

/**
 * Bridge backend Agent mutations into the DOM events already consumed by the
 * settings/model UI. Installation is app-lifetime and idempotent.
 */
export async function installChatV2DomainEventBridge(): Promise<UnlistenFn[]> {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return [];
  const bridgeWindow = window as BridgeWindow;
  if (bridgeWindow.__deepStudentChatV2DomainEventBridgeInstalled) return [];
  bridgeWindow.__deepStudentChatV2DomainEventBridgeInstalled = true;

  try {
    return await Promise.all([
      listen<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
        void refreshChangedSetting(event.payload ?? {});
      }),
      listen<ModelAssignmentsChangedPayload>(MODEL_ASSIGNMENTS_CHANGED_EVENT, (event) => {
        dispatch('model_assignments_changed', event.payload ?? {});
      }),
    ]);
  } catch (error) {
    bridgeWindow.__deepStudentChatV2DomainEventBridgeInstalled = false;
    console.warn('[chat-v2-domain-events] failed to install event bridge', error);
    return [];
  }
}
