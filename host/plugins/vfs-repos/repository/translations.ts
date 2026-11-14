/** Port of dstu-vfs translation_repo.rs. All functions take the caller's connection. */
import { logInfo, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type JsonValue,
  type ResourceLocation,
  type TranslationRepository,
  type VfsCreateTranslationParams,
  type VfsFolderItem,
  type VfsTranslation,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { FolderRepo } from './folders.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { ResourceRepo } from './resources.ts';
import { utcTimestamp } from './timestamps.ts';

/** 翻译完整查询列（含 resources.data 正文）。 */
const SELECT_TRANSLATION_WITH_CONTENT = `
    SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
           t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
           r.data as content_json
    FROM translations t
    LEFT JOIN resources r ON t.resource_id = r.id
`;

/** 翻译轻量查询列（不 JOIN resources，content_json 恒为 NULL）。 */
const SELECT_TRANSLATION_META_ONLY = `
    SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
           t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
           NULL as content_json
    FROM translations t
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function serializationMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_SERIALIZATION', `Serialization error: ${message}`);
}

function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return databaseMessage(`Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
function readText(row: Row, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readInteger(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw columnError(index, name, value);
  return number;
}
function optionalText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function optionalInteger(value: SqlValue | undefined): number | undefined {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : undefined;
}

function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function parseMetadata(raw: string | undefined): JsonValue | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
}

function parseContent(raw: string | undefined): { source?: string; translated?: string } {
  if (raw === undefined) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const object = value as Record<string, unknown>;
    const result: { source?: string; translated?: string } = {};
    if (typeof object.source === 'string') result.source = object.source;
    if (typeof object.translated === 'string') result.translated = object.translated;
    return result;
  } catch {
    return {};
  }
}

function rowToTranslation(row: Row): VfsTranslation {
  const title = optionalText(row.title);
  const engine = optionalText(row.engine);
  const model = optionalText(row.model);
  const qualityRating = optionalInteger(row.quality_rating);
  const updatedAt = optionalText(row.updated_at);
  const metadata = parseMetadata(optionalText(row.metadata_json));
  const content = parseContent(optionalText(row.content_json));
  return {
    id: readText(row, 'id', 0),
    resourceId: readText(row, 'resource_id', 1),
    ...(title === undefined ? {} : { title }),
    srcLang: readText(row, 'src_lang', 3),
    tgtLang: readText(row, 'tgt_lang', 4),
    ...(engine === undefined ? {} : { engine }),
    ...(model === undefined ? {} : { model }),
    isFavorite: readInteger(row, 'is_favorite', 7) !== 0,
    ...(qualityRating === undefined ? {} : { qualityRating }),
    createdAt: readText(row, 'created_at', 9),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(content.source === undefined ? {} : { sourceText: content.source }),
    ...(content.translated === undefined ? {} : { translatedText: content.translated }),
  };
}

function mapTranslations(rows: readonly Row[]): VfsTranslation[] {
  const translations: VfsTranslation[] = [];
  for (const row of rows) {
    try { translations.push(rowToTranslation(row)); }
    catch (error) { logWarn('[VFS::TranslationRepo] Row parse error (skipped):', error); }
  }
  return translations;
}

function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T): T {
  try { conn.exec(`SAVEPOINT ${name}`); }
  catch (error) {
    logWarn(`[VFS::TranslationRepo] Failed to create savepoint ${name}:`, error);
    throw databaseMessage(`Failed to create savepoint ${name}: ${errorMessage(error)}`);
  }

  let value: T | undefined;
  let failure: { error: unknown } | null = null;
  try { value = run(); }
  catch (error) { failure = { error }; }

  if (failure === null) {
    try { conn.exec(`RELEASE ${name}`); }
    catch (error) {
      logWarn(`[VFS::TranslationRepo] Failed to release savepoint ${name}:`, error);
      throw databaseMessage(`Failed to release savepoint ${name}: ${errorMessage(error)}`);
    }
    return value as T;
  }

  try { conn.exec(`ROLLBACK TO ${name}`); }
  catch (error) { logWarn(`[VFS::TranslationRepo] Rollback to ${name} failed:`, error); }
  try { conn.exec(`RELEASE ${name}`); }
  catch (error) { logWarn(`[VFS::TranslationRepo] Release after rollback of ${name} failed:`, error); }
  throw failure.error;
}

function contentJson(source: string, translated: string): string {
  try {
    return JSON.stringify({ source, translated });
  } catch (error) {
    throw serializationMessage(errorMessage(error));
  }
}

export class TranslationRepo implements TranslationRepository {
  private readonly folders = new FolderRepo();
  private readonly resources = new ResourceRepo();
  private readonly deviceId: string;

  /** `current_device_id` (translation_repo.rs): resolved once by the plugin from F4 `paths`. */
  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  private currentDeviceId(): string {
    return this.deviceId;
  }

  listTranslations(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsTranslation[] {
    return databaseResult(() => {
      let sql = `${SELECT_TRANSLATION_WITH_CONTENT} WHERE t.deleted_at IS NULL`;
      const params: (string | number)[] = [];
      let paramIndex = 1;
      if (search !== null) {
        sql += ` AND (t.title LIKE ?${paramIndex} ESCAPE '\\' OR r.data LIKE ?${paramIndex + 1} ESCAPE '\\')`;
        const pattern = `%${escapeLikePattern(search)}%`;
        params.push(pattern, pattern);
        paramIndex += 2;
      }
      sql += ` ORDER BY t.created_at DESC LIMIT ?${paramIndex} OFFSET ?${paramIndex + 1}`;
      params.push(limit, offset);
      return mapTranslations(conn.all<Row>(sql, params));
    });
  }

  listTranslationsLight(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsTranslation[] {
    return databaseResult(() => {
      let sql = `${SELECT_TRANSLATION_META_ONLY} WHERE t.deleted_at IS NULL`;
      const params: (string | number)[] = [];
      let paramIndex = 1;
      if (search !== null) {
        sql += ` AND t.title LIKE ?${paramIndex} ESCAPE '\\'`;
        params.push(`%${escapeLikePattern(search)}%`);
        paramIndex += 1;
      }
      sql += ` ORDER BY t.created_at DESC LIMIT ?${paramIndex} OFFSET ?${paramIndex + 1}`;
      params.push(limit, offset);
      return mapTranslations(conn.all<Row>(sql, params));
    });
  }

  getTranslation(conn: SqlExecutor, translationId: string): VfsTranslation | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `${SELECT_TRANSLATION_WITH_CONTENT} WHERE t.id = ?1 AND t.deleted_at IS NULL`,
        [translationId]);
      return row === undefined ? null : rowToTranslation(row);
    });
  }

  getTranslationIncludingDeleted(conn: SqlExecutor, translationId: string): VfsTranslation | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `${SELECT_TRANSLATION_WITH_CONTENT} WHERE t.id = ?1`, [translationId]);
      return row === undefined ? null : rowToTranslation(row);
    });
  }

  getTranslationContent(conn: SqlExecutor, translationId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT r.data
         FROM translations t
         LEFT JOIN resources r ON t.resource_id = r.id
         WHERE t.id = ?1 AND t.deleted_at IS NULL`, [translationId]);
      if (row === undefined) return null;
      const data = optionalText(row.data);
      return data === undefined || data === '' ? null : data;
    });
  }

  searchTranslations(conn: SqlExecutor, query: string, limit: number): VfsTranslation[] {
    return this.listTranslations(conn, query, limit, 0);
  }

  createTranslation(conn: SqlExecutor, params: VfsCreateTranslationParams): VfsTranslation {
    return databaseResult(() => {
      const content = contentJson(params.source, params.translated);
      return withSavepoint(conn, 'create_translation', () => {
        const translationId = `tr_${nanoid(10)}`;
        const saltedHash = this.resources.computeHashWithSalt(content, translationId);
        const resource = this.resources.createOrReuseWithHash(conn, 'translation', content,
          saltedHash, translationId, 'translations', null);

        const now = utcTimestamp();
        conn.run(`INSERT INTO translations
            (id, resource_id, title, src_lang, tgt_lang, engine, model,
             is_favorite, quality_rating, created_at, updated_at, metadata_json,
             device_id, local_version)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?9, NULL, ?10, 1)`,
        [translationId, resource.resourceId, params.title ?? null, params.srcLang,
          params.tgtLang, params.engine ?? null, params.model ?? null, now, now,
          this.currentDeviceId()]);

        return {
          id: translationId,
          resourceId: resource.resourceId,
          ...(params.title === undefined || params.title === null ? {} : { title: params.title }),
          srcLang: params.srcLang,
          tgtLang: params.tgtLang,
          ...(params.engine === undefined || params.engine === null ? {} : { engine: params.engine }),
          ...(params.model === undefined || params.model === null ? {} : { model: params.model }),
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
          sourceText: params.source,
          translatedText: params.translated,
        };
      });
    });
  }

  createTranslationLegacy(conn: SqlExecutor, sourceText: string, translatedText: string,
    srcLang: string, tgtLang: string, engine: string | null, model: string | null): VfsTranslation {
    return this.createTranslation(conn, {
      title: null,
      source: sourceText,
      translated: translatedText,
      srcLang,
      tgtLang,
      engine,
      model,
    });
  }

  setFavorite(conn: SqlExecutor, translationId: string, favorite: boolean): void {
    databaseResult(() => {
      const updated = conn.run(
        `UPDATE translations
         SET is_favorite = ?1, updated_at = ?2,
             local_version = COALESCE(local_version, 0) + 1, device_id = ?3
         WHERE id = ?4 AND deleted_at IS NULL`,
        [favorite ? 1 : 0, utcTimestamp(), this.currentDeviceId(), translationId]).changes;
      if (updated === 0) throw notFound('Translation', translationId);
    });
  }

  setQualityRating(conn: SqlExecutor, translationId: string, rating: number): void {
    databaseResult(() => {
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw invalidArgument('rating', 'Rating must be between 1 and 5');
      }
      const updated = conn.run(
        `UPDATE translations
         SET quality_rating = ?1, updated_at = ?2,
             local_version = COALESCE(local_version, 0) + 1, device_id = ?3
         WHERE id = ?4 AND deleted_at IS NULL`,
        [rating, utcTimestamp(), this.currentDeviceId(), translationId]).changes;
      if (updated === 0) throw notFound('Translation', translationId);
    });
  }

  deleteTranslation(conn: SqlExecutor, translationId: string): void {
    databaseResult(() => {
      withSavepoint(conn, 'delete_translation', () => {
        const now = utcTimestamp();
        const updated = conn.run(
          `UPDATE translations
           SET deleted_at = ?1, updated_at = ?1,
               local_version = COALESCE(local_version, 0) + 1, device_id = ?2
           WHERE id = ?3 AND deleted_at IS NULL`,
          [now, this.currentDeviceId(), translationId]).changes;

        if (updated === 0) {
          let alreadyDeleted = false;
          try {
            alreadyDeleted = Number(conn.pluck<number>(
              'SELECT EXISTS(SELECT 1 FROM translations WHERE id = ?1 AND deleted_at IS NOT NULL)',
              [translationId]) ?? 0) !== 0;
          } catch (error) {
            logWarn('[VFS::TranslationRepo] Failed to check soft-delete state:', error);
          }
          if (!alreadyDeleted) throw notFound('Translation', translationId);
        }

        const nowMs = Date.now();
        conn.run(
          `UPDATE folder_items
           SET deleted_at = ?1, updated_at = ?2,
               local_version = COALESCE(local_version, 0) + 1, device_id = ?3
           WHERE item_type = 'translation' AND item_id = ?4 AND deleted_at IS NULL`,
          [now, nowMs, this.currentDeviceId(), translationId]);
      });
    });
  }

  purgeTranslation(conn: SqlExecutor, translationId: string): void {
    databaseResult(() => {
      withSavepoint(conn, 'purge_translation', () => {
        const resourceRow = conn.get<Row>(
          'SELECT resource_id FROM translations WHERE id = ?1', [translationId]);
        const resourceId = resourceRow === undefined ? undefined : optionalText(resourceRow.resource_id);

        conn.run("DELETE FROM folder_items WHERE item_type = 'translation' AND item_id = ?1",
          [translationId]);

        const deleted = conn.run('DELETE FROM translations WHERE id = ?1', [translationId]).changes;
        if (deleted === 0) throw notFound('Translation', translationId);

        if (resourceId !== undefined) {
          const remaining = Number(conn.pluck<number>(
            'SELECT COUNT(*) FROM translations WHERE resource_id = ?1', [resourceId]) ?? 0);
          if (remaining === 0) {
            purgeIndexArtifactsByResource(conn, resourceId);
            conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
          } else {
            logInfo(`[VFS::TranslationRepo] Resource ${resourceId} still referenced by ${remaining} translations, kept`);
          }
        }
      });
    });
  }

  updateTranslationContent(conn: SqlExecutor, translationId: string, source: string, translated: string): void {
    databaseResult(() => {
      const resourceRow = conn.get<Row>(
        'SELECT resource_id FROM translations WHERE id = ?1 AND deleted_at IS NULL',
        [translationId]);
      const resourceId = resourceRow === undefined ? undefined : optionalText(resourceRow.resource_id);
      if (resourceId === undefined) throw notFound('Translation', translationId);

      const content = contentJson(source, translated);
      const saltedHash = this.resources.computeHashWithSalt(content, translationId);

      const sharers = Number(conn.pluck<number>(
        'SELECT COUNT(*) FROM translations WHERE resource_id = ?1 AND id != ?2',
        [resourceId, translationId]) ?? 0);

      const now = utcTimestamp();
      const nowMs = Date.now();

      withSavepoint(conn, 'update_translation_content', () => {
        if (sharers > 0) {
          const newResource = this.resources.createOrReuseWithHash(conn, 'translation',
            content, saltedHash, translationId, 'translations', null);
          conn.run(
            `UPDATE translations
             SET resource_id = ?1, updated_at = ?2,
                 local_version = COALESCE(local_version, 0) + 1, device_id = ?3
             WHERE id = ?4`,
            [newResource.resourceId, now, this.currentDeviceId(), translationId]);
          logInfo(`[VFS::TranslationRepo] Detached shared resource for translation ${translationId}: ${resourceId} -> ${newResource.resourceId}`);
        } else {
          conn.run(
            `UPDATE resources SET data = ?1, hash = ?2, updated_at = ?3,
                index_state = 'pending', index_error = NULL,
                index_retry_count = 0, index_next_retry_at = 0
             WHERE id = ?4`,
            [content, saltedHash, nowMs, resourceId]);
          conn.run(
            `UPDATE translations
             SET updated_at = ?1,
                 local_version = COALESCE(local_version, 0) + 1, device_id = ?2
             WHERE id = ?3`,
            [now, this.currentDeviceId(), translationId]);
        }
      });
    });
  }

  setMetadataJsonOnlyWithConn(conn: SqlExecutor, translationId: string, metadataJson: string): void {
    const updated = conn.run('UPDATE translations SET metadata_json = ?1 WHERE id = ?2',
      [metadataJson, translationId]).changes;
    if (updated === 0) throw new Error(`translation row ${translationId} not found for metadata update`);
  }

  restoreTranslation(conn: SqlExecutor, translationId: string): void {
    databaseResult(() => {
      withSavepoint(conn, 'restore_translation', () => {
        const now = utcTimestamp();
        const nowMs = Date.now();
        const updated = conn.run(
          `UPDATE translations
           SET deleted_at = NULL, updated_at = ?1,
               local_version = COALESCE(local_version, 0) + 1, device_id = ?2
           WHERE id = ?3 AND deleted_at IS NOT NULL`,
          [now, this.currentDeviceId(), translationId]).changes;
        if (updated === 0) throw notFound('Translation', translationId);

        conn.run(
          `UPDATE folder_items
           SET deleted_at = NULL, updated_at = ?1,
               local_version = COALESCE(local_version, 0) + 1, device_id = ?2
           WHERE item_type = 'translation' AND item_id = ?3 AND deleted_at IS NOT NULL`,
          [nowMs, this.currentDeviceId(), translationId]);
      });
    });
  }

  listDeletedTranslations(conn: SqlExecutor, limit: number, offset: number): VfsTranslation[] {
    return databaseResult(() => mapTranslations(conn.all<Row>(
      `${SELECT_TRANSLATION_WITH_CONTENT}
       WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset])));
  }

  updateTitle(conn: SqlExecutor, translationId: string, newTitle: string): VfsTranslation {
    return databaseResult(() => {
      const updated = conn.run(
        `UPDATE translations
         SET title = ?1, updated_at = ?2,
             local_version = COALESCE(local_version, 0) + 1, device_id = ?3
         WHERE id = ?4 AND deleted_at IS NULL`,
        [newTitle, utcTimestamp(), this.currentDeviceId(), translationId]).changes;
      if (updated === 0) throw notFound('Translation', translationId);
      const translation = this.getTranslation(conn, translationId);
      if (translation === null) throw notFound('Translation', translationId);
      return translation;
    });
  }

  createTranslationInFolder(conn: SqlExecutor, params: VfsCreateTranslationParams,
    folderId: string | null): VfsTranslation {
    return databaseResult(() => withSavepoint(conn, 'create_translation_in_folder', () => {
      if (folderId !== null && !this.folders.folderExists(conn, folderId)) {
        throw notFound('Folder', folderId);
      }
      const translation = this.createTranslation(conn, params);
      const folderItem: VfsFolderItem = {
        id: `fi_${nanoid(10)}`,
        ...(folderId === null ? {} : { folderId }),
        itemType: 'translation',
        itemId: translation.id,
        sortOrder: 0,
        createdAt: Date.now(),
      };
      this.folders.addItemToFolder(conn, folderItem);
      return translation;
    }));
  }

  deleteTranslationWithFolderItem(conn: SqlExecutor, translationId: string): void {
    this.deleteTranslation(conn, translationId);
  }

  listTranslationsByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsTranslation[] {
    return databaseResult(() => mapTranslations(conn.all<Row>(
      `${SELECT_TRANSLATION_WITH_CONTENT}
       JOIN folder_items fi ON fi.item_type = 'translation' AND fi.item_id = t.id
       WHERE fi.folder_id IS ?1
         AND t.deleted_at IS NULL
         AND fi.deleted_at IS NULL
       ORDER BY fi.sort_order ASC, t.created_at DESC
       LIMIT ?2 OFFSET ?3`,
      [folderId, limit, offset])));
  }

  getTranslationLocation(conn: SqlExecutor, translationId: string): ResourceLocation | null {
    return databaseResult(() => this.folders.getResourceLocation(conn, 'translation', translationId));
  }
}
