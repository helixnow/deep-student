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
    expect(state.sessions['s-b']?.plan).toEqual({ core: { queries: ['clobber'] } });
    expect(state.sessions['s-b']?.synthesis).toBe('foreign');
    expect(state.sessions['s-a']?.plan).toEqual({ core: { queries: ['keep'] } });
  });

  it('keeps the active session when another session_started arrives', () => {
    const handleEvent = useHpiasStore.getState().actions.handleEvent;
    handleEvent({ type: 'session_started', session_id: 's-a', question: 'A' });
    handleEvent({
      type: 'plan_generated',
      session_id: 's-a',
      round: 1,
      plan: { core: { queries: ['keep'] } },
    });
    handleEvent({ type: 'session_started', session_id: 's-b', question: 'B' });
    const state = useHpiasStore.getState();
    expect(state.sessionId).toBe('s-a');
    expect(state.plan).toEqual({ core: { queries: ['keep'] } });
    expect(state.sessions['s-a']?.plan).toEqual({ core: { queries: ['keep'] } });
    expect(state.sessions['s-b']?.sessionId).toBe('s-b');
    expect(state.sessions['s-b']?.plan).toBeNull();
  });

  it('reset replaces the active session without dropping other slices', () => {
    const actions = useHpiasStore.getState().actions;
    actions.handleEvent({ type: 'session_started', session_id: 's-a', question: 'A' });
    actions.handleEvent({
      type: 'plan_generated',
      session_id: 's-a',
      round: 1,
      plan: { core: { queries: ['keep'] } },
    });
    actions.reset('style-lab-hpias-demo', 0);

    const state = useHpiasStore.getState();
    expect(state.sessionId).toBe('style-lab-hpias-demo');
    expect(state.plan).toBeNull();
    expect(state.sessions['s-a']?.plan).toEqual({ core: { queries: ['keep'] } });
    expect(state.sessions['style-lab-hpias-demo']?.sessionId).toBe('style-lab-hpias-demo');
  });
});
