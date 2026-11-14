// notes_exporter.rs: export path (schema 3 ZIP: Markdown + lossless documents).
const randomUUID = () => globalThis.crypto.randomUUID();
import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { dirname, join, resolve, sep } from '../../../platform/util/path.ts';
import JSZip from 'jszip';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { NoteFormat, NoteRevision } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { noteRepository } from './notes.ts';
import { notesLog } from './log.ts';
import { notesLocalRuntime } from '../src/local-runtime.ts';
import { noteFormatRepository } from './format.ts';
import { noteRevisionRepository, extractAssetRefs } from './revisions.ts';
import { decodeJson } from './json.ts';
import { vfsErrorDisplay } from './errors.ts';
import { blocks, marker, roots } from '../src/structure.ts';
import {
  civilTime, nowEpochNanos, toRfc3339, ymd,
} from '../../../platform/time/index.ts';
import { isRustWhitespace, rustTrim, truncateUtf8 } from '../../../platform/util/index.ts';
import {
  MAX_IMPORT_TEXT_BYTES, SCHEMA_VERSION, NotesExporterError,
  collectPropsAssets, database, extractNoteAssetPaths, filesystem, isPathTraversal,
  isUnsafeArchiveRelative, message, plainMarkdown, remapAssetText, remapProps,
  resolveSafePathUnder, sanitizeFilename, sanitizePrefKey, slugifySubject,
  stripNotesAssetsPrefix, stripYamlQuotes, validateDocumentFormat, validation, yamlQuote,
  type AttachmentInternal, type DocumentArchive, type ExportNote, type ExportRelation,
  type Manifest, type ManifestPreference, type SubjectBundle,
} from './export-common.ts';


interface FolderEntry {
  title: string;
  children: string[];
}

function buildFolderPathsFlat(noteIds: ReadonlySet<string>, preferences: Map<string, unknown>): Map<string, string> {
  const entry = [...preferences.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .find(([key]) => key.includes('notes_folders') || key.includes('notes.pref'));
  const value = entry?.[1];
  const result = new Map<string, string>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result;
  const obj = value as Record<string, unknown>;
  const rawFolders = obj.folders;
  const rootChildren = Array.isArray(obj.rootChildren)
    ? obj.rootChildren.filter((item): item is string => typeof item === 'string') : [];
  const folders = new Map<string, FolderEntry>();
  if (rawFolders !== null && typeof rawFolders === 'object' && !Array.isArray(rawFolders)) {
    for (const [folderId, raw] of Object.entries(rawFolders as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const folder = raw as Record<string, unknown>;
      folders.set(folderId, {
        title: typeof folder.title === 'string' ? folder.title : '未命名文件夹',
        children: Array.isArray(folder.children)
          ? folder.children.filter((item): item is string => typeof item === 'string') : [],
      });
    }
  }
  const visited = new Set<string>();
  const visit = (current: string, prefix: string[]) => {
    if (visited.has(current)) return;
    visited.add(current);
    const folder = folders.get(current);
    if (folder !== undefined) {
      const next = [...prefix];
      const safe = sanitizeFilename(folder.title);
      if (safe.length > 0) next.push(safe);
      for (const child of folder.children) visit(child, next);
    } else if (noteIds.has(current)) {
      const path = prefix.join('/');
      if (path.length > 0) result.set(current, path);
    }
  };
  for (const child of rootChildren) visit(child, []);
  return result;
}

function buildMarkdownPath(folderPath: string | undefined, safeTitle: string, id: string): string {
  const segments = ['notes'];
  if (folderPath !== undefined && folderPath.length > 0) {
    for (const segment of folderPath.split('/')) {
      const safe = sanitizeFilename(segment);
      if (safe.length > 0) segments.push(safe);
    }
  }
  segments.push(safeTitle.length === 0 ? `${id}.md` : `${safeTitle}_${id}.md`);
  return segments.join('/');
}

function renderMarkdownNote(note: ExportNote, folderPath: string | undefined): string {
  let out = '---\n';
  out += `id: ${note.id}\n`;
  out += `title: ${yamlQuote(note.title)}\n`;
  out += `created: ${note.created_at}\n`;
  out += `updated: ${note.updated_at}\n`;
  if (note.is_favorite) out += 'favorite: true\n';
  if (folderPath !== undefined) out += `folder: ${yamlQuote(folderPath)}\n`;
  if (note.tags.length > 0) {
    out += 'tags:\n';
    for (const tag of note.tags) out += `  - ${yamlQuote(tag)}\n`;
  }
  out += '---\n\n';
  out += plainMarkdown(note.content_md);
  return out;
}

function collectRelations(conn: SqlExecutor, noteId: string): ExportRelation[] {
  return conn.all<{
    id: string; block_id: string | null; relation_type: string; resource_id: string;
    locator_json: string; invalidated_at: string | null; created_at: string; updated_at: string;
  }>(`SELECT id,block_id,relation_type,resource_id,locator_json,invalidated_at,created_at,updated_at
        FROM note_learning_relations WHERE note_id=?1 ORDER BY id`, [noteId]).map((row) => ({
    id: row.id,
    block_id: row.block_id,
    relation_type: row.relation_type,
    resource_id: row.resource_id,
    locator: (() => {
      try {
        return decodeJson(row.locator_json);
      } catch (error) {
        // notes_exporter.rs::collect_relations -> AppError::validation(serde msg).
        validation(message(error));
      }
    })(),
    invalidated_at: row.invalidated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export interface ExportOptions {
  conn: SqlExecutor;
  settings: SettingsStore;
  /** Writable app-data dir used for `notes_assets/` (active slot). */
  baseDir: string;
  /** Tauri `app_data_dir()`, used for the default `exports/` directory. */
  appDataDir?: string;
  appVersion: string;
  includeVersions: boolean;
  outputPath: string | null;
}

function collectAllPreferences(settings: SettingsStore): Map<string, unknown> {
  const preferences = new Map<string, unknown>();
  // Rust collects into a BTreeMap, i.e. UTF-8 byte order, not SQL ordering.
  const rows = [...settings.listByPrefix('notes.pref.')].sort((a, b) => compareUtf8(a.key, b.key));
  for (const row of rows) {
    try {
      preferences.set(row.key, decodeJson(row.value));
    } catch (error) {
      notesLog.debugError('[notes] ignoring malformed preference while exporting', error);
    }
  }
  return preferences;
}

function collectBundle(
  options: ExportOptions,
  noteFilter: ReadonlySet<string> | null,
): SubjectBundle {
  // Rust holds `unchecked_transaction()` (BEGIN) while reading current
  // documents and their revision timelines so autosave cannot swap a resource
  // mid-export. Materialize everything before releasing the read snapshot.
  options.conn.exec('BEGIN');
  try {
    return collectBundleSnapshot(options, noteFilter);
  } finally {
    try {
      options.conn.exec('ROLLBACK');
    } catch (error) {
      notesLog.debugError('[notes] export read snapshot release failed', error);
    }
  }
}

function collectBundleSnapshot(
  options: ExportOptions,
  noteFilter: ReadonlySet<string> | null,
): SubjectBundle {
  const notes: ExportNote[] = [];
  let listed: VfsNote[];
  try {
    listed = noteRepository.listNotes(null, 1_000_000, 0, options.conn);
  } catch (error) {
    database(`VFS 查询笔记失败: ${vfsErrorDisplay(error)}`);
  }
  for (const note of listed) {
    if (noteFilter !== null && !noteFilter.has(note.id)) continue;
    let content: string | null;
    try {
      content = noteRepository.getNoteContent(note.id, options.conn);
    } catch (error) {
      database(vfsErrorDisplay(error));
    }
    if (content === null) database('Missing note resource');
    let format: NoteFormat;
    try {
      format = noteFormatRepository.get(options.conn, note.id);
    } catch (error) {
      database(vfsErrorDisplay(error));
    }
    notes.push({
      id: note.id,
      title: note.title,
      content_md: content,
      tags: note.tags,
      created_at: note.createdAt,
      updated_at: note.updatedAt,
      is_favorite: note.isFavorite,
      attachments: [],
      props: note.props ?? null,
      format,
      resource_id: note.resourceId,
      relations: collectRelations(options.conn, note.id),
    });
  }
  if (notes.length === 0) return { notes, attachments: [], preferences: new Map(), revisions: [] };

  const revisions: NoteRevision[] = [];
  if (options.includeVersions) {
    for (const note of notes) {
      let ids: Array<{ version_id: string }>;
      try {
        ids = options.conn.all<{ version_id: string }>(
          'SELECT version_id FROM note_document_revisions WHERE note_id=?1 ORDER BY seq', [note.id]);
      } catch (error) {
        database(vfsErrorDisplay(error));
      }
      for (const row of ids) {
        try {
          revisions.push(noteRevisionRepository.get(options.conn, note.id, row.version_id));
        } catch (error) {
          database(vfsErrorDisplay(error));
        }
      }
    }
  }

  const referenced = new Set<string>();
  for (const note of notes) {
    for (const path of extractNoteAssetPaths(note.content_md)) referenced.add(path);
    collectPropsAssets(note.props, referenced);
  }
  for (const revision of revisions) {
    for (const path of extractNoteAssetPaths(revision.content_md)) referenced.add(path);
    collectPropsAssets(revision.props, referenced);
    for (const ref of revision.asset_refs) {
      if (ref.kind === 'notes_asset') referenced.add(ref.value.replaceAll('\\', '/'));
    }
  }
  const attachments: AttachmentInternal[] = [];
  for (const storedPath of [...referenced].sort()) {
    if (isPathTraversal(storedPath)) validation('Unsafe note attachment reference');
    const normalized = stripNotesAssetsPrefix(storedPath);
    if (normalized === null) validation('Unsafe note attachment reference');
    const absolute = join(options.baseDir, storedPath);
    if (!notesLocalRuntime().exists(absolute) || notesLocalRuntime().stat(absolute).kind !== 'file') {
      filesystem('A referenced note/history attachment is missing');
    }
    attachments.push({ relative_path: normalized, absolute_path: absolute });
  }
  attachments.sort((a, b) => (a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0));
  return { notes, attachments, preferences: collectAllPreferences(options.settings), revisions };
}

function defaultExportName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `notes_export_${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.zip`;
}

function resolveOutputPath(requested: string | null, options: ExportOptions, single: ExportNote | null): string {
  if (requested !== null) {
    if (requested.length === 0) validation('导出路径不能为空');
    if (notesLocalRuntime().exists(requested) && notesLocalRuntime().stat(requested).kind === 'directory') {
      const filename = single === null
        ? defaultExportName()
        : `note_export_${sanitizeFilename(single.title)}_${single.id}.zip`;
      return join(requested, filename);
    }
    return requested;
  }
  const exportsDir = join(options.appDataDir ?? options.baseDir, 'exports');
  if (single === null) return join(exportsDir, defaultExportName());
  return join(exportsDir, `note_export_${sanitizeFilename(single.title)}_${single.id}.zip`);
}

function buildManifest(
  options: ExportOptions,
  notes: ExportNote[],
  attachments: AttachmentInternal[],
  revisions: NoteRevision[],
  preferences: ManifestPreference[],
): Manifest {
  return {
    schema_version: SCHEMA_VERSION,
    exported_at: toRfc3339(),
    app_version: options.appVersion,
    note_count: notes.length,
    attachment_count: attachments.length,
    version_count: revisions.length,
    preferences,
    subjects: [],
  };
}

function documentsIndex(bundle: SubjectBundle): DocumentArchive {
  // serde `skip_serializing_if = "Vec::is_empty"` omits the empty inline
  // arrays; documents live in `_versions/notes|history/*.json` instead.
  return {
    note_files: bundle.notes.map((_, index) => `_versions/notes/${index}.json`),
    revision_files: bundle.revisions.map((_, index) => `_versions/history/${index}.json`),
  };
}

/** notes_exporter.rs::write_documents::write_json (compact JSON + per-entry cap). */
function writeJsonEntry(zip: JSZip, path: string, value: unknown): void {
  const bytes = utf8Encode(JSON.stringify(value));
  if (bytes.length > MAX_IMPORT_TEXT_BYTES) {
    validation('A single document exceeds the archive entry size limit');
  }
  zip.file(path, bytes);
}

export interface ExportSummary {
  output_path: string;
  note_count: number;
  attachment_count: number;
}

export async function exportNotes(options: ExportOptions): Promise<ExportSummary> {
  const bundle = collectBundle(options, null);
  if (bundle.notes.length === 0) validation('没有可导出的笔记');
  return writeArchive(options, bundle, null);
}

export async function exportSingle(options: ExportOptions, noteId: string): Promise<ExportSummary> {
  const bundle = collectBundle(options, new Set([noteId]));
  if (bundle.notes.length === 0) validation('未找到要导出的笔记');
  return writeArchive(options, bundle, bundle.notes[0] as ExportNote);
}

async function writeArchive(
  options: ExportOptions,
  bundle: SubjectBundle,
  single: ExportNote | null,
): Promise<ExportSummary> {
  const outputPath = resolveOutputPath(options.outputPath, options, single);
  const parent = dirname(outputPath);
  try {
    notesLocalRuntime().mkdirp(parent);
  } catch (error) {
    filesystem(`创建导出目录失败: ${message(error)} (${parent})`);
  }
  const zip = new JSZip();
  const noteIds = new Set(bundle.notes.map((note) => note.id));
  const folderPaths = buildFolderPathsFlat(noteIds, bundle.preferences);

  for (const note of bundle.notes) {
    const path = buildMarkdownPath(folderPaths.get(note.id), sanitizeFilename(note.title), note.id);
    zip.file(path, renderMarkdownNote(note, folderPaths.get(note.id)));
  }

  const index = documentsIndex(bundle);
  for (const [i, note] of bundle.notes.entries()) {
    writeJsonEntry(zip, `_versions/notes/${i}.json`, note);
  }
  for (const [i, revision] of bundle.revisions.entries()) {
    writeJsonEntry(zip, `_versions/history/${i}.json`, revision);
  }
  writeJsonEntry(zip, '_versions/documents.json', index);

  const preferenceEntries: ManifestPreference[] = [];
  for (const [key, value] of bundle.preferences) {
    const file = `_preferences/${sanitizePrefKey(key)}.json`;
    const bytes = utf8Encode(JSON.stringify(value, null, 2));
    zip.file(file, bytes);
    preferenceEntries.push({ key, file, bytes: bytes.length });
  }

  for (const attachment of bundle.attachments) {
    if (attachment.relative_path.length === 0) continue;
    try {
      zip.file(`assets/${attachment.relative_path.replaceAll(sep, '/')}`, notesLocalRuntime().readBytes(attachment.absolute_path));
    } catch (error) {
      filesystem(`读取附件失败: ${message(error)}`);
    }
  }

  const manifest = buildManifest(options, bundle.notes, bundle.attachments, bundle.revisions, preferenceEntries);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const exportedAt = civilTime(nowEpochNanos(), false);
  const two = (value: number): string => String(value).padStart(2, '0');
  const exportedAtText = `${ymd(exportedAt)} ${two(exportedAt.hour)}:${two(exportedAt.minute)}:${two(exportedAt.second)}`;
  const readme = single === null
    ? `# 笔记导出\n\n导出时间：${exportedAtText}\n导出格式：统一 ZIP 格式（Markdown + 元数据）\n`
      + `笔记数量：${bundle.notes.length}\n附件数量：${bundle.attachments.length}\n\n`
      + '## 目录结构\n\n- `notes/` 目录：`.md` 笔记文件（YAML frontmatter + 正文）\n'
      + '- `_preferences/` 目录：偏好设置（可选）\n'
      + '- `_versions/documents.json`：完整文档与所选版本历史\n'
      + '- `assets/` 目录：附件文件（笔记正文中的 `notes_assets/<x>` 对应归档内 `assets/<x>`）\n\n'
      + '## 跨软件兼容性\n\n本备份格式兼容常见 Markdown 编辑器。\n'
      + '解压后即可查看笔记内容。\n以下划线 `_` 开头的目录为应用专用元数据，可安全忽略。\n'
    : `# 笔记导出\n\n导出时间：${exportedAtText}\n导出格式：统一 ZIP 格式（单条笔记）\n`
      + `笔记标题：${single.title}\n附件数量：${bundle.attachments.length}\n\n`
      + '## 目录结构\n\n- `notes/` 目录：笔记文件\n'
      + '- `_versions/documents.json`：完整文档与所选版本历史\n'
      + '- `assets/` 目录：附件文件（笔记正文中的 `notes_assets/<x>` 对应归档内 `assets/<x>`）\n\n'
      + '## 跨软件兼容性\n\n本备份格式兼容常见 Markdown 编辑器。\n';
  zip.file('README.md', readme);

  let bytes: Uint8Array;
  try {
    bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX',
    });
  } catch (error) {
    filesystem(`完成导出文件失败: ${message(error)}`);
  }
  try {
    notesLocalRuntime().writeBytes(outputPath, bytes);
  } catch (error) {
    filesystem(`创建导出文件失败: ${message(error)} (${outputPath})`);
  }
  return {
    output_path: outputPath,
    note_count: bundle.notes.length,
    attachment_count: bundle.attachments.length,
  };
}

// ------------------------------------------------------------------ import
