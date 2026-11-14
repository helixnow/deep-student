/** Draft/material persistence for qbank_authoring_service.rs. */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import type {
  DraftGroup, DraftMaterial, DraftQuestion, QuestionDocument, QuestionImage, QuestionMaterial, SourceRef,
} from '../api.ts';
import type { JsonValue, QuestionImage as VfsQuestionImage } from '../../vfs-repos/api.ts';
import { requireQuestions, type QbankPorts } from '../src/ports.ts';
import { questionDocument } from './authoring-decode.ts';
import { questionImage, sourceRef } from './practice-decode.ts';
import { fromStr, fromValueStr, json, vec } from './serde-decode.ts';
import { toDifficulty, toQuestionType } from '../src/question-enums.ts';

export class AuthoringConflict extends Error {}
export class AuthoringNotFound extends Error {}
export class AuthoringValidation extends Error {}

export interface AuthoringDraft {
  job_id: string; exam_id: string; document: QuestionDocument; status: string; version: number;
  metadata: JsonValue;
}
export interface DraftSummary {
  job_id: string; exam_id: string; status: string; version: number; question_count: number; created_at: string;
}

function now(): string {
  return rfc3339Now();
}
export function newId(prefix: string): string {
  const alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';
  let id = '';
  for (let index = 0; index < 16; index += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}_${id}`;
}
/** IPC `QuestionImage.role` 允许 `null`，L11 的仓储类型用 `undefined` 表示缺省。 */
function vfsImages(images: readonly QuestionImage[]): VfsQuestionImage[] {
  return images.map(image => ({
    id: image.id, name: image.name, mime: image.mime, hash: image.hash,
    ...(image.role == null ? {} : { role: image.role }),
  }));
}

export function conflict(message: string): never {
  throw new AuthoringConflict(`CONFLICT: ${message}`);
}
export function notFound(message: string): never {
  throw new AuthoringNotFound(message);
}
export function validation(message: string): never {
  throw new AuthoringValidation(message);
}
/** serde_json `Value[key]`: non-objects and missing keys read as `Null`. */
export function jsonField(value: JsonValue, key: string): JsonValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] ?? null : null;
}

/** serde_json `Value` equality (object key order does not matter). */
function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]!));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key]!, right[key]!));
}

/** serde_json `Value::get(key)`: `undefined` for non-objects or absent keys; a stored null is kept. */
export function jsonGet(value: JsonValue, key: string): JsonValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** serde_json `Value::as_u64().unwrap_or(0)`. */
function asU64(value: JsonValue): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function readDraft(db: SqlExecutor, jobId: string): AuthoringDraft {
  const row = db.get<{ exam_id: string; status: string; version: number; document_json: string;
    metadata_json: string }>(`SELECT exam_id, status, version, document_json, metadata_json
    FROM qbank_import_jobs WHERE id = ?1`, [jobId]);
  if (row === undefined) notFound('未找到题目草稿');
  return { job_id: jobId, exam_id: row.exam_id, status: row.status, version: row.version,
    // qbank_authoring_service.rs:649-650
    document: fromValueStr(row.document_json, questionDocument), metadata: fromValueStr(row.metadata_json, json) };
}

export function listDraftSummaries(db: SqlExecutor, examId: string): DraftSummary[] {
  return db.all<{ id: string; status: string; version: number; question_count: number; created_at: string }>(
    `SELECT j.id, j.status, j.version, json_array_length(j.document_json, '$.questions') AS question_count,
       j.created_at FROM qbank_import_jobs j JOIN exam_sheets e ON e.id = j.exam_id
     WHERE j.exam_id = ?1 AND e.deleted_at IS NULL AND j.status IN ('ready', 'needs_review', 'partial')
     ORDER BY j.created_at DESC, j.id`, [examId])
    .map(row => ({ job_id: row.id, exam_id: examId, status: row.status, version: row.version,
      question_count: row.question_count, created_at: row.created_at }));
}

export function updateDraftRow(db: SqlExecutor, jobId: string, document: QuestionDocument,
  status: string, expectedVersion: number, updatedAt: string): number {
  return db.run(`UPDATE qbank_import_jobs SET document_json = ?1, status = ?2,
      version = version + 1, updated_at = ?3 WHERE id = ?4 AND version = ?5`,
  [JSON.stringify(document), status, updatedAt, jobId, expectedVersion]).changes;
}

export function readMaterial(db: SqlExecutor, id: string): QuestionMaterial {
  const row = db.get<{ content: string; images_json: string; source_refs_json: string; local_version: number }>(
    `SELECT content, images_json, source_refs_json, local_version FROM qbank_materials
     WHERE id = ?1 AND deleted_at IS NULL`, [id]);
  if (row === undefined) notFound('材料不存在或已删除');
  // qbank_authoring_service.rs:658-659
  return { id, content: row.content, images: fromStr(row.images_json, vec(questionImage)),
    source_refs: fromStr(row.source_refs_json, vec(sourceRef)), version: row.local_version };
}

export function updateMaterialRow(db: DatabaseHandle, materialId: string, content: string,
  expectedVersion: number, ports?: QbankPorts): QuestionMaterial {
  return db.transaction(tx => {
    const changed = tx.run(`UPDATE qbank_materials SET content = ?1, local_version = local_version + 1,
        updated_at = ?2 WHERE id = ?3 AND local_version = ?4 AND deleted_at IS NULL`,
    [content, now(), materialId, expectedVersion]).changes;
    if (changed !== 1) conflict('材料版本已变化或材料不存在');
    const material = readMaterial(tx, materialId);
    const resourceIds = tx.all<{ resource_id: string | null }>(
      `SELECT e.resource_id FROM exam_sheets e JOIN qbank_materials m ON m.exam_id = e.id
       WHERE m.id = ?1`, [materialId]);
    const indexing = ports?.indexing;
    for (const row of resourceIds) {
      if (row.resource_id === null || row.resource_id.trim() === '') continue;
      if (indexing === undefined) {
        ports?.log?.warn(`[qbank] 无法标记材料索引待重建：vfsIndex 未提供 markResourcePending resource=${row.resource_id}`);
        continue;
      }
      indexing.markResourcePending(row.resource_id);
      ports?.log?.debug?.(`[qbank] 材料更新失效索引 material=${materialId} resource=${row.resource_id}`);
    }
    return material;
  });
}

export function materialReferenced(db: SqlExecutor, materialId: string): boolean {
  return Boolean(db.pluck<number>(`SELECT EXISTS(SELECT 1 FROM qbank_group_materials l
    JOIN qbank_groups g ON g.id = l.group_id
    WHERE l.material_id = ?1 AND l.deleted_at IS NULL AND g.deleted_at IS NULL)`, [materialId]));
}

export function deleteMaterialRow(db: DatabaseHandle, materialId: string, expectedVersion: number): void {
  db.transaction(tx => {
    if (materialReferenced(tx, materialId)) validation('材料仍被题组引用，请先替换或解除依赖');
    const changed = tx.run(`UPDATE qbank_materials SET deleted_at = ?1, updated_at = ?1,
        local_version = local_version + 1 WHERE id = ?2 AND local_version = ?3 AND deleted_at IS NULL`,
    [now(), materialId, expectedVersion]).changes;
    if (changed !== 1) conflict('材料版本已变化');
  });
}

export function examExists(db: SqlExecutor, examId: string): boolean {
  return Boolean(db.pluck<number>(
    'SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL)', [examId]));
}

export function insertDraft(db: SqlExecutor, examId: string, document: QuestionDocument,
  metadata: Record<string, unknown>, jobId: string, status: string, idempotencyKey: string | null): void {
  const stamp = now();
  db.run(`INSERT INTO qbank_import_jobs(id, exam_id, status, document_json, metadata_json,
      idempotency_key, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  [jobId, examId, status, JSON.stringify(document), JSON.stringify(metadata), idempotencyKey, stamp]);
}

export function findJobByIdempotency(db: SqlExecutor, examId: string, key: string): {
  id: string; document_json: string;
} | null {
  return db.get<{ id: string; document_json: string }>(
    'SELECT id, document_json FROM qbank_import_jobs WHERE exam_id = ?1 AND idempotency_key = ?2',
    [examId, key]) ?? null;
}

/** qbank_executor.rs:5052 — exam a prior chat batch import with this key landed in. */
export function findChatImportExam(db: SqlExecutor, key: string, chatSessionId: string): string | null {
  const row = db.get<{ exam_id: string }>(
    "SELECT j.exam_id FROM qbank_import_jobs j JOIN exam_sheets e ON e.id=j.exam_id WHERE j.idempotency_key=?1 AND json_extract(j.metadata_json,'$.chat_session_id')=?2 AND e.deleted_at IS NULL ORDER BY j.created_at LIMIT 1",
    [key, chatSessionId]);
  return row?.exam_id ?? null;
}

export function markDraftCommitted(db: SqlExecutor, jobId: string, receipt: unknown, selection: string,
  expectedVersion: number, stamp: string): number {
  return db.run(`UPDATE qbank_import_jobs SET status = 'committed', version = version + 1,
      receipt_json = ?1, selected_json = ?2, updated_at = ?3 WHERE id = ?4 AND version = ?5`,
  [JSON.stringify(receipt), selection, stamp, jobId, expectedVersion]).changes;
}

/** qbank_authoring_service.rs:534：一条 json_set 语句完成题目集，不改 updated_at，题目集不存在时不报错。 */
export function markExamCompleted(db: SqlExecutor, examId: string, ports?: QbankPorts): void {
  const exams = ports?.exams;
  if (exams === undefined) {
    ports?.log?.warn(`[qbank] 无法完成题目集：vfsRepo 未提供 exams 仓储 exam=${examId}`);
    return;
  }
  exams.markQuestionDocumentCompleted(db, examId);
}

export type { DraftGroup, DraftMaterial, DraftQuestion };

export interface CommitReceipt {
  committed: boolean; exam_id: string; question_ids: string[]; material_ids: string[]; group_ids: string[];
  imported_count: number; total_questions: number; partial: boolean; needs_review: boolean;
  coverage: unknown[]; unmatched_answers: unknown[];
}

function sha256(value: string): string {
  return sha256HexSync(value);
}

function remapRefs(refs: SourceRef[], sources: Map<string, string>): SourceRef[] {
  return refs.map(ref => ({
    ...ref,
    source_id: sources.size === 0 ? ref.source_id : (() => {
      const mapped = sources.get(ref.source_id);
      if (mapped === undefined) throw new AuthoringValidation('来源引用不在当前完整证据清单中');
      return mapped;
    })(),
  }));
}

function sourceSlot(question: DraftQuestion, sources: Map<string, string>): string | null {
  if (question.answer_origin === 'generated') return null;
  if (sources.size === 0 || question.source_refs.length === 0) return null;
  const refs = remapRefs(question.source_refs, sources);
  if (question.original_label === null || question.original_label.trim() === '') {
    throw new AuthoringValidation('来源题目缺少原题号，无法建立稳定重解析身份，请复核');
  }
  const sourceIds = refs.map(ref => [ref.source_id, ref.page]);
  return sha256(JSON.stringify([sourceIds, question.section_path, question.original_label]));
}

function verifyImages(db: SqlExecutor, images: QuestionImage[]): void {
  for (const image of images) {
    const valid = db.pluck<number>(`SELECT EXISTS(SELECT 1 FROM files f JOIN blobs b ON b.hash = f.blob_hash
      WHERE f.id = ?1 AND f.blob_hash = ?2 AND f.deleted_at IS NULL)`, [image.id, image.hash]);
    if (!valid) throw new AuthoringValidation(`题目/材料图片不可用: ${image.name}`);
  }
}

function commitSources(db: SqlExecutor, draft: AuthoringDraft, stamp: string): Map<string, string> {
  const sources = new Map<string, string>();
  const sourcesValue = jsonField(draft.metadata, 'sources');
  const pagesValue = jsonField(draft.metadata, 'pages');
  const metadataSources = Array.isArray(sourcesValue) ? sourcesValue : [];
  const metadataPages = Array.isArray(pagesValue) ? pagesValue : [];
  for (const raw of metadataSources) {
    const source = raw as Record<string, unknown>;
    const local = source.source_id;
    if (typeof local !== 'string') throw new AuthoringValidation('来源缺少source_id');
    const stable = typeof source.content_hash === 'string' ? source.content_hash
      : typeof source.blob_hash === 'string' ? source.blob_hash : null;
    if (stable === null) throw new AuthoringValidation('来源缺少稳定内容哈希');
    const key = `${stable}:${typeof source.anchor === 'string' ? source.anchor : ''}`;
    const existing = db.get<{ id: string }>('SELECT id FROM qbank_sources WHERE exam_id = ?1 AND source_key = ?2',
      [draft.exam_id, key]);
    const sourceId = existing?.id ?? newId('qsource');
    const descriptor = { ...source, pages: metadataPages.filter(page => jsonField(page, 'source_id') === local) };
    const previousRaw = db.pluck<string>('SELECT descriptor_json FROM qbank_sources WHERE id = ?1', [sourceId]);
    if (previousRaw !== undefined) {
      // qbank_authoring_service.rs:344-356 (Value indexing: missing keys compare as Null).
      let previous = fromValueStr(previousRaw, json);
      const previousPages = jsonField(previous, 'pages');
      const pages: JsonValue[] = Array.isArray(previousPages) ? [...previousPages] : [];
      for (const page of descriptor.pages as JsonValue[]) {
        const old = pages.find(candidate => jsonEqual(jsonField(candidate, 'page'), jsonField(page, 'page')));
        if (old !== undefined) {
          if (!jsonEqual(jsonField(old, 'blob_hash'), jsonField(page, 'blob_hash'))) {
            conflict('同一来源版本的页面证据已变化，请重新复核');
          }
        } else {
          pages.push(page);
        }
      }
      pages.sort((left, right) => asU64(jsonField(left, 'page')) - asU64(jsonField(right, 'page')));
      // `previous["pages"] = ...`: Null becomes an object; other non-objects panic in Rust.
      if (previous === null) previous = {};
      if (typeof previous !== 'object' || Array.isArray(previous)) {
        throw new Error('cannot index into a non-object source descriptor');
      }
      previous.pages = pages;
      db.run('UPDATE qbank_sources SET descriptor_json = ?1, updated_at = ?2, local_version = local_version + 1 WHERE id = ?3',
        [JSON.stringify(previous), stamp, sourceId]);
    } else {
      db.run(`INSERT INTO qbank_sources(id, exam_id, source_key, descriptor_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      [sourceId, draft.exam_id, key, JSON.stringify(descriptor), stamp]);
    }
    sources.set(local, sourceId);
  }
  return sources;
}

export function commitDraftRows(db: SqlExecutor, draft: AuthoringDraft, selectedLocalIds: string[],
  receipt: CommitReceipt, stamp: string, ports?: QbankPorts): CommitReceipt {
  const sources = commitSources(db, draft, stamp);
  const selected = new Set(selectedLocalIds);
  const selectedQuestions = draft.document.questions.filter(question => selected.has(question.local_id));
  const existing = new Map<string, string>();
  for (const question of selectedQuestions) {
    const key = draft.document.mode === 'extract' ? sourceSlot(question, sources) : null;
    if (key === null) continue;
    const row = db.get<{ id: string; deleted_at: string | null; provenance_json: string | null }>(
      'SELECT id, deleted_at, provenance_json FROM questions WHERE exam_id = ?1 AND source_key = ?2',
      [draft.exam_id, key]);
    if (row === undefined) continue;
    if (row.deleted_at !== null) conflict('该来源题目曾被删除，请明确恢复而非重复导入');
    // qbank_authoring_service.rs:392: unparsable provenance reads as Null (`.ok()`), not an error.
    let old: JsonValue = null;
    if (row.provenance_json !== null) {
      try { old = fromValueStr(row.provenance_json, json); } catch { old = null; }
    }
    if (jsonField(old, 'imported_content') !== question.content) {
      conflict('同源重新解析内容变化，需复核映射，未覆盖已有题目');
    }
    existing.set(question.local_id, row.id);
  }
  if (existing.size > 0 && existing.size !== selectedQuestions.length) {
    conflict('同源范围同时含已有与新拆分题目，请先复核，未自动混合导入');
  }
  if (existing.size === selectedQuestions.length) {
    receipt.question_ids = selectedQuestions.map(question => existing.get(question.local_id)!);
    return receipt;
  }

  const neededGroups = new Set(selectedQuestions.map(question => question.group_id)
    .filter((value): value is string => value !== null));
  const neededMaterials = new Set(draft.document.groups
    .filter(group => neededGroups.has(group.local_id))
    .flatMap(group => group.material_ids));
  const materialIds = new Map<string, string>();
  for (const material of draft.document.materials.filter(item => neededMaterials.has(item.local_id))) {
    verifyImages(db, material.images);
    const materialId = newId('qmat');
    const refs = remapRefs(material.source_refs, sources);
    db.run(`INSERT INTO qbank_materials(id, exam_id, content, images_json, source_refs_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    [materialId, draft.exam_id, material.content, JSON.stringify(material.images),
      JSON.stringify(refs), stamp]);
    receipt.material_ids.push(materialId);
    materialIds.set(material.local_id, materialId);
  }
  const groupIds = new Map<string, string>();
  let groupPosition = 0;
  for (const group of draft.document.groups.filter(item => neededGroups.has(item.local_id))) {
    const groupId = newId('qgroup');
    db.run(`INSERT INTO qbank_groups(id, exam_id, label, position, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    [groupId, draft.exam_id, group.label, groupPosition, stamp]);
    groupPosition += 1;
    group.material_ids.forEach((local, position) => {
      const materialId = materialIds.get(local);
      if (materialId === undefined) throw new AuthoringValidation('题组材料不在当前完整证据清单中');
      db.run(`INSERT INTO qbank_group_materials(id, exam_id, group_id, material_id, position, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      [newId('qgm'), draft.exam_id, groupId, materialId, position, stamp]);
    });
    groupIds.set(group.local_id, groupId);
    receipt.group_ids.push(groupId);
  }

  const questions = requireQuestions(ports ?? {});
  const newQuestionIds = new Map<string, string>();
  const deferredParents: { questionId: string; parentLocalId: string }[] = [];
  for (const question of selectedQuestions) {
    verifyImages(db, question.images);
    if (question.parent_id !== null) {
      const parentExists = db.pluck<number>(`SELECT EXISTS(SELECT 1 FROM questions
        WHERE id = ?1 AND exam_id = ?2 AND deleted_at IS NULL)`, [question.parent_id, draft.exam_id]);
      if (!parentExists) throw new AuthoringValidation('变式父题不属于目标题目集');
    }
    const refs = remapRefs(question.source_refs, sources);
    const answerRefs = remapRefs(question.answer_source_refs, sources);
    const sourceRef = sources.size === 0 ? question.source_ref
      : JSON.stringify({ source_refs: refs, answer_source_refs: answerRefs });
    let content = question.content;
    if (question.smiles !== null) {
      content += `\n\n\`\`\`smiles\n${question.smiles}\n\`\`\``;
      if (question.smiles_caption !== null) content += `\n${question.smiles_caption}`;
    }
    const created = questions.createQuestion(db, {
      exam_id: draft.exam_id,
      card_id: null,
      question_label: question.original_label,
      content,
      options: question.options,
      answer: question.answer,
      explanation: question.explanation,
      structured_data: question.structured_data as JsonValue,
      question_type: toQuestionType(question.question_type),
      difficulty: question.difficulty === null ? null : toDifficulty(question.difficulty),
      tags: question.tags,
      source_type: draft.document.mode === 'generate' ? 'ai_generated' : 'imported',
      source_ref: sourceRef,
      images: vfsImages(question.images),
      parent_id: question.parent_id,
    });
    const groupId = question.group_id === null ? null : groupIds.get(question.group_id) ?? null;
    const group = draft.document.groups.find(item => item.local_id === question.group_id);
    const groupPositionValue = group === undefined ? null : Math.max(0, group.question_ids.indexOf(question.local_id));
    const slot = draft.document.mode === 'extract' ? sourceSlot(question, sources) : null;
    const provenance = { source_refs: refs, answer_source_refs: answerRefs,
      section_path: question.section_path, original_label: question.original_label,
      imported_content: question.content };
    questions.applyQuestionMetadata(db, created.id, {
      card_id: created.id, group_id: groupId, group_position: groupPositionValue,
      source_key: slot, provenance, answer_origin: question.answer_origin,
    });
    newQuestionIds.set(question.local_id, created.id);
    if (question.parent_local_id !== null) {
      deferredParents.push({ questionId: created.id, parentLocalId: question.parent_local_id });
    }
    receipt.question_ids.push(created.id);
    receipt.imported_count += 1;
  }
  for (const deferred of deferredParents) {
    const parent = newQuestionIds.get(deferred.parentLocalId);
    if (parent === undefined) throw new AuthoringValidation('所选变式题依赖未选择的父题，请一并选择父题');
    questions.applyQuestionMetadata(db, deferred.questionId, { parent_id: parent });
  }
  return receipt;
}

export function readCommittedReceipt(db: SqlExecutor, jobId: string): {
  selected_json: string; receipt_json: string;
} | null {
  return db.get<{ selected_json: string; receipt_json: string }>(
    'SELECT selected_json, receipt_json FROM qbank_import_jobs WHERE id = ?1', [jobId]) ?? null;
}

export function countLiveQuestions(db: SqlExecutor, examId: string): number {
  return db.pluck<number>(
    'SELECT COUNT(*) FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL', [examId]) ?? 0;
}
