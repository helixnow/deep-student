/**
 * 可移植的路径解析与包含判断（纯函数，不依赖 `node:path`，桌面与移动端共用）。
 *
 * 规则参照 Rust `Path::components` / `Path::starts_with` 与 W07 在
 * `vfs-repos/repository/attachment-utils.ts` 的 `rustComponents` / `isInside`：
 * 按组件比较（`/a/bc` 不在 `/a/b` 内），分隔符折叠，`.` 丢弃；另外这里对 `..` 做词法消解，
 * 消解后再判断包含关系（`/root/a/../../etc` → `/etc`，不在 `/root` 内）。
 *
 * Windows（`win32`）：
 * - 只接受 `X:\` 盘符根和 `\\server\share\` UNC 根；`\\?\X:\`、`\\?\UNC\…` 去掉前缀后同等处理；
 *   `\\.\` 设备路径、`C:foo`（盘符相对）、`\foo`（根相对）不是绝对路径；
 * - 比较大小写不敏感（NTFS 默认）；
 * - 拒绝 Win32 会悄悄改写或指向设备的组件：含 `:`（备用数据流）、`<>"|?*` 与控制字符、
 *   以 `.` 或空格结尾、`CON`/`NUL`/`COM1` 等保留设备名。
 */
import type { FileRoot, PathFlavor } from './api.ts';

export interface ParsedPath {
  /** POSIX 为 `/`；Windows 为 `C:\` 或 `\\server\share\`。 */
  readonly root: string;
  /** 规范化后的组件（无 `.`、`..`、空串）。 */
  readonly parts: readonly string[];
}

export type PathProblem =
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'escape'; readonly reason: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

export function separator(flavor: PathFlavor): '/' | '\\' {
  return flavor === 'win32' ? '\\' : '/';
}

function splitParts(rest: string, flavor: PathFlavor): string[] {
  return rest.split(flavor === 'win32' ? /[\\/]+/ : /\/+/).filter((part) => part !== '');
}

/** 单个组件是否合法；返回问题描述或 null。 */
export function componentProblem(part: string, flavor: PathFlavor): string | null {
  if (part.includes('\u0000')) return 'path contains a NUL character';
  if (flavor !== 'win32' || part === '.' || part === '..') return null;
  if (WINDOWS_FORBIDDEN_CHARS.test(part)) return `component ${JSON.stringify(part)} contains a character Windows does not allow in file names`;
  if (part.endsWith('.') || part.endsWith(' ')) return `component ${JSON.stringify(part)} ends with a dot or space, which Windows strips`;
  if (WINDOWS_RESERVED.test(part)) return `component ${JSON.stringify(part)} is a reserved Windows device name`;
  return null;
}

/** 词法消解 `.` / `..`；`..` 越过起点时返回 null（调用方据此判越界）。 */
function resolveDots(parts: readonly string[], flavor: PathFlavor, clampAtRoot: boolean): { parts: string[]; problem: PathProblem | null } {
  const out: string[] = [];
  for (const part of parts) {
    const problem = componentProblem(part, flavor);
    if (problem !== null) return { parts: out, problem: { kind: 'invalid', reason: problem } };
    if (part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      else if (!clampAtRoot) return { parts: out, problem: { kind: 'escape', reason: '".." climbs above the scope root' } };
      continue;
    }
    out.push(part);
  }
  return { parts: out, problem: null };
}

function windowsRoot(path: string): { root: string; rest: string } | null {
  let value = path;
  if (/^[\\/]{2}\?[\\/]/.test(value)) {
    value = value.slice(4);
    if (/^UNC[\\/]/i.test(value)) value = `\\\\${value.slice(4)}`;
  } else if (/^[\\/]{2}\.[\\/]/.test(value)) {
    return null;
  }
  const drive = /^([A-Za-z]):[\\/]/.exec(value);
  if (drive) return { root: `${drive[1]!.toUpperCase()}:\\`, rest: value.slice(3) };
  const unc = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(value);
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}\\`, rest: value.slice(unc[0].length) };
  return null;
}

/**
 * 解析绝对路径并词法规范化。不是绝对路径返回 `{ problem: invalid }`；`..` 在根上停住（同 `path.resolve`）。
 */
export function parseAbsolute(path: string, flavor: PathFlavor): { parsed: ParsedPath | null; problem: PathProblem | null } {
  if (path.includes('\u0000')) return { parsed: null, problem: { kind: 'invalid', reason: 'path contains a NUL character' } };
  let root: string;
  let rest: string;
  if (flavor === 'win32') {
    const found = windowsRoot(path);
    if (found === null) return { parsed: null, problem: { kind: 'invalid', reason: `not an absolute Windows path: ${JSON.stringify(path)}` } };
    ({ root, rest } = found);
  } else {
    if (!path.startsWith('/')) return { parsed: null, problem: { kind: 'invalid', reason: `not an absolute path: ${JSON.stringify(path)}` } };
    root = '/';
    rest = path;
  }
  const { parts, problem } = resolveDots(splitParts(rest, flavor), flavor, true);
  if (problem !== null) return { parsed: null, problem };
  return { parsed: { root, parts }, problem: null };
}

/**
 * 解析作用域内的相对路径（可能来自不可信输入）。绝对路径、盘符、NUL、非法组件为 `invalid`；
 * `..` 越出作用域根为 `escape`。`''` 与 `.` 表示作用域根本身。
 */
export function parseRelative(relativePath: string, flavor: PathFlavor): { parts: readonly string[] | null; problem: PathProblem | null } {
  if (relativePath.includes('\u0000')) return { parts: null, problem: { kind: 'invalid', reason: 'path contains a NUL character' } };
  const absolute = flavor === 'win32' ? /^([\\/]|[A-Za-z]:)/.test(relativePath) : relativePath.startsWith('/');
  if (absolute) return { parts: null, problem: { kind: 'invalid', reason: `expected a relative path, got ${JSON.stringify(relativePath)}` } };
  const { parts, problem } = resolveDots(splitParts(relativePath, flavor), flavor, false);
  return problem === null ? { parts, problem: null } : { parts: null, problem };
}

export function formatPath(parsed: ParsedPath, flavor: PathFlavor): string {
  if (parsed.parts.length === 0) return parsed.root;
  return parsed.root + parsed.parts.join(separator(flavor));
}

function key(part: string, flavor: PathFlavor): string {
  return flavor === 'win32' ? part.toLowerCase() : part;
}

/** `child` 是否等于或位于 `parent` 之内（按组件；Windows 不区分大小写）。 */
export function isWithin(child: ParsedPath, parent: ParsedPath, flavor: PathFlavor): boolean {
  if (key(child.root, flavor) !== key(parent.root, flavor)) return false;
  if (parent.parts.length > child.parts.length) return false;
  return parent.parts.every((part, index) => key(part, flavor) === key(child.parts[index]!, flavor));
}

export function samePath(a: ParsedPath, b: ParsedPath, flavor: PathFlavor): boolean {
  return a.parts.length === b.parts.length && isWithin(a, b, flavor);
}

/** 已知 `child` 在 `parent` 内时，返回以 `/` 分隔的相对路径（相同则为 `''`）。 */
export function relativePath(child: ParsedPath, parent: ParsedPath): string {
  return child.parts.slice(parent.parts.length).join('/');
}

export function childOf(parent: ParsedPath, ...parts: readonly string[]): ParsedPath {
  return { root: parent.root, parts: [...parent.parts, ...parts] };
}

export function parentOf(path: ParsedPath): ParsedPath | null {
  return path.parts.length === 0 ? null : { root: path.root, parts: path.parts.slice(0, -1) };
}

/** `FilesService.backupRoot` 的缺省值：`appData` 根下的 `recovery/backups`；没有 `appData` 根时为 null。 */
export function defaultBackupRoot(roots: readonly FileRoot[], flavor: PathFlavor): string | null {
  const appData = roots.find((root) => root.name === 'appData');
  const parsed = appData ? parseAbsolute(appData.path, flavor).parsed : null;
  return parsed ? formatPath(childOf(parsed, 'recovery', 'backups'), flavor) : null;
}
