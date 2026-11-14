import { describe, expect, it, vi } from 'vitest';
import type { LlmRawPrompt, StandardModel2Output } from '../../llm/api.ts';
import type { CreateQuestionParams, Question, QuestionFilters } from '../../vfs-repos/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  MistakeVariantGenerator,
  buildVariantCacheKey,
  parseAndValidateVariantJson,
  resolveVariantEligibility,
  shouldUseMistakeVariant,
} from '../src/mistakeVariantGenerator.ts';
import type { ReviewPlan } from '../src/review-plan-types.ts';

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q_root_1',
    exam_id: 'exam_calc',
    card_id: null,
    question_label: 'Q1',
    content: 'Let f(x) = x^2 + 2x. Find f\'(3).',
    options: [
      { key: 'A', content: '6' },
      { key: 'B', content: '7' },
      { key: 'C', content: '8' },
      { key: 'D', content: '9' },
    ],
    answer: 'C',
    explanation: 'f\'(x) = 2x + 2, so f\'(3) = 8.',
    structured_data: null,
    question_type: 'single_choice',
    difficulty: 'medium',
    tags: ['calculus.derivative'],
    status: 'review',
    user_answer: 'A',
    is_correct: false,
    attempt_count: 3,
    correct_count: 1,
    last_attempt_at: '2026-11-01T10:00:00Z',
    user_note: null,
    is_favorite: false,
    is_bookmarked: false,
    source_type: 'imported',
    source_ref: null,
    images: [],
    parent_id: null,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    ai_feedback: null,
    ai_score: null,
    ai_graded_at: null,
    group_id: null,
    group_position: null,
    group_label: null,
    materials: [],
    answer_origin: null,
    source_refs: [],
    answer_source_refs: [],
    source_key: null,
    ...overrides,
  };
}

function makePlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    id: 'rp_1',
    question_id: 'q_root_1',
    exam_id: 'exam_calc',
    ease_factor: 2.1,
    interval_days: 1,
    repetitions: 0,
    next_review_date: '2026-11-11',
    last_review_date: '2026-11-10',
    status: 'learning',
    total_reviews: 3,
    total_correct: 1,
    consecutive_failures: 2,
    is_difficult: true,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-11-10T10:00:00Z',
    ...overrides,
  };
}

function createInMemoryHarness(llmImpl: LlmRawPrompt['callModel2RawPromptOpts']) {
  const storedQuestions: Question[] = [];
  let seq = 1;
  const dummyDb = {} as SqlExecutor;

  const createQuestion = vi.fn((params: CreateQuestionParams): Question => {
    const created = makeQuestion({
      id: `q_var_${seq++}`,
      exam_id: params.exam_id,
      content: params.content,
      options: params.options ?? null,
      answer: params.answer ?? null,
      explanation: params.explanation ?? null,
      question_type: params.question_type ?? 'single_choice',
      difficulty: params.difficulty ?? null,
      tags: params.tags ? [...params.tags] : [],
      source_type: params.source_type ?? 'ai_generated',
      source_ref: params.source_ref ?? null,
      parent_id: params.parent_id ?? null,
      attempt_count: 0,
      correct_count: 0,
      last_attempt_at: null,
      created_at: `2026-11-11T12:00:0${seq}Z`,
    });
    storedQuestions.push(created);
    return created;
  });

  const listQuestions = vi.fn(
    (_conn: SqlExecutor, examId: string, _filters: QuestionFilters, _page: number, _size: number) => {
      const matching = storedQuestions.filter((q) => q.exam_id === examId);
      return {
        questions: matching,
        total: matching.length,
        page: 1,
        page_size: 100,
        has_more: false,
      };
    },
  );

  const callSpy = vi.fn(llmImpl);
  const rawPrompt = {
    callModel2RawPromptOpts: callSpy,
  } as unknown as LlmRawPrompt;

  return {
    storedQuestions,
    createQuestion,
    listQuestions,
    callSpy,
    makeGenerator(timeoutMs = 8000) {
      return new MistakeVariantGenerator({
        getVfsDb: () => dummyDb,
        getVfsRepos: () => ({
          questions: {
            listQuestions,
          } as never,
        }),
        getRawPrompt: () => rawPrompt,
        getQbank: () => ({
          createQuestion: createQuestion as never,
          getQuestion: (id: string) =>
            (storedQuestions.find((q) => q.id === id) ?? null) as never,
        }),
        timeoutMs,
      });
    },
  };
}

describe('MistakeVariantGenerator', () => {
  it('rotates using fresh attempt timestamps instead of stale LRU copies', () => {
    const harness = createInMemoryHarness(async () => { throw new Error('offline'); });
    const original = makeQuestion();
    const sourceRef = `isomorphic_variant:${buildVariantCacheKey(original)}`;
    harness.storedQuestions.push(
      makeQuestion({ id: 'variant_a', parent_id: original.id, source_type: 'ai_generated', source_ref: sourceRef,
        last_attempt_at: '2026-01-01', attempt_count: 1 }),
      makeQuestion({ id: 'variant_b', parent_id: original.id, source_type: 'ai_generated', source_ref: sourceRef,
        last_attempt_at: '2026-02-01', attempt_count: 1 }),
    );
    const generator = harness.makeGenerator();
    expect(generator.getCachedVariant(original)?.id).toBe('variant_a');
    harness.storedQuestions[0] = { ...harness.storedQuestions[0]!, last_attempt_at: '2026-03-01', attempt_count: 2 };
    expect(generator.getCachedVariant(original)?.id).toBe('variant_b');
  });

  it('bounds an uncooperative LLM that ignores AbortSignal and never persists late results', async () => {
    const harness = createInMemoryHarness(() => new Promise<StandardModel2Output>(() => undefined));
    const result = await harness.makeGenerator(100).resolveOrGenerateVariant({ originalQuestion: makeQuestion() });
    expect(result.fallbackReason).toBe('timeout');
    expect(harness.createQuestion).not.toHaveBeenCalled();
  });

  it('rejects unrelated AI children and variants made for an earlier original revision', async () => {
    const harness = createInMemoryHarness(async () => { throw new Error('offline'); });
    harness.storedQuestions.push(makeQuestion({ id: 'unrelated', parent_id: 'q_root_1', source_type: 'ai_generated', source_ref: 'other-generator' }),
      makeQuestion({ id: 'stale', parent_id: 'q_root_1', source_type: 'ai_generated', source_ref: 'isomorphic_variant:q_root_1:old' }));
    const result = await harness.makeGenerator().resolveOrGenerateVariant({ originalQuestion: makeQuestion(), allowLiveGeneration: false });
    expect(result.isVariant).toBe(false);
  });

  it('searches persisted variants beyond the first 500 questions', async () => {
    const harness = createInMemoryHarness(async () => { throw new Error('offline'); });
    const original = makeQuestion();
    const variant = makeQuestion({ id: 'late_variant', parent_id: original.id, source_type: 'ai_generated',
      source_ref: `isomorphic_variant:${buildVariantCacheKey(original)}` });
    harness.storedQuestions.push(variant);
    harness.listQuestions.mockImplementation((_db, _examId, _filter, page) => ({
      questions: page < 6 ? [original] : [variant], total: 501, page, page_size: 100, has_more: page < 6,
    }));
    expect(harness.makeGenerator().getCachedVariant(original)?.id).toBe('late_variant');
  });

  it('accepts prose-wrapped fenced JSON but rejects missing answers and multiple true/false keys', () => {
    const payload = { content: 'Compute the slope at x = 4 instead.', options: makeQuestion().options, answer: 'B' };
    expect(parseAndValidateVariantJson(`Here is the variant:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nDone.`, makeQuestion()).ok).toBe(true);
    expect(parseAndValidateVariantJson(JSON.stringify({ ...payload, answer: undefined, correctAnswer: 'Z' }), makeQuestion()))
      .toEqual({ ok: false, reason: 'empty_answer' });
    expect(parseAndValidateVariantJson(JSON.stringify({ ...payload, answer: 'AB' }), makeQuestion({ question_type: 'true_false' })).ok).toBe(false);
  });

  it('triggers variant eligibility only for high-lapses or low-accuracy text mistakes and skips image-dependent questions', () => {
    const textMistake = makeQuestion({ attempt_count: 1, correct_count: 0, images: [] });
    expect(shouldUseMistakeVariant(makePlan({ consecutive_failures: 2, is_difficult: false }), textMistake)).toBe(true);
    expect(resolveVariantEligibility(makePlan({ consecutive_failures: 2 }), textMistake).badgeReason).toBe('high_lapses');

    // Low accuracy (< 0.60 over >= 2 attempts) even when consecutive_failures === 0
    const repeatedWrong = makeQuestion({ attempt_count: 4, correct_count: 2, images: [] });
    expect(
      resolveVariantEligibility(makePlan({ consecutive_failures: 0, is_difficult: false }), repeatedWrong),
    ).toEqual({ eligible: true, badgeReason: 'repeated_wrong' });

    // First-time mistake with high accuracy is NOT eligible
    const freshQuestion = makeQuestion({ attempt_count: 1, correct_count: 1, images: [] });
    expect(
      shouldUseMistakeVariant(makePlan({ consecutive_failures: 1, is_difficult: false }), freshQuestion),
    ).toBe(false);

    // Image-dependent geometry question MUST skip variant mode even with high lapses
    const geometryWithImage = makeQuestion({
      images: [{ id: 'img_1', name: 'triangle.png', mime: 'image/png', hash: 'abc' }],
    });
    expect(
      shouldUseMistakeVariant(makePlan({ consecutive_failures: 5, is_difficult: true }), geometryWithImage),
    ).toBe(false);
  });

  it('synthesizes isomorphic variant via LLM, persists child question with parent_id + ai_generated, and serves from Tier-1 & Tier-2 caches without re-calling LLM', async () => {
    const llmJson = JSON.stringify({
      content: 'Let g(t) = 3t^2 - 4t. Compute g\'(2).',
      options: [
        { key: 'A', content: '8' },
        { key: 'B', content: '6' },
        { key: 'C', content: '10' },
        { key: 'D', content: '12' },
      ],
      answer: 'A',
      explanation: 'g\'(t) = 6t - 4, so g\'(2) = 8.',
    });

    const harness = createInMemoryHarness(async (): Promise<StandardModel2Output> => ({
      assistant_message: `\`\`\`json\n${llmJson}\n\`\`\``,
      raw_response: llmJson,
      chain_of_thought_details: null,
      cancelled: false,
    }));

    const original = makeQuestion();
    const gen1 = harness.makeGenerator();

    const first = await gen1.resolveOrGenerateVariant({
      originalQuestion: original,
      plan: makePlan(),
    });

    expect(first.isVariant).toBe(true);
    expect(first.fromCache).toBe(false);
    expect(first.originalQuestionId).toBe(original.id);
    expect(first.variantQuestionId).not.toBe(original.id);
    expect(first.answer).toBe('A');
    expect(harness.callSpy).toHaveBeenCalledTimes(1);
    expect(harness.createQuestion).toHaveBeenCalledTimes(1);
    expect(harness.createQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        exam_id: original.exam_id,
        parent_id: original.id,
        source_type: 'ai_generated',
        source_ref: expect.stringContaining(`isomorphic_variant:${original.id}:`),
      }),
    );

    // Second lookup on same generator hits Tier-1 LRU cache (0 additional LLM calls, 0 VFS scans)
    const listCallsBefore = harness.listQuestions.mock.calls.length;
    const second = await gen1.resolveOrGenerateVariant({
      originalQuestion: original,
      plan: makePlan(),
    });
    expect(second.isVariant).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(second.variantQuestionId).toBe(first.variantQuestionId);
    expect(harness.callSpy).toHaveBeenCalledTimes(1);
    expect(harness.listQuestions.mock.calls.length).toBe(listCallsBefore);

    // Fresh generator instance hits Tier-2 VFS child question cache without calling LLM
    const gen2 = harness.makeGenerator();
    const third = await gen2.resolveOrGenerateVariant({
      originalQuestion: original,
      plan: makePlan(),
    });
    expect(third.isVariant).toBe(true);
    expect(third.fromCache).toBe(true);
    expect(third.variantQuestionId).toBe(first.variantQuestionId);
    expect(harness.callSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back deterministically to the original question on timeout, AbortSignal cancellation, malformed JSON, or invalid choice answer key', async () => {
    const original = makeQuestion();

    // 1. Timeout fallback
    const slowHarness = createInMemoryHarness(
      (_prompt, _forceJson, _caller, _task, signal) =>
        new Promise<StandardModel2Output>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const timeoutGen = slowHarness.makeGenerator(100);
    const timedOut = await timeoutGen.resolveOrGenerateVariant({
      originalQuestion: original,
      plan: makePlan(),
    });
    expect(timedOut.isVariant).toBe(false);
    expect(timedOut.variantQuestionId).toBe(original.id);
    expect(timedOut.fallbackReason).toBe('timeout');

    // 2. Caller AbortSignal cancellation
    const abortController = new AbortController();
    abortController.abort();
    const aborted = await timeoutGen.resolveOrGenerateVariant({
      originalQuestion: original,
      plan: makePlan(),
      signal: abortController.signal,
    });
    expect(aborted.isVariant).toBe(false);
    expect(aborted.fallbackReason).toBe('aborted');

    // 3. Malformed JSON fallback
    const badJsonHarness = createInMemoryHarness(async (): Promise<StandardModel2Output> => ({
      assistant_message: 'not valid json {{{',
      raw_response: null,
      chain_of_thought_details: null,
      cancelled: false,
    }));
    const badJsonRes = await badJsonHarness.makeGenerator().resolveOrGenerateVariant({
      originalQuestion: original,
      plan: makePlan(),
    });
    expect(badJsonRes.isVariant).toBe(false);
    expect(badJsonRes.variantQuestionId).toBe(original.id);
    expect(badJsonRes.fallbackReason).toBe('invalid_json');

    // 4. Invalid choice answer key ('E' when options are A..D)
    const invalidKeyCheck = parseAndValidateVariantJson(
      JSON.stringify({
        content: 'Let h(x) = x^3. Find h\'(2).',
        options: [
          { key: 'A', content: '4' },
          { key: 'B', content: '8' },
          { key: 'C', content: '12' },
          { key: 'D', content: '16' },
        ],
        answer: 'E',
        explanation: '3 * 4 = 12',
      }),
      original,
    );
    expect(invalidKeyCheck).toEqual({ ok: false, reason: 'invalid_choice_answer_key' });
  });
});
