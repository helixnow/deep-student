/**
 * 操作系统目录（Rust `dirs` / dirs-sys）。无 Cordis 依赖，storage 的 worker 线程也直接引用，
 * 保证 Host 内只有这一套 `data_local_dir` 等推导。
 */
import { readFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import type { OsDirs } from './api.ts';
import { rustJoin } from './compat.ts';

export type Platform = 'darwin' | 'win32' | 'linux';

/** 进程环境的只读视图（测试可注入）。 */
export type Env = Readonly<Record<string, string | undefined>>;

function separatorOf(platform: Platform): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/';
}

/** `dirs_sys::is_absolute_path`：非空且绝对路径才采用 XDG 变量。 */
function xdg(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.startsWith('/') ? value : undefined;
}

/** dirs-sys `home_dir()`：Unix 取非空 `$HOME`，否则 passwd；Windows 取 FOLDERID_Profile（`%USERPROFILE%`）。 */
function resolveHome(platform: Platform, env: Env): string {
  if (platform === 'win32') {
    const profile = env.USERPROFILE;
    return profile !== undefined && profile !== '' ? profile : homedir();
  }
  const home = env.HOME;
  if (home !== undefined && home !== '') return home;
  return userInfo().homedir;
}

/** dirs 4.0 `download_dir()` 在 Linux 上读 `user-dirs.dirs` 的 `XDG_DOWNLOAD_DIR`。 */
function linuxUserDir(home: string, config: string, name: string): string | null {
  let text: string;
  try {
    text = readFileSync(rustJoin(config, '/', 'user-dirs.dirs'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"(.*)"\s*$/.exec(line);
    if (!match || match[1] !== name) continue;
    const raw = match[2] ?? '';
    if (raw.startsWith('$HOME/')) return rustJoin(home, '/', raw.slice('$HOME/'.length));
    if (raw === '$HOME') return null;
    if (raw.startsWith('/')) return raw;
    return null;
  }
  return null;
}

/**
 * 外壳传给 Host 进程的操作系统目录（JSON，键为 {@link ShellOsDirKey}）。
 *
 * Electron main 用 `electron/shell/paths.ts` 的 `PathResolver` 解析（Windows 走 Known Folder，
 * 与 Rust `dirs` 的 `SHGetKnownFolderPath` 一致），在 fork Host 之前写入 `process.env`；
 * utilityProcess 与 worker 线程继承该变量。Host 侧以它为准，缺省或无效时才按环境变量推导。
 */
export const SHELL_OS_DIRS_ENV = 'DS_SHELL_OS_DIRS';

export type ShellOsDirKey = 'home' | 'data' | 'dataLocal' | 'config' | 'cache';
const SHELL_OS_DIR_KEYS: readonly ShellOsDirKey[] = ['home', 'data', 'dataLocal', 'config', 'cache'];

export interface ShellOsDirs {
  readonly dirs: Partial<Record<ShellOsDirKey, string>>;
  /** 被忽略的字段与原因（格式错误、非绝对路径）。 */
  readonly problems: readonly string[];
}

function isAbsoluteFor(platform: Platform, value: string): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value) : value.startsWith('/');
}

/** 解析 {@link SHELL_OS_DIRS_ENV}；只接受目标平台的绝对路径。 */
export function parseShellOsDirs(platform: Platform, env: Env): ShellOsDirs {
  const raw = env[SHELL_OS_DIRS_ENV];
  if (raw === undefined || raw === '') return { dirs: {}, problems: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { dirs: {}, problems: [`${SHELL_OS_DIRS_ENV} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { dirs: {}, problems: [`${SHELL_OS_DIRS_ENV} 必须是 JSON 对象`] };
  }
  const record = value as Record<string, unknown>;
  const dirs: Partial<Record<ShellOsDirKey, string>> = {};
  const problems: string[] = [];
  for (const key of SHELL_OS_DIR_KEYS) {
    const entry = record[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string' || !isAbsoluteFor(platform, entry)) {
      problems.push(`${SHELL_OS_DIRS_ENV}.${key} 不是 ${platform} 绝对路径: ${JSON.stringify(entry)}`);
      continue;
    }
    dirs[key] = entry;
  }
  return { dirs, problems };
}

/**
 * 外壳传给 Host 的 bundle identifier（`tauri.conf.json` 的 `identifier`，`electron/shell/os-dirs.ts` 的 `hostPathEnv`
 * 在 fork Host 之前写入）。`DS_APP_DATA_DIR` 隔离时 app data 目录名不是 identifier，app_log_dir / app_local_data_dir /
 * app_config_dir / app_cache_dir 按它拼接才与外壳 path 插件一致。
 */
export const APP_IDENTIFIER_ENV = 'DS_APP_IDENTIFIER';

/** Tauri identifier 的字符集（字母数字、`-`，以 `.` 分段），保证它只是一个路径段。 */
const IDENTIFIER_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

/** {@link APP_IDENTIFIER_ENV} 优先；缺省或不合法时取 `basename(appDataDir)`（Tauri 中二者相同），不合法时给出原因。 */
export function resolveAppIdentifier(platform: Platform, env: Env, appDataDir: string): { identifier: string; problem: string | null } {
  const raw = env[APP_IDENTIFIER_ENV];
  const fallback = (platform === 'win32' ? win32 : posix).basename(appDataDir);
  if (raw === undefined || raw === '') return { identifier: fallback, problem: null };
  if (IDENTIFIER_RE.test(raw)) return { identifier: raw, problem: null };
  return { identifier: fallback, problem: `${APP_IDENTIFIER_ENV} 不是合法的 bundle identifier: ${JSON.stringify(raw)}` };
}

/** `dirs::home_dir()`，外壳的 `home` 优先；不推导其余目录（不读 `user-dirs.dirs`）。 */
export function resolveOsHome(platform: Platform, env: Env): string {
  return parseShellOsDirs(platform, env).dirs.home ?? resolveHome(platform, env);
}

/** Known Folder 总是绝对路径：环境变量为空或相对路径时按 profile 默认布局推导。 */
function windowsEnvDir(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && isAbsoluteFor('win32', value) ? value : undefined;
}

/**
 * `dirs` 的操作系统目录。外壳经 {@link SHELL_OS_DIRS_ENV} 提供的值优先（Windows Known Folder
 * 的权威来源），其余按 dirs-sys 规则从环境变量推导。
 */
export function resolveOsDirs(platform: Platform, env: Env): OsDirs {
  const shell = parseShellOsDirs(platform, env).dirs;
  const sep = separatorOf(platform);
  const home = shell.home ?? resolveHome(platform, env);
  const temp = tmpdir();
  if (platform === 'darwin') {
    const appSupport = rustJoin(home, sep, 'Library/Application Support');
    return {
      home,
      data: shell.data ?? appSupport,
      dataLocal: shell.dataLocal ?? appSupport,
      config: shell.config ?? appSupport,
      cache: shell.cache ?? rustJoin(home, sep, 'Library/Caches'),
      temp,
      download: rustJoin(home, sep, 'Downloads'),
    };
  }
  if (platform === 'win32') {
    const roaming = shell.data ?? windowsEnvDir(env, 'APPDATA') ?? rustJoin(home, sep, 'AppData', 'Roaming');
    const local = shell.dataLocal ?? windowsEnvDir(env, 'LOCALAPPDATA') ?? rustJoin(home, sep, 'AppData', 'Local');
    return {
      home,
      data: roaming,
      dataLocal: local,
      config: shell.config ?? roaming,
      cache: shell.cache ?? local,
      temp,
      download: rustJoin(home, sep, 'Downloads'),
    };
  }
  const data = shell.data ?? xdg(env, 'XDG_DATA_HOME') ?? rustJoin(home, sep, '.local/share');
  const config = shell.config ?? xdg(env, 'XDG_CONFIG_HOME') ?? rustJoin(home, sep, '.config');
  return {
    home,
    data,
    dataLocal: shell.dataLocal ?? data,
    config,
    cache: shell.cache ?? xdg(env, 'XDG_CACHE_HOME') ?? rustJoin(home, sep, '.cache'),
    temp,
    download: linuxUserDir(home, config, 'DOWNLOAD'),
  };
}

