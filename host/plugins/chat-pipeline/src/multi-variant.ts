/**
 * pipeline/multi_variant.rs — variant retry helpers.
 *
 * A retry without fresh context refs must reuse the original user canonical
 * content (stable blob hashes and ids), not a re-derived payload.
 */
import type {
  CanonicalContentPart, ChatMessage,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';

export function sourceUserCanonicalBeforeAssistant(
  messages: readonly ChatMessage[],
  assistantMessageId: string,
): CanonicalContentPart[] | null {
  const assistantIndex = messages.findIndex(message => message.id === assistantMessageId);
  if (assistantIndex < 0) return null;
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    return message._meta?.canonicalContent ?? null;
  }
  return null;
}
