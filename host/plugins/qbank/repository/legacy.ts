/** Legacy preview-card audit and explicit migration (qbank_legacy_reconcile.rs). */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { DraftQuestion, QuestionImage, QuestionOption } from '../api.ts';
import type { JsonValue, QuestionImage as VfsQuestionImage, QuestionRepository } from '../../vfs-repos/api.ts';
import type { QbankPorts } from '../src/ports.ts';
import { jsonField, jsonGet, readDraft } from './authoring.ts';
import { reparseResolveReceipt } from './authoring-decode.ts';
import { toDifficulty, toQuestionType } from '../src/question-enums.ts';
import { cloneJsonValue, valueFromStr } from '../src/raw-json-number.ts';

export class LegacyNotFound extends Error {}
export class LegacyConflict extends Error {}
export class LegacyValidation extends Error {}

export interface AuditPage {
  page_index: number; blob_hash: string | null; original_image_path: string;
  width: number | null; height: number | null; card_count: number;
}
export interface AuditCard {
  card_id: string | null; page_index: number; card_index: number; question_label: string | null;
  preview_text: string; status: string; formal_question_id: string | null;
  candidate_question_ids: string[]; deleted_question_ids: string[]; migratable: boolean;
  reason: string | null;
}
export interface MigrationAudit {
  exam_id: string; canonical_marker: boolean; canonical_question_count: number;
  source_version: string; audit_version: string; pages: AuditPage[]; cards: AuditCard[];
  migratable_card_ids: string[]; matched_count: number; unmatched_count: number;
  ambiguous_count: number; deleted_count: number; invalid_count: number; suppressed_count: number;
}
export interface MigrationReceipt {
  exam_id: string; committed: boolean; idempotent: boolean; job_id: string | null;
  migrated_card_ids: string[]; question_ids: string[]; imported_count: number;
  audit_version_before: string; audit_version_after: string | null;
}

export interface PreviewCard {
  card_id: string | null; page_index: number; card_index: number;
  question_label: string | null; text: string; raw: Record<string, unknown>;
}
export interface PreviewPage {
  page_index: number; blob_hash: string | null; original_image_path: string;
  width: number | null; height: number | null; cards: PreviewCard[];
}
interface FormalRow {
  id: string; card_id: string | null; deleted: boolean; updated_at: string; source_key: string | null;
}

const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank',
  'short_answer', 'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other'];

export function hashValue(value: unknown): string {
  return sha256HexSync(JSON.stringify(value));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function liveExamExists(db: SqlExecutor, examId: string): boolean {
  return Boolean(db.pluck<number>(
    'SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL)', [examId]));
}

export function rawPreview(db: SqlExecutor, examId: string): Record<string, unknown> {
  const raw = db.pluck<string>(
    'SELECT preview_json FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL', [examId]);
  if (raw === undefined) throw new LegacyNotFound('目标题目集不存在');
  try {
    return (valueFromStr(raw) as unknown as Record<string, unknown>) ?? { pages: [] };
  } catch {
    return { pages: [] };
  }
}

export function previewCardIdentity(card: Record<string, unknown>): string | null {
  const cardId = string(card.card_id)?.trim() ?? '';
  const id = string(card.id)?.trim() ?? '';
  if (cardId !== '' && id !== '' && cardId !== id) return null;
  if (cardId !== '') return cardId;
  if (id !== '') return id;
  return null;
}

export function previewCardText(card: Record<string, unknown>): string {
  for (const key of ['ocr_text', 'content', 'text']) {
    const value = card[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function previewPages(db: SqlExecutor, examId: string): PreviewPage[] {
  const preview = rawPreview(db, examId);
  const pages: PreviewPage[] = [];
  for (const [index, rawPage] of array(preview.pages).entries()) {
    const page = object(rawPage) ?? {};
    const pageIndex = numberOrNull(page.page_index) ?? index;
    const cards: PreviewCard[] = [];
    for (const [cardIndex, rawCard] of array(page.cards).entries()) {
      const card = object(rawCard) ?? {};
      const label = (string(card.question_label) ?? string(card.questionLabel))?.trim();
      cards.push({
        card_id: previewCardIdentity(card), page_index: pageIndex, card_index: cardIndex,
        question_label: label === undefined || label === '' ? null : label,
        text: previewCardText(card), raw: card,
      });
    }
    pages.push({
      page_index: pageIndex,
      blob_hash: (string(page.blob_hash) ?? '').trim() === '' ? null : String(page.blob_hash).trim(),
      original_image_path: string(page.original_image_path) ?? '',
      width: numberOrNull(page.width), height: numberOrNull(page.height), cards,
    });
  }
  return pages;
}

export function loadFormalRows(db: SqlExecutor, examId: string): FormalRow[] {
  return db.all<{ id: string; card_id: string | null; deleted_at: string | null; updated_at: string;
    source_key: string | null }>(
    'SELECT id, card_id, deleted_at, updated_at, source_key FROM questions WHERE exam_id = ?1', [examId])
    .map(row => ({ id: row.id, card_id: row.card_id, deleted: row.deleted_at !== null,
      updated_at: row.updated_at, source_key: row.source_key }));
}

export function auditLegacyCards(db: SqlExecutor, examId: string): MigrationAudit {
  const exam = db.get<{ metadata_json: string }>(
    'SELECT metadata_json FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL', [examId]);
  if (exam === undefined) throw new LegacyNotFound('目标题目集不存在');
  let metadata: Record<string, unknown> = {};
  try {
    metadata = (JSON.parse(exam.metadata_json) as Record<string, unknown>) ?? {};
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const canonicalMarker = metadata.question_document_version === 2;
  const pages = previewPages(db, examId);
  const rows = loadFormalRows(db, examId);
  const liveCount = rows.filter(row => !row.deleted).length;
  const byCard = new Map<string, FormalRow[]>();
  const byId = new Map<string, FormalRow>();
  for (const row of rows) {
    byId.set(row.id, row);
    if (row.card_id !== null) {
      const list = byCard.get(row.card_id) ?? [];
      list.push(row);
      byCard.set(row.card_id, list);
    }
  }
  const identityCounts = new Map<string, number>();
  for (const page of pages) {
    for (const card of page.cards) {
      if (card.card_id !== null) identityCounts.set(card.card_id, (identityCounts.get(card.card_id) ?? 0) + 1);
    }
  }
  const cards: AuditCard[] = [];
  const migratable: string[] = [];
  let matched = 0; let unmatched = 0; let ambiguous = 0; let deleted = 0; let invalid = 0; let suppressed = 0;
  for (const page of pages) {
    for (const card of page.cards) {
      const item: AuditCard = {
        card_id: card.card_id, page_index: card.page_index, card_index: card.card_index,
        question_label: card.question_label, preview_text: card.text, status: '',
        formal_question_id: null, candidate_question_ids: [], deleted_question_ids: [],
        migratable: false, reason: null,
      };
      if (card.card_id === null) {
        item.status = 'invalid'; item.reason = '卡片缺少 card_id/id，无法建立稳定身份';
        invalid += 1; cards.push(item); continue;
      }
      if ((identityCounts.get(card.card_id) ?? 0) > 1) {
        item.status = 'invalid'; item.reason = '预览中存在重复 card_id，不能猜测迁移对象';
        invalid += 1; cards.push(item); continue;
      }
      const candidates: FormalRow[] = [];
      const seen = new Set<string>();
      for (const row of byCard.get(card.card_id) ?? []) {
        if (!seen.has(row.id)) { seen.add(row.id); candidates.push(row); }
      }
      const direct = byId.get(card.card_id);
      if (direct !== undefined && !seen.has(direct.id)) { seen.add(direct.id); candidates.push(direct); }
      const live = candidates.filter(row => !row.deleted);
      const removed = candidates.filter(row => row.deleted);
      item.candidate_question_ids = live.map(row => row.id);
      item.deleted_question_ids = removed.map(row => row.id);
      if (canonicalMarker && liveCount === 0) {
        item.status = 'suppressed_canonical';
        item.reason = '题目集已有规范化标记且正式题目全部删除；不会从历史预览快照重建';
        suppressed += 1;
      } else if (live.length === 1) {
        item.status = 'matched'; item.formal_question_id = live[0]!.id; matched += 1;
      } else if (live.length > 1) {
        item.status = 'ambiguous'; item.reason = '同一 card_id/id 命中多个正式题目，未做语义猜测';
        ambiguous += 1;
      } else if (removed.length > 0) {
        item.status = 'deleted'; item.reason = '对应正式题目已删除；如需恢复必须显式恢复原题';
        deleted += 1;
      } else if (card.text.trim() === '') {
        item.status = 'invalid'; item.reason = '卡片题干预览为空，不能生成正式题目';
        invalid += 1;
      } else {
        item.status = 'unmatched'; item.migratable = true; migratable.push(card.card_id); unmatched += 1;
      }
      cards.push(item);
    }
  }
  const sourceSnapshot = pages.map(page => ({
    page_index: page.page_index, blob_hash: page.blob_hash,
    original_image_path: page.original_image_path, width: page.width, height: page.height,
    cards: page.cards.map(card => ({
      card_id: card.card_id, page_index: card.page_index, card_index: card.card_index,
      question_label: card.question_label,
    })),
  }));
  const sourceVersion = hashValue(sourceSnapshot);
  const formalSnapshot = [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const auditVersion = hashValue({
    source_version: sourceVersion,
    canonical_marker: canonicalMarker,
    formal: formalSnapshot.map(row => ({ id: row.id, card_id: row.card_id, deleted: row.deleted,
      updated_at: row.updated_at, source_key: row.source_key })),
    mapping: cards.map(card => ({ card_id: card.card_id, status: card.status,
      formal_question_id: card.formal_question_id, candidates: card.candidate_question_ids,
      deleted: card.deleted_question_ids })),
  });
  return {
    exam_id: examId, canonical_marker: canonicalMarker, canonical_question_count: liveCount,
    source_version: sourceVersion, audit_version: auditVersion,
    pages: pages.map(page => ({ page_index: page.page_index, blob_hash: page.blob_hash,
      original_image_path: page.original_image_path, width: page.width, height: page.height,
      card_count: page.cards.length })),
    cards, migratable_card_ids: migratable, matched_count: matched, unmatched_count: unmatched,
    ambiguous_count: ambiguous, deleted_count: deleted, invalid_count: invalid, suppressed_count: suppressed,
  };
}

export function idempotentReceipt(db: SqlExecutor, examId: string, selectedCardIds: string[],
  currentAuditVersion: string): MigrationReceipt | null {
  for (const cardId of selectedCardIds) {
    const deleted = Boolean(db.pluck<number>(`SELECT EXISTS(SELECT 1 FROM questions
      WHERE exam_id = ?1 AND deleted_at IS NOT NULL
        AND json_extract(provenance_json, '$.legacy_migration.card_id') = ?2)`, [examId, cardId]));
    if (deleted) {
      throw new LegacyConflict('该历史卡片迁移出的正式题目已被删除；不会从预览快照重建，请显式恢复原题');
    }
  }
  const questionIds: string[] = [];
  for (const cardId of selectedCardIds) {
    const ids = db.all<{ id: string }>(`SELECT id FROM questions
      WHERE exam_id = ?1 AND deleted_at IS NULL AND (card_id = ?2 OR id = ?2)
        AND json_extract(provenance_json, '$.legacy_migration.card_id') = ?2 ORDER BY id`,
    [examId, cardId]).map(row => row.id);
    if (ids.length !== 1) return null;
    questionIds.push(ids[0]!);
  }
  return {
    exam_id: examId, committed: true, idempotent: true, job_id: null,
    migrated_card_ids: [...selectedCardIds], question_ids: questionIds, imported_count: 0,
    audit_version_before: currentAuditVersion, audit_version_after: currentAuditVersion,
  };
}

function parseOptions(value: unknown): QuestionOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: QuestionOption[] = [];
  for (const raw of value) {
    const option = object(raw);
    const key = string(option?.key);
    const content = string(option?.content);
    if (option === null || key === null || content === null) return null;
    options.push({ key, content });
  }
  return options;
}

function usableImages(db: SqlExecutor, value: unknown): QuestionImage[] {
  const images: QuestionImage[] = [];
  for (const raw of array(value)) {
    const image = object(raw);
    const id = string(image?.id);
    const hash = string(image?.hash);
    const name = string(image?.name);
    const mime = string(image?.mime);
    if (id === null || hash === null || name === null || mime === null) continue;
    const valid = db.pluck<number>(`SELECT EXISTS(SELECT 1 FROM files f JOIN blobs b ON b.hash = f.blob_hash
      WHERE f.id = ?1 AND f.blob_hash = ?2 AND f.deleted_at IS NULL)`, [id, hash]);
    if (valid) images.push({ id, name, mime, hash });
  }
  return images;
}

export function previewCardToDraft(db: SqlExecutor, card: PreviewCard, _page: PreviewPage): DraftQuestion {
  const text = card.text.trim();
  if (text === '') {
    throw new LegacyValidation(`卡片 ${card.card_id ?? '<unknown>'} 的题干为空，不能迁移`);
  }
  const raw = card.raw;
  const rawType = (string(raw.question_type) ?? '').trim() || 'other';
  const rawDifficulty = string(raw.difficulty)?.trim();
  const structured = object(raw.structured_data);
  const sectionPath = array(raw.section_path).filter((item): item is string => typeof item === 'string');
  return {
    local_id: `legacy:${card.card_id ?? 'card'}`,
    group_id: null,
    original_label: card.question_label,
    section_path: sectionPath,
    content: text,
    question_type: QUESTION_TYPES.includes(rawType) ? rawType : 'other',
    options: parseOptions(raw.options),
    answer: string(raw.answer),
    explanation: string(raw.explanation),
    structured_data: structured,
    difficulty: rawDifficulty !== undefined && ['easy', 'medium', 'hard', 'very_hard'].includes(rawDifficulty)
      ? rawDifficulty : null,
    tags: array(raw.tags).filter((item): item is string => typeof item === 'string'),
    source_refs: [],
    answer_source_refs: [],
    figures: [],
    images: usableImages(db, raw.images),
    answer_origin: null,
    smiles: null,
    smiles_caption: null,
    parent_id: null,
    parent_local_id: null,
    source_ref: null,
  };
}

export function legacySnapshot(cardId: string, card: PreviewCard, page: PreviewPage): Record<string, unknown> {
  return {
    card_id: cardId, page_index: card.page_index, card_index: card.card_index,
    question_label: card.question_label, page_blob_hash: page.blob_hash,
    page_original_image_path: page.original_image_path, page_width: page.width,
    page_height: page.height, card: card.raw,
  };
}

/** IPC `QuestionImage.role` 允许 `null`，L11 的仓储类型用 `undefined` 表示缺省。 */
function vfsImages(images: readonly QuestionImage[]): VfsQuestionImage[] {
  return images.map(image => ({
    id: image.id, name: image.name, mime: image.mime, hash: image.hash,
    ...(image.role == null ? {} : { role: image.role }),
  }));
}

export function bindMigratedCard(questions: QuestionRepository, db: SqlExecutor, examId: string,
  cardId: string, questionId: string, snapshot: Record<string, unknown>, auditVersion: string,
  stamp: string): void {
  const changedCard = questions.bindQuestionCard(db, examId, cardId, questionId, stamp);
  if (changedCard !== 1) throw new LegacyConflict('新迁移题目已被其他操作修改，未写入卡片身份');
  const marker = {
    legacy_migration: { exam_id: examId, card_id: cardId, audit_version: auditVersion, migrated_at: stamp },
    legacy_preview: snapshot as unknown as JsonValue,
  };
  const changedProvenance = questions.mergeQuestionProvenance(db, questionId, marker);
  if (changedProvenance !== 1) throw new LegacyConflict('新迁移题目来源写入失败');
}

export function mergePreviewUnion(original: Record<string, unknown>,
  projected: Record<string, unknown>): Record<string, unknown> {
  const merged = cloneJsonValue(original);
  if (!Array.isArray(merged.pages)) merged.pages = [];
  const pages = merged.pages as Record<string, unknown>[];
  for (const page of pages) if (!Array.isArray(page.cards)) page.cards = [];
  const knownCards = new Set<string>();
  for (const page of pages) {
    for (const raw of array(page.cards)) {
      const id = string(object(raw)?.card_id);
      if (id !== null) knownCards.add(id);
    }
  }
  for (const rawProjected of array(projected.pages)) {
    const projectedPage = object(rawProjected) ?? {};
    const blob = string(projectedPage.blob_hash);
    const pageIndex = numberOrNull(projectedPage.page_index) ?? 0;
    let target = pages.findIndex(page => (blob !== null && string(page.blob_hash) === blob)
      || numberOrNull(page.page_index) === pageIndex);
    if (target < 0) {
      pages.push(cloneJsonValue(projectedPage));
      target = pages.length - 1;
    }
    const targetPage = pages[target]!;
    if (!Array.isArray(targetPage.cards)) targetPage.cards = [];
    for (const rawCard of array(projectedPage.cards)) {
      const card = object(rawCard) ?? {};
      const cardId = string(card.card_id);
      if (cardId !== null) {
        if (knownCards.has(cardId)) continue;
        knownCards.add(cardId);
      }
      (targetPage.cards as unknown[]).push(cloneJsonValue(card));
    }
  }
  return merged;
}

export function savePreview(db: SqlExecutor, examId: string, preview: Record<string, unknown>,
  ports?: QbankPorts): void {
  const exams = ports?.exams;
  if (exams === undefined) {
    ports?.log?.warn(`[qbank] 无法保存预览：vfsRepo 未提供 exams 仓储 exam=${examId}`);
    return;
  }
  exams.updatePreviewJson(db, examId, preview as unknown as JsonValue);
}

// ---------------------------------------------------------------------------
// Reparse report / resolve (qbank_legacy_reconcile.rs:476-1860)
// ---------------------------------------------------------------------------

export interface ReparseFieldChange { field: string; before: unknown; after: unknown }

export interface ReparseItem {
  local_id: string;
  source_key: string | null;
  status: string;
  canonical_question_id: string | null;
  canonical_revision: string | null;
  candidate_question_ids: string[];
  changes: ReparseFieldChange[];
  allowed_actions: string[];
  reason: string | null;
}

export interface ReparseCanonicalOnlyItem {
  question_id: string;
  source_key: string;
  canonical_revision: string;
  question_label: string | null;
}

export interface ReparseResolveReceipt {
  exam_id: string;
  job_id: string;
  applied: { local_id: string; action: string; question_id: string | null }[];
  imported_question_ids: string[];
  replaced_question_ids: string[];
  kept_local_ids: string[];
}

export interface ReparseReport {
  exam_id: string;
  job_id: string;
  job_version: number;
  report_version: string;
  canonical_marker: boolean;
  canonical_question_count: number;
  items: ReparseItem[];
  canonical_only: ReparseCanonicalOnlyItem[];
  changed_count: number;
  new_count: number;
  deleted_count: number;
  ambiguous_count: number;
  resolved: boolean;
  resolution: ReparseResolveReceipt | null;
}

export interface ReparseDecision {
  local_id: string;
  action: string;
  expected_revision?: string | null;
}

export interface CanonicalRow {
  id: string;
  card_id: string | null;
  question_label: string | null;
  content: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structured_data: unknown;
  question_type: string;
  difficulty: string | null;
  tags: string[];
  images: QuestionImage[];
  source_key: string | null;
  deleted: boolean;
  updated_at: string;
  group_id: string | null;
  parent_id: string | null;
  provenance_json: string | null;
}

function parsedValue(raw: string | null): unknown {
  if (raw === null) return null;
  try { return valueFromStr(raw); } catch { return null; }
}

export function loadCanonicalRows(db: SqlExecutor, examId: string): CanonicalRow[] {
  return db.all<{
    id: string; card_id: string | null; question_label: string | null; content: string;
    options_json: string | null; answer: string | null; explanation: string | null;
    structured_data: string | null; question_type: string; difficulty: string | null;
    tags: string | null; images_json: string | null; source_key: string | null;
    deleted_at: string | null; updated_at: string; group_id: string | null;
    parent_id: string | null; provenance_json: string | null;
  }>(`SELECT id, card_id, question_label, content, options_json, answer, explanation,
      structured_data, question_type, difficulty, tags, images_json, source_key, deleted_at,
      updated_at, group_id, parent_id, provenance_json
    FROM questions WHERE exam_id = ?1`, [examId])
    .map(row => {
      const tags = parsedValue(row.tags);
      const images = parsedValue(row.images_json);
      return {
        id: row.id, card_id: row.card_id, question_label: row.question_label,
        content: row.content, options: parsedValue(row.options_json) as QuestionOption[] | null,
        answer: row.answer, explanation: row.explanation,
        structured_data: parsedValue(row.structured_data), question_type: row.question_type,
        difficulty: row.difficulty, tags: Array.isArray(tags) ? tags as string[] : [],
        images: Array.isArray(images) ? images as QuestionImage[] : [],
        source_key: row.source_key, deleted: row.deleted_at !== null,
        updated_at: row.updated_at, group_id: row.group_id, parent_id: row.parent_id,
        provenance_json: row.provenance_json,
      };
    });
}

export function loadCanonicalRow(db: SqlExecutor, examId: string, questionId: string): CanonicalRow | null {
  return loadCanonicalRows(db, examId).find(row => row.id === questionId) ?? null;
}

export function canonicalRevision(row: CanonicalRow): string {
  return hashValue({
    id: row.id, card_id: row.card_id, source_key: row.source_key, group_id: row.group_id,
    parent_id: row.parent_id, provenance_json: row.provenance_json, content: row.content,
    options: row.options, answer: row.answer, explanation: row.explanation,
    structured_data: row.structured_data, question_type: row.question_type,
    difficulty: row.difficulty, tags: row.tags, images: row.images, updated_at: row.updated_at,
  });
}

export function expectedReparseContent(question: DraftQuestion): string {
  let content = question.content;
  if (question.smiles !== null && question.smiles !== undefined) {
    content += `\n\n\`\`\`smiles\n${question.smiles}\n\`\`\``;
    if (question.smiles_caption !== null && question.smiles_caption !== undefined) {
      content += `\n${question.smiles_caption}`;
    }
  }
  return content;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

export function diffQuestion(question: DraftQuestion, row: CanonicalRow): ReparseFieldChange[] {
  const changes: ReparseFieldChange[] = [];
  const push = (field: string, before: unknown, after: unknown): void => {
    if (!deepEqual(before, after)) changes.push({ field, before, after });
  };
  push('content', row.content, expectedReparseContent(question));
  push('options', row.options, question.options);
  push('answer', row.answer, question.answer);
  push('explanation', row.explanation, question.explanation);
  push('structured_data', row.structured_data ?? null, question.structured_data ?? null);
  push('question_type', row.question_type, question.question_type);
  push('difficulty', row.difficulty, question.difficulty);
  push('tags', row.tags, question.tags);
  return changes;
}

export function draftSourceSlot(db: SqlExecutor, examId: string, metadata: JsonValue,
  question: DraftQuestion): { slot: string | null; reason: string | null } {
  if (question.answer_origin === 'generated') {
    return { slot: null, reason: '草稿题目答案由模型生成，没有可复核来源槽' };
  }
  const sourcesValue = jsonField(metadata, 'sources');
  const sources: unknown[] = Array.isArray(sourcesValue) ? sourcesValue : [];
  if (sources.length === 0 || question.source_refs.length === 0) {
    return { slot: null, reason: null };
  }
  if (question.original_label === null || question.original_label.trim() === '') {
    return { slot: null, reason: '草稿题目缺少原题号，无法建立稳定来源槽' };
  }
  const mapping = new Map<string, string>();
  for (const raw of sources) {
    const source = object(raw);
    if (source === null) continue;
    const local = string(source.source_id);
    const key = string(source.content_hash) ?? string(source.blob_hash);
    if (local === null || key === null) continue;
    const stable = `${key}:${string(source.anchor) ?? ''}`;
    const id = db.pluck<string>(
      `SELECT id FROM qbank_sources WHERE exam_id = ?1 AND source_key = ?2 AND deleted_at IS NULL`,
      [examId, stable]);
    if (id !== undefined) mapping.set(local, id);
  }
  const sourceIds: [string, number | null][] = [];
  for (const reference of question.source_refs) {
    const id = mapping.get(reference.source_id);
    if (id === undefined) {
      return { slot: null, reason: '草稿来源尚未持久化，无法与正式来源槽比较' };
    }
    sourceIds.push([id, reference.page ?? null]);
  }
  const slot = hashValue([sourceIds, question.section_path, question.original_label]);
  return { slot, reason: null };
}

export function supportsStandaloneImport(question: DraftQuestion): boolean {
  return (question.group_id === null || question.group_id === undefined)
    && (question.parent_local_id === null || question.parent_local_id === undefined)
    && (question.parent_id === null || question.parent_id === undefined);
}

function restrictReparseActions(item: ReparseItem, question: DraftQuestion, resolved: boolean): void {
  if (resolved) {
    item.allowed_actions = [];
    item.reason = '该草稿已完成复核；原决策重试只返回已保存结果，不会再次导入';
  } else if (!supportsStandaloneImport(question)) {
    item.allowed_actions = item.allowed_actions.filter(action => action !== 'import_as_new');
  }
}

const REPARSE_ACTIONS = ['keep_existing', 'import_as_new', 'replace_existing'];

export function normalizeReparseDecisions(document: { questions: DraftQuestion[] },
  decisions: ReparseDecision[]): ReparseDecision[] {
  const normalized = new Map<string, ReparseDecision>();
  for (const question of document.questions) {
    normalized.set(question.local_id, {
      local_id: question.local_id, action: 'keep_existing', expected_revision: null,
    });
  }
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.local_id)) throw new LegacyValidation('同一草稿题目不能重复决策');
    seen.add(decision.local_id);
    if (!normalized.has(decision.local_id)) {
      throw new LegacyValidation(`草稿题目不存在: ${decision.local_id}`);
    }
    if (!REPARSE_ACTIONS.includes(decision.action)) {
      throw new LegacyValidation(`未知操作: ${decision.action}`);
    }
    if (decision.action === 'replace_existing'
      && (decision.expected_revision === null || decision.expected_revision === ''
        || decision.expected_revision === undefined)) {
      throw new LegacyValidation('替换操作必须携带 expected_revision');
    }
    normalized.set(decision.local_id, {
      local_id: decision.local_id, action: decision.action,
      expected_revision: decision.action === 'replace_existing'
        ? decision.expected_revision ?? null : null,
    });
  }
  return [...normalized.values()].sort((left, right) =>
    left.local_id < right.local_id ? -1 : left.local_id > right.local_id ? 1 : 0);
}

export function imageExists(db: SqlExecutor, imageId: string, hash: string): boolean {
  return Boolean(db.pluck<number>(
    `SELECT EXISTS(SELECT 1 FROM files f JOIN blobs b ON b.hash = f.blob_hash
      WHERE f.id = ?1 AND f.blob_hash = ?2 AND f.deleted_at IS NULL)`, [imageId, hash]));
}

export function reparseReport(db: SqlExecutor, examId: string, requestedJobId: string | null): ReparseReport {
  const exam = db.get<{ metadata_json: string }>(
    'SELECT metadata_json FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL', [examId]);
  if (exam === undefined) throw new LegacyNotFound('目标题目集不存在');
  const metadata = object(parsedValue(exam.metadata_json)) ?? {};
  const canonicalMarker = metadata.question_document_version === 2;
  let jobId = requestedJobId;
  if (jobId === null) {
    const found = db.pluck<string>(
      `SELECT id FROM qbank_import_jobs WHERE exam_id = ?1
        AND (status IN ('ready','needs_review','partial','committed')
          OR json_type(metadata_json, '$.reparse_resolution') = 'object')
        AND json_type(metadata_json, '$.reparse_import') IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 1`, [examId]);
    if (found === undefined) throw new LegacyNotFound('当前题目集没有可复核的导入草稿');
    jobId = found;
  }
  const draft = readDraft(db, jobId);
  if (draft.exam_id !== examId) throw new LegacyValidation('草稿不属于目标题目集');
  // qbank_legacy_reconcile.rs:1042-1047
  const saved = jsonGet(draft.metadata, 'reparse_resolution');
  const resolution: ReparseResolveReceipt | null = saved === undefined ? null
    : reparseResolveReceipt(jsonField(saved, 'receipt'), 'receipt');
  const resolved = resolution !== null;
  const rows = loadCanonicalRows(db, examId);
  const liveCount = rows.filter(row => !row.deleted).length;
  const bySource = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    if (row.source_key === null) continue;
    const list = bySource.get(row.source_key) ?? [];
    list.push(row);
    bySource.set(row.source_key, list);
  }
  const matchedKeys = new Set<string>();
  const items: ReparseItem[] = [];
  let changedCount = 0;
  let newCount = 0;
  let deletedCount = 0;
  let ambiguousCount = 0;
  for (const question of draft.document.questions) {
    const slotResult = draftSourceSlot(db, examId, draft.metadata, question);
    const item: ReparseItem = {
      local_id: question.local_id, source_key: slotResult.slot, status: '',
      canonical_question_id: null, canonical_revision: null, candidate_question_ids: [],
      changes: [], allowed_actions: [], reason: null,
    };
    if (slotResult.slot === null) {
      if (canonicalMarker && liveCount === 0) {
        item.status = 'deleted';
        item.reason = '规范化题目集已无正式题目；不会从无来源槽草稿重建题目';
        item.allowed_actions = ['keep_existing'];
        deletedCount += 1;
      } else {
        item.status = 'unmapped';
        item.reason = slotResult.reason
          ?? '草稿缺少稳定来源槽，不能与正式题目建立身份映射';
        item.allowed_actions = ['keep_existing', 'import_as_new'];
      }
      restrictReparseActions(item, question, resolved);
      items.push(item);
      continue;
    }
    const candidates = bySource.get(slotResult.slot) ?? [];
    const live = candidates.filter(row => !row.deleted);
    const deleted = candidates.filter(row => row.deleted);
    item.candidate_question_ids = candidates.map(row => row.id);
    if (canonicalMarker && liveCount === 0 && live.length === 0) {
      item.status = 'deleted';
      item.reason = '规范化题目集已无正式题目；不会从草稿/预览重建已删除的题目';
      item.allowed_actions = ['keep_existing'];
      deletedCount += 1;
    } else if (live.length > 1) {
      item.status = 'ambiguous';
      item.reason = '多个正式题目共享同一来源槽，未做覆盖猜测';
      item.allowed_actions = ['keep_existing'];
      ambiguousCount += 1;
    } else if (live.length === 1) {
      const row = live[0]!;
      matchedKeys.add(slotResult.slot);
      item.canonical_question_id = row.id;
      item.canonical_revision = canonicalRevision(row);
      const changes = diffQuestion(question, row);
      if (changes.length === 0) {
        item.status = 'unchanged';
        item.allowed_actions = ['keep_existing'];
      } else {
        item.status = 'changed';
        item.changes = changes;
        item.allowed_actions = ['keep_existing', 'import_as_new', 'replace_existing'];
        changedCount += 1;
      }
    } else if (deleted.length > 0) {
      item.status = 'deleted';
      item.canonical_question_id = deleted[0]!.id;
      item.reason = '对应正式题目已删除；如需恢复必须显式恢复原题';
      item.allowed_actions = ['keep_existing'];
      deletedCount += 1;
    } else {
      item.status = 'new';
      item.allowed_actions = ['keep_existing', 'import_as_new'];
      newCount += 1;
    }
    restrictReparseActions(item, question, resolved);
    items.push(item);
  }
  const canonicalOnly: ReparseCanonicalOnlyItem[] = [];
  for (const row of rows) {
    if (row.deleted || row.source_key === null) continue;
    if (!matchedKeys.has(row.source_key)) {
      canonicalOnly.push({
        question_id: row.id, source_key: row.source_key,
        canonical_revision: canonicalRevision(row), question_label: row.question_label,
      });
    }
  }
  canonicalOnly.sort((left, right) => left.question_id < right.question_id ? -1
    : left.question_id > right.question_id ? 1 : 0);
  const reportVersion = hashValue({
    exam_id: examId, job_id: jobId, job_version: draft.version, document: draft.document,
    metadata: draft.metadata, canonical_marker: canonicalMarker,
    canonical_question_count: liveCount,
    items: items.map(item => ({
      local_id: item.local_id, source_key: item.source_key, status: item.status,
      canonical_question_id: item.canonical_question_id,
      canonical_revision: item.canonical_revision, candidates: item.candidate_question_ids,
    })),
    canonical_only: canonicalOnly.map(item => ({
      question_id: item.question_id, source_key: item.source_key,
      canonical_revision: item.canonical_revision,
    })),
  });
  return {
    exam_id: examId, job_id: jobId, job_version: draft.version, report_version: reportVersion,
    canonical_marker: canonicalMarker, canonical_question_count: liveCount, items, canonical_only: canonicalOnly,
    changed_count: changedCount, new_count: newCount, deleted_count: deletedCount,
    ambiguous_count: ambiguousCount, resolved, resolution,
  };
}

export function replaceCanonicalRow(questions: QuestionRepository, db: SqlExecutor, examId: string,
  questionId: string, expectedRevision: string, question: DraftQuestion, jobId: string,
  stamp: string): void {
  const current = loadCanonicalRow(db, examId, questionId);
  if (current === null) throw new LegacyNotFound('待替换的正式题目不存在');
  if (current.deleted) {
    throw new LegacyConflict('待替换的正式题目已删除；请显式恢复原题而不是重建身份');
  }
  if (canonicalRevision(current) !== expectedRevision) {
    throw new LegacyConflict('题目版本已变化，请重新载入后再替换');
  }
  const marker = {
    reparse: {
      job_id: jobId, local_id: question.local_id, applied_at: stamp,
      action: 'replace_existing', previous_revision: expectedRevision,
    },
  };
  const changed = questions.replaceQuestionForReparse(db, examId, questionId, current.updated_at, {
    content: expectedReparseContent(question),
    options: question.options,
    answer: question.answer,
    explanation: question.explanation,
    question_type: toQuestionType(question.question_type),
    difficulty: question.difficulty === null ? null : toDifficulty(question.difficulty),
    tags: question.tags,
    structured_data: question.structured_data as JsonValue,
    images: vfsImages(question.images),
    provenance_marker: marker,
  }, stamp);
  if (changed !== 1) throw new LegacyConflict('题目已被其他操作修改，未覆盖任何历史内容');
}

export function applyReparseImportMarker(questions: QuestionRepository, db: SqlExecutor,
  questionId: string, jobId: string, question: DraftQuestion, stamp: string): void {
  const marker = {
    reparse: {
      job_id: jobId, local_id: question.local_id, applied_at: stamp, action: 'import_as_new',
      draft_source_refs: question.source_refs, draft_answer_source_refs: question.answer_source_refs,
    },
  };
  questions.mergeQuestionProvenance(db, questionId, marker);
}

export function reparseResolveRow(db: SqlExecutor, jobId: string, examId: string,
  expectedVersion: number, resolution: Record<string, unknown>, stamp: string): number {
  return db.run(`UPDATE qbank_import_jobs
    SET metadata_json = json_set(metadata_json, '$.reparse_resolution', json(?1)),
        status = CASE WHEN status = 'committed' THEN status ELSE 'cancelled' END,
        version = version + 1, updated_at = ?2
    WHERE id = ?3 AND exam_id = ?4 AND version = ?5
      AND json_extract(metadata_json, '$.reparse_resolution') IS NULL`,
  [JSON.stringify(resolution), stamp, jobId, examId, expectedVersion]).changes;
}

export function examImportState(db: SqlExecutor, examId: string, ports?: QbankPorts): string | null {
  const exams = ports?.exams;
  if (exams !== undefined) return exams.getImportState(db, examId);
  const value = db.pluck<string>('SELECT import_state_json FROM exam_sheets WHERE id = ?1', [examId]);
  return value === undefined ? null : value;
}

/** qbank_legacy_reconcile.rs:696-699：按原文写 import_state_json（不重新序列化、不改 updated_at）。 */
export function writeExamImportStateText(db: SqlExecutor, examId: string, state: string | null): void {
  db.run('UPDATE exam_sheets SET import_state_json = ?1 WHERE id = ?2', [state, examId]);
}

export function updateExamImportState(db: SqlExecutor, examId: string, state: string | null,
  ports?: QbankPorts): void {
  const exams = ports?.exams;
  if (exams === undefined) {
    ports?.log?.warn(`[qbank] 无法保存导入状态：vfsRepo 未提供 exams 仓储 exam=${examId}`);
    return;
  }
  if (state === null) {
    exams.clearImportState(db, examId);
    return;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(state) as JsonValue;
  } catch (error) {
    throw new LegacyValidation(`导入状态不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  exams.updateImportState(db, examId, parsed);
}

export function decisionsEqual(left: ReparseDecision[], right: ReparseDecision[]): boolean {
  return deepEqual(left, right);
}

export { deepEqual as legacyDeepEqual };
