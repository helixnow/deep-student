import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const locale = (language: string) => JSON.parse(read(`src/locales/${language}/sync.json`));

it('r11_autosync_locale_zh_en_autosync_subtrees_are_aligned', () => {
  function collectKeys(value: unknown, prefix = ''): string[] {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, child]) => collectKeys(child, prefix ? `${prefix}.${key}` : key))
      : [prefix];
  }
  const zh = locale('zh-CN');
  const en = locale('en-US');
  expect(zh.autoSync).toBeDefined();
  expect(en.autoSync).toBeDefined();
  const keys = collectKeys(zh.autoSync).sort();
  expect(keys).toEqual(collectKeys(en.autoSync).sort());
  for (const key of [
    'intervalLabel', 'interval.15m', 'interval.1h', 'interval.6h', 'lastRun', 'neverRan',
    'outcome.success', 'outcome.failure', 'outcome.skippedUnconfigured',
    'outcome.skippedBusy', 'outcome.skippedLeaseHeld', 'consecutiveFailures',
  ]) expect(keys).toContain(key);
});

it('lease_held_locale_keys_are_aligned', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const message = locale(language).errors.leaseHeld;
    expect(typeof message).toBe('string');
    expect(message.includes('retry') || message.includes('重试')).toBe(true);
  }
});
