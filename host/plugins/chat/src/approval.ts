/**
 * Tool approval commands. Rust source: `chat_v2/handlers/approval_handlers.rs`.
 *
 * Waiting requests live in L05 `agentApproval`; the handler only decides
 * delivery, fail-closed persistence and the expiry event.
 */
import type {} from '../../agent-workspace/api.ts';
import type { ApprovalManager, ApprovalRespondResult } from '../../agent-workspace/api.ts';
import type { BackendEventsLike, EventLogger } from './events.ts';
import { BackendEventsSink, ChatV2EventEmitter, EVENT_TYPE } from './events.ts';
import { ChatV2Error } from './error.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { errorText, type ChatLogger } from './logger.ts';

export interface SettingsLike {
  save(key: string, value: string): void;
  deleteByPrefix(prefix: string): number;
}

const APPROVAL_SCOPE_PREFIX = 'tool_approval.scope.';

export type ApprovalLookup = () => ApprovalManager | undefined;

function requireManager(manager: ApprovalManager | undefined): ApprovalManager {
  if (manager === undefined) {
    throw new ChatV2Error('Other', 'ApprovalManager is not available');
  }
  return manager;
}

function commandLogger(log: ChatLogger): EventLogger {
  return {
    error: (message: string) => log.error(message),
    debug: (message: string) => log.debug(message),
  };
}

/** Emits the `approval_expired` error on `tool_approval_request`. */
function emitApprovalExpired(
  events: BackendEventsLike, sessionId: string, toolCallId: string, log: ChatLogger,
): void {
  const emitter = new ChatV2EventEmitter(
    new BackendEventsSink(events, commandLogger(log)), sessionId);
  emitter.emitError(EVENT_TYPE.TOOL_APPROVAL_REQUEST, `approval_${toolCallId}`, 'approval_expired', null);
}

/**
 * `chat_v2_tool_approval_respond` (approval_handlers.rs:39-172).
 *
 * The never-remember policy is enforced twice in Rust: the manager downgrades
 * remember flags and returns a null setting key, and the handler skips
 * persistence again. Relying on the manager's null key keeps the same
 * fail-closed persistence without duplicating L05's classifier table.
 */
export function respondToApproval(
  manager: ApprovalManager | undefined,
  settings: SettingsLike,
  events: BackendEventsLike,
  request: {
    sessionId: string; toolCallId: string; toolName: string; approved: boolean;
    reason?: string | null; remember: boolean; rememberSession?: boolean | null;
  },
  log: ChatLogger,
): void {
  if (rustTrim(request.toolCallId) === '') {
    throw new ChatV2Error('InvalidInput', 'tool_call_id must not be empty');
  }
  const approvalManager = requireManager(manager);
  const response = {
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    approved: request.approved,
    reason: request.reason ?? null,
    remember: request.remember,
    rememberSession: request.rememberSession ?? false,
  };
  const result: ApprovalRespondResult = approvalManager.respondWithResult(response);
  if (!result.delivered) {
    log.warn(`[ChatV2::approval] No waiting approval found for tool_call_id=${request.toolCallId}`);
    emitApprovalExpired(events, request.sessionId, request.toolCallId, log);
    throw new ChatV2Error('Timeout',
      `approval_expired: no waiting approval for tool_call_id=${request.toolCallId}`);
  }
  if (!request.remember) return;
  const settingKey = result.settingKey;
  if (settingKey === null) {
    // Privilege tools, spoofed tool names and session-only approvals end here.
    log.warn(`[ChatV2::approval] remember=true but no server-side setting key was available; approval choice was not persisted (tool_call_id=${request.toolCallId})`);
    return;
  }
  try {
    settings.save(settingKey, request.approved ? 'allow' : 'deny');
  } catch (error) {
    log.error(`[ChatV2::approval] Failed to persist approval choice for '${request.toolName}': ` + errorText(error));
  }
}

/** `chat_v2_tool_approval_cancel` (approval_handlers.rs:174-190). */
export function cancelApproval(manager: ApprovalManager | undefined, toolCallId: string): void {
  requireManager(manager).cancel(toolCallId);
}

/** `chat_v2_clear_approval_history` (approval_handlers.rs:192-229). */
export function clearApprovalHistory(
  manager: ApprovalManager | undefined, settings: SettingsLike, log: ChatLogger,
): number {
  manager?.clearAllRemembered();
  try {
    return settings.deleteByPrefix(APPROVAL_SCOPE_PREFIX);
  } catch (error) {
    log.error('[ChatV2::approval] clear_approval_history: delete DB entries failed: ' + errorText(error));
    throw new ChatV2Error('Database', error instanceof Error ? error.message : String(error));
  }
}
