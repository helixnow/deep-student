/**
 * 外壳交给 Host 的操作系统目录（`dirs::home_dir/data_dir/data_local_dir/config_dir/cache_dir`）。
 *
 * 只有这一个计算函数：main 在 fork Host 之前把结果写进 `DS_SHELL_OS_DIRS`（Host
 * `host/platform/paths/os-dirs.ts` 以它为准，storage 的 `ctx.paths.os.dataLocal` 即由此而来），
 * shell op `app.dataDirs` 与 localStorage 迁移的 `homeDir` / `dataLocalDir` 也读同一份结果。
 *
 * `DS_APP_DATA_DIR`（冒烟隔离）生效时，五个目录一起换到 `<DS_APP_DATA_DIR>.os/home` 下按平台默认布局推导，
 * 不继承真实用户的 HOME、XDG_*、%LOCALAPPDATA% 或 Known Folder，避免读写真实用户数据
 * （例如 Tauri 版 WebView 存储、sync 状态库、`.secure`）。隔离目录放在 app data 之外：Host 启动恢复会把
 * app data 根下的未知条目移入 recovery。
 */
import { join as posixJoin } from 'node:path/posix';
import { join as winJoin } from 'node:path/win32';
import { APP_IDENTIFIER_ENV, SHELL_OS_DIRS_ENV, type ShellOsDirKey } from '../../host/platform/paths/os-dirs.ts';
import { PathResolver, type PathEnvironment } from './paths.ts';

export type ShellOsDirMap = Readonly<Record<ShellOsDirKey, string | null>>;

/** 冒烟隔离时操作系统目录的根（与 app data 同级）。 */
export function isolatedOsRoot(appDataDir: string): string {
  return `${appDataDir}.os`;
}

const INHERITED_DIR_VARIABLES = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_BIN_HOME',
  'XDG_RUNTIME_DIR',
];

function isolatedEnvironment(base: PathEnvironment, root: string, appDataDir: string): PathEnvironment {
  const env = { ...base.env };
  for (const name of INHERITED_DIR_VARIABLES) delete env[name];
  if (base.platform === 'win32') {
    const home = winJoin(root, 'home');
    const roaming = winJoin(home, 'AppData', 'Roaming');
    return {
      ...base,
      env,
      fallbackHome: home,
      appDataDir,
      // Known Folder 的 Windows 默认布局；FOLDERID_Public 在 profile 之外，同样落在隔离根下。
      windowsKnownFolders: {
        profile: home,
        roamingAppData: roaming,
        localAppData: winJoin(home, 'AppData', 'Local'),
        desktop: winJoin(home, 'Desktop'),
        documents: winJoin(home, 'Documents'),
        downloads: winJoin(home, 'Downloads'),
        music: winJoin(home, 'Music'),
        pictures: winJoin(home, 'Pictures'),
        videos: winJoin(home, 'Videos'),
        templates: winJoin(roaming, 'Microsoft', 'Windows', 'Templates'),
        public: winJoin(root, 'Public'),
      },
    };
  }
  const home = posixJoin(root, 'home');
  return { ...base, env: { ...env, HOME: home }, fallbackHome: home, appDataDir, windowsKnownFolders: {} };
}

/**
 * `paths` 即 path 插件、asset / fs / opener 作用域使用的解析器：隔离时与 `dirs` 出自同一个隔离环境，
 * AppData 为 `DS_APP_DATA_DIR` 本身；未设置时与 `new PathResolver(base)` 完全相同（Tauri 语义）。
 */
export function resolveShellOsDirs(
  base: PathEnvironment,
  appDataDirOverride: string | undefined,
): { dirs: ShellOsDirMap; paths: PathResolver; isolatedRoot: string | null } {
  const isolatedRoot = appDataDirOverride === undefined || appDataDirOverride === '' ? null : isolatedOsRoot(appDataDirOverride);
  const paths = new PathResolver(isolatedRoot === null ? base : isolatedEnvironment(base, isolatedRoot, appDataDirOverride!));
  return {
    dirs: { home: paths.home(), data: paths.dataDir(), dataLocal: paths.localDataDir(), config: paths.configDir(), cache: paths.cacheDir() },
    paths,
    isolatedRoot,
  };
}

/** `DS_SHELL_OS_DIRS` 的值；解析不出的目录不写（Host 对缺省项按自身规则推导）。 */
export function shellOsDirsJson(dirs: ShellOsDirMap): string {
  return JSON.stringify(Object.fromEntries(Object.entries(dirs).filter(([, value]) => value !== null)));
}

/**
 * fork Host 之前写入 `process.env` 的路径相关变量（utilityProcess 与 worker 线程继承）。`APP_IDENTIFIER_ENV` 是配置的
 * bundle identifier：`DS_APP_DATA_DIR` 隔离时 app data 目录名不是 identifier，Host 的 app_log_dir / app_local_data_dir /
 * app_config_dir / app_cache_dir 按它拼接（`host/platform/paths/os-dirs.ts` `resolveAppIdentifier`）。
 */
export function hostPathEnv(dirs: ShellOsDirMap, identifier: string): Record<string, string> {
  return { [SHELL_OS_DIRS_ENV]: shellOsDirsJson(dirs), [APP_IDENTIFIER_ENV]: identifier };
}
