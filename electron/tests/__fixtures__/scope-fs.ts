/**
 * 给 `FsScope` 注入的文件系统视图，在任意宿主上复现 Windows / Linux / macOS 的路径语义：
 * - Windows：大小写不敏感；`/` 与 `\` 等价；`..` 按字面消解；8.3 短名、subst 盘经 `aliases` 映射到长名；
 *   `realpath` 返回 libuv 形态（`GetFinalPathNameByHandleW` 结果去掉 `\\?\` / `\\?\UNC\`），共享根带结尾 `\`。
 *   `\\.\C:\…`、`\\.\UNC\…` 设备路径（Node 不给它们加 `\\?\`）按 Win32 规范化：中间组件去掉一个尾点，
 *   最后一个组件（路径不以分隔符结尾时）去掉全部尾部点和空格。没有盘符的根路径 `\x` 按当前盘 `C:\x` 解析。
 * - Linux：大小写敏感。macOS：大小写不敏感。
 * `links` 是符号链接 / junction（链接路径 → 目标），`realpath` 穿过它们。
 */
import { posix, win32 } from 'node:path';
import type { ScopeFileSystem } from '../../shell/scope.ts';
import type { ShellPlatform } from '../../shell/tauri-config.ts';

export interface FakeScopeFsOptions {
  platform: ShellPlatform;
  /** 存在的文件与目录（真实大小写），祖先目录自动存在。 */
  entries: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  links?: Readonly<Record<string, string>>;
  /**
   * Windows 卷名 → 盘符（如 `Volume{…}` 或 `GLOBALROOT\Device\HarddiskVolume3` → `C:`）：`\\.\<卷名>\…` 与 `\\?\<卷名>\…`
   * 分别按 `\\.\C:\…`、`\\?\C:\…` 解析，realpath 照常给出 `C:\…`（libuv 取 `GetFinalPathNameByHandleW` 的 DOS 形态）。
   */
  volumes?: Readonly<Record<string, string>>;
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

function win32DevicePath(path: string): string {
  const body = path.slice(4);
  const s = /^UNC\\/i.test(body) ? `\\\\${body.slice(4)}` : body;
  const root = win32.parse(s).root;
  const segments = s.slice(root.length).split('\\');
  const last = segments.length - 1;
  return root + segments.map((seg, i) => (/^\.+$/.test(seg) ? seg : i === last ? seg.replace(/[. ]+$/, '') : seg.replace(/\.$/, ''))).join('\\');
}

export function fakeScopeFs(options: FakeScopeFsOptions): ScopeFileSystem {
  const windows = options.platform === 'win32';
  const lib = windows ? win32 : posix;
  const fold = (s: string) => (options.platform === 'linux' ? s : s.toLowerCase());

  const normalize = (path: string): string => {
    let s = path;
    if (windows) {
      s = s.replace(/\//g, '\\');
      for (const [volume, drive] of Object.entries(options.volumes ?? {})) {
        const prefix = s.slice(0, 4);
        if ((prefix === '\\\\.\\' || prefix === '\\\\?\\') && s.slice(4).toLowerCase().startsWith(volume.toLowerCase())
          && (s.length === 4 + volume.length || s[4 + volume.length] === '\\')) {
          s = `${prefix}${drive}${s.slice(4 + volume.length) || '\\'}`;
          break;
        }
      }
      if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
      else if (s.startsWith('\\\\?\\')) s = s.slice(4);
      else {
        // Node 交给系统的写法（`toNamespacedPath` 之前的 `path.resolve`）：合并重复分隔符、求值 `.` 段。
        s = win32.normalize(s);
        if (/^\\\\\.\\(?:[A-Za-z]:|UNC\\)/i.test(s)) s = win32DevicePath(s);
        else if (/^\\(?!\\)/.test(s)) s = `C:${s}`;
      }
    }
    s = lib.normalize(s);
    if (lib.parse(s).root !== s && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1);
    return s;
  };
  const replacePrefix = (path: string, map: Readonly<Record<string, string>>): string => {
    for (const [from, to] of Object.entries(map)) {
      const key = normalize(from);
      if (fold(path) === fold(key)) return normalize(to);
      if (fold(path).startsWith(fold(key.endsWith(lib.sep) ? key : key + lib.sep))) {
        return normalize(lib.join(to, path.slice(key.length)));
      }
    }
    return path;
  };

  const known = new Map<string, string>();
  for (const entry of options.entries) {
    let current = normalize(entry);
    for (;;) {
      known.set(fold(current), current);
      const parent = lib.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const linkKeys = new Map(Object.entries(options.links ?? {}).map(([from, to]) => [fold(normalize(from)), to]));

  const resolve = (path: string): string | null => {
    let current = normalize(path);
    for (let hops = 0; hops < 16; hops++) {
      const next = replacePrefix(replacePrefix(current, options.aliases ?? {}), options.links ?? {});
      if (next === current) break;
      current = next;
    }
    return known.get(fold(current)) ?? null;
  };

  return {
    isSymbolicLink: (path) => linkKeys.has(fold(normalize(path))),
    readlink: (path) => {
      const target = linkKeys.get(fold(normalize(path)));
      if (target === undefined) throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: 'EINVAL' });
      return target;
    },
    exists: (path) => resolve(path) !== null,
    realpath: (path) => {
      const real = resolve(path);
      if (real === null) throw enoent(path);
      return real;
    },
  };
}
