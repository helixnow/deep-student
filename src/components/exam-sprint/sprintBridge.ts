import { invoke } from '@tauri-apps/api/core';
import { examSprintClient } from '@/shared/exam-sprint';
import {
  clampSprintBudgetMinutes,
  type BuildDailySprintRequest,
  type ClientMindmapReciteSignal,
  type DailySprintPlan,
  type ExamHorizonConfig,
  type ExamHorizonConfigPatch,
  type ExamPhase,
  type ExamReadinessSnapshot,
  type SettleSprintSessionRequest,
  type SprintRating,
  type SprintSessionSettlement,
} from './sprintContracts';

export const MINDMAP_RECITE_STATS_PREFIX = 'mindmap-recite-stats:';

interface StoredReciteBlankStat {
  attempts?: unknown;
  misses?: unknown;
  lastReviewedAt?: unknown;
}

type StoredReciteNodeStats = Record<string, Record<string, StoredReciteBlankStat>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteRatioOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function computeDaysUntilExamLocal(
  examDate: string | null | undefined,
  dayRolloverHour = 4,
  nowMs: number = Date.now(),
): number | null {
  if (typeof examDate !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }

  const safeRollover = Number.isFinite(dayRolloverHour)
    ? Math.max(0, Math.min(23, Math.trunc(dayRolloverHour)))
    : 4;
  const logicalNow = new Date(nowMs - safeRollover * 3_600_000);
  const todayUtc = Date.UTC(
    logicalNow.getFullYear(),
    logicalNow.getMonth(),
    logicalNow.getDate(),
  );
  return Math.round((candidate.getTime() - todayUtc) / 86_400_000);
}

export function resolvePhaseFromDays(
  examDate: string | null,
  daysUntilExam: number | null,
): ExamPhase {
  if (!examDate || daysUntilExam === null) return 'unscheduled';
  if (daysUntilExam < 0) return 'maintenance';
  if (daysUntilExam <= 7) return 'sprint';
  if (daysUntilExam <= 30) return 'reinforce';
  return 'foundation';
}

export function createEmptyExamReadiness(
  spaceId: string | null = null,
  examDate: string | null = null,
  nowMs: number = Date.now(),
): ExamReadinessSnapshot {
  const daysUntilExam = computeDaysUntilExamLocal(examDate, 4, nowMs);
  const normalizedExamDate = daysUntilExam === null ? null : examDate;
  const phase = resolvePhaseFromDays(normalizedExamDate, daysUntilExam);
  return {
    spaceId,
    examDate: normalizedExamDate,
    daysUntilExam,
    phase,
    effectiveTargetRetention: phase === 'sprint' ? 0.94 : 0.88,
    dailyNewCardQuota: phase === 'sprint' && daysUntilExam !== null && daysUntilExam <= 3 ? 0 : 20,
    newIntakeFrozen: phase === 'sprint' && daysUntilExam !== null && daysUntilExam <= 3,
    predictedExamRetrievability: null,
    currentRetrievability: null,
    totalActiveItems: 0,
    selectedSprintCount: 0,
    estimatedSprintMinutes: 0,
    estimatedSprintSeconds: 0,
    deferredBacklogCount: 0,
    breakdown: {
      fsrsDueCount: 0,
      fsrsNewCount: 0,
      mistakeDueCount: 0,
      mindmapWeakCount: 0,
    },
    computedAtMs: nowMs,
  };
}

export function sanitizeExamReadinessSnapshot(raw: unknown): ExamReadinessSnapshot | null {
  if (!isRecord(raw)) return null;
  const validPhases: ReadonlySet<ExamPhase> = new Set([
    'foundation',
    'reinforce',
    'sprint',
    'maintenance',
    'unscheduled',
  ]);
  const rawPhase = typeof raw.phase === 'string' && validPhases.has(raw.phase as ExamPhase)
    ? (raw.phase as ExamPhase)
    : 'unscheduled';
  const examDate = typeof raw.examDate === 'string' && raw.examDate.trim().length > 0
    ? raw.examDate.trim()
    : null;
  const daysUntilExam = typeof raw.daysUntilExam === 'number' && Number.isFinite(raw.daysUntilExam)
    ? Math.trunc(raw.daysUntilExam)
    : computeDaysUntilExamLocal(examDate);
  const totalActiveItems = nonNegativeInt(raw.totalActiveItems);
  const breakdownRaw = isRecord(raw.breakdown) ? raw.breakdown : {};

  return {
    spaceId: typeof raw.spaceId === 'string' ? raw.spaceId : null,
    examDate,
    daysUntilExam,
    phase: rawPhase,
    effectiveTargetRetention:
      typeof raw.effectiveTargetRetention === 'number' && Number.isFinite(raw.effectiveTargetRetention)
        ? Math.max(0.8, Math.min(0.97, raw.effectiveTargetRetention))
        : 0.88,
    dailyNewCardQuota: nonNegativeInt(raw.dailyNewCardQuota),
    newIntakeFrozen: Boolean(raw.newIntakeFrozen),
    predictedExamRetrievability:
      totalActiveItems === 0 ? null : finiteRatioOrNull(raw.predictedExamRetrievability),
    currentRetrievability:
      totalActiveItems === 0 ? null : finiteRatioOrNull(raw.currentRetrievability),
    totalActiveItems,
    selectedSprintCount: nonNegativeInt(raw.selectedSprintCount),
    estimatedSprintMinutes: nonNegativeInt(raw.estimatedSprintMinutes),
    estimatedSprintSeconds: nonNegativeInt(raw.estimatedSprintSeconds),
    deferredBacklogCount: nonNegativeInt(raw.deferredBacklogCount),
    breakdown: {
      fsrsDueCount: nonNegativeInt(breakdownRaw.fsrsDueCount),
      fsrsNewCount: nonNegativeInt(breakdownRaw.fsrsNewCount),
      mistakeDueCount: nonNegativeInt(breakdownRaw.mistakeDueCount),
      mindmapWeakCount: nonNegativeInt(breakdownRaw.mindmapWeakCount),
    },
    computedAtMs:
      typeof raw.computedAtMs === 'number' && Number.isFinite(raw.computedAtMs)
        ? raw.computedAtMs
        : Date.now(),
  };
}

export function collectClientMindmapSignals(): ClientMindmapReciteSignal[] {
  if (typeof globalThis.localStorage === 'undefined') return [];
  const signals: ClientMindmapReciteSignal[] = [];
  try {
    const storage = globalThis.localStorage;
    for (let idx = 0; idx < storage.length; idx += 1) {
      const key = storage.key(idx);
      if (!key || !key.startsWith(MINDMAP_RECITE_STATS_PREFIX)) continue;
      const mindmapId = key.slice(MINDMAP_RECITE_STATS_PREFIX.length).trim();
      if (!mindmapId) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;

      for (const [nodeId, blankMap] of Object.entries(parsed as StoredReciteNodeStats)) {
        if (!nodeId || !isRecord(blankMap)) continue;
        let worstError = -1;
        let chosenAttempts = 0;
        let chosenMisses = 0;
        let latestReviewedAt: number | null = null;

        for (const stat of Object.values(blankMap)) {
          if (!isRecord(stat)) continue;
          const attempts = nonNegativeInt(stat.attempts);
          const misses = Math.min(attempts, nonNegativeInt(stat.misses));
          const smoothed = (misses + 1) / (attempts + 2);
          if (smoothed > worstError) {
            worstError = smoothed;
            chosenAttempts = attempts;
            chosenMisses = misses;
          }
          if (typeof stat.lastReviewedAt === 'number' && Number.isFinite(stat.lastReviewedAt)) {
            latestReviewedAt =
              latestReviewedAt === null
                ? stat.lastReviewedAt
                : Math.max(latestReviewedAt, stat.lastReviewedAt);
          }
        }

        if (worstError >= 0) {
          signals.push({
            mindmapId,
            nodeId,
            attempts: chosenAttempts,
            misses: chosenMisses,
            lastReviewedAtMs: latestReviewedAt,
          });
        }
      }
    }
  } catch {
    return [];
  }
  return signals;
}

export function recordMindmapClozeSprintOutcome(
  mindmapId: string,
  nodeId: string,
  blankCount: number,
  rating: SprintRating,
  nowMs: number = Date.now(),
): void {
  if (!mindmapId || !nodeId || typeof globalThis.localStorage === 'undefined') return;
  const missed = rating === 1 || rating === 2;
  const effectiveBlankCount = Math.max(1, Math.trunc(blankCount || 1));
  const storageKey = `${MINDMAP_RECITE_STATS_PREFIX}${mindmapId}`;
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const nextStats: Record<string, Record<number, { attempts: number; misses: number; lastReviewedAt: number }>> =
      isRecord(parsed) ? { ...(parsed as Record<string, Record<number, { attempts: number; misses: number; lastReviewedAt: number }>>) } : {};
    const prevNode = isRecord(nextStats[nodeId]) ? { ...nextStats[nodeId] } : {};

    for (let i = 0; i < effectiveBlankCount; i += 1) {
      const prevBlank = isRecord(prevNode[i]) ? prevNode[i] : undefined;
      const prevAttempts = nonNegativeInt(prevBlank?.attempts);
      const prevMisses = nonNegativeInt(prevBlank?.misses);
      prevNode[i] = {
        attempts: prevAttempts + 1,
        misses: prevMisses + (missed ? 1 : 0),
        lastReviewedAt: nowMs,
      };
    }

    nextStats[nodeId] = prevNode;
    globalThis.localStorage.setItem(storageKey, JSON.stringify(nextStats));
  } catch {
    // Degrade silently when storage is unavailable or quota-limited.
  }
}

export async function commitFsrsSprintRatingInline(
  cardStateId: string,
  rating: SprintRating,
  durationMs: number,
): Promise<boolean> {
  if (!cardStateId) return false;
  try {
    const res = await invoke<unknown>('fsrs_rate', {
      cardStateId,
      rating,
      durationMs: Math.max(0, Math.round(durationMs)),
    });
    if (!isRecord(res)) return false;
    return (
      typeof res.logId === 'string'
      || typeof res.log_id === 'string'
      || isRecord(res.cardState)
      || isRecord(res.card_state)
    );
  } catch {
    return false;
  }
}

export async function fetchExamHorizonConfig(
  spaceId: string | null = null,
): Promise<ExamHorizonConfig> {
  try {
    const raw = await examSprintClient.getExamHorizonConfig(spaceId);
    if (isRecord(raw)) {
      return {
        spaceId: typeof raw.spaceId === 'string' ? raw.spaceId : spaceId,
        rootFolderId: typeof raw.rootFolderId === 'string' ? raw.rootFolderId : null,
        examDate: typeof raw.examDate === 'string' ? raw.examDate : null,
        sprintBudgetMinutes: clampSprintBudgetMinutes(raw.sprintBudgetMinutes, 15),
        baseTargetRetention:
          typeof raw.baseTargetRetention === 'number' && Number.isFinite(raw.baseTargetRetention)
            ? Math.max(0.8, Math.min(0.97, raw.baseTargetRetention))
            : 0.88,
        defaultDeckId: typeof raw.defaultDeckId === 'string' ? raw.defaultDeckId : null,
        dayRolloverHour:
          typeof raw.dayRolloverHour === 'number' && Number.isFinite(raw.dayRolloverHour)
            ? Math.max(0, Math.min(23, Math.trunc(raw.dayRolloverHour)))
            : 4,
      };
    }
  } catch {
    // Fall back to deterministic default config when Host remote is unavailable.
  }
  return {
    spaceId,
    rootFolderId: null,
    examDate: null,
    sprintBudgetMinutes: 15,
    baseTargetRetention: 0.88,
    defaultDeckId: null,
    dayRolloverHour: 4,
  };
}

export async function saveExamHorizonConfig(
  patch: ExamHorizonConfigPatch,
): Promise<ExamHorizonConfig> {
  const updated = await examSprintClient.updateExamHorizonConfig(patch);
  if (isRecord(updated)) {
    return {
      spaceId: typeof updated.spaceId === 'string' ? updated.spaceId : (patch.spaceId ?? null),
      rootFolderId: typeof updated.rootFolderId === 'string' ? updated.rootFolderId : null,
      examDate: typeof updated.examDate === 'string' ? updated.examDate : null,
      sprintBudgetMinutes: clampSprintBudgetMinutes(updated.sprintBudgetMinutes, 15),
      baseTargetRetention:
        typeof updated.baseTargetRetention === 'number' && Number.isFinite(updated.baseTargetRetention)
          ? Math.max(0.8, Math.min(0.97, updated.baseTargetRetention))
          : 0.88,
      defaultDeckId: typeof updated.defaultDeckId === 'string' ? updated.defaultDeckId : null,
      dayRolloverHour:
        typeof updated.dayRolloverHour === 'number' && Number.isFinite(updated.dayRolloverHour)
          ? Math.max(0, Math.min(23, Math.trunc(updated.dayRolloverHour)))
          : 4,
    };
  }
  return {
    spaceId: patch.spaceId ?? null,
    rootFolderId: patch.rootFolderId ?? null,
    examDate: patch.examDate ?? null,
    sprintBudgetMinutes: clampSprintBudgetMinutes(patch.sprintBudgetMinutes, 15),
    baseTargetRetention: patch.baseTargetRetention ?? 0.88,
    defaultDeckId: patch.defaultDeckId ?? null,
    dayRolloverHour: 4,
  };
}

export async function fetchExamReadiness(options: {
  spaceId: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
}): Promise<ExamReadinessSnapshot | null> {
  const signals = collectClientMindmapSignals();
  const raw = await examSprintClient.getExamReadiness({
    spaceId: options.spaceId,
    rootFolderId: options.rootFolderId ?? null,
    examDateOverride: options.examDateOverride ?? null,
    sprintBudgetMinutesOverride: options.sprintBudgetMinutesOverride ?? null,
    defaultDeckIdOverride: options.defaultDeckIdOverride ?? null,
    clientMindmapSignals: signals.length > 0 ? signals : null,
  });
  return sanitizeExamReadinessSnapshot(raw);
}

export async function fetchDailySprintPlan(
  request: BuildDailySprintRequest,
): Promise<DailySprintPlan> {
  const signals = request.clientMindmapSignals ?? collectClientMindmapSignals();
  const raw = await examSprintClient.buildDailySprintPlan({
    ...request,
    clientMindmapSignals: signals.length > 0 ? signals : null,
  });
  if (isRecord(raw) && Array.isArray(raw.items)) {
    const readinessBefore =
      sanitizeExamReadinessSnapshot(raw.readinessBefore)
      ?? createEmptyExamReadiness(request.spaceId);
    return {
      ...(raw as unknown as DailySprintPlan),
      readinessBefore,
    };
  }
  return {
    planSessionId: `sprint_${Date.now()}`,
    config: await fetchExamHorizonConfig(request.spaceId),
    readinessBefore: createEmptyExamReadiness(request.spaceId, request.examDateOverride ?? null),
    items: [],
    deferredBacklogCount: 0,
    generatedVariantsCount: 0,
    createdAtMs: Date.now(),
  };
}

export function buildFallbackSettlement(
  request: SettleSprintSessionRequest,
): SprintSessionSettlement {
  const uniqueByItem = new Map<string, SettleSprintSessionRequest['completedItems'][number]>();
  let againCount = 0;
  for (const item of request.completedItems) {
    if (item.rating === 1) againCount += 1;
    uniqueByItem.set(item.sprintItemId, item);
  }
  const finalItems = [...uniqueByItem.values()];
  const passedCount = finalItems.filter((item) => item.passed).length;
  const fsrsCards = finalItems.filter((item) => item.kind === 'fsrs_card').length;
  const mistakes = finalItems.filter((item) => item.kind === 'mistake_question').length;
  const variantsSolved = finalItems.filter(
    (item) => item.kind === 'mistake_question' && item.isVariant,
  ).length;
  const mindmapNodes = finalItems.filter((item) => item.kind === 'mindmap_cloze').length;

  const before = request.readinessBefore.predictedExamRetrievability;
  const activeDenom = Math.max(1, request.readinessBefore.totalActiveItems, finalItems.length);
  const gainRatio = before !== null ? Math.min(1 - before, (passedCount / activeDenom) * 0.12) : null;
  const after = before !== null && gainRatio !== null ? Math.min(0.99, before + gainRatio) : before;
  const delta =
    before !== null && after !== null
      ? Math.round((after - before) * 1000) / 10
      : null;

  const readinessAfter: ExamReadinessSnapshot = {
    ...request.readinessBefore,
    predictedExamRetrievability: after,
    selectedSprintCount: Math.max(0, request.readinessBefore.selectedSprintCount - finalItems.length),
    computedAtMs: Date.now(),
  };

  return {
    planSessionId: request.planSessionId,
    readinessBefore: request.readinessBefore,
    readinessAfter,
    readinessDeltaPctPoints: delta,
    totalCompleted: finalItems.length,
    passedCount,
    againCount,
    totalElapsedSeconds: Math.max(0, Math.round(request.totalElapsedSeconds)),
    studyTimeRecordedSeconds:
      request.totalElapsedSeconds >= 5 ? Math.round(request.totalElapsedSeconds) : 0,
    masteryEventsWritten: finalItems.length,
    byKind: {
      fsrsCards,
      mistakes,
      variantsSolved,
      mindmapNodes,
    },
    conceptDeltas: [],
  };
}

export async function settleDailySprint(
  request: SettleSprintSessionRequest,
): Promise<SprintSessionSettlement> {
  const signalsAfter = request.clientMindmapSignalsAfter ?? collectClientMindmapSignals();
  const raw = await examSprintClient.settleSprintSession({
      ...request,
      clientMindmapSignalsAfter: signalsAfter.length > 0 ? signalsAfter : null,
    });
    if (isRecord(raw) && typeof raw.planSessionId === 'string') {
      const readinessBefore =
        sanitizeExamReadinessSnapshot(raw.readinessBefore) ?? request.readinessBefore;
      const readinessAfter =
        sanitizeExamReadinessSnapshot(raw.readinessAfter) ?? readinessBefore;
      return {
        ...(raw as unknown as SprintSessionSettlement),
        readinessBefore,
        readinessAfter,
        readinessDeltaPctPoints:
          typeof raw.readinessDeltaPctPoints === 'number'
          && Number.isFinite(raw.readinessDeltaPctPoints)
            ? raw.readinessDeltaPctPoints
            : null,
      };
    }
  // A failed/ambiguous host transaction must be retried under the same session ID.
  // Falling back to fsrs_rate can double-apply a committed rating and drops mistakes.
  throw new Error('冲刺结算失败，请重试');
}
