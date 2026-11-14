// notes_exporter.rs: schema 3 document import, schema 2 legacy Markdown ZIPs,
// and the zip-slip safe import helpers.
const randomUUID = () => globalThis.crypto.randomUUID();
import { decodeUtf8Lossy } from '../../../platform/util/utf8.ts';
import { dirname } from '../../../platform/util/path.ts';
import JSZip from 'jszip';
import type { NoteFormat, NoteRevision } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { noteRepository } from './notes.ts';
import { notesLog } from './log.ts';
import { notesLocalRuntime } from '../src/local-runtime.ts';
import { noteFormatRepository } from './format.ts';
import { noteRevisionRepository } from './revisions.ts';
import { noteRelationRepository } from './relations.ts';
import { decodeJson } from './json.ts';
import { blocks } from '../src/structure.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  MAX_IMPORT_TEXT_BYTES, SCHEMA_VERSION, NotesExporterError,
  collectPropsAssets, database, extractNoteAssetPaths, filesystem, isUnsafeArchiveRelative, message,
  remapAssetText, remapProps, resolveImportAttachmentDiskPath, stripYamlQuotes,
  validateDocumentFormat, validation,
  type DocumentArchive, type ExportNote, type Manifest,
} from './export-common.ts';


export type ImportConflictStrategy = 'skip' | 'overwrite' | 'merge_keep_newer';

export interface ImportProgress {
  stage: 'parsing' | 'importing_notes' | 'importing_attachments' | 'importing_preferences' | 'done';
  progress: number;
  current_item: string | null;
  processed: number;
  total: number;
}

export interface ImportOptions {
  conn: SqlExecutor;
  settings: SettingsStore;
  baseDir: string;
  filePath: string;
  conflictStrategy: ImportConflictStrategy;
  onProgress?: (progress: ImportProgress) => void;
  /** Defaults to {@link DEFAULT_ATTACHMENT_LIMITS}. */
  attachmentLimits?: AttachmentLimits;
}

export interface ImportSummary {
  subject_count: number;
  note_count: number;
  attachment_count: number;
  skipped_count: number;
  overwritten_count: number;
}

interface ArchiveEntry {
  name: string;
  /** Inflates at most `limit` bytes, failing with `overflow` past it; header sizes can lie. */
  bytes: (limit: number, overflow: string) => Promise<Uint8Array>;
  size: number;
  compressedSize: number;
  crc32: number | null;
}

/** Same per-entry ratio cap as backup imports (`backup/src/zip.ts` MAX_ARCHIVE_COMPRESSION_RATIO). */
const MAX_ATTACHMENT_COMPRESSION_RATIO = 200;
/** Small attachments may compress past the ratio (blank images, SVG) and stay importable up to this size. */
const ATTACHMENT_RATIO_FLOOR_BYTES = 1024 * 1024;

export interface AttachmentLimits {
  readonly entryBytes: number;
  readonly totalBytes: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  entryBytes: 1024 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
};

/**
 * Bounds what one archive import may inflate into attachments, counted on the actual
 * decompressed bytes.
 * RUST-FIX(RF-W10-notes-import-attachment-inflate-limits): notes_exporter.rs copies every
 * attachment entry with no size, ratio or total bound.
 */
export class AttachmentBudget {
  private used = 0;
  private readonly limits: AttachmentLimits;

  constructor(limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS) {
    this.limits = limits;
  }

  async read(entry: Pick<ArchiveEntry, 'name' | 'compressedSize' | 'bytes'>): Promise<Uint8Array> {
    const ratioLimit = Math.max(entry.compressedSize * MAX_ATTACHMENT_COMPRESSION_RATIO, ATTACHMENT_RATIO_FLOOR_BYTES);
    const entryLimit = Math.min(ratioLimit, this.limits.entryBytes);
    const remaining = this.limits.totalBytes - this.used;
    const bytes = remaining < entryLimit
      ? await entry.bytes(remaining, 'Archive attachments exceed total size limit')
      : await entry.bytes(entryLimit, `Archive attachment exceeds size limit: ${entry.name}`);
    this.used += bytes.length;
    return bytes;
  }
}

interface InflateStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): InflateStream;
  on(event: 'end', callback: () => void): InflateStream;
  on(event: 'error', callback: (error: Error) => void): InflateStream;
  resume(): InflateStream;
  pause(): InflateStream;
}

/** JSZip `internalStream` (runtime API, missing from its typings) with a running byte count. */
function inflateBounded(file: JSZip.JSZipObject, limit: number, overflow: string): Promise<Uint8Array> {
  const stream = (file as unknown as { internalStream(type: 'uint8array'): InflateStream }).internalStream('uint8array');
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        stream.pause();
        try { validation(overflow); } catch (error) { reject(error); }
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    stream.resume();
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readArchiveJson(entry: ArchiveEntry): Promise<unknown> {
  if (entry.size > MAX_IMPORT_TEXT_BYTES) validation('Archive JSON exceeds size limit');
  return entry.bytes(MAX_IMPORT_TEXT_BYTES, 'Archive JSON exceeds size limit').then((bytes) => {
    try {
      return decodeJson(decodeUtf8Lossy(bytes));
    } catch (error) {
      validation(`Invalid archive JSON: ${message(error)}`);
    }
  });
}

function entriesOf(zip: JSZip): ArchiveEntry[] {
  return Object.values(zip.files)
    .filter((file) => !file.dir)
    .map((file) => {
      const data = (file as unknown as {
        _data?: { uncompressedSize?: number; compressedSize?: number; crc32?: number };
      })._data;
      const size = data?.uncompressedSize ?? 0;
      const expected = data?.crc32 ?? null;
      return {
        name: file.name,
        size,
        compressedSize: data?.compressedSize ?? 0,
        crc32: expected,
        bytes: async (limit: number, overflow: string) => {
          const bytes = await inflateBounded(file, limit, overflow);
          if (expected !== null && crc32Of(bytes) !== expected >>> 0) {
            filesystem(`Zip read error: invalid checksum for ${file.name}`);
          }
          if (size > 0 && bytes.length !== size) {
            filesystem(`Zip read error: size mismatch for ${file.name}`);
          }
          return bytes;
        },
      };
    });
}

interface ParsedMarkdown {
  id: string;
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  folder_path: string | null;
  body: string;
}

export function parseMarkdownExport(content: string): ParsedMarkdown {
  const raw = content.startsWith('\ufeff') ? content.slice(1) : content;
  let id = '';
  let createdAt = '';
  let updatedAt = '';
  let isFavorite = false;
  let tags: string[] = [];
  let title = '未命名笔记';
  let folderPath: string | null = null;
  const lines = raw.split(/\r?\n/);
  let contentStart = 0;
  if (lines[0] !== undefined && rustTrim(lines[0]) === '---') {
    let closed = false;
    let endIndex = 0;
    let inTags = false;
    for (let index = 1; index < lines.length; index += 1) {
      const trimmed = rustTrim((lines[index] as string));
      if (trimmed === '---') {
        closed = true;
        endIndex = index;
        break;
      }
      if (inTags) {
        if (trimmed.startsWith('-')) {
          const value = stripYamlQuotes(rustTrim(trimmed.replace(/^-+/, '')));
          if (value.length > 0) tags.push(value);
          continue;
        }
        inTags = false;
      }
      const colon = trimmed.indexOf(':');
      if (colon < 0) continue;
      const key = rustTrim(trimmed.slice(0, colon));
      const value = stripYamlQuotes(rustTrim(trimmed.slice(colon + 1)));
      if (key === 'id') id = value;
      else if (key === 'title') title = value;
      else if (key === 'created') createdAt = value;
      else if (key === 'updated') updatedAt = value;
      else if (key === 'folder' || key === 'folder_path') {
        if (value.length > 0) folderPath = value;
      } else if (key === 'favorite') isFavorite = value === 'true';
      else if (key === 'tags') inTags = true;
      else if (key === '-' && value.length > 0) tags.push(value);
    }
    if (closed) {
      contentStart = endIndex + 1;
      while (contentStart < lines.length && rustTrim((lines[contentStart] as string)).length === 0) {
        contentStart += 1;
      }
    }
  } else {
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = rustTrim((lines[index] as string));
      const strip = (prefix: string) => trimmed.startsWith(prefix)
        ? rustTrim(trimmed.slice(prefix.length).replace(/-->$/, '')) : '';
      if (trimmed.startsWith('<!-- Note ID:')) id = strip('<!-- Note ID:');
      else if (trimmed.startsWith('<!-- Created:')) createdAt = strip('<!-- Created:');
      else if (trimmed.startsWith('<!-- Updated:')) updatedAt = strip('<!-- Updated:');
      else if (trimmed.startsWith('<!-- Favorite:')) isFavorite = strip('<!-- Favorite:') === 'true';
      else if (trimmed.startsWith('<!-- Tags:')) {
        tags = strip('<!-- Tags:').split(',').map((tag) => rustTrim(tag)).filter((tag) => tag.length > 0);
      } else if (trimmed.startsWith('# ') && !trimmed.startsWith('<!--')) {
        title = trimmed.slice(2);
        contentStart = index;
        break;
      } else if (trimmed.length > 0) {
        contentStart = index;
        break;
      }
    }
  }
  if (id.length === 0) id = randomUUID();
  if (createdAt.length === 0) createdAt = toRfc3339();
  if (updatedAt.length === 0) updatedAt = createdAt;
  const body = rustTrim(lines.slice(contentStart).join('\n'));
  return { id, title, tags, created_at: createdAt, updated_at: updatedAt, is_favorite: isFavorite, folder_path: folderPath, body };
}

function validateLegacyDocuments(entries: ArchiveEntry[]): Promise<void> {
  return (async () => {
    for (const entry of entries) {
      if (!entry.name.endsWith('.md') || entry.name === 'README.md'
        || entry.name.startsWith('_versions/') || entry.name.includes('/_versions/')) continue;
      if (entry.size > MAX_IMPORT_TEXT_BYTES) validation('Markdown entry exceeds size limit');
      const content = decodeUtf8Lossy(await entry.bytes(MAX_IMPORT_TEXT_BYTES, 'Markdown entry exceeds size limit'));
      const parsed = parseMarkdownExport(content);
      validateDocumentFormat(parsed.id, parsed.body, null);
    }
  })();
}

function shouldReportProgress(processed: number, total: number): boolean {
  if (total <= 200) return true;
  const step = Math.max(Math.ceil(total / 200), 1);
  return processed === 1 || processed === total || processed % step === 0;
}

function report(options: ImportOptions, progress: ImportProgress): void {
  options.onProgress?.(progress);
}

function writeEntryToDisk(entry: ArchiveEntry, diskPath: string, bytes: Uint8Array): number {
  try {
    notesLocalRuntime().mkdirp(dirname(diskPath));
    notesLocalRuntime().writeBytes(diskPath, bytes, { exclusive: true });
    return bytes.length;
  } catch (error) {
    try {
      notesLocalRuntime().unlink(diskPath);
    } catch (cleanupError) {
      notesLog.debugError('[notes] failed to clean up partial attachment', cleanupError);
    }
    filesystem(message(error));
  }
}

export async function importNotes(options: ImportOptions): Promise<ImportSummary> {
  if (!notesLocalRuntime().exists(options.filePath)) validation('导入文件不存在');
  report(options, {
    stage: 'parsing', progress: 0, current_item: '正在解析归档文件...', processed: 0, total: 0,
  });
  let bytes: Uint8Array;
  try {
    bytes = notesLocalRuntime().readBytes(options.filePath);
  } catch (error) {
    filesystem(`打开导入文件失败: ${message(error)}`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    filesystem(`读取归档文件失败: ${message(error)}`);
  }
  const entries = entriesOf(zip);
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  let manifest: Manifest | null = null;
  if (manifestEntry !== undefined) {
    const parsed = await readArchiveJson(manifestEntry);
    if (parsed === null || typeof parsed !== 'object') validation('Invalid manifest: missing object');
    manifest = parsed as Manifest;
  }
  if (manifest !== null && manifest.schema_version === SCHEMA_VERSION) {
    return importDocumentArchive(options, entries, manifest);
  }
  if (manifest !== null && manifest.schema_version !== 2) {
    validation(`不支持的备份格式版本: ${manifest.schema_version}，请使用新版本导出后重新导入`);
  }
  await validateLegacyDocuments(entries);
  const legacyManifest: Manifest = manifest ?? {
    schema_version: 2,
    exported_at: '',
    app_version: '',
    note_count: 0,
    attachment_count: 0,
    version_count: 0,
    preferences: [],
    subjects: [],
  };
  return importUnifiedZip(options, entries, legacyManifest);
}

async function importUnifiedZip(
  options: ImportOptions,
  entries: ArchiveEntry[],
  manifest: Manifest,
): Promise<ImportSummary> {
  const assetNamespace = `_global/import_${randomUUID().replaceAll('-', '')}`;
  const assetPaths = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.name.startsWith('assets/')) continue;
    const after = entry.name.slice('assets/'.length);
    if (isUnsafeArchiveRelative(after)) continue;
    const normalized = after.startsWith('notes_assets/') ? after.slice('notes_assets/'.length) : after;
    const destination = `notes_assets/${assetNamespace}/${normalized}`;
    assetPaths.set(`notes_assets/${normalized}`, destination);
    assetPaths.set(`assets/${normalized}`, destination);
    assetPaths.set(`assets/${after}`, destination);
  }

  const markdown = entries.filter((entry) => entry.name.endsWith('.md')
    && entry.name !== 'README.md' && !entry.name.startsWith('_versions/')
    && !entry.name.includes('/_versions/')
    && entry.name.split('/').length >= 2);
  const total = markdown.length;
  report(options, {
    stage: 'importing_notes', progress: 0,
    current_item: `准备导入 ${total} 条笔记（VFS 模式）...`, processed: 0, total,
  });

  let noteCount = 0;
  let skipped = 0;
  let overwritten = 0;
  let processed = 0;
  const folderPaths = new Map<string, string | null>();
  for (const entry of markdown) {
    if (entry.size > MAX_IMPORT_TEXT_BYTES) {
      notesLog.warn(`[notes] 跳过异常大笔记条目 ${entry.name}（声明 ${entry.size} 字节）`);
      skipped += 1;
      continue;
    }
    let text: string;
    try {
      text = decodeUtf8Lossy(await entry.bytes(MAX_IMPORT_TEXT_BYTES, 'Markdown entry exceeds size limit'));
    } catch (error) {
      // Rust: read_to_string failure -> warn + continue.
      notesLog.warn(`[notes] 读取文件 ${entry.name} 失败: ${message(error)}`);
      continue;
    }
    let parsed: ParsedMarkdown;
    try {
      parsed = parseMarkdownExport(text);
    } catch (error) {
      validation(message(error));
    }
    const content = remapAssetText(parsed.body, assetPaths);
    processed += 1;
    if (shouldReportProgress(processed, total)) {
      report(options, {
        stage: 'importing_notes', progress: Math.floor((processed / Math.max(total, 1)) * 50),
        current_item: parsed.title, processed, total,
      });
    }
    const existing = noteRepository.getNote(parsed.id, options.conn);
    let finalId: string;
    let favoriteSync: boolean | null = null;
    if (existing !== null) {
      if (options.conflictStrategy === 'skip'
        || (options.conflictStrategy === 'merge_keep_newer' && parsed.updated_at <= existing.updatedAt)) {
        skipped += 1;
        continue;
      }
      let updated;
      try {
        updated = noteRepository.updateNote(parsed.id, {
          title: parsed.title, content, tags: parsed.tags, expectedUpdatedAt: null,
        }, options.conn);
      } catch (error) {
        // Rust: per-note update failure -> warn + continue.
        notesLog.warn(`[notes] VFS Import 更新笔记 ${parsed.id} 失败: ${message(error)}`);
        skipped += 1;
        continue;
      }
      overwritten += 1;
      noteCount += 1;
      finalId = updated.id;
      if (existing.isFavorite !== parsed.is_favorite) favoriteSync = parsed.is_favorite;
    } else {
      let created;
      try {
        created = noteRepository.createNoteWithConn(options.conn, {
          title: parsed.title, content, tags: parsed.tags,
        });
      } catch (error) {
        // Rust: per-note create failure -> warn + continue.
        notesLog.warn(`[notes] VFS Import 创建笔记 ${parsed.id} 失败: ${message(error)}`);
        skipped += 1;
        continue;
      }
      noteCount += 1;
      finalId = created.id;
      if (parsed.is_favorite) favoriteSync = true;
    }
    if (favoriteSync !== null) {
      try {
        noteRepository.setFavorite(finalId, favoriteSync, options.conn);
      } catch (error) {
        notesLog.warn(`[VFS Import] 同步收藏状态失败 ${finalId}: ${message(error)}`);
      }
    }
    folderPaths.set(finalId, parsed.folder_path);
  }

  const assetEntries = entries.filter((entry) => entry.name.startsWith('assets/'));
  report(options, {
    stage: 'importing_attachments', progress: 50,
    current_item: `准备导入 ${assetEntries.length} 个附件...`, processed: 0, total: assetEntries.length,
  });
  let attachmentCount = 0;
  let processedAttachments = 0;
  const attachmentBudget = new AttachmentBudget(options.attachmentLimits);
  const preferences = new Map<string, unknown>();
  for (const preference of manifest.preferences) {
    const entry = entries.find((item) => item.name === preference.file);
    if (entry === undefined || entry.size > MAX_IMPORT_TEXT_BYTES) continue;
    try {
      preferences.set(preference.key, await readArchiveJson(entry));
    } catch (error) {
      notesLog.debugError('[notes] skipping malformed import preference', error);
    }
  }
  for (const entry of assetEntries) {
    let parts = entry.name.slice('assets/'.length).split('/');
    if (isUnsafeArchiveRelative(entry.name.slice('assets/'.length))) continue;
    if (parts[0] === 'notes_assets' && parts.length >= 3) parts = parts.slice(1);
    if (parts.length < 2) continue;
    const subject = parts[0] as string;
    const relativeInSubject = parts.slice(1).join('/');
    const relativePath = `notes_assets/${assetNamespace}/${subject}/${relativeInSubject}`;
    const diskPath = resolveImportAttachmentDiskPath(options.baseDir, relativePath);
    if (diskPath === null) continue;
    try {
      writeEntryToDisk(entry, diskPath, await attachmentBudget.read(entry));
      attachmentCount += 1;
    } catch (error) {
      if (error instanceof NotesExporterError && error.kind === 'filesystem') {
        notesLog.warn(`[notes] failed to write import attachment: ${message(error)}`);
        skipped += 1;
      } else {
        throw error;
      }
    }
    processedAttachments += 1;
    if (shouldReportProgress(processedAttachments, assetEntries.length)) {
      report(options, {
        stage: 'importing_attachments',
        progress: 50 + Math.floor((processedAttachments / Math.max(assetEntries.length, 1)) * 40),
        current_item: relativeInSubject, processed: processedAttachments, total: assetEntries.length,
      });
    }
  }

  for (const [key, value] of preferences) {
    const fullKey = key.startsWith('notes.pref.') ? key : `notes.pref.${key}`;
    try {
      options.settings.save(fullKey, JSON.stringify(value));
    } catch (error) {
      notesLog.warn(`[notes] VFS import could not restore preference: ${message(error)}`);
    }
  }
  if (folderPaths.size > 0) {
    try {
      options.settings.save('notes.pref.notes_folders', JSON.stringify(buildFolderPref(folderPaths)));
    } catch (error) {
      notesLog.warn(`[notes] VFS import could not rebuild folder preferences: ${message(error)}`);
    }
  }
  report(options, {
    stage: 'done', progress: 100, current_item: null, processed: noteCount, total: noteCount,
  });
  return {
    subject_count: 0,
    note_count: noteCount,
    attachment_count: attachmentCount,
    skipped_count: skipped,
    overwritten_count: overwritten,
  };
}

function buildFolderPref(noteFolderMap: ReadonlyMap<string, string | null>): unknown {
  const folders = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const [noteId, folderPath] of noteFolderMap) {
    let parent = 'root';
    if (folderPath !== null) {
      const segments = folderPath.split('/').map((segment) => rustTrim(segment)).filter((segment) => segment.length > 0);
      const accum: string[] = [];
      for (const segment of segments) {
        accum.push(segment);
        const folderKey = `folder_${accum.join('_').replaceAll(' ', '_')}`;
        if (!folders.has(folderKey)) folders.set(folderKey, segment);
        const siblings = children.get(parent) ?? [];
        if (!siblings.includes(folderKey)) siblings.push(folderKey);
        children.set(parent, siblings);
        parent = folderKey;
      }
    }
    const siblings = children.get(parent) ?? [];
    if (!siblings.includes(noteId)) siblings.push(noteId);
    children.set(parent, siblings);
  }
  const foldersValue: Record<string, unknown> = {};
  for (const [id, title] of folders) {
    foldersValue[id] = { title, children: children.get(id) ?? [] };
  }
  return { folders: foldersValue, rootChildren: children.get('root') ?? [] };
}

interface ArchiveRelationRow {
  id: string;
  note_id: string;
  block_id: string | null;
  relation_type: string;
  resource_id: string;
  locator: { type: string; value?: unknown };
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
}

async function importDocumentArchive(
  options: ImportOptions,
  entries: ArchiveEntry[],
  manifest: Manifest,
): Promise<ImportSummary> {
  const documentsEntry = entries.find((entry) => entry.name === '_versions/documents.json');
  if (documentsEntry === undefined) validation('Missing document archive: file not found');
  const documents = await readArchiveJson(documentsEntry) as DocumentArchive;
  documents.notes = documents.notes ?? [];
  documents.revisions = documents.revisions ?? [];
  documents.note_files = documents.note_files ?? [];
  documents.revision_files = documents.revision_files ?? [];
  for (const path of documents.note_files) {
    const entry = entries.find((item) => item.name === path);
    if (entry === undefined) validation(`Missing document archive: ${path}`);
    documents.notes.push(await readArchiveJson(entry) as ExportNote);
  }
  for (const path of documents.revision_files) {
    const entry = entries.find((item) => item.name === path);
    if (entry === undefined) validation(`Missing document archive: ${path}`);
    documents.revisions.push(await readArchiveJson(entry) as NoteRevision);
  }
  if (documents.notes.length !== manifest.note_count
    || documents.revisions.length !== manifest.version_count) {
    validation('Document/history count mismatch');
  }
  const preferences: Array<[string, unknown]> = [];
  for (const preference of manifest.preferences ?? []) {
    const entry = entries.find((item) => item.name === preference.file);
    if (entry === undefined) validation(`Missing document archive: ${preference.file}`);
    preferences.push([preference.key, await readArchiveJson(entry)]);
  }

  const noteIds = new Set<string>();
  const versionIds = new Set<string>();
  for (const note of documents.notes) {
    if (noteIds.has(note.id)) validation('Duplicate note ID');
    noteIds.add(note.id);
    validateDocumentFormat(note.id, note.content_md, note.format ?? null);
    const relationIds = new Set<string>();
    for (const relation of note.relations ?? []) {
      const locatorType = relation.locator !== null && typeof relation.locator === 'object'
        ? (relation.locator as { type?: string }).type : undefined;
      if (relation.id.length === 0
        || relationIds.has(relation.id)
        || !['source', 'card', 'mistake'].includes(relation.relation_type)
        || (relation.relation_type === 'card' && locatorType !== 'card')
        || (relation.relation_type === 'mistake' && locatorType !== 'question')) {
        validation('Invalid archive learning relation');
      }
      relationIds.add(relation.id);
    }
  }
  for (const revision of documents.revisions) {
    if (!noteIds.has(revision.note_id) || versionIds.has(revision.version_id)) {
      validation('Invalid history ownership/duplicate version');
    }
    versionIds.add(revision.version_id);
    validateDocumentFormat(revision.note_id, revision.content_md, {
      note_id: revision.note_id,
      content_format: revision.content_format,
      format_version: revision.format_version,
      serializer_version: revision.serializer_version,
      baseline_version_id: null,
    });
  }

  const namespace = `notes_assets/_global/import_${randomUUID().replaceAll('-', '')}/`;
  const assets = new Map<string, { entry: ArchiveEntry; relative: string }>();
  for (const entry of entries) {
    if (!entry.name.startsWith('assets/')) continue;
    const path = entry.name.slice('assets/'.length);
    if (isUnsafeArchiveRelative(path)) validation('Unsafe asset path');
    const key = `notes_assets/${path}`;
    if (assets.has(key)) validation('Duplicate asset path');
    assets.set(key, { entry, relative: `${namespace}${path}` });
  }
  const pathMap = new Map<string, string>();
  for (const [key, value] of assets) pathMap.set(key, value.relative);

  const required = new Set<string>();
  for (const note of documents.notes) {
    for (const path of extractNoteAssetPaths(note.content_md)) required.add(path);
    collectPropsAssets(note.props, required);
  }
  for (const revision of documents.revisions) {
    for (const path of extractNoteAssetPaths(revision.content_md)) required.add(path);
    collectPropsAssets(revision.props, required);
    for (const ref of revision.asset_refs) {
      if (ref.kind === 'notes_asset') required.add(ref.value.replaceAll('\\', '/'));
    }
  }
  for (const path of required) {
    if (!pathMap.has(path)) validation('Archive is missing a referenced current/history attachment');
  }

  const lineage = new Map<string, string>();
  for (const revision of documents.revisions) {
    for (const id of [revision.version_id, revision.parent_version_id, revision.restored_from_version_id]) {
      if (id !== null && !lineage.has(id)) lineage.set(id, `nrev_${randomUUID().replaceAll('-', '')}`);
    }
  }

  const written: string[] = [];
  let summary: ImportSummary;
  const imported = new Map<string, string>();
  options.conn.exec('SAVEPOINT import_documents');
  try {
    let overwritten = 0;
    let skipped = 0;
    for (const note of documents.notes) {
      const existing = noteRepository.getNote(note.id, options.conn);
      if (existing !== null) {
        if (options.conflictStrategy === 'skip'
          || (options.conflictStrategy === 'merge_keep_newer' && note.updated_at <= existing.updatedAt)) {
          skipped += 1;
          continue;
        }
      }
      note.content_md = remapAssetText(note.content_md, pathMap);
      note.props = remapProps(note.props, pathMap);
      let id: string;
      if (existing !== null) {
        const currentFormat = noteFormatRepository.get(options.conn, existing.id);
        try {
          noteFormatRepository.ensureSupported(currentFormat);
        } catch (error) {
          validation(message(error));
        }
        const incoming: NoteFormat = note.format ?? noteFormatRepository.detect(existing.id, note.content_md);
        incoming.note_id = existing.id;
        incoming.baseline_version_id = incoming.baseline_version_id === null
          ? null : lineage.get(incoming.baseline_version_id) ?? null;
        const before = noteRevisionRepository.snapshot(options.conn, existing.id, 'before_import');
        options.conn.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [before]);
        const updated = noteRepository.updateNoteWithFormat(options.conn, existing.id, {
          title: note.title, content: note.content_md, tags: note.tags,
          expectedUpdatedAt: existing.updatedAt,
        }, incoming);
        overwritten += 1;
        id = updated.id;
      } else {
        const created = noteRepository.createNoteWithConn(options.conn, {
          title: note.title, content: note.content_md, tags: note.tags,
        });
        options.conn.run('DELETE FROM note_document_revisions WHERE note_id=?1', [created.id]);
        id = created.id;
      }
      options.conn.run('UPDATE notes SET props=?2, is_favorite=?3, created_at=?4 WHERE id=?1',
        [id, note.props === null || note.props === undefined ? null : JSON.stringify(note.props),
          note.is_favorite ? 1 : 0, note.created_at]);
      if (note.format !== null && note.format !== undefined) {
        const format = { ...note.format, note_id: id };
        format.baseline_version_id = format.baseline_version_id === null
          ? null : lineage.get(format.baseline_version_id) ?? null;
        noteFormatRepository.insert(options.conn, format);
      }
      imported.set(note.id, id);
    }
    for (const revision of documents.revisions) {
      const id = imported.get(revision.note_id);
      if (id === undefined) continue;
      revision.note_id = id;
      revision.version_id = lineage.get(revision.version_id) as string;
      revision.parent_version_id = revision.parent_version_id === null
        ? null : lineage.get(revision.parent_version_id) ?? null;
      revision.restored_from_version_id = revision.restored_from_version_id === null
        ? null : lineage.get(revision.restored_from_version_id) ?? null;
      if (revision.title === undefined || revision.title === null) {
        // NoteRevisionSummary always carries title; malformed archives fail the count/format gates.
      }
      revision.content_md = remapAssetText(revision.content_md, pathMap);
      revision.props = remapProps(revision.props, pathMap);
      for (const asset of revision.asset_refs) asset.value = remapAssetText(asset.value, pathMap);
      insertArchiveRevision(options.conn, revision);
    }
    for (const id of imported.values()) noteRevisionRepository.snapshot(options.conn, id, 'import');
    importRelations(options.conn, documents.notes, imported);
    if (imported.size > 0) {
      const attachmentBudget = new AttachmentBudget(options.attachmentLimits);
      for (const value of assets.values()) {
        const diskPath = resolveImportAttachmentDiskPath(options.baseDir, value.relative);
        if (diskPath === null) validation('Unsafe attachment destination');
        if (notesLocalRuntime().exists(diskPath)) filesystem(`File exists: ${diskPath}`);
        const bytes = await attachmentBudget.read(value.entry);
        writeEntryToDisk(value.entry, diskPath, bytes);
        written.push(diskPath);
      }
    }
    options.conn.exec('RELEASE import_documents');
    summary = {
      subject_count: 0,
      note_count: imported.size,
      attachment_count: written.length,
      skipped_count: skipped,
      overwritten_count: overwritten,
    };
  } catch (error) {
    try {
      options.conn.exec('ROLLBACK TO import_documents; RELEASE import_documents');
    } catch (rollbackError) {
      notesLog.warnError('[notes] import_documents rollback failed', rollbackError);
    }
    for (const path of written) {
      try {
        notesLocalRuntime().unlink(path);
      } catch (cleanupError) {
        notesLog.debugError('[notes] failed to remove imported attachment', cleanupError);
      }
    }
    throw error;
  }

  for (const [key, value] of preferences) {
    const fullKey = key.startsWith('notes.pref.') ? key : `notes.pref.${key}`;
    try {
      options.settings.save(fullKey, JSON.stringify(remapPreferenceIds(value, imported)));
    } catch (error) {
      notesLog.warn(`[notes] Document import committed; preferences could not be restored: ${message(error)}`);
    }
  }
  report(options, {
    stage: 'done', progress: 100, current_item: null,
    processed: summary.note_count, total: summary.note_count,
  });
  return summary;
}

function remapPreferenceIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapPreferenceIds(item, ids));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, remapPreferenceIds(item, ids)]));
  }
  return value;
}

function insertArchiveRevision(conn: SqlExecutor, revision: NoteRevision): void {
  const created = Date.parse(revision.created_at);
  const bucket = Number.isFinite(created) ? Math.trunc(created / 1000 / 300) : 0;
  conn.run(`INSERT INTO note_document_revisions
     (version_id,note_id,parent_version_id,restored_from_version_id,title,content_md,tags_json,props_json,
       asset_refs_json,content_format,format_version,serializer_version,source,created_at,edit_bucket,pinned)
     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`, [
    revision.version_id, revision.note_id, revision.parent_version_id, revision.restored_from_version_id,
    revision.title, revision.content_md, JSON.stringify(revision.tags),
    revision.props === null || revision.props === undefined ? null : JSON.stringify(revision.props),
    JSON.stringify(revision.asset_refs), revision.content_format, revision.format_version,
    revision.serializer_version, revision.source, revision.created_at, bucket, revision.pinned ? 1 : 0,
  ]);
}

function importRelations(
  conn: SqlExecutor,
  notes: readonly ExportNote[],
  imported: ReadonlyMap<string, string>,
): void {
  const resources = new Map<string, string>();
  for (const note of notes) {
    if (note.resource_id === null || !imported.has(note.id)) continue;
    const target = imported.get(note.id) as string;
    const row = conn.get<{ resource_id: string }>(
      'SELECT resource_id FROM notes WHERE id=?1', [target]);
    if (row !== undefined) resources.set(note.resource_id, row.resource_id);
  }
  for (const note of notes) {
    const target = imported.get(note.id);
    if (target === undefined) continue;
    for (const relation of note.relations ?? []) {
      const locator = relation.locator as { type: string; value?: unknown };
      const card = locator.type === 'card';
      const resource = card ? relation.resource_id : resources.get(relation.resource_id) ?? relation.resource_id;
      let valid = false;
      if (!card) {
        const status = noteRelationRepository.referenceStatus(
          conn, null, resource, locator as never);
        valid = status.resource_exists && status.locator_exists;
      }
      let ownerValid = true;
      if (relation.block_id !== null && relation.block_id !== undefined) {
        const content = noteRepository.getNoteContent(target, conn) ?? '';
        try {
          ownerValid = blocks(content).some((block) => block.id === relation.block_id);
        } catch (error) {
          ownerValid = false;
        }
      }
      const invalidated = relation.invalidated_at !== null
        ? relation.invalidated_at
        : (!valid || !ownerValid ? toRfc3339() : null);
      conn.run(`INSERT INTO note_learning_relations
        (id,note_id,block_id,relation_type,resource_id,locator_json,revision,invalidated_at,created_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6,1,?7,?8,?9)`, [
        `nrel_${randomUUID().replaceAll('-', '')}`, target, relation.block_id,
        relation.relation_type, resource, JSON.stringify(locator), invalidated,
        relation.created_at, relation.updated_at,
      ]);
    }
  }
}
