/**
 * `qbank_generation/pipeline.rs` 的纯数据步骤：
 * `normalize_generation_root` / `validate_generation_source_refs` / `legacy_drafts`。
 *
 * 管线编排（参考资料收集、视觉兜底、`run_question_json`、配图落库、草稿保存）
 * 依赖 L18 栅格化/docx 带图抽取与 L13b `extract_file_text_with_strategy`，
 * 由 `generation-runner.ts` 编排。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { GeneratedQuestionDraft, QuestionDocument } from '../api.ts';
import { QbankServiceError } from './question-service.ts';
import { asU64, coverageKey, expectedCoverage, type SourceBundle } from './source-bundle.ts';

type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rust `normalize_generation_root`：强制 v2/generate，补齐缺失数组，
 * 有非空答案的题标记 answer_origin=generated。根必须是对象（Rust 对非对象
 * `raw["x"] = ...` 会 panic；调用方已经过 complete_json_payload 保证是对象）。
 */
export function normalizeGenerationRoot(raw: JsonObject): void {
  raw.schema_version = 2;
  raw.mode = 'generate';
  for (const key of ['materials', 'groups', 'unmatched_answers', 'issues', 'coverage']) {
    if (!Array.isArray(raw[key])) raw[key] = [];
  }
  const questions = raw.questions;
  if (!Array.isArray(questions)) return;
  for (const question of questions) {
    if (!isObject(question)) continue;
    const answer = question.answer;
    if (typeof answer === 'string' && answer.trim() !== '') question.answer_origin = 'generated';
  }
}

/** Rust `validate_generation_source_refs`：禁止引用未提供的来源或页码。 */
export function validateGenerationSourceRefs(raw: JsonValue, bundle: SourceBundle): void {
  const expected = expectedCoverage(bundle);
  if (!isObject(raw)) return;
  const items = [
    ...(Array.isArray(raw.questions) ? raw.questions : []),
    ...(Array.isArray(raw.materials) ? raw.materials : []),
  ];
  for (const item of items) {
    for (const field of ['source_refs', 'answer_source_refs', 'figures']) {
      const refs = isObject(item) ? item[field] : undefined;
      if (!Array.isArray(refs)) continue;
      for (const reference of refs) {
        const sourceId = isObject(reference) && typeof reference.source_id === 'string' ? reference.source_id : '';
        const page = isObject(reference) ? asU64(reference.page) : null;
        if (!expected.has(coverageKey(sourceId, page))) {
          throw new QbankServiceError(AppError.validation(`${field} 引用了未提供的来源或页码，禁止伪造来源`));
        }
      }
    }
  }
}

/** Rust `legacy_drafts`（serde：local_id/group_id/original_label/structured_data/source_ref 为 None 时省略）。 */
export function legacyDrafts(document: QuestionDocument): GeneratedQuestionDraft[] {
  return document.questions.map(question => {
    const draft: GeneratedQuestionDraft = { local_id: question.local_id } as GeneratedQuestionDraft;
    if (question.group_id !== null && question.group_id !== undefined) draft.group_id = question.group_id;
    if (question.original_label !== null && question.original_label !== undefined) {
      draft.original_label = question.original_label;
    }
    draft.question_type = question.question_type;
    draft.content = question.content;
    draft.options = question.options === null || question.options === undefined ? null
      : question.options.map(option => ({ key: option.key, content: option.content }));
    draft.answer = question.answer ?? null;
    draft.explanation = question.explanation ?? null;
    draft.difficulty = question.difficulty ?? null;
    draft.tags = question.tags.length === 0 ? null : [...question.tags];
    if (question.structured_data !== null && question.structured_data !== undefined) {
      draft.structured_data = question.structured_data;
    }
    draft.smiles = question.smiles ?? null;
    draft.smiles_caption = question.smiles_caption ?? null;
    if (question.source_ref !== null && question.source_ref !== undefined) draft.source_ref = question.source_ref;
    return draft;
  });
}
