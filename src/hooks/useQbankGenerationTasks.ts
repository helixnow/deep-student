/**
 * 题目集 AI 出题 - 全局任务监听（常驻 App 壳层，2026-09-09 后台任务化）
 *
 * 两路保证：
 * 1. 全局事件 `qbank_generation_task_event`（AppHandle::emit，窗口销毁不受影响）
 * 2. 轮询兜底：仅存在非终态任务时每 30s 主动查一次，补齐「事件早于监听注册」竞态
 *
 * 完成 / 失败时发全局通知；同一任务只通知一次（notifiedRef 去重）。
 */

import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useQbankGenerationStore } from '@/stores/qbankGenerationStore';
import {
  extractAuthoringDraftAttribution,
  extractGenerationTaskAttribution,
  isTerminalTaskStatus,
  QBANK_OPEN_GENERATION_DRAFT_EVENT,
  type PendingAuthoringDraftOrigin,
  type QbankGenerationTask,
  type QbankOpenGenerationDraftDetail,
} from '@/types/qbankGeneration';

/** 全局任务事件名（与 Rust `qbank_generation::events::QBANK_GENERATION_TASK_EVENT` 一致） */
export const QBANK_GENERATION_TASK_EVENT = 'qbank_generation_task_event';

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 30_000;

type AttributionTranslateFn = (key: string, options?: Record<string, unknown>) => string;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectMetadataSourceNames(
  metadata: Record<string, unknown>,
  request: Record<string, unknown> | null,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const str = readNonEmptyString(raw);
    if (!str || seen.has(str)) return;
    seen.add(str);
    names.push(str);
  };

  if (Array.isArray(metadata.sources)) {
    for (const item of metadata.sources) {
      const rec = asRecord(item);
      if (!rec) continue;
      push(rec.name ?? rec.file_name ?? rec.title);
    }
  }
  if (request && Array.isArray(request.reference_files_base64)) {
    for (const item of request.reference_files_base64) {
      const rec = asRecord(item);
      if (!rec) continue;
      push(rec.name);
    }
  }
  return names;
}

/**
 * Format authoring draft / AI generation attribution strictly through the active i18n locale
 * so `en-US` notifications and panels never leak hardcoded Chinese prefixes.
 */
export function formatLocalizedAuthoringAttribution(
  metadata: unknown,
  translate: AttributionTranslateFn,
  options?: { defaultOrigin?: PendingAuthoringDraftOrigin },
): { origin: PendingAuthoringDraftOrigin; sourceLabel: string } {
  const { origin } = extractAuthoringDraftAttribution(metadata, options);
  const meta = asRecord(metadata);
  const request = asRecord(meta?.request);
  const listSeparator = translate('exam_sheet:aiGeneration.attributionListSeparator', {
    defaultValue: ', ',
  });
  const parts: string[] = [];

  const topicHint = readNonEmptyString(request?.topic_hint);
  if (topicHint) {
    const clipped = topicHint.length > 36 ? `${topicHint.slice(0, 36)}…` : topicHint;
    parts.push(
      translate('exam_sheet:aiGeneration.attributionTopic', {
        value: clipped,
        defaultValue: 'Topic: {{value}}',
      }),
    );
  }

  const sourceNames = meta ? collectMetadataSourceNames(meta, request) : [];
  if (sourceNames.length > 0) {
    const shown = sourceNames.slice(0, 2).join(listSeparator);
    parts.push(
      sourceNames.length > 2
        ? translate('exam_sheet:aiGeneration.attributionSourcesMore', {
            names: shown,
            count: sourceNames.length,
            defaultValue: 'Sources: {{names}} ({{count}} total)',
          })
        : translate('exam_sheet:aiGeneration.attributionSources', {
            names: shown,
            defaultValue: 'Sources: {{names}}',
          }),
    );
  }

  if (request && Array.isArray(request.knowledge_points)) {
    const kps = request.knowledge_points
      .map((item) => readNonEmptyString(item))
      .filter((item): item is string => Boolean(item));
    if (kps.length > 0) {
      const shown = `${kps.slice(0, 3).join(listSeparator)}${kps.length > 3 ? '…' : ''}`;
      parts.push(
        translate('exam_sheet:aiGeneration.attributionKnowledgePoints', {
          points: shown,
          defaultValue: 'Knowledge points: {{points}}',
        }),
      );
    }
  }

  if (parts.length === 0 && request?.based_on_existing === true) {
    parts.push(
      translate('exam_sheet:aiGeneration.attributionBasedOnExisting', {
        defaultValue: 'Variants based on existing questions',
      }),
    );
  }

  if (parts.length === 0) {
    const primaryModel = asRecord(meta?.primary_model);
    const modelLabel =
      readNonEmptyString(primaryModel?.name) ?? readNonEmptyString(primaryModel?.model);
    if (origin === 'ai_generation') {
      const base = translate('exam_sheet:aiGeneration.attributionOriginAi', {
        defaultValue: 'AI Question Generation',
      });
      parts.push(modelLabel ? `${base} · ${modelLabel}` : base);
    } else if (origin === 'chat_import') {
      parts.push(
        translate('exam_sheet:aiGeneration.attributionOriginChat', {
          defaultValue: 'Chat Import',
        }),
      );
    } else {
      const base = translate('exam_sheet:aiGeneration.attributionOriginFile', {
        defaultValue: 'Document / Exam Import',
      });
      parts.push(modelLabel ? `${base} · ${modelLabel}` : base);
    }
  }

  return {
    origin,
    sourceLabel: parts.join(' · '),
  };
}

export function useQbankGenerationTasks(): void {
  const { t } = useTranslation(['exam_sheet']);
  const upsertTask = useQbankGenerationStore((state) => state.upsertTask);
  const notifiedRef = useRef<Set<string>>(new Set());

  const handleTask = useCallback(
    (task: QbankGenerationTask) => {
      upsertTask(task);
      if (!isTerminalTaskStatus(task.status)) return;
      if (notifiedRef.current.has(task.id)) return;
      notifiedRef.current.add(task.id);

      if (task.status === 'completed') {
        const { count } = extractGenerationTaskAttribution(task);
        const { sourceLabel } = formatLocalizedAuthoringAttribution(
          task.authoringResult?.model_route,
          (key, opts) => t(key, opts),
          { defaultOrigin: 'ai_generation' },
        );
        if (typeof window !== 'undefined') {
          // 立即通知题库视图刷新待确认草稿列表，避免停留在“暂无题目”
          window.dispatchEvent(
            new CustomEvent('qbank:refresh', {
              detail: {
                examId: task.examId,
                taskId: task.id,
                jobId: task.authoringResult?.job_id ?? null,
                source: 'ai_generation',
              },
            }),
          );
        }
        const message = sourceLabel
          ? t('exam_sheet:aiGeneration.taskCompletedAttributed', {
              count,
              source: sourceLabel,
              defaultValue:
                'AI question generation finished: {{count}} draft question(s) ready to review (Source: {{source}})',
            })
          : t('exam_sheet:aiGeneration.taskCompletedReady', {
              count,
              defaultValue:
                'AI question generation finished: {{count}} draft question(s) ready to review and import',
            });
        showGlobalNotification(
          'success',
          message,
          undefined,
          {
            action: {
              label: t('exam_sheet:aiGeneration.openReviewAction', {
                defaultValue: 'Review & Import',
              }),
              onClick: () => {
                if (typeof window === 'undefined') return;
                const detail: QbankOpenGenerationDraftDetail = {
                  examId: task.examId,
                  taskId: task.id,
                  jobId: task.authoringResult?.job_id ?? null,
                };
                window.dispatchEvent(
                  new CustomEvent<QbankOpenGenerationDraftDetail>(
                    QBANK_OPEN_GENERATION_DRAFT_EVENT,
                    { detail },
                  ),
                );
              },
            },
          },
        );
      } else if (task.status === 'failed') {
        showGlobalNotification(
          'error',
          t('exam_sheet:aiGeneration.taskFailed', { error: task.error ?? '' }),
        );
      }
    },
    [t, upsertTask],
  );

  // 1) 全局事件
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void (async () => {
      try {
        const fn = await listen<QbankGenerationTask>(
          QBANK_GENERATION_TASK_EVENT,
          (event) => handleTask(event.payload),
        );
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch (error) {
        debugLog.warn(
          '[useQbankGenerationTasks] Failed to listen to generation task events:',
          error,
        );
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleTask]);

  // 2) 轮询兜底（仅跟踪非终态任务）
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const inFlightTaskIds = new Set<string>();

    const getActiveTasks = () => {
      const tasks = useQbankGenerationStore.getState().tasks;
      return Object.values(tasks).filter(
        (task) => !isTerminalTaskStatus(task.status),
      );
    };

    const pollActiveTasks = () => {
      const active = getActiveTasks();
      for (const task of active) {
        if (inFlightTaskIds.has(task.id)) continue;
        inFlightTaskIds.add(task.id);

        void invoke<QbankGenerationTask | null>('qbank_get_generation_task', {
          taskId: task.id,
        })
          .then((view) => {
            if (!disposed && view) handleTask(view);
          })
          .catch((error) => {
            if (disposed) return;
            debugLog.warn(
              '[useQbankGenerationTasks] Failed to poll generation task:',
              task.id,
              error,
            );
          })
          .finally(() => {
            inFlightTaskIds.delete(task.id);
          });
      }
    };

    const stopPolling = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const syncPolling = () => {
      const hasActiveTasks = getActiveTasks().length > 0;
      if (!hasActiveTasks) {
        stopPolling();
        return;
      }
      if (timer !== null) return;

      // 立即补一次可能早于事件监听注册的状态，再以低频 interval 兜底。
      pollActiveTasks();
      timer = setInterval(pollActiveTasks, POLL_INTERVAL_MS);
    };

    const unsubscribe = useQbankGenerationStore.subscribe(syncPolling);
    syncPolling();

    return () => {
      disposed = true;
      unsubscribe();
      stopPolling();
      inFlightTaskIds.clear();
    };
  }, [handleTask]);
}
