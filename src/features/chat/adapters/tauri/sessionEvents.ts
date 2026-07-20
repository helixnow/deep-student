/**
 * Session / LLM request-body event parsing helpers (pure).
 */

/** Channel names for a chat_v2 session. */
export function blockEventChannel(sessionId: string): string {
  return `chat_v2_event_${sessionId}`;
}

export function sessionEventChannel(sessionId: string): string {
  return `chat_v2_session_${sessionId}`;
}

/**
 * Whether a backend `chat_v2_llm_request_body` streamEvent belongs to this session.
 * Accepts exact match or variant-suffixed channels (`…_var_…`).
 */
export function matchesLlmRequestBodySession(
  streamEvent: string,
  sessionId: string,
): boolean {
  const prefix = blockEventChannel(sessionId);
  return streamEvent === prefix || streamEvent.startsWith(`${prefix}_`);
}

export function isSessionEventForSession(
  payloadSessionId: string | undefined,
  sessionId: string,
): boolean {
  return payloadSessionId === sessionId;
}
