/**
 * Chat V2 - TauriAdapter 拆分模块 —— ChatAnki 重试/加载后的块状态对账（以后端 TaskSnapshot 为权威）
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import type { AnkiCard } from '@/types';
import { autoSave } from '../../core/middleware/autoSave';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import type { TauriAdapterHost } from './adapterHost';

export function scheduleAnkiRetryReconcile(host: TauriAdapterHost, blockId: string, documentId: string): void {
  const revision = (host.ankiRetryReconcileRevisions.get(documentId) ?? 0) + 1;
  host.ankiRetryReconcileRevisions.set(documentId, revision);
  void host.reconcileAnkiRetryState(blockId, documentId, revision).catch((error: unknown) => {
    if (host.ankiRetryReconcileRevisions.get(documentId) !== revision) return;
    console.warn(
      LOG_PREFIX,
      `Failed to reconcile retried Anki document ${documentId}:`,
      getErrorMessage(error),
    );
  });
}

export function reconcileLoadedAnkiBlocks(host: TauriAdapterHost): void {
  const state = host.getCurrentState();
  for (const block of state.blocks.values()) {
    if (block.type !== 'anki_cards') continue;
    const output = block.toolOutput as Record<string, unknown> | undefined;
    const documentId = typeof output?.documentId === 'string' ? output.documentId.trim() : '';
    if (!documentId) continue;
    const cards = Array.isArray(output?.cards) ? output.cards : [];
    const needsProjectionUpgrade = Number(output?.schemaVersion ?? 0) < 2;
    const inconsistentTerminal = block.status === 'error' && (
      output?.workflowStatus !== 'failed' ||
      output?.generationStatus !== 'failed' ||
      output?.finalStatus !== 'error'
    );
    if (needsProjectionUpgrade || inconsistentTerminal) {
      host.scheduleAnkiRetryReconcile(block.id, documentId);
    }
  }
}

export async function reconcileAnkiRetryState(
  host: TauriAdapterHost,
  blockId: string,
  documentId: string,
  revision: number,
): Promise<void> {
  type TaskSnapshot = {
    status?: unknown;
    error_message?: unknown;
    errorMessage?: unknown;
  };

  const tasks = await invoke<TaskSnapshot[]>('get_document_tasks', { documentId });
  if (host.ankiRetryReconcileRevisions.get(documentId) !== revision) return;
  if (!Array.isArray(tasks) || tasks.length === 0) return;

  const normalizeStatus = (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  const statuses = tasks.map((task) => normalizeStatus(task.status));
  const count = (status: string) => statuses.filter((value) => value === status).length;
  const counts = {
    total: tasks.length,
    pending: count('pending'),
    processing: count('processing'),
    streaming: count('streaming'),
    paused: count('paused'),
    completed: count('completed'),
    failed: count('failed'),
    truncated: count('truncated'),
    cancelled: count('cancelled'),
  };
  const hasInFlight = counts.pending + counts.processing + counts.streaming > 0;

  let cards: AnkiCard[] | undefined;
  if (!hasInFlight) {
    cards = await invoke<AnkiCard[]>('get_document_cards', { documentId });
    if (host.ankiRetryReconcileRevisions.get(documentId) !== revision) return;
    if (!Array.isArray(cards)) cards = [];
  }

  const state = host.getCurrentState();
  const block = state.blocks.get(blockId);
  const output = block?.toolOutput as Record<string, unknown> | undefined;
  if (block?.type !== 'anki_cards' || output?.documentId !== documentId) return;

  const currentCards = Array.isArray(output.cards) ? (output.cards as AnkiCard[]) : [];
  // Once a terminal SQLite snapshot is available it is authoritative. Re-merging the
  // serialized UI copy can resurrect deleted cards or overwrite newer database edits.
  const mergedCards = cards ?? currentCards;
  const hasFailure = counts.failed + counts.truncated > 0;
  const hasUsableCard = mergedCards.some(
    (card) => !(card as AnkiCard & { is_error_card?: boolean }).is_error_card,
  );
  const hasUserCancellation = tasks.some((task, index) => {
    if (statuses[index] !== 'cancelled') return false;
    const error = task.error_message ?? task.errorMessage;
    return error !== 'GLOBAL_CARD_LIMIT_REACHED';
  });
  const terminalCount = counts.completed + counts.failed + counts.truncated + counts.cancelled;
  const completedRatio = counts.total > 0 ? terminalCount / counts.total : 0;

  let finalStatus: 'generating' | 'paused' | 'cancelled' | 'completed' | 'completed_with_errors' | 'error';
  let blockStatus: 'running' | 'success' | 'error';
  if (hasInFlight) {
    finalStatus = 'generating';
    blockStatus = 'running';
  } else if (counts.paused > 0) {
    finalStatus = 'paused';
    blockStatus = 'running';
  } else if (hasUserCancellation) {
    finalStatus = 'cancelled';
    blockStatus = 'success';
  } else if (hasFailure) {
    const isPartial = counts.completed > 0 || hasUsableCard;
    finalStatus = isPartial ? 'completed_with_errors' : 'error';
    blockStatus = isPartial ? 'success' : 'error';
  } else {
    finalStatus = 'completed';
    blockStatus = 'success';
  }

  const taskError = tasks
    .map((task) => task.error_message ?? task.errorMessage)
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const normalizedTaskError = taskError?.toLowerCase() ?? '';
  const taskIssueCode =
    normalizedTaskError.includes('balance is insufficient') ||
    normalizedTaskError.includes('余额不足') ||
    normalizedTaskError.includes('额度不足')
      ? 'provider_quota_exhausted'
      : normalizedTaskError.includes('403') || normalizedTaskError.includes('访问被拒绝')
        ? 'provider_forbidden'
      : normalizedTaskError.includes('401') ||
          normalizedTaskError.includes('api key') ||
          normalizedTaskError.includes('认证失败')
        ? 'provider_auth_failed'
        : 'generation_failed';
  const taskErrorRetryable = taskIssueCode === 'generation_failed';
  const progress = (output.progress as Record<string, unknown> | undefined) ?? {};
  const recoveredFromGenerationError =
    ['error', 'failed'].includes(String(output.finalStatus ?? '').toLowerCase()) ||
    ['error', 'failed'].includes(String(progress.stage ?? '').toLowerCase());
  const messageKey =
    finalStatus === 'completed_with_errors'
      ? 'blocks.ankiCards.progress.messages.completedWithErrors'
      : finalStatus === 'generating'
        ? 'blocks.ankiCards.progress.messages.generating'
        : undefined;

  state.updateBlock(blockId, {
    status: blockStatus,
    error: finalStatus === 'error' ? taskError ?? block.error ?? 'generation_failed' : undefined,
    toolOutput: {
      ...output,
      schemaVersion: 2,
      stateRevision: Math.max(Date.now(), Number(output.stateRevision ?? 0) + 1),
      cards: mergedCards,
      workflowStatus:
        finalStatus === 'generating'
          ? 'running'
          : finalStatus === 'completed_with_errors'
          ? 'completed_with_warnings'
          : finalStatus === 'error'
            ? 'failed'
            : finalStatus,
      generationStatus:
        finalStatus === 'generating'
          ? 'running'
          : finalStatus === 'completed_with_errors'
          ? counts.completed > 0 ? 'partial' : 'failed'
          : finalStatus === 'error'
            ? 'failed'
            : finalStatus,
      deliveryStatus: hasUsableCard ? 'ready' : 'empty',
      recoveryStatus:
        finalStatus === 'completed_with_errors' && counts.completed === 0
          ? 'existing_cards'
          : 'none',
      availableCards: mergedCards.filter(
        (card) => !(card as AnkiCard & { is_error_card?: boolean }).is_error_card,
      ).length,
      finalStatus,
      finalError:
        finalStatus === 'error'
          ? taskError ?? output.finalError
          : undefined,
      issues: taskError
        ? [{
            scope: 'generation',
            code: taskIssueCode,
            severity: hasUsableCard ? 'warning' : 'error',
            retryable: taskErrorRetryable,
            recovered: hasUsableCard,
            detail: taskError,
          }]
        : [],
      warnings: finalStatus === 'completed_with_errors'
        ? [{
            code: 'generation_recovered',
            messageKey: 'blocks.ankiCards.warnings.generationRecovered',
            messageParams: { count: mergedCards.length },
          }]
        : output.warnings,
      syncStatus:
        recoveredFromGenerationError && output.syncStatus === 'error'
          ? 'pending'
          : output.syncStatus,
      syncError:
        recoveredFromGenerationError && output.syncStatus === 'error'
          ? undefined
          : output.syncError,
      progress: {
        ...progress,
        stage: finalStatus,
        messageKey,
        messageParams:
          finalStatus === 'completed_with_errors'
            ? { failed: counts.failed, truncated: counts.truncated }
            : undefined,
        cardsGenerated: mergedCards.length,
        counts,
        completedRatio,
        lastUpdatedAt: new Date().toISOString(),
      },
    },
  });
  state.updateBlockStatus(blockId, blockStatus);
  autoSave.scheduleAutoSave(host.getCurrentState());

  if (blockStatus !== 'running') {
    host.retryingAnkiDocumentIds.delete(documentId);
  }
}
