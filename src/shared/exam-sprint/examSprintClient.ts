import { invoke } from '@tauri-apps/api/core';
import type {
  BuildDailySprintRequest,
  ClientMindmapReciteSignal,
  DailySprintPlan,
  ExamHorizonConfig,
  ExamHorizonConfigPatch,
  ExamReadinessSnapshot,
  GenerateMistakeVariantRequest,
  GenerateMistakeVariantResult,
  SettleSprintSessionRequest,
  SprintSessionSettlement,
} from './types';

function callReviewRemote<T>(method: string, args: unknown[]): Promise<T> {
  return invoke<T>('plugin:host|call', {
    caller: 'dstu.review',
    service: 'review',
    method,
    args,
  });
}

function sanitizeOptionalPatch(patch: ExamHorizonConfigPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.spaceId !== undefined) out.spaceId = patch.spaceId;
  if (patch.rootFolderId !== undefined) out.rootFolderId = patch.rootFolderId;
  if (patch.examDate !== undefined) out.examDate = patch.examDate;
  if (patch.sprintBudgetMinutes !== undefined) out.sprintBudgetMinutes = patch.sprintBudgetMinutes;
  if (patch.baseTargetRetention !== undefined) out.baseTargetRetention = patch.baseTargetRetention;
  if (patch.defaultDeckId !== undefined) out.defaultDeckId = patch.defaultDeckId;
  return out;
}

function sanitizeBuildRequest(request: BuildDailySprintRequest): Record<string, unknown> {
  return {
    spaceId: request.spaceId ?? null,
    rootFolderId: request.rootFolderId ?? null,
    examDateOverride: request.examDateOverride ?? null,
    sprintBudgetMinutesOverride: request.sprintBudgetMinutesOverride ?? null,
    defaultDeckIdOverride: request.defaultDeckIdOverride ?? null,
    clientMindmapSignals: request.clientMindmapSignals ?? null,
    enableAiVariants: request.enableAiVariants ?? true,
    maxLiveVariants: request.maxLiveVariants ?? 2,
  };
}

export interface GetExamReadinessOptions {
  spaceId: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
  clientMindmapSignals?: ClientMindmapReciteSignal[] | null;
}

export function getExamHorizonConfig(spaceId: string | null = null): Promise<ExamHorizonConfig> {
  return callReviewRemote<ExamHorizonConfig>('getExamHorizonConfig', [spaceId]);
}

export function updateExamHorizonConfig(patch: ExamHorizonConfigPatch): Promise<ExamHorizonConfig> {
  return callReviewRemote<ExamHorizonConfig>('updateExamHorizonConfig', [sanitizeOptionalPatch(patch)]);
}

export function getExamReadiness(
  spaceIdOrOptions: string | null | GetExamReadinessOptions = null,
): Promise<ExamReadinessSnapshot> {
  if (
    spaceIdOrOptions === null ||
    typeof spaceIdOrOptions === 'string'
  ) {
    return callReviewRemote<ExamReadinessSnapshot>('getExamReadiness', [
      {
        spaceId: spaceIdOrOptions,
        rootFolderId: null,
        examDateOverride: null,
        sprintBudgetMinutesOverride: null,
        defaultDeckIdOverride: null,
        clientMindmapSignals: null,
      },
    ]);
  }
  return callReviewRemote<ExamReadinessSnapshot>('getExamReadiness', [
    {
      spaceId: spaceIdOrOptions.spaceId ?? null,
      rootFolderId: spaceIdOrOptions.rootFolderId ?? null,
      examDateOverride: spaceIdOrOptions.examDateOverride ?? null,
      sprintBudgetMinutesOverride: spaceIdOrOptions.sprintBudgetMinutesOverride ?? null,
      defaultDeckIdOverride: spaceIdOrOptions.defaultDeckIdOverride ?? null,
      clientMindmapSignals: spaceIdOrOptions.clientMindmapSignals ?? null,
    },
  ]);
}

export function buildDailySprintPlan(request: BuildDailySprintRequest): Promise<DailySprintPlan> {
  return callReviewRemote<DailySprintPlan>('buildDailySprintPlan', [sanitizeBuildRequest(request)]);
}

export function generateMistakeVariant(
  request: GenerateMistakeVariantRequest,
): Promise<GenerateMistakeVariantResult> {
  return callReviewRemote<GenerateMistakeVariantResult>('generateMistakeVariant', [
    {
      questionId: request.questionId,
      planId: request.planId ?? null,
      forceRegenerate: request.forceRegenerate ?? false,
    },
  ]);
}

export function settleSprintSession(
  request: SettleSprintSessionRequest,
): Promise<SprintSessionSettlement> {
  return callReviewRemote<SprintSessionSettlement>('settleSprintSession', [
    {
      planSessionId: request.planSessionId,
      spaceId: request.spaceId ?? null,
      rootFolderId: request.rootFolderId ?? null,
      examDateOverride: request.examDateOverride ?? null,
      sprintBudgetMinutesOverride: request.sprintBudgetMinutesOverride ?? null,
      defaultDeckIdOverride: request.defaultDeckIdOverride ?? null,
      readinessBefore: request.readinessBefore,
      totalElapsedSeconds: request.totalElapsedSeconds,
      completedItems: request.completedItems,
      clientMindmapSignalsAfter: request.clientMindmapSignalsAfter ?? null,
    },
  ]);
}

export const examSprintClient = {
  getExamHorizonConfig,
  updateExamHorizonConfig,
  getExamReadiness,
  buildDailySprintPlan,
  generateMistakeVariant,
  settleSprintSession,
} as const;
