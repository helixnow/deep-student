/** Port of dstu-vfs exam_repo.rs. All functions take the caller's connection. */
import { logDebug, logError, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import type { QbankExamCascade } from '../../qbank/api.ts';
import { jsonNumberToRawJSON, objectLastWins, parseJsonDocument, type JsonNode } from '../../../platform/util/portable.ts';
import {
  VfsRepositoryError,
  type ExamRepository,
  type ImportingSession,
  type JsonValue,
  type ResourceLocation,
  type VfsCreateExamSheetParams,
  type VfsExamSheet,
  type VfsFolderItem,
} from '../api.ts';
import { BlobRepo } from './blobs.ts';
import { databaseResult, rollbackIgnoringFailure } from './errors.ts';
import { FolderRepo } from './folders.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { parseOcrPagesJson } from './ocr-utils.ts';
import { QuestionRepo } from './questions.ts';
import { ResourceRepo } from './resources.ts';
import { utcNow, utcTimestamp } from './timestamps.ts';

const EXAM_COLUMNS = `id, resource_id, exam_name, status, temp_id,
  metadata_json, preview_json, linked_mistake_ids, is_favorite, created_at, updated_at`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function serializationMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_SERIALIZATION', `Serialization error: ${message}`);
}
function internalMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INTERNAL', message);
}

function optionalText(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function optionalNumber(value: SqlValue | undefined): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : null;
}
function jsonPageNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
/**
 * `serde_json::Value` (arbitrary_precision, preserve_order): safe integers become numbers, every other
 * number keeps its text as a `JSON.rawJSON` atom, so `1.0` / `1e5` / big integers survive the round trip.
 */
function jsonNodeValue(node: JsonNode): JsonValue {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': case 'string': return node.value;
    case 'number': {
      const number = node.value;
      if ((number.kind === 'u64' || number.kind === 'i64')
        && number.value >= -9007199254740991n && number.value <= 9007199254740991n) return Number(number.value);
      return jsonNumberToRawJSON(number) as unknown as JsonValue;
    }
    case 'array': return node.items.map(jsonNodeValue);
    case 'object': return Object.fromEntries([...objectLastWins(node)].map(([key, value]) => [key, jsonNodeValue(value)]));
  }
}
function parseJsonValue(raw: string | null): JsonValue | undefined {
  if (raw === null) return undefined;
  try { return jsonNodeValue(parseJsonDocument(raw)); }
  catch { return undefined; }
}
function serializeJson(value: JsonValue): string {
  try { return JSON.stringify(value); }
  catch (error) { throw serializationMessage(errorMessage(error)); }
}

function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
function sanitizeSavepointSuffix(id: string): string {
  return [...id].map(character => /[A-Za-z0-9]/.test(character) ? character : '_').join('');
}

function rowToExamSheet(row: Row): VfsExamSheet {
  const resourceId = optionalText(row.resource_id);
  const examName = optionalText(row.exam_name);
  const metadata = parseJsonValue(optionalText(row.metadata_json)) ?? null;
  const preview = parseJsonValue(optionalText(row.preview_json)) ?? null;
  const linkedRaw = optionalText(row.linked_mistake_ids);
  let linkedMistakeIds: string[] | undefined;
  if (linkedRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(linkedRaw);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        linkedMistakeIds = parsed as string[];
      }
    } catch { linkedMistakeIds = undefined; }
  }
  return {
    id: String(row.id),
    ...(resourceId === null ? {} : { resourceId }),
    ...(examName === null ? {} : { examName }),
    status: String(row.status),
    tempId: String(row.temp_id),
    metadataJson: metadata,
    previewJson: preview,
    ...(linkedMistakeIds === undefined ? {} : { linkedMistakeIds }),
    isFavorite: Number(row.is_favorite) !== 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapExamSheets(rows: readonly Row[]): VfsExamSheet[] {
  const exams: VfsExamSheet[] = [];
  for (const row of rows) {
    try { exams.push(rowToExamSheet(row)); }
    catch (error) { logWarn('[VFS::ExamRepo] Row parse error (skipped):', error); }
  }
  return exams;
}

// ------------------------------------------------------------------ qbank helpers

function remapEntityReferences(value: JsonValue, ids: ReadonlyMap<string, string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) remapEntityReferences(item, ids);
    return;
  }
  const object = value as Record<string, JsonValue>;
  for (const key of Object.keys(object)) {
    const child = object[key]!;
    if (key === 'source_id' || key === 'group_id' || key === 'material_id') {
      if (typeof child === 'string') {
        const mapped = ids.get(child);
        if (mapped !== undefined) object[key] = mapped;
      }
    } else {
      remapEntityReferences(child, ids);
    }
  }
}

export class ExamRepo implements ExamRepository {
  private readonly blobs = new BlobRepo();
  private readonly folders = new FolderRepo();
  private readonly resources = new ResourceRepo();
  private readonly questions = new QuestionRepo();
  private readonly resolveQbankCascade: (() => QbankExamCascade | undefined) | undefined;

  constructor(resolveQbankCascade?: () => QbankExamCascade | undefined) {
    this.resolveQbankCascade = resolveQbankCascade;
  }

  private qbankCascade(): QbankExamCascade {
    const owner = this.resolveQbankCascade?.();
    if (owner === undefined) throw internalMessage('qbank.examCascade service is not available');
    return owner;
  }

  listExamSheets(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsExamSheet[] {
    return databaseResult(() => {
      let sql = `SELECT ${EXAM_COLUMNS} FROM exam_sheets WHERE deleted_at IS NULL`;
      const params: (string | number)[] = [];
      let paramIndex = 1;
      if (search !== null) {
        sql += ` AND exam_name LIKE ?${paramIndex} ESCAPE '\\'`;
        params.push(`%${escapeLikePattern(search)}%`);
        paramIndex += 1;
      }
      sql += ` ORDER BY updated_at DESC LIMIT ?${paramIndex} OFFSET ?${paramIndex + 1}`;
      params.push(limit, offset);
      return mapExamSheets(conn.all<Row>(sql, params));
    });
  }

  countExamSheets(conn: SqlExecutor, search: string | null): number {
    return databaseResult(() => {
      const count = search === null
        ? Number(conn.pluck<number>('SELECT COUNT(*) FROM exam_sheets WHERE deleted_at IS NULL') ?? 0)
        : Number(conn.pluck<number>(
          "SELECT COUNT(*) FROM exam_sheets WHERE deleted_at IS NULL AND exam_name LIKE ?1 ESCAPE '\\'",
          [`%${escapeLikePattern(search)}%`]) ?? 0);
      return Math.max(0, count);
    });
  }

  getExamSheet(conn: SqlExecutor, examId: string): VfsExamSheet | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${EXAM_COLUMNS} FROM exam_sheets
        WHERE id = ?1 AND deleted_at IS NULL`, [examId]);
      return row === undefined ? null : rowToExamSheet(row);
    });
  }

  getExamSheetContent(conn: SqlExecutor, examId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT r.data
        FROM exam_sheets e
        JOIN resources r ON e.resource_id = r.id
        WHERE e.id = ?1 AND e.deleted_at IS NULL`, [examId]);
      return row === undefined ? null : optionalText(row.data);
    });
  }

  searchExamSheets(conn: SqlExecutor, query: string, limit: number): VfsExamSheet[] {
    return this.listExamSheets(conn, query, limit, 0);
  }

  createExamSheet(conn: SqlExecutor, params: VfsCreateExamSheetParams): VfsExamSheet {
    return databaseResult(() => {
      const previewContent = serializeJson(params.previewJson);
      try { conn.exec('SAVEPOINT create_exam'); }
      catch (error) {
        logWarn('[VFS::ExamRepo] Failed to create savepoint for create_exam:', error);
        throw databaseMessage(`Failed to create savepoint: ${errorMessage(error)}`);
      }
      let result: { ok: true; exam: VfsExamSheet } | { ok: false; error: unknown };
      try { result = { ok: true, exam: this.createExamSheetInternal(conn, params, previewContent) }; }
      catch (error) { result = { ok: false, error }; }

      if (!result.ok) {
        try { conn.exec('ROLLBACK TO create_exam'); }
        catch (error) { logWarn('[VFS::ExamRepo] create_exam rollback failed:', error); }
        try { conn.exec('RELEASE create_exam'); }
        catch (error) { logWarn('[VFS::ExamRepo] create_exam release failed:', error); }
        throw result.error;
      }
      try { conn.exec('RELEASE create_exam'); }
      catch (error) {
        logWarn('[VFS::ExamRepo] Failed to release savepoint create_exam:', error);
        throw databaseMessage(`Failed to release savepoint: ${errorMessage(error)}`);
      }
      return result.exam;
    });
  }

  private createExamSheetInternal(conn: SqlExecutor, params: VfsCreateExamSheetParams,
    previewContent: string): VfsExamSheet {
    const resource = this.resources.createOrReuse(conn, 'exam', previewContent, null, 'exam_sheets', null);
    const examId = `exam_${nanoid(10)}`;
    const now = utcTimestamp();
    const metadataStr = serializeJson(params.metadataJson);
    const previewStr = serializeJson(params.previewJson);
    const status = params.status ?? 'pending';
    const examName = params.examName ?? null;
    conn.run(`INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id,
        metadata_json, preview_json, linked_mistake_ids, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)`,
    [examId, resource.resourceId, examName, status, params.tempId, metadataStr,
      previewStr, now, now]);
    conn.run('UPDATE resources SET source_id = COALESCE(source_id, ?1) WHERE id = ?2',
      [examId, resource.resourceId]);

    const folderId = params.folderId ?? null;
    if (folderId !== null) {
      const folderItem: VfsFolderItem = {
        id: `fi_${nanoid(10)}`,
        folderId,
        itemType: 'exam',
        itemId: examId,
        sortOrder: 0,
        createdAt: Date.now(),
      };
      try { this.folders.addItemToFolder(conn, folderItem); }
      catch (error) {
        throw databaseMessage(`Failed to add exam ${examId} to folder ${folderId}: ${errorMessage(error)}`);
      }
    }

    return {
      id: examId,
      resourceId: resource.resourceId,
      ...(examName === null ? {} : { examName }),
      status,
      tempId: params.tempId,
      metadataJson: params.metadataJson,
      previewJson: params.previewJson,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  copyExamSheet(conn: SqlExecutor, srcExamId: string, folderId: string | null): VfsExamSheet {
    return databaseResult(() => {
      const src = this.getExamSheet(conn, srcExamId);
      if (src === null) throw notFound('ExamSheet', srcExamId);
      const sharedHashes = this.collectExamBlobHashes(conn, srcExamId);
      conn.exec('SAVEPOINT copy_exam');
      let result: { ok: true; exam: VfsExamSheet } | { ok: false; error: unknown };
      try {
        for (const hash of sharedHashes) this.blobs.incrementRef(conn, hash);
        const newTempId = `copy_${nanoid(10)}`;
        const newExam = this.createExamSheet(conn, {
          examName: src.examName === undefined ? null : `${src.examName} (副本)`,
          tempId: newTempId,
          metadataJson: src.metadataJson,
          previewJson: src.previewJson,
          status: src.status,
          folderId,
        });
        const entityMap = this.copyAuthoringEntities(conn, srcExamId, newExam.id);
        this.copyQuestions(conn, srcExamId, newExam.id, entityMap);
        try { this.refreshCanonicalPreview(conn, newExam.id); }
        catch (error) { throw internalMessage(errorMessage(error)); }
        this.questions.refreshStats(conn, newExam.id);
        result = { ok: true, exam: newExam };
      } catch (error) {
        result = { ok: false, error };
      }

      if (!result.ok) {
        try { conn.exec('ROLLBACK TO copy_exam'); }
        catch (error) { logWarn('[VFS::ExamRepo] copy_exam rollback failed:', error); }
        try { conn.exec('RELEASE copy_exam'); }
        catch (error) { logWarn('[VFS::ExamRepo] copy_exam release failed:', error); }
        logError(`[VFS::ExamRepo] Failed to copy exam ${srcExamId}:`, result.error);
        throw result.error;
      }
      conn.exec('RELEASE copy_exam');
      return result.exam;
    });
  }

  private copyQuestions(conn: SqlExecutor, srcExamId: string, targetExamId: string,
    entityMap: ReadonlyMap<string, string>): void {
    const now = utcTimestamp();
    const rows = conn.all<Row>(`SELECT id, card_id, question_label, content, options_json, answer,
        explanation, question_type, difficulty, tags, images_json
      FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL`, [srcExamId]);
    const questionMap = new Map<string, string>();
    for (const row of rows) {
      let oldId: string;
      let cardId: string | null;
      let questionLabel: string | null;
      let content: string;
      let optionsJson: string | null;
      let answer: string | null;
      let explanation: string | null;
      let questionType: string | null;
      let difficulty: string | null;
      let tags: string | null;
      let imagesJson: string | null;
      try {
        oldId = String(row.id);
        cardId = optionalText(row.card_id);
        questionLabel = optionalText(row.question_label);
        content = String(row.content);
        optionsJson = optionalText(row.options_json);
        answer = optionalText(row.answer);
        explanation = optionalText(row.explanation);
        questionType = optionalText(row.question_type);
        difficulty = optionalText(row.difficulty);
        tags = optionalText(row.tags);
        imagesJson = optionalText(row.images_json);
      } catch (error) {
        logWarn('[VFS::ExamRepo] Question row parse error (skipped):', error);
        continue;
      }

      const newId = `q_${nanoid(16)}`;
      conn.run(`INSERT INTO questions (id, exam_id, card_id, question_label, content,
          options_json, answer, explanation, question_type,
          difficulty, tags, images_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, '[]'), COALESCE(?12, '[]'), ?13, ?13)`,
      [newId, targetExamId, cardId, questionLabel, content, optionsJson, answer,
        explanation, questionType, difficulty, tags, imagesJson, now]);

      conn.run(`UPDATE questions SET card_id=id,
          structured_data=(SELECT structured_data FROM questions WHERE id=?1),
          source_type=(SELECT source_type FROM questions WHERE id=?1),
          source_ref=(SELECT source_ref FROM questions WHERE id=?1),
          provenance_json=(SELECT provenance_json FROM questions WHERE id=?1),
          answer_origin=(SELECT answer_origin FROM questions WHERE id=?1),
          group_position=(SELECT group_position FROM questions WHERE id=?1)
        WHERE id=?2`, [oldId, newId]);

      const oldGroup = conn.pluck<string | null>(
        'SELECT group_id FROM questions WHERE id=?1', [oldId]) ?? null;
      if (oldGroup !== null) {
        const newGroup = entityMap.get(oldGroup);
        if (newGroup === undefined) throw internalMessage('复制时题组依赖缺失');
        conn.run('UPDATE questions SET group_id=?1 WHERE id=?2', [newGroup, newId]);
      }

      for (const column of ['source_ref', 'provenance_json']) {
        const raw = conn.pluck<string | null>(
          `SELECT ${column} FROM questions WHERE id=?1`, [newId]) ?? null;
        if (raw !== null) {
          let value: JsonValue | undefined;
          try { value = JSON.parse(raw) as JsonValue; }
          catch { value = undefined; }
          if (value !== undefined) {
            remapEntityReferences(value, entityMap);
            conn.run(`UPDATE questions SET ${column}=?1 WHERE id=?2`, [JSON.stringify(value), newId]);
          }
        }
      }
      questionMap.set(oldId, newId);
    }

    for (const [oldId, newId] of questionMap) {
      const parent = conn.pluck<string | null>(
        'SELECT parent_id FROM questions WHERE id=?1', [oldId]) ?? null;
      if (parent !== null) {
        const mapped = questionMap.get(parent);
        if (mapped !== undefined) {
          conn.run('UPDATE questions SET parent_id=?1 WHERE id=?2', [mapped, newId]);
        }
      }
    }
  }

  private copyAuthoringEntities(conn: SqlExecutor, src: string, target: string): Map<string, string> {
    try { return this.qbankCascade().copyAuthoringEntitiesWithConn(conn, src, target, utcNow()); }
    catch (error) {
      // The owner propagates JSON parse errors; preserve the Rust VfsError serialization wrapper.
      if (error instanceof SyntaxError) throw serializationMessage(errorMessage(error));
      throw error;
    }
  }

  private collectExamBlobHashes(conn: SqlExecutor, examId: string): string[] {
    const hashes: string[] = [];
    const previewRow = conn.get<Row>(
      'SELECT preview_json FROM exam_sheets WHERE id = ?1', [examId]);
    const previewRaw = previewRow === undefined ? null : optionalText(previewRow.preview_json);
    if (previewRaw !== null) {
      try {
        const preview = JSON.parse(previewRaw) as JsonValue;
        if (preview !== null && typeof preview === 'object' && !Array.isArray(preview)) {
          const pages = (preview as Record<string, JsonValue>).pages;
          if (Array.isArray(pages)) {
            for (const page of pages) {
              if (page === null || typeof page !== 'object' || Array.isArray(page)) continue;
              const hash = (page as Record<string, JsonValue>).blob_hash;
              if (typeof hash === 'string' && hash !== '') hashes.push(hash);
            }
          }
        }
      } catch (error) {
        logWarn('[VFS::ExamRepo] Failed to parse preview_json for blob collection:', error);
      }
    }

    const imageRows = conn.all<Row>(
      "SELECT images_json FROM questions WHERE exam_id = ?1 AND images_json IS NOT NULL AND images_json != '[]'",
      [examId]);
    for (const row of imageRows) {
      try {
        const images = JSON.parse(String(row.images_json)) as JsonValue;
        if (Array.isArray(images)) {
          for (const image of images) {
            if (image === null || typeof image !== 'object' || Array.isArray(image)) continue;
            const hash = (image as Record<string, JsonValue>).hash;
            if (typeof hash === 'string' && hash !== '') hashes.push(hash);
          }
        }
      } catch (error) {
        logWarn('[VFS::ExamRepo] Failed to parse question images_json:', error);
      }
    }

    const materialRows = conn.all<Row>(
      'SELECT images_json FROM qbank_materials WHERE exam_id=?1', [examId]);
    for (const row of materialRows) {
      const value = JSON.parse(String(row.images_json)) as JsonValue;
      if (Array.isArray(value)) {
        for (const image of value) {
          if (image === null || typeof image !== 'object' || Array.isArray(image)) continue;
          const hash = (image as Record<string, JsonValue>).hash;
          if (typeof hash === 'string') hashes.push(hash);
        }
      }
    }

    const sourceRows = conn.all<Row>(
      'SELECT descriptor_json FROM qbank_sources WHERE exam_id=?1', [examId]);
    for (const row of sourceRows) {
      const value = JSON.parse(String(row.descriptor_json)) as JsonValue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const hash = (value as Record<string, JsonValue>).blob_hash;
        if (typeof hash === 'string') hashes.push(hash);
      }
    }
    return hashes;
  }

  private refreshCanonicalPreview(conn: SqlExecutor, examId: string): void {
    const row = conn.get<Row>('SELECT preview_json FROM exam_sheets WHERE id=?1', [examId]);
    if (row === undefined) throw databaseMessage('query returned no rows');
    const raw = optionalText(row.preview_json);
    let preview: JsonValue;
    if (raw === null) preview = { pages: [] };
    else {
      try { preview = JSON.parse(raw) as JsonValue; }
      catch { preview = { pages: [] }; }
    }
    if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
      preview = { pages: [] };
    }
    const previewObject = preview as Record<string, JsonValue>;
    if (!Array.isArray(previewObject.pages)) previewObject.pages = [];
    const pages = previewObject.pages as JsonValue[];
    for (const page of pages) {
      if (page !== null && typeof page === 'object' && !Array.isArray(page)) {
        (page as Record<string, JsonValue>).cards = [];
      }
    }

    const sourcePages = new Map<string, number>();
    const descriptorRows = conn.all<Row>(
      `SELECT id,descriptor_json FROM qbank_sources
       WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,id`, [examId]);
    for (const descriptorRow of descriptorRows) {
      const source = String(descriptorRow.id);
      const descriptor = JSON.parse(String(descriptorRow.descriptor_json)) as JsonValue;
      if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) continue;
      const descriptorPages = (descriptor as Record<string, JsonValue>).pages;
      if (!Array.isArray(descriptorPages)) continue;
      for (const page of descriptorPages) {
        if (page === null || typeof page !== 'object' || Array.isArray(page)) continue;
        const pageObject = page as Record<string, JsonValue>;
        const hash = pageObject.blob_hash;
        if (typeof hash !== 'string') throw internalMessage('来源页面缺少blob_hash');
        let index = pages.findIndex(candidate => candidate !== null
          && typeof candidate === 'object' && !Array.isArray(candidate)
          && (candidate as Record<string, JsonValue>).blob_hash === hash);
        if (index < 0) {
          index = pages.length;
          pages.push({
            page_index: index,
            blob_hash: hash,
            width: pageObject.width ?? null,
            height: pageObject.height ?? null,
            cards: [],
            ocr_completed: true,
            parse_completed: true,
          });
        }
        const pageNumber = jsonPageNumber(pageObject.page) ?? 1;
        sourcePages.set(`${source}:${pageNumber}`, index);
      }
    }

    if (pages.length === 0) previewObject.pages = [{ page_index: 0, cards: [] }];
    const activePages = previewObject.pages as JsonValue[];

    const questionRows = conn.all<Row>(
      `SELECT COALESCE(card_id,id),question_label,content,question_type,answer,explanation,
              options_json,structured_data,images_json,provenance_json,group_id
       FROM questions WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,rowid`,
      [examId]);
    for (const questionRow of questionRows) {
      const id = String(questionRow['COALESCE(card_id,id)'] ?? questionRow.id ?? '');
      const label = optionalText(questionRow.question_label);
      const content = String(questionRow.content);
      const kind = String(questionRow.question_type);
      const answer = optionalText(questionRow.answer);
      const explanation = optionalText(questionRow.explanation);
      const options = parseJsonValue(optionalText(questionRow.options_json));
      const structured = parseJsonValue(optionalText(questionRow.structured_data));
      const images = parseJsonValue(optionalText(questionRow.images_json)) ?? [];
      const provenance = parseJsonValue(optionalText(questionRow.provenance_json));
      const group = optionalText(questionRow.group_id);

      let reference: JsonValue = null;
      if (provenance !== null && provenance !== undefined && typeof provenance === 'object'
        && !Array.isArray(provenance)) {
        const refs = (provenance as Record<string, JsonValue>).source_refs;
        if (Array.isArray(refs) && refs.length > 0) reference = refs[0]!;
      }
      let sourceId = '';
      let pageNumber = 1;
      if (reference !== null && typeof reference === 'object' && !Array.isArray(reference)) {
        const referenceObject = reference as Record<string, JsonValue>;
        if (typeof referenceObject.source_id === 'string') sourceId = referenceObject.source_id;
        pageNumber = jsonPageNumber(referenceObject.page) ?? 1;
      }
      let pageIndex = sourcePages.get(`${sourceId}:${pageNumber}`) ?? 0;
      pageIndex = Math.min(pageIndex, activePages.length - 1);
      const targetPage = activePages[pageIndex];
      if (targetPage === null || typeof targetPage !== 'object' || Array.isArray(targetPage)) continue;
      const targetObject = targetPage as Record<string, JsonValue>;
      if (!Array.isArray(targetObject.cards)) targetObject.cards = [];
      (targetObject.cards as JsonValue[]).push({
        card_id: id,
        question_label: label ?? '',
        ocr_text: content,
        question_type: kind,
        answer,
        explanation,
        options: options ?? null,
        structured_data: structured ?? null,
        images,
        group_id: group,
        page_index: pageIndex,
      });
    }

    this.updatePreviewJson(conn, examId, previewObject);
  }

  createExamSheetLegacy(conn: SqlExecutor, examName: string | null, tempId: string,
    status: string, metadataJson: JsonValue, previewJson: JsonValue): VfsExamSheet {
    return this.createExamSheet(conn, {
      examName, tempId, metadataJson, previewJson, status, folderId: null,
    });
  }

  upsertExamSheet(conn: SqlExecutor, params: VfsCreateExamSheetParams, examId: string | null): VfsExamSheet {
    return databaseResult(() => {
      const now = utcTimestamp();
      let existing: VfsExamSheet | null = null;
      if (examId !== null) {
        existing = this.getExamSheet(conn, examId);
      } else {
        let existingId: string | null = null;
        try {
          existingId = conn.pluck<string | null>(
            'SELECT id FROM exam_sheets WHERE temp_id = ?1 LIMIT 1', [params.tempId]) ?? null;
        } catch (error) {
          logWarn('[VFS::ExamRepo] Failed to find exam by temp_id:', error);
        }
        if (existingId !== null) {
          try { existing = this.getExamSheet(conn, existingId); }
          catch (error) { logWarn('[VFS::ExamRepo] Failed to load existing exam:', error); }
        }
      }

      if (existing === null) return this.createExamSheet(conn, params);

      const metadataStr = serializeJson(params.metadataJson);
      const previewStr = serializeJson(params.previewJson);
      conn.run(`UPDATE exam_sheets
        SET exam_name = ?1, status = ?2, metadata_json = ?3, preview_json = ?4, updated_at = ?5
        WHERE id = ?6`,
      [params.examName ?? null, params.status ?? 'pending', metadataStr, previewStr,
        now, existing.id]);
      if (existing.resourceId !== undefined) {
        const previewContent = serializeJson(params.previewJson);
        this.resources.updateResourceData(conn, existing.resourceId, previewContent);
      }
      return {
        id: existing.id,
        ...(existing.resourceId === undefined ? {} : { resourceId: existing.resourceId }),
        ...(params.examName === undefined || params.examName === null ? {} : { examName: params.examName }),
        status: params.status ?? 'pending',
        tempId: params.tempId,
        metadataJson: params.metadataJson,
        previewJson: params.previewJson,
        ...(existing.linkedMistakeIds === undefined ? {} : { linkedMistakeIds: existing.linkedMistakeIds }),
        isFavorite: existing.isFavorite,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    });
  }

  updateLinkedMistakes(conn: SqlExecutor, examId: string,
    linkedMistakeIds: readonly string[] | null): void {
    databaseResult(() => {
      let linked: string | null = null;
      if (linkedMistakeIds !== null) {
        try { linked = JSON.stringify(linkedMistakeIds); }
        catch { linked = '[]'; }
      }
      const updated = conn.run(
        'UPDATE exam_sheets SET linked_mistake_ids = ?1, updated_at = ?2 WHERE id = ?3',
        [linked, utcTimestamp(), examId]).changes;
      if (updated === 0) throw notFound('ExamSheet', examId);
    });
  }

  updateExamName(conn: SqlExecutor, examId: string, newName: string): VfsExamSheet {
    return databaseResult(() => {
      const updated = conn.run(
        'UPDATE exam_sheets SET exam_name = ?1, updated_at = ?2 WHERE id = ?3',
        [newName, utcTimestamp(), examId]).changes;
      if (updated === 0) throw notFound('ExamSheet', examId);
      const exam = this.getExamSheet(conn, examId);
      if (exam === null) throw notFound('ExamSheet', examId);
      return exam;
    });
  }

  setFavorite(conn: SqlExecutor, examId: string, favorite: boolean): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE exam_sheets SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [favorite ? 1 : 0, utcTimestamp(), examId]).changes;
      if (updated === 0) throw notFound('ExamSheet', examId);
    });
  }

  updateStatus(conn: SqlExecutor, examId: string, status: string): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE exam_sheets SET status = ?1, updated_at = ?2 WHERE id = ?3',
        [status, utcTimestamp(), examId]).changes;
      if (updated === 0) throw notFound('ExamSheet', examId);
    });
  }

  deleteExamSheet(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const batch = `exam_delete_${nanoid(16)}`;
      conn.exec('SAVEPOINT qbank_delete_exam');
      let failure: unknown = null;
      try {
        const updated = conn.run(
          'UPDATE exam_sheets SET deleted_at = ?1, updated_at = ?1, deletion_batch=?3 WHERE id = ?2 AND deleted_at IS NULL',
          [now, examId, batch]).changes;
        if (updated === 0) {
          let alreadyDeleted = false;
          try {
            alreadyDeleted = Number(conn.pluck<number>(
              'SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NOT NULL)',
              [examId]) ?? 0) !== 0;
          } catch (error) {
            logWarn('[VFS::ExamRepo] Failed to check soft-delete state:', error);
          }
          if (!alreadyDeleted) throw notFound('ExamSheet', examId);
        }
        if (updated > 0) {
          conn.run(`UPDATE questions SET deleted_at=?1,updated_at=?1,deletion_batch=?3
            WHERE exam_id=?2 AND deleted_at IS NULL`, [now, examId, batch]);
          this.qbankCascade().softDeleteForExamWithConn(conn, examId, now, batch);
          conn.run(`UPDATE folder_items SET deleted_at=?1,updated_at=?1
            WHERE item_type='exam' AND item_id=?2 AND deleted_at IS NULL`,
          [Date.now(), examId]);
        }
      } catch (error) { failure = error; }

      if (failure !== null) {
        try { conn.exec('ROLLBACK TO qbank_delete_exam; RELEASE qbank_delete_exam'); }
        catch (error) { logWarn('[VFS::ExamRepo] delete exam rollback failed:', error); }
        throw failure;
      }
      conn.exec('RELEASE qbank_delete_exam');
    });
  }

  purgeExamSheet(conn: SqlExecutor, blobsDir: string, examId: string): void {
    databaseResult(() => {
      this.purgeExamSheetWithConn(conn, examId);
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) {
        logWarn('[VFS::ExamRepo] Post-purge blob sweep failed (will retry on next sweep):', error);
      }
    });
  }

  purgeExamSheetWithConn(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      const savepoint = `purge_exam_${sanitizeSavepointSuffix(examId)}`;
      conn.exec(`SAVEPOINT ${savepoint}`);
      let failure: unknown = null;
      try {
        const resourceRow = conn.get<Row>(
          'SELECT resource_id FROM exam_sheets WHERE id = ?1', [examId]);
        const resourceId = resourceRow === undefined ? null : optionalText(resourceRow.resource_id);

        let blobHashes: string[] = [];
        try { blobHashes = this.collectExamBlobHashes(conn, examId); }
        catch (error) {
          logWarn(`[VFS::ExamRepo] Failed to collect blob hashes for exam ${examId} (blobs may leak):`, error);
        }

        conn.run("DELETE FROM folder_items WHERE item_type = 'exam' AND item_id = ?1", [examId]);
        conn.run('DELETE FROM review_history WHERE plan_id IN (SELECT id FROM review_plans WHERE exam_id = ?1)',
          [examId]);
        conn.run('DELETE FROM review_plans WHERE exam_id = ?1', [examId]);
        conn.run('DELETE FROM question_sync_conflicts WHERE exam_id = ?1', [examId]);
        conn.run('DELETE FROM question_sync_logs WHERE exam_id = ?1', [examId]);
        conn.run('DELETE FROM answer_submissions WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?1)',
          [examId]);
        conn.run('DELETE FROM question_history WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?1)',
          [examId]);
        conn.run('DELETE FROM question_bank_stats WHERE exam_id = ?1', [examId]);
        conn.run('DELETE FROM questions WHERE exam_id = ?1', [examId]);
        const deleted = conn.run('DELETE FROM exam_sheets WHERE id = ?1', [examId]).changes;
        if (deleted === 0) throw notFound('ExamSheet', examId);

        if (resourceId !== null) {
          const remainingRefs = Number(conn.pluck<number>(
            'SELECT COUNT(*) FROM exam_sheets WHERE resource_id = ?1', [resourceId]) ?? 0);
          if (remainingRefs === 0) {
            purgeIndexArtifactsByResource(conn, resourceId);
            conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
          }
        }

        for (const hash of blobHashes) {
          if (this.qbankCascade().retainsAssetWithConn(conn, hash)) continue;
          try { this.blobs.decrementRef(conn, hash); }
          catch (error) {
            if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') {
              logDebug(`[VFS::ExamRepo] Exam blob ${hash} already gone, skipping`);
            } else {
              logWarn(`[VFS::ExamRepo] Failed to decrement exam blob ${hash}:`, error);
            }
          }
        }
      } catch (error) { failure = error; }

      if (failure !== null) {
        try { conn.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); }
        catch (error) { logWarn('[VFS::ExamRepo] purge exam rollback failed:', error); }
        throw failure;
      }
      conn.exec(`RELEASE ${savepoint}`);
    });
  }

  restoreExam(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const savepoint = `restore_exam_${sanitizeSavepointSuffix(examId)}`;
      conn.exec(`SAVEPOINT ${savepoint}`);
      let failure: unknown = null;
      try {
        const batchRow = conn.get<Row>(
          'SELECT deletion_batch,deleted_at FROM exam_sheets WHERE id=?1', [examId]);
        if (batchRow === undefined) throw databaseMessage('query returned no rows');
        const batch = optionalText(batchRow.deletion_batch);
        const deletedAt = optionalText(batchRow.deleted_at);

        const updated = conn.run(
          'UPDATE exam_sheets SET deleted_at = NULL, deletion_batch=NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL',
          [now, examId]).changes;
        if (updated === 0) throw notFound('ExamSheet', examId);

        conn.run(`UPDATE folder_items SET deleted_at = NULL, updated_at = ?1
          WHERE item_type = 'exam' AND item_id = ?2 AND deleted_at IS NOT NULL`,
        [Date.now(), examId]);

        conn.run(`UPDATE questions SET deleted_at = NULL, deletion_batch=NULL, updated_at = ?1
          WHERE exam_id = ?2 AND deleted_at IS NOT NULL
            AND ((?3 IS NOT NULL AND deletion_batch=?3) OR (?3 IS NULL AND deleted_at=?4))`,
        [now, examId, batch, deletedAt]);
        this.qbankCascade().restoreForExamWithConn(conn, examId, now, batch);
      } catch (error) { failure = error; }

      if (failure !== null) {
        try { conn.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); }
        catch (error) { logWarn('[VFS::ExamRepo] restore exam rollback failed:', error); }
        throw failure;
      }
      conn.exec(`RELEASE ${savepoint}`);
    });
  }

  listDeletedExams(conn: SqlExecutor, limit: number, offset: number): VfsExamSheet[] {
    return databaseResult(() => mapExamSheets(conn.all<Row>(`SELECT ${EXAM_COLUMNS}
      FROM exam_sheets
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`, [limit, offset])));
  }

  listAllExamSheets(conn: SqlExecutor): VfsExamSheet[] {
    return databaseResult(() => mapExamSheets(conn.all<Row>(`SELECT ${EXAM_COLUMNS}
      FROM exam_sheets ORDER BY created_at ASC`)));
  }

  updatePreviewJson(conn: SqlExecutor, examId: string, previewJson: JsonValue): void {
    databaseResult(() => {
      let previewStr: string;
      try { previewStr = JSON.stringify(previewJson); }
      catch (error) {
        throw serializationMessage(`Failed to serialize preview_json: ${errorMessage(error)}`);
      }
      const affected = conn.run(
        'UPDATE exam_sheets SET preview_json = ?1, updated_at = ?2 WHERE id = ?3',
        [previewStr, utcTimestamp(), examId]).changes;
      if (affected === 0) throw notFound('ExamSheet', examId);
      const resourceRow = conn.get<Row>(
        'SELECT resource_id FROM exam_sheets WHERE id = ?1', [examId]);
      const resourceId = resourceRow === undefined ? null : optionalText(resourceRow.resource_id);
      if (resourceId !== null) this.resources.updateResourceData(conn, resourceId, previewStr);
    });
  }

  updatePreviewJsonIfUnchanged(conn: SqlExecutor, examId: string, previewJson: JsonValue,
    expectedUpdatedAt: string): boolean {
    return databaseResult(() => {
      let previewStr: string;
      try { previewStr = JSON.stringify(previewJson); }
      catch (error) {
        throw serializationMessage(`Failed to serialize preview_json: ${errorMessage(error)}`);
      }
      const affected = conn.run(
        'UPDATE exam_sheets SET preview_json = ?1, updated_at = ?2 WHERE id = ?3 AND updated_at = ?4',
        [previewStr, utcTimestamp(), examId, expectedUpdatedAt]).changes;
      if (affected === 0) {
        const exists = conn.get<Row>('SELECT id FROM exam_sheets WHERE id = ?1', [examId]);
        if (exists !== undefined) return false;
        throw notFound('ExamSheet', examId);
      }
      const resourceRow = conn.get<Row>(
        'SELECT resource_id FROM exam_sheets WHERE id = ?1', [examId]);
      const resourceId = resourceRow === undefined ? null : optionalText(resourceRow.resource_id);
      if (resourceId !== null) this.resources.updateResourceData(conn, resourceId, previewStr);
      return true;
    });
  }

  updateImportState(conn: SqlExecutor, examId: string, importStateJson: JsonValue): void {
    databaseResult(() => {
      let stateStr: string;
      try { stateStr = JSON.stringify(importStateJson); }
      catch (error) {
        throw serializationMessage(`Failed to serialize import_state_json: ${errorMessage(error)}`);
      }
      conn.run(
        'UPDATE exam_sheets SET import_state_json = ?1, updated_at = ?2 WHERE id = ?3',
        [stateStr, utcTimestamp(), examId]);
    });
  }

  clearImportState(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      conn.run(
        'UPDATE exam_sheets SET import_state_json = NULL, updated_at = ?1 WHERE id = ?2',
        [utcTimestamp(), examId]);
    });
  }

  /** qbank_legacy_reconcile.rs:695-699: stored text as is, `updated_at` untouched, missing row ignored. */
  setImportStateRaw(conn: SqlExecutor, examId: string, importStateJson: string | null): void {
    databaseResult(() => {
      conn.run('UPDATE exam_sheets SET import_state_json=?1 WHERE id=?2', [importStateJson, examId]);
    });
  }

  /**
   * qbank_authoring_service.rs:534 commit tail: one statement, `updated_at` untouched,
   * other metadata keys left as stored text; a missing row is not an error.
   */
  markQuestionDocumentCompleted(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      conn.run(
        "UPDATE exam_sheets SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.question_document_version',2),status='completed',import_state_json=NULL WHERE id=?1",
        [examId]);
    });
  }

  listImportingSessions(conn: SqlExecutor): ImportingSession[] {
    return databaseResult(() => {
      const rows = conn.all<Row>(`SELECT id, exam_name, import_state_json,
          (SELECT COUNT(*) FROM questions WHERE exam_id = exam_sheets.id AND deleted_at IS NULL) as question_count
        FROM exam_sheets
        WHERE status = 'importing' AND deleted_at IS NULL`);
      const sessions: ImportingSession[] = [];
      for (const row of rows) {
        try {
          sessions.push({
            session_id: String(row.id),
            exam_name: optionalText(row.exam_name),
            import_state_json: optionalText(row.import_state_json),
            existing_question_count: Number(row.question_count),
          });
        } catch (error) {
          logWarn('[VFS::ExamRepo] list_importing_sessions row error:', error);
        }
      }
      return sessions;
    });
  }

  getImportState(conn: SqlExecutor, examId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        'SELECT import_state_json FROM exam_sheets WHERE id = ?1', [examId]);
      return row === undefined ? null : optionalText(row.import_state_json);
    });
  }

  createExamSheetInFolder(conn: SqlExecutor, params: VfsCreateExamSheetParams,
    folderId: string | null): VfsExamSheet {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        if (folderId !== null && !this.folders.folderExists(conn, folderId)) {
          throw notFound('Folder', folderId);
        }
        const exam = this.createExamSheet(conn, params);
        const folderItem: VfsFolderItem = {
          id: `fi_${nanoid(10)}`,
          ...(folderId === null ? {} : { folderId }),
          itemType: 'exam',
          itemId: exam.id,
          sortOrder: 0,
          createdAt: Date.now(),
        };
        this.folders.addItemToFolder(conn, folderItem);
        conn.exec('COMMIT');
        return exam;
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
    });
  }

  deleteExamSheetWithFolderItem(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      const nowStr = utcTimestamp();
      const nowMs = Date.now();
      const savepoint = `delete_exam_${sanitizeSavepointSuffix(examId)}`;
      conn.exec(`SAVEPOINT ${savepoint}`);
      let failure: unknown = null;
      try {
        conn.run(`UPDATE questions SET deleted_at = ?1, updated_at = ?1
          WHERE exam_id = ?2 AND deleted_at IS NULL`, [nowStr, examId]);
        this.deleteExamSheet(conn, examId);
        conn.run(`UPDATE folder_items SET deleted_at = ?1, updated_at = ?2
          WHERE item_type = 'exam' AND item_id = ?3 AND deleted_at IS NULL`,
        [nowStr, nowMs, examId]);
      } catch (error) { failure = error; }

      if (failure !== null) {
        try { conn.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); }
        catch (error) { logWarn('[VFS::ExamRepo] delete exam with folder item rollback failed:', error); }
        throw failure;
      }
      conn.exec(`RELEASE ${savepoint}`);
    });
  }

  listExamSheetsByFolder(conn: SqlExecutor, folderId: string | null, limit: number,
    offset: number): VfsExamSheet[] {
    return databaseResult(() => mapExamSheets(conn.all<Row>(`
      SELECT e.id, e.resource_id, e.exam_name, e.status, e.temp_id,
             e.metadata_json, e.preview_json, e.linked_mistake_ids, e.is_favorite, e.created_at, e.updated_at
      FROM exam_sheets e
      JOIN folder_items fi ON fi.item_type = 'exam' AND fi.item_id = e.id
      WHERE fi.folder_id IS ?1 AND e.deleted_at IS NULL AND fi.deleted_at IS NULL
      ORDER BY fi.sort_order ASC, e.updated_at DESC
      LIMIT ?2 OFFSET ?3`, [folderId, limit, offset])));
  }

  getExamSheetLocation(conn: SqlExecutor, examId: string): ResourceLocation | null {
    return databaseResult(() => this.folders.getResourceLocation(conn, 'exam', examId));
  }

  saveOcrPages(conn: SqlExecutor, examId: string, ocrPages: readonly (string | null)[]): void {
    databaseResult(() => {
      let ocrJson: string;
      try { ocrJson = JSON.stringify(ocrPages); }
      catch (error) { throw serializationMessage(errorMessage(error)); }
      const updated = conn.run(
        'UPDATE exam_sheets SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3',
        [ocrJson, utcTimestamp(), examId]).changes;
      if (updated === 0) throw notFound('ExamSheet', examId);
    });
  }

  savePageOcr(conn: SqlExecutor, examId: string, pageIndex: number, ocrText: string): void {
    databaseResult(() => {
      const row = conn.get<Row>(
        'SELECT ocr_pages_json FROM exam_sheets WHERE id = ?1', [examId]);
      const existing = row === undefined ? null : optionalText(row.ocr_pages_json);
      const pages = existing === null ? [] : parseOcrPagesJson(existing);
      while (pages.length <= pageIndex) pages.push(null);
      pages[pageIndex] = ocrText;
      this.saveOcrPages(conn, examId, pages);
    });
  }

  getOcrPages(conn: SqlExecutor, examId: string): (string | null)[] {
    return databaseResult(() => {
      const row = conn.get<Row>(
        'SELECT ocr_pages_json FROM exam_sheets WHERE id = ?1', [examId]);
      const existing = row === undefined ? null : optionalText(row.ocr_pages_json);
      return existing === null ? [] : parseOcrPagesJson(existing);
    });
  }

  getPageOcr(conn: SqlExecutor, examId: string, pageIndex: number): string | null {
    const pages = this.getOcrPages(conn, examId);
    return pageIndex < pages.length ? pages[pageIndex] ?? null : null;
  }

  getMmIndexState(conn: SqlExecutor, examId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        'SELECT mm_index_state FROM exam_sheets WHERE id = ?1', [examId]);
      return row === undefined ? null : optionalText(row.mm_index_state);
    });
  }

  setMmIndexState(conn: SqlExecutor, examId: string, state: string, error: string | null): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE exam_sheets SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4',
        [state, error, utcTimestamp(), examId]).changes;
      if (updated === 0) throw notFound('ExamSheet', examId);
    });
  }

  applyMultimodalIndexState(conn: SqlExecutor, examId: string, state: string,
    indexedPagesJsonOrError: string | null, embeddingDim: number): void {
    databaseResult(() => {
      // multimodal_service.rs:1645-1658: exam_sheets also stores
      // mm_embedding_dim/mm_indexed_at only on the `indexed` branch.
      const now = utcTimestamp();
      if (state === 'indexed') {
        conn.run(
          `UPDATE exam_sheets SET mm_index_state = ?1, mm_indexed_pages_json = ?2,
                  mm_embedding_dim = ?3, mm_indexed_at = ?4, updated_at = ?4 WHERE id = ?5`,
          [state, indexedPagesJsonOrError, embeddingDim, now, examId]);
      } else if (state === 'failed') {
        conn.run(
          'UPDATE exam_sheets SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4',
          [state, indexedPagesJsonOrError, now, examId]);
      } else {
        conn.run(
          'UPDATE exam_sheets SET mm_index_state = ?1, updated_at = ?2 WHERE id = ?3',
          [state, now, examId]);
      }
    });
  }

  saveMmIndexMetadata(conn: SqlExecutor, examId: string, indexedPagesJson: string,
    embeddingDim: number, indexingMode: string): void {
    databaseResult(() => {
      const nowMs = Date.now();
      const nowStr = utcTimestamp();
      conn.run(`UPDATE exam_sheets
        SET mm_indexed_pages_json = ?1, mm_embedding_dim = ?2, mm_indexing_mode = ?3,
            mm_indexed_at = ?4, mm_index_state = 'indexed', updated_at = ?5
        WHERE id = ?6`,
      [indexedPagesJson, embeddingDim, indexingMode, nowMs, nowStr, examId]);
    });
  }
}
