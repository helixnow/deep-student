import { describe, it, expect, beforeEach } from 'vitest';
import { useHpiasStore } from '@/stores/researchStore';
import {
  HPIAS_EVENT_CHANNEL,
  createHpiasEventBridgeHandler,
  intentHasResearchBlocks,
  normalizeHpiasEventPayload,
  omitResearchBlocksFromIntent,
} from '@/features/generative-ui/bridge/hpiasEventBridge';

describe('hpiasEventBridge', () => {
  beforeEach(() => {
    useHpiasStore.getState().actions.clear();
  });

  it('exports canonical event channel name', () => {
    expect(HPIAS_EVENT_CHANNEL).toBe('hpias_event');
  });

  it('normalizes flat and wrapped payloads', () => {
    const flat = normalizeHpiasEventPayload({
      type: 'session_started',
      session_id: 's1',
      question: 'Q?',
    });
    expect(flat?.type).toBe('session_started');

    const wrapped = normalizeHpiasEventPayload({
      event: { type: 'round_started', session_id: 's1', round: 1 },
    });
    expect(wrapped).toMatchObject({ type: 'round_started', round: 1 });
  });

  it('filters events by sessionId', () => {
    const handler = createHpiasEventBridgeHandler({ sessionId: 'target' });
    handler({
      type: 'session_started',
      session_id: 'other',
      question: 'skip',
    });
    expect(useHpiasStore.getState().sessionId).toBeNull();

    handler({
      type: 'session_started',
      session_id: 'target',
      question: 'keep',
    });
    expect(useHpiasStore.getState().sessionId).toBe('target');
  });

  it('detects research blocks in intent', () => {
    expect(
      intentHasResearchBlocks({
        version: '1',
        blocks: [{ type: 'text', props: { body: 'hi' } }],
      }),
    ).toBe(false);
    expect(
      intentHasResearchBlocks({
        version: '1',
        blocks: [{ type: 'research-plan', props: { title: 'Plan', steps: [] } }],
      }),
    ).toBe(true);
  });

  it('omits research blocks when live panel takes over', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'text', props: { body: 'intro' } },
        { type: 'research-plan', props: { title: 'Plan', steps: [] } },
      ],
    };
    const filtered = omitResearchBlocksFromIntent(intent);
    expect(filtered.blocks.map((b) => b.type)).toEqual(['text']);
  });
});
