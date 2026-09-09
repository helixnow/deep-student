/**
 * 题目集 AI 出题 - 全局任务 store（2026-09-09 后台任务化）
 *
 * 出题任务在后台执行，面板关闭 / 标签页卸载都不再中断任务；
 * 任务状态与结果由后端落库（vfs.db 的 qbank_generation_tasks 表），
 * 前端在这里维护内存镜像，由 `useQbankGenerationTasks` 常驻监听 + 轮询兜底刷新。
 */

import { create } from 'zustand';

import type { QbankGenerationTask } from '@/types/qbankGeneration';

interface QbankGenerationStoreState {
  /** task_id -> 任务视图 */
  tasks: Record<string, QbankGenerationTask>;
  /** 单个任务 upsert（事件 / 轮询 / 提交响应共用） */
  upsertTask: (task: QbankGenerationTask) => void;
  /** 批量 upsert（列表查询结果） */
  upsertTasks: (tasks: QbankGenerationTask[]) => void;
  /** 移除任务（仅前端内存，不影响后端记录） */
  removeTask: (taskId: string) => void;
}

export const useQbankGenerationStore = create<QbankGenerationStoreState>((set) => ({
  tasks: {},
  upsertTask: (task) =>
    set((state) => ({ tasks: { ...state.tasks, [task.id]: task } })),
  upsertTasks: (tasks) =>
    set((state) => {
      if (tasks.length === 0) return state;
      const next = { ...state.tasks };
      for (const task of tasks) {
        next[task.id] = task;
      }
      return { tasks: next };
    }),
  removeTask: (taskId) =>
    set((state) => {
      if (!(taskId in state.tasks)) return state;
      const next = { ...state.tasks };
      delete next[taskId];
      return { tasks: next };
    }),
}));

/** 取某题目集的任务（按创建时间倒序） */
export function selectTasksForExam(
  tasks: Record<string, QbankGenerationTask>,
  examId: string,
): QbankGenerationTask[] {
  return Object.values(tasks)
    .filter((task) => task.examId === examId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 取某题目集当前活跃（未终态）任务 */
export function selectActiveTaskForExam(
  tasks: Record<string, QbankGenerationTask>,
  examId: string,
): QbankGenerationTask | undefined {
  return selectTasksForExam(tasks, examId).find(
    (task) => task.status === 'queued' || task.status === 'running',
  );
}
