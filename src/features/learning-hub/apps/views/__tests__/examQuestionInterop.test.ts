import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@/api/questionBankApi';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  DS_EXCERPT_MIME,
  parseSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { clearActiveExcerptDrag } from '@/ui-kernel/services/excerpt-dnd';
import {
  QUESTION_STEM_SUMMARY_MAX_CODE_POINTS,
  buildQuestionExcerptPayload,
  buildQuestionSemanticAnchor,
  createQuestionRevealSequencer,
  deriveQuestionExcerptMeta,
  extractQuestionIdFromAnchor,
  startQuestionExcerptDrag,
  summarizeQuestionStem,
} from '../examQuestionInterop';

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

function createMockDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  const dt = {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return Array.from(store.keys());
    },
    setData(type: string, data: string) {
      store.set(type, data);
    },
    getData(type: string) {
      return store.get(type) ?? '';
    },
    clearData(type?: string) {
      if (type) store.delete(type);
      else store.clear();
    },
    setDragImage: vi.fn(),
  };
  return dt as unknown as DataTransfer;
}

function makePastQuestion(overrides: Partial<Question> & { id: string }): Question {
  return {
    examId: 'exam-math-2025',
    cardId: `card-${overrides.id}`,
    questionLabel: 'Q12',
    content: '已知实对称矩阵 A 满足 A^2 = A，证明 A 的特征值只能为 0 或 1。',
    ocrText: '',
    questionType: 'proof',
    answer: '设 Av = lambda v (v != 0)，两边左乘 A 得 lambda^2 v = lambda v。',
    explanation: '利用幂等矩阵最小多项式整除 x(x-1)。',
    difficulty: 'hard',
    tags: ['特征值', '幂等矩阵'],
    status: 'review',
    attemptCount: 4,
    correctCount: 1,
    isCorrect: false,
    isFavorite: true,
    ...overrides,
  };
}

afterEach(() => {
  clearActiveExcerptDrag();
});

describe('examQuestionInterop — semantic anchors & excerpt packaging (C7 §2.4)', () => {
  it('keeps full multiline stem, options, and LaTeX intact in DS_EXCERPT_MIME instead of the 260-character summary', () => {
    const question = makePastQuestion({ id: 'q-latex', content: `${'背景条件'.repeat(80)}\n$$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$$`,
      options: [{ key: 'A', content: '$\\frac{1}{2}$' }, { key: 'B', content: '$\\sqrt{2}$' }] });
    const dt = createMockDataTransfer();
    startQuestionExcerptDrag({ dataTransfer: dt }, { resourceId: 'exam-math-2025', question });
    const payload = JSON.parse(dt.getData(DS_EXCERPT_MIME));
    expect(payload.text).toContain(question.content);
    expect(payload.text).toContain('A. $\\frac{1}{2}$\nB. $\\sqrt{2}$');
    expect(payload.anchor.questionId).toBe(question.id);
  });
  it('roundtrips canonical qbank semantic anchors and extracts questionId from qbank/custom anchors', () => {
    const anchor = buildQuestionSemanticAnchor({
      resourceId: 'exam-math-2025',
      aliasResourceId: '/真题/线代2025.exam',
      questionId: 'q-eigen-12',
      examTitle: '2025 线性代数真题',
      questionLabel: 'Q12',
    });

    expect(anchor).toEqual({
      kind: 'qbank',
      resourceId: 'exam-math-2025',
      aliasResourceId: '/真题/线代2025.exam',
      questionId: 'q-eigen-12',
      label: '2025 线性代数真题 · Q12',
    });

    const payload = buildQuestionExcerptPayload({
      resourceId: 'exam-math-2025',
      aliasResourceId: '/真题/线代2025.exam',
      examTitle: '2025 线性代数真题',
      question: makePastQuestion({ id: 'q-eigen-12' }),
    });

    expect(payload.anchorUri).toContain('ds-anchor://v1/qbank/exam-math-2025');
    const parsed = parseSemanticAnchor(payload.anchorUri);
    expect(parsed).toMatchObject({
      kind: 'qbank',
      resourceId: 'exam-math-2025',
      aliasResourceId: '/真题/线代2025.exam',
      questionId: 'q-eigen-12',
    });

    expect(extractQuestionIdFromAnchor(anchor)).toBe('q-eigen-12');
    expect(
      extractQuestionIdFromAnchor({
        kind: 'custom',
        namespace: 'exam',
        resourceId: 'exam-math-2025',
        locator: 'q-custom-7',
      }),
    ).toBe('q-custom-7');
    expect(
      extractQuestionIdFromAnchor({
        kind: 'custom',
        namespace: 'other_plugin',
        resourceId: 'exam-math-2025',
        locator: 'q-custom-7',
      }),
    ).toBeNull();
  });

  it('derives accuracy rate, mistake count, error causes, and stem summary without emojis', () => {
    const staleTimestamp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const mistake = makePastQuestion({
      id: 'q-mistake-1',
      attemptCount: 4,
      correctCount: 1,
      status: 'review',
      lastAttemptAt: staleTimestamp,
    });

    const meta = deriveQuestionExcerptMeta({
      resourceId: 'exam-math-2025',
      question: mistake,
      questionIndex: 0,
    });

    expect(meta.accuracyPercent).toBe(25);
    expect(meta.accuracyText).toBe('25%');
    expect(meta.mistakeCount).toBe(3);
    expect(meta.mistakeCountText).toBe('3');
    expect(meta.isMistake).toBe(true);
    expect(meta.errorCauses).toEqual(['repeatedErrors', 'stale']);

    const neverCorrectMeta = deriveQuestionExcerptMeta({
      resourceId: 'exam-math-2025',
      question: makePastQuestion({ id: 'q-never', attemptCount: 2, correctCount: 0 }),
    });
    expect(neverCorrectMeta.errorCauses).toContain('neverCorrect');

    const payload = buildQuestionExcerptPayload({
      resourceId: 'exam-math-2025',
      examTitle: '线性代数期末卷',
      question: mistake,
    });

    expect(payload.excerptKind).toBe('text');
    expect(payload.text).toContain('Q12');
    expect(payload.text).toContain('25%');
    expect(payload.text).toContain('特征值');
    expect(payload.text).toContain('幂等矩阵');
    expect(EMOJI_RE.test(payload.text)).toBe(false);

    const longStem = '甲'.repeat(QUESTION_STEM_SUMMARY_MAX_CODE_POINTS + 40);
    const truncated = summarizeQuestionStem(longStem);
    expect(Array.from(truncated).length).toBe(QUESTION_STEM_SUMMARY_MAX_CODE_POINTS);
  });

  it('starts DS_EXCERPT_MIME drag session with compact tabular drag ghost via AppKernel dnd', () => {
    const dt = createMockDataTransfer();
    const question = makePastQuestion({
      id: 'q-drag-9',
      questionLabel: 'Q9',
      attemptCount: 3,
      correctCount: 2,
    });

    const started = startQuestionExcerptDrag(
      { dataTransfer: dt },
      {
        resourceId: 'exam-math-2025',
        examTitle: '2025 真题卷',
        question,
      },
    );

    expect(started).not.toBeNull();
    expect(dt.types).toContain(DS_EXCERPT_MIME);
    expect(dt.types).toContain('text/plain');
    expect(dt.setDragImage).toHaveBeenCalledTimes(1);

    const readBack = getAppKernel().dnd.readExcerptDrag({ dataTransfer: dt });
    expect(readBack).not.toBeNull();
    expect(readBack?.anchor).toMatchObject({
      kind: 'qbank',
      resourceId: 'exam-math-2025',
      questionId: 'q-drag-9',
    });
    expect(readBack?.text).toContain('67%');
  });

  it('routes qbank & custom exam anchors via AnchorRevealHandler in <50ms with monotonic sequencer', async () => {
    const kernel = getAppKernel();
    const sequencer = createQuestionRevealSequencer();
    const revealed: Array<{ questionId: string | null; pulse: boolean; token: number }> = [];

    const disposeQbank = kernel.anchors.registerAnchorRevealHandler('qbank', {
      canHandle: (anchor) =>
        anchor.resourceId === 'exam-fast-1' ? 'exact-focused' : false,
      reveal: (anchor, ctx) => {
        const token = sequencer.next();
        const qid = extractQuestionIdFromAnchor(anchor);
        revealed.push({ questionId: qid, pulse: ctx.pulse, token });
        return true;
      },
    });

    const disposeCustom = kernel.anchors.registerAnchorRevealHandler('custom', {
      canHandle: (anchor) =>
        anchor.namespace === 'exam' && anchor.resourceId === 'exam-fast-1'
          ? 'exact-mounted'
          : false,
      reveal: (anchor, ctx) => {
        const token = sequencer.next();
        const qid = extractQuestionIdFromAnchor(anchor);
        revealed.push({ questionId: qid, pulse: ctx.pulse, token });
        return true;
      },
    });

    try {
      const firstResult = await kernel.anchors.reveal(
        buildQuestionSemanticAnchor({
          resourceId: 'exam-fast-1',
          questionId: 'q-first',
        }),
      );
      expect(firstResult.ok).toBe(true);
      expect(firstResult.outcome).toBe('revealed-in-open-pane');
      expect(firstResult.elapsedMs).toBeLessThan(50);

      const secondResult = await kernel.anchors.reveal({
        kind: 'custom',
        namespace: 'exam',
        resourceId: 'exam-fast-1',
        locator: 'q-second',
      });
      expect(secondResult.ok).toBe(true);
      expect(secondResult.outcome).toBe('revealed-in-open-pane');
      expect(secondResult.elapsedMs).toBeLessThan(50);

      expect(revealed).toHaveLength(2);
      expect(sequencer.isCurrent(revealed[0]!.token)).toBe(false);
      expect(sequencer.isCurrent(revealed[1]!.token)).toBe(true);
      expect(revealed[1]?.questionId).toBe('q-second');
    } finally {
      disposeQbank();
      disposeCustom();
    }
  });
});
