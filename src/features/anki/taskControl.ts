/**
 * 文档级制卡任务控制薄门面
 *
 * 统一 pause / resume / cancel 的 invoke 参数（camelCase documentId），
 * 供 Chat 块按钮与其它入口复用，避免散落硬编码命令名。
 */
import { invoke } from '@tauri-apps/api/core';

export type DocumentTaskAction = 'pause' | 'resume' | 'cancel';

const COMMAND_BY_ACTION: Record<DocumentTaskAction, string> = {
  pause: 'pause_document_processing',
  resume: 'resume_document_processing',
  cancel: 'cancel_document_processing',
};

export async function controlDocumentTask(opts: {
  documentId: string;
  action: DocumentTaskAction;
}): Promise<void> {
  const { documentId, action } = opts;
  if (!documentId) {
    throw new Error('documentId is required');
  }
  await invoke<void>(COMMAND_BY_ACTION[action], { documentId });
}
