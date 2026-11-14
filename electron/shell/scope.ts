/**
 * Tauri 文件系统作用域（tauri-2.11.5 `src/scope/fs.rs`）的移植：asset 协议与 fs 插件共用此实现。
 *
 * - 模式先按路径组件重组（`components().collect()`），再额外加入"规范化父目录"版本
 *   （`canonicalize_parent`：对不存在的 glob 路径逐级上溯 canonicalize，再拼回剩余部分）。
 * - Windows 上 `\\?\C:\` 形式的模式额外加入去前缀版本。
 * - `is_allowed`：先解析符号链接并 canonicalize（路径不存在则原样），先查 deny，再查 allow。
 * - macOS / Windows 上 deny 另按 {@link foldForDeny} 不区分大小写匹配（RF-W23-fs-deny-case-insensitive）；allow 仍逐字比较。
 * - Windows 上 deny 另按 {@link stripNtfsStreams} 去掉流后缀、按 {@link trimWin32Trailing} 去掉组件末尾的点和空格后匹配
 *   （RF-W23-fs-deny-ntfs-stream-suffix）。
 */
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { GlobPattern, GlobPatternError, type MatchOptions } from './glob.ts';
import { UnknownPathError, type PathResolver } from './paths.ts';
import type { ShellPlatform } from './tauri-config.ts';

/**
 * 作用域条目里代表 Electron userData（`app.getPath('userData')`：应用窗口的 Chromium 配置，含 cookie、localStorage、
 * IndexedDB 与缓存）的变量，Tauri 的 `BaseDirectory` 没有对应项。只接受 `$ELECTRON_USERDATA/**`，表示该目录本身及其下
 * 全部内容；目录按字面路径匹配，不当作 glob。
 */
// RUST-FIX(RF-W23-fs-deny-webview-data-user-data): Rust 的 deny-default 不 deny 任何目录；Electron 的 WebView 数据在 userData，用此变量 deny。
export const ELECTRON_USER_DATA_VARIABLE = '$ELECTRON_USERDATA';

/** 以 {@link ELECTRON_USER_DATA_VARIABLE} 开头的条目返回 true；写法不受支持时抛错（deny 条目不能被静默丢弃）。 */
function isUserDataPattern(pattern: string, platform: ShellPlatform): boolean {
  const [first, ...rest] = pattern.split(platform === 'win32' ? /[\\/]/ : /\//);
  if (first !== ELECTRON_USER_DATA_VARIABLE) return false;
  const tail = rest.filter((segment) => segment !== '' && segment !== '.');
  if (tail.length !== 1 || tail[0] !== '**') throw new Error(`unsupported scope pattern ${JSON.stringify(pattern)}: only ${ELECTRON_USER_DATA_VARIABLE}/** is accepted`);
  return true;
}

/**
 * capability 中的路径模式（`$APPDATA/**` 等）展开后建成作用域。与 Tauri `Scope::new` 一致：
 * `manager.path().parse(path)` 失败（变量在本机无法解析）的条目被跳过；`$ELECTRON_USERDATA` 在 `userDataDir` 为 null
 * 时同样跳过。
 */
export function fsScopeFromPatterns(
  paths: PathResolver,
  platform: ShellPlatform,
  allow: readonly string[],
  deny: readonly string[],
  userDataDir: string | null = null,
): FsScope {
  const scope = new FsScope({ platform });
  const expand = (pattern: string) => {
    try {
      return paths.parseVariablePath(pattern);
    } catch (error) {
      if (error instanceof UnknownPathError) return null;
      throw error;
    }
  };
  for (const pattern of allow) {
    if (isUserDataPattern(pattern, platform)) {
      if (userDataDir !== null) scope.allowDirectory(userDataDir, true);
      continue;
    }
    const expanded = expand(pattern);
    if (expanded !== null) scope.allowPattern(expanded);
  }
  for (const pattern of deny) {
    if (isUserDataPattern(pattern, platform)) {
      if (userDataDir !== null) scope.forbidDirectory(userDataDir, true);
      continue;
    }
    const expanded = expand(pattern);
    if (expanded !== null) scope.forbidPattern(expanded);
  }
  return scope;
}

/** Rust `Path::components().collect::<PathBuf>()` 的效果：去掉 `.`、重复分隔符与结尾分隔符。 */
export function collectComponents(path: string, platform: ShellPlatform): string {
  if (platform === 'win32') {
    const p = path.replace(/\//g, '\\');
    const verbatim = p.startsWith('\\\\?\\') ? '\\\\?\\' : '';
    const body = verbatim ? p.slice(4) : p;
    const prefixMatch = (verbatim ? /^(?:UNC\\[^\\]+\\[^\\]+|[A-Za-z]:|[^\\]+)/ : /^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)/).exec(body);
    const prefix = prefixMatch ? prefixMatch[0] : '';
    const rest = body.slice(prefix.length);
    const rooted = rest.startsWith('\\');
    const parts = rest.split('\\').filter((s) => s !== '' && s !== '.');
    return `${verbatim}${prefix}${rooted ? '\\' : ''}${parts.join('\\')}`;
  }
  const rooted = path.startsWith('/');
  const parts = path.split('/').filter((s, i) => s !== '' && !(s === '.' && i > 0));
  const joined = parts.join('/');
  return rooted ? `/${joined}` : joined;
}

/** 作用域判定用到的文件系统操作；出错时抛带 `code` 的 Error（与 node:fs 相同）。 */
export interface ScopeFileSystem {
  isSymbolicLink(path: string): boolean;
  readlink(path: string): string;
  exists(path: string): boolean;
  /** `fs.realpathSync.native` 语义：Windows 上 libuv 去掉 `GetFinalPathNameByHandleW` 结果的 `\\?\` / `\\?\UNC\` 前缀。 */
  realpath(path: string): string;
}

const NODE_SCOPE_FS: ScopeFileSystem = {
  isSymbolicLink: (path) => lstatSync(path).isSymbolicLink(),
  readlink: (path) => readlinkSync(path),
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync.native(path),
};

/**
 * Rust `fs::canonicalize`：Windows 上是 `GetFinalPathNameByHandleW` 的原样结果（`\\?\C:\…`、`\\?\UNC\server\share\…`），
 * 作用域模式与待判定路径都用这个形态比较；把 libuv 去掉的前缀补回来。
 */
function canonicalize(path: string, platform: ShellPlatform, fs: ScopeFileSystem): string {
  const real = fs.realpath(path);
  if (platform !== 'win32' || real.startsWith('\\\\?\\')) return real;
  if (/^[A-Za-z]:\\/.test(real)) return `\\\\?\\${real}`;
  if (real.startsWith('\\\\') && !real.startsWith('\\\\.\\')) return `\\\\?\\UNC\\${real.slice(2)}`;
  return real;
}

function canonicalizeParent(path: string, platform: ShellPlatform, fs: ScopeFileSystem): string | null {
  const lib = platform === 'win32' ? win32 : posix;
  let current = path;
  let failed: string | null = null;
  for (;;) {
    try {
      const real = canonicalize(current, platform, fs);
      return failed === null ? real : lib.join(real, failed);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error)) throw error;
    }
    const base = lib.basename(current);
    if (base === '') return null;
    const parent = lib.dirname(current);
    if (parent === current) return null;
    failed = failed === null ? base : lib.join(base, failed);
    current = parent;
  }
}

/**
 * deny 在 macOS / Windows 上比较用的折叠形态：NFD 后逐字符 lower → upper → lower，再 NFD。
 * APFS 按完整大小写折叠且不区分规范化形式（`Plugins`、`pluginſ`、`ß` / `ẞ` 与 `ss`、Kelvin 符号与 `k`、NFC 与 NFD
 * 都指向同一项，本机实测），NTFS 按大写表比较；两者认为同名的写法折叠后都相同。只用于 deny，折得更粗只会多拒。
 * glob 元字符与分隔符不受影响。
 */
export function foldForDeny(s: string): string {
  let out = '';
  for (const c of s.normalize('NFD')) out += c.toLowerCase().toUpperCase().toLowerCase();
  return out.normalize('NFD');
}

/**
 * Windows：去掉根之后每个组件里从 `:` 起的 NTFS 流部分。`plugins::$INDEX_ALLOCATION` 打开的就是目录 `plugins`，
 * `plugins:x` 是它的流；Windows 文件名里不可能有 `:`，所以只用于 deny 时不会误伤。根（`C:\`、`\\?\C:\`、UNC）不动。
 */
export function stripNtfsStreams(path: string): string {
  const root = win32.parse(path).root;
  return root + path.slice(root.length).replace(/:[^\\/]*/g, '');
}

/**
 * Windows：去掉根之后每个组件末尾的 `.` 和空格，去掉后为空的组件一并丢弃。`\\.\` 设备路径 Node 不加 `\\?\`，交给系统时
 * 由 Win32 规范化去掉它们（`\\.\C:\…\plugins.`、`…\plugins ` 打开的就是 `plugins`）。Win32 只对最后一个组件去掉全部、
 * 对中间组件去掉一个尾点；这里每个组件都去掉全部，只用于 deny，多拒不少拒。根不动。
 */
export function trimWin32Trailing(path: string): string {
  const root = win32.parse(path).root;
  return collectComponents(root + path.slice(root.length).replace(/[. ]+(?=[\\/]|$)/g, ''), 'win32');
}

/**
 * glob 模式 `pattern` 能否匹配 `path` 之下的某个路径（不含 `path` 本身）。按组件比较：`path` 的每个组件依次按单组件 glob
 * 匹配模式的对应组件（`*` 只在一个组件内），遇到 `**`、或 `path` 的组件用完而模式还有组件时为 true。不再检查剩余组件能否
 * 真的匹配某个名字；字符类跨分隔符、拆开后不成模式的组件也算匹配。只会多判。
 */
export function mayMatchBelow(pattern: string, path: string, platform: ShellPlatform, options: MatchOptions): boolean {
  const separators = platform === 'win32' ? /[\\/]/ : /\//;
  const want = pattern.split(separators);
  const have = path.split(separators);
  if (have.length > 0 && have[have.length - 1] === '') have.pop();
  for (let i = 0; i < want.length; i++) {
    const component = want[i] as string;
    if (component === '**') return true;
    if (i >= have.length) return true;
    let glob: GlobPattern;
    try {
      glob = new GlobPattern(component, platform === 'win32');
    } catch (error) {
      if (error instanceof GlobPatternError) continue;
      throw error;
    }
    if (!glob.matches(have[i] as string, options)) return false;
  }
  return false;
}

export interface ScopeOptions {
  platform: ShellPlatform;
  /** 未显式配置时 Unix 为 true、Windows 为 false。 */
  requireLiteralLeadingDot?: boolean;
  fs?: ScopeFileSystem;
}

export class FsScope {
  private readonly allowed = new Map<string, GlobPattern>();
  private readonly forbidden = new Map<string, GlobPattern>();
  /** macOS / Windows：{@link forbidden} 各模式的 {@link foldForDeny} 形态；Linux 为 null。 */
  private readonly forbiddenFolded: Map<string, GlobPattern> | null;
  private readonly platform: ShellPlatform;
  private readonly fs: ScopeFileSystem;
  readonly matchOptions: MatchOptions;

  constructor(options: ScopeOptions) {
    this.platform = options.platform;
    this.fs = options.fs ?? NODE_SCOPE_FS;
    this.forbiddenFolded = options.platform === 'linux' ? null : new Map();
    this.matchOptions = {
      requireLiteralSeparator: true,
      requireLiteralLeadingDot: options.requireLiteralLeadingDot ?? options.platform !== 'win32',
      windows: options.platform === 'win32',
    };
  }

  private sep(): string {
    return this.platform === 'win32' ? '\\' : '/';
  }

  private push(list: Map<string, GlobPattern>, rawPath: string, make: (p: string) => string): void {
    const path = collectComponents(rawPath, this.platform);
    const windows = this.platform === 'win32';
    const add = (p: string) => {
      const source = make(p);
      if (!list.has(source)) list.set(source, new GlobPattern(source, windows));
      if (list === this.forbidden && this.forbiddenFolded !== null) {
        const folded = foldForDeny(source);
        if (!this.forbiddenFolded.has(folded)) this.forbiddenFolded.set(folded, new GlobPattern(folded, windows));
      }
    };
    add(path);
    if (this.platform === 'win32' && path.startsWith('\\\\?\\') && /^\\\\\?\\[A-Za-z]:/.test(path)) {
      add(path.slice(4));
    }
    const canonical = canonicalizeParent(path, this.platform, this.fs);
    if (canonical !== null) add(canonical);
  }

  /** 配置中的模式（已把 `$APPDATA` 等变量展开）：原样作为 glob。 */
  allowPattern(pattern: string): void {
    this.push(this.allowed, pattern, (p) => p);
  }

  forbidPattern(pattern: string): void {
    this.push(this.forbidden, pattern, (p) => p);
  }

  allowFile(path: string): void {
    this.push(this.allowed, path, (p) => GlobPattern.escape(p));
  }

  allowDirectory(path: string, recursive: boolean): void {
    this.push(this.allowed, path, (p) => GlobPattern.escape(p));
    this.push(this.allowed, path, (p) => this.escapedWith(p, recursive ? '**' : '*'));
  }

  forbidFile(path: string): void {
    this.push(this.forbidden, path, (p) => GlobPattern.escape(p));
  }

  forbidDirectory(path: string, recursive: boolean): void {
    this.push(this.forbidden, path, (p) => GlobPattern.escape(p));
    this.push(this.forbidden, path, (p) => this.escapedWith(p, recursive ? '**' : '*'));
  }

  private escapedWith(p: string, append: string): string {
    const sep = this.sep();
    return p.endsWith(sep) ? `${GlobPattern.escape(p)}${append}` : `${GlobPattern.escape(p)}${sep}${append}`;
  }

  private literalForm(path: string): string {
    // RUST-FIX(RF-W23-fs-scope-literal-win32-normalize): `\\.\\C:\…` 的前缀匹配不上，空段被丢掉后成了 `\C:\…`；Node 交给系统的是 `win32.normalize` 后的 `\\.\C:\…`。
    return collectComponents(this.platform === 'win32' ? win32.normalize(path) : path, this.platform);
  }

  /**
   * `canonical` 用于 allow 与 deny。`denyOnly` 只用于 deny：请求的字面形态、目录项本身的位置（父目录规范化后拼回最后一个
   * 组件；请求路径是符号链接时它与 `canonical` 不同），以及目标不存在时目标的字面形态。
   */
  private resolveForMatch(path: string): { canonical: string; denyOnly: string[] } | null {
    const lib = this.platform === 'win32' ? win32 : posix;
    const request = this.literalForm(path);
    // RUST-FIX(RF-W23-fs-deny-symlink-entry): Tauri 只用链接目标判定；受保护目录里指向 allow 区的链接能被改名覆盖、删除或经它写入。
    const denyOnly = [request];
    const parent = lib.dirname(request);
    if (parent !== request) {
      const parentCanonical = canonicalizeParent(parent, this.platform, this.fs);
      if (parentCanonical !== null) denyOnly.push(collectComponents(lib.join(parentCanonical, lib.basename(request)), this.platform));
    }
    let target = path;
    try {
      if (this.fs.isSymbolicLink(path)) {
        const link = this.fs.readlink(path);
        // RUST-FIX(RF-W23-fs-deny-symlink-entry): Rust 把相对链接目标交给 canonicalize，按进程 cwd 解析；系统按链接所在目录解析。
        target = lib.isAbsolute(link) ? link : lib.join(lib.dirname(path), link);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error)) throw error;
    }
    if (!this.fs.exists(target)) {
      const literal = this.literalForm(target);
      // RUST-FIX(RF-W23-fs-scope-missing-path-canonical-ancestor): Rust 对不存在的路径按字面匹配，大小写不敏感的文件系统上换个大小写、或经符号链接 / junction 的父目录，就能在 deny 目录里或作用域外新建文件。
      const viaAncestor = canonicalizeParent(literal, this.platform, this.fs);
      return { canonical: viaAncestor === null ? literal : collectComponents(viaAncestor, this.platform), denyOnly: [literal, ...denyOnly] };
    }
    try {
      return { canonical: collectComponents(canonicalize(target, this.platform, this.fs), this.platform), denyOnly };
    } catch (error) {
      if (error instanceof Error && 'code' in error) return null;
      throw error;
    }
  }

  private matchesAny(list: Map<string, GlobPattern>, path: string): boolean {
    for (const pattern of list.values()) if (pattern.matches(path, this.matchOptions)) return true;
    return false;
  }

  private reachesBelowAny(list: Map<string, GlobPattern>, path: string): boolean {
    for (const source of list.keys()) if (mayMatchBelow(source, path, this.platform, this.matchOptions)) return true;
    return false;
  }

  /** deny 比较的各个形态：规范形态与 `denyOnly`；Windows 上再加去掉流后缀、去掉组件末尾点和空格的形态。 */
  private denyCandidates(resolved: { canonical: string; denyOnly: string[] }): string[] {
    const paths = [...new Set([resolved.canonical, ...resolved.denyOnly])];
    // RUST-FIX(RF-W23-fs-deny-ntfs-stream-suffix): glob 逐字比较，`plugins::$INDEX_ALLOCATION`、`\\.\…\plugins.` 不匹配 `plugins`，但 NTFS / Win32 把它们解析成这个目录。
    if (this.platform === 'win32') {
      for (const path of [...paths]) {
        const stripped = stripNtfsStreams(path);
        if (stripped !== path) paths.push(stripped);
      }
      for (const path of [...paths]) {
        const trimmed = trimWin32Trailing(path);
        if (trimmed !== path) paths.push(trimmed);
      }
    }
    return paths;
  }

  private forbids(resolved: { canonical: string; denyOnly: string[] }): boolean {
    const folded = this.forbiddenFolded;
    // RUST-FIX(RF-W23-fs-deny-case-insensitive): Tauri 的 glob 区分大小写；APFS / NTFS 上另一种写法（`Plugins`、`pluginſ`）指向被 deny 的同一目录，目录还不存在或以另一种大小写建出时就能绕过 deny。
    return this.denyCandidates(resolved).some((path) => this.matchesAny(this.forbidden, path) || (folded !== null && this.matchesAny(folded, foldForDeny(path))));
  }

  isAllowed(path: string): boolean {
    const resolved = this.resolveForMatch(path);
    if (resolved === null) return false;
    if (this.forbids(resolved)) return false;
    return this.matchesAny(this.allowed, resolved.canonical);
  }

  isForbidden(path: string): boolean {
    const resolved = this.resolveForMatch(path);
    if (resolved === null) return true;
    return this.forbids(resolved);
  }

  /**
   * 有 deny 能匹配 `path` 之下的路径（不含 `path` 本身）。改名或递归删除 `path` 会连带搬走或删掉受保护的目录，
   * 改名到 `path` 能一次放进准备好的受保护目录；判定与 {@link isForbidden} 用同样的形态（含大小写折叠与 Windows 写法）。
   * RUST-FIX(RF-W23-fs-deny-protected-ancestor): Tauri 的作用域只判定请求路径本身，没有“之下有 deny”的判定。
   */
  forbidsBelow(path: string): boolean {
    const resolved = this.resolveForMatch(path);
    if (resolved === null) return true;
    const folded = this.forbiddenFolded;
    return this.denyCandidates(resolved).some((candidate) => this.reachesBelowAny(this.forbidden, candidate)
      || (folded !== null && this.reachesBelowAny(folded, foldForDeny(candidate))));
  }

  allowedPatterns(): string[] {
    return [...this.allowed.keys()];
  }
}
