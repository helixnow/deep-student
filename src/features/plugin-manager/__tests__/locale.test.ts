import { describe, expect, it } from 'vitest';

import desktopProfile from '../../../../host/profiles/desktop.json';
import en from '../../../locales/en-US/plugin_manager.json';
import zh from '../../../locales/zh-CN/plugin_manager.json';
import { pluginCategory } from '../presentation';
import { DEGRADED_CODE_KEYS } from '../reasons';
import type { ManagedPlugin } from '../types';

type Dict = Record<string, unknown>;

function flatten(node: Dict, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object') for (const [child, text] of flatten(value as Dict, path)) out.set(child, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1]).sort();

describe('plugin_manager locale', () => {
  it('defines the same keys in zh-CN and en-US', () => {
    const zhKeys = [...flatten(zh as Dict).keys()].sort();
    const enKeys = [...flatten(en as Dict).keys()].sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('matches interpolation placeholders between languages', () => {
    const zhFlat = flatten(zh as Dict);
    const enFlat = flatten(en as Dict);
    for (const [key, text] of zhFlat) {
      expect({ key, placeholders: placeholders(enFlat.get(key) ?? '') }).toEqual({ key, placeholders: placeholders(text) });
    }
  });

  it('has a message for every Host degraded code and for CONSENT_REQUIRED', () => {
    const zhFlat = flatten(zh as Dict);
    const enFlat = flatten(en as Dict);
    for (const suffix of [...Object.values(DEGRADED_CODE_KEYS), 'consent_required']) {
      expect(zhFlat.has(`degraded.code.${suffix}`)).toBe(true);
      expect(enFlat.has(`degraded.code.${suffix}`)).toBe(true);
    }
  });

  it('defines localized names and descriptions for every official desktop plugin and maps kernel/shell lanes', () => {
    const zhFlat = flatten(zh as Dict);
    const enFlat = flatten(en as Dict);
    for (const entry of desktopProfile.plugins) {
      expect(zhFlat.get(`builtinNames.${entry.id}`), `missing zh name for ${entry.id}`).toBeTruthy();
      expect(enFlat.get(`builtinNames.${entry.id}`), `missing en name for ${entry.id}`).toBeTruthy();
      expect(zhFlat.get(`builtinDescriptions.${entry.id}`), `missing zh description for ${entry.id}`).toBeTruthy();
      expect(enFlat.get(`builtinDescriptions.${entry.id}`), `missing en description for ${entry.id}`).toBeTruthy();
    }
    expect(pluginCategory({ id: 'dstu.plugins', category: 'F1-kernel' } as ManagedPlugin)).toBe('manager.categories.platform');
    expect(pluginCategory({ id: 'dstu.shell', category: 'F2-shell' } as ManagedPlugin)).toBe('manager.categories.platform');
  });
});
