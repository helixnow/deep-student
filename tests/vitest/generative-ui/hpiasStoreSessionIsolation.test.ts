import { beforeEach, describe, expect, it } from 'vitest';
import { useHpiasStore } from '@/stores/researchStore';

describe('HpiasStore session isolation', () => {
  beforeEach(() => {
    useHpiasStore.getState().actions.clear();
  });

  it('applies events when no session is active yet', () => {
    useHpiasStore.getState().actions.handleEvent({
      type: 'session_started',
      session_id: 's-a',
      question: 'A',
    });
    expect(useHpiasStore.getState().sessionId).toBe('s-a');
  });

  it('ignores plan events from a different session', () => {
    const handleEvent = useHpiasStore.getState().actions.handleEvent;
    handleEvent({ type: 'session_started', session_id: 's-a', question: 'A' });
    handleEvent({
      type: 'plan_generated',
      session_id: 's-a',
      round: 1,
      plan: { core: { queries: ['keep'] } },
    });
    handleEvent({
      type: 'plan_generated',
      session_id: 's-b',
      round: 1,
      plan: { core: { queries: ['clobber'] } },
    });
    handleEvent({
      type: 'synthesis_updated',
      session_id: 's-b',
      round: 1,
      synthesis: 'foreign',
    });

    const state = useHpiasStore.getState();
    expect(state.sessionId).toBe('s-a');
    expect(state.plan).toEqual({ core: { queries: ['keep'] } });
    expect(state.synthesis).toBeNull();
  });

  it('lets a new session_started replace the active session', () => {
    const handleEvent = useHpiasStore.getState().actions.handleEvent;
    handleEvent({ type: 'session_started', session_id: 's-a', question: 'A' });
    handleEvent({ type: 'session_started', session_id: 's-b', question: 'B' });
    expect(useHpiasStore.getState().sessionId).toBe('s-b');
  });
});
