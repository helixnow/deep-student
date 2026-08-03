/**
 * 文档级制卡任务控制薄门面
 *
 * 统一文档级 pause / resume / cancel 与分段级 retry 的 invoke 参数，
 * 供 Chat 块按钮与其它入口复用，避免散落硬编码命令名。
 */
import { invoke } from '@tauri-apps/api/core';

export type DocumentTaskAction = 'pause' | 'resume' | 'cancel' | 'retry';
type DocumentLevelTaskAction = Exclude<DocumentTaskAction, 'retry'>;

const COMMAND_BY_ACTION: Record<DocumentLevelTaskAction, string> = {
  pause: 'pause_document_processing',
  resume: 'resume_document_processing',
  cancel: 'cancel_document_processing',
};

export type DocumentTaskControlOptions =
  | { documentId: string; action: DocumentLevelTaskAction }
  | { taskId: string; action: 'retry' };

export async function controlDocumentTask(opts: DocumentTaskControlOptions): Promise<void> {
  if (opts.action === 'retry') {
    const taskId = opts.taskId.trim();
    if (!taskId) {
      throw new Error('taskId is required');
    }
    await invoke<void>('trigger_task_processing', { taskId });
    return;
  }

  const { documentId, action } = opts;
  if (!documentId) {
    throw new Error('documentId is required');
  }
  await invoke<void>(COMMAND_BY_ACTION[action], { documentId });
}

/**
 * 会话统计（database/mod.rs list_document_sessions）把这三种状态计入
 * failed_tasks，重试入口必须与该口径一致。
 */
export const FAILED_TASK_STATUSES = ['Failed', 'Truncated', 'Cancelled'] as const;
export type FailedTaskStatus = (typeof FAILED_TASK_STATUSES)[number];

export function isFailedTaskStatus(status: string): status is FailedTaskStatus {
  return (FAILED_TASK_STATUSES as readonly string[]).includes(status);
}

/** `get_document_tasks` 返回的 DocumentTask（snake_case，见 models.rs）的前端只读切片 */
export interface DocumentTaskSummary {
  id: string;
  status: string;
  segment_index: number;
  error_message?: string | null;
  updated_at?: string;
}

export async function getDocumentTasks(documentId: string): Promise<DocumentTaskSummary[]> {
  if (!documentId) {
    throw new Error('documentId is required');
  }
  return invoke<DocumentTaskSummary[]>('get_document_tasks', { documentId });
}

/** 拉取文档下所有「失败口径」任务（Failed / Truncated / Cancelled），带 error_message */
export async function listFailedDocumentTasks(documentId: string): Promise<DocumentTaskSummary[]> {
  const tasks = await getDocumentTasks(documentId);
  return tasks
    .filter(task => isFailedTaskStatus(task.status))
    .sort((a, b) => a.segment_index - b.segment_index);
}

export interface RetryFailedResult {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * 重试文档下全部失败任务。allSettled 避免个别失败中断其余任务；
 * total === 0 表示当前没有可重试的任务。
 */
export async function retryFailedDocumentTasks(documentId: string): Promise<RetryFailedResult> {
  const failedTasks = await listFailedDocumentTasks(documentId);
  if (failedTasks.length === 0) {
    return { total: 0, succeeded: 0, failed: 0 };
  }
  const results = await Promise.allSettled(
    failedTasks.map(task => invoke<void>('trigger_task_processing', { taskId: task.id })),
  );
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  return { total: results.length, succeeded, failed: results.length - succeeded };
}
