import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compressIntervalForExamHorizon,
  computeDailyNewCardQuota,
  computeDaysUntilExam,
  computeEffectiveTargetRetention,
  computeExamBufferDays,
  logicalLocalDateKey,
  resolveExamPhase,
  runExamHorizonTriage,
  type FsrsTriageCandidate,
  type MindmapTriageCandidate,
  type MistakeTriageCandidate,
  type TriageCandidateInput,
} from '../index';
import type { ExamHorizonConfig } from '@/shared/exam-sprint';
import * as hostScheduler from '../../../../../host/plugins/review/src/examHorizonScheduler';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function makeConfig(overrides: Partial<ExamHorizonConfig> = {}): ExamHorizonConfig {
  return {
    spaceId: 'space_cs',
    rootFolderId: 'fld_cs',
    examDate: '2026-12-01',
    sprintBudgetMinutes: 15,
    baseTargetRetention: 0.88,
    defaultDeckId: null,
    dayRolloverHour: 4,
    ...overrides,
  };
}

function makeFsrs(index: number, overrides: Partial<FsrsTriageCandidate> = {}): FsrsTriageCandidate {
  return {
    kind: 'fsrs_card',
    cardStateId: `s_${index}`,
    ankiCardId: `c_${index}`,
    deckName: 'OS',
    cardFormat: 'cloze',
    front: `Virtual memory {{c1::page table}} ${index}`,
    back: 'TLB details',
    fields: { Text: `Virtual memory {{c1::page table}} ${index}` },
    templateId: 'cloze',
    state: 2,
    lapses: 1,
    reps: 3,
    stability: 5,
    difficulty: 5.5,
    isDue: true,
    daysSinceLastReview: 6,
    daysOverdue: 2,
    conceptTags: ['os.vm'],
    sourceAnchor: null,
    ...overrides,
  };
}

function makeMistake(
  index: number,
  overrides: Partial<MistakeTriageCandidate> = {},
): MistakeTriageCandidate {
  return {
    kind: 'mistake_question',
    planId: `p_${index}`,
    examId: 'exam_os',
    examName: 'Operating Systems',
    questionId: `q_${index}`,
    originalQuestionId: `q_${index}`,
    isVariant: false,
    variantBadgeReason: null,
    questionType: 'single_choice',
    content: `Page fault latency question ${index}`,
    options: [
      { key: 'A', content: 'Option A' },
      { key: 'B', content: 'Option B' },
    ],
    answer: 'A',
    explanation: 'EAT formula.',
    structuredData: null,
    originalPromptPreview: null,
    originalAnswerPreview: null,
    status: 'reviewing',
    lapsesCount: 2,
    consecutiveFailures: 2,
    isDifficult: true,
    repetitions: 1,
    intervalDays: 2,
    easeFactor: 2.3,
    isDue: true,
    daysSinceLastReview: 5,
    daysOverdue: 3,
    conceptTags: ['os.paging'],
    sourceAnchor: null,
    ...overrides,
  };
}

function makeMindmap(
  index: number,
  overrides: Partial<MindmapTriageCandidate> = {},
): MindmapTriageCandidate {
  const nodeId = `n_${index}`;
  return {
    kind: 'mindmap_cloze',
    mindmapId: 'mm_os',
    mindmapTitle: 'Memory Hierarchy',
    nodeId,
    ancestorPath: ['OS', `Section ${index % 4}`],
    siblingHints: ['L1 Cache', 'Main Memory'],
    fullText: `Page replacement algorithm ${index}`,
    maskedText: 'Page replacement ［ ？ ］',
    blankedRanges: [{ start: 17, end: 28 }],
    noteExcerpt: null,
    attempts: 3,
    misses: 2,
    daysSinceLastReview: 2,
    priority: 1,
    conceptTags: ['os.replacement'],
    sourceAnchor: {
      anchorUri: `ds-anchor://v1/mindmap/mm_os?node=${nodeId}`,
      kind: 'mindmap',
      resourceId: 'mm_os',
      label: 'Memory Hierarchy',
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

describe('Frontend Exam-Horizon Scheduler & examSprintClient', () => {
  it('stays byte-for-byte equal to Host triage for corrupt memory values and date/budget boundaries', () => {
    for (const stability of [null, 0, -1, NaN, Infinity, 0.001, 5, 10000]) {
      for (const examDate of [null, 'invalid', '2026-11-10', '2026-11-11', '2026-11-13', '2026-12-20']) {
        const input = { config: makeConfig({ examDate, baseTargetRetention: NaN, sprintBudgetMinutes: 5 }),
          nowMs: Date.UTC(2026, 10, 11, 8), offsetMinutes: 480,
          candidates: [makeFsrs(1, { stability, difficulty: 100 }), makeMistake(1)] };
        expect(runExamHorizonTriage(input)).toEqual(hostScheduler.runExamHorizonTriage(input));
      }
    }
  });

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('computes identical phase transitions, rollover day boundaries, retention ramp, and burn-down quotas', () => {
    const preRollover = new Date(2026, 10, 11, 2, 30, 0).getTime();
    expect(logicalLocalDateKey(preRollover, 4)).toBe('2026-11-10');
    expect(computeDaysUntilExam(preRollover, '2026-11-11', 4)).toBe(1);

    const noon = new Date(2026, 10, 11, 12, 0, 0).getTime();
    expect(resolveExamPhase(computeDaysUntilExam(noon, '2026-12-26', 4))).toBe('foundation');
    expect(resolveExamPhase(computeDaysUntilExam(noon, '2026-12-11', 4))).toBe('reinforce');
    expect(resolveExamPhase(computeDaysUntilExam(noon, '2026-11-19', 4))).toBe('reinforce');
    expect(resolveExamPhase(computeDaysUntilExam(noon, '2026-11-18', 4))).toBe('sprint');
    expect(resolveExamPhase(computeDaysUntilExam(noon, '2026-11-11', 4))).toBe('sprint');
    expect(resolveExamPhase(computeDaysUntilExam(noon, '2026-11-10', 4))).toBe('maintenance');
    expect(resolveExamPhase(computeDaysUntilExam(noon, null, 4))).toBe('unscheduled');

    expect(computeEffectiveTargetRetention(45, 0.88)).toBe(0.88);
    expect(computeEffectiveTargetRetention(8, 0.88)).toBe(0.92);
    expect(computeEffectiveTargetRetention(7, 0.88)).toBe(0.925);
    expect(computeEffectiveTargetRetention(0, 0.88)).toBe(0.94);
    expect(computeEffectiveTargetRetention(-2, 0.88)).toBe(0.88);

    expect(computeExamBufferDays(15)).toBe(5);
    const quota = computeDailyNewCardQuota({ daysUntilExam: 15, unseenCount: 100, deckNewPerDay: 20 });
    expect(quota.dailyNewCardQuota).toBe(10);
    expect(quota.newIntakeFrozen).toBe(false);

    expect(
      compressIntervalForExamHorizon({
        scheduledDays: 14,
        stabilityAfter: 4,
        daysUntilExam: 10,
      }),
    ).toBe(7);
  });

  it('caps a 500-item overdue storm to <= 900s with cross-modal balance and handles empty/corrupt inputs safely', () => {
    const nowMs = new Date(2026, 10, 11, 12, 0, 0).getTime();
    const candidates: TriageCandidateInput[] = [
      ...Array.from({ length: 350 }, (_, i) => makeFsrs(i)),
      ...Array.from({ length: 100 }, (_, i) => makeMistake(i)),
      ...Array.from({ length: 50 }, (_, i) => makeMindmap(i)),
    ];

    const out = runExamHorizonTriage({
      config: makeConfig({ examDate: '2026-11-24', sprintBudgetMinutes: 15 }),
      nowMs,
      candidates,
    });

    const used = out.selectedItems.reduce((acc, item) => acc + item.triage.estimatedSeconds, 0);
    expect(used).toBeLessThanOrEqual(900);
    expect(out.deferredBacklogCount).toBeGreaterThan(400);
    const kinds = new Set(out.selectedItems.map((i) => i.kind));
    expect(kinds.size).toBe(3);

    const empty = runExamHorizonTriage({
      config: makeConfig({ examDate: null }),
      nowMs,
      candidates: [],
    });
    expect(empty.snapshot.phase).toBe('unscheduled');
    expect(empty.snapshot.predictedExamRetrievability).toBeNull();
    expect(empty.snapshot.currentRetrievability).toBeNull();
  });

  it('dispatches examSprintClient calls over plugin:host|call with strict JSON null normalization', async () => {
    const { examSprintClient } = await import('@/shared/exam-sprint');
    invokeMock.mockResolvedValue({ ok: true });

    await examSprintClient.getExamReadiness('space_cs');
    expect(invokeMock).toHaveBeenLastCalledWith('plugin:host|call', {
      caller: 'dstu.review',
      service: 'review',
      method: 'getExamReadiness',
      args: [
        {
          spaceId: 'space_cs',
          rootFolderId: null,
          examDateOverride: null,
          sprintBudgetMinutesOverride: null,
          defaultDeckIdOverride: null,
          clientMindmapSignals: null,
        },
      ],
    });

    await examSprintClient.buildDailySprintPlan({ spaceId: null });
    expect(invokeMock).toHaveBeenLastCalledWith('plugin:host|call', {
      caller: 'dstu.review',
      service: 'review',
      method: 'buildDailySprintPlan',
      args: [
        {
          spaceId: null,
          rootFolderId: null,
          examDateOverride: null,
          sprintBudgetMinutesOverride: null,
          defaultDeckIdOverride: null,
          clientMindmapSignals: null,
          enableAiVariants: true,
          maxLiveVariants: 2,
        },
      ],
    });
  });
});
