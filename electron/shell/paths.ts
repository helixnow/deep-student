/**
 * Tauri `PathResolver`（tauri-2.11.5 `src/path/desktop.rs`）在 Node 中的等价实现。
 *
 * Tauri 桌面端的目录全部来自 `dirs` 6.0.0：
 * - macOS（dirs-6.0.0/src/mac.rs）：data_dir = data_local_dir = config_dir = `$HOME/Library/Application Support`，
 *   cache_dir = `$HOME/Library/Caches`；home 取 `$HOME`（非空）否则 getpwuid（dirs-sys-0.5.0 `home_dir`）。
 * - Windows（dirs-6.0.0/src/win.rs）：data_dir = config_dir = FOLDERID_RoamingAppData，
 *   data_local_dir = cache_dir = FOLDERID_LocalAppData，home = FOLDERID_Profile。
 * - Linux（dirs-6.0.0/src/lin.rs）：data_dir = data_local_dir = `$XDG_DATA_HOME`（须为绝对路径）否则 `$HOME/.local/share`，
 *   config_dir = `$XDG_CONFIG_HOME` 否则 `$HOME/.config`，cache_dir = `$XDG_CACHE_HOME` 否则 `$HOME/.cache`；
 *   桌面/文档等用户目录解析 `user-dirs.dirs`（dirs-sys-0.5.0 `xdg_user_dirs.rs`），未配置即 None。
 * app_* 目录 = 上述目录 `.join(identifier)`；app_log_dir 在 macOS 为 `$HOME/Library/Logs/<id>`，其余为
 * `data_local_dir/<id>/logs`；temp_dir = `std::env::temp_dir()`。
 */
import { readFileSync } from 'node:fs';
import { join as posixJoin } from 'node:path/posix';
import { join as winJoin } from 'node:path/win32';
import type { ShellPlatform } from './tauri-config.ts';

/** 与 `@tauri-apps/api/path` 的 `BaseDirectory` 数值一致（tauri-2.11.5 `src/path/mod.rs`）。 */
export const BaseDirectory = {
  Audio: 1,
  Cache: 2,
  Config: 3,
  Data: 4,
  LocalData: 5,
  Document: 6,
  Download: 7,
  Picture: 8,
  Public: 9,
  Video: 10,
  Resource: 11,
  Temp: 12,
  AppConfig: 13,
  AppData: 14,
  AppLocalData: 15,
  AppCache: 16,
  AppLog: 17,
  Desktop: 18,
  Executable: 19,
  Font: 20,
  Home: 21,
  Runtime: 22,
  Template: 23,
} as const;
export type BaseDirectoryValue = (typeof BaseDirectory)[keyof typeof BaseDirectory];

/** `BaseDirectory::variable()` 的映射，用于 `$APPDATA/**` 这类 scope 模式。 */
export const BASE_DIRECTORY_VARIABLES: Record<string, BaseDirectoryValue> = {
  $AUDIO: 1,
  $CACHE: 2,
  $CONFIG: 3,
  $DATA: 4,
  $LOCALDATA: 5,
  $DOCUMENT: 6,
  $DOWNLOAD: 7,
  $PICTURE: 8,
  $PUBLIC: 9,
  $VIDEO: 10,
  $RESOURCE: 11,
  $TEMP: 12,
  $APPCONFIG: 13,
  $APPDATA: 14,
  $APPLOCALDATA: 15,
  $APPCACHE: 16,
  $APPLOG: 17,
  $DESKTOP: 18,
  $EXE: 19,
  $FONT: 20,
  $HOME: 21,
  $RUNTIME: 22,
  $TEMPLATE: 23,
};

/** tauri `Error::UnknownPath` 的显示文本。 */
export const UNKNOWN_PATH = 'unknown path';

export class UnknownPathError extends Error {
  constructor() {
    super(UNKNOWN_PATH);
    this.name = 'UnknownPathError';
  }
}

export interface PathEnvironment {
  platform: ShellPlatform;
  /** `process.env` 快照。 */
  env: Record<string, string | undefined>;
  /** getpwuid 得到的 home（`$HOME` 为空时的回退）；Windows 为 FOLDERID_Profile。 */
  fallbackHome: string;
  identifier: string;
  /** `std::env::temp_dir()`。 */
  tempDir: string;
  /** 资源目录（打包后为 Electron `process.resourcesPath`）。 */
  resourceDir: string | null;
  /** Windows Known Folder（由 Electron `app.getPath` / 环境变量提供）。 */
  windowsKnownFolders?: Partial<Record<'roamingAppData' | 'localAppData' | 'profile' | 'music' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'public' | 'templates' | 'videos', string>>;
  /** `DS_APP_DATA_DIR`：替代 `data_dir/<identifier>` 作为 AppData，与 Host 握手的 appDataDir 一致。 */
  appDataDir?: string;
}

function absoluteEnv(env: PathEnvironment['env'], key: string): string | null {
  const value = env[key];
  return value !== undefined && value.startsWith('/') ? value : null;
}

/** dirs-sys `shell_unescape`：去掉反斜杠转义。 */
function shellUnescape(value: string): string {
  let out = '';
  let escape = false;
  for (const ch of value) {
    if (escape) {
      out += ch;
      escape = false;
    } else if (ch === '\\') {
      escape = true;
    } else {
      out += ch;
    }
  }
  return out;
}

/** dirs-sys `xdg_user_dirs::parse_user_dirs` 的单项查询。 */
export function parseXdgUserDir(home: string, content: string, name: string): string | null {
  for (const rawLine of content.split('\n')) {
    const eq = rawLine.indexOf('=');
    if (eq < 0) continue;
    const key = rawLine.slice(0, eq).trim();
    if (!(key.startsWith('XDG_') && key.endsWith('_DIR'))) continue;
    if (key.slice(4, key.length - 4) !== name) continue;
    let value = rawLine.slice(eq + 1).trim();
    if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) continue;
    value = value.slice(1, -1);
    if (value === '$HOME/') continue;
    if (value.startsWith('$HOME/')) return posixJoin(home, shellUnescape(value.slice('$HOME/'.length)));
    if (value.startsWith('/')) return shellUnescape(value);
  }
  return null;
}

export class PathResolver {
  readonly env: PathEnvironment;
  private readonly readFile: (path: string) => string | null;

  constructor(env: PathEnvironment, readFile?: (path: string) => string | null) {
    this.env = env;
    this.readFile =
      readFile ??
      ((path: string) => {
        try {
          return readFileSync(path, 'utf8');
        } catch (error) {
          if (error instanceof Error && 'code' in error) return null;
          throw error;
        }
      });
  }

  private join(...parts: string[]): string {
    return this.env.platform === 'win32' ? winJoin(...parts) : posixJoin(...parts);
  }

  private known(key: keyof NonNullable<PathEnvironment['windowsKnownFolders']>): string | null {
    return this.env.windowsKnownFolders?.[key] ?? null;
  }

  home(): string | null {
    if (this.env.platform === 'win32') return this.known('profile');
    const home = this.env.env.HOME;
    if (home !== undefined && home !== '') return home;
    return this.env.fallbackHome === '' ? null : this.env.fallbackHome;
  }

  private homeJoin(rel: string): string | null {
    const home = this.home();
    return home === null ? null : this.join(home, rel);
  }

  private linuxUserDir(name: string): string | null {
    const home = this.home();
    if (home === null) return null;
    const configHome = absoluteEnv(this.env.env, 'XDG_CONFIG_HOME') ?? posixJoin(home, '.config');
    const content = this.readFile(posixJoin(configHome, 'user-dirs.dirs'));
    return content === null ? null : parseXdgUserDir(home, content, name);
  }

  dataDir(): string | null {
    switch (this.env.platform) {
      case 'darwin':
        return this.homeJoin('Library/Application Support');
      case 'win32':
        return this.known('roamingAppData');
      case 'linux':
        return absoluteEnv(this.env.env, 'XDG_DATA_HOME') ?? this.homeJoin('.local/share');
    }
  }

  localDataDir(): string | null {
    switch (this.env.platform) {
      case 'darwin':
        return this.homeJoin('Library/Application Support');
      case 'win32':
        return this.known('localAppData');
      case 'linux':
        return this.dataDir();
    }
  }

  configDir(): string | null {
    switch (this.env.platform) {
      case 'darwin':
        return this.homeJoin('Library/Application Support');
      case 'win32':
        return this.known('roamingAppData');
      case 'linux':
        return absoluteEnv(this.env.env, 'XDG_CONFIG_HOME') ?? this.homeJoin('.config');
    }
  }

  cacheDir(): string | null {
    switch (this.env.platform) {
      case 'darwin':
        return this.homeJoin('Library/Caches');
      case 'win32':
        return this.known('localAppData');
      case 'linux':
        return absoluteEnv(this.env.env, 'XDG_CACHE_HOME') ?? this.homeJoin('.cache');
    }
  }

  private userDir(mac: string | null, win: Parameters<PathResolver['known']>[0] | null, xdg: string | null): string | null {
    switch (this.env.platform) {
      case 'darwin':
        return mac === null ? null : this.homeJoin(mac);
      case 'win32':
        return win === null ? null : this.known(win);
      case 'linux':
        return xdg === null ? null : this.linuxUserDir(xdg);
    }
  }

  /** Tauri `app_data_dir()`：`data_dir/<identifier>`。 */
  appDataDir(): string | null {
    if (this.env.appDataDir !== undefined) return this.env.appDataDir;
    const base = this.dataDir();
    return base === null ? null : this.join(base, this.env.identifier);
  }

  /** 解析 `BaseDirectory`，失败抛出 `unknown path`（tauri `resolve_path`）。 */
  resolveDirectory(directory: number): string {
    const id = this.env.identifier;
    const withId = (base: string | null) => (base === null ? null : this.join(base, id));
    let result: string | null;
    switch (directory) {
      case BaseDirectory.Audio:
        result = this.userDir('Music', 'music', 'MUSIC');
        break;
      case BaseDirectory.Cache:
        result = this.cacheDir();
        break;
      case BaseDirectory.Config:
        result = this.configDir();
        break;
      case BaseDirectory.Data:
        result = this.dataDir();
        break;
      case BaseDirectory.LocalData:
        result = this.localDataDir();
        break;
      case BaseDirectory.Document:
        result = this.userDir('Documents', 'documents', 'DOCUMENTS');
        break;
      case BaseDirectory.Download:
        result = this.userDir('Downloads', 'downloads', 'DOWNLOAD');
        break;
      case BaseDirectory.Picture:
        result = this.userDir('Pictures', 'pictures', 'PICTURES');
        break;
      case BaseDirectory.Public:
        result = this.userDir('Public', 'public', 'PUBLICSHARE');
        break;
      case BaseDirectory.Video:
        result = this.userDir('Movies', 'videos', 'VIDEOS');
        break;
      case BaseDirectory.Resource:
        result = this.env.resourceDir;
        break;
      case BaseDirectory.Temp:
        result = this.env.tempDir;
        break;
      case BaseDirectory.AppConfig:
        result = withId(this.configDir());
        break;
      case BaseDirectory.AppData:
        result = this.appDataDir();
        break;
      case BaseDirectory.AppLocalData:
        result = withId(this.localDataDir());
        break;
      case BaseDirectory.AppCache:
        result = withId(this.cacheDir());
        break;
      case BaseDirectory.AppLog:
        if (this.env.platform === 'darwin') {
          const home = this.home();
          result = home === null ? null : this.join(home, 'Library/Logs', id);
        } else {
          const local = this.localDataDir();
          result = local === null ? null : this.join(local, id, 'logs');
        }
        break;
      case BaseDirectory.Desktop:
        result = this.userDir('Desktop', 'desktop', 'DESKTOP');
        break;
      case BaseDirectory.Executable:
        if (this.env.platform === 'linux') {
          result = absoluteEnv(this.env.env, 'XDG_BIN_HOME') ?? this.homeJoin('.local/bin');
        } else {
          result = null;
        }
        break;
      case BaseDirectory.Font:
        if (this.env.platform === 'darwin') result = this.homeJoin('Library/Fonts');
        else if (this.env.platform === 'linux') {
          const data = this.dataDir();
          result = data === null ? null : posixJoin(data, 'fonts');
        } else result = null;
        break;
      case BaseDirectory.Home:
        result = this.home();
        break;
      case BaseDirectory.Runtime:
        result = this.env.platform === 'linux' ? absoluteEnv(this.env.env, 'XDG_RUNTIME_DIR') : null;
        break;
      case BaseDirectory.Template:
        result = this.userDir(null, 'templates', 'TEMPLATES');
        break;
      default:
        throw new TypeError(`invalid base directory ${directory}`);
    }
    if (result === null) throw new UnknownPathError();
    return result;
  }

  /**
   * tauri `resolve_path(directory, Some(path))`：`Resource` 目录按打包器规则把 `..` 映射为 `_up_`、
   * 根映射为 `_root_`；其余直接 `push`（绝对路径会替换基准目录，与 `PathBuf::push` 相同）。
   */
  resolve(directory: number, path: string | null): string {
    const base = this.resolveDirectory(directory);
    if (path === null) return base;
    if (directory === BaseDirectory.Resource) {
      const parts: string[] = [];
      const isWin = this.env.platform === 'win32';
      const normalized = isWin ? path.replace(/\//g, '\\') : path;
      const sep = isWin ? '\\' : '/';
      const rooted = isWin ? /^(?:[A-Za-z]:)?\\/.test(normalized) : normalized.startsWith('/');
      if (rooted) parts.push('_root_');
      for (const comp of normalized.replace(/^[A-Za-z]:/, '').split(sep)) {
        if (comp === '' || comp === '.') continue;
        parts.push(comp === '..' ? '_up_' : comp);
      }
      return this.join(base, ...parts);
    }
    return pushPath(this.env.platform, base, path);
  }

  /** tauri `BaseDirectory::parse`：首段是 `$VAR` 时替换，`..` 段被丢弃。 */
  parseVariablePath(pattern: string): string {
    const isWin = this.env.platform === 'win32';
    const sepRe = isWin ? /[\\/]/ : /\//;
    const segments = pattern.split(sepRe);
    const first = segments[0] ?? '';
    let out: string;
    let rest: string[];
    const variable = BASE_DIRECTORY_VARIABLES[first];
    if (variable !== undefined) {
      out = this.resolveDirectory(variable);
      rest = segments.slice(1);
    } else if (first === '') {
      out = isWin ? '\\' : '/';
      rest = segments.slice(1);
    } else {
      out = first;
      rest = segments.slice(1);
    }
    for (const seg of rest) {
      if (seg === '' || seg === '.' || seg === '..') continue;
      out = pushPath(this.env.platform, out, seg);
    }
    return out;
  }
}

/** `PathBuf::push` 语义：push 绝对路径时替换。 */
export function pushPath(platform: ShellPlatform, base: string, segment: string): string {
  if (platform === 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(segment) || segment.startsWith('\\\\')) return segment;
    return winJoin(base, segment);
  }
  if (segment.startsWith('/')) return segment;
  if (segment === '') return base.endsWith('/') ? base : `${base}/`;
  const sep = base.endsWith('/') ? '' : '/';
  return `${base}${sep}${segment}`;
}
