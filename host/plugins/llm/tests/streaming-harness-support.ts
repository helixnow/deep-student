/**
 * Test-only stream fixture driver, matching Rust's cfg(test) streaming_harness
 * (`llm_manager/adapters/streaming_harness.rs`).
 *
 * `RequestAdapter::id()` -> provider stream parser, matching the
 * `model2_pipeline` routing rule: Anthropic/Claude adapters parse the Messages
 * SSE format, Google/Gemini parse `generateContent` chunks, and every other
 * adapter consumes the OpenAI-compatible protocol.
 */
import {
  AnthropicAdapter, GeminiAdapter, OpenAIAdapter,
  type JsonValue, type ProviderAdapter, type StreamEvent,
} from '../../llm-providers/api.ts';

export function parserForAdapterId(adapterId: string): ProviderAdapter {
  switch (adapterId) {
    case 'anthropic':
    case 'claude':
      return new AnthropicAdapter();
    case 'google':
    case 'gemini':
      return new GeminiAdapter();
    default:
      return new OpenAIAdapter();
  }
}

/**
 * Feeds a fixture line by line, exactly like a live SSE socket. Non-`data:`
 * lines (`event:`, `: heartbeat`, blank separators) are ignored by the
 * parsers themselves.
 */
export function driveParser(parser: ProviderAdapter, fixture: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of fixture.split('\n')) events.push(...parser.parseStream(line));
  return events;
}

export function collectContent(events: StreamEvent[]): string {
  const parts: string[] = [];
  for (const event of events) if (event.type === 'ContentChunk') parts.push(event.value);
  return parts.join('');
}

export function collectReasoning(events: StreamEvent[]): string {
  const parts: string[] = [];
  for (const event of events) if (event.type === 'ReasoningChunk') parts.push(event.value);
  return parts.join('');
}

export function collectToolCalls(events: StreamEvent[]): JsonValue[] {
  const calls: JsonValue[] = [];
  for (const event of events) if (event.type === 'ToolCall') calls.push(event.value);
  return calls;
}

export interface AggregatedToolCall {
  id: string;
  name: string;
  argumentsText: string;
  parsedArguments: JsonValue | null;
}

function field(value: JsonValue, key: string): JsonValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value[key]
    : undefined;
}

/**
 * Rebuilds one tool call from streamed deltas: first non-empty name/id wins,
 * every `function.arguments` fragment is concatenated (OpenAI splits JSON,
 * Anthropic/Gemini emit it whole).
 */
export function aggregateToolCalls(calls: JsonValue[]): AggregatedToolCall | null {
  if (calls.length === 0) return null;
  let id = '';
  let name = '';
  let argumentsText = '';
  for (const call of calls) {
    if (name === '') {
      const candidate = field(field(call, 'function') ?? null, 'name');
      if (typeof candidate === 'string' && candidate !== '') name = candidate;
    }
    if (id === '') {
      const candidate = field(call, 'id');
      if (typeof candidate === 'string' && candidate !== '') id = candidate;
    }
    const args = field(field(call, 'function') ?? null, 'arguments');
    if (typeof args === 'string') argumentsText += args;
  }
  let parsedArguments: JsonValue | null = null;
  try {
    parsedArguments = JSON.parse(argumentsText.trim()) as JsonValue;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { id, name, argumentsText, parsedArguments };
}
