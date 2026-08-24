import { describe, expect, it } from 'vitest';
import {
  MAX_HPIAS_SESSION_SLICES,
  applyHpiasEventToSessionSlice,
  createEmptyHpiasSessionSlice,
  pruneHpiasSessionSlices,
} from '@/stores/hpiasSessionSlice';

describe('hpiasSessionSlice', () => {
  it('ignores events stamped for another session', () => {
    const slice = createEmptyHpiasSessionSlice('s-a');
    const next = applyHpiasEventToSessionSlice(slice, {
      type: 'plan_generated',
      session_id: 's-b',
      round: 1,
      plan: { core: { queries: ['nope'] } },
    });
    expect(next.plan).toBeNull();
    expect(next.sessionId).toBe('s-a');
  });

  it('folds plan / retrieval / synthesis into the same slice', () => {
    let slice = createEmptyHpiasSessionSlice('s-a');
    slice = applyHpiasEventToSessionSlice(slice, {
      type: 'session_started',
      session_id: 's-a',
      question: 'A',
    });
    slice = applyHpiasEventToSessionSlice(slice, {
      type: 'plan_generated',
      session_id: 's-a',
      round: 1,
      plan: { core: { queries: ['q1'] } },
    });
    slice = applyHpiasEventToSessionSlice(slice, {
      type: 'retrieval_completed',
      session_id: 's-a',
      round: 1,
      fetched: 9,
    });
    slice = applyHpiasEventToSessionSlice(slice, {
      type: 'synthesis_updated',
      session_id: 's-a',
      round: 1,
      synthesis: 'hello',
    });

    expect(slice.plan).toEqual({ core: { queries: ['q1'] } });
    expect(slice.retrievalCount).toBe(9);
    expect(slice.synthesis).toBe('hello');
    expect(slice.round).toBe(1);
  });

  it('prunes oldest unprotected slices when over the cap', () => {
    const sessions = Object.fromEntries(
      Array.from({ length: MAX_HPIAS_SESSION_SLICES + 2 }, (_, index) => {
        const id = `s-${index}`;
        return [
          id,
          { ...createEmptyHpiasSessionSlice(id), updatedAt: index },
        ];
      }),
    );

    const pruned = pruneHpiasSessionSlices(sessions, ['s-0']);
    expect(Object.keys(pruned)).toHaveLength(MAX_HPIAS_SESSION_SLICES);
    expect(pruned['s-0']).toBeDefined();
    expect(pruned['s-1']).toBeUndefined();
    expect(pruned['s-2']).toBeUndefined();
    expect(pruned['s-9']).toBeDefined();
  });
});
