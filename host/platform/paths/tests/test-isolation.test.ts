/**
 * Test wiring often calls `createPaths({ dataDir, platform })` without an env, which used to resolve
 * OS dirs from the real `$HOME`; device-id resolution then read and copied
 * `~/Library/Application Support/deep-student/.device_id` into the test data dir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import pathsPlugin, {
  SHELL_OS_DIRS_ENV,
  createPaths,
  isRealUserPath,
  resolveOsDirs,
  sandboxTestEnv,
  type PathsService,
  type UserHomeRoots,
} from '../index.ts';

const realHome = userInfo().homedir;
const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
const dirs: string[] = [];
const hosts: TestHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'f4-paths-isolation-'));
  dirs.push(dir);
  return dir;
}

function expectNoRealHome(paths: PathsService, dataDir: string): void {
  const userDirs = [paths.os.home, paths.os.data, paths.os.dataLocal, paths.os.config, paths.os.cache,
    paths.appLogDir, paths.appLocalDataDir, paths.fallbackSecureDir, paths.syncStateDatabase, ...paths.legacyDeviceIdFiles];
  for (const dir of userDirs) {
    // dataDir itself may sit inside the real home (server job TMPDIR `~/oc-jobs-tmp/<id>`).
    const inRealHome = dir === realHome || dir.startsWith(`${realHome}${sep}`);
    expect(inRealHome && !dir.startsWith(`${dataDir}${sep}`)).toBe(false);
    expect(dir.startsWith(dataDir)).toBe(true);
  }
}

it('createPaths without an injected env never resolves the real user home under test', () => {
  const dataDir = tempDir();
  expectNoRealHome(createPaths({ dataDir, platform, log: () => {} }), dataDir);
});

it('the paths plugin used by createTestHost never resolves the real user home under test', async () => {
  const dataDir = tempDir();
  const host = await createTestHost({ app: { dataDir }, plugins: [pathsPlugin] });
  hosts.push(host);
  expectNoRealHome(host.ctx.paths, dataDir);
  expect((await host.ctx.paths.dataSpaceDeviceId()).length).toBeGreaterThan(0);
});

it('an explicitly injected env is kept as-is', () => {
  const paths = createPaths({ dataDir: '/d/app', platform: 'linux', env: { HOME: '/h' }, log: () => {} });
  expect(paths.os.home).toBe('/h');
  expect(paths.legacyDeviceIdFiles).toContain('/h/deep-student/.device_id');
});

describe('sandboxTestEnv (pure)', () => {
  const server: UserHomeRoots = { realHome: '/home/dsdev', tempDirs: ['/home/dsdev/oc-jobs-tmp/42'] };

  it('real home → sandbox; temp dirs inside the real home are test-owned and kept', () => {
    const out = sandboxTestEnv({
      HOME: '/home/dsdev',
      XDG_DATA_HOME: '/home/dsdev/oc-jobs-tmp/42/case/local',
      XDG_CONFIG_HOME: '/home/dsdev/.config',
      XDG_CACHE_HOME: '',
    }, 'linux', '/home/dsdev/oc-jobs-tmp/42/case/app', server)!;
    expect(out.HOME).toBe('/home/dsdev/oc-jobs-tmp/42/case/app/.test-home');
    expect(out.XDG_DATA_HOME).toBe('/home/dsdev/oc-jobs-tmp/42/case/local');
    expect('XDG_CONFIG_HOME' in out).toBe(false);
    expect('XDG_CACHE_HOME' in out).toBe(false);
    expect(resolveOsDirs('linux', out).dataLocal).toBe('/home/dsdev/oc-jobs-tmp/42/case/local');
  });

  it('nothing in the real home → null (the process env is used unchanged)', () => {
    expect(sandboxTestEnv({ HOME: '/home/dsdev/oc-jobs-tmp/42/h', XDG_DATA_HOME: '/tmp/x' }, 'linux', '/d', server)).toBeNull();
  });

  it('".." cannot climb out of the temp dir into the real home', () => {
    const out = sandboxTestEnv({ HOME: '/tmp/h', XDG_CONFIG_HOME: '/home/dsdev/oc-jobs-tmp/42/../../.config' }, 'linux', '/tmp/app', server)!;
    expect('XDG_CONFIG_HOME' in out).toBe(false);
    expect(out.HOME).toBe('/tmp/h');
  });

  it('a temp dir that contains the real home does not exempt it', () => {
    const roots: UserHomeRoots = { realHome: '/home/u', tempDirs: ['/home'] };
    expect(isRealUserPath('/home/u/.config', 'linux', roots)).toBe(true);
    expect(isRealUserPath('/home/u2/.config', 'linux', roots)).toBe(false);
  });

  it('DS_SHELL_OS_DIRS entries in the real home cannot bypass the sandbox', () => {
    const env = {
      HOME: '/home/dsdev',
      [SHELL_OS_DIRS_ENV]: JSON.stringify({ home: '/home/dsdev', dataLocal: '/home/dsdev/.local/share', cache: '/tmp/c' }),
    };
    const out = sandboxTestEnv(env, 'linux', '/tmp/app', server)!;
    const os = resolveOsDirs('linux', out);
    expect(os.home).toBe('/tmp/app/.test-home');
    expect(os.dataLocal).toBe('/tmp/app/.test-home/.local/share');
    expect(os.cache).toBe('/tmp/c');
  });

  it('Windows: profile matched case-insensitively and with either separator; %TEMP% inside the profile is test-owned', () => {
    const roots: UserHomeRoots = { realHome: 'C:\\Users\\Ann', tempDirs: ['C:\\Users\\Ann\\AppData\\Local\\Temp'] };
    const out = sandboxTestEnv({
      USERPROFILE: 'c:\\users\\ann',
      APPDATA: 'C:/Users/Ann/AppData/Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local\\Temp\\job\\local',
    }, 'win32', 'C:\\Users\\Ann\\AppData\\Local\\Temp\\job\\app', roots)!;
    expect(out.USERPROFILE).toBe('C:\\Users\\Ann\\AppData\\Local\\Temp\\job\\app\\.test-home');
    expect('APPDATA' in out).toBe(false);
    expect(out.LOCALAPPDATA).toBe('C:\\Users\\Ann\\AppData\\Local\\Temp\\job\\local');
    const os = resolveOsDirs('win32', out);
    expect(os.data).toBe('C:\\Users\\Ann\\AppData\\Local\\Temp\\job\\app\\.test-home\\AppData\\Roaming');
    expect(os.dataLocal).toBe('C:\\Users\\Ann\\AppData\\Local\\Temp\\job\\local');
  });

  it('Windows: UNC profiles and other drives', () => {
    const roots: UserHomeRoots = { realHome: '\\\\fs01\\profiles\\ann', tempDirs: [] };
    expect(isRealUserPath('//FS01/Profiles/ann/AppData', 'win32', roots)).toBe(true);
    expect(isRealUserPath('\\\\fs01\\profiles\\anna', 'win32', roots)).toBe(false);
    expect(isRealUserPath('D:\\profiles\\ann', 'win32', roots)).toBe(false);
  });
});
