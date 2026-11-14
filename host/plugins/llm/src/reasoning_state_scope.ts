import type { ProtocolConfigLike } from './protocol.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';

/** Portable deterministic fingerprint; never includes endpoint text in persisted state. */
export function reasoningScopeHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function endpointIdentity(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    // Credentials and fragments do not identify an API endpoint. Preserve path case.
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    // Virtual/local targets need the same stable binding without URL parsing.
    if (error instanceof TypeError) return trimmed;
    throw error;
  }
}

/** Serialized provider / endpoint fingerprint / model / effective-protocol tuple. */
export function computeReasoningStateScope(config: ProtocolConfigLike): string {
  const provider = (config.providerType?.trim() || config.providerScope?.trim() || '').toLowerCase();
  return JSON.stringify([provider, reasoningScopeHash(endpointIdentity(config.baseUrl)),
    config.model.trim().toLowerCase(), effectiveApiProtocolForConfig(config)]);
}

export function canReplayReasoningState(savedScope: unknown, targetConfig: ProtocolConfigLike): boolean {
  return typeof savedScope === 'string' && savedScope === computeReasoningStateScope(targetConfig);
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Gateways often emit several aliases for the same text. Pick one, never concatenate them. */
export function pickCanonicalReasoningText(payload: unknown): string {
  if (!record(payload)) return '';
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text', 'summary_text']) {
    const text = payload[key];
    if (typeof text === 'string' && text.trim() !== '') return text;
  }
  return '';
}

function visibleReasoning(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleReasoning).filter(Boolean).join('\n\n');
  if (!record(value)) return '';
  const canonical = pickCanonicalReasoningText(value);
  if (canonical) return canonical;
  if (value.type === 'thinking' && typeof value.thinking === 'string') return value.thinking;
  if (['reasoning.text', 'summary_text', 'reasoning_text'].includes(String(value.type))
    && typeof value.text === 'string') return value.text;
  if (value.type === 'reasoning.summary' && typeof value.summary === 'string') return value.summary;
  return ['items', 'summary', 'content', 'reasoning_details'].map(key => visibleReasoning(value[key]))
    .filter(Boolean).join('\n\n');
}

function stripPrivateState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateState).filter(item => item !== undefined);
  if (!record(value)) return value;
  if (value.type === 'redacted_thinking' || value.type === 'reasoning.encrypted') return undefined;
  if (value.type === 'thinking') return { type: 'text', text: typeof value.thinking === 'string' ? value.thinking : '' };
  if (value.type === 'reasoning') {
    const text = visibleReasoning(value);
    return text ? { type: 'text', text } : undefined;
  }
  const result: RecordValue = {};
  for (const [key, item] of Object.entries(value)) {
    if (['providerState', 'stateScope', 'signature', 'thinking_signature', 'thought_signature',
      'thoughtSignature', 'encrypted_content', 'extra_content', 'reasoning_details', 'redacted_thinking'].includes(key)) continue;
    // Do not rewrite user tool arguments/schema or application data inside tool inputs.
    result[key] = ['content', 'parts', 'items', 'output', 'tool_calls'].includes(key)
      ? stripPrivateState(item) : item;
  }
  return result;
}

/** Missing scope is not replay authorization. Returns copies only for incompatible messages. */
export function sanitizeHistoryReasoningForTarget<T extends object>(
  messages: readonly T[], targetConfig: ProtocolConfigLike,
): T[] {
  return messages.map(message => {
    const source = message as RecordValue;
    const state = record(source.providerState) ? source.providerState : undefined;
    if (canReplayReasoningState(source.stateScope ?? state?.stateScope, targetConfig)) return message;
    const result = stripPrivateState(source) as RecordValue;
    const text = pickCanonicalReasoningText(source) || visibleReasoning(state) || visibleReasoning(source.reasoning_details);
    if (text) result.reasoning_content = text;
    return result as T;
  });
}

export interface DeduplicatedReasoning {
  reasoning_content: string;
  reasoning_details: RecordValue[];
}

/** Merge ordered delta/done/snapshot payloads. Explicit `mode: 'snapshot'` also
 * supports JSON completion snapshots; detail identity is index + type + id. */
export function deduplicateReasoningChunks(chunks: readonly unknown[]): DeduplicatedReasoning {
  const texts = new Map<string, string>();
  const details = new Map<string, RecordValue>();
  const mergeText = (key: string, text: string, snapshot: boolean): void => {
    const previous = texts.get(key) ?? '';
    texts.set(key, snapshot ? (text.startsWith(previous) ? text : previous || text) : previous + text);
  };
  const mergeDetail = (detail: unknown, snapshot: boolean): void => {
    if (!record(detail)) return;
    const key = JSON.stringify([detail.index ?? 0, detail.type ?? '', detail.id ?? null]);
    const previous = details.get(key);
    const next = { ...previous, ...detail };
    for (const field of ['text', 'summary', 'data', 'signature']) {
      if (typeof detail[field] !== 'string' || !previous) continue;
      const prior = typeof previous[field] === 'string' ? previous[field] as string : '';
      next[field] = snapshot ? (detail[field].startsWith(prior) ? detail[field] : prior || detail[field]) : prior + detail[field];
    }
    details.set(key, next);
  };
  const visit = (chunk: unknown, forceSnapshot = false): void => {
    if (!record(chunk)) return;
    const type = String(chunk.type ?? '');
    const snapshot = forceSnapshot || chunk.mode === 'snapshot' || /(?:\.done|\.completed)$/.test(type);
    const key = `${chunk.output_index ?? 0}:${chunk.summary_index ?? chunk.content_index ?? 0}`;
    const text = pickCanonicalReasoningText(chunk)
      || (type.includes('reasoning') && typeof chunk.delta === 'string' ? chunk.delta : '')
      || (type.includes('reasoning') && typeof chunk.text === 'string' ? chunk.text : '');
    if (text) mergeText(key, text, snapshot);
    if (Array.isArray(chunk.reasoning_details)) chunk.reasoning_details.forEach(detail => mergeDetail(detail, snapshot));
    if (record(chunk.delta)) visit(chunk.delta);
    if (record(chunk.message)) visit(chunk.message, true);
    if (Array.isArray(chunk.choices)) chunk.choices.forEach(choice => visit(choice));
    const output = record(chunk.response) ? chunk.response.output : chunk.output;
    const items = Array.isArray(output) ? output : record(chunk.item) ? [chunk.item] : [];
    items.forEach((item, index) => {
      if (!record(item) || item.type !== 'reasoning') return;
      const parts = [...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : [])];
      parts.forEach((part, partIndex) => {
        if (record(part) && typeof part.text === 'string') mergeText(`${chunk.output_index ?? index}:${partIndex}`, part.text, true);
      });
    });
  };
  chunks.forEach(chunk => visit(chunk));
  // Details are a fallback display channel, not a second copy of canonical aliases.
  return { reasoning_content: [...texts.values()].join('\n\n') || visibleReasoning([...details.values()]),
    reasoning_details: [...details.values()] };
}
