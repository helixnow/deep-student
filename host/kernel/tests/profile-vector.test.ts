import { expect, it } from 'vitest';
import { importProfile, installProfile, OFFICIAL_PROFILE_PATH, resolveProfile } from '../profile.ts';
import { createTestHost } from '../testing.ts';

it('installs and unloads the real vector provider selected from the generated official profile', async () => {
  // Verify only the real F7 entry's assembly/lifetime. No substitute storage and no claim
  // about whole-profile readiness, Lance table operations or the other native capabilities.
  const selected = (await resolveProfile(OFFICIAL_PROFILE_PATH)).filter(entry => entry.id === 'dstu.vector');
  expect(selected).toHaveLength(1);
  const entries = await importProfile(selected);
  const host = await createTestHost();
  try {
    const result = await installProfile(host.runtime, entries);
    expect(result.degraded).toEqual([]);
    expect(result.installed.map(entry => entry.id)).toEqual(['dstu.vector']);
    expect(result.installed[0]!.plugin.meta.provides).toEqual(['vector']);
    expect(typeof host.ctx.get('vector')?.connect).toBe('function');
    await host.unload('dstu.vector');
    expect(host.ctx.get('vector')).toBeUndefined();
  } finally { await host.dispose(); }
});
