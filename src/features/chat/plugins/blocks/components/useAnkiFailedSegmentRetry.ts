/**
 * Chat V2 - Anki 卡片块失败分段任务探测与重试 Hook
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { controlDocumentTask } from '@/features/anki/taskControl';
import { parseAnkiSegmentCounts } from './ankiSegmentCounts';
import { getRetryableTaskIds } from './ankiCardsBlockFields';
import type {
  ActionStatus,
  AnkiCardsBlockData,
  DocumentTaskSummary,
} from './ankiCardsBlockTypes';

export interface UseAnkiFailedSegmentRetryOptions {
  blockStatus: string;
  data: AnkiCardsBlockData | undefined;
  documentId: string;
}

export interface UseAnkiFailedSegmentRetryResult {
  retryableTaskIds: string[];
  retryStatus: ActionStatus;
  retryError: string | null;
  handleRetryFailedSegments: () => Promise<void>;
}

export function useAnkiFailedSegmentRetry({
  blockStatus,
  data,
  documentId,
}: UseAnkiFailedSegmentRetryOptions): UseAnkiFailedSegmentRetryResult {
  const { t } = useTranslation('chatV2');
  const [retryableTaskIds, setRetryableTaskIds] = useState<string[]>([]);
  const [retryStatus, setRetryStatus] = useState<ActionStatus>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryActionLockRef = useRef(false);
  const retryScopeRef = useRef(0);

  const retryableCountHint = useMemo((): { failed: number; truncated: number } => {
    const counts = parseAnkiSegmentCounts(data?.progress?.counts);
    return {
      failed: counts?.failed ?? 0,
      truncated: counts?.truncated ?? 0,
    };
  }, [data?.progress?.counts]);

  const retryInspectionKey = useMemo(() => {
    const progressStage = data?.progress?.stage?.trim().toLowerCase() ?? '';
    const finalStatus = data?.finalStatus?.trim().toLowerCase() ?? '';
    const terminalStatuses = new Set([
      'completed',
      'completed_with_errors',
      'success',
      'error',
      'failed',
      'cancelled',
      'canceled',
    ]);
    const blockIsTerminal = blockStatus === 'success' || blockStatus === 'error';
    const statusIsTerminal = terminalStatuses.has(finalStatus) || terminalStatuses.has(progressStage);
    const hasFailureCount = retryableCountHint.failed > 0 || retryableCountHint.truncated > 0;
    return blockIsTerminal || statusIsTerminal || hasFailureCount
      ? `${blockStatus}:${finalStatus}:${progressStage}:${retryableCountHint.failed}:${retryableCountHint.truncated}`
      : '';
  }, [
    blockStatus,
    data?.finalStatus,
    data?.progress?.stage,
    retryableCountHint.failed,
    retryableCountHint.truncated,
  ]);

  const generationRetryBlocked = useMemo(() => {
    const generationIssues = data?.issues?.filter((issue) => issue.scope === 'generation') ?? [];
    return generationIssues.length > 0 && generationIssues.every((issue) => !issue.retryable);
  }, [data?.issues]);

  useEffect(() => {
    retryScopeRef.current += 1;
    retryActionLockRef.current = false;
    setRetryableTaskIds([]);
    setRetryStatus('idle');
    setRetryError(null);
  }, [documentId]);

  useEffect(() => {
    if (!documentId || !retryInspectionKey || generationRetryBlocked) {
      setRetryableTaskIds([]);
      return;
    }

    let cancelled = false;
    void invoke<DocumentTaskSummary[]>('get_document_tasks', { documentId })
      .then((tasks) => {
        if (!cancelled) {
          setRetryableTaskIds(getRetryableTaskIds(tasks));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRetryableTaskIds([]);
          console.warn('[AnkiCardsBlock] Failed to inspect retryable document tasks:', error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [documentId, retryInspectionKey, generationRetryBlocked]);

  const handleRetryFailedSegments = useCallback(async () => {
    if (!documentId || retryableTaskIds.length === 0 || retryActionLockRef.current) return;

    const attemptedTaskIds = [...retryableTaskIds];
    const attemptedTaskIdSet = new Set(attemptedTaskIds);
    const scope = retryScopeRef.current;
    retryActionLockRef.current = true;
    setRetryStatus('loading');
    setRetryError(null);

    try {
      const results = await Promise.allSettled(
        attemptedTaskIds.map((taskId) => controlDocumentTask({ action: 'retry', taskId })),
      );
      if (scope !== retryScopeRef.current) return;

      const failedTaskIds = results.flatMap((result, index) =>
        result.status === 'rejected' ? [attemptedTaskIds[index]] : [],
      );
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      setRetryableTaskIds((current) => {
        const unattempted = current.filter((taskId) => !attemptedTaskIdSet.has(taskId));
        return Array.from(new Set([...unattempted, ...failedTaskIds]));
      });

      if (failedTaskIds.length === 0) {
        setRetryStatus('success');
        showGlobalNotification(
          'success',
          t('blocks.ankiCards.action.retrySegmentsStarted', { count: attemptedTaskIds.length }),
        );
        return;
      }

      const messageKey =
        failedTaskIds.length === attemptedTaskIds.length
          ? 'blocks.ankiCards.action.retrySegmentsFailed'
          : 'blocks.ankiCards.action.retrySegmentsPartial';
      const summary = t(messageKey, {
        failed: failedTaskIds.length,
        total: attemptedTaskIds.length,
      });
      const detail = firstFailure ? getErrorMessage(firstFailure.reason) : '';
      const errorMessage = detail ? `${summary}: ${detail}` : summary;
      setRetryStatus('error');
      setRetryError(errorMessage);
      showGlobalNotification(
        failedTaskIds.length === attemptedTaskIds.length ? 'error' : 'warning',
        summary,
        detail || undefined,
      );
    } finally {
      if (scope === retryScopeRef.current) {
        retryActionLockRef.current = false;
      }
    }
  }, [documentId, retryableTaskIds, t]);

  return {
    retryableTaskIds,
    retryStatus,
    retryError,
    handleRetryFailedSegments,
  };
}
