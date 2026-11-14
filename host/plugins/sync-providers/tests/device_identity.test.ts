/**
 * [R4-P06] L23 consumes F4 `paths.dataSpaceDeviceId()` directly.
 *
 * The owner implementation (DEVICE_ID env → primary `.device_id` → legacy
 * migration → generate, process-stable fallback and production logging) lives
 * in F4 `host/platform/paths` and is exercised by F4's own scenario tests.
 * This lane keeps only:
 * - always-on delegation/error-propagation tests for the production command;
 * - the Rust `sync_android_*` persistence/rotation and subprocess assertions,
 *   which now run against the F4 owner API present in main.
 *
 * There is no local identity reconstruction and no optional fallback: a missing
 * owner method is a programming error and propagates as a kernel panic.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { HandlerPanic } from '../../../kernel/testing.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { createSyncHost } from './host_fixture.ts';

const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function restartFixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'device-restart-'));
  tempDirs.push(base);
  return base;
}

interface ProbeOutput {
  deviceId: string;
  r09Initial: string;
  old?: string;
  new?: string;
  after?: string;
}

/** Runs one fresh app process against the same data dir (separate OS process). */
function runDeviceProbe(baseDir: string, rotate = false): ProbeOutput {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(baseDir, 'home'),
    XDG_DATA_HOME: join(baseDir, 'xdg-data'),
    XDG_CONFIG_HOME: join(baseDir, 'xdg-config'),
    L23_DEVICE_PROBE_DATA_DIR: baseDir,
  };
  delete env.DEVICE_ID;
  if (rotate) env.L23_DEVICE_PROBE_ROTATE = '1';
  else delete env.L23_DEVICE_PROBE_ROTATE;

  const probe = fileURLToPath(new URL('./fixtures/device_id_probe.ts', import.meta.url));
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings', probe,
  ], { env, encoding: 'utf8' });
  // Child processes must exit successfully; a non-zero exit is the failure.
  expect(result.status, `probe failed:\n${result.stderr}\n${result.stdout}`).toBe(0);

  const field = (prefix: string): string | undefined => result.stdout
    .split(/\s+/)
    .find(token => token.startsWith(prefix))
    ?.slice(prefix.length);
  return {
    deviceId: field('PROBE_DEVICE_ID=')!,
    r09Initial: field('R09_PROBE_INITIAL=')!,
    old: field('PROBE_OLD='),
    new: field('PROBE_NEW='),
    after: field('PROBE_AFTER='),
  };
}

describe('cloud_sync_get_device_id consumes the F4 owner API', () => {
  it('scenario_38_device_id_persistence', async () => {
    // sync_scenarios_tests.rs:1288-1292: two calls are stable and nonempty.
    const fixture = await createSyncHost();
    try {
      const first = await fixture.host.invoke<string>('cloud_sync_get_device_id');
      const second = await fixture.host.invoke<string>('cloud_sync_get_device_id');
      expect(first).toBe(second);
      expect(first).not.toBe('');
    } finally { await fixture.dispose(); }
  });

  it('adv_14_device_id_collision_scenario', async () => {
    // sync_adversarial_tests.rs:605-611 tests stability, not global uniqueness.
    const fixture = await createSyncHost();
    try {
      const first = await fixture.host.invoke<string>('cloud_sync_get_device_id');
      const second = await fixture.host.invoke<string>('cloud_sync_get_device_id');
      expect(first).toBe(second);
    } finally { await fixture.dispose(); }
  });

  it('persists a generated id and preserves hostname priority through the command', async () => {
    const fixture = await createSyncHost({ env: { COMPUTERNAME: 'win-box', HOSTNAME: 'linux-box', HOST: 'mac-box' } });
    try {
      const first = await fixture.host.invoke<string>('cloud_sync_get_device_id');
      expect(first.startsWith('win-box-')).toBe(true);
      expect(await readFile(join(fixture.host.app.dataDir, '.device_id'), 'utf8')).toBe(first);
      expect(await fixture.host.invoke('cloud_sync_get_device_id')).toBe(first);
    } finally { await fixture.dispose(); }
  });

  it('DEVICE_ID wins over primary and legacy files through the command', async () => {
    const fixture = await createSyncHost({ env: { DEVICE_ID: 'env-id', COMPUTERNAME: 'win-box' } });
    try {
      await writeFile(join(fixture.host.app.dataDir, 'device_id'), 'legacy-root-id\n');
      await writeFile(join(fixture.host.app.dataDir, '.device_id'), 'primary-id\n');
      expect(await fixture.host.invoke('cloud_sync_get_device_id')).toBe('env-id');
    } finally { await fixture.dispose(); }
  });

  it('uses primary before the legacy wrapper and migrates a lone legacy identity', async () => {
    const fixture = await createSyncHost();
    try {
      await writeFile(join(fixture.host.app.dataDir, 'device_id'), 'legacy-root-id\n');
      await writeFile(join(fixture.host.app.dataDir, '.device_id'), 'primary-id\n');
      expect(await fixture.host.invoke('cloud_sync_get_device_id')).toBe('primary-id');
    } finally { await fixture.dispose(); }
    const legacy = await createSyncHost();
    try {
      await writeFile(join(legacy.host.app.dataDir, 'device_id'), 'legacy-root-id\n');
      expect(await legacy.host.invoke('cloud_sync_get_device_id')).toBe('legacy-root-id');
      expect((await readFile(join(legacy.host.app.dataDir, '.device_id'), 'utf8')).trim()).toBe('legacy-root-id');
    } finally { await legacy.dispose(); }
  });

  // Rust `dirs::data_local_dir()` on Linux: `$XDG_DATA_HOME`, else `$HOME/.local/share` (the fixture sets no XDG variables).
  it('migrates the default Linux data path through the command', async () => {
    const fixture = await createSyncHost({ pathsPlatform: 'linux' });
    try {
      const legacy = join(fixture.host.app.dataDir, '.local', 'share', 'deep-student');
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, '.device_id'), 'xdg-default-id');
      expect(await fixture.host.invoke('cloud_sync_get_device_id')).toBe('xdg-default-id');
      expect((await readFile(join(fixture.host.app.dataDir, '.device_id'), 'utf8')).trim()).toBe('xdg-default-id');
    } finally { await fixture.dispose(); }
  });

  it('logs migration failure and retains the readable legacy identity', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const fixture = await createSyncHost({
      pathsPlatform: 'linux',
      pathsLog: (level, message) => { logs.push({ level, message }); },
    });
    try {
      const legacy = join(fixture.host.app.dataDir, '.local', 'share', 'deep-student');
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, '.device_id'), 'legacy-still-readable');
      await mkdir(join(fixture.host.app.dataDir, '.device_id'));
      expect(await fixture.host.invoke('cloud_sync_get_device_id')).toBe('legacy-still-readable');
      expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('迁移到主路径'))).toBe(true);
    } finally { await fixture.dispose(); }
  });

  it('keeps a process-stable identity and logs persistence failure', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const fixture = await createSyncHost({ pathsLog: (level, message) => { logs.push({ level, message }); } });
    try {
      await mkdir(join(fixture.host.app.dataDir, '.device_id'));
      const first = await fixture.host.invoke('cloud_sync_get_device_id');
      expect(await fixture.host.invoke('cloud_sync_get_device_id')).toBe(first);
      expect(logs.some(entry => entry.level === 'error' && entry.message.includes('无法持久化'))).toBe(true);
    } finally { await fixture.dispose(); }
  });

  it('delegates to paths.dataSpaceDeviceId() without local identity logic', async () => {
    const calls: string[] = [];
    const host = await createSyncHost({
      dataSpaceDeviceId: async () => {
        calls.push('owner');
        return 'owner-id';
      },
    });
    try {
      expect(await host.host.invoke<string>('cloud_sync_get_device_id')).toBe('owner-id');
      expect(calls).toEqual(['owner']);
    } finally {
      await host.dispose();
    }
  });

  it('propagates an owner AppError unchanged from a Result-returning command', async () => {
    const host = await createSyncHost({
      dataSpaceDeviceId: async () => { throw new CommandError(AppError.file_system('owner device id read failed')); },
    });
    try {
      await expect(host.host.invoke('cloud_sync_list_versions', {
        config: {
          provider: 'webdav',
          webdav: { endpoint: 'https://dav.example.com/root', username: 'student', password: 'secret' },
        },
      })).rejects.toEqual({
        error_type: 'FileSystem',
        message: 'owner device id read failed',
        details: null,
      });
    } finally {
      await host.dispose();
    }
  });

  it('keeps an unknown owner failure as a kernel panic', async () => {
    const host = await createSyncHost({
      dataSpaceDeviceId: async () => { throw new TypeError('owner bug'); },
    });
    try {
      await expect(host.host.invoke('cloud_sync_get_device_id')).rejects.toBeInstanceOf(HandlerPanic);
    } finally {
      await host.dispose();
    }
  });

  it(
    'does not synthesize an identity when the F4 owner API is absent',
    async () => {
      const host = await createSyncHost();
      try {
        // Explicit dependency fault, rather than conditionally skipping on main.
        Object.defineProperty(host.paths, 'dataSpaceDeviceId', { value: undefined });
        await expect(host.host.invoke('cloud_sync_get_device_id')).rejects.toBeInstanceOf(HandlerPanic);
      } finally {
        await host.dispose();
      }
    },
  );
});

describe('F4 owner identity integration', () => {
  it('device_id_persists_in_app_data_dir_and_rotates_after_restore', async () => {
    const base = await restartFixture();
    const deviceIdFile = join(base, '.device_id');

    // sync_android_restart.rs:864-912 uses fresh OS processes, not new objects.
    const first = runDeviceProbe(base).deviceId;
    expect(first.trim()).not.toBe('');
    expect((await stat(deviceIdFile)).isFile()).toBe(true);
    expect((await readFile(deviceIdFile, 'utf8')).trim()).toBe(first);

    // Restart: the identity is read back from disk, not regenerated.
    expect(runDeviceProbe(base).deviceId).toBe(first);

    // Restore activation: rotate must produce a different persisted identity.
    const rotated = runDeviceProbe(base, true);
    const oldId = rotated.old;
    const newId = rotated.new;
    expect(oldId).toBeDefined();
    expect(newId).toBeDefined();
    expect(oldId).toBe(first);
    expect(newId).not.toBe(oldId);
    expect(rotated.after).toBe(newId);
    expect((await readFile(deviceIdFile, 'utf8')).trim()).toBe(newId);

    // A later restart never resurrects the old identity.
    expect(runDeviceProbe(base).deviceId).toBe(newId);
  });

  it('device_id_lives_in_app_data_dir_and_rotates_after_restore', async () => {
    const base = await restartFixture();
    const deviceIdFile = join(base, '.device_id');

    // sync_android_device_switch.rs:1096-1140 has the same subprocess contract.
    const firstBoot = runDeviceProbe(base).deviceId;
    expect((await stat(deviceIdFile)).isFile()).toBe(true);
    expect((await readFile(deviceIdFile, 'utf8')).trim()).toBe(firstBoot);

    const rotation = runDeviceProbe(base, true);
    expect(rotation.deviceId).toBe(firstBoot);
    const oldId = rotation.old;
    const newId = rotation.new;
    expect(oldId).toBeDefined();
    expect(newId).toBeDefined();
    expect(oldId).toBe(firstBoot);
    expect(newId).not.toBe(oldId);
    expect(rotation.after).toBe(newId);
    expect((await readFile(deviceIdFile, 'utf8')).trim()).toBe(newId);

    expect(runDeviceProbe(base).deviceId).toBe(newId);
  });

  it('sync_r07_device_id_probe', async () => {
    const base = await restartFixture();
    const deviceIdFile = join(base, '.device_id');

    const first = runDeviceProbe(base);
    expect(first.deviceId.trim()).not.toBe('');
    expect((await readFile(deviceIdFile, 'utf8')).trim()).toBe(first.deviceId);

    // A second process reads the same persisted identity.
    expect(runDeviceProbe(base).deviceId).toBe(first.deviceId);

    // Rotation happens in another process; the next process sees only the new id.
    const rotated = runDeviceProbe(base, true);
    expect(rotated.old).toBe(first.deviceId);
    expect(rotated.new).toBeDefined();
    expect(rotated.new).not.toBe(first.deviceId);
    expect(rotated.after).toBe(rotated.new);
    expect((await readFile(deviceIdFile, 'utf8')).trim()).toBe(rotated.new);
    expect(runDeviceProbe(base).deviceId).toBe(rotated.new);
  });

  it('r09_device_id_probe_subprocess', async () => {
    const base = await restartFixture();
    const isolatedHome = join(base, 'home');
    await mkdir(isolatedHome, { recursive: true });

    const initial = runDeviceProbe(base);
    expect(initial.r09Initial).toBe(initial.deviceId);

    const rotated = runDeviceProbe(base, true);
    expect(rotated.old).toBe(initial.deviceId);
    expect(rotated.new).toBeDefined();
    expect(rotated.new).not.toBe(rotated.old);
    expect(rotated.after).toBe(rotated.new);
    expect(runDeviceProbe(base).deviceId).toBe(rotated.new);
  });
});
