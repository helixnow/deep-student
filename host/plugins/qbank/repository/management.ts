/** OCC-safe question-group and shared-material administration (qbank_management.rs). */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import type { QuestionMaterial } from '../api.ts';
import type { JsonValue, QuestionRepository } from '../../vfs-repos/api.ts';
import { requireQuestions, type QbankPorts } from '../src/ports.ts';
import { cloneJsonValue, valueFromStr } from '../src/raw-json-number.ts';
import { questionImage, sourceRef } from './practice-decode.ts';
import { fromStr, vec } from './serde-decode.ts';

export class ManagementConflict extends Error {}
export class ManagementNotFound extends Error {}
export class ManagementValidation extends Error {}

export type DeleteMode = 'ungroup' | 'delete_members';

export interface GroupView {
  id: string; exam_id: string; label: string; position: number; version: number;
  material_ids: string[]; question_ids: string[];
}

export interface Structure {
  exam_id: string; materials: QuestionMaterial[]; groups: GroupView[];
}

export interface GroupUpdate {
  exam_id: string; group: GroupView; removed_question_ids: string[]; solo_group_ids: string[];
}

export interface GroupDelete {
  exam_id: string; group_id: string; mode: DeleteMode; deleted_question_ids: string[];
  ungrouped_question_ids: string[]; solo_group_ids: string[]; material_ids: string[];
}

export interface MaterialExpectation { material_id: string; expected_version: number }
export interface MaterialDeletion { exam_id: string; deleted_material_ids: string[] }

function now(): string {
  return rfc3339Now();
}
function newId(prefix: string): string {
  const alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';
  let id = '';
  for (let index = 0; index < 16; index += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}_${id}`;
}
/** `serde_json::from_str::<Value>(raw).ok()`：小数/指数/大整数保留原文。 */
function parseValue<T>(raw: string, fallback: T): T {
  try {
    return valueFromStr(raw) as T;
  } catch {
    return fallback;
  }
}
function conflict(message: string): never {
  throw new ManagementConflict(`CONFLICT: ${message}`);
}
function notFound(message: string): never {
  throw new ManagementNotFound(message);
}
function validation(message: string): never {
  throw new ManagementValidation(message);
}
function hasDuplicates(values: readonly string[]): boolean {
  const seen = new Set<string>();
  return values.some(value => (seen.has(value) ? true : (seen.add(value), false)));
}

export function ensureExamActive(db: SqlExecutor, examId: string): void {
  const exists = db.pluck<number>('SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL)',
    [examId]);
  if (!exists) notFound('目标题目集不存在或已删除');
}

function ensureMaterialActive(db: SqlExecutor, examId: string, materialId: string): void {
  const exists = db.pluck<number>(`SELECT EXISTS(SELECT 1 FROM qbank_materials
    WHERE id = ?1 AND exam_id = ?2 AND deleted_at IS NULL)`, [materialId, examId]);
  if (!exists) validation('材料不存在、已删除或不属于目标题目集');
}

export function listStructure(db: SqlExecutor, examId: string): Structure {
  ensureExamActive(db, examId);
  const materials = db.all<{
    id: string; content: string; images_json: string; source_refs_json: string; local_version: number;
  }>(`SELECT id, content, images_json, source_refs_json, local_version
    FROM qbank_materials WHERE exam_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id`, [examId])
    .map(row => ({
      id: row.id, content: row.content,
      images: fromStr(row.images_json, vec(questionImage)),
      source_refs: fromStr(row.source_refs_json, vec(sourceRef)),
      version: row.local_version,
    }));
  const groups = db.all<{ id: string; label: string; position: number; local_version: number }>(
    `SELECT id, label, position, local_version FROM qbank_groups
     WHERE exam_id = ?1 AND deleted_at IS NULL ORDER BY position, id`, [examId])
    .map(row => ({ id: row.id, exam_id: examId, label: row.label, position: row.position,
      version: row.local_version, material_ids: [] as string[], question_ids: [] as string[] }));
  const materialIds = new Map<string, string[]>();
  for (const row of db.all<{ group_id: string; material_id: string }>(
    `SELECT gm.group_id, gm.material_id FROM qbank_group_materials gm
     JOIN qbank_groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
     JOIN qbank_materials m ON m.id = gm.material_id AND m.deleted_at IS NULL
     WHERE gm.exam_id = ?1 AND gm.deleted_at IS NULL
     ORDER BY gm.group_id, gm.position, gm.id`, [examId])) {
    const list = materialIds.get(row.group_id) ?? [];
    list.push(row.material_id);
    materialIds.set(row.group_id, list);
  }
  const questionIds = new Map<string, string[]>();
  for (const row of db.all<{ group_id: string; id: string }>(
    `SELECT group_id, id FROM questions
     WHERE exam_id = ?1 AND deleted_at IS NULL AND group_id IS NOT NULL
     ORDER BY group_id, CASE WHEN group_position IS NULL THEN 1 ELSE 0 END,
       group_position, created_at, id`, [examId])) {
    const list = questionIds.get(row.group_id) ?? [];
    list.push(row.id);
    questionIds.set(row.group_id, list);
  }
  for (const group of groups) {
    group.material_ids = materialIds.get(group.id) ?? [];
    group.question_ids = questionIds.get(group.id) ?? [];
  }
  return { exam_id: examId, materials, groups };
}

interface GroupHeader { examId: string; label: string; position: number; version: number }

function readGroupHeader(db: SqlExecutor, groupId: string): GroupHeader {
  const row = db.get<{ exam_id: string; label: string; position: number; local_version: number }>(
    `SELECT exam_id, label, position, local_version FROM qbank_groups
     WHERE id = ?1 AND deleted_at IS NULL`, [groupId]);
  if (row === undefined) notFound('题组不存在或已删除');
  return { examId: row.exam_id, label: row.label, position: row.position, version: row.local_version };
}

function loadGroupQuestionIds(db: SqlExecutor, groupId: string): string[] {
  return db.all<{ id: string }>(
    `SELECT id FROM questions WHERE group_id = ?1 AND deleted_at IS NULL
     ORDER BY CASE WHEN group_position IS NULL THEN 1 ELSE 0 END, group_position, created_at, id`,
    [groupId]).map(row => row.id);
}

function loadGroupMaterialIds(db: SqlExecutor, groupId: string): string[] {
  return db.all<{ material_id: string }>(
    `SELECT gm.material_id FROM qbank_group_materials gm
     JOIN qbank_materials m ON m.id = gm.material_id AND m.deleted_at IS NULL
     WHERE gm.group_id = ?1 AND gm.deleted_at IS NULL ORDER BY gm.position, gm.id`,
    [groupId]).map(row => row.material_id);
}

function nextGroupPosition(db: SqlExecutor, examId: string): number {
  return (db.pluck<number>(`SELECT COALESCE(MAX(position), -1) FROM qbank_groups
    WHERE exam_id = ?1 AND deleted_at IS NULL`, [examId]) ?? -1) + 1;
}

function soloLabel(sourceLabel: string): string {
  const trimmed = sourceLabel.trim();
  return trimmed === '' ? '独立题' : `${trimmed} · 独立题`;
}

function createSoloGroup(questions: QuestionRepository, db: SqlExecutor, examId: string,
  sourceLabel: string, position: number, questionId: string, oldGroupId: string,
  materialIds: string[], stamp: string): string {
  const soloId = newId('qgroup');
  db.run(`INSERT INTO qbank_groups(id, exam_id, label, position, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  [soloId, examId, soloLabel(sourceLabel), position, stamp]);
  materialIds.forEach((materialId, index) => {
    db.run(`INSERT INTO qbank_group_materials(id, exam_id, group_id, material_id, position, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    [newId('qgm'), examId, soloId, materialId, index, stamp]);
  });
  const affected = questions.updateQuestionGroupMembership(db, questionId, {
    group_id: soloId, group_position: 0, exam_id: examId, expected_group_id: oldGroupId,
  });
  if (affected !== 1) validation('子题在操作期间已变化，请重新载入');
  questions.recordHistory(db, questionId, 'group_id', oldGroupId, soloId, 'system',
    'group_member_preserved_in_solo');
  return soloId;
}

export function updateGroup(db: DatabaseHandle, groupId: string, label: string, questionIds: string[],
  materialIds: string[], expectedVersion: number, ports?: QbankPorts): GroupUpdate {
  const questions = requireQuestions(ports ?? {});
  if (questionIds.length === 0 || hasDuplicates(questionIds)) validation('题组成员为空或重复');
  if (hasDuplicates(materialIds)) validation('题组材料关联重复');
  return db.transaction(tx => {
    const header = readGroupHeader(tx, groupId);
    ensureExamActive(tx, header.examId);
    if (header.version !== expectedVersion) conflict('题组版本已变化，请重新载入');
    const currentMembers = loadGroupQuestionIds(tx, groupId);
    const currentMemberSet = new Set(currentMembers);
    const finalMemberSet = new Set(questionIds);
    const currentMaterialIds = loadGroupMaterialIds(tx, groupId);
    for (const questionId of questionIds) {
      const row = tx.get<{ group_id: string | null }>(
        `SELECT group_id FROM questions WHERE id = ?1 AND exam_id = ?2 AND deleted_at IS NULL`,
        [questionId, header.examId]);
      if (row === undefined) validation('子题不存在、已删除或不属于目标题目集');
      if (row.group_id !== null && row.group_id !== groupId) {
        validation('子题已属于其他题组，请先从原题组移出');
      }
    }
    for (const materialId of materialIds) ensureMaterialActive(tx, header.examId, materialId);
    const removed = currentMembers.filter(id => !finalMemberSet.has(id));
    const stamp = now();
    const preservedMaterialIds = removed.length === 0 ? [] : currentMaterialIds;
    let nextPosition = nextGroupPosition(tx, header.examId);
    const soloGroupIds: string[] = [];
    for (const removedId of removed) {
      if (preservedMaterialIds.length === 0) {
        const affected = questions.updateQuestionGroupMembership(tx, removedId, {
          group_id: null, group_position: null, exam_id: header.examId, expected_group_id: groupId,
        });
        if (affected !== 1) validation('子题在操作期间已变化，请重新载入');
        questions.recordHistory(tx, removedId, 'group_id', groupId, null, 'system',
          'group_member_removed');
      } else {
        soloGroupIds.push(createSoloGroup(questions, tx, header.examId, header.label, nextPosition,
          removedId, groupId, preservedMaterialIds, stamp));
        nextPosition += 1;
      }
    }
    const changed = tx.run(`UPDATE qbank_groups SET label = ?1, local_version = local_version + 1,
        updated_at = ?2 WHERE id = ?3 AND local_version = ?4 AND deleted_at IS NULL`,
    [label, stamp, groupId, expectedVersion]).changes;
    if (changed !== 1) conflict('题组版本已变化，请重新载入');
    questionIds.forEach((questionId, position) => {
      const affected = questions.updateQuestionGroupMembership(tx, questionId, {
        group_id: groupId, group_position: position, exam_id: header.examId,
        allow_existing_group: true,
      });
      if (affected !== 1) validation('子题不存在、跨题库或已属于另一题组');
      if (!currentMemberSet.has(questionId)) {
        questions.recordHistory(tx, questionId, 'group_id', null, groupId, 'system',
          'group_member_added');
      }
    });
    tx.run(`UPDATE qbank_group_materials SET deleted_at = ?1, updated_at = ?1,
        local_version = local_version + 1 WHERE group_id = ?2 AND deleted_at IS NULL`, [stamp, groupId]);
    materialIds.forEach((materialId, position) => {
      tx.run(`INSERT INTO qbank_group_materials
          (id, exam_id, group_id, material_id, position, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(group_id, material_id) DO UPDATE SET
          position = excluded.position, deleted_at = NULL, updated_at = excluded.updated_at,
          deletion_batch = NULL, local_version = qbank_group_materials.local_version + 1`,
      [newId('qgm'), header.examId, groupId, materialId, position, stamp]);
    });
    const group = readGroupView(tx, header.examId, groupId);
    finalizeExamReadModels(tx, header.examId, ports);
    return { exam_id: header.examId, group, removed_question_ids: removed, solo_group_ids: soloGroupIds };
  });
}

function readGroupView(db: SqlExecutor, examId: string, groupId: string): GroupView {
  const row = db.get<{ id: string; exam_id: string; label: string; position: number; local_version: number }>(
    `SELECT id, exam_id, label, position, local_version FROM qbank_groups
     WHERE id = ?1 AND exam_id = ?2 AND deleted_at IS NULL`, [groupId, examId]);
  if (row === undefined) notFound('题组不存在或已删除');
  return { id: row.id, exam_id: row.exam_id, label: row.label, position: row.position,
    version: row.local_version, material_ids: loadGroupMaterialIds(db, groupId),
    question_ids: loadGroupQuestionIds(db, groupId) };
}

export function deleteGroup(db: DatabaseHandle, groupId: string, mode: DeleteMode,
  expectedVersion: number, ports?: QbankPorts): GroupDelete {
  const questions = requireQuestions(ports ?? {});
  return db.transaction(tx => {
    const header = readGroupHeader(tx, groupId);
    ensureExamActive(tx, header.examId);
    if (header.version !== expectedVersion) conflict('题组版本已变化，请重新载入');
    const members = loadGroupQuestionIds(tx, groupId);
    const materialIds = loadGroupMaterialIds(tx, groupId);
    const stamp = now();
    const batch = newId('qdel');
    const deletedQuestionIds: string[] = [];
    const ungroupedQuestionIds: string[] = [];
    const soloGroupIds: string[] = [];
    if (mode === 'ungroup') {
      let nextPosition = nextGroupPosition(tx, header.examId);
      for (const questionId of members) {
        if (materialIds.length === 0) {
          const affected = questions.updateQuestionGroupMembership(tx, questionId, {
            group_id: null, group_position: null, exam_id: header.examId, expected_group_id: groupId,
          });
          if (affected !== 1) validation('子题在操作期间已变化，请重新载入');
          questions.recordHistory(tx, questionId, 'group_id', groupId, null, 'system',
            'group_ungrouped');
          ungroupedQuestionIds.push(questionId);
        } else {
          soloGroupIds.push(createSoloGroup(questions, tx, header.examId, header.label, nextPosition,
            questionId, groupId, materialIds, stamp));
          nextPosition += 1;
        }
      }
    } else {
      rejectExternalVariantDependencies(tx, groupId, members);
      for (const questionId of members) {
        const affected = questions.softDeleteQuestionInGroup(tx, questionId, header.examId, stamp);
        if (affected !== 1) validation('题组成员在操作期间已变化，请重新载入');
        questions.recordHistory(tx, questionId, 'group_id', groupId, null, 'system',
          'group_deleted_with_members');
        questions.recordHistory(tx, questionId, 'deleted_at', null, stamp, 'system',
          'group_deleted_with_members');
        deletedQuestionIds.push(questionId);
      }
    }
    tx.run(`UPDATE qbank_group_materials SET deleted_at = ?1, updated_at = ?1,
        local_version = local_version + 1, deletion_batch = ?2
      WHERE group_id = ?3 AND deleted_at IS NULL`, [stamp, batch, groupId]);
    const changed = tx.run(`UPDATE qbank_groups SET deleted_at = ?1, updated_at = ?1,
        local_version = local_version + 1, deletion_batch = ?2
      WHERE id = ?3 AND local_version = ?4 AND deleted_at IS NULL`,
    [stamp, batch, groupId, expectedVersion]).changes;
    if (changed !== 1) conflict('题组版本已变化，请重新载入');
    finalizeExamReadModels(tx, header.examId, ports);
    return {
      exam_id: header.examId, group_id: groupId, mode, deleted_question_ids: deletedQuestionIds,
      ungrouped_question_ids: ungroupedQuestionIds, solo_group_ids: soloGroupIds,
      material_ids: materialIds,
    };
  });
}

function rejectExternalVariantDependencies(db: SqlExecutor, groupId: string, members: string[]): void {
  const memberSet = new Set(members);
  for (const member of members) {
    for (const row of db.all<{ id: string }>(`SELECT id FROM questions
      WHERE parent_id = ?1 AND deleted_at IS NULL AND group_id IS NOT ?2`, [member, groupId])) {
      if (!memberSet.has(row.id)) {
        validation('题组成员仍是其他活动变式题的父题，请先处理变式依赖');
      }
    }
  }
}

export function deleteUnusedMaterials(db: DatabaseHandle, examId: string,
  expected: MaterialExpectation[], ports?: QbankPorts): MaterialDeletion {
  const seen = new Set<string>();
  for (const item of expected) {
    if (seen.has(item.material_id)) validation('待删除材料重复');
    seen.add(item.material_id);
  }
  return db.transaction(tx => {
    ensureExamActive(tx, examId);
    if (expected.length === 0) return { exam_id: examId, deleted_material_ids: [] };
    for (const item of expected) {
      const row = tx.get<{ local_version: number; deleted_at: string | null }>(
        `SELECT local_version, deleted_at FROM qbank_materials WHERE id = ?1 AND exam_id = ?2`,
        [item.material_id, examId]);
      if (row === undefined) notFound('材料不存在或不属于目标题目集');
      if (row.deleted_at !== null) conflict('材料已被删除或版本已变化');
      if (row.local_version !== item.expected_version) conflict('材料版本已变化，请重新载入');
      const referenced = tx.pluck<number>(`SELECT EXISTS(SELECT 1 FROM qbank_group_materials gm
        JOIN qbank_groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
        WHERE gm.material_id = ?1 AND gm.exam_id = ?2 AND gm.deleted_at IS NULL)`,
      [item.material_id, examId]);
      if (referenced) validation('材料仍被题组引用，请先解除依赖');
    }
    const stamp = now();
    const batch = newId('qdel');
    for (const item of expected) {
      const changed = tx.run(`UPDATE qbank_materials SET deleted_at = ?1, updated_at = ?1,
          local_version = local_version + 1, deletion_batch = ?2
        WHERE id = ?3 AND exam_id = ?4 AND local_version = ?5 AND deleted_at IS NULL`,
      [stamp, batch, item.material_id, examId, item.expected_version]).changes;
      if (changed !== 1) conflict('材料版本已变化，请重新载入');
    }
    finalizeExamReadModels(tx, examId, ports);
    return { exam_id: examId, deleted_material_ids: expected.map(item => item.material_id) };
  });
}

/** vfs qbank_helpers::refresh_canonical_preview_with_conn */
export function refreshCanonicalPreview(db: SqlExecutor, examId: string, ports?: QbankPorts): void {
  const exams = ports?.exams;
  if (exams === undefined) {
    ports?.log?.warn(`[qbank] 无法刷新预览：vfsRepo 未提供 exams 仓储 exam=${examId}`);
    return;
  }
  const sheet = exams.getExamSheet(db, examId);
  const raw = sheet?.previewJson;
  const preview = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)
    ? cloneJsonValue(raw) as unknown as { pages?: unknown[] } : { pages: [] as unknown[] };
  if (!Array.isArray(preview.pages)) preview.pages = [];
  for (const page of preview.pages as Record<string, unknown>[]) page.cards = [];
  const sourcePages = new Map<string, number>();
  for (const row of db.all<{ id: string; descriptor_json: string }>(
    `SELECT id, descriptor_json FROM qbank_sources WHERE exam_id = ?1 AND deleted_at IS NULL
     ORDER BY created_at, id`, [examId])) {
    const descriptor = parseValue<{ pages?: Record<string, unknown>[] }>(row.descriptor_json, {});
    for (const page of descriptor.pages ?? []) {
      const hash = page.blob_hash;
      if (typeof hash !== 'string') throw new Error('来源页面缺少blob_hash');
      const pages = preview.pages as Record<string, unknown>[];
      let index = pages.findIndex(existing => existing.blob_hash === hash);
      if (index < 0) {
        index = pages.length;
        pages.push({ page_index: index, blob_hash: hash, width: page.width, height: page.height,
          cards: [], ocr_completed: true, parse_completed: true });
      }
      sourcePages.set(`${row.id}:${typeof page.page === 'number' ? page.page : 1}`, index);
    }
  }
  if ((preview.pages as unknown[]).length === 0) preview.pages = [{ page_index: 0, cards: [] }];
  const pages = preview.pages as Record<string, unknown>[];
  for (const row of db.all<{
    id: string; question_label: string | null; content: string; question_type: string;
    answer: string | null; explanation: string | null; options_json: string | null;
    structured_data: string | null; images_json: string; provenance_json: string | null;
    group_id: string | null;
  }>(`SELECT COALESCE(card_id, id) AS id, question_label, content, question_type, answer,
      explanation, options_json, structured_data, images_json, provenance_json, group_id
    FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL ORDER BY created_at, rowid`, [examId])) {
    const provenance = row.provenance_json === null ? null : parseValue<Record<string, unknown>>(row.provenance_json, {});
    const refs = provenance === null ? null : provenance.source_refs;
    const reference = Array.isArray(refs) ? refs[0] as Record<string, unknown> | undefined : undefined;
    const sourceId = typeof reference?.source_id === 'string' ? reference.source_id : '';
    const pageNumber = typeof reference?.page === 'number' ? reference.page : 1;
    const page = Math.min(sourcePages.get(`${sourceId}:${pageNumber}`) ?? 0, pages.length - 1);
    (pages[page]!.cards as unknown[]).push({
      card_id: row.id, question_label: row.question_label ?? '', ocr_text: row.content,
      question_type: row.question_type, answer: row.answer, explanation: row.explanation,
      options: row.options_json === null ? null : parseValue<unknown>(row.options_json, null),
      structured_data: row.structured_data === null ? null : parseValue<unknown>(row.structured_data, null),
      images: parseValue<unknown>(row.images_json, []), group_id: row.group_id, page_index: page,
    });
  }
  exams.updatePreviewJson(db, examId, preview as unknown as JsonValue);
}

/** VfsQuestionRepo::invalidate_exam_content_index_with_conn */
export function invalidateExamContentIndex(db: SqlExecutor, examId: string, ports?: QbankPorts): void {
  const hasResources = db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resources')");
  if (!hasResources) return;
  const resource = db.get<{ resource_id: string | null; index_state: string | null }>(
    `SELECT e.resource_id, r.index_state FROM exam_sheets e
     LEFT JOIN resources r ON r.id = e.resource_id WHERE e.id = ?1`, [examId]);
  const resourceId = resource?.resource_id ?? null;
  if (resourceId === null || resourceId.trim() === '') return;
  if (resource?.index_state === 'pending' || resource?.index_state === 'disabled') return;
  const indexing = ports?.indexing;
  if (indexing === undefined) {
    ports?.log?.warn(`[qbank] 无法标记索引待重建：vfsIndex 未提供 markResourcePending resource=${resourceId}`);
    return;
  }
  indexing.markResourcePending(resourceId);
  ports?.log?.debug?.(`[VFS::QuestionRepo] Invalidated content index for exam=${examId} resource=${resourceId}`);
}

export function finalizeExamReadModels(db: SqlExecutor, examId: string, ports?: QbankPorts): void {
  refreshCanonicalPreview(db, examId, ports);
  requireQuestions(ports ?? {}).refreshStats(db, examId);
  invalidateExamContentIndex(db, examId, ports);
}
