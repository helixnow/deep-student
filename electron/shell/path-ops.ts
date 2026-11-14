/**
 * `plugin:path|*` 中不依赖目录解析的纯函数，逐行对应 tauri-2.11.5 `src/path/plugin.rs`
 * （`normalize_path` / `normalize_path_no_absolute` / `join` / `normalize` / `dirname` / `extname` /
 * `basename` / `is_absolute` / `resolve`）与 Rust `std::path::Path` 的组件语义。
 */
import type { ShellPlatform } from './tauri-config.ts';

type Component =
  | { kind: 'prefix'; text: string }
  | { kind: 'root' }
  | { kind: 'cur' }
  | { kind: 'parent' }
  | { kind: 'normal'; text: string };

export const NO_PARENT = 'path does not have a parent';
export const NO_EXTENSION = 'path does not have an extension';
export const NO_BASENAME = 'path does not have a basename';

function isSep(c: string, platform: ShellPlatform): boolean {
  return c === '/' || (platform === 'win32' && c === '\\');
}

/** Rust `Path::components()`。 */
export function components(path: string, platform: ShellPlatform): Component[] {
  const out: Component[] = [];
  let rest = path;
  if (platform === 'win32') {
    const m = /^(\\\\\?\\[A-Za-z]:|\\\\\?\\UNC\\[^\\]+\\[^\\]+|\\\\\?\\[^\\]+|\\\\\.\\[^\\]+|\\\\[^\\/]+[\\/][^\\/]+|[A-Za-z]:)/.exec(rest);
    if (m) {
      out.push({ kind: 'prefix', text: m[0] });
      rest = rest.slice(m[0].length);
    }
  }
  if (rest.length > 0 && isSep(rest[0] as string, platform)) {
    out.push({ kind: 'root' });
  }
  const parts = rest.split(platform === 'win32' ? /[\\/]/ : /\//);
  let first = true;
  for (const part of parts) {
    if (part === '') {
      first = false;
      continue;
    }
    if (part === '.') {
      // Rust 只在相对路径开头保留 CurDir。
      if (first && out.length === 0) out.push({ kind: 'cur' });
    } else if (part === '..') {
      out.push({ kind: 'parent' });
    } else {
      out.push({ kind: 'normal', text: part });
    }
    first = false;
  }
  return out;
}

function mainSep(platform: ShellPlatform): string {
  return platform === 'win32' ? '\\' : '/';
}

/** 简化版 PathBuf：只实现 push/pop/字符串化，足以复现 plugin.rs 的两个 normalize。 */
class PathBuf {
  text: string;
  private readonly platform: ShellPlatform;
  constructor(text: string, platform: ShellPlatform) {
    this.text = text;
    this.platform = platform;
  }
  private hasRoot(s: string): boolean {
    const comps = components(s, this.platform);
    return comps.some((c) => c.kind === 'root');
  }
  push(segment: string): void {
    const sep = mainSep(this.platform);
    const segComps = components(segment, this.platform);
    const segAbsolute = this.platform === 'win32'
      ? segComps[0]?.kind === 'prefix' && segComps[1]?.kind === 'root'
      : segComps[0]?.kind === 'root';
    if (segAbsolute) {
      this.text = segment;
      return;
    }
    if (this.platform === 'win32' && segComps[0]?.kind === 'root') {
      const prefix = components(this.text, this.platform)[0];
      this.text = prefix?.kind === 'prefix' ? `${prefix.text}${segment}` : segment;
      return;
    }
    if (this.text === '' || this.text.endsWith(sep) || (this.platform === 'win32' && this.text.endsWith('/'))) {
      this.text += segment;
    } else if (this.platform === 'win32' && /^[A-Za-z]:$/.test(this.text)) {
      this.text += segment;
    } else {
      this.text += sep + segment;
    }
  }
  pop(): boolean {
    const comps = components(this.text, this.platform);
    const last = comps[comps.length - 1];
    if (!last || last.kind === 'root' || last.kind === 'prefix') return false;
    const kept = comps.slice(0, -1);
    this.text = render(kept, this.platform);
    return true;
  }
  get rooted(): boolean {
    return this.hasRoot(this.text);
  }
}

function render(comps: Component[], platform: ShellPlatform): string {
  const sep = mainSep(platform);
  let out = '';
  let needSep = false;
  for (const c of comps) {
    switch (c.kind) {
      case 'prefix':
        out += c.text;
        break;
      case 'root':
        out += sep;
        needSep = false;
        continue;
      case 'cur':
        if (needSep) out += sep;
        out += '.';
        break;
      case 'parent':
        if (needSep) out += sep;
        out += '..';
        break;
      case 'normal':
        if (needSep) out += sep;
        out += c.text;
        break;
    }
    needSep = c.kind !== 'prefix';
  }
  return out;
}

/** dunce::simplified：去掉 Windows `\\?\` 前缀（仅当结果仍是合法普通路径）。 */
function simplified(path: string, platform: ShellPlatform): string {
  if (platform === 'win32' && /^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
  return path;
}

function normalizePath(path: string, platform: ShellPlatform): string {
  const comps = components(path, platform);
  let start = 0;
  const ret = new PathBuf('', platform);
  if (comps[0]?.kind === 'prefix') {
    ret.text = comps[0].text;
    start = 1;
  }
  for (const c of comps.slice(start)) {
    if (c.kind === 'root') ret.push(mainSep(platform));
    else if (c.kind === 'parent') ret.pop();
    else if (c.kind === 'normal') ret.push(c.text);
  }
  return ret.text;
}

function normalizePathNoAbsolute(path: string, platform: ShellPlatform): string {
  const comps = components(path, platform);
  let start = 0;
  const ret = new PathBuf('', platform);
  if (comps[0]?.kind === 'prefix') {
    ret.text = comps[0].text;
    start = 1;
  }
  const sep = mainSep(platform);
  for (const c of comps.slice(start)) {
    if (c.kind === 'root') ret.push(sep);
    else if (c.kind === 'parent') ret.pop();
    else if (c.kind === 'normal') {
      let p = ret.text;
      if (p !== '' && !p.endsWith('/') && !p.endsWith('\\')) p += sep;
      p += c.text;
      ret.text = p;
    }
  }
  return ret.text;
}

export function join(paths: string[], platform: ShellPlatform): string {
  const sep = mainSep(platform);
  const joined = paths
    .map((p) => (p !== '' && !p.endsWith('/') && !p.endsWith('\\') ? p + sep : p))
    .join('');
  const p = simplified(normalizePathNoAbsolute(joined, platform), platform);
  return p === '' ? '.' : p;
}

export function normalize(path: string, platform: ShellPlatform): string {
  let p = simplified(normalizePathNoAbsolute(path, platform), platform);
  if (p === '' && path === '..') return '..';
  if (p === '' && path === '.') return '.';
  // 原实现条件 `!p.ends_with('/') || !p.ends_with('\\')` 恒为真：只要输入以分隔符结尾就追加。
  if (path.endsWith('/') || path.endsWith('\\')) p += mainSep(platform);
  return p;
}

export function resolve(paths: string[], cwd: string, platform: ShellPlatform): string {
  const buf = new PathBuf(cwd, platform);
  for (const p of paths) buf.push(p);
  return simplified(normalizePath(buf.text, platform), platform);
}

/** Rust `Path::file_name()`。 */
export function fileName(path: string, platform: ShellPlatform): string | null {
  const comps = components(path, platform);
  const last = comps[comps.length - 1];
  return last && last.kind === 'normal' ? last.text : null;
}

/** Rust `Path::parent()`。 */
export function parent(path: string, platform: ShellPlatform): string | null {
  const comps = components(path, platform);
  const last = comps[comps.length - 1];
  if (!last || last.kind === 'root' || last.kind === 'prefix') return null;
  return render(comps.slice(0, -1), platform);
}

export function dirname(path: string, platform: ShellPlatform): string {
  const p = parent(path, platform);
  if (p === null) throw new Error(NO_PARENT);
  return simplified(p, platform);
}

export function extname(path: string, platform: ShellPlatform): string {
  const name = fileName(path, platform);
  if (name === null) throw new Error(NO_EXTENSION);
  if (name === '..') throw new Error(NO_EXTENSION);
  const idx = name.lastIndexOf('.');
  if (idx <= 0) throw new Error(NO_EXTENSION);
  return name.slice(idx + 1);
}

export function basename(path: string, ext: string | null, platform: ShellPlatform): string {
  const name = fileName(path, platform);
  if (name === null) throw new Error(NO_BASENAME);
  if (ext !== null && name.endsWith(ext)) return name.slice(0, name.length - ext.length);
  return name;
}

export function isAbsolute(path: string, platform: ShellPlatform): boolean {
  const comps = components(path, platform);
  if (platform === 'win32') {
    const first = comps[0];
    if (first?.kind !== 'prefix') return false;
    if (first.text.startsWith('\\\\')) return true;
    return comps[1]?.kind === 'root';
  }
  return comps[0]?.kind === 'root';
}
