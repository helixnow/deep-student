import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { readEnabled, readSettings, writeEnabled, writeSettings } from '../src/settings.ts';

function settingsStore() {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); } };
}

describe('super_session settings (state.rs)', () => {
  it('settings_roundtrip', async () => {
    const settings = settingsStore();
    const host = await createTestHost({ plugins: [plugin], provide: { settings, storage: {} } });
    try {
      expect(readEnabled(settings)).toBe(false);
      writeEnabled(settings, true);
      expect(readEnabled(settings)).toBe(true);
      writeEnabled(settings, false);
      expect(readEnabled(settings)).toBe(false);
      expect(readSettings(settings)).toEqual({ instructions: '' });
      await host.invoke('super_session_set_settings', { settings: { instructions: `  ${'x'.repeat(4010)}  ` } });
      const result = await host.invoke<{ instructions: string }>('super_session_get_settings');
      expect([...result.instructions]).toHaveLength(4000);
    } finally { await host.dispose(); }
  });

  it('clips Unicode scalar values and uses Rust whitespace trimming', async () => {
    const settings = settingsStore();
    const host = await createTestHost({ plugins: [plugin], provide: { settings, storage: {} } });
    try {
      await host.invoke('super_session_set_settings', { settings: { instructions: `\u0085${'😀'.repeat(4010)}\u0085` } });
      expect(settings.get('super_agent.instructions')).toBe('😀'.repeat(4000));
      writeSettings(settings, { instructions: '\ufeffkeep\ufeff' });
      expect(readSettings(settings).instructions).toBe('\ufeffkeep\ufeff');
      await expect(host.invoke('super_session_set_settings', { settings: {} })).resolves.toBeNull();
      expect(readSettings(settings).instructions).toBe('');
    } finally { await host.dispose(); }
  });

  it('preserves read fallback and write error strings', async () => {
    const settings = {
      get(): never { throw new Error('read error'); },
      save(): never { throw new Error('disk full'); },
    };
    const host = await createTestHost({ plugins: [plugin], provide: { settings, storage: {} } });
    try {
      expect(readEnabled(settings)).toBe(false);
      await expect(host.invoke('super_session_get_settings')).resolves.toEqual({ instructions: '' });
      await expect(host.invoke('super_session_set_settings', { settings: { instructions: 'x' } }))
        .rejects.toBe('保存 super_agent.instructions 失败: disk full');
    } finally { await host.dispose(); }
  });
});
