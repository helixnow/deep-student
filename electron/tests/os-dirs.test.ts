/**
 * 外壳 → Host 的操作系统目录只有一个来源：`resolveShellOsDirs` 的结果既写入 `DS_SHELL_OS_DIRS`
 * （Host `resolveOsDirs` 以它为准），也是 `app.dataDirs` 的返回值；`DS_APP_DATA_DIR` 隔离时五个目录一起隔离。
 */
import { join as posixJoin } from 'node:path/posix';
import { join as winJoin } from 'node:path/win32';
import { describe, expect, it } from 'vitest';
import { APP_IDENTIFIER_ENV, parseShellOsDirs, resolveAppIdentifier, resolveOsDirs, SHELL_OS_DIRS_ENV } from '../../host/platform/paths/os-dirs.ts';
import { hostPathEnv, isolatedOsRoot, resolveShellOsDirs, shellOsDirsJson } from '../shell/os-dirs.ts';
import { BaseDirectory, PathResolver, UnknownPathError, type PathEnvironment } from '../shell/paths.ts';

const identifier = 'com.deepstudent.app';

function environment(platform: PathEnvironment['platform'], env: Record<string, string>, known?: PathEnvironment['windowsKnownFolders']): PathEnvironment {
  return {
    platform,
    env,
    fallbackHome: platform === 'win32' ? 'C:\\Users\\real' : '/home/real',
    identifier,
    tempDir: '/tmp',
    resourceDir: null,
    ...(known === undefined ? {} : { windowsKnownFolders: known }),
  };
}

const windowsKnown = {
  profile: 'C:\\Users\\real',
  roamingAppData: 'C:\\Users\\real\\AppData\\Roaming',
  localAppData: 'D:\\Redirected\\Local',
};

describe('resolveShellOsDirs without DS_APP_DATA_DIR', () => {
  it('returns exactly what PathResolver resolves for every platform', () => {
    const cases = [
      environment('darwin', { HOME: '/Users/real' }),
      environment('linux', { HOME: '/home/real', XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' }),
      environment('win32', { LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local' }, windowsKnown),
    ];
    for (const env of cases) {
      const paths = new PathResolver(env);
      const { dirs, isolatedRoot, paths: shellPaths } = resolveShellOsDirs(env, undefined);
      expect(isolatedRoot).toBeNull();
      for (let directory = 1; directory <= 23; directory += 1) {
        const resolve = (resolver: PathResolver) => {
          try {
            return resolver.resolveDirectory(directory);
          } catch (error) {
            return error instanceof UnknownPathError ? null : String(error);
          }
        };
        expect(resolve(shellPaths)).toBe(resolve(paths));
      }
      expect(shellPaths.appDataDir()).toBe(paths.appDataDir());
      expect(dirs).toEqual({
        home: paths.home(),
        data: paths.dataDir(),
        dataLocal: paths.localDataDir(),
        config: paths.configDir(),
        cache: paths.cacheDir(),
      });
    }
  });

  it('Windows dataLocal is the Known Folder, not %LOCALAPPDATA%, and the Host adopts it from the env value', () => {
    const env = environment('win32', { LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local' }, windowsKnown);
    const { dirs } = resolveShellOsDirs(env, undefined);
    expect(dirs.dataLocal).toBe('D:\\Redirected\\Local');
    const hostEnv = { LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local', [SHELL_OS_DIRS_ENV]: shellOsDirsJson(dirs) };
    expect(parseShellOsDirs('win32', hostEnv).problems).toEqual([]);
    const host = resolveOsDirs('win32', hostEnv);
    expect({ home: host.home, data: host.data, dataLocal: host.dataLocal, config: host.config, cache: host.cache }).toEqual(dirs);
  });

  it('serialises only resolvable directories (null never reaches the Host as a string)', () => {
    const json = shellOsDirsJson({ home: '/h', data: null, dataLocal: '/h/l', config: '/h/c', cache: null });
    expect(JSON.parse(json)).toEqual({ home: '/h', dataLocal: '/h/l', config: '/h/c' });
  });
});

describe('resolveShellOsDirs with DS_APP_DATA_DIR (smoke isolation)', () => {
  it('macOS: home and every dirs:: directory move under <DS_APP_DATA_DIR>.os/home, ignoring the real HOME', () => {
    const appData = '/tmp/smoke/appdata';
    const root = isolatedOsRoot(appData);
    expect(root).toBe('/tmp/smoke/appdata.os');
    const home = posixJoin(root, 'home');
    const { dirs, isolatedRoot } = resolveShellOsDirs(environment('darwin', { HOME: '/Users/real' }), appData);
    expect(isolatedRoot).toBe(root);
    expect(dirs).toEqual({
      home,
      data: posixJoin(home, 'Library/Application Support'),
      dataLocal: posixJoin(home, 'Library/Application Support'),
      config: posixJoin(home, 'Library/Application Support'),
      cache: posixJoin(home, 'Library/Caches'),
    });
  });

  it('Linux: XDG_* of the real user are not inherited', () => {
    const appData = '/tmp/smoke/appdata';
    const home = posixJoin(isolatedOsRoot(appData), 'home');
    const env = environment('linux', { HOME: '/home/real', XDG_DATA_HOME: '/home/real/.data', XDG_CONFIG_HOME: '/home/real/.cfg', XDG_CACHE_HOME: '/home/real/.c' });
    expect(resolveShellOsDirs(env, appData).dirs).toEqual({
      home,
      data: posixJoin(home, '.local/share'),
      dataLocal: posixJoin(home, '.local/share'),
      config: posixJoin(home, '.config'),
      cache: posixJoin(home, '.cache'),
    });
  });

  it('Windows: Known Folders and %LOCALAPPDATA% of the real user are not inherited', () => {
    const appData = 'C:\\smoke\\appdata';
    const root = isolatedOsRoot(appData);
    expect(root).toBe('C:\\smoke\\appdata.os');
    const home = winJoin(root, 'home');
    const env = environment('win32', { LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local', APPDATA: 'C:\\Users\\real\\AppData\\Roaming' }, windowsKnown);
    expect(resolveShellOsDirs(env, appData).dirs).toEqual({
      home,
      data: winJoin(home, 'AppData', 'Roaming'),
      dataLocal: winJoin(home, 'AppData', 'Local'),
      config: winJoin(home, 'AppData', 'Roaming'),
      cache: winJoin(home, 'AppData', 'Local'),
    });
  });

  it('the path plugin resolver comes from the same isolation: app dirs follow DS_SHELL_OS_DIRS and AppData is DS_APP_DATA_DIR', () => {
    for (const [platform, appData] of [['darwin', '/tmp/a/appdata'], ['linux', '/tmp/a/appdata'], ['win32', 'C:\\a\\appdata']] as const) {
      const join = platform === 'win32' ? winJoin : posixJoin;
      const env = environment(platform, { HOME: '/home/real', XDG_CONFIG_HOME: '/home/real/.cfg' }, platform === 'win32' ? windowsKnown : undefined);
      const { dirs, paths } = resolveShellOsDirs(env, appData);
      expect(paths.appDataDir()).toBe(appData);
      expect(paths.resolveDirectory(BaseDirectory.AppData)).toBe(appData);
      expect(paths.resolveDirectory(BaseDirectory.Home)).toBe(dirs.home);
      expect(paths.resolveDirectory(BaseDirectory.Data)).toBe(dirs.data);
      expect(paths.resolveDirectory(BaseDirectory.LocalData)).toBe(dirs.dataLocal);
      expect(paths.resolveDirectory(BaseDirectory.Config)).toBe(dirs.config);
      expect(paths.resolveDirectory(BaseDirectory.Cache)).toBe(dirs.cache);
      expect(paths.resolveDirectory(BaseDirectory.AppLocalData)).toBe(join(dirs.dataLocal!, identifier));
      expect(paths.resolveDirectory(BaseDirectory.AppConfig)).toBe(join(dirs.config!, identifier));
      expect(paths.resolveDirectory(BaseDirectory.AppCache)).toBe(join(dirs.cache!, identifier));
      expect(paths.resolve(BaseDirectory.AppData, 'notes/a.md')).toBe(join(appData, 'notes/a.md'));
    }
  });

  it('no directory the path plugin resolves points into the real user profile', () => {
    const appData = '/tmp/a/appdata';
    const root = isolatedOsRoot(appData);
    const realLinux = { HOME: '/home/real', XDG_CONFIG_HOME: '/home/real/.cfg', XDG_BIN_HOME: '/home/real/bin', XDG_RUNTIME_DIR: '/run/user/1000' };
    const cases = [
      { env: environment('darwin', { HOME: '/Users/real' }), root },
      { env: environment('linux', realLinux), root },
      { env: environment('win32', {}, { ...windowsKnown, documents: 'C:\\Users\\real\\Documents', downloads: 'C:\\Users\\real\\Downloads', desktop: 'D:\\Desk', public: 'C:\\Users\\Public' }), appData: 'C:\\a\\appdata', root: 'C:\\a\\appdata.os' },
    ];
    for (const c of cases) {
      const isolatedAppData = c.appData ?? appData;
      const { paths } = resolveShellOsDirs(c.env, isolatedAppData);
      const isolated = (value: string) => value === isolatedAppData || value.startsWith(c.root);
      for (let directory = 1; directory <= 23; directory += 1) {
        if (directory === BaseDirectory.Temp || directory === BaseDirectory.Resource) continue;
        let value: string | null;
        try {
          value = paths.resolveDirectory(directory);
        } catch (error) {
          expect(error).toBeInstanceOf(UnknownPathError);
          value = null;
        }
        if (value !== null) expect(`${c.env.platform}:${directory}:${value}`).toBe(`${c.env.platform}:${directory}:${isolated(value) ? value : '<outside isolation>'}`);
      }
    }
  });

  it('Windows user folders exist under the isolated profile (downloads and documents stay usable)', () => {
    const appData = 'C:\\a\\appdata';
    const home = winJoin(isolatedOsRoot(appData), 'home');
    const { paths } = resolveShellOsDirs(environment('win32', {}, windowsKnown), appData);
    expect(paths.resolveDirectory(BaseDirectory.Download)).toBe(winJoin(home, 'Downloads'));
    expect(paths.resolveDirectory(BaseDirectory.Document)).toBe(winJoin(home, 'Documents'));
    expect(paths.resolveDirectory(BaseDirectory.Desktop)).toBe(winJoin(home, 'Desktop'));
  });

  it('the Host env carries the configured identifier, not the isolated app data directory name', () => {
    const appData = '/tmp/smoke/data';
    const { dirs } = resolveShellOsDirs(environment('darwin', { HOME: '/Users/real' }), appData);
    const env = hostPathEnv(dirs, identifier);
    expect(Object.keys(env).sort()).toEqual([APP_IDENTIFIER_ENV, SHELL_OS_DIRS_ENV].sort());
    expect(env[APP_IDENTIFIER_ENV]).toBe('com.deepstudent.app');
    expect(env[SHELL_OS_DIRS_ENV]).toBe(shellOsDirsJson(dirs));
    expect(parseShellOsDirs('darwin', env)).toEqual({ dirs, problems: [] });
    // Host 的 app_log_dir 等按它拼接；不写时退回 app data 目录名。
    expect(resolveAppIdentifier('darwin', env, appData)).toEqual({ identifier: 'com.deepstudent.app', problem: null });
    expect(resolveAppIdentifier('darwin', {}, appData)).toEqual({ identifier: 'data', problem: null });
  });

  it('the isolated values survive the Host parser unchanged on every platform', () => {
    for (const [platform, appData] of [['darwin', '/tmp/a/appdata'], ['linux', '/tmp/a/appdata'], ['win32', 'C:\\a\\appdata']] as const) {
      const { dirs } = resolveShellOsDirs(environment(platform, {}, platform === 'win32' ? windowsKnown : undefined), appData);
      const parsed = parseShellOsDirs(platform, { [SHELL_OS_DIRS_ENV]: shellOsDirsJson(dirs) });
      expect(parsed.problems).toEqual([]);
      expect(parsed.dirs).toEqual(dirs);
    }
  });
});
