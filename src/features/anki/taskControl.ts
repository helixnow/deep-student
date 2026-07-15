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
