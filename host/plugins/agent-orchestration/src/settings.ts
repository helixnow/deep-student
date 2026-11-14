import type { SettingsStore } from '../../../platform/settings/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { SuperSessionSettings } from '../api.ts';

export const SETTING_ENABLED = 'super_agent.enabled';
export const SETTING_INSTRUCTIONS = 'super_agent.instructions';
export const MAX_INSTRUCTIONS_CHARS = 4000;
export type SuperSettingsStore = Pick<SettingsStore, 'get' | 'save'>;

export function readEnabled(settings: SuperSettingsStore): boolean {
  try {
    const value = rustTrim(settings.get(SETTING_ENABLED) ?? '');
    return value === 'true' || value === '1';
  } catch {
    return false;
  }
}

export function writeEnabled(settings: SuperSettingsStore, enabled: boolean): void {
  try {
    settings.save(SETTING_ENABLED, enabled ? 'true' : 'false');
  } catch (error) {
    throw new Error(`保存 ${SETTING_ENABLED} 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readSettings(settings: SuperSettingsStore): SuperSessionSettings {
  try {
    return { instructions: settings.get(SETTING_INSTRUCTIONS) ?? '' };
  } catch {
    return { instructions: '' };
  }
}

export function writeSettings(settings: SuperSettingsStore, value: SuperSessionSettings): void {
  const clipped = [...rustTrim(value.instructions)].slice(0, MAX_INSTRUCTIONS_CHARS).join('');
  try {
    settings.save(SETTING_INSTRUCTIONS, clipped);
  } catch (error) {
    throw new Error(`保存 ${SETTING_INSTRUCTIONS} 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
