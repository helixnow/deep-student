import { describe, expect, it } from 'vitest';
import {
  compressIntervalForExamHorizon,
  computeDailyNewCardQuota,
  computeDaysUntilExam,
  computeEffectiveTargetRetention,
  computeExamBufferDays,
  interleaveSprintQueue,
  logicalLocalDateKey,
  parseExamDateYmd,
  projectFsrsRetrievability,
  resolveExamPhase,
  runExamHorizonTriage,
  sanitizeBaseTargetRetention,
  type ExamHorizonConfig,
  type FsrsTriageCandidate,
  type MindmapTriageCandidate,
  type MistakeTriageCandidate,
  type TriageCandidateInput,
} from '../src/examHorizonScheduler.ts';

function makeConfig(overrides: Partial<ExamHorizonConfig> = {}): ExamHorizonConfig {
  return {
    spaceId: 'space_math',
    rootFolderId: 'fld_math',
    examDate: '2026-12-01',
    sprintBudgetMinutes: 15,
    baseTargetRetention: 0.88,
    defaultDeckId: null,
    dayRolloverHour: 4,
    ...overrides,
  };
}

function makeFsrsCandidate(
  index: number,
  overrides: Partial<FsrsTriageCandidate> = {},
): FsrsTriageCandidate {
  return {
    kind: 'fsrs_card',
    cardStateId: `state_${index}`,
    ankiCardId: `card_${index}`,
    deckName: 'Calculus',
    cardFormat: 'qa',
    front: `Question ${index}`,
    back: `Answer ${index}`,
    fields: { Front: `Question ${index}`, Back: `Answer ${index}` },
    templateId: 'basic',
    state: 2,
    lapses: 0,
    reps: 4,
    stability: 6,
    difficulty: 5,
    isDue: true,
    daysSinceLastReview: 7,
    daysOverdue: 2,
    conceptTags: ['calculus.limit'],
    sourceAnchor: null,
    ...overrides,
  };
}

function makeMistakeCandidate(
  index: number,
  overrides: Partial<MistakeTriageCandidate> = {},
): MistakeTriageCandidate {
  return {
    kind: 'mistake_question',
    planId: `plan_${index}`,
    examId: 'exam_1',
    examName: 'Calculus Midterm',
    questionId: `q_${index}`,
    originalQuestionId: `q_${index}`,
    isVariant: false,
    variantBadgeReason: null,
    questionType: 'single_choice',
    content: `Derivative problem ${index}`,
    options: [
      { key: 'A', content: '1' },
      { key: 'B', content: '2' },
      { key: 'C', content: '3' },
      { key: 'D', content: '4' },
    ],
    answer: 'B',
    explanation: 'Apply chain rule.',
    structuredData: null,
    originalPromptPreview: null,
    originalAnswerPreview: null,
    status: 'reviewing',
    lapsesCount: 2,
    consecutiveFailures: 2,
    isDifficult: true,
    repetitions: 1,
    intervalDays: 2,
    easeFactor: 2.2,
    isDue: true,
    daysSinceLastReview: 4,
    daysOverdue: 2,
    conceptTags: ['calculus.chain_rule'],
    sourceAnchor: null,
    ...overrides,
  };
}

function makeMindmapCandidate(
  index: number,
  overrides: Partial<MindmapTriageCandidate> = {},
): MindmapTriageCandidate {
  const mmId = overrides.mindmapId ?? 'mm_1';
  const nodeId = overrides.nodeId ?? `node_${index}`;
  return {
    kind: 'mindmap_cloze',
    mindmapId: mmId,
    mindmapTitle: 'Mean Value Theorems',
    nodeId,
    ancestorPath: ['Calculus', `Chapter ${index % 5}`],
    siblingHints: ['Rolle Theorem', 'Cauchy Theorem'],
    fullText: `Lagrange theorem conclusion ${index}`,
    maskedText: 'Lagrange theorem ［ ？ ］',
    blankedRanges: [{ start: 17, end: 29 }],
    noteExcerpt: null,
    attempts: 3,
    misses: 2,
    daysSinceLastReview: 3,
    priority: 1,
    conceptTags: ['calculus.mvt'],
    sourceAnchor: {
      anchorUri: `ds-anchor://v1/mindmap/${mmId}?node=${nodeId}`,
      kind: 'mindmap',
      resourceId: mmId,
      label: 'Mean Value Theorems',
      page: null,
      startMs: null,
      blockId: null,
      nodeId,
      questionId: null,
      quote: null,
    },
    ...overrides,
  };
}

describe('Exam-Horizon FSRS Scheduler & Smart Triage (Host)', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null])(
    'treats a missing or invalid stability (%s) as unlearned rather than perfect recall', (stability) => {
      expect(projectFsrsRetrievability({ state: 2, stability, daysSinceLastReview: 0, horizonDays: 7 }))
        .toEqual({ currentRetrievability: 0.15, examRetrievability: 0.15 });
    });

  it('clamps queue memory values and corrupted mindmap counters to finite wire values', () => {
    const result = runExamHorizonTriage({ config: makeConfig(), nowMs: new Date(2026, 10, 11, 12).getTime(),
      candidates: [makeFsrsCandidate(1, { stability: -1, difficulty: 100 }),
        makeMindmapCandidate(1, { attempts: NaN, misses: Infinity })] });
    const card = result.selectedItems.find((item) => item.kind === 'fsrs_card')!;
    expect(card.kind === 'fsrs_card' && card.stability).toBe(0);
    expect(card.kind === 'fsrs_card' && card.difficulty).toBe(10);
    expect(JSON.stringify(result)).not.toContain('"attempts":null');
    expect(sanitizeBaseTargetRetention(NaN, NaN)).toBe(0.88);
    for (const target of [-1, 0, 1, Infinity, NaN]) {
      expect(Number.isFinite(computeEffectiveTargetRetention(0, target))).toBe(true);
      expect(compressIntervalForExamHorizon({ scheduledDays: NaN, stabilityAfter: -1,
        daysUntilExam: 0, effectiveTargetRetention: target })).toBe(1);
    }
  });

  it('counts remaining unseen cards without subtracting introductions twice', () => {
    expect(computeDailyNewCardQuota({ daysUntilExam: null, unseenCount: 10,
      newIntroducedToday: 15, deckNewPerDay: 20 }).remainingNewCardQuota).toBe(5);
    expect(computeDailyNewCardQuota({ daysUntilExam: 15, unseenCount: 90,
      newIntroducedToday: 10, deckNewPerDay: 20 }).remainingNewCardQuota).toBe(0);
  });

  it('uses local calendar dates in UTC+8 and UTC-8, including pre-rollover study and invalid dates', () => {
    const now = Date.UTC(2026, 11, 19, 17, 30);
    expect(computeDaysUntilExam(now, '2026-12-20', 0, 480)).toBe(0);
    expect(computeDaysUntilExam(now, '2026-12-20', 4, 480)).toBe(1);
    expect(computeDaysUntilExam(now, '2026-12-20', 4, -480)).toBe(1);
    for (const date of ['2026-02-30', '2026-12-20T00:00:00Z', 'invalid', null]) {
      expect(computeDaysUntilExam(now, date)).toBeNull();
    }
  });

  it('fills a ten-second tail with an eight-second historical item', () => {
    const result = runExamHorizonTriage({ config: makeConfig({ sprintBudgetMinutes: 5 }),
      nowMs: new Date(2026, 10, 11, 12).getTime(), candidates: [
        ...[120, 120, 50].map((seconds, index) => makeFsrsCandidate(index, {
          historicalMeanSeconds: seconds, historicalReviewCount: 3, stability: 0.01, daysSinceLastReview: 1000,
          conceptMasteryScore: 0, lapses: 3,
        })),
        makeFsrsCandidate(4, { historicalMeanSeconds: 20, historicalReviewCount: 3,
          stability: 6, daysSinceLastReview: 6 }),
        makeFsrsCandidate(5, { historicalMeanSeconds: 8, historicalReviewCount: 3,
          stability: 100000, daysSinceLastReview: 0 }),
      ] });
    expect(result.selectedItems.some((item) => item.sprintItemId === 'fsrs:state_5')).toBe(true);
    expect(result.snapshot.estimatedSprintSeconds).toBeLessThanOrEqual(300);
  });

  it('transitions phases accurately across D=45, D=30, D=8, D=7, D=0, D=-1, unscheduled, and rollover hour 02:30', () => {
    const noonNov11 = new Date(2026, 10, 11, 12, 0, 0).getTime();

    const d45 = computeDaysUntilExam(noonNov11, '2026-12-26', 4);
    expect(d45).toBe(45);
    expect(resolveExamPhase(d45)).toBe('foundation');

    const d30 = computeDaysUntilExam(noonNov11, '2026-12-11', 4);
    expect(d30).toBe(30);
    expect(resolveExamPhase(d30)).toBe('reinforce');

    const d8 = computeDaysUntilExam(noonNov11, '2026-11-19', 4);
    expect(d8).toBe(8);
    expect(resolveExamPhase(d8)).toBe('reinforce');

    const d7 = computeDaysUntilExam(noonNov11, '2026-11-18', 4);
    expect(d7).toBe(7);
    expect(resolveExamPhase(d7)).toBe('sprint');

    const d0 = computeDaysUntilExam(noonNov11, '2026-11-11', 4);
    expect(d0).toBe(0);
    expect(resolveExamPhase(d0)).toBe('sprint');

    const dNeg1 = computeDaysUntilExam(noonNov11, '2026-11-10', 4);
    expect(dNeg1).toBe(-1);
    expect(resolveExamPhase(dNeg1)).toBe('maintenance');

    expect(computeDaysUntilExam(noonNov11, null, 4)).toBeNull();
    expect(resolveExamPhase(null)).toBe('unscheduled');
    expect(parseExamDateYmd('2026-02-30')).toBeNull();
    expect(computeDaysUntilExam(noonNov11, '2026-02-30', 4)).toBeNull();

    // At 02:30 local time before dayRolloverHour=4, logical day is still Nov 10!
    const earlyMorningNov11 = new Date(2026, 10, 11, 2, 30, 0).getTime();
    expect(logicalLocalDateKey(earlyMorningNov11, 4)).toBe('2026-11-10');
    expect(computeDaysUntilExam(earlyMorningNov11, '2026-11-11', 4)).toBe(1);

    // At 04:30 local time after dayRolloverHour=4, logical day advances to Nov 11 (D=0 D-Day).
    const postRolloverNov11 = new Date(2026, 10, 11, 4, 30, 0).getTime();
    expect(logicalLocalDateKey(postRolloverNov11, 4)).toBe('2026-11-11');
    expect(computeDaysUntilExam(postRolloverNov11, '2026-11-11', 4)).toBe(0);
  });

  it('maintains monotonic desired retention R_target(D) across foundation -> reinforce -> sprint and resets post-exam', () => {
    const r45 = computeEffectiveTargetRetention(45, 0.88);
    const r30 = computeEffectiveTargetRetention(30, 0.88);
    const r19 = computeEffectiveTargetRetention(19, 0.88);
    const r8 = computeEffectiveTargetRetention(8, 0.88);
    const r7 = computeEffectiveTargetRetention(7, 0.88);
    const r4 = computeEffectiveTargetRetention(4, 0.88);
    const r1 = computeEffectiveTargetRetention(1, 0.88);
    const r0 = computeEffectiveTargetRetention(0, 0.88);
    const rPost = computeEffectiveTargetRetention(-3, 0.88);
    const rUnscheduled = computeEffectiveTargetRetention(null, 0.90);

    expect(r45).toBe(0.88);
    expect(r30).toBe(0.88);
    expect(r19).toBeGreaterThan(r30);
    expect(r8).toBe(0.92);
    expect(r7).toBe(0.925);
    expect(r4).toBeGreaterThan(r7);
    expect(r1).toBe(0.94);
    expect(r0).toBe(0.94);
    expect(rPost).toBe(0.88);
    expect(rUnscheduled).toBe(0.90);
  });

  it('computes new-card burn-down quota and freezes standard unseen intake inside pre-exam buffer while allowing <=3 high-importance emergency slots', () => {
    expect(computeExamBufferDays(15)).toBe(5);
    expect(computeExamBufferDays(7)).toBe(3);
    expect(computeExamBufferDays(2)).toBe(2);
    expect(computeExamBufferDays(0)).toBe(0);

    const burn15 = computeDailyNewCardQuota({
      daysUntilExam: 15,
      unseenCount: 100,
      deckNewPerDay: 20,
      newIntroducedToday: 0,
    });
    expect(burn15.newIntakeFrozen).toBe(false);
    expect(burn15.dailyNewCardQuota).toBe(10);

    const frozenD2 = computeDailyNewCardQuota({
      daysUntilExam: 2,
      unseenCount: 30,
      deckNewPerDay: 20,
      newIntroducedToday: 0,
    });
    expect(frozenD2.newIntakeFrozen).toBe(true);
    expect(frozenD2.dailyNewCardQuota).toBe(0);

    // Inside buffer (D=2): standard unseen cards (Importance < 1.25) are blocked,
    // while high-importance unseen cards (Importance >= 1.25) take at most 3 emergency slots.
    const nowMs = new Date(2026, 10, 11, 12, 0, 0).getTime();
    const candidates: TriageCandidateInput[] = [
      makeFsrsCandidate(1, { state: 2, isDue: true }),
      ...Array.from({ length: 5 }, (_, idx) =>
        makeFsrsCandidate(10 + idx, {
          state: 0,
          isDue: false,
          inActiveSpaceScope: false,
          hasExamPriorityTag: false,
          conceptMasteryScore: null,
        }),
      ),
      ...Array.from({ length: 5 }, (_, idx) =>
        makeFsrsCandidate(30 + idx, {
          state: 0,
          isDue: false,
          inActiveSpaceScope: true,
          hasExamPriorityTag: true,
          conceptMasteryScore: 0.2, // deltaMastery = 0.44 + deltaExamTag = 0.20 => Importance = 1.64 >= 1.25
        }),
      ),
    ];

    const triage = runExamHorizonTriage({
      config: makeConfig({ examDate: '2026-11-13', sprintBudgetMinutes: 15 }),
      nowMs,
      candidates,
    });

    expect(triage.snapshot.newIntakeFrozen).toBe(true);
    expect(triage.snapshot.dailyNewCardQuota).toBe(0);
    const unseenSelected = triage.selectedItems.filter(
      (item) => item.kind === 'fsrs_card' && item.state === 0,
    );
    expect(unseenSelected.length).toBe(3);
    for (const item of unseenSelected) {
      expect(item.triage.importance).toBeGreaterThanOrEqual(1.25);
    }
  });

  it('compresses pre-exam interval without mutating stability when projected exam R falls below target - 0.03', () => {
    // D = 10 (reinforce), stabilityAfter = 4 => R(10, 4) < 0.88, scheduledDays = 14 > 10 => floor(10 * 0.75) = 7
    const compressed = compressIntervalForExamHorizon({
      scheduledDays: 14,
      stabilityAfter: 4,
      daysUntilExam: 10,
      baseTargetRetention: 0.88,
    });
    expect(compressed).toBe(7);

    // High stability (S = 120) already exceeds R_target(10) - 0.03 at D = 10 => unchanged
    const untouchedHighStability = compressIntervalForExamHorizon({
      scheduledDays: 90,
      stabilityAfter: 120,
      daysUntilExam: 10,
      baseTargetRetention: 0.88,
    });
    expect(untouchedHighStability).toBe(90);

    // Foundation (D = 45) => unchanged
    expect(
      compressIntervalForExamHorizon({
        scheduledDays: 60,
        stabilityAfter: 8,
        daysUntilExam: 45,
      }),
    ).toBe(60);
  });

  it('bounds a 500-item overdue post-hiatus storm within 15-minute budget with cross-modal floors and 3:1:1 interleaving', () => {
    const nowMs = new Date(2026, 10, 11, 12, 0, 0).getTime();
    const stormCandidates: TriageCandidateInput[] = [];

    for (let i = 0; i < 360; i += 1) {
      stormCandidates.push(
        makeFsrsCandidate(i, {
          stability: i < 40 ? 1.2 : 12,
          daysSinceLastReview: i < 40 ? 18 : 180,
          daysOverdue: i < 40 ? 4 : 165,
          cardFormat: 'qa',
        }),
      );
    }
    for (let i = 0; i < 90; i += 1) {
      stormCandidates.push(
        makeMistakeCandidate(i, {
          daysSinceLastReview: i < 15 ? 4 : 120,
          daysOverdue: i < 15 ? 2 : 110,
        }),
      );
    }
    for (let i = 0; i < 50; i += 1) {
      stormCandidates.push(
        makeMindmapCandidate(i, {
          attempts: 4,
          misses: 3,
          daysSinceLastReview: i < 15 ? 3 : 90,
        }),
      );
    }

    const result = runExamHorizonTriage({
      config: makeConfig({ examDate: '2026-11-25', sprintBudgetMinutes: 15 }),
      nowMs,
      candidates: stormCandidates,
    });

    const totalSeconds = result.selectedItems.reduce(
      (sum, item) => sum + item.triage.estimatedSeconds,
      0,
    );
    expect(totalSeconds).toBeLessThanOrEqual(900);
    expect(result.snapshot.estimatedSprintSeconds).toBe(totalSeconds);
    expect(result.deferredBacklogCount).toBeGreaterThan(400);
    expect(result.snapshot.deferredBacklogCount).toBe(result.deferredBacklogCount);

    const kinds = new Set(result.selectedItems.map((item) => item.kind));
    expect(kinds.has('fsrs_card')).toBe(true);
    expect(kinds.has('mistake_question')).toBe(true);
    expect(kinds.has('mindmap_cloze')).toBe(true);

    // Verify 3:1:1 interleaving starts with up to 3 flashcards, 1 mistake, 1 mindmap
    expect(result.selectedItems.slice(0, 5).map((item) => item.kind)).toEqual([
      'fsrs_card',
      'fsrs_card',
      'fsrs_card',
      'mistake_question',
      'mindmap_cloze',
    ]);

    // Verify sweet-spot bankruptcy guard prioritized freshly slipping items over 165-day ancient items
    const firstFsrs = result.selectedItems.find((item) => item.kind === 'fsrs_card');
    expect(firstFsrs).toBeDefined();
    const firstStateIdx = Number(firstFsrs!.sprintItemId.replace('fsrs:state_', ''));
    expect(firstStateIdx).toBeLessThan(40);
  });

  it('avoids adjacent duplicate originalQuestionId when interleaving', () => {
    const nowMs = new Date(2026, 10, 11, 12, 0, 0).getTime();
    const triage = runExamHorizonTriage({
      config: makeConfig({ sprintBudgetMinutes: 15 }),
      nowMs,
      candidates: [
        makeMistakeCandidate(1, { planId: 'p1', questionId: 'v1', originalQuestionId: 'root_A' }),
        makeMistakeCandidate(2, { planId: 'p2', questionId: 'v2', originalQuestionId: 'root_A' }),
        makeMistakeCandidate(3, { planId: 'p3', questionId: 'qB', originalQuestionId: 'root_B' }),
      ],
    });
    const interleaved = interleaveSprintQueue(triage.selectedItems);
    for (let i = 1; i < interleaved.length; i += 1) {
      const prev = interleaved[i - 1]!;
      const curr = interleaved[i]!;
      if (prev.kind === 'mistake_question' && curr.kind === 'mistake_question') {
        expect(curr.originalQuestionId).not.toBe(prev.originalQuestionId);
      }
    }
  });

  it('handles mid-prep exam date shift, D-Day H=0 forecast, empty cold-start pool, and corrupt numeric inputs without NaN', () => {
    const nowMs = new Date(2026, 10, 11, 12, 0, 0).getTime();

    // Empty pool -> null retrievability, never NaN or fake 1.0
    const empty = runExamHorizonTriage({
      config: makeConfig({ examDate: '2026-11-20' }),
      nowMs,
      candidates: [],
    });
    expect(empty.snapshot.totalActiveItems).toBe(0);
    expect(empty.snapshot.predictedExamRetrievability).toBeNull();
    expect(empty.snapshot.currentRetrievability).toBeNull();
    expect(empty.snapshot.estimatedSprintMinutes).toBe(0);

    // Mid-prep shift from D-40 to D-5 on identical candidate pool
    const pool: TriageCandidateInput[] = [
      makeFsrsCandidate(1, { stability: 0, daysSinceLastReview: Number.NaN }),
      makeFsrsCandidate(2, { state: 0, isDue: false }),
    ];
    const atD40 = runExamHorizonTriage({
      config: makeConfig({ examDate: '2026-12-21', sprintBudgetMinutes: -5, dayRolloverHour: 99 }),
      nowMs,
      candidates: pool,
    });
    const atD2 = runExamHorizonTriage({
      config: makeConfig({ examDate: '2026-11-13' }),
      nowMs,
      candidates: pool,
    });
    expect(atD40.snapshot.phase).toBe('foundation');
    expect(atD40.snapshot.newIntakeFrozen).toBe(false);
    expect(atD2.snapshot.phase).toBe('sprint');
    expect(atD2.snapshot.newIntakeFrozen).toBe(true);
    expect(Number.isFinite(atD40.snapshot.predictedExamRetrievability)).toBe(true);
    expect(Number.isFinite(atD2.snapshot.predictedExamRetrievability)).toBe(true);

    // D-Day (D=0): horizon H=0 => examRetrievability equals currentRetrievability
    const dDayProj = projectFsrsRetrievability({
      state: 2,
      stability: 10,
      daysSinceLastReview: 0,
      horizonDays: 0,
    });
    expect(dDayProj.examRetrievability).toBe(dDayProj.currentRetrievability);
    expect(dDayProj.examRetrievability).toBeCloseTo(1, 5);
  });
});
