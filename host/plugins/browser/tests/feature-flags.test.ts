import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFeatureFlagCommands, featureFlagsResult, rustF64AsF32 } from '../../../platform/settings/feature-flag-commands.ts';
import { openFileDatabase } from '../../../platform/storage/service.ts';
import { f3FeatureFlags, loadF3Flags } from './support/f3-feature-flags.ts';

function openFlags(file: string, readOnly = false) {
  const db = openFileDatabase(file, { profile: { readonly: readOnly } });
  if (!readOnly) db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const commands = createFeatureFlagCommands({
    appVersion: '0.20.0', debug: false, featureFlags: f3FeatureFlags,
    settings: {
      get: key => db.pluck<string>('SELECT value FROM settings WHERE key = ?', [key]) ?? null,
      save: (key, value) => { db.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', [key, value]); },
    },
  });
  return { commands, close: () => db.close() };
}

// feature_flags.rs::tests belong to F3 (host/platform/storage/tests/feature-flags.test.ts).
describe('src/cmd/web_search.rs feature flag command shaping', () => {
  it('get_feature_flags groups the F3 manager flags by category', () => {
    const values = new Map<string, string>();
    const manager = loadF3Flags({ get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); } });
    const result = featureFlagsResult(manager);
    expect(result.total_count).toBe(manager.listAllFlags().length);
    expect(result.flags.map(flag => flag.name)).toEqual(manager.listAllFlags().map(flag => flag.name));
    for (const [category, flags] of Object.entries(result.flags_by_category)) {
      expect(flags.every(flag => flag.category === category)).toBe(true);
    }
    expect(Object.values(result.flags_by_category).flat()).toHaveLength(result.total_count);
  });

  it('set_gradual converts the f64 argument with `as f32` and stores the f32 shortest decimal', () => {
    expect(rustF64AsF32(0.3)).toBe(0.3);
    expect(rustF64AsF32(0.30000000000000004)).toBe(0.3);
    expect(rustF64AsF32(0.123456789123)).toBe(0.12345679);
    expect(rustF64AsF32(1)).toBe(1);
    expect(rustF64AsF32(0)).toBe(0);
    expect(rustF64AsF32(1e39)).toBe(Infinity);
    expect(rustF64AsF32(-1e39)).toBe(-Infinity);
  });

  it('reads the updated flag after closing and reopening its SQLite settings', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dstu-feature-flags-')), 'flags.db');
    const featureName = 'tools.workbench_agent';
    const first = openFlags(file);
    try {
      expect(first.commands.isFeatureEnabled({ featureName })).toBe(true);
      expect(first.commands.updateFeatureFlag({ featureName, action: 'disable' }).success).toBe(true);
    } finally {
      first.close();
    }
    const restarted = openFlags(file);
    try {
      expect(restarted.commands.getFeatureFlags().flags).toContainEqual(expect.objectContaining({ name: featureName, state: 'Disabled' }));
      expect(restarted.commands.isFeatureEnabled({ featureName })).toBe(false);
      restarted.commands.updateFeatureFlag({ featureName, action: 'reset' });
      expect(restarted.commands.isFeatureEnabled({ featureName })).toBe(true);
    } finally {
      restarted.close();
    }
  });

  it('fails unsupported edits and a failed real database write', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dstu-feature-flags-')), 'flags.db');
    openFlags(file).close();
    const locked = openFlags(file, true);
    const featureName = 'tools.workbench_agent';
    try {
      expect(() => locked.commands.updateFeatureFlag({ featureName, action: 'noop' })).toThrow(/不支持的操作/);
      expect(() => locked.commands.updateFeatureFlag({ featureName: 'missing', action: 'enable' })).toThrow(/not found/);
      expect(() => locked.commands.updateFeatureFlag({ featureName, action: 'set_gradual', value: NaN })).toThrow(/百分比/);
      expect(() => locked.commands.updateFeatureFlag({ featureName, action: 'disable' })).toThrow(/保存功能开关失败/);
      expect(locked.commands.isFeatureEnabled({ featureName })).toBe(true);
    } finally {
      locked.close();
    }
  });
});
