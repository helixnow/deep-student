export interface PromptCacheTarget {
  provider: string;
  model: string;
  protocol: string;
  baseUrl: string;
}

export interface CacheTool {
  name?: string;
  function?: { name: string; parameters?: unknown; [key: string]: unknown };
  input_schema?: unknown;
  parameters?: unknown;
  [key: string]: unknown;
}

function canonicalSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonicalSchema(item)]));
}

/** Strip native state only at a target boundary; text, calls and results remain evidence. */
function stripPrivateState(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !item || typeof item !== 'object'
    || !['thinking', 'redacted_thinking'].includes(item.type)).map(stripPrivateState);
  if (!value || typeof value !== 'object') return value;
  const block = value as Record<string, unknown>;
  // Tool payloads are evidence, not native reasoning state. Never sanitize their user data.
  if (['tool_use', 'tool_result', 'function_call', 'function_call_output'].includes(String(block.type)) || block.role === 'tool') return value;
  return Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'encrypted_content' && key !== 'signature')
    .map(([key, item]) => [key, ['content', 'output', 'input'].includes(key) ? stripPrivateState(item) : item]));
}

export interface PromptCacheRequest {
  tools?: readonly CacheTool[];
  messages?: readonly unknown[];
  input?: readonly unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export function stabilizePromptCacheRequest<T extends PromptCacheRequest>(request: T, options: {
  finalizing?: boolean;
  previousTarget?: PromptCacheTarget;
  target?: PromptCacheTarget;
} = {}): T & PromptCacheRequest {
  const result: T & PromptCacheRequest = { ...request };
  if (request.tools) {
    result.tools = [...request.tools].sort((a, b) => {
      const left = a.function?.name ?? a.name ?? '';
      const right = b.function?.name ?? b.name ?? '';
      return left < right ? -1 : left > right ? 1 : 0;
    }).map((tool) => ({ ...tool,
      ...(tool.parameters !== undefined ? { parameters: canonicalSchema(tool.parameters) } : {}),
      ...(tool.input_schema !== undefined ? { input_schema: canonicalSchema(tool.input_schema) } : {}),
      ...(tool.function ? { function: { ...tool.function,
        ...(tool.function.parameters !== undefined ? { parameters: canonicalSchema(tool.function.parameters) } : {}),
      } } : {}),
    }));
  }
  if (options.finalizing) result.tool_choice = 'none';
  const { previousTarget, target } = options;
  if (previousTarget && target && (['provider', 'model', 'protocol', 'baseUrl'] as const)
    .some((key) => previousTarget[key] !== target[key])) {
    if (request.messages) result.messages = stripPrivateState(request.messages) as unknown[];
    if (request.input) result.input = stripPrivateState(request.input) as unknown[];
  }
  return result;
}

export interface PromptCacheObservation {
  inputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  input_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null };
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  prompt_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null };
}

export function computePromptCacheHitRate(observations: readonly PromptCacheObservation[]): number | null {
  let totalInput = 0;
  let totalRead = 0;
  for (const observation of observations) {
    const read = observation.cacheReadInputTokens ?? observation.cache_read_input_tokens
      ?? observation.prompt_tokens_details?.cached_tokens ?? observation.input_tokens_details?.cached_tokens;
    // Camel-case measurements are already normalized; Anthropic raw input excludes cache read/write.
    const input = observation.inputTokens ?? (observation.input_tokens != null
      ? observation.input_tokens + (observation.cache_read_input_tokens ?? 0) + (observation.cache_creation_input_tokens ?? 0)
      : observation.prompt_tokens);
    if (input == null || read == null || !Number.isFinite(input) || !Number.isFinite(read) || input < 0 || read < 0) continue;
    totalInput += input;
    totalRead += read;
  }
  return totalInput === 0 ? null : Math.max(0, Math.min(1, totalRead / totalInput));
}

export interface CompactableMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  interrupted?: boolean;
  pendingAsk?: unknown;
}

export interface AtomicTurn<T extends CompactableMessage = CompactableMessage> {
  id: string;
  messages: T[];
  protected: boolean;
}

export const protectedRecentTurns = 2;
export const MAX_COMPACTION_BATCH_BYTES = 30_000;

/** The evaluator receives whole batches; errors/oversized turns always retain source text. */
export async function planExtractiveTurnCompaction<T extends CompactableMessage>(messages: readonly T[],
  evaluate: (turns: readonly AtomicTurn<T>[]) => Promise<Readonly<Record<string, number>>>,
) {
  const turns: AtomicTurn<T>[] = [];
  const prefix: T[] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push({ id: message.id, messages: [message], protected: false });
    else if (turns.length) turns[turns.length - 1].messages.push(message);
    else prefix.push(message);
  }
  for (const [index, turn] of turns.entries()) {
    turn.protected = index >= turns.length - protectedRecentTurns
      || turn.messages.some((message) => message.interrupted || Boolean(message.pendingAsk));
  }
  const encoder = new TextEncoder();
  const bytes = (batch: AtomicTurn<T>[]) => encoder.encode(JSON.stringify(batch)).byteLength;
  const batches: AtomicTurn<T>[][] = [];
  let batch: AtomicTurn<T>[] = [];
  // Match Jev's bounded evaluation: at most the latest 32 eligible old turns.
  for (const turn of turns.filter((item) => !item.protected).slice(-32)) {
    if (bytes([turn]) > MAX_COMPACTION_BATCH_BYTES) continue;
    if (bytes([...batch, turn]) > MAX_COMPACTION_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
    }
    batch.push(turn);
  }
  if (batch.length) batches.push(batch);
  const omitted = new Set<string>();
  // Four batches at a time, without creating an unbounded request fan-out.
  for (let index = 0; index < batches.length; index += 4) {
    await Promise.all(batches.slice(index, index + 4).map(async (items) => {
      try {
        const probabilities = await evaluate(items);
        for (const turn of items) {
          const probability = probabilities[turn.id];
          if (Number.isFinite(probability) && probability >= 0.95 && probability <= 1) omitted.add(turn.id);
        }
      } catch { /* An unavailable decision model cannot remove history. */ }
    }));
  }
  return {
    turns,
    batches,
    omittedTurnIds: turns.filter((turn) => omitted.has(turn.id)).map((turn) => turn.id),
    messages: [...prefix, ...turns.filter((turn) => !omitted.has(turn.id)).flatMap((turn) => turn.messages)],
  };
}

export type AskUserType = 'single' | 'multiple' | 'text' | 'confirm';
export interface AskUserOption { id: string; label: string }
export interface AskUserSpec {
  question: string;
  type: AskUserType;
  options: AskUserOption[];
  minSelections: number;
  maxSelections: number;
  allowCustom: boolean;
  allowSkip: boolean;
}
export type AskUserValidation = { ok: true; spec: AskUserSpec } | { ok: false; error: string };

export function validateAskUserSpec(raw: unknown): AskUserValidation {
  const fail = (error: string): AskUserValidation => ({ ok: false, error });
  if (!raw || typeof raw !== 'object') return fail('invalid_spec');
  const value = raw as Record<string, unknown>;
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  if (!question || question.length > 200) return fail('invalid_question');
  const type = (value.type ?? 'single') as AskUserType;
  if (!['single', 'multiple', 'text', 'confirm'].includes(type)) return fail('invalid_type');
  const options: AskUserOption[] = [];
  if (type === 'confirm') {
    options.push({ id: 'confirm', label: typeof value.confirmLabel === 'string' ? value.confirmLabel.trim() : 'confirm' },
      { id: 'decline', label: typeof value.declineLabel === 'string' ? value.declineLabel.trim() : 'decline' });
  } else if (type !== 'text') {
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5) return fail('invalid_options');
    for (const [index, item] of value.options.entries()) {
      const option = typeof item === 'string' ? { id: `option-${index + 1}`, label: item } : item;
      if (!option || typeof option.id !== 'string' || typeof option.label !== 'string') return fail('invalid_option');
      options.push({ id: option.id.trim(), label: option.label.trim().replace(/\s+/g, ' ') });
    }
  }
  if (options.some((option) => !option.id || !option.label || option.label.length > 60)
    || new Set(options.map((option) => option.id)).size !== options.length
    || new Set(options.map((option) => option.label)).size !== options.length) return fail('invalid_options');
  const minSelections = type === 'multiple' ? value.minSelections ?? 1 : type === 'text' ? 0 : 1;
  const maxSelections = type === 'multiple' ? value.maxSelections ?? options.length : type === 'text' ? 0 : 1;
  if (typeof minSelections !== 'number' || typeof maxSelections !== 'number'
    || !Number.isInteger(minSelections) || !Number.isInteger(maxSelections)
    || minSelections < (type === 'text' ? 0 : 1) || maxSelections < minSelections
    || maxSelections > options.length) return fail('invalid_selection_bounds');
  return { ok: true, spec: { question, type, options, minSelections, maxSelections,
    allowCustom: type !== 'confirm' && value.allowCustom !== false, allowSkip: value.allowSkip === true } };
}

export interface AskUserAnswerInput {
  status: 'answered' | 'declined' | 'skipped' | 'cancelled';
  mode: 'selection' | 'custom' | 'text';
  selectedIds?: string[];
  text?: string;
  note?: string;
}
export interface AskUserAnswer extends AskUserAnswerInput {
  selectedIds: string[];
  selectedLabels: string[];
  text: string;
  note: string;
}

export function buildAskUserAnswerEnvelope(spec: AskUserSpec, input: AskUserAnswerInput | string) {
  const matched = typeof input === 'string' ? spec.options.find((option) => option.label === input.trim()) : undefined;
  const source: AskUserAnswerInput = typeof input === 'string'
    ? { status: 'answered', mode: matched ? 'selection' : spec.type === 'text' ? 'text' : 'custom',
      selectedIds: matched ? [matched.id] : [], text: matched ? '' : input }
    : input;
  if (!['answered', 'declined', 'skipped', 'cancelled'].includes(source.status)
    || !['selection', 'custom', 'text'].includes(source.mode)) throw new Error('invalid_answer');
  const answer: AskUserAnswer = { status: source.status, mode: source.mode,
    selectedIds: [...(source.selectedIds ?? [])], selectedLabels: [], text: (source.text ?? '').trim(), note: (source.note ?? '').trim() };
  if (answer.text.length > 4000 || answer.note.length > 2000) throw new Error('answer_too_long');
  if (answer.status === 'cancelled' || answer.status === 'skipped') {
    if (answer.status === 'skipped' && !spec.allowSkip) throw new Error('skip_not_allowed');
    Object.assign(answer, { mode: 'text', selectedIds: [], selectedLabels: [], text: '', note: '' });
  } else if (answer.mode === 'selection') {
    const selected = answer.selectedIds.map((id) => spec.options.find((option) => option.id === id));
    if (spec.type === 'text' || selected.some((option) => !option)
      || new Set(answer.selectedIds).size !== selected.length
      || selected.length < spec.minSelections || selected.length > spec.maxSelections) throw new Error('invalid_selection');
    answer.selectedLabels = selected.map((option) => option!.label);
    answer.text = '';
    const declined = spec.type === 'confirm' && answer.selectedIds[0] === 'decline';
    if (source.status === 'declined' && !declined) throw new Error('invalid_decline');
    answer.status = declined ? 'declined' : 'answered';
  } else {
    if (source.status === 'declined' || spec.type === 'confirm'
      || (spec.type !== 'text' && !spec.allowCustom) || !answer.text) throw new Error('invalid_custom_answer');
    answer.mode = spec.type === 'text' ? 'text' : 'custom';
    answer.selectedIds = [];
    answer.status = 'answered';
  }
  const picked = answer.status === 'skipped' || answer.status === 'cancelled' ? answer.status
    : [answer.mode === 'selection' ? answer.selectedLabels.join('、') : answer.text, answer.note].filter(Boolean).join('\n');
  return { answer, picked, toolResult: JSON.stringify(answer) };
}
