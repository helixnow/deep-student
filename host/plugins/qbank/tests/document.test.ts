import { describe, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { DraftQuestion, QuestionDocument } from '../api.ts';
import { documentNeedsReview, validateDocument } from '../src/document.ts';
import { valueFromStr } from '../src/raw-json-number.ts';

function document(): QuestionDocument {
  const question: DraftQuestion = {
    local_id: 'q1', content: 'question', question_type: 'short_answer', group_id: null, original_label: null,
    section_path: [], options: null, answer: null, explanation: null, structured_data: null, difficulty: null,
    tags: [], source_refs: [], answer_source_refs: [], figures: [], images: [], answer_origin: null,
    smiles: null, smiles_caption: null, parent_id: null, parent_local_id: null, source_ref: null,
  };
  return { schema_version: 2, mode: 'extract', materials: [], groups: [], questions: [question], unmatched_answers: [], coverage: [], issues: [] };
}

describe('qbank_document.rs', () => {
  it('ordinary_legacy_question_remains_valid_without_invented_answer', () => {
    expect(() => validateDocument(document())).not.toThrow();
  });
  it('duplicate_ids_and_dangling_members_are_rejected', () => {
    const duplicate = document();
    duplicate.questions.push(structuredClone(duplicate.questions[0]!));
    expect(() => validateDocument(duplicate)).toThrow(CommandError);
    const dangling = document();
    dangling.questions[0]!.group_id = 'missing';
    expect(() => validateDocument(dangling)).toThrow(CommandError);
  });
  it('serialized_backup_retains_historical_answer_origin', () => {
    const historical = document();
    historical.questions[0]!.answer_origin = 'generated';
    expect(() => validateDocument(historical)).not.toThrow();
  });
  it('preserves generate/extract distinctions, actionable material errors, structured checks, and review flags', () => {
    const d = document();
    d.mode = 'generate';
    expect(() => validateDocument(d)).toThrow(CommandError);
    d.questions[0]!.answer = 'answer';
    expect(() => validateDocument(d)).not.toThrow();
    d.groups = [{ local_id: 'g1', label: '', material_ids: ['missing'], question_ids: ['q1'] }];
    expect(() => validateDocument(d)).toThrow(CommandError);
    d.groups = [];
    d.questions[0]!.question_type = 'numeric';
    d.questions[0]!.answer = null;
    d.questions[0]!.structured_data = { answer_value: 1, tolerance: -1 };
    expect(() => validateDocument(d)).toThrow(CommandError);
    d.questions[0]!.structured_data = { answer_value: 1, tolerance: 0 };
    expect(() => validateDocument(d)).not.toThrow();
    expect(documentNeedsReview(d)).toBe(false);
    d.coverage = [{ status: 'processed' }];
    expect(documentNeedsReview(d)).toBe(false);
    d.coverage = [{}];
    expect(documentNeedsReview(d)).toBe(true);
  });
  it('numeric structured_data reads Value numbers with as_f64, lossless raw atoms included (qbank_document.rs:326)', () => {
    const d = document();
    const question = d.questions[0]!;
    question.question_type = 'numeric';
    const value = (text: string) => valueFromStr(text) as QuestionDocument['questions'][number]['structured_data'];
    question.structured_data = value('{"answer_value":3.14,"tolerance":1e-2}');
    expect(() => validateDocument(d)).not.toThrow();
    question.structured_data = value('{"answer_value":2.50}');
    expect(() => validateDocument(d)).not.toThrow();
    question.structured_data = value('{"answer_value":3.14,"tolerance":-0.5}');
    expect(() => validateDocument(d)).toThrow(CommandError);
    question.structured_data = value('{"answer_value":1e400}');
    expect(() => validateDocument(d)).toThrow(CommandError);
    question.structured_data = value('{"answer_value":"3.14"}');
    expect(() => validateDocument(d)).toThrow(CommandError);
    // arbitrary_precision `as_f64` 过滤非有限值：tolerance 1e400 读作 None，`is_some_and(..)` 为 false，不拒绝。
    question.structured_data = value('{"answer_value":3.14,"tolerance":1e400}');
    expect(() => validateDocument(d)).not.toThrow();
  });
});
