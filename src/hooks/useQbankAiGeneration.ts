/**
 * 题目集 AI 出题 Hook（后台任务版，2026-09-09）
 *
 * 与 MVP 版本的差异：
 * - 不再监听 SSE 流式事件（后端已后台化），改为「提交任务 → 全局 store 跟踪 → 面板读结果」
 * - 不再有 180s 前端看门狗（超时由后端 120s 空闲超时 + 任务状态收敛负责）
 * - 组件卸载不再取消任务（这是后台化的核心诉求）
 *
 * 任务状态由 `useQbankGenerationTasks`（App 壳层常驻）统一刷新；
 * 本 hook 只负责「提交 / 取消 / 恢复该题目集的任务列表」。
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid';

import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useQbankGenerationStore } from '@/stores/qbankGenerationStore';
import type {
  GeneratedQuestionDraft,
  QbankGenerationRequestPayload,
  QbankGenerationTask,
} from '@/types/qbankGeneration';

// 类型从共享定义处再导出，保持既有 import 路径兼容
export type {
  GeneratedQuestionDraft,
  GeneratedQuestionOption,
  QuestionGenerationSpec,
  QbankGenerationRequestPayload,
  QbankGenerationTask,
  QbankGenerationTaskStatus,
  SkippedReference,
} from '@/types/qbankGeneration';

/** 面板关心的任务视图（无任务时为 undefined） */
export interface UseQbankAiGenerationResult {
  /** 当前跟踪的任务（提交后由 store 更新） */
  task: QbankGenerationTask | undefined;
  /** 是否正在提交（invoke 往返） */
  submitting: boolean;
  /** 提交阶段的错误（任务运行阶段的错误在 task.error） */
  submitError: string | null;
  /** 提交出题任务；返回创建的任务视图 */
  startGeneration: (
    request: Omit<QbankGenerationRequestPayload, 'stream_session_id'>,
  ) => Promise<QbankGenerationTask>;
  /** 请求取消当前任务（后端收尾后任务状态变为 cancelled） */
  cancelGeneration: () => Promise<void>;
  /** 重置面板状态（不取消任务，任务仍在后台跑） */
  resetState: () => void;
  /** 切换到某个历史任务（面板预览用） */
  selectTask: (taskId: string | null) => void;
}

export function useQbankAiGeneration(examId: string): UseQbankAiGenerationResult {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  const upsertTask = useQbankGenerationStore((state) => state.upsertTask);
  const upsertTasks = useQbankGenerationStore((state) => state.upsertTasks);
  const task = useQbankGenerationStore((state) =>
    taskId ? state.tasks[taskId] : undefined,
  );

  // 打开面板时恢复该题目集的任务列表（关闭面板/重启后仍能取回结果）
  useEffect(() => {
    if (!examId) return;
    void invoke<QbankGenerationTask[]>('qbank_list_generation_tasks', {
      examId,
      limit: 20,
    })
      .then((tasks) => {
        upsertTasks(tasks);
        // 自动跟踪最新任务，便于面板直接展示最近一次结果
        const latest = tasks[0];
        if (latest) {
          setTaskId((prev) => prev ?? latest.id);
        }
      })
      .catch((error) => {
        debugLog.warn('[useQbankAiGeneration] 恢复任务列表失败:', error);
      });
  }, [examId, upsertTasks]);

  const startGeneration = useCallback(
    async (
      request: Omit<QbankGenerationRequestPayload, 'stream_session_id'>,
    ): Promise<QbankGenerationTask> => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const view = await invoke<QbankGenerationTask>(
          'qbank_ai_generate_questions',
          {
            request: { ...request, stream_session_id: nanoid(12) },
          },
        );
        upsertTask(view);
        setTaskId(view.id);
        debugLog.info('[useQbankAiGeneration] 出题任务已提交:', view.id);
        return view;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSubmitError(message);
        debugLog.error('[useQbankAiGeneration] 提交出题任务失败:', error);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [upsertTask],
  );

  const cancelGeneration = useCallback(async () => {
    if (!taskId) return;
    try {
      const view = await invoke<QbankGenerationTask | null>(
        'qbank_cancel_generation_task',
        { taskId },
      );
      if (view) upsertTask(view);
    } catch (error) {
      debugLog.warn('[useQbankAiGeneration] 取消失题任务失败:', error);
    }
  }, [taskId, upsertTask]);

  const resetState = useCallback(() => {
    setTaskId(null);
    setSubmitError(null);
  }, []);

  const selectTask = useCallback((nextTaskId: string | null) => {
    setTaskId(nextTaskId);
  }, []);

  return {
    task,
    submitting,
    submitError,
    startGeneration,
    cancelGeneration,
    resetState,
    selectTask,
  };
}

/** 从任务草稿派生「是否还有未入库结果」 */
export function hasImportableDrafts(task: QbankGenerationTask | undefined): boolean {
  return Boolean(task && task.status === 'completed' && task.drafts.length > 0);
}

/** 便捷取草稿（面板渲染用） */
export function taskDrafts(
  task: QbankGenerationTask | undefined,
): GeneratedQuestionDraft[] {
  return task?.drafts ?? [];
}
