/**
 * Server jobs put the process temp dir inside the real user home (`~/oc-jobs-tmp/<id>`), and on Windows
 * `%TEMP%` is `<profile>\AppData\Local\Temp`. Directories a test creates under the temp dir belong to the
 * test, so the Vitest home sandbox must keep them even though they sit inside the real home.
 *
 * The real home is simulated as the parent of the temp dir, so nothing is read or written in the
 * developer's actual home.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createPaths } from '../index.ts';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const { dirname: parentOf } = await import('node:path');
  const fakeHome = parentOf(actual.tmpdir());
  const userInfo = ((options?: { encoding: BufferEncoding }) => ({ ...actual.userInfo(options), homedir: fakeHome })) as typeof actual.userInfo;
  return { ...actual, default: { ...actual, userInfo }, userInfo };
});

const fakeRealHome = userInfo().homedir;
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'f4-paths-home-tmp-'));
  dirs.push(dir);
  return dir;
}

it('the simulated real home contains the process temp dir', () => {
  expect(fakeRealHome).toBe(dirname(tmpdir()));
});

it('an explicit XDG_DATA_HOME under the temp dir survives the sandbox, so sync_state.db follows it', () => {
  const dir = tempDir();
  vi.stubEnv('HOME', fakeRealHome);
  vi.stubEnv('XDG_DATA_HOME', join(dir, 'local'));
  const paths = createPaths({ dataDir: join(dir, 'app'), platform: 'linux', log: () => {} });
  expect(paths.os.home).toBe(join(dir, 'app', '.test-home'));
  expect(paths.os.dataLocal).toBe(join(dir, 'local'));
  expect(paths.syncStateDatabase).toBe(join(dir, 'local', 'deep-student', 'sync', 'sync_state.db'));
});

it('a test HOME under the temp dir is the test home, not the real one', () => {
  const dir = tempDir();
  vi.stubEnv('HOME', join(dir, 'home'));
  const paths = createPaths({ dataDir: join(dir, 'app'), platform: 'linux', log: () => {} });
  expect(paths.os.home).toBe(join(dir, 'home'));
  expect(paths.legacyDeviceIdFiles).toContain(join(dir, 'home', 'deep-student', '.device_id'));
});

it('XDG dirs inside the real home but outside the temp dir are still dropped', () => {
  const dir = tempDir();
  vi.stubEnv('HOME', fakeRealHome);
  vi.stubEnv('XDG_CONFIG_HOME', join(fakeRealHome, '.config-not-temp'));
  const paths = createPaths({ dataDir: join(dir, 'app'), platform: 'linux', log: () => {} });
  expect(paths.os.config).toBe(join(dir, 'app', '.test-home', '.config'));
});

it('a real-home XDG dir is dropped even when the test already redirected HOME', () => {
  const dir = tempDir();
  vi.stubEnv('HOME', join(dir, 'home'));
  vi.stubEnv('XDG_DATA_HOME', join(fakeRealHome, '.local-not-temp', 'share'));
  const paths = createPaths({ dataDir: join(dir, 'app'), platform: 'linux', log: () => {} });
  expect(paths.os.dataLocal).toBe(join(dir, 'home', '.local', 'share'));
  expect(paths.syncStateDatabase.startsWith(join(dir, 'home'))).toBe(true);
});
