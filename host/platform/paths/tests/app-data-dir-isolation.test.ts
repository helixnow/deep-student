/**
 * `DS_APP_DATA_DIR` (smoke isolation, W12 finding #4): the shell moves every `dirs::` directory under
 * `<DS_APP_DATA_DIR>.os/home` and hands them to the Host as `DS_SHELL_OS_DIRS`. The Host still inherits the
 * real user's HOME / XDG_* / %APPDATA% in its process env, so every user-level location it derives — main
 * log, crash and debug logs, sync_state.db, the fallback `.secure`, legacy device-id copies, app
 * local/config/cache dirs — must come from `DS_SHELL_OS_DIRS` alone.
 */
import { join as posixJoin } from 'node:path/posix';
import { join as winJoin } from 'node:path/win32';
import { describe, expect, it } from 'vitest';
import { isolatedOsRoot, resolveShellOsDirs, shellOsDirsJson } from '../../../../electron/shell/os-dirs.ts';
import type { PathEnvironment } from '../../../../electron/shell/paths.ts';
import { createPaths, SHELL_OS_DIRS_ENV, type PathsService } from '../index.ts';

const realPosix = {
  HOME: '/home/real', XDG_DATA_HOME: '/home/real/.data', XDG_CONFIG_HOME: '/home/real/.cfg', XDG_CACHE_HOME: '/home/real/.c',
};
const realWindows = {
  USERPROFILE: 'C:\\Users\\real', APPDATA: 'C:\\Users\\real\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
};

const cases = [
  { platform: 'darwin', appData: '/tmp/smoke/data', env: { HOME: '/Users/real' }, real: '/Users/real' },
  { platform: 'linux', appData: '/tmp/smoke/data', env: realPosix, real: '/home/real' },
  { platform: 'win32', appData: 'C:\\smoke\\data', env: realWindows, real: 'C:\\Users\\real' },
] as const;

function shellEnvironment(platform: PathEnvironment['platform'], env: Record<string, string>, real: string): PathEnvironment {
  return {
    platform,
    env,
    fallbackHome: real,
    identifier: 'com.deepstudent.app',
    tempDir: platform === 'win32' ? 'C:\\Temp' : '/tmp',
    resourceDir: null,
    ...(platform === 'win32' ? { windowsKnownFolders: { profile: real, roamingAppData: `${real}\\AppData\\Roaming`, localAppData: `${real}\\AppData\\Local` } } : {}),
  };
}

function userLevelPaths(paths: PathsService): string[] {
  return [
    paths.os.home, paths.os.data, paths.os.dataLocal, paths.os.config, paths.os.cache,
    paths.appLogDir, paths.mainLogFile, paths.crashLogDir, paths.debugLogsDir, paths.structuredLogDir('backend'),
    paths.appLocalDataDir, paths.appConfigDir, paths.appCacheDir,
    paths.syncStateDatabase, paths.fallbackSecureDir,
    ...paths.legacyDeviceIdFiles.filter((file) => !file.startsWith(paths.appDataDir)),
  ];
}

describe('DS_APP_DATA_DIR isolation reaches the Host through DS_SHELL_OS_DIRS', () => {
  for (const c of cases) {
    it(`${c.platform}: logs, sync_state.db and every user-level path stay under <DS_APP_DATA_DIR>.os`, () => {
      const { dirs } = resolveShellOsDirs(shellEnvironment(c.platform, c.env, c.real), c.appData);
      const hostEnv = { ...c.env, [SHELL_OS_DIRS_ENV]: shellOsDirsJson(dirs) };
      const paths = createPaths({ dataDir: c.appData, platform: c.platform, env: hostEnv, log: () => {} });
      const root = isolatedOsRoot(c.appData);
      const join = c.platform === 'win32' ? winJoin : posixJoin;
      const sep = c.platform === 'win32' ? '\\' : '/';

      for (const value of userLevelPaths(paths)) {
        expect(value.startsWith(`${root}${sep}`), value).toBe(true);
        expect(value.toLowerCase().startsWith(c.real.toLowerCase()), value).toBe(false);
      }
      const home = join(root, 'home');
      const local = c.platform === 'darwin' ? join(home, 'Library/Application Support')
        : c.platform === 'win32' ? join(home, 'AppData', 'Local') : join(home, '.local/share');
      expect(paths.syncStateDatabase).toBe(join(local, 'deep-student', 'sync', 'sync_state.db'));
      expect(paths.mainLogFile).toBe(c.platform === 'darwin'
        ? join(home, 'Library/Logs', 'data', 'deep-student.log')
        : join(local, 'data', 'logs', 'deep-student.log'));
    });
  }

  it('without DS_SHELL_OS_DIRS the inherited env is used (Tauri semantics outside the shell)', () => {
    const paths = createPaths({ dataDir: '/tmp/smoke/data', platform: 'linux', env: realPosix, log: () => {} });
    expect(paths.syncStateDatabase).toBe('/home/real/.data/deep-student/sync/sync_state.db');
  });
});
