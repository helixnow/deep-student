/**
 * readGenerativeUIInteraction（方案 2.6）各状态组合
 */
import { describe, it, expect } from 'vitest';
import {
  buildPendingGenerativeUIInteraction,
  parseGenerativeUIInteraction,
  readGenerativeUIInteraction,
  type GenerativeUIInteractionBlockLike,
} from '@/features/generative-ui/interaction/readInteraction';

const pendingOutput = (extra: Record<string, unknown> = {}) => ({
  intent: { version: '1', blocks: [] },
  interaction: { mode: 'await', toolCallId: 'call_1', state: 'pending' },
  ...extra,
});

const block = (b: Partial<GenerativeUIInteractionBlockLike>): GenerativeUIInteractionBlockLike => ({
  status: 'running',
  toolCallId: 'call_1',
  ...b,
});

describe('readGenerativeUIInteraction', () => {
  it('returns null for non-await blocks', () => {
    expect(readGenerativeUIInteraction(block({ toolOutput: { intent: {}, isStreaming: false } }), { sessionStatus: 'idle' })).toBeNull();
    expect(readGenerativeUIInteraction(block({}), { sessionStatus: 'idle' })).toBeNull();
  });

  it('pending + running + streaming → can submit without IPC', () => {
    for (const sessionStatus of ['streaming', 'sending']) {
      expect(readGenerativeUIInteraction(block({ toolOutput: pendingOutput() }), { sessionStatus })).toEqual({
        state: 'pending',
        toolCallId: 'call_1',
        canSubmit: true,
        needsPendingCheck: false,
      });
    }
  });

  it('live start marker (toolInput.awaitAnswer / toolOutput.awaitAnswer) counts as pending', () => {
    expect(
      readGenerativeUIInteraction(block({ toolInput: { awaitAnswer: true } }), { sessionStatus: 'streaming' }),
    ).toMatchObject({ state: 'pending', canSubmit: true });
    expect(
      readGenerativeUIInteraction(
        block({ toolOutput: { awaitAnswer: true, interaction: buildPendingGenerativeUIInteraction('call_9') } }),
        { sessionStatus: 'streaming' },
      ),
    ).toMatchObject({ state: 'pending', toolCallId: 'call_9', canSubmit: true });
  });

  it('pending but not streaming → needs list_pending check until known', () => {
    const b = block({ status: 'running', toolOutput: pendingOutput() });
    expect(readGenerativeUIInteraction(b, { sessionStatus: 'idle' })).toMatchObject({
      state: 'pending',
      canSubmit: false,
      needsPendingCheck: true,
    });
    expect(readGenerativeUIInteraction(b, { sessionStatus: 'idle', livePending: null })).toMatchObject({ needsPendingCheck: true });
    expect(readGenerativeUIInteraction(b, { sessionStatus: 'idle', livePending: true })).toMatchObject({
      state: 'pending',
      canSubmit: true,
      needsPendingCheck: false,
    });
    expect(readGenerativeUIInteraction(b, { sessionStatus: 'idle', livePending: false })).toMatchObject({
      state: 'interrupted',
      reason: 'interrupted',
      canSubmit: false,
    });
  });

  it('restored DB snapshot (status success, state pending) uses livePending', () => {
    const b = block({ status: 'success', toolOutput: { status: 'not_answered', reason: 'interrupted', ...pendingOutput() } });
    expect(readGenerativeUIInteraction(b, { sessionStatus: 'streaming', livePending: false })).toMatchObject({ state: 'interrupted' });
    expect(readGenerativeUIInteraction(b, { sessionStatus: 'idle', livePending: true })).toMatchObject({ canSubmit: true });
  });

  it('pending + block error without answer → cancelled (stopped)', () => {
    expect(
      readGenerativeUIInteraction(block({ status: 'error', toolOutput: pendingOutput() }), { sessionStatus: 'idle', livePending: true }),
    ).toEqual({ state: 'cancelled', reason: 'stopped', toolCallId: 'call_1', canSubmit: false, needsPendingCheck: false });
    expect(
      readGenerativeUIInteraction(block({ status: 'error', toolInput: { awaitAnswer: true } }), { sessionStatus: 'idle' }),
    ).toMatchObject({ state: 'cancelled' });
  });

  it('answered → read-only with summary/data', () => {
    const r = readGenerativeUIInteraction(
      block({
        status: 'success',
        toolOutput: {
          interaction: { mode: 'await', toolCallId: 'call_1', state: 'answered', answeredAt: 1 },
          answer: { summary: 'Q：A', data: { q1: { selected: ['a'] } }, trust: 'untrusted_user_input' },
        },
      }),
      { sessionStatus: 'idle', livePending: true },
    );
    expect(r).toEqual({
      state: 'answered',
      toolCallId: 'call_1',
      canSubmit: false,
      needsPendingCheck: false,
      answered: { summary: 'Q：A', data: { q1: { selected: ['a'] } } },
    });
  });

  it.each([
    ['dismissed', 'user_message'],
    ['dismissed', 'skipped'],
    ['cancelled', 'stopped'],
  ])('%s/%s → terminal read-only', (state, reason) => {
    const r = readGenerativeUIInteraction(
      block({ status: 'success', toolOutput: { interaction: { mode: 'await', toolCallId: 'call_1', state, reason } } }),
      { sessionStatus: 'streaming', livePending: true },
    );
    expect(r).toMatchObject({ state, reason, canSubmit: false, needsPendingCheck: false });
    expect(r?.answered).toBeUndefined();
  });

  it('error status does not override terminal dismissed', () => {
    const r = readGenerativeUIInteraction(
      block({ status: 'error', toolOutput: { interaction: { mode: 'await', toolCallId: 'c', state: 'dismissed', reason: 'skipped' } } }),
      { sessionStatus: 'idle' },
    );
    expect(r).toMatchObject({ state: 'dismissed', reason: 'skipped' });
  });

  it('pending without toolCallId cannot submit or check', () => {
    const r = readGenerativeUIInteraction(
      { status: 'running', toolInput: { awaitAnswer: true } },
      { sessionStatus: 'idle' },
    );
    expect(r).toMatchObject({ state: 'pending', canSubmit: false, needsPendingCheck: false });
  });

  it('parseGenerativeUIInteraction rejects unknown states and drops unknown reasons', () => {
    expect(parseGenerativeUIInteraction({ state: 'weird' })).toBeNull();
    expect(parseGenerativeUIInteraction('x')).toBeNull();
    expect(parseGenerativeUIInteraction({ state: 'dismissed', reason: 'hack', toolCallId: 'c' })).toEqual({
      mode: 'await',
      toolCallId: 'c',
      state: 'dismissed',
    });
  });
});
