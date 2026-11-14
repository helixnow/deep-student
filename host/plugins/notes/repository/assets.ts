// cmd/notes.rs asset commands + file_manager.rs note asset storage.
const randomUUID = () => globalThis.crypto.randomUUID();
import { notesLog } from './log.ts';
import { decodeBase64Standard } from '../../../platform/util/base64-core.ts';
import { isAbsolute, join, relative, resolve, sep } from '../../../platform/util/path.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { notesLocalRuntime } from '../src/local-runtime.ts';
import { noteRevisionRepository } from './revisions.ts';
import { rustTrim } from '../../../platform/util/index.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AssetError extends Error {
  readonly kind: 'validation' | 'filesystem' | 'database';
  constructor(kind: 'validation' | 'filesystem' | 'database', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface AssetPath {
  absolute_path: string;
  relative_path: string;
}

export function normalizeSubject(subject: string | null | undefined): string {
  const trimmed = subject == null ? '' : rustTrim(subject);
  return trimmed.length === 0 ? '_global' : trimmed;
}

function validateSegment(label: string, value: string): void {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0) throw new AssetError('validation', `${label} 不能为空`);
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new AssetError('validation', `${label} 不允许包含路径分隔符`);
  }
  if (trimmed === '..' || trimmed === '.') throw new AssetError('validation', `${label} 非法`);
  if (isAbsolute(trimmed) || trimmed.includes('\0')) {
    throw new AssetError('validation', `${label} 含非法路径成分`);
  }
  if (trimmed.length >= 2 && trimmed[1] === ':') {
    throw new AssetError('validation', `${label} 含盘符前缀`);
  }
}

function portable(path: string): string {
  return path.replaceAll('\\', '/');
}

function assetsDir(baseDir: string, subject: string, noteId: string): string {
  validateSegment('subject', subject);
  validateSegment('note_id', noteId);
  return join(baseDir, 'notes_assets', subject, noteId);
}

function mimeExtension(mime: string, fallback: string): string {
  if (mime.includes('image/png')) return 'png';
  if (mime.includes('image/webp')) return 'webp';
  if (mime.includes('image/gif')) return 'gif';
  if (mime.includes('image/bmp')) return 'bmp';
  if (mime.includes('image/jpg') || mime.includes('image/jpeg')) return 'jpg';
  return fallback;
}

export function saveNoteAsset(
  baseDir: string,
  subject: string,
  noteId: string,
  base64Data: string,
  defaultExt: string,
): AssetPath {
  const dir = assetsDir(baseDir, subject, noteId);
  try {
    notesLocalRuntime().mkdirp(dir);
  } catch (error) {
    throw new AssetError('filesystem', `创建资源目录失败: ${message(error)}`);
  }
  const marker = base64Data.indexOf('base64,');
  const mime = marker >= 0 ? base64Data.slice(5, marker) : '';
  const payload = marker >= 0 ? base64Data.slice(marker + 7) : base64Data;
  const bytes = decodeBase64Strict(payload);
  const file = `${randomUUID()}.${mimeExtension(mime, defaultExt)}`;
  const absolute = join(dir, file);
  try {
    notesLocalRuntime().writeBytes(absolute, bytes);
  } catch (error) {
    throw new AssetError('filesystem', `写入资源失败: ${message(error)}`);
  }
  return { absolute_path: absolute, relative_path: portable(relative(baseDir, absolute)) };
}

export function listNoteAssets(baseDir: string, subject: string, noteId: string): AssetPath[] {
  const dir = assetsDir(baseDir, subject, noteId);
  if (!notesLocalRuntime().exists(dir)) return [];
  let entries;
  try {
    entries = notesLocalRuntime().readDir(dir);
  } catch (error) {
    throw new AssetError('filesystem', `读取资源目录失败: ${message(error)}`);
  }
  const out: AssetPath[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const absolute = join(dir, entry.name);
    out.push({ absolute_path: absolute, relative_path: portable(relative(baseDir, absolute)) });
  }
  return out;
}

function decodeBase64Strict(payload: string): Uint8Array {
  // Rust `base64::STANDARD.decode` rejects whitespace, non-alphabet characters,
  // bad padding and trailing bits; Node's Buffer.from(..., 'base64') is lenient.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new AssetError('validation', 'base64解码失败: invalid base64');
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const body = padding === 0 ? payload : payload.slice(0, -padding);
  if (body.includes('=')) {
    throw new AssetError('validation', 'base64解码失败: invalid padding');
  }
  if (body.length > 0) {
    const last = body.at(-1) as string;
    const bits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(last);
    if (padding === 1 && (bits & 0b11) !== 0) {
      throw new AssetError('validation', 'base64解码失败: invalid trailing bits');
    }
    if (padding === 2 && (bits & 0b1111) !== 0) {
      throw new AssetError('validation', 'base64解码失败: invalid trailing bits');
    }
  }
  const decoded = decodeBase64Standard(payload);
  if (decoded.error !== undefined) {
    throw new AssetError('validation', `base64解码失败: ${decoded.error}`);
  }
  return decoded.bytes;
}

/** file_deletion_queue.rs::asset_key_from_relative_path. */
export function assetKeyFromRelativePath(relativePath: string): string | null {
  let normalized = rustTrim(relativePath).replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, '');
  if (normalized.length === 0) return null;
  if (isAbsolute(normalized) || normalized.split('/').includes('..')) return null;
  if (normalized.startsWith('active/') || normalized.startsWith('app_data/')) return normalized;
  if (normalized === 'pdf_ocr_sessions' || normalized.startsWith('pdf_ocr_sessions/')) {
    return `app_data/${normalized}`;
  }
  return `active/${normalized}`;
}

export function resolveAssetPath(baseDir: string, relativePath: string): string {
  let baseCanonical: string;
  try {
    baseCanonical = notesLocalRuntime().realpath(baseDir);
  } catch (error) {
    throw new AssetError('filesystem', `解析app_data_dir失败: ${message(error)}`);
  }
  // Rust PathBuf::join keeps `..`, so reject parent components before Node's
  // lexical join normalizes them away.
  if (relativePath.split(/[\\/]/).includes('..')) {
    throw new AssetError('validation', '拒绝访问：路径包含上级目录跳转');
  }
  const candidate = isAbsolute(relativePath) ? relativePath : join(baseDir, relativePath);
  if (notesLocalRuntime().exists(candidate)) {
    try {
      const canonical = notesLocalRuntime().realpath(candidate);
      if (canonical !== baseCanonical && !canonical.startsWith(`${baseCanonical}${sep}`)) {
        throw new AssetError('validation', '拒绝访问：超出应用数据目录');
      }
      return canonical;
    } catch (error) {
      if (error instanceof AssetError) throw error;
      // Fall through to the lexical check, matching the Rust `canonicalize` miss branch.
    }
  }
  const normalized = resolve(candidate);
  const base = resolve(baseDir);
  if (normalized !== base && !normalized.startsWith(`${base}${sep}`)) {
    throw new AssetError('validation', '拒绝访问：超出应用数据目录');
  }
  return candidate;
}

const HTML_IMG_SRC = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
const HTML_SRCSET = /srcset\s*=\s*["']([^"']+)["']/gi;
const CSS_URL = /url\(\s*['"]?([^"'()\s]+)['"]?\s*\)/gi;
const MD_LINK = /!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^)]+)\)/g;

function addRefPath(refs: Set<string>, raw: string): void {
  const value = rustTrim(raw).replace(/^[()"']+|[()"']+$/g, '');
  if (value.length === 0) return;
  const fwd = value.indexOf('notes_assets/');
  if (fwd >= 0) {
    const sub = value.slice(fwd);
    refs.add(sub);
    refs.add(sub.replaceAll('\\', '/'));
    refs.add(sub.replaceAll('/', '\\'));
    return;
  }
  const back = value.indexOf('notes_assets\\');
  if (back >= 0) {
    const sub = value.slice(back);
    const forward = sub.replaceAll('\\', '/');
    refs.add(sub);
    refs.add(forward);
    refs.add(forward.replaceAll('/', '\\'));
  }
}

function collectJsonPaths(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    addRefPath(refs, value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectJsonPaths(item, refs);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectJsonPaths(item, refs);
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!notesLocalRuntime().exists(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = notesLocalRuntime().readDir(dir);
    } catch (error) {
      // notes_assets_scan_orphans: `读取资源目录失败: ...` (file_system).
      throw new AssetError('filesystem', `读取资源目录失败: ${message(error)}`);
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.kind === 'directory') stack.push(path);
      else if (entry.kind === 'file') out.push(path);
    }
  }
  return out;
}

export function scanOrphanAssets(
  baseDir: string,
  subject: string,
  conn: SqlExecutor,
): string[] {
  const all = walkFiles(join(baseDir, 'notes_assets', subject));
  if (all.length === 0) return [];
  const refs = new Set<string>();
  let contents: Array<{ data: string }>;
  try {
    contents = conn.all<{ data: string }>(
      "SELECT COALESCE(r.data, '') AS data FROM notes n JOIN resources r ON r.id = n.resource_id");
  } catch (error) {
    // Rust: `AppError::database(e.to_string())` for prepare/query failures.
    throw new AssetError('database', message(error));
  }
  for (const { data } of contents) {
    const trimmed = rustTrim(data);
    for (const match of trimmed.matchAll(MD_LINK)) {
      if (match[1] !== undefined) addRefPath(refs, match[1]);
      if (match[2] !== undefined) addRefPath(refs, match[2]);
    }
    for (const match of trimmed.matchAll(HTML_IMG_SRC)) addRefPath(refs, match[1]!);
    for (const match of trimmed.matchAll(HTML_SRCSET)) {
      for (const candidate of match[1]!.split(',')) {
        const path = rustTrim(candidate).split(/\s+/)[0] ?? '';
        if (path.length > 0) addRefPath(refs, path);
      }
    }
    for (const match of trimmed.matchAll(CSS_URL)) addRefPath(refs, match[1]!);
    if (trimmed.includes('notes_assets/') || trimmed.includes('notes_assets\\')) {
      for (const token of trimmed.split(/[\s"']/)) {
        if (token.includes('notes_assets/') || token.includes('notes_assets\\')) addRefPath(refs, token);
      }
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        collectJsonPaths(JSON.parse(trimmed), refs);
      } catch (error) {
        notesLog.debugError('[notes] skipping malformed JSON while scanning assets', error);
      }
    }
  }
  try {
    for (const path of noteRevisionRepository.retainedAssetPaths(conn)) refs.add(path);
  } catch (error) {
    throw new AssetError('database', message(error));
  }
  const orphans: string[] = [];
  for (const file of all) {
    const rel = portable(relative(baseDir, file));
    if (!(refs.has(rel) || refs.has(rel.replaceAll('\\', '/')) || refs.has(rel.replaceAll('/', '\\')))) {
      orphans.push(rel);
    }
  }
  return orphans;
}

export interface NoteAssetDeletionFile {
  /** file_deletion_queue key (`active/notes_assets/...`). */
  key: string;
  /** app-data-relative path (`notes_assets/<subject>/<note>/<file>`). */
  localPath: string;
}

export interface NoteAssetDeletionDir {
  dir: string;
  files: NoteAssetDeletionFile[];
}

function isDirectory(path: string): boolean {
  try {
    return notesLocalRuntime().stat(path).kind === 'directory';
  } catch {
    return false;
  }
}

/**
 * cmd/notes.rs `collect_note_asset_deletion_entries_inner`: enumerate the
 * note's asset files *before* the purge transaction so path validation and IO
 * errors abort without deleting metadata. Non-regular entries reject the whole
 * deletion (`拒绝删除非普通笔记资产`).
 */
export function collectNoteAssetDeletionEntries(
  baseDir: string,
  dir: string,
): NoteAssetDeletionFile[] {
  const out: NoteAssetDeletionFile[] = [];
  if (!isDirectory(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = notesLocalRuntime().readDir(current);
    } catch (error) {
      throw new AssetError(
        'filesystem', `读取待删除笔记资产目录失败 (${current}): ${message(error)}`);
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.kind === 'directory') {
        stack.push(path);
        continue;
      }
      if (entry.kind !== 'file') {
        throw new AssetError('validation', `拒绝删除非普通笔记资产: ${path}`);
      }
      const rel = relative(baseDir, path).split(sep).join('/');
      const key = assetKeyFromRelativePath(rel);
      if (key === null) throw new AssetError('validation', `无法归一化资产路径: ${rel}`);
      out.push({ key, localPath: notesLocalRuntime().assetLocalPathFromKey(key) });
    }
  }
  return out;
}

/** notes_hard_delete: only the requested subject's asset directory. */
export function collectNoteAssetDeletionDirForNote(
  baseDir: string,
  subject: string | null | undefined,
  noteId: string,
): NoteAssetDeletionDir {
  const dir = join(baseDir, 'notes_assets', normalizeSubject(subject), noteId);
  return { dir, files: collectNoteAssetDeletionEntries(baseDir, dir) };
}

/** Notes empty-trash: every subject directory for the deleted note IDs. */
export function collectNoteAssetDeletionDirsForNotes(
  baseDir: string,
  noteIds: readonly string[],
): NoteAssetDeletionDir[] {
  const root = join(baseDir, 'notes_assets');
  if (!isDirectory(root)) return [];
  let subjects;
  try {
    subjects = notesLocalRuntime().readDir(root);
  } catch (error) {
    throw new AssetError('filesystem', `读取笔记资产根目录失败 (${root}): ${message(error)}`);
  }
  const out: NoteAssetDeletionDir[] = [];
  for (const subject of subjects) {
    const subjectDir = join(root, subject.name);
    if (!isDirectory(subjectDir)) continue;
    for (const noteId of noteIds) {
      const dir = join(subjectDir, noteId);
      if (!isDirectory(dir)) continue;
      out.push({ dir, files: collectNoteAssetDeletionEntries(baseDir, dir) });
    }
  }
  return out;
}

/**
 * Rust: `let _ = std::fs::remove_dir(...)` — a non-empty or busy directory is
 * not an error (another note/history may still reference files under it).
 */
export function removeEmptyAssetDirectory(dir: string): void {
  try {
    if (notesLocalRuntime().readDirNames(dir).length === 0) notesLocalRuntime().rmdir(dir);
  } catch (error) {
    notesLog.debug(`[notes] cannot remove asset directory ${dir}: ${message(error)}`);
  }
}
