/** Standalone helpers for attachment_repo.rs (archive inspection, paths, row mapping). */
import { logWarn } from './logger.ts';
import { fromBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { hostPath as nodePath, type PathModule as PlatformPath } from '../../../platform/util/path.ts';
import { vfsReposLocalRuntime } from '../src/local-runtime.ts';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type VfsAttachment,
} from '../api.ts';

export const INLINE_SIZE_THRESHOLD = 1024 * 1024;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_MEDIA_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
export const ZIP_MANIFEST_MAX_ENTRIES = 200;
export const ARCHIVE_MANIFEST_MARKER = '[#archive-manifest]';

export const ATTACHMENT_COLUMNS = `id, resource_id, blob_hash, type, name, mime_type, size,
  content_hash, is_favorite, created_at, updated_at,
  preview_json, extracted_text, page_count, deleted_at`;

export const SUPPORTED_EXTENSIONS: readonly string[] = [
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'heif',
  'pdf', 'docx', 'xlsx', 'xls', 'xlsb', 'ods', 'pptx',
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonc', 'jsonl', 'xml', 'html', 'htm',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'log',
  'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'py', 'rs', 'go', 'java',
  'c', 'cpp', 'h', 'hpp', 'ts', 'tsx', 'js', 'jsx', 'css', 'scss', 'less',
  'epub', 'rtf',
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'wma', 'opus',
  'aiff', 'aif', 'caf', 'weba', 'mka',
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv', 'ogv', 'mpg', 'mpeg', '3gp',
  'zip', 'rar', '7z',
];

export const SUPPORTED_MIME_TYPES: readonly string[] = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp',
  'image/svg+xml', 'image/heic', 'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'text/tab-separated-values',
  'application/json', 'application/jsonc', 'application/xml', 'text/xml', 'text/html',
  'application/epub+zip', 'application/rtf', 'text/rtf',
  'text/javascript', 'application/javascript', 'application/x-javascript',
  'text/typescript', 'application/typescript',
  'application/yaml', 'application/x-yaml', 'text/yaml',
  'application/toml', 'text/toml',
  'application/x-sh', 'application/x-shellscript', 'text/x-shellscript',
  'application/sql', 'text/sql',
  'text/x-python', 'text/x-python3',
  'text/x-c', 'text/x-c++src', 'text/x-java', 'text/x-go', 'text/x-rust',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a',
  'audio/flac', 'audio/aac', 'audio/x-ms-wma', 'audio/opus',
  'audio/aiff', 'audio/x-aiff', 'audio/x-caf', 'audio/webm', 'audio/x-matroska',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/x-m4v', 'video/x-ms-wmv', 'video/x-flv',
  'video/ogg', 'video/mpeg', 'video/3gpp',
  'video/x-bilibili',
  'application/zip', 'application/x-zip-compressed', 'application/vnd.rar',
  'application/x-rar-compressed', 'application/x-7z-compressed',
];

export const PLAIN_TEXT_CODE_EXTENSIONS: readonly string[] = [
  'py', 'pyw', 'ipynb', 'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'c', 'cpp',
  'cc', 'cxx', 'h', 'hpp', 'hh', 'cs', 'go', 'rb', 'php', 'swift', 'kt', 'kts', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'properties', 'env', 'log', 'tex', 'bib', 'rst', 'adoc', 'vue', 'svelte',
  'astro', 'lua', 'pl', 'pm', 'r', 'jl', 'dart', 'gradle', 'cmake', 'makefile', 'mk',
  'dockerfile', 'gitignore', 'editorconfig', 'proto', 'graphql', 'gql', 'prisma', 'sol',
  'asm', 's', 'vb', 'fs', 'fsx', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'elm',
  'nim', 'zig',
];

export type ArchiveKind = 'zip' | 'rar' | '7z';


export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
export function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
export function ioError(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_IO', `IO error: ${message}`);
}
export function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
export function serializationMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_SERIALIZATION', `Serialization error: ${message}`);
}
export function internalMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INTERNAL', message);
}

export function optionalText(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
export function optionalNumber(value: SqlValue | undefined): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : null;
}
export function textOr(value: SqlValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
export function numberOr(value: SqlValue | undefined, fallback: number): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : fallback;
}

export function isVirtualUri(path: string): boolean {
  const lower = path.trimStart().toLowerCase();
  for (const scheme of ['content://', 'asset://', 'ph://', 'image://', 'camera://']) {
    if (lower.startsWith(scheme)) return true;
  }
  for (const prefix of ['primary:', 'secondary:', 'raw:']) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

export function looksLikePath(input: string): boolean {
  const trimmed = input.trim();
  if (isVirtualUri(trimmed)) return true;
  if (trimmed.startsWith('file://')) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return true;
  const bytes = utf8Encode(trimmed);
  if (bytes.length >= 3) {
    const first = bytes[0]!;
    const second = bytes[1]!;
    const third = bytes[2]!;
    if (second === 0x3a && (third === 0x5c || third === 0x2f)
      && ((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) {
      return true;
    }
  }
  return false;
}

export function normalizeExtension(name: string): string | null {
  const index = name.lastIndexOf('.');
  const ext = (index < 0 ? name : name.slice(index + 1)).trim().toLowerCase();
  if (ext === '' || ext.length >= 10) return null;
  return ext;
}

export function isPlainTextCodeExtension(ext: string): boolean {
  return PLAIN_TEXT_CODE_EXTENSIONS.includes(ext.trim().toLowerCase());
}

export function extensionOf(name: string): string | null {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = name.slice(slash + 1);
  const index = base.lastIndexOf('.');
  if (index < 0 || index === base.length - 1) return null;
  return base.slice(index + 1).toLowerCase();
}

export function archiveKindFromExtension(name: string): ArchiveKind | null {
  switch (normalizeExtension(name)) {
    case 'zip': return 'zip';
    case 'rar': return 'rar';
    case '7z': return '7z';
    default: return null;
  }
}
export function archiveKindFromMime(mimeType: string): ArchiveKind | null {
  switch (mimeType.trim().toLowerCase()) {
    case 'application/zip':
    case 'application/x-zip-compressed': return 'zip';
    case 'application/vnd.rar':
    case 'application/x-rar-compressed': return 'rar';
    case 'application/x-7z-compressed': return '7z';
    default: return null;
  }
}
export function archiveKindFromMagic(data: Uint8Array): ArchiveKind | null {
  const startsWith = (signature: readonly number[]): boolean => signature.every((byte, index) => data[index] === byte);
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])
    || startsWith([0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (startsWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
    || startsWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])) return 'rar';
  if (startsWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  return null;
}

export function validateArchiveContent(name: string, mimeType: string, data: Uint8Array): void {
  const extensionKind = archiveKindFromExtension(name);
  const mimeKind = archiveKindFromMime(mimeType);
  const declaredKind = extensionKind ?? mimeKind;
  if (declaredKind === null) return;
  if (extensionKind !== null && mimeKind !== null && extensionKind !== mimeKind) {
    throw invalidArgument('content', 'Archive extension and MIME type disagree');
  }
  if (archiveKindFromMagic(data) !== declaredKind) {
    throw invalidArgument('content', 'Archive signature does not match the declared format');
  }
}

export function formatManifestSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** ZIP central-directory manifest used when no processing adapter is wired. */
export function buildZipManifestText(name: string, data: Uint8Array): string | null {
  let archive;
  try {
    archive = vfsReposLocalRuntime().readZip(data);
  } catch (error) {
    logWarn(`[VFS::AttachmentRepo] Failed to parse zip central directory for ${name}:`, error);
    return null;
  }
  const total = archive.entries.length;
  const shown = Math.min(total, ZIP_MANIFEST_MAX_ENTRIES);
  const lines: string[] = [ARCHIVE_MANIFEST_MARKER];
  lines.push(`压缩包 ${name}：共 ${total} 个条目${total > shown ? `（仅显示前 ${shown} 条）` : ''}`);
  for (let index = 0; index < shown; index += 1) {
    const entry = archive.entries[index]!;
    // zip 0.6 `ZipFile::is_dir` is exactly "name ends with /".
    if (entry.name.endsWith('/')) lines.push(`- ${entry.name} (目录)`);
    else lines.push(`- ${entry.name} (${formatManifestSize(entry.size)})`);
  }
  return lines.join('\n');
}

export function sleepSync(milliseconds: number): void {
  vfsReposLocalRuntime().sleepSync(milliseconds);
}

/** Rust `is_sqlite_busy_error`: message-based, same keywords. */
export function isSqliteBusyError(error: unknown): boolean {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code) : '';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return code === 'BUSY'
    || message.includes('database is locked')
    || message.includes('database table is locked')
    || message.includes('sqlite_busy')
    || message.includes('database busy');
}

export function splitTextToPages(text: string, pageCount: number): (string | null)[] {
  if (pageCount === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return new Array(pageCount).fill(null);
  const linesPerPage = Math.max(1, Math.ceil(lines.length / pageCount));
  const pages: (string | null)[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const start = index * linesPerPage;
    if (start >= lines.length) {
      pages.push(null);
    } else {
      const end = Math.min(start + linesPerPage, lines.length);
      const pageText = lines.slice(start, end).join('\n');
      pages.push(pageText.trim() === '' ? null : pageText);
    }
  }
  return pages;
}

export function canonicalize(path: string): string | null {
  try { return vfsReposLocalRuntime().realpath(path); }
  catch { return null; }
}

/**
 * Filesystem seam for original_path checks. Production uses the host flavour;
 * tests inject `path.win32` plus a fake realpath to exercise Windows paths on any OS.
 */
export interface AttachmentPathPlatform {
  readonly path: PlatformPath;
  canonicalize(path: string): string | null;
  isFile(path: string): boolean;
}

export const NATIVE_ATTACHMENT_PATHS: AttachmentPathPlatform = {
  path: nodePath,
  canonicalize,
  isFile: (path) => {
    try { return vfsReposLocalRuntime().stat(path).kind === 'file'; }
    catch { return false; }
  },
};

function isWindowsFlavour(api: PlatformPath): boolean {
  return api.sep === '\\';
}

function isSeparator(character: string, windows: boolean): boolean {
  return character === '/' || (windows && character === '\\');
}

/**
 * Rust `Path::components()` collapsed into strings: prefix + root dir form the first
 * entry, separators collapse, non-leading `.` is dropped. Drive letters compare
 * case-insensitively (std `parse_drive` uppercases them); other components are exact.
 */
export function rustComponents(value: string, api: PlatformPath = nodePath): string[] {
  const windows = isWindowsFlavour(api);
  const root = api.parse(value).root;
  const components: string[] = [];
  if (root !== '') {
    if (!windows) {
      components.push('/');
    } else {
      let prefix = root.replaceAll('/', '\\');
      const hasRootDir = prefix.endsWith('\\');
      while (prefix.endsWith('\\') && prefix.length > 0) prefix = prefix.slice(0, -1);
      if (/^[A-Za-z]:$/.test(prefix)) prefix = prefix.toUpperCase();
      const unc = prefix.startsWith('\\\\');
      components.push(`${prefix}${hasRootDir || unc ? '\\' : ''}`);
    }
  }
  const parts = value.slice(root.length).split(windows ? /[\\/]+/ : /\/+/);
  parts.forEach((part, index) => {
    if (part === '') return;
    if (part === '.' && !(index === 0 && root === '')) return;
    components.push(part);
  });
  return components;
}

/** Rust `Path::starts_with`: whole-component prefix match (`/a/bc` is not inside `/a/b`). */
export function isInside(child: string, parent: string, api: PlatformPath = nodePath): boolean {
  const childParts = rustComponents(child, api);
  const parentParts = rustComponents(parent, api);
  if (parentParts.length > childParts.length) return false;
  return parentParts.every((part, index) => part === childParts[index]);
}

/** Rust `Path::parent`: `null` for a bare root or empty path, `''` for a single relative component. */
export function rustParent(path: string, api: PlatformPath = nodePath): string | null {
  const windows = isWindowsFlavour(api);
  const root = api.parse(path).root;
  let end = path.length;
  const stripSeparators = () => {
    while (end > root.length && isSeparator(path[end - 1]!, windows)) end -= 1;
  };
  stripSeparators();
  while (end - root.length >= 2 && path[end - 1] === '.' && isSeparator(path[end - 2]!, windows)) {
    end -= 2;
    stripSeparators();
  }
  if (end <= root.length) return null;
  let start = end;
  while (start > root.length && !isSeparator(path[start - 1]!, windows)) start -= 1;
  let parentEnd = start;
  while (parentEnd > root.length && isSeparator(path[parentEnd - 1]!, windows)) parentEnd -= 1;
  return path.slice(0, parentEnd);
}

/** Rust `Path::is_absolute`: Unix needs a root; Windows needs a prefix and a root (`C:\`, UNC). */
export function rustIsAbsolute(value: string, api: PlatformPath = nodePath): boolean {
  if (!isWindowsFlavour(api)) return value.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value);
}

export function retainsAsset(conn: SqlExecutor, value: string): boolean {
  for (const table of ['qbank_papers', 'qbank_practice_drafts', 'qbank_practice_attempts']) {
    const exists = Number(conn.pluck<number>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]) ?? 0) !== 0;
    if (!exists) continue;
    const retained = Number(conn.pluck<number>(
      `SELECT EXISTS(SELECT 1 FROM ${table},json_tree(document_json) j WHERE j.key IN ('id','hash') AND j.value=?1)`,
      [value]) ?? 0) !== 0;
    if (retained) return true;
    const answers = Number(conn.pluck<number>(
      `SELECT EXISTS(SELECT 1 FROM ${table},json_each(document_json,'$.answers') a,json_tree(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END) j WHERE j.key IN ('id','hash') AND j.value=?1)`,
      [value]) ?? 0) !== 0;
    if (answers) return true;
  }
  return false;
}

export function rowToAttachment(row: Row): VfsAttachment {
  const resourceId = optionalText(row.resource_id);
  const blobHash = optionalText(row.blob_hash);
  const previewJson = optionalText(row.preview_json);
  const extractedText = optionalText(row.extracted_text);
  const pageCount = optionalNumber(row.page_count);
  const deletedAt = optionalText(row.deleted_at);
  return {
    id: String(row.id),
    ...(resourceId === null ? {} : { resourceId }),
    ...(blobHash === null ? {} : { blobHash }),
    type: textOr(row.type, 'file'),
    name: textOr(row.name, ''),
    mimeType: textOr(row.mime_type, 'application/octet-stream'),
    size: numberOr(row.size, 0),
    contentHash: textOr(row.content_hash, ''),
    isFavorite: numberOr(row.is_favorite, 0) !== 0,
    createdAt: textOr(row.created_at, ''),
    updatedAt: textOr(row.updated_at, ''),
    ...(previewJson === null ? {} : { previewJson }),
    ...(extractedText === null ? {} : { extractedText }),
    ...(pageCount === null ? {} : { pageCount }),
    ...(deletedAt === null ? {} : { deletedAt }),
  };
}

export { parsePdfPreviewJson as parsePdfPreview } from './pdf-preview-json.ts';

export interface PreparedUpload {
  data: Uint8Array;
  contentHash: string;
  attachmentType: string;
  isPdf: boolean;
  previewJson: string | null;
  extractedText: string | null;
  pageCount: number | null;
  pagedTextPages: string[] | null;
  pdfRenderError: string | null;
}

export function isProbablyBase64(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === '') return false;
  if (looksLikePath(trimmed)) return false;
  let raw: string;
  if (trimmed.startsWith('data:')) {
    const parts = trimmed.split(',');
    if (parts.length < 2) return false;
    raw = parts[1]!;
  } else {
    raw = trimmed;
  }
  let cleaned = '';
  for (const character of raw) {
    if (/\p{White_Space}/u.test(character)) continue;
    cleaned += character === '-' ? '+' : character === '_' ? '/' : character;
  }
  if (cleaned === '') return false;
  if (!/^[A-Za-z0-9+/=]*$/.test(cleaned)) return false;
  const remainder = cleaned.length % 4;
  if (remainder === 1) return false;
  if (remainder > 0) cleaned += '='.repeat(4 - remainder);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return false;
  try {
    fromBase64(cleaned);
    return true;
  } catch {
    return false;
  }
}


export function inferExtension(mimeType: string, name: string): string | null {
  const index = name.lastIndexOf('.');
  if (index > 0) {
    const ext = name.slice(index + 1);
    if (ext !== '' && ext.length < 10) return ext.toLowerCase();
  }
  switch (mimeType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/bmp': return 'bmp';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'application/pdf': return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    case 'application/vnd.ms-excel': return 'xls';
    case 'application/vnd.ms-excel.sheet.binary.macroEnabled.12': return 'xlsb';
    case 'application/vnd.oasis.opendocument.spreadsheet': return 'ods';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'pptx';
    case 'text/plain': return 'txt';
    case 'text/markdown': return 'md';
    case 'text/csv': return 'csv';
    case 'application/json': return 'json';
    case 'application/xml':
    case 'text/xml': return 'xml';
    case 'text/html': return 'html';
    case 'application/epub+zip': return 'epub';
    case 'application/rtf':
    case 'text/rtf': return 'rtf';
    case 'audio/mpeg': return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav': return 'wav';
    case 'audio/ogg': return 'ogg';
    case 'audio/mp4':
    case 'audio/x-m4a': return 'm4a';
    case 'audio/flac': return 'flac';
    case 'audio/aac': return 'aac';
    case 'audio/x-ms-wma': return 'wma';
    case 'audio/opus': return 'opus';
    case 'video/mp4': return 'mp4';
    case 'video/webm': return 'webm';
    case 'video/quicktime': return 'mov';
    case 'video/x-msvideo': return 'avi';
    case 'video/x-matroska': return 'mkv';
    case 'video/x-m4v': return 'm4v';
    case 'video/x-ms-wmv': return 'wmv';
    case 'video/x-flv': return 'flv';
    case 'application/zip':
    case 'application/x-zip-compressed': return 'zip';
    case 'application/vnd.rar':
    case 'application/x-rar-compressed': return 'rar';
    case 'application/x-7z-compressed': return '7z';
    default: return null;
  }
}
