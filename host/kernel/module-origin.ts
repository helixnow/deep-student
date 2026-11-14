/**
 * 插件模块的来源判定与路径换算：应用内（`host/`、`electron/`）的模块是官方内置插件，其余（用户 profile
 * 指向的包目录、`examples/`）是社区插件。按 URL 前缀比较；`file:` URL 与本地路径的互换按 Node
 * `url.fileURLToPath` / `url.pathToFileURL` 的规则实现，不依赖 Node 内建模块。路径风格（`windows`）默认取
 * 宿主进程自身：kernel 模块的 URL 带盘符时按 Windows 处理（与 `AppInfo.platform` 无关，测试常伪造后者）。
 */
import type { HostPluginOrigin } from './api.ts';

const HOST_ROOT = new URL('../', import.meta.url).href;
const APP_ROOTS: readonly string[] = [HOST_ROOT, new URL('../../electron/', import.meta.url).href];

/** 宿主进程的路径风格。 */
export const WINDOWS_PATHS = /^file:\/\/\/[A-Za-z]:\//.test(import.meta.url);

function normalizeUrl(href: string): string | null {
  try {
    return new URL(href).href;
  } catch {
    // 不是绝对 URL（包名等）：调用方负责先解析。
    return null;
  }
}

/** Windows 盘符大小写不敏感（`file:///c:/` 与 `file:///C:/` 同一处）；路径其余部分仍按原样比较。 */
function foldDrive(href: string, windows: boolean): string {
  return windows ? href.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => `file:///${drive.toLowerCase()}:`) : href;
}

/** 模块 URL 是否等于或位于某个根目录 URL（以 `/` 结尾）之下。 */
export function urlUnderRoots(href: string, roots: readonly string[], windows: boolean = WINDOWS_PATHS): boolean {
  const normalized = normalizeUrl(href);
  if (normalized === null) return false;
  const target = foldDrive(normalized, windows);
  return roots.some(root => {
    const folded = foldDrive(root, windows);
    return target === folded || target.startsWith(folded);
  });
}

/** 模块 URL（`file:` 等绝对 URL）是否位于应用内。 */
export function isAppModuleUrl(href: string): boolean {
  return urlUnderRoots(href, APP_ROOTS);
}

/** 模块 URL 是否位于 `host/` 内（v1 UI 清单只排除这些模块）。 */
export function isHostModuleUrl(href: string): boolean {
  return urlUnderRoots(href, [HOST_ROOT]);
}

/** 模块 URL 的来源；`null` 表示进程内直接安装、没有模块来源（视为内置）。 */
export function moduleOrigin(href: string | null): HostPluginOrigin {
  return href === null || isAppModuleUrl(href) ? 'builtin' : 'community';
}

/** 同 Node `path.isAbsolute`（posix / win32）。 */
export function isAbsolutePath(path: string, windows: boolean = WINDOWS_PATHS): boolean {
  if (!windows) return path.startsWith('/');
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** 路径中会被 URL 解析器当成语法的字符先转义（同 Node `pathToFileURL`）。 */
function encodePathChars(path: string, windows: boolean): string {
  let out = path.replace(/%/g, '%25');
  if (!windows) out = out.replace(/\\/g, '%5C');
  return out.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09').replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/** 同 Node `url.pathToFileURL(path, { windows }).href`；`path` 必须是绝对路径。 */
export function pathToFileHref(path: string, windows: boolean = WINDOWS_PATHS): string {
  if (!isAbsolutePath(path, windows)) throw new TypeError(`path must be absolute: ${path}`);
  if (!windows) return new URL(`file://${encodePathChars(path, false)}`).href;
  const slashed = path.replace(/\\/g, '/');
  const unc = /^\/\/([^/]+)(\/.*)?$/.exec(slashed);
  if (unc) return new URL(`file://${unc[1]}${encodePathChars(unc[2] ?? '/', true)}`).href;
  return new URL(`file:///${encodePathChars(slashed.replace(/^\//, ''), true)}`).href;
}

/** 同 Node `url.fileURLToPath(href, { windows })`。 */
export function fileUrlToPath(href: string, windows: boolean = WINDOWS_PATHS): string {
  const url = new URL(href);
  if (url.protocol !== 'file:') throw new TypeError(`not a file URL: ${href}`);
  const pathname = url.pathname;
  if (/%2f/i.test(pathname) || (windows && /%5c/i.test(pathname))) {
    throw new TypeError(`file URL path must not include encoded path separators: ${href}`);
  }
  const decoded = decodeURIComponent(pathname);
  if (!windows) {
    if (url.hostname !== '') throw new TypeError(`file URL host must be "localhost" or empty: ${href}`);
    return decoded;
  }
  const backslashed = decoded.replace(/\//g, '\\');
  if (url.hostname !== '') return `\\\\${url.hostname}${backslashed}`;
  if (!/^\\[A-Za-z]:/.test(backslashed)) throw new TypeError(`file URL path must be absolute: ${href}`);
  return backslashed.slice(1);
}

/**
 * profile 条目 / 已安装插件的模块来源换成模块 URL：`file:` URL 原样（规范化），绝对路径转 `file:`，
 * 包名用 `import.meta.resolve`（宿主不支持或解析失败时 `null`）。
 */
export function moduleUrlOf(source: string, windows: boolean = WINDOWS_PATHS): string | null {
  if (source.startsWith('file:')) return normalizeUrl(source);
  if (isAbsolutePath(source, windows)) return pathToFileHref(source, windows);
  try {
    const resolved = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve?.(source);
    return resolved ?? null;
  } catch {
    return null;
  }
}

/**
 * `file:` URL 是否严格位于目录 `rootPath`（绝对路径）之内：两边都经 URL 规范化（消去 `.` / `..`）后按路径组件比较，
 * Windows 不区分大小写。根目录本身不算在内。
 */
export function fileUrlWithin(href: string, rootPath: string, windows: boolean = WINDOWS_PATHS): boolean {
  const sep = windows ? '\\' : '/';
  const fold = (path: string) => (windows ? path.toLowerCase() : path);
  const root = fileUrlToPath(pathToFileHref(rootPath, windows), windows);
  const prefix = fold(root.endsWith(sep) ? root : `${root}${sep}`);
  const path = fold(fileUrlToPath(href, windows));
  return path.startsWith(prefix) && path.length > prefix.length;
}

/** `relative`（相对或绝对路径）相对于 `baseHref` 所在目录解析，返回 `file:` URL（同 `path.resolve(dirname(base), relative)`）。 */
export function resolveRelativeFile(baseHref: string, relative: string, windows: boolean = WINDOWS_PATHS): string {
  if (isAbsolutePath(relative, windows)) return pathToFileHref(relative, windows);
  const segments = (windows ? relative.replace(/\\/g, '/') : relative).split('/').map(segment =>
    segment === '.' || segment === '..' ? segment : encodePathChars(segment, windows));
  return new URL(segments.join('/'), baseHref).href;
}
