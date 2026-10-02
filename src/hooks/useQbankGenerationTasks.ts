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
  isTerminalTaskStatus,
  type QbankGenerationTask,
} from '@/types/qbankGeneration';

/** 全局任务事件名（与 Rust `qbank_generation::events::QBANK_GENERATION_TASK_EVENT` 一致） */
export const QBANK_GENERATION_TASK_EVENT = 'qbank_generation_task_event';

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 30_000;

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
        showGlobalNotification(
          'success',
          t('exam_sheet:aiGeneration.taskCompleted', { count: task.drafts.length }),
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
          '[useQbankGenerationTasks] 监听出题任务事件失败:',
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
              '[useQbankGenerationTasks] 轮询任务失败:',
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
