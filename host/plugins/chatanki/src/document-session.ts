// Rust: chatanki_executor.rs:7284–7385 (placeholder terminal sessions).
const randomUUID = () => globalThis.crypto.randomUUID();
import type { ChatAnkiDocumentTaskRepository, DocumentTask } from '../api.ts';
import { errorText } from './execution.ts';
import { now } from '../../../platform/time/index.ts';

function placeholderTask(
  documentId: string, documentName: string, errorMessage: string,
  status: DocumentTask['status'],
): DocumentTask {
  const timestamp = now().rfc3339;
  return {
    id: randomUUID(),
    document_id: documentId,
    original_document_name: documentName,
    segment_index: 0,
    content_segment: '',
    status,
    created_at: timestamp,
    updated_at: timestamp,
    error_message: errorMessage,
    anki_generation_options_json: '{}',
  };
}

function insertPlaceholder(
  repo: ChatAnkiDocumentTaskRepository,
  documentId: string,
  sessionId: string,
  documentName: string,
  task: DocumentTask,
  noun: string,
): void {
  try { repo.insertDocumentTask(task); }
  catch (caught) { throw new Error(`failed to insert placeholder ${noun} task: ${errorText(caught)}`); }
  try { repo.setDocumentSessionSource(documentId, sessionId); }
  catch (caught) {
    throw new Error(
      `failed to set source_session_id for ${noun} placeholder task: ${errorText(caught)}`,
    );
  }
}

/**
 * 管线在任务落库前失败：插入一条 Failed 占位任务，让 status/wait 收敛为 failed。
 * 已存在任务行优先，绝不注入占位失败。
 */
export function ensureFailedDocumentSession(
  repo: ChatAnkiDocumentTaskRepository,
  documentId: string,
  sessionId: string,
  documentName: string,
  errorMessage: string,
): void {
  let existing: DocumentTask[];
  try { existing = repo.getTasksForDocument(documentId); }
  catch (caught) {
    throw new Error(
      `failed to check existing tasks for document ${documentId}: ${errorText(caught)}`,
    );
  }
  if (existing.length > 0) return;
  insertPlaceholder(
    repo, documentId, sessionId, documentName,
    placeholderTask(documentId, documentName, errorMessage, 'Failed'),
    'failed',
  );
}

/** 取消语义贯通：管线在任务落库前被取消时插入 Cancelled 占位任务。 */
export function ensureCancelledDocumentSession(
  repo: ChatAnkiDocumentTaskRepository,
  documentId: string,
  sessionId: string,
  documentName: string,
): void {
  let existing: DocumentTask[];
  try { existing = repo.getTasksForDocument(documentId); }
  catch (caught) {
    throw new Error(
      `failed to check existing tasks for document ${documentId}: ${errorText(caught)}`,
    );
  }
  if (existing.length > 0) return;
  insertPlaceholder(
    repo, documentId, sessionId, documentName,
    placeholderTask(documentId, documentName, 'PIPELINE_CANCELLED_BY_CONTROLLER', 'Cancelled'),
    'cancelled',
  );
}
