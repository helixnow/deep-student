import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventRegistry } from '../../../registry/eventRegistry';
import {
  clearBridgeState,
  clearEventContext,
  clearProcessedEventIds,
  getLastSkillInjectionAudit,
  handleBackendEventWithSequence,
  resetBridgeState,
} from '../eventBridge';
import type { ChatStore } from '../../types';

function createStore() {
  return {
    sessionId: 'sess_audit',
    currentStreamingMessageId: 'msg_1',
    messageMap: new Map(),
    blocks: new Map(),
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    createBlockWithId: vi.fn((_m: string, _t: string, id: string) => id),
    createBlock: vi.fn(() => 'blk_generated'),
    updateBlock: vi.fn(),
    setBlockError: vi.fn(),
    saveSession: vi.fn(async () => undefined),
  } as unknown as ChatStore;
}

const audit = {
  injectedSkillIds: ['tutor'],
  droppedSkillIds: [],
  missingSkillIds: ['gone'],
  estimatedTokens: 120,
  skillStateVersion: 1,
};

// Rust 版：首个带序号事件是 audit（phase=end）时被缓冲到间隙恢复计时器触发，随后进入块分发打出 No handler registered。
describe('RF-W09-skill-injection-audit-unhandled: skill_injection_audit', () => {
  const onStart = vi.fn((_s, _m, _p, id?: string) => id ?? 'blk_generated');

  beforeEach(() => {
    vi.useFakeTimers();
    eventRegistry.clear();
    eventRegistry.register('content', { onStart, onChunk: vi.fn(), onEnd: vi.fn() });
    onStart.mockClear();
    resetBridgeState('sess_audit');
  });

  afterEach(() => {
    clearProcessedEventIds('sess_audit');
    clearEventContext('sess_audit');
    clearBridgeState('sess_audit');
    eventRegistry.clear();
    vi.useRealTimers();
  });

  it('is consumed as the first sequenced event without holding back the stream', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore();
    handleBackendEventWithSequence(store, { sequenceId: 0, type: 'skill_injection_audit', phase: 'end', messageId: 'msg_1', result: audit });
    handleBackendEventWithSequence(store, { sequenceId: 1, type: 'content', phase: 'start', messageId: 'msg_1', blockId: 'blk_1' });

    // processed synchronously: no gap-recovery timeout needed
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(getLastSkillInjectionAudit('sess_audit')).toMatchObject({ messageId: 'msg_1', ...audit });
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/No handler registered|orphan/i);
    warn.mockRestore();
  });

  it('is consumed mid-stream and keeps the sequence moving', () => {
    const store = createStore();
    handleBackendEventWithSequence(store, { sequenceId: 0, type: 'content', phase: 'start', messageId: 'msg_1', blockId: 'blk_1' });
    handleBackendEventWithSequence(store, { sequenceId: 1, type: 'skill_injection_audit', phase: 'end', messageId: 'msg_1', result: { ...audit, estimatedTokens: 7 } });
    handleBackendEventWithSequence(store, { sequenceId: 2, type: 'content', phase: 'start', messageId: 'msg_1', blockId: 'blk_2' });
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(getLastSkillInjectionAudit('sess_audit')).toMatchObject({ estimatedTokens: 7 });
    expect(store.createBlockWithId).not.toHaveBeenCalledWith(expect.anything(), 'skill_injection_audit', expect.anything());
  });
});
