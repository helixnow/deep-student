/** Write-side repositories used by dstu_create / dstu_update (Rust vfs/repos/*). */
import { dirname, join } from '../../../platform/util/path.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { fs } from '../src/local-runtime.ts';
import type {
  VfsExamSheet,
  VfsFile,
  VfsMindMap,
  VfsResourceType,
  VfsTranslation,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';
import type { VfsEssaySession } from '../src/node-converters.ts';
import { VfsError } from '../src/error.ts';
import { nanoid } from '../src/nanoid.ts';
import { parseSerdeJson } from './json.ts';
import { callNoteRepository, notesRepository, vfsRepositories } from './services.ts';
import {
  addItemToFolderWithConn,
  createFolderItemRecord,
  folderExistsWithConn,
} from './folders.ts';

function database<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof VfsError
      ? error
      : new VfsError('Database', error instanceof Error ? error.message : String(error));
  }
}

function withSavepoint<T>(conn: SqlExecutor, name: string, operation: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const value = operation();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); }
    catch { // boundary-allow empty-catch: mindmap_repo.rs:343-354 and file_repo.rs:202 discard rollback results and preserve the original error
      // Preserve the original failure, as Rust does.
    }
    throw error;
  }
}

/** Rust `Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")`. */
export function nowIso(): string {
  return toRfc3339Opts(nowEpochNanos(), 'Millis', true);
}

/** `VfsResourceRepo::compute_hash` (resource_repo.rs:842-847). */
export function computeHash(data: string): string {
  return sha256HexSync(data);
}

/** `VfsResourceRepo::compute_hash_with_salt` (resource_repo.rs:850-857). */
export function computeHashWithSalt(data: string, salt: string): string {
  return sha256HexSync(`${salt}:${data}`);
}

/** `current_device_id` (translation_repo.rs); F4 paths are not injected in this lane. */
export function currentDeviceId(): string | null {
  return fs.deviceIdEnv();
}

/** `VfsResourceRepo::create_or_reuse_with_conn` (resource_repo.rs:118-190); writer is L11. */
export function createOrReuseResourceWithConn(
  conn: SqlExecutor,
  resourceType: string,
  data: string,
  hash: string,
  sourceId: string | null,
  sourceTable: string | null,
): string {
  return vfsRepositories().resources.createOrReuseWithHash(
    conn,
    resourceType as VfsResourceType,
    data,
    hash,
    sourceId,
    sourceTable,
    null,
  ).resourceId;
}

const MAX_TITLE_CHARS = 500;
const MAX_TAGS = 100;
const MAX_TAG_CHARS = 100;

/** `VfsNoteRepo::validate_title` (note_repo.rs:351-371); Rust `is_control` except tab. */
export function validateNoteTitle(title: string): void {
  if (rustTrim(title) === '') {
    throw new VfsError('InvalidArgument', { param: 'title', reason: '标题不能为空' });
  }
  if (Array.from(title).length > MAX_TITLE_CHARS) {
    throw new VfsError('InvalidArgument', {
      param: 'title',
      reason: `标题过长（最多 ${MAX_TITLE_CHARS} 个字符）`,
    });
  }
  for (const char of title) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 || (code >= 0x7f && code <= 0x9f)) && char !== '\t') {
      throw new VfsError('InvalidArgument', {
        param: 'title',
        reason: '标题不能包含换行等控制字符',
      });
    }
  }
}

/** `VfsNoteRepo::validate_tags` (note_repo.rs:375-397). */
export function validateNoteTags(tags: readonly string[]): void {
  if (tags.length > MAX_TAGS) {
    throw new VfsError('InvalidArgument', {
      param: 'tags',
      reason: `标签数量超出上限（最多 ${MAX_TAGS} 个）`,
    });
  }
  for (const tag of tags) {
    if (Array.from(tag).length > MAX_TAG_CHARS) {
      throw new VfsError('InvalidArgument', {
        param: 'tags',
        reason: `标签过长（最多 ${MAX_TAG_CHARS} 个字符）`,
      });
    }
    for (const char of tag) {
      const code = char.codePointAt(0)!;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        throw new VfsError('InvalidArgument', {
          param: 'tags',
          reason: '标签不能包含控制字符',
        });
      }
    }
  }
}

export interface CreateNoteParams {
  title: string;
  content: string;
  tags: string[];
}

/** `VfsNoteRepo::create_note_with_conn` (note_repo.rs:480-592); writer is L10 notes. */
export function createNoteWithConn(conn: SqlExecutor, params: CreateNoteParams): VfsNote {
  validateNoteTitle(params.title);
  validateNoteTags(params.tags);
  return callNoteRepository(() => notesRepository().createNote(
    { title: params.title, content: params.content, tags: params.tags },
    conn,
  ));
}

/** `VfsNoteRepo::create_note_in_folder_with_conn` (note_repo.rs:2301-2353). */
export function createNoteInFolderWithConn(
  conn: SqlExecutor,
  params: CreateNoteParams,
  folderId: string | undefined,
): VfsNote {
  validateNoteTitle(params.title);
  validateNoteTags(params.tags);
  return callNoteRepository(() => notesRepository().createNoteInFolder(
    { title: params.title, content: params.content, tags: params.tags },
    folderId ?? null,
    conn,
  ));
}

export interface CreateTranslationParams {
  title: string | null;
  source: string;
  translated: string;
  srcLang: string;
  tgtLang: string;
  engine?: string | null;
  model?: string | null;
}

/** `VfsTranslationRepo::create_translation_with_conn` (translation_repo.rs:380-460). */
export function createTranslationWithConn(
  conn: SqlExecutor,
  params: CreateTranslationParams,
): VfsTranslation {
  return vfsRepositories().translations.createTranslation(conn, params);
}

/** `VfsTranslationRepo::create_translation_in_folder_with_conn` (translation_repo.rs:1088-1122). */
export function createTranslationInFolderWithConn(
  conn: SqlExecutor,
  params: CreateTranslationParams,
  folderId: string | undefined,
): VfsTranslation {
  return vfsRepositories().translations.createTranslationInFolder(conn, params, folderId ?? null);
}

/** `VfsTranslationRepo::set_favorite_with_conn`. */
export function setTranslationFavoriteWithConn(
  conn: SqlExecutor,
  translationId: string,
  favorite: boolean,
): void {
  vfsRepositories().translations.setFavorite(conn, translationId, favorite);
}

/** `VfsTranslationRepo::set_quality_rating_with_conn`. */
export function setTranslationQualityRatingWithConn(
  conn: SqlExecutor,
  translationId: string,
  rating: number,
): void {
  vfsRepositories().translations.setQualityRating(conn, translationId, rating);
}

export interface CreateEssaySessionParams {
  title: string;
  essayType: string | null;
  gradeLevel: string | null;
  customPrompt: string | null;
}

/** `VfsEssayRepo::create_session_with_conn` (essay_repo.rs:749-790). */
export function createEssaySessionWithConn(
  conn: SqlExecutor,
  params: CreateEssaySessionParams,
): VfsEssaySession {
  const session = vfsRepositories().essays.createSessionWithConn(conn, params);
  return { id: session.id, title: session.title, essayType: params.essayType, gradeLevel: params.gradeLevel,
    customPrompt: params.customPrompt, totalRounds: session.total_rounds, latestScore: session.latest_score ?? null,
    isFavorite: session.is_favorite, createdAt: session.created_at, updatedAt: session.updated_at, deletedAt: null };
}

/** `VfsEssayRepo::create_session_in_folder_with_conn` (essay_repo.rs:811-860). */
export function createEssaySessionInFolderWithConn(
  conn: SqlExecutor,
  params: CreateEssaySessionParams,
  folderId: string | undefined,
): VfsEssaySession {
  const session = vfsRepositories().essays.createSessionInFolder(conn, params, folderId ?? null);
  return { id: session.id, title: session.title, essayType: params.essayType, gradeLevel: params.gradeLevel,
    customPrompt: params.customPrompt, totalRounds: session.total_rounds, latestScore: session.latest_score ?? null,
    isFavorite: session.is_favorite, createdAt: session.created_at, updatedAt: session.updated_at, deletedAt: null };
}

export interface CreateExamSheetParams {
  examName: string | null;
  tempId: string;
  metadataJson: unknown;
  previewJson: unknown;
  status: string;
}

/** `VfsExamRepo::create_exam_sheet_with_conn` (exam_repo.rs:249-330). */
export function createExamSheetWithConn(
  conn: SqlExecutor,
  params: CreateExamSheetParams,
): VfsExamSheet {
  return vfsRepositories().exams.createExamSheet(conn, {
    ...params, metadataJson: params.metadataJson as import('../../vfs-repos/api.ts').JsonValue,
    previewJson: params.previewJson as import('../../vfs-repos/api.ts').JsonValue,
  });
}

/** `VfsExamRepo::create_exam_sheet_in_folder_with_conn` (exam_repo.rs:1628-1677). */
export function createExamSheetInFolderWithConn(
  conn: SqlExecutor,
  params: CreateExamSheetParams,
  folderId: string | undefined,
): VfsExamSheet {
  return vfsRepositories().exams.createExamSheetInFolder(conn, {
    ...params, metadataJson: params.metadataJson as import('../../vfs-repos/api.ts').JsonValue,
    previewJson: params.previewJson as import('../../vfs-repos/api.ts').JsonValue,
  }, folderId ?? null);
}

const MAX_MINDMAP_DEPTH = 100;
const MAX_MINDMAP_NODES = 10_000;

function mindmapText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function normalizeMindmapNode(
  node: Record<string, unknown>,
  depth: number,
  state: { count: number; ids: Set<string> },
): void {
  if (depth > MAX_MINDMAP_DEPTH) {
    throw new VfsError('InvalidArgument', {
      param: 'content',
      reason: `Mindmap depth exceeds limit (${MAX_MINDMAP_DEPTH})`,
    });
  }
  state.count += 1;
  if (state.count > MAX_MINDMAP_NODES) {
    throw new VfsError('InvalidArgument', {
      param: 'content',
      reason: `Mindmap node count exceeds limit (${MAX_MINDMAP_NODES})`,
    });
  }

  const rawId = typeof node.id === 'string' ? rustTrim(node.id) : '';
  let uniqueId: string;
  if (rawId !== '' && !state.ids.has(rawId)) {
    uniqueId = rawId;
  } else if (rawId !== '') {
    uniqueId = nanoid(10);
    while (state.ids.has(uniqueId)) uniqueId = nanoid(10);
  } else if (depth === 0 && !state.ids.has('root')) {
    uniqueId = 'root';
  } else {
    uniqueId = nanoid(10);
    while (state.ids.has(uniqueId)) uniqueId = nanoid(10);
  }
  state.ids.add(uniqueId);
  node.id = uniqueId;

  if (typeof node.text !== 'string' || rustTrim(node.text) === '') {
    const fallback = mindmapText(node.name)
      ?? mindmapText(node.label)
      ?? mindmapText(node.title)
      ?? mindmapText(node.value)
      ?? mindmapText(node.content);
    node.text = fallback ?? '未命名';
  }

  if (node.note !== undefined && typeof node.note !== 'string') node.note = '';
  const children = node.children === undefined ? [] : node.children;
  if (!Array.isArray(children)) {
    node.children = [];
  } else {
    node.children = children;
    for (const child of children) {
      if (typeof child !== 'object' || child === null || Array.isArray(child)) {
        throw new VfsError('InvalidArgument', {
          param: 'content',
          reason: 'Mindmap node must be an object',
        });
      }
      normalizeMindmapNode(child as Record<string, unknown>, depth + 1, state);
    }
  }
}

/** `VfsMindMapRepo::normalize_mindmap_content` (mindmap_repo.rs:81-286). */
export function normalizeMindmapContent(content: string): string {
  let doc: unknown;
  try {
    doc = parseSerdeJson(content);
  } catch (error) {
    throw new VfsError('InvalidArgument', {
      param: 'content',
      reason: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new VfsError('InvalidArgument', {
      param: 'content',
      reason: 'MindMapDocument must be a JSON object',
    });
  }
  let record = doc as Record<string, unknown>;
  const isNodeLike = !('root' in record) && ('text' in record || 'children' in record);
  if (isNodeLike) {
    record = { version: '1.0', root: record, meta: { createdAt: '' } };
  }

  if (typeof record.version !== 'string' || rustTrim(record.version) === '') record.version = '1.0';
  if (typeof record.meta !== 'object' || record.meta === null || Array.isArray(record.meta)) {
    record.meta = {};
  }
  const meta = record.meta as Record<string, unknown>;
  if (typeof meta.createdAt !== 'string' || rustTrim(meta.createdAt) === '') {
    meta.createdAt = nowIso();
  }
  if (!('root' in record)) {
    record.root = { id: 'root', text: '根节点', children: [] };
  }
  const root = record.root;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new VfsError('InvalidArgument', { param: 'content', reason: 'Missing root node' });
  }
  normalizeMindmapNode(root as Record<string, unknown>, 0, { count: 0, ids: new Set() });
  return JSON.stringify(record);
}

export interface CreateMindMapParams {
  title: string;
  content: string;
  description: string | null;
  defaultView: string;
  theme: string | null;
}

/** `VfsMindMapRepo::create_mindmap_inner` (mindmap_repo.rs:359-425). */
export function createMindmapWithConn(
  conn: SqlExecutor,
  params: CreateMindMapParams,
): VfsMindMap {
  return vfsRepositories().mindmaps.createMindmapWithConn(conn, params);
}

/** `VfsMindMapRepo::create_mindmap_in_folder_with_conn` (mindmap_repo.rs:439-488). */
export function createMindmapInFolderWithConn(
  conn: SqlExecutor,
  params: CreateMindMapParams,
  folderId: string | undefined,
): VfsMindMap {
  return vfsRepositories().mindmaps.createMindmapInFolderWithConn(conn, params, folderId ?? null);
}

export interface VfsBlob {
  hash: string;
  relativePath: string;
  size: number;
  mimeType: string | null;
  refCount: number;
  createdAt: number;
}

/** `VfsBlobRepo::build_blob_path` (blob_repo.rs:1120-1133). */
function buildBlobPath(blobsDir: string, hash: string, extension: string | null): [string, string] {
  const prefix = hash.slice(0, Math.min(2, hash.length));
  const relativePath = `${prefix}/${hash}.${extension ?? 'bin'}`;
  return [relativePath, join(blobsDir, relativePath)];
}

function containedExistingBlobPath(blobsDir: string, relativePath: string): string {
  // RUST-FIX(RF-W10-blob-path-containment): blob_repo.rs reuses the stored relative_path unchecked.
  const resolved = vfsRepositories().blobs.resolveBlobPath(blobsDir, relativePath);
  if (resolved === null) {
    throw new VfsError('PathParse', { path: relativePath, reason: 'blob path must remain inside vfs_blobs' });
  }
  return resolved;
}

/** `VfsBlobRepo::store_blob_with_conn` (blob_repo.rs:105-500). */
export function storeBlobWithConn(
  conn: SqlExecutor,
  blobsDir: string,
  data: Uint8Array,
  mimeType: string | null,
  extension: string | null,
): VfsBlob {
  return database(() => {
    const hash = sha256HexSync(data);
    const dataLength = data.length;
    const existingRelativePath = conn.pluck<string | null>(
      'SELECT relative_path FROM blobs WHERE hash = ?1',
      [hash],
    ) ?? null;
    const [relativePath, absolutePath] = existingRelativePath === null
      ? buildBlobPath(blobsDir, hash, extension)
      : [existingRelativePath, containedExistingBlobPath(blobsDir, existingRelativePath)];

    try { fs.mkdirSync(dirname(absolutePath), { recursive: true }); }
    catch (error) {
      throw new VfsError('Io', `Failed to create blob directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    let shouldWrite: boolean;
    try { shouldWrite = fs.statSync(absolutePath).size !== dataLength; }
    catch { shouldWrite = true; }

    if (shouldWrite) {
      const tempPath = `${absolutePath}.${nanoid(8)}.tmp`;
      try { fs.writeFileSync(tempPath, data); }
      catch (error) {
        throw new VfsError('Io', `Failed to create temp blob file: ${error instanceof Error ? error.message : String(error)}`);
      }
      try { fs.renameSyncWithRetry(tempPath, absolutePath); }
      catch (error) {
        throw new VfsError('Io', `Failed to rename temp blob to final path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const now = Date.now();
    return withSavepoint(conn, 'blob_store_metadata', () => {
      const row = conn.one<{ ref_count: number; created_at: number }>(
        `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)
         ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1
         RETURNING ref_count, created_at`,
        [hash, relativePath, dataLength, mimeType, now],
      );
      return {
        hash,
        relativePath,
        size: dataLength,
        mimeType,
        refCount: row.ref_count,
        createdAt: row.created_at,
      };
    });
  });
}

export interface CreateFileParams {
  sha256: string;
  fileName: string;
  size: number;
  fileType: string;
  mimeType: string | null;
  blobHash: string | null;
  originalPath: string | null;
}

interface CreatedFileRow {
  id: string;
  resource_id: string | null;
  blob_hash: string | null;
  sha256: string;
  file_name: string;
  original_path: string | null;
  size: number;
  file_type: string;
  mime_type: string | null;
  created_at: string;
  updated_at: string;
}

function fileFromRow(row: CreatedFileRow): VfsFile {
  return {
    id: row.id,
    resourceId: row.resource_id,
    blobHash: row.blob_hash,
    sha256: row.sha256,
    fileName: row.file_name,
    originalPath: row.original_path,
    size: row.size,
    fileType: row.file_type,
    mimeType: row.mime_type,
    tags: [],
    isFavorite: false,
    bookmarks: [],
    status: 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CREATED_FILE_SELECT = `SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size,
              "type" AS file_type, mime_type, created_at, updated_at
       FROM files`;

/** `VfsFileRepo::create_file_with_conn` (file_repo.rs:69-180). */
export function createFileWithConn(conn: SqlExecutor, params: CreateFileParams): VfsFile {
  const existing = database(() => conn.get<{ id: string; status: string }>(
    'SELECT id, status FROM files WHERE sha256 = ?1 LIMIT 1',
    [params.sha256],
  ));
  if (existing !== undefined) {
    if (existing.status !== 'active') {
      const now = nowIso();
      conn.run(
        "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
        [now, existing.id],
      );
    }
    const row = database(() => conn.get<CreatedFileRow>(
      `${CREATED_FILE_SELECT} WHERE id = ?1`,
      [existing.id],
    ));
    if (row === undefined) {
      throw new VfsError('Database', `File ${existing.id} not found after restore`);
    }
    return fileFromRow(row);
  }

  return withSavepoint(conn, 'create_file', () => {
    const fileId = `file_${nanoid(10)}`;
    const now = nowIso();
    const nowMs = Date.now();
    const resourceId = `res_${nanoid(10)}`;
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?5)`,
      [resourceId, params.sha256, fileId, nowMs, nowMs],
    );
    conn.run(
      `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size,
                          "type", mime_type, tags_json, is_favorite, status, created_at, updated_at,
                          processing_status, processing_progress, processing_error,
                          processing_started_at, processing_completed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', 0, 'active', ?10, ?11, NULL, NULL, NULL, NULL, NULL)`,
      [
        fileId, resourceId, params.blobHash, params.sha256, params.fileName,
        params.originalPath, params.size, params.fileType, params.mimeType, now, now,
      ],
    );
    return {
      id: fileId,
      resourceId,
      blobHash: params.blobHash,
      sha256: params.sha256,
      fileName: params.fileName,
      originalPath: params.originalPath,
      size: params.size,
      fileType: params.fileType,
      mimeType: params.mimeType,
      tags: [],
      isFavorite: false,
      bookmarks: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  });
}

/** `VfsFileRepo::create_file_in_folder_with_conn` (file_repo.rs:236-300). */
export function createFileInFolderWithConn(
  conn: SqlExecutor,
  params: CreateFileParams,
  folderId: string | undefined,
): VfsFile {
  return withSavepoint(conn, 'create_file_in_folder', () => {
    if (folderId !== undefined && !folderExistsWithConn(conn, folderId)) {
      throw new VfsError('NotFound', { resource_type: 'Folder', id: folderId });
    }
    const file = createFileWithConn(conn, params);
    addItemToFolderWithConn(conn, createFolderItemRecord(folderId, 'file', file.id));
    return file;
  });
}
