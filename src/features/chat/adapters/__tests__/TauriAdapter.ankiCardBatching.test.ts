import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/middleware/eventBridge', () => ({
  handleBackendEventWithSequence: vi.fn(),
  flushPendingBackendEvents: vi.fn(),
  handleStreamComplete: vi.fn(() => Promise.resolve()),
  handleStreamAbort: vi.fn(() => Promise.resolve()),
  clearEventContext: vi.fn(),
  resetBridgeState: vi.fn(),
}));

vi.mock('../../core/middleware/autoSave', () => ({
  autoSave: {
    forceImmediateSave: vi.fn(() => Promise.resolve()),
    cleanup: vi.fn(),
  },
  streamingBlockSaver: {
    cleanup: vi.fn(),
  },
}));

import { ChatV2TauriAdapter } from '../TauriAdapter';

/**
 * F3（2026-09-07 审阅）：anki 卡片合并缓冲的判重必须近线性且语义不变——
 * 同窗口重复、跨窗口（已落盘）重复被过滤；无 ID 卡片不参与判重始终保留。
 */
function createAnkiStore(existingCards: Array<{ id?: string }> = []) {
  const block: any = {
    id: 'blk_anki',
    messageId: 'msg_1',
    type: 'anki_cards',
    status: 'running',
    toolOutput: { documentId: 'doc-1', cards: [...existingCards] },
  };
  const state: any = {
    sessionId: 'sess_anki',
    currentStreamingMessageId: 'msg_1',
    blocks: new Map([['blk_anki', block]]),
    messageMap: new Map([['msg_1', { id: 'msg_1', role: 'assistant', blockIds: ['blk_anki'] }]]),
  };
  state.updateBlock = vi.fn((blockId: string, patch: Record<string, unknown>) => {
    const current = state.blocks.get(blockId);
    state.blocks.set(blockId, { ...current, ...patch });
  });
  return state;
}

function newCardEvent(id: string | undefined, docId = 'doc-1') {
  return {
    type: 'NewCard',
    data: { card: { id, front: `Q-${id ?? 'noid'}`, back: 'A' }, document_id: docId },
  };
}

function getCards(store: any) {
  return (store.blocks.get('blk_anki').toolOutput.cards as Array<{ id?: string }>);
}

describe('TauriAdapter anki 卡片批量落盘（F3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同窗口重复 ID 只落一张，且合并为一次 updateBlock', () => {
    const store = createAnkiStore();
    const adapter = new ChatV2TauriAdapter('sess_anki', store as any);

    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c1'));
    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c1'));
    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c2'));
    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c1'));

    vi.advanceTimersByTime(150);

    expect(store.updateBlock).toHaveBeenCalledTimes(1);
    expect(getCards(store).map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('跨窗口重复（已落盘卡片）在播种索引与落盘过滤两道防线上都被拦截', () => {
    const store = createAnkiStore([{ id: 'c0', front: 'old', back: 'old' } as any]);
    const adapter = new ChatV2TauriAdapter('sess_anki', store as any);

    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c0'));
    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c1'));

    vi.advanceTimersByTime(150);

    expect(store.updateBlock).toHaveBeenCalledTimes(1);
    expect(getCards(store).map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('无 ID 卡片不参与判重，全部保留', () => {
    const store = createAnkiStore();
    const adapter = new ChatV2TauriAdapter('sess_anki', store as any);

    (adapter as any).handleAnkiGenerationEvent(newCardEvent(undefined));
    (adapter as any).handleAnkiGenerationEvent(newCardEvent(undefined));

    vi.advanceTimersByTime(150);

    expect(getCards(store)).toHaveLength(2);
  });

  it('后续窗口从最新状态重新播种，跨窗口重复不复活', () => {
    const store = createAnkiStore();
    const adapter = new ChatV2TauriAdapter('sess_anki', store as any);

    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c1'));
    vi.advanceTimersByTime(150);
    expect(getCards(store).map((c) => c.id)).toEqual(['c1']);

    // 第二个窗口：c1 已落盘，再次到达应被过滤；c2 是新卡
    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c1'));
    (adapter as any).handleAnkiGenerationEvent(newCardEvent('c2'));
    vi.advanceTimersByTime(150);

    expect(getCards(store).map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});
