import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useHpiasStore } from '@/stores/researchStore';
import {
  HPIAS_EVENT_CHANNEL,
  createHpiasEventBridgeHandler,
  intentHasResearchBlocks,
  normalizeHpiasEventPayload,
  omitResearchBlocksFromIntent,
  resetSharedHpiasEventBridgeForTests,
} from '@/features/generative-ui/bridge/hpiasEventBridge';

describe('hpiasEventBridge', () => {
  beforeEach(() => {
    useHpiasStore.getState().actions.clear();
    resetSharedHpiasEventBridgeForTests();
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

  it('fails closed when a scoped event has no valid session id', () => {
    const onEvent = vi.fn();
    const handler = createHpiasEventBridgeHandler({ sessionId: 'target', onEvent });

    handler({ type: 'session_started', question: 'missing id' });
    handler({ type: 'session_started', session_id: 42, question: 'invalid id' });

    expect(onEvent).not.toHaveBeenCalled();
    expect(useHpiasStore.getState().sessionId).toBeNull();
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

  it('drops orphaned research-only action bars when live panel takes over', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'research-report', props: { body: 'Done' } },
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'copy-report', label: 'Copy report' },
              { id: 'export-plan', label: 'Export plan' },
              { id: 'export-intent', label: 'Export intent' },
              { id: 'copy-intent', label: 'Copy intent' },
            ],
          },
        },
      ],
    };

    expect(omitResearchBlocksFromIntent(intent).blocks).toEqual([]);
  });

  it('drops orphaned copy-block action bars when live panel takes over', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'research-report', props: { body: 'Done' } },
        {
          type: 'action-bar',
          props: {
            actions: [{ id: 'copy-block', label: 'Copy block' }],
          },
        },
      ],
    };

    expect(omitResearchBlocksFromIntent(intent).blocks).toEqual([]);
  });

  it('preserves action bars containing non-research actions', () => {
    const mixedActionBar = {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'copy-report', label: 'Copy report' },
          { id: 'start-review', label: 'Start review' },
        ],
      },
    };
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'research-plan', props: { title: 'Plan', steps: [] } },
        mixedActionBar,
      ],
    };

    expect(omitResearchBlocksFromIntent(intent).blocks).toEqual([mixedActionBar]);
  });

  it('preserves research-like action bars when no research block is omitted', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'text', props: { body: 'Learning plan' } },
        {
          type: 'action-bar',
          props: {
            actions: [{ id: 'export-plan', label: 'Export plan' }],
          },
        },
      ],
    };

    expect(omitResearchBlocksFromIntent(intent).blocks).toEqual(intent.blocks);
  });
});
