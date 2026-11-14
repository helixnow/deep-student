/**
 * `DS_APP_IDENTIFIER` (W06 handoff): under `DS_APP_DATA_DIR` smoke isolation the app data directory name is not the
 * bundle identifier, so the Host's app local/config/cache/log dirs must take the identifier the shell hands over —
 * otherwise they diverge from the shell's path plugin (`PathResolver`), which joins `tauri.conf.json`'s identifier.
 */
import { describe, expect, it } from 'vitest';
import { hostPathEnv, resolveShellOsDirs } from '../../../../electron/shell/os-dirs.ts';
import { BaseDirectory, type PathEnvironment } from '../../../../electron/shell/paths.ts';
import { APP_IDENTIFIER_ENV, createPaths, resolveAppIdentifier } from '../index.ts';

const IDENTIFIER = 'com.deepstudent.app';

const cases = [
  { platform: 'darwin', appData: '/tmp/smoke/data', env: { HOME: '/Users/real' }, real: '/Users/real' },
  {
    platform: 'linux', appData: '/tmp/smoke/data', real: '/home/real',
    env: { HOME: '/home/real', XDG_DATA_HOME: '/home/real/.data', XDG_CONFIG_HOME: '/home/real/.cfg', XDG_CACHE_HOME: '/home/real/.c' },
  },
  {
    platform: 'win32', appData: 'C:\\smoke\\data', real: 'C:\\Users\\real',
    env: { USERPROFILE: 'C:\\Users\\real', APPDATA: 'C:\\Users\\real\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local' },
  },
] as const;

function shellEnvironment(platform: PathEnvironment['platform'], env: Record<string, string>, real: string): PathEnvironment {
  return {
    platform,
    env,
    fallbackHome: real,
    identifier: IDENTIFIER,
    tempDir: platform === 'win32' ? 'C:\\Temp' : '/tmp',
    resourceDir: null,
    ...(platform === 'win32' ? { windowsKnownFolders: { profile: real, roamingAppData: `${real}\\AppData\\Roaming`, localAppData: `${real}\\AppData\\Local` } } : {}),
  };
}

describe('DS_APP_IDENTIFIER: Host app dirs match the shell path plugin under smoke isolation', () => {
  for (const c of cases) {
    it(`${c.platform}: appLocalDataDir / appConfigDir / appCacheDir / appLogDir equal PathResolver's App* directories`, () => {
      const shell = resolveShellOsDirs(shellEnvironment(c.platform, c.env, c.real), c.appData);
      const env = { ...c.env, ...hostPathEnv(shell.dirs, IDENTIFIER) };
      const paths = createPaths({ dataDir: c.appData, platform: c.platform, env, log: () => {} });

      expect(paths.identifier).toBe(IDENTIFIER);
      expect(paths.appDataDir).toBe(shell.paths.resolveDirectory(BaseDirectory.AppData));
      expect(paths.appLocalDataDir).toBe(shell.paths.resolveDirectory(BaseDirectory.AppLocalData));
      expect(paths.appConfigDir).toBe(shell.paths.resolveDirectory(BaseDirectory.AppConfig));
      expect(paths.appCacheDir).toBe(shell.paths.resolveDirectory(BaseDirectory.AppCache));
      expect(paths.appLogDir).toBe(shell.paths.resolveDirectory(BaseDirectory.AppLog));
    });
  }

  it('without DS_APP_IDENTIFIER the identifier is basename(dataDir) (installed builds: both are the identifier)', () => {
    const paths = createPaths({ dataDir: `/home/u/.local/share/${IDENTIFIER}`, platform: 'linux', env: { HOME: '/home/u' }, log: () => {} });
    expect(paths.identifier).toBe(IDENTIFIER);
    expect(paths.appConfigDir).toBe(`/home/u/.config/${IDENTIFIER}`);
    expect(resolveAppIdentifier('win32', { [APP_IDENTIFIER_ENV]: '' }, 'C:\\smoke\\data')).toEqual({ identifier: 'data', problem: null });
  });

  it('a value that is not a single identifier segment is rejected with a warning, falling back to basename(dataDir)', () => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '.', '..', 'com..app', '.com.app', 'com app', 'com.app\n']) {
      const warnings: string[] = [];
      const paths = createPaths({
        dataDir: '/tmp/smoke/data', platform: 'linux', env: { HOME: '/home/u', [APP_IDENTIFIER_ENV]: bad },
        log: (level, message) => { if (level === 'warn') warnings.push(message); },
      });
      expect(paths.identifier, bad).toBe('data');
      expect(paths.appCacheDir, bad).toBe('/home/u/.cache/data');
      expect(warnings, bad).toEqual([`[paths] ${APP_IDENTIFIER_ENV} 不是合法的 bundle identifier: ${JSON.stringify(bad)}，改用 app data 目录名 data`]);
    }
  });
});
