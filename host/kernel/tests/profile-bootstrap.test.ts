import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { generateDesktopProfile } from '../../profiles/generate.ts';
import { loadProfile } from '../profile.ts';
import { createTestHost } from '../testing.ts';

const root = fileURLToPath(new URL('../__fixtures__/profile-host-bootstrap/', import.meta.url));

it('W13 rejects a bootstrap that would wait for storage or a downstream service', async () => {
  const root = fileURLToPath(new URL('../__fixtures__/profile-host-bootstrap-invalid/', import.meta.url));
  await expect(generateDesktopProfile(root)).rejects.toThrow('invalid: pre-storage bootstrap must inject only paths');
});

it.each([false, true])('W13 generated bootstrap runs before storage even on apply failure=%s', async fail => {
  // This tests the actual generator/loader seam, not F3 purge or L20 table-reset behavior.
  const trace: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'dstu-bootstrap-'));
  const host = await createTestHost({ provide: { bootstrapTrace: trace } });
  try {
    const profile = JSON.parse(await generateDesktopProfile(root)) as { plugins: { id: string; module: string; config?: unknown }[] };
    expect(profile.plugins.map(p => p.id)).toEqual([
      'dstu.plugins', 'fixture.z-bootstrap', 'dstu.platform.paths', 'dstu.platform.storage',
    ]);
    for (const p of profile.plugins) {
      p.module = resolve(root, 'profiles', p.module);
      if (p.id === 'fixture.z-bootstrap') p.config = { fail };
    }
    const path = join(dir, 'profile.json');
    await writeFile(path, JSON.stringify(profile));
    const loaded = await loadProfile(host.runtime, path);
    expect(trace).toEqual(['paths', 'bootstrap', fail ? 'storage:provider-missing' : 'storage:provider-ready']);
    expect(loaded.degraded).toEqual(fail ? [{ id: 'fixture.z-bootstrap', reason: 'APPLY_FAILED: bootstrap apply failed' }] : []);
    expect(loaded.installed.map(p => p.id)).toContain('dstu.platform.storage');
  } finally { await host.dispose(); await rm(dir, { recursive: true, force: true }); }
});

it.each([false, true])('W13 discovers the independent sync/startup.ts before late sync (failure=%s)', async fail => {
  const moduleRoot = fileURLToPath(new URL('../__fixtures__/profile-host-bootstrap-module/', import.meta.url));
  const trace: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'dstu-bootstrap-module-'));
  const host = await createTestHost({ provide: { bootstrapTrace: trace } });
  try {
    const profile = JSON.parse(await generateDesktopProfile(moduleRoot)) as { plugins: { id: string; module: string; config?: unknown }[] };
    expect(profile.plugins.map(p => p.id)).toEqual([
      'dstu.plugins', 'fixture.z-bootstrap', 'dstu.platform.paths', 'dstu.platform.storage', 'fixture.sync',
    ]);
    expect(profile.plugins[1]!.module).toBe('../plugins/sync/startup.ts');
    for (const p of profile.plugins) {
      p.module = resolve(moduleRoot, 'profiles', p.module);
      if (p.id === 'fixture.z-bootstrap') p.config = { fail };
    }
    const path = join(dir, 'profile.json');
    await writeFile(path, JSON.stringify(profile));
    const loaded = await loadProfile(host.runtime, path);
    expect(trace).toEqual(['paths', 'bootstrap', fail ? 'storage:provider-missing' : 'storage:provider-ready', 'sync']);
    expect(loaded.degraded).toEqual(fail ? [{ id: 'fixture.z-bootstrap', reason: 'APPLY_FAILED: bootstrap apply failed' }] : []);
    expect(loaded.installed.map(p => p.id)).toContain('fixture.sync');
  } finally { await host.dispose(); await rm(dir, { recursive: true, force: true }); }
});
