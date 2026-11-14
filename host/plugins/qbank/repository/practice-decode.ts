/**
 * Field-by-field decoders for practice/paper `document_json` (qbank_practice.rs `decode`,
 * question_bank_service.rs `GeneratedPaper`). Field order and serde attributes follow the
 * Rust structs listed beside each decoder.
 */
import type {
  GeneratedPaper, GradingDiagnostics, PaperConfig, PracticeAttempt, PracticeDraft, PracticeGradingDraft,
  PracticeResult, Question, QuestionImage, QuestionMaterial, QuestionOption, SourceRef,
} from '../api.ts';
import {
  boolean, dflt, f64, i32, i64, json, map, opt, req, string, struct, tuple4, u16, u32, unitEnum, usize, vec,
  type Decoder,
} from './serde-decode.ts';

/** question_repo.rs:250 */
const questionOption = struct<QuestionOption>('QuestionOption', {
  key: req(string), content: req(string),
});

/** question_repo.rs:257; `role` is `default, skip_serializing_if = "Option::is_none"`. */
export const questionImage = struct<QuestionImage>('QuestionImage', {
  id: req(string), name: req(string), mime: req(string), hash: req(string), role: opt(string, true),
});

/** qbank_types.rs:11 */
export const sourceRef = struct<SourceRef>('SourceRef', {
  source_id: req(string), page: opt(u32), bbox: opt(tuple4(f64)),
});

/** qbank_types.rs:20 */
const questionMaterial = struct<QuestionMaterial>('QuestionMaterial', {
  id: req(string), content: req(string),
  images: dflt(vec(questionImage), () => []), source_refs: dflt(vec(sourceRef), () => []),
  version: req(i64),
});

const questionType = unitEnum(['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank',
  'short_answer', 'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other']);
const difficulty = unitEnum(['easy', 'medium', 'hard', 'very_hard']);
const questionStatus = unitEnum(['new', 'in_progress', 'mastered', 'review']);
const sourceType = unitEnum(['ocr', 'imported', 'ai_generated', 'manual']);

/** question_repo.rs:277 `Question`. */
export const question = struct<Question>('Question', {
  id: req(string), exam_id: req(string), card_id: opt(string), question_label: opt(string),
  content: req(string), options: opt(vec(questionOption)), answer: opt(string), explanation: opt(string),
  structured_data: opt(json), question_type: req(questionType), difficulty: opt(difficulty),
  tags: req(vec(string)), status: req(questionStatus), user_answer: opt(string), is_correct: opt(boolean),
  attempt_count: req(i32), correct_count: req(i32), last_attempt_at: opt(string), user_note: opt(string),
  is_favorite: req(boolean), is_bookmarked: req(boolean), source_type: req(sourceType),
  source_ref: opt(string), images: req(vec(questionImage)), parent_id: opt(string),
  created_at: req(string), updated_at: req(string), ai_feedback: opt(string), ai_score: opt(i32),
  ai_graded_at: opt(string), group_id: opt(string), group_position: opt(i32), group_label: opt(string),
  materials: dflt(vec(questionMaterial), () => []), answer_origin: opt(string),
  source_refs: dflt(vec(sourceRef), () => []), answer_source_refs: dflt(vec(sourceRef), () => []),
  source_key: opt(string),
});

/** qbank_grading/types.rs:75 */
const gradingDiagnostics = struct<GradingDiagnostics>('GradingDiagnostics', {
  status: req(unitEnum(['completed', 'cancelled', 'truncated', 'provider_error', 'transport_error',
    'incomplete', 'invalid_result', 'configuration_error', 'persistence_error'])),
  model: req(string), model_config_id: req(string), max_output_tokens: req(u32),
  finish_reason: opt(string), usage: opt(json), response_chars: req(usize), reasoning_chars: req(usize),
  http_status: opt(u16), error_message: opt(string),
});

/** qbank_practice.rs:57 */
const practiceGradingDraft = struct<PracticeGradingDraft>('PracticeGradingDraft', {
  feedback: req(string), error: req(string), diagnostics: opt(gradingDiagnostics), created_at: req(string),
});

/** qbank_practice.rs:41 */
const practiceResult = struct<PracticeResult>('PracticeResult', {
  question_id: req(string), status: req(string), is_correct: opt(boolean), score: opt(i32),
  feedback: opt(string), error: opt(string), submission_id: opt(string), source_available: req(boolean),
  grading_diagnostics: opt(gradingDiagnostics), grading_drafts: dflt(vec(practiceGradingDraft), () => []),
});

/** qbank_practice.rs:22 */
export const practiceDraft: Decoder<PracticeDraft> = struct<PracticeDraft>('PracticeDraft', {
  id: req(string), scope_id: req(string), paper_id: opt(string), title: req(string), mode: req(string),
  questions: req(vec(question)), answers: req(map(string)), marked_ids: req(vec(string)),
  current_index: req(usize), elapsed_seconds: req(u32), duration_seconds: opt(u32), deadline: opt(string),
  revision: req(i64), created_at: req(string), updated_at: req(string),
});

/** qbank_practice.rs:65 */
export const practiceAttempt: Decoder<PracticeAttempt> = struct<PracticeAttempt>('PracticeAttempt', {
  id: req(string), scope_id: req(string), paper_id: opt(string), title: req(string), mode: req(string),
  questions: req(vec(question)), answers: req(map(string)), marked_ids: req(vec(string)),
  results: req(vec(practiceResult)), elapsed_seconds: req(u32), duration_seconds: opt(u32),
  status: req(string), origin_device_id: req(string), created_at: req(string), submitted_at: req(string),
});

/** question_bank_service.rs:3464 */
const paperConfig = struct<PaperConfig>('PaperConfig', {
  title: req(string), type_selection: req(map(u32)), difficulty_filter: opt(vec(string)),
  tags_filter: opt(vec(string)), shuffle: req(boolean), include_answers: req(boolean),
  include_explanations: req(boolean), export_format: req(unitEnum(['preview', 'pdf', 'word', 'markdown'])),
});

/** question_bank_service.rs:3516 */
export const generatedPaper: Decoder<GeneratedPaper> = struct<GeneratedPaper>('GeneratedPaper', {
  id: req(string), title: req(string), exam_id: req(string), questions: req(vec(question)),
  total_score: req(u32), config: req(paperConfig), created_at: req(string), export_path: opt(string),
});
