import { describe, expect, it } from 'vitest';
import type { Question, QuestionMaterial, QuestionOption } from '../api.ts';
import {
  GradingContext, materialSnapshotJson, questionSnapshotJson,
} from '../src/grading-context.ts';
import {
  IMAGE_ANSWER_MAX_DECODED_BYTES, IMAGE_ANSWER_MAX_IMAGES, IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES,
  ImageAnswerValidation, parseImageAnswerEnvelope, validateImageSizes,
} from '../src/image-answer.ts';

function question(): Question {
  return {
    id: 'q1', exam_id: 'exam1', card_id: null, question_label: '1', content: '原始题干',
    options: null, answer: '原始答案', explanation: null, structured_data: null,
    question_type: 'short_answer', difficulty: null, tags: [], status: 'new',
    user_answer: null, is_correct: null, attempt_count: 0, correct_count: 0,
    last_attempt_at: null, user_note: null, is_favorite: false, is_bookmarked: false,
    source_type: 'manual', source_ref: null, images: [], parent_id: null,
    created_at: '', updated_at: '', ai_feedback: null, ai_score: null, ai_graded_at: null,
    group_id: null, group_position: null, group_label: null, materials: [],
    answer_origin: null, source_refs: [], answer_source_refs: [], source_key: null,
  };
}

function material(content: string, version: number, id = 'm1'): QuestionMaterial {
  return { id, content, images: [], source_refs: [], version };
}

function envelopeJson(images: unknown[], text: unknown): string {
  return JSON.stringify({ type: 'image_answer', images, text });
}

function imageValue(id: string, mime: string): Record<string, unknown> {
  return { id, name: `${id}.jpg`, mime, hash: `h-${id}` };
}

describe('qbank_grading/context.rs', () => {
  it('snapshot_overrides_live_question_version', () => {
    const context = GradingContext.fromQuestion(question());
    context.applySnapshots(JSON.stringify({
      content: '提交时题干', answer: '提交时答案', question_label: '2',
      options: [{ key: 'A', content: '选项甲' }],
    }), null);
    expect(context.content).toBe('提交时题干');
    expect(context.answer).toBe('提交时答案');
    expect(context.question_label).toBe('2');
    expect(context.options).toHaveLength(1);
  });

  it('corrupted_snapshot_is_reported_not_silently_ignored', () => {
    const context = GradingContext.fromQuestion(question());
    expect(() => context.applySnapshots('not-json', null)).toThrow();
    expect(() => context.applySnapshots(null, '{')).toThrow();
  });

  it('material_snapshot_replaces_live_materials', () => {
    const context = GradingContext.fromQuestion(question());
    context.applySnapshots(null, JSON.stringify({
      materials: [{ id: 'm1', content: '提交时共享材料', images: [], source_refs: [], version: 3 }],
    }));
    expect(context.materials).toHaveLength(1);
    expect(context.materials[0]!.version).toBe(3);
    expect(context.materials[0]!.content).toBe('提交时共享材料');
  });

  it('legacy_array_material_snapshot_is_still_readable', () => {
    const context = GradingContext.fromQuestion(question());
    context.applySnapshots(null, JSON.stringify([
      { id: 'm1', content: '旧版数组材料', images: [], source_refs: [], version: 1 },
    ]));
    expect(context.materials).toHaveLength(1);
    expect(context.materials[0]!.content).toBe('旧版数组材料');
  });

  it('edited_material_does_not_leak_into_old_submission_grading', () => {
    const context = GradingContext.fromQuestion(question());
    context.materials = [material('编辑后的新材料内容', 9)];
    context.applySnapshots(null, JSON.stringify({
      materials: [{ id: 'm1', content: '提交时的旧材料内容', images: [], source_refs: [], version: 2 }],
    }));
    expect(context.materials[0]!.version).toBe(2);
    expect(context.materials[0]!.content).toBe('提交时的旧材料内容');
  });

  it('explicit_null_snapshot_clears_live_answer_and_options', () => {
    const live = question();
    const options: QuestionOption[] = [{ key: 'A', content: 'live 选项' }];
    live.options = options;
    const context = GradingContext.fromQuestion(live);
    context.applySnapshots(JSON.stringify({
      content: '提交时题干', question_type: 'single_choice', options: null, answer: null,
      explanation: null, structured_data: null, images: [],
    }), null);
    expect(context.options).toBeNull();
    expect(context.answer).toBeNull();
    expect(context.explanation).toBeNull();
    expect(context.structured_data).toBeNull();
    expect(context.question_type).toBe('SingleChoice');
  });

  it('question_snapshot_keeps_grading_fields', () => {
    const value = questionSnapshotJson(question());
    expect(value.id).toBe('q1');
    expect(value.content).toBe('原始题干');
    expect(value.question_type).toBe('short_answer');
    expect(value.answer).toBe('原始答案');
  });
});

describe('qbank_grading/image_answer.rs', () => {
  it('parses_valid_envelope_with_text', () => {
    const raw = envelopeJson([imageValue('a', 'image/png'), imageValue('b', 'image/jpeg')], '第三步没写完');
    const payload = parseImageAnswerEnvelope(raw);
    expect(payload).not.toBeNull();
    expect(payload!.images).toHaveLength(2);
    expect(payload!.images[0]!.id).toBe('a');
    expect(payload!.text).toBe('第三步没写完');
  });

  it('parses_envelope_without_text', () => {
    const raw = '{"type":"image_answer","images":[{"id":"a","name":"a.jpg","mime":"image/jpeg","hash":"h"}]}';
    const payload = parseImageAnswerEnvelope(raw);
    expect(payload).not.toBeNull();
    expect(payload!.text).toBe('');
  });

  it('rejects_non_envelope_shapes', () => {
    expect(parseImageAnswerEnvelope('手写答案')).toBeNull();
    expect(parseImageAnswerEnvelope('["a","b"]')).toBeNull();
    expect(parseImageAnswerEnvelope('{"type":"text","images":[]}')).toBeNull();
    expect(parseImageAnswerEnvelope('{"pairs":[{"left":"L1","right":"R1"}]}')).toBeNull();
    expect(parseImageAnswerEnvelope('["ans1","ans2"]')).toBeNull();
  });

  it('rejects_empty_over_cap_or_invalid_entries', () => {
    expect(parseImageAnswerEnvelope(envelopeJson([], ''))).toBeNull();
    const tooMany = Array.from({ length: IMAGE_ANSWER_MAX_IMAGES + 1 },
      (_, index) => imageValue(`i${index}`, 'image/png'));
    expect(parseImageAnswerEnvelope(envelopeJson(tooMany, ''))).toBeNull();
    expect(parseImageAnswerEnvelope(envelopeJson([imageValue('a', 'application/pdf')], ''))).toBeNull();
    expect(parseImageAnswerEnvelope(envelopeJson([{ id: 'a', mime: 'image/png' }], ''))).toBeNull();
    expect(parseImageAnswerEnvelope(envelopeJson([imageValue('  ', 'image/png')], ''))).toBeNull();
    expect(parseImageAnswerEnvelope(envelopeJson([imageValue('a', 'image/png')], 42))).toBeNull();
  });

  it('validates_image_sizes_with_essay_aligned_limits', () => {
    let oversized = 'A'.repeat(IMAGE_ANSWER_MAX_DECODED_BYTES / 3 * 4 + 1024);
    let error: unknown = null;
    try { validateImageSizes([oversized]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ImageAnswerValidation);
    expect((error as Error).message).toContain('单张最大');

    oversized = '';
    const third = 'A'.repeat(IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES / 9 * 4 + 16);
    error = null;
    try { validateImageSizes([third, third, third]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ImageAnswerValidation);
    expect((error as Error).message).toContain('总体积超限');

    const ok = 'A'.repeat(1024 * 1024 / 3);
    expect(() => validateImageSizes([ok])).not.toThrow();
  });

  it('material_snapshot_json_keeps_material_shape', () => {
    expect(materialSnapshotJson([material('shared', 4)])).toEqual([
      { id: 'm1', content: 'shared', images: [], source_refs: [], version: 4 },
    ]);
  });
});
