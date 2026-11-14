/**
 * Plan-mode gate responses. Rust source: `chat_v2/handlers/manage_session.rs:2185-2218`.
 *
 * Waiting plan gates live in L03 `chatPipeline` (`planGateManager`); this
 * command only delivers the response and reports whether one was waiting.
 */
import type { PlanGateManager } from '../../chat-pipeline/api.ts';
import { ChatV2Error } from './error.ts';

export interface PlanGateRespondRequest {
  sessionId: string;
  planId: string;
  toolCallId: string;
  approved: boolean;
  reason?: string | null;
}

/** `chat_v2_plan_gate_respond` (manage_session.rs:2185-2218). */
export function planGateRespondAction(
  manager: PlanGateManager | undefined, request: PlanGateRespondRequest,
): void {
  if (manager === undefined) {
    throw new ChatV2Error('Other', 'PlanGateManager is not available');
  }
  const response = {
    sessionId: request.sessionId,
    planId: request.planId,
    toolCallId: request.toolCallId,
    approved: request.approved,
    ...(request.reason === null || request.reason === undefined ? {} : { reason: request.reason }),
  };
  const delivered = manager.respond(response);
  if (!delivered) {
    // `plan_gate_expired` stays a literal prefix for old callers that match on it.
    throw new ChatV2Error('Timeout',
      `plan_gate_expired: no waiting plan gate for tool_call_id=${request.toolCallId}`);
  }
}
