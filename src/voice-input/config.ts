import { getSetting, saveSetting } from '@/utils/settingsApi';

import type { VoiceInputConfig, VoiceInputInsertMode } from './types';

export const VOICE_INPUT_CONFIG_SETTING_KEY = 'voice_input.config';
export const VOICE_INPUT_CONFIG_CHANGED_EVENT = 'voice-input-config-changed';
export const DEFAULT_VOICE_INPUT_CONFIG: VoiceInputConfig = {
  maxDurationMs: 60_000,
  insertMode: 'replace-selection',
  hotkey: 'mod+shift+space',
};

function normalizeInsertMode(mode: unknown): VoiceInputInsertMode {
  return mode === 'replace-selection' ? mode : 'replace-selection';
}

export function normalizeVoiceInputConfig(
  input: Partial<VoiceInputConfig> | null | undefined
): VoiceInputConfig {
  const partial = input ?? {};
  const maxDurationMs =
    typeof partial.maxDurationMs === 'number' && Number.isFinite(partial.maxDurationMs) && partial.maxDurationMs > 0
      ? partial.maxDurationMs
      : DEFAULT_VOICE_INPUT_CONFIG.maxDurationMs;
  const hotkey =
    typeof partial.hotkey === 'string' && partial.hotkey.trim()
      ? partial.hotkey.trim()
      : DEFAULT_VOICE_INPUT_CONFIG.hotkey;
  const language =
    typeof partial.language === 'string' && partial.language.trim()
      ? partial.language.trim()
      : undefined;
  const prompt =
    typeof partial.prompt === 'string' && partial.prompt.trim()
      ? partial.prompt.trim()
      : undefined;

  return {
    maxDurationMs,
    insertMode: normalizeInsertMode(partial.insertMode),
    hotkey,
    language,
    prompt,
  };
}

export function parseVoiceInputConfig(raw: string | null | undefined): VoiceInputConfig {
  if (!raw) {
    return DEFAULT_VOICE_INPUT_CONFIG;
  }

  try {
    return normalizeVoiceInputConfig(JSON.parse(raw) as Partial<VoiceInputConfig>);
  } catch {
    return DEFAULT_VOICE_INPUT_CONFIG;
  }
}

export async function loadVoiceInputConfig(): Promise<VoiceInputConfig> {
  try {
    const raw = await getSetting(VOICE_INPUT_CONFIG_SETTING_KEY);
    return parseVoiceInputConfig(raw);
  } catch {
    return DEFAULT_VOICE_INPUT_CONFIG;
  }
}

export async function saveVoiceInputConfig(config: Partial<VoiceInputConfig>): Promise<VoiceInputConfig> {
  const normalized = normalizeVoiceInputConfig(config);
  await saveSetting(VOICE_INPUT_CONFIG_SETTING_KEY, JSON.stringify(normalized));
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(VOICE_INPUT_CONFIG_CHANGED_EVENT));
  }
  return normalized;
}
