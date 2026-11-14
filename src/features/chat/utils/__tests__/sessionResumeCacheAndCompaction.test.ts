import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_LIST_CACHE_STORAGE_KEY, MODEL_LIST_CACHE_TTL_MS, ModelListCacheStore,
  normalizeProviderBaseUrl, buildInterruptedMessage, buildContinuationPayload,
  CONTINUE_INSTRUCTION, appendContinuationDelta, resolveRetryOrForkAction,
  ParkedSessionViewManager, type ResumableMessage,
} from '../modelListCacheAndResume';
import {
  stabilizePromptCacheRequest, computePromptCacheHitRate, planExtractiveTurnCompaction,
  validateAskUserSpec, buildAskUserAnswerEnvelope, MAX_COMPACTION_BATCH_BYTES,
  type CompactableMessage, type AskUserSpec, type PromptCacheTarget, type AtomicTurn,
} from '../promptCacheAndTurnCompaction';

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, data };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('endpoint-scoped local model lists', () => {
  it('normalizes endpoints, persists only IDs and time, and never confuses reused provider IDs', () => {
    const storage = memoryStorage();
    const store = new ModelListCacheStore(storage, () => 10);
    expect(normalizeProviderBaseUrl(' https://one/v1/// ')).toBe('https://one/v1');
    store.write(' https://one/v1/// ', ['model-one']);
    expect(store.read('https://one/v1/')).toEqual({ ids: ['model-one'], updatedAt: 10, stale: false });
    expect(store.read('https://two/v1')).toBeNull();
    const raw = JSON.parse(storage.getItem(MODEL_LIST_CACHE_STORAGE_KEY)!);
    expect(raw).toEqual([['https://one/v1', { ids: ['model-one'], updatedAt: 10 }]]);
    expect(new ModelListCacheStore(storage, () => 20).read('https://one/v1')?.ids).toEqual(['model-one']);
    const copy = store.read('https://one/v1')!;
    copy.ids.push('not-persisted');
    expect(store.read('https://one/v1')?.ids).toEqual(['model-one']);
    store.evictByBaseUrl('https://one/v1//');
    expect(store.read('https://one/v1')).toBeNull();
  });

  it('fills synchronously and refreshes only expired/missing entries, deduplicating endpoints', async () => {
    let now = 0;
    const store = new ModelListCacheStore(memoryStorage(), () => now);
    store.write('https://old', ['old']);
    now = MODEL_LIST_CACHE_TTL_MS;
    store.write('https://fresh', []);
    const fetchModels = vi.fn(async (_baseUrl: string) => ['new']);
    const candidates = store.openSettings(['https://old/', 'https://old', 'https://fresh', 'https://missing'], fetchModels);
    expect(candidates.get('https://old')?.ids).toEqual(['old']);
    expect(candidates.get('https://old')?.stale).toBe(true);
    expect(candidates.get('https://fresh')?.ids).toEqual([]);
    expect(candidates.get('https://missing')).toBeNull();
    expect(fetchModels).not.toHaveBeenCalled();
    await store.waitForRefreshes();
    expect(fetchModels.mock.calls.map((call) => call[0])).toEqual(['https://old', 'https://missing']);
    expect(store.read('https://old')?.ids).toEqual(['new']);
  });

  it('silently retains stale results on failure and cannot resurrect an evicted endpoint', async () => {
    const store = new ModelListCacheStore(memoryStorage(), () => 1, 0);
    store.write('https://old', ['old']);
    store.openSettings(['https://old'], async () => { throw new Error('offline'); });
    await expect(store.waitForRefreshes()).resolves.toBeUndefined();
    expect(store.read('https://old')?.ids).toEqual(['old']);
    const pending = deferred<string[]>();
    store.openSettings(['https://old'], () => pending.promise);
    const done = store.waitForRefreshes();
    store.evictByBaseUrl('https://old');
    pending.resolve(['late']);
    await done;
    expect(store.read('https://old')).toBeNull();
  });

  it('handles unavailable/malformed storage and strips unrecognized persisted credential fields', () => {
    const storage = memoryStorage();
    storage.setItem(MODEL_LIST_CACHE_STORAGE_KEY, JSON.stringify([['url', { ids: ['a'], updatedAt: 1, apiKey: 'secret' }]]));
    const store = new ModelListCacheStore(storage, () => 2);
    store.write('other', ['b']);
    expect(storage.getItem(MODEL_LIST_CACHE_STORAGE_KEY)).not.toContain('secret');
    storage.setItem(MODEL_LIST_CACHE_STORAGE_KEY, 'not-json');
    expect(new ModelListCacheStore(storage).read('url')).toBeNull();
    const unavailable = { getItem: () => { throw new Error('unavailable'); }, setItem: () => { throw new Error('full'); } };
    const memory = new ModelListCacheStore(unavailable);
    memory.write('url', ['a']);
    expect(memory.read('url')?.ids).toEqual(['a']);
  });
});

const history: ResumableMessage[] = [
  { id: 'u1', role: 'user', content: 'question' },
  { id: 'a1', role: 'assistant', content: 'partial', reasoning: 'thinking' },
];

describe('interruption, continuation and explicit forks', () => {
  it('preserves content and reasoning in a persistable row without inserting failure prose', () => {
    const interrupted = buildInterruptedMessage(history[1], 'connection reset');
    expect(interrupted).toEqual({ ...history[1], interrupted: true, interruptReason: 'connection reset' });
    expect(JSON.parse(JSON.stringify(interrupted)).reasoning).toBe('thinking');
    expect(buildInterruptedMessage(history[1], 'abort', true)).toEqual(history[1]);
    expect(history[1].interrupted).toBeUndefined();
  });

  it('does not duplicate the prior prompt, disables tools, and appends to the original row', () => {
    const row = buildInterruptedMessage(history[1], 'offline');
    const payload = buildContinuationPayload('system', [history[0], row]);
    expect(payload.tools).toEqual([]);
    expect(payload.messages).toEqual([{ role: 'system', content: 'system' },
      { role: 'user', content: 'question' }, { role: 'assistant', content: 'partial' },
      { role: 'user', content: CONTINUE_INSTRUCTION }]);
    const delta = appendContinuationDelta(row, '-more', '-more-thinking');
    expect(delta.interrupted).toBe(true);
    const completed = appendContinuationDelta(delta, '-end', '', true);
    expect(completed.id).toBe('a1');
    expect(completed.content).toBe('partial-more-end');
    expect(completed.reasoning).toBe('thinking-more-thinking');
    expect(completed).not.toHaveProperty('interrupted');
    expect(completed).not.toHaveProperty('interruptReason');
    expect(row.content).toBe('partial');
  });

  it('routes interrupted, last complete and historical messages without mutating history', () => {
    expect(resolveRetryOrForkAction([history[0], buildInterruptedMessage(history[1], 'offline')], 'a1'))
      .toEqual({ action: 'continue_interrupted', messageId: 'a1' });
    expect(resolveRetryOrForkAction(history, 'a1')).toEqual({ action: 'regenerate_last', userPromptMessageId: 'u1', assistantMessageId: 'a1' });
    const later: ResumableMessage[] = [...history, { id: 'u2', role: 'user', content: 'next' }, { id: 'a2', role: 'assistant', content: 'done' }];
    expect(resolveRetryOrForkAction(later, 'a1')).toEqual({ action: 'require_fork', forkUpToMessageId: 'a1' });
    expect(resolveRetryOrForkAction(later.slice(0, -1), 'a1').action).toBe('require_fork');
    expect(later).toHaveLength(4);
    expect(() => resolveRetryOrForkAction(history, 'missing')).toThrow('invalid_assistant_message');
    expect(() => resolveRetryOrForkAction(history, 'u1')).toThrow();
    expect(() => resolveRetryOrForkAction([history[1]], 'a1')).toThrow('missing_user_prompt');
  });
});

describe('parked per-session views', () => {
  const empty = () => ({ messages: [] as string[], queued: [] as string[], pendingAsk: null as string | null, loading: false });

  it('keeps concurrent streams, queue and cards isolated and restores resident views without DB reads', async () => {
    const manager = new ParkedSessionViewManager('a', empty, empty());
    manager.runningIds = ['a'];
    manager.writeView('a', { messages: ['partial-a'], queued: ['followup-a'], pendingAsk: 'ask-a', loading: true });
    const load = vi.fn(async () => empty());
    await manager.switchSession('b', load);
    expect(manager.readView('b')).toEqual(empty());
    expect(manager.canMutateSessionLifecycle('a')).toBe(false);
    expect(manager.canMutateSessionLifecycle('b')).toBe(true);
    expect(manager.shouldClearDraftOnSend('a')).toBe(false);
    expect(manager.shouldClearDraftOnSend('b')).toBe(true);
    manager.runningIds = ['a', 'b'];
    manager.writeView('b', { messages: ['partial-b'], loading: true });
    manager.writeView('a', { messages: ['partial-a', 'delta-a'] });
    await manager.switchSession('a', load);
    expect(manager.readView('a')).toEqual({ messages: ['partial-a', 'delta-a'], queued: ['followup-a'], pendingAsk: 'ask-a', loading: true });
    expect(manager.readView('b').messages).toEqual(['partial-b']);
    expect(load).toHaveBeenCalledTimes(1);
    manager.runningIds = ['b'];
    expect(manager.canMutateSessionLifecycle('a')).toBe(true);
  });

  it('parks late DB results and merges stream patches without overwriting the current session', async () => {
    const manager = new ParkedSessionViewManager('a', empty, empty());
    const pending = deferred<ReturnType<typeof empty>>();
    const load = vi.fn(() => pending.promise);
    const first = manager.switchSession('b', load);
    const again = manager.switchSession('b', load);
    manager.writeView('b', { messages: ['live-b'] });
    await manager.switchSession('a', load);
    pending.resolve({ ...empty(), messages: ['db-b'], queued: ['db-queue'] });
    await Promise.all([first, again]);
    expect(manager.activeSessionKey).toBe('a');
    expect(manager.readView('a').messages).toEqual([]);
    expect(manager.readView('b').messages).toEqual(['live-b']);
    expect(manager.readView('b').queued).toEqual(['db-queue']);
    expect(load).toHaveBeenCalledTimes(1);
    await manager.switchSession('b', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('allows a failed DB load to be retried', async () => {
    const manager = new ParkedSessionViewManager('a', empty);
    await expect(manager.switchSession('b', async () => { throw new Error('db'); })).rejects.toThrow('db');
    await manager.switchSession('b', async () => ({ ...empty(), messages: ['retried'] }));
    expect(manager.readView('b').messages).toEqual(['retried']);
  });
});

describe('stable prompt/KV prefixes', () => {
  const target: PromptCacheTarget = { provider: 'p', model: 'm', protocol: 'anthropic', baseUrl: 'https://one' };
  const tools = [{ function: { name: 'z', parameters: { z: 1, properties: { b: { z: 2, a: 1 }, a: {} }, required: ['z', 'a'] } } },
    { name: 'a', input_schema: { z: 1, a: 2 } }];

  it('sorts names and recursive schema keys, preserves message text and array order, and keeps the final tool prefix', () => {
    const messages = [{ role: 'user', content: '  literal\n text  ', arguments: { z: 1, a: 2 } }];
    const first = stabilizePromptCacheRequest({ tools, messages });
    const final = stabilizePromptCacheRequest({ tools: [...tools].reverse(), messages }, { finalizing: true });
    expect(JSON.stringify(first.tools)).toBe(JSON.stringify(final.tools));
    expect(final.tool_choice).toBe('none');
    expect(first.messages).toBe(messages);
    expect(first.tools?.[0].name).toBe('a');
    const schema = first.tools?.[1].function?.parameters as NonNullable<typeof tools[0]['function']>['parameters'];
    expect(Object.keys(schema)).toEqual(['properties', 'required', 'z']);
    expect(Object.keys(schema.properties.b)).toEqual(['a', 'z']);
    expect(schema.required).toEqual(['z', 'a']);
    expect(Object.keys(tools[0].function!.parameters!)).toEqual(['z', 'properties', 'required']);
  });

  it.each(['provider', 'model', 'protocol', 'baseUrl'] as const)('strips incompatible native state when %s changes but keeps tool evidence', (key) => {
    const messages = [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'secret', signature: 'sig' },
      { type: 'redacted_thinking', data: 'private' }, { type: 'text', text: 'answer' },
      { type: 'tool_use', input: { signature: 'user-data', encrypted_content: 'evidence' } },
    ] }, { role: 'tool', content: { signature: 'evidence' } }];
    const input = [{ type: 'reasoning', encrypted_content: 'encrypted', summary: ['summary'] }, { type: 'function_call_output', output: 'result' }];
    const same = stabilizePromptCacheRequest({ messages, input }, { target, previousTarget: target });
    expect(same.messages).toBe(messages);
    const switched = stabilizePromptCacheRequest({ messages, input }, { previousTarget: target, target: { ...target, [key]: 'different' } });
    expect(switched.messages![0].content).toEqual((messages[0].content as unknown[]).slice(2));
    expect(switched.messages![1]).toEqual(messages[1]);
    expect(switched.input).toEqual([{ type: 'reasoning', summary: ['summary'] }, input[1]]);
    expect(input[0].encrypted_content).toBe('encrypted');
  });

  it('normalizes Anthropic total input and weights only observations with both measurements', () => {
    expect(computePromptCacheHitRate([{ input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 },
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 20 } }, { inputTokens: 1000 }, { cacheReadInputTokens: 999 }])).toBe(0.4);
    expect(computePromptCacheHitRate([{ inputTokens: 100, cacheReadInputTokens: 50, cache_read_input_tokens: 50 }])).toBe(0.5);
    expect(computePromptCacheHitRate([{ input_tokens: 100, input_tokens_details: { cached_tokens: 60 } }])).toBe(0.6);
    expect(computePromptCacheHitRate([{ inputTokens: 0, cacheReadInputTokens: 0 }])).toBeNull();
    expect(computePromptCacheHitRate([])).toBeNull();
    expect(computePromptCacheHitRate([{ inputTokens: 10, cacheReadInputTokens: 0 }])).toBe(0);
    expect(computePromptCacheHitRate([{ inputTokens: NaN, cacheReadInputTokens: 3 }])).toBeNull();
  });
});

function turn(index: number, content = 'content'): CompactableMessage[] {
  return [{ id: `u${index}`, role: 'user', content }, { id: `a${index}`, role: 'assistant', content: `answer-${index}` },
    { id: `t${index}`, role: 'tool', content: `result-${index}` }];
}

describe('extractive atomic-turn compaction', () => {
  it('protects recent two turns, pending questions and interruptions, omitting only at the inclusive threshold', async () => {
    const messages = [ ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5), ...turn(6), ...turn(7) ];
    messages[7].interrupted = true;
    messages[10].pendingAsk = { question: 'pending' };
    const evaluate = vi.fn(async (_batch: readonly AtomicTurn[]) => ({ u1: 0.95, u2: 0.9499, u3: 1, u4: 1, u5: 0.99, u6: 1, u7: 1 }));
    const plan = await planExtractiveTurnCompaction(messages, evaluate);
    expect(plan.omittedTurnIds).toEqual(['u1', 'u5']);
    expect(plan.messages.map((message) => message.id)).toEqual([...turn(2), ...turn(3), ...turn(4), ...turn(6), ...turn(7)].map((message) => message.id));
    expect(evaluate.mock.calls[0][0].map((item) => item.id)).toEqual(['u1', 'u2', 'u5']);
    expect(plan.turns.every((item) => item.messages.length === 3)).toBe(true);
    expect(messages).toHaveLength(21);
  });

  it('uses UTF-8 whole-batch size, skips oversized turns without truncation, and keeps order', async () => {
    const messages = [...turn(1, '汉'.repeat(11_000)), ...turn(2, '汉'.repeat(5000)), ...turn(3, '汉'.repeat(5000)), ...turn(4), ...turn(5)];
    const plan = await planExtractiveTurnCompaction(messages, async (batch) => Object.fromEntries(batch.map((item) => [item.id, 1])));
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches.every((batch) => new TextEncoder().encode(JSON.stringify(batch)).length <= MAX_COMPACTION_BATCH_BYTES)).toBe(true);
    expect(plan.omittedTurnIds).toEqual(['u2', 'u3']);
    expect(plan.messages[0].content).toBe('汉'.repeat(11_000));
  });

  it('preserves prefix messages and falls back on evaluation failures or unknown probabilities', async () => {
    const messages: CompactableMessage[] = [{ id: 's', role: 'system', content: 'rules' }, ...turn(1), ...turn(2), ...turn(3)];
    const failed = await planExtractiveTurnCompaction(messages, async () => { throw new Error('offline'); });
    expect(failed.messages).toEqual(messages);
    const unknown = await planExtractiveTurnCompaction(messages, async () => ({ u1: NaN }));
    expect(unknown.omittedTurnIds).toEqual([]);
    const evaluate = vi.fn(async () => ({}));
    await planExtractiveTurnCompaction(turn(1), evaluate);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('evaluates only the latest 32 old turns', async () => {
    const plan = await planExtractiveTurnCompaction(Array.from({ length: 40 }, (_, index) => turn(index)).flat(),
      async (batch) => Object.fromEntries(batch.map((item) => [item.id, 1])));
    expect(plan.omittedTurnIds).toHaveLength(32);
    expect(plan.omittedTurnIds[0]).toBe('u6');
    expect(plan.messages.map((message) => message.id)).toContain('u0');
  });
});

function spec(raw: unknown): AskUserSpec {
  const result = validateAskUserSpec(raw);
  if (!result.ok) throw new Error(result.error);
  return result.spec;
}
const choice = { question: 'Choose', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }] };

describe('four-type ask_user protocol', () => {
  it('supports default single and legacy string options with stable IDs', () => {
    const question = spec({ question: 'Choose', options: ['Alpha', 'Beta'] });
    expect(question.type).toBe('single');
    const envelope = buildAskUserAnswerEnvelope(question, 'Alpha');
    expect(envelope.answer).toEqual({ status: 'answered', mode: 'selection', selectedIds: ['option-1'], selectedLabels: ['Alpha'], text: '', note: '' });
    expect(JSON.parse(envelope.toolResult)).toEqual(envelope.answer);
    expect(envelope.picked).toBe('Alpha');
  });

  it.each([
    null, { question: '' }, { ...choice, type: 'unknown' }, { question: 'Q', options: ['one'] },
    { question: 'Q', options: Array(6).fill('x') }, { question: 'Q', options: ['same', 'same'] },
    { question: 'Q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] },
    { question: 'Q', options: ['', 'valid'] }, { ...choice, type: 'multiple', minSelections: 0 },
    { ...choice, type: 'multiple', minSelections: 2, maxSelections: 1 },
    { ...choice, type: 'multiple', maxSelections: 4 }, { ...choice, type: 'multiple', minSelections: 1.5 },
  ])('rejects malformed questions and option bounds: %j', (raw) => {
    expect(validateAskUserSpec(raw).ok).toBe(false);
  });

  it('checks multiple selection bounds and derives labels from the spec', () => {
    const question = spec({ ...choice, type: 'multiple', minSelections: 2, maxSelections: 2 });
    const answer = buildAskUserAnswerEnvelope(question, { status: 'answered', mode: 'selection', selectedIds: ['b', 'a'], note: 'detail' });
    expect(answer.answer.selectedLabels).toEqual(['Beta', 'Alpha']);
    expect(answer.picked).toBe('Beta、Alpha\ndetail');
    for (const ids of [['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'missing']]) {
      expect(() => buildAskUserAnswerEnvelope(question, { status: 'answered', mode: 'selection', selectedIds: ids })).toThrow('invalid_selection');
    }
  });

  it('keeps custom replacement separate from selection notes and supports text questions', () => {
    const question = spec(choice);
    const custom = buildAskUserAnswerEnvelope(question, { status: 'answered', mode: 'custom', text: ' Different ', note: ' rationale ', selectedIds: ['a'] });
    expect(custom.answer).toMatchObject({ mode: 'custom', selectedIds: [], text: 'Different', note: 'rationale' });
    const selected = buildAskUserAnswerEnvelope(question, { status: 'answered', mode: 'selection', selectedIds: ['a'], note: 'More', text: 'not a replacement' });
    expect(selected.answer).toMatchObject({ mode: 'selection', text: '', note: 'More' });
    expect(() => buildAskUserAnswerEnvelope(spec({ ...choice, allowCustom: false }), 'Other')).toThrow();
    expect(buildAskUserAnswerEnvelope(spec({ question: 'Explain', type: 'text' }), 'My answer').answer.mode).toBe('text');
    expect(() => buildAskUserAnswerEnvelope(spec({ question: 'Explain', type: 'text' }), '  ')).toThrow();
  });

  it('supports stable confirm/decline IDs and all four statuses', () => {
    const question = spec({ question: 'Proceed?', type: 'confirm', confirmLabel: 'Proceed', declineLabel: 'Stop' });
    expect(question.options.map((option) => option.id)).toEqual(['confirm', 'decline']);
    expect(buildAskUserAnswerEnvelope(question, 'Proceed').answer.status).toBe('answered');
    expect(buildAskUserAnswerEnvelope(question, 'Stop').answer.status).toBe('declined');
    expect(() => buildAskUserAnswerEnvelope(question, 'other')).toThrow();
    expect(() => buildAskUserAnswerEnvelope(question, { status: 'declined', mode: 'selection', selectedIds: ['confirm'] })).toThrow('invalid_decline');
    expect(() => buildAskUserAnswerEnvelope(question, { status: 'skipped', mode: 'text' })).toThrow('skip_not_allowed');
    const skipped = buildAskUserAnswerEnvelope(spec({ ...choice, allowSkip: true }), { status: 'skipped', mode: 'selection', selectedIds: ['a'], note: 'discard' });
    expect(skipped.answer).toMatchObject({ status: 'skipped', selectedIds: [], note: '' });
    expect(skipped.picked).toBe('skipped');
    const cancelled = buildAskUserAnswerEnvelope(question, { status: 'cancelled', mode: 'text' });
    expect(cancelled.answer.status).toBe('cancelled');
    expect(JSON.parse(cancelled.toolResult).status).toBe('cancelled');
  });
});
