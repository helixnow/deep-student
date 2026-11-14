/**
 * Field-by-field decoders for authoring JSON (qbank_document.rs, qbank_authoring_service.rs:37).
 * Field order and serde attributes follow the Rust structs listed beside each decoder.
 */
import type {
  AuthoringCommitReceipt, DraftFigure, DraftGroup, DraftMaterial, DraftQuestion, QuestionDocument, QuestionOption,
  ReparseAppliedItem, ReparseDecision, ReparseResolveReceipt,
} from '../api.ts';
import { questionImage, sourceRef } from './practice-decode.ts';
import {
  alias, boolean, dflt, f64, json, opt, req, string, struct, tuple4, u32, usize, vec, type Decoder,
} from './serde-decode.ts';

const questionOption = struct<QuestionOption>('QuestionOption', { key: req(string), content: req(string) });

/** qbank_document.rs:12 */
const draftFigure = struct<DraftFigure>('DraftFigure', {
  source_id: req(string), page: opt(u32), bbox: req(tuple4(f64)),
  label: dflt(string, () => ''), role: dflt(string, () => ''),
});

/** qbank_document.rs:23 */
const draftMaterial = struct<DraftMaterial>('DraftMaterial', {
  local_id: req(string), content: req(string), source_refs: dflt(vec(sourceRef), () => []),
  figures: dflt(vec(draftFigure), () => []), images: dflt(vec(questionImage), () => []),
});

/** qbank_document.rs:34 */
const draftGroup = struct<DraftGroup>('DraftGroup', {
  local_id: req(string), label: dflt(string, () => ''), material_ids: dflt(vec(string), () => []),
  question_ids: req(vec(string)),
});

/** qbank_document.rs:43 */
const draftQuestion = struct<DraftQuestion>('DraftQuestion', {
  local_id: req(string), group_id: opt(string),
  original_label: alias(opt(string), 'questionLabel', 'question_label'),
  section_path: dflt(vec(string), () => []), content: req(string),
  question_type: alias(req(string), 'questionType'),
  options: opt(vec(questionOption)), answer: opt(string), explanation: opt(string), structured_data: opt(json),
  difficulty: opt(string), tags: dflt(vec(string), () => []), source_refs: dflt(vec(sourceRef), () => []),
  answer_source_refs: dflt(vec(sourceRef), () => []), figures: dflt(vec(draftFigure), () => []),
  images: dflt(vec(questionImage), () => []), answer_origin: opt(string), smiles: opt(string),
  smiles_caption: opt(string), parent_id: opt(string),
  parent_local_id: alias(opt(string), 'variant_parent_local_id'), source_ref: opt(string),
});

/** qbank_document.rs:88 */
export const questionDocument: Decoder<QuestionDocument> = struct<QuestionDocument>('QuestionDocument', {
  schema_version: req(u32), mode: req(string), materials: dflt(vec(draftMaterial), () => []),
  groups: dflt(vec(draftGroup), () => []), questions: req(vec(draftQuestion)),
  unmatched_answers: dflt(vec(json), () => []), coverage: dflt(vec(json), () => []),
  issues: dflt(vec(json), () => []),
});

/** qbank_authoring_service.rs:37 */
export const commitReceipt: Decoder<AuthoringCommitReceipt> = struct<AuthoringCommitReceipt>('AuthoringCommitReceipt', {
  committed: req(boolean), exam_id: req(string), question_ids: req(vec(string)),
  material_ids: req(vec(string)), group_ids: req(vec(string)), imported_count: req(usize),
  total_questions: req(usize), partial: req(boolean), needs_review: req(boolean),
  coverage: req(vec(json)), unmatched_answers: req(vec(json)),
});

/** qbank_legacy_reconcile.rs:178 */
export const reparseDecision: Decoder<ReparseDecision> = struct<ReparseDecision>('ReparseDecision', {
  local_id: req(string), action: req(string), expected_revision: opt(string),
});

/** qbank_legacy_reconcile.rs:188 */
const reparseAppliedItem = struct<ReparseAppliedItem>('ReparseAppliedItem', {
  local_id: req(string), action: req(string), question_id: opt(string),
});

/** qbank_legacy_reconcile.rs:195 */
export const reparseResolveReceipt: Decoder<ReparseResolveReceipt> = struct<ReparseResolveReceipt>(
  'ReparseResolveReceipt', {
    exam_id: req(string), job_id: req(string), applied: req(vec(reparseAppliedItem)),
    imported_question_ids: req(vec(string)), replaced_question_ids: req(vec(string)),
    kept_local_ids: req(vec(string)),
  });
