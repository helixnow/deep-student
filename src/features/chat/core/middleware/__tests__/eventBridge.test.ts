import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventRegistry } from '../../../registry/eventRegistry';
import {
  clearBridgeState,
  clearEventContext,
  clearProcessedEventIds,
  handleBackendEventWithSequence,
  resetBridgeState,
  type BackendEvent,
} from '../eventBridge';
import type { ChatStore } from '../../types';

function createStore(skillStateVersion = 3) {
  return {
    sessionId: 'sess_test',
    currentStreamingMessageId: 'msg_test',
    skillStateJson: JSON.stringify({ version: skillStateVersion }),
    messageMap: new Map(),
    blocks: new Map(),
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    handleVariantStart: vi.fn(),
    handleVariantEnd: vi.fn(),
    createBlockWithId: vi.fn((_messageId: string, _type: string, backendBlockId: string) => backendBlockId),
    createBlock: vi.fn(() => 'blk_generated'),
    updateBlock: vi.fn(),
    setBlockError: vi.fn(),
    saveSession: vi.fn(async () => undefined),
  } as unknown as ChatStore & { skillStateJson: string };
}

describe('eventBridge guards', () => {
  const onStart = vi.fn((_, __, ___, backendBlockId?: string) => backendBlockId ?? 'blk_generated');
  const onError = vi.fn();
  const onEnd = vi.fn();

  beforeEach(() => {
    eventRegistry.clear();
    eventRegistry.register('tool_call', {
      onStart,
      onError,
      onEnd,
    });
    onStart.mockClear();
    onError.mockClear();
    onEnd.mockClear();
    resetBridgeState('sess_test');
  });

  afterEach(() => {
    clearProcessedEventIds('sess_test');
    clearEventContext('sess_test');
    clearBridgeState('sess_test');
    eventRegistry.clear();
  });

  it('drops stale events from older skillStateVersion', () => {
    const store = createStore(3);
    const event: BackendEvent = {
      sequenceId: 0,
      type: 'tool_call',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_old',
      payload: { toolName: 'fetch' },
      skillStateVersion: 2,
      roundId: 'tool-round-0',
    };

    handleBackendEventWithSequence(store, event);

    expect(onStart).not.toHaveBeenCalled();
  });

  it('drops stale tool events from an older round', () => {
    const store = createStore(3);

    handleBackendEventWithSequence(store, {
      sequenceId: 0,
      type: 'tool_call',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_round',
      payload: { toolName: 'fetch' },
      skillStateVersion: 3,
      roundId: 'tool-round-1',
    });

    handleBackendEventWithSequence(store, {
      sequenceId: 1,
      type: 'tool_call',
      phase: 'error',
      blockId: 'blk_round',
      error: 'late error',
      skillStateVersion: 3,
      roundId: 'tool-round-0',
    });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
