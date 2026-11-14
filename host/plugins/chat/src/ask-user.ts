/**
 * `chat_v2_ask_user_respond` bridge.
 * Rust source: `chat_v2/handlers/ask_user_handlers.rs` +
 * `chat_v2/tools/ask_user_executor.rs:99-137`.
 *
 * The waiting map is owned by this plugin (the executor registers a resolver
 * when it asks the user), so the command does not depend on another lane.
 */
import { ChatV2Error } from './error.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { ChatLogger } from './logger.ts';

/** `VALID_ASK_USER_SOURCES` (ask_user_handlers.rs:14-20). */
export const VALID_ASK_USER_SOURCES = [
  'user_click', 'custom_input', 'mixed', 'timeout', 'channel_closed',
] as const;
export type AskUserSource = typeof VALID_ASK_USER_SOURCES[number];

export interface AskUserResponse {
  toolCallId: string;
  selectedTexts: string[];
  selectedIndices: number[];
  customText: string | null;
  source: string;
}

export type AskUserResolver = (response: AskUserResponse) => void;

/** `PENDING_ASK_CALLBACKS` (ask_user_executor.rs:104-106). */
const pendingCallbacks = new Map<string, AskUserResolver>();

/** `register_ask_callback`: the executor calls this before emitting the block. */
export function registerAskUserCallback(toolCallId: string, resolver: AskUserResolver): () => void {
  pendingCallbacks.set(toolCallId, resolver);
  return () => {
    if (pendingCallbacks.get(toolCallId) === resolver) pendingCallbacks.delete(toolCallId);
  };
}

/** `handle_ask_user_response`: missing callbacks only warn (expiry is the executor's job). */
export function handleAskUserResponse(response: AskUserResponse, log?: ChatLogger): boolean {
  const resolver = pendingCallbacks.get(response.toolCallId);
  if (resolver === undefined) {
    log?.warn(`[AskUserExecutor] No pending callback for tool_call_id: ${response.toolCallId}`);
    return false;
  }
  pendingCallbacks.delete(response.toolCallId);
  resolver(response);
  return true;
}

/** `chat_v2_ask_user_respond` (ask_user_handlers.rs:45-82). */
export function respondToAskUser(
  request: {
    toolCallId: string;
    selectedTexts: string[];
    selectedIndices: number[];
    customText?: string | null;
    source: string;
  },
  log?: ChatLogger,
): void {
  if (rustTrim(request.toolCallId) === '') {
    throw new ChatV2Error('InvalidInput', 'tool_call_id must not be empty');
  }
  if (!(VALID_ASK_USER_SOURCES as readonly string[]).includes(request.source)) {
    // Rust `{:?}` on `[&str; 5]` renders `["a", "b", ...]` with spaces.
    const allowed = `[${VALID_ASK_USER_SOURCES.map(source => `"${source}"`).join(', ')}]`;
    throw new ChatV2Error('InvalidInput',
      `Invalid ask_user source '${request.source}'. Allowed: ${allowed}`);
  }
  log?.info('[ChatV2::ask_user] Received response: tool_call_id='
    + `${request.toolCallId}, selected=${JSON.stringify(request.selectedTexts)}, `
    + `indices=${JSON.stringify(request.selectedIndices)}, custom_text=${JSON.stringify(request.customText ?? null)}, `
    + `source='${request.source}'`);
  const response: AskUserResponse = {
    toolCallId: request.toolCallId,
    selectedTexts: request.selectedTexts,
    selectedIndices: request.selectedIndices,
    customText: request.customText ?? null,
    source: request.source,
  };
  handleAskUserResponse(response, log);
}
