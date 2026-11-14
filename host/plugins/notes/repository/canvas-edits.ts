// chat_v2/tools/canvas_executor.rs: pending ACK/result callbacks for frontend
// delegation. The chat executor that awaits these callbacks is not yet migrated;
// the registry is kept here because the callback commands belong to L10.
import type { CanvasAIEditResult } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { notesLog } from './log.ts';

type AckSender = () => void;
type ResultSender = (result: CanvasAIEditResult) => void;

const pendingAcks = new Map<string, AckSender>();
const pendingResults = new Map<string, ResultSender>();

export function registerEditAck(requestId: string, sender: AckSender): void {
  pendingAcks.set(requestId, sender);
}

export function registerEditResult(requestId: string, sender: ResultSender): void {
  pendingResults.set(requestId, sender);
}

export function removePending(requestId: string): void {
  pendingAcks.delete(requestId);
  pendingResults.delete(requestId);
}

export function handleEditAck(requestId: string): void {
  const sender = pendingAcks.get(requestId);
  if (sender === undefined) {
    notesLog.warn(`[CanvasToolExecutor] No pending ACK for request_id: ${requestId}`);
    return;
  }
  pendingAcks.delete(requestId);
  sender();
}

export function handleEditResult(result: CanvasAIEditResult): void {
  const sender = pendingResults.get(result.requestId);
  if (sender === undefined) {
    notesLog.warn(`[CanvasToolExecutor] No pending callback for request_id: ${result.requestId}`);
    return;
  }
  pendingResults.delete(result.requestId);
  sender(result);
}

/** Reset for tests and plugin disposal. */
export function clearPending(): void {
  pendingAcks.clear();
  pendingResults.clear();
}
