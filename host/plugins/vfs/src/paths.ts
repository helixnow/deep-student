import type { DstuParsedPath } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import { DstuFailure } from './dstu-error.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';

export const MAX_RESOURCE_ID_LENGTH = 128;
export const RESOURCE_ID_PREFIXES = [
  ['note_', 'note'], ['tb_', 'textbook'], ['exam_', 'exam'], ['tr_', 'translation'], ['essay_', 'essay'],
  ['fld_', 'folder'], ['att_', 'attachment'], ['img_', 'image'], ['file_', 'file'], ['mm_', 'mindmap'],
] as const;
export const VIRTUAL_PATH_TYPES: readonly string[] = ['trash', 'recent', 'favorites', 'all'];
export interface RealParsedPath {
  fullPath: string;
  folderPath?: string;
  resourceId?: string;
  resourceType?: string;
  isRoot: boolean;
  isVirtual: boolean;
  virtualType?: string;
}
export const ParsedPath = {
  root(): RealParsedPath { return { fullPath: '/', isRoot: true, isVirtual: false }; },
  virtualPath(type: string): RealParsedPath { return { fullPath: `/@${type}`, isRoot: false, isVirtual: true, virtualType: type }; },
  folder(folderPath: string): RealParsedPath {
    const fullPath = !folderPath || folderPath === '/' ? '/' : folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
    return { fullPath, ...(fullPath === '/' ? {} : { folderPath: fullPath }), isRoot: fullPath === '/', isVirtual: false };
  },
  resource(folderPath: string | null, resourceId: string, resourceType: string): RealParsedPath {
    const fp = folderPath && folderPath !== '/' ? folderPath.startsWith('/') ? folderPath : `/${folderPath}` : null;
    return { fullPath: `${fp ?? ''}/${resourceId}`, ...(fp === null ? {} : { folderPath: fp }), resourceId, resourceType, isRoot: false, isVirtual: false };
  },
  isResource(p: RealParsedPath): boolean { return p.resourceId !== undefined; },
  isFolderOnly(p: RealParsedPath): boolean { return p.resourceId === undefined && !p.isRoot && !p.isVirtual; },
  getName(p: RealParsedPath): string { return p.isRoot ? '/' : p.fullPath.slice(p.fullPath.lastIndexOf('/') + 1); },
};
export function getResourceTypeFromId(id: string): string | null {
  return RESOURCE_ID_PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}
export function isValidResourceId(id: string): boolean {
  return utf8ByteLength(id) <= MAX_RESOURCE_ID_LENGTH && getResourceTypeFromId(id) !== null;
}
export function isVirtualPathType(type: string): boolean { return VIRTUAL_PATH_TYPES.includes(type.toLowerCase()); }
export function normalizePath(path: string): string {
  // Rust str::trim uses Unicode White_Space (unlike JS trim's BOM treatment).
  const trimmed = rustTrim(path);
  if (!trimmed) return '/';
  const full = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  // Exactly one trailing slash is removed by path_parser.rs:282-283.
  return full.length > 1 && full.endsWith('/') ? full.slice(0, -1) : full;
}
export function parseRealPath(path: string): RealParsedPath {
  if (!path) return ParsedPath.root();
  const normalized = normalizePath(path);
  if (normalized === '/') return ParsedPath.root();
  if (normalized.startsWith('/@') && isVirtualPathType(normalized.slice(2))) return ParsedPath.virtualPath(normalized.slice(2));
  const segments = normalized.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (last === undefined) return ParsedPath.root();
  const length = utf8ByteLength(last);
  if (length > MAX_RESOURCE_ID_LENGTH) throw new DstuFailure('InvalidPath', `资源ID长度超限: ${length} 字符（最大 ${MAX_RESOURCE_ID_LENGTH}）`);
  if (!isValidResourceId(last)) return ParsedPath.folder(normalized);
  return { fullPath: normalized, ...(segments.length > 1 ? { folderPath: `/${segments.slice(0, -1).join('/')}` } : {}),
    resourceId: last, resourceType: getResourceTypeFromId(last)!, isRoot: false, isVirtual: false };
}
export function buildRealPath(folderPath: string | null, resourceId: string): string {
  if (!folderPath || folderPath === '/') return `/${resourceId}`;
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  return `${normalized.replace(/\/+$/, '')}/${resourceId}`;
}
export function isValidPath(path: string): boolean {
  if (!path) return false;
  if (path === '/') return true;
  if (!path.startsWith('/') || path.endsWith('/') || path.includes('//')) return false;
  return !path.split('/').some(s => s === '.' || s === '..');
}
export function extractResourceId(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === '/') return null;
  const last = normalized.slice(normalized.lastIndexOf('/') + 1);
  return isValidResourceId(last) ? last : null;
}
export function extractFolderPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === '/') return null;
  const idx = normalized.lastIndexOf('/');
  return isValidResourceId(normalized.slice(idx + 1)) ? idx === 0 ? null : normalized.slice(0, idx) : normalized;
}
export function buildSimpleResourcePath(id: string): string { return `/${id}`; }
export function isParentPath(parent: string, child: string): boolean {
  const p = normalizePath(parent), c = normalizePath(child);
  return p === '/' ? c !== '/' : c.startsWith(p) && c[p.length] === '/';
}
export function getParentPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}
export function getPathName(path: string): string {
  const normalized = normalizePath(path);
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** handlers.rs:5852 is intentionally distinct from parse_real_path. */
export function parseDstuPath(path: string): DstuParsedPath {
  const root: DstuParsedPath = { fullPath: '/', folderPath: null, resourceId: null, resourceType: null, isRoot: true, isVirtual: false };
  if (!path || path === '/') return root;
  const normalized = (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '');
  if (normalized.startsWith('/@')) return { ...root, fullPath: normalized, isRoot: false, isVirtual: true };
  const segments = normalized.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (last === undefined) return root;
  let resourceType = getResourceTypeFromId(last);
  if (resourceType === 'image') resourceType = null;
  if (resourceType === 'textbook' || resourceType === 'attachment') resourceType = 'file';
  return { fullPath: normalized, folderPath: resourceType === null ? normalized : segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : null,
    resourceId: resourceType === null ? null : last, resourceType, isRoot: false, isVirtual: false };
}
