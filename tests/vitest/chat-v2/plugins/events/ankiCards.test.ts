/**
 * Chat V2 - ankiCards 事件处理插件单元测试
 *
 * 测试要点：
 * - should create anki_cards block
 * - should append card on chunk
 * - should preserve cards on abort
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';
import type { ChatStore, Block } from '@/chat-v2/core/types';

// 导入插件（触发自动注册）
import '@/chat-v2/plugins/events/ankiCards';

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockStore(): ChatStore {
  const blocks = new Map<string, Block>();

  return {
    sessionId: 'test-session',
    mode: 'chat',
    title: 'Test',
    description: '',
    sessionStatus: 'streaming',
    isDataLoaded: true,
    messageMap: new Map(),
    messageOrder: [],
    blocks,
    currentStreamingMessageId: 'msg-1',
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    chatParams: {
      modelId: 'test-model',
      temperature: 0.7,
      contextLimit: 4096,
      maxTokens: 2048,
      enableThinking: false,
      disableTools: false,
      model2OverrideId: null,
    },
    features: new Map(),
    modeState: null,
    inputValue: '',
    attachments: [],
    panelStates: {
      rag: false,
      mcp: false,
      search: false,
      learn: false,
      model: false,
      advanced: false,
      attachment: false,
    },
    pendingContextRefs: [],
    messageOperationLock: null,
    pendingApprovalRequest: null,
    activeSkillId: null,
    pendingParallelModelIds: null,
    modelRetryTarget: null,
    // Guards
    canSend: vi.fn(() => false),
    canEdit: vi.fn(() => false),
    canDelete: vi.fn(() => false),
    canAbort: vi.fn(() => true),
    isBlockLocked: vi.fn(() => true),
    isMessageLocked: vi.fn(() => true),
    // Actions
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn(),
    abortStream: vi.fn(),
    createBlock: vi.fn((messageId, type) => {
      const blockId = `${type}-block-1`;
      blocks.set(blockId, {
        id: blockId,
        type,
        status: 'pending',
        messageId,
      });
      return blockId;
    }),
    createBlockWithId: vi.fn((messageId, type, blockId) => {
      blocks.set(blockId, {
        id: blockId,
        type,
        status: 'pending',
        messageId,
      });
      return blockId;
    }),
    updateBlockContent: vi.fn(),
    updateBlock: vi.fn((blockId: string, patch: Partial<Block>) => {
      const block = blocks.get(blockId);
      if (!block) return;
      Object.assign(block, patch);
    }),
    updateBlockStatus: vi.fn((blockId, status) => {
      const block = blocks.get(blockId);
      if (block) {
        block.status = status;
      }
    }),
    setBlockResult: vi.fn((blockId, result) => {
      const block = blocks.get(blockId);
      if (block) {
        block.toolOutput = result;
      }
    }),
    setBlockError: vi.fn((blockId, error) => {
      const block = blocks.get(blockId);
      if (block) {
        block.status = 'error';
        block.error = error;
      }
    }),
    setCurrentStreamingMessage: vi.fn(),
    addActiveBlock: vi.fn(),
    removeActiveBlock: vi.fn(),
    setChatParams: vi.fn(),
    resetChatParams: vi.fn(),
    setFeature: vi.fn(),
    toggleFeature: vi.fn(),
    getFeature: vi.fn(() => false),
    setModeState: vi.fn(),
    updateModeState: vi.fn(),
    setInputValue: vi.fn(),
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
    initSession: vi.fn(),
    loadSession: vi.fn(),
    saveSession: vi.fn(() => Promise.resolve()),
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn(() => []),
    getOrderedMessages: vi.fn(() => []),
    addBlockToVariant: vi.fn(),
    addBlockToMessage: vi.fn(),
    getActiveVariant: vi.fn(),
    getVariants: vi.fn(() => []),
    isMultiVariantMessage: vi.fn(() => false),
    getDisplayBlockIds: vi.fn(() => []),
    switchVariant: vi.fn(),
    deleteVariant: vi.fn(),
    retryVariant: vi.fn(),
    cancelVariant: vi.fn(),
    handleVariantStart: vi.fn(),
    handleVariantEnd: vi.fn(),
    setSwitchVariantCallback: vi.fn(),
    setDeleteVariantCallback: vi.fn(),
    setRetryVariantCallback: vi.fn(),
    setCancelVariantCallback: vi.fn(),
    setPendingParallelModelIds: vi.fn(),
    setModelRetryTarget: vi.fn(),
  } as unknown as ChatStore;
}

// ============================================================================
// 测试
// ============================================================================

describe('AnkiCardsEventHandler', () => {
  let mockStore: ChatStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it('should be registered in eventRegistry', () => {
    expect(eventRegistry.has('anki_cards')).toBe(true);
  });

  describe('onStart', () => {
    it('should create anki_cards block', () => {
      const handler = eventRegistry.get('anki_cards');
      expect(handler).toBeDefined();
      expect(handler!.onStart).toBeDefined();

      const blockId = handler!.onStart!(mockStore, 'msg-1', {
        blockType: 'anki_cards',
      });

      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'anki_cards');
      expect(blockId).toBe('anki_cards-block-1');
    });

    it('should set initial block data with empty cards', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      expect(mockStore.updateBlock).toHaveBeenCalledWith(
        'anki_cards-block-1',
        expect.objectContaining({
          toolOutput: expect.objectContaining({
            cards: [],
            syncStatus: 'pending',
            templateId: null,
          }),
          status: 'running',
        })
      );
    });

    it('should accept templateId from payload', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', {
        blockType: 'anki_cards',
        templateId: 'template-123',
      });

      expect(mockStore.updateBlock).toHaveBeenCalledWith(
        'anki_cards-block-1',
        expect.objectContaining({
          toolOutput: expect.objectContaining({
            templateId: 'template-123',
          }),
        })
      );
    });

    it('should be idempotent when backendBlockId already exists', () => {
      const handler = eventRegistry.get('anki_cards');
      expect(handler).toBeDefined();

      // 第一次 start：创建块
      const firstId = handler!.onStart!(
        mockStore,
        'msg-1',
        { blockType: 'anki_cards' },
        'blk-fixed-1'
      );
      expect(firstId).toBe('blk-fixed-1');
      expect(mockStore.createBlockWithId).toHaveBeenCalledTimes(1);

      // 第二次 start（同 blockId）：应幂等复用，不再重复创建
      const secondId = handler!.onStart!(
        mockStore,
        'msg-1',
        { blockType: 'anki_cards' },
        'blk-fixed-1'
      );
      expect(secondId).toBe('blk-fixed-1');
      expect(mockStore.createBlockWithId).toHaveBeenCalledTimes(1);
    });

    it('should not downgrade terminal block status on duplicated start', () => {
      const handler = eventRegistry.get('anki_cards');
      expect(handler).toBeDefined();

      handler!.onStart!(
        mockStore,
        'msg-1',
        { blockType: 'anki_cards' },
        'blk-fixed-terminal'
      );
      mockStore.updateBlockStatus('blk-fixed-terminal', 'success');

      handler!.onStart!(
        mockStore,
        'msg-1',
        { blockType: 'anki_cards', templateId: 'template-123' },
        'blk-fixed-terminal'
      );

      const block = mockStore.blocks.get('blk-fixed-terminal');
      expect(block?.status).toBe('success');
      expect((block?.toolOutput as any)?.templateId).toBe('template-123');
    });
  });

  describe('onChunk', () => {
    it('should append card on chunk', () => {
      const handler = eventRegistry.get('anki_cards');

      // 先创建块
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      // 模拟收到卡片数据
      const cardJson = JSON.stringify({
        front: 'Question 1',
        back: 'Answer 1',
        tags: ['math'],
      });

      handler!.onChunk!(mockStore, 'anki_cards-block-1', cardJson);

      // 验证 updateBlock 被调用，且包含新卡片（保持 running）
      expect(mockStore.updateBlock).toHaveBeenLastCalledWith(
        'anki_cards-block-1',
        expect.objectContaining({
          toolOutput: expect.objectContaining({
            cards: expect.arrayContaining([
              expect.objectContaining({
                front: 'Question 1',
                back: 'Answer 1',
                tags: ['math'],
              }),
            ]),
          }),
          status: 'running',
        })
      );
    });

    it('should assign id to card if not provided', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      const cardJson = JSON.stringify({
        front: 'Question',
        back: 'Answer',
      });

      handler!.onChunk!(mockStore, 'anki_cards-block-1', cardJson);

      // 验证卡片有 id
      const lastCall = (mockStore.updateBlock as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      const cards = lastCall?.[1]?.toolOutput?.cards as Array<{ id?: string }> | undefined;
      expect(cards?.[0]?.id).toBeDefined();
      expect(typeof cards?.[0]?.id).toBe('string');
    });

    it('should handle invalid JSON gracefully', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      // 不应该抛出异常
      expect(() => {
        handler!.onChunk!(mockStore, 'anki_cards-block-1', 'invalid json');
      }).not.toThrow();
    });

    it('should merge progress/ankiConnect patch on chunk', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      // 先追加一张卡片，确保 patch 合并不会丢失 cards
      handler!.onChunk!(
        mockStore,
        'anki_cards-block-1',
        JSON.stringify({ front: 'Q1', back: 'A1' })
      );

      const patchJson = JSON.stringify({
        documentId: 'doc-1',
        ankiConnect: { available: true },
        progress: { stage: 'generating', message: 'Generating...', completedRatio: 0.5, cardsGenerated: 3 },
      });
      handler!.onChunk!(mockStore, 'anki_cards-block-1', patchJson);

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;
      expect(toolOutput?.documentId).toBe('doc-1');
      expect(toolOutput?.ankiConnect?.available).toBe(true);
      expect(toolOutput?.progress?.stage).toBe('generating');
      expect(toolOutput?.progress?.cardsGenerated).toBe(3);
      expect(toolOutput?.cards?.length).toBeGreaterThanOrEqual(1);
    });

    it('should append cards from patch chunk when provided', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      handler!.onChunk!(
        mockStore,
        'anki_cards-block-1',
        JSON.stringify({ front: 'Q1', back: 'A1' })
      );

      const patchJson = JSON.stringify({
        cards: [{ front: 'Q2', back: 'A2' }],
        progress: { stage: 'generating', cardsGenerated: 2 },
      });
      handler!.onChunk!(mockStore, 'anki_cards-block-1', patchJson);

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;
      expect(toolOutput?.cards?.length).toBe(2);
      expect(toolOutput?.cards?.[1]?.front).toBe('Q2');
    });

    it('should preserve initial context fields when merging patch-only chunk', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', {
        blockType: 'anki_cards',
        templateId: 'template-ctx',
        options: { route: 'simple_text' },
      });

      // patch-only（不包含 cards）
      handler!.onChunk!(
        mockStore,
        'anki_cards-block-1',
        JSON.stringify({
          documentId: 'doc-ctx',
          ankiConnect: { available: true },
          progress: { stage: 'routing', completedRatio: 0.1, message: 'Routing...' },
        })
      );

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;

      // merge: patch fields
      expect(toolOutput?.documentId).toBe('doc-ctx');
      expect(toolOutput?.ankiConnect?.available).toBe(true);
      expect(toolOutput?.progress?.stage).toBe('routing');

      // preserve: onStart context fields
      expect(toolOutput?.templateId).toBe('template-ctx');
      expect(toolOutput?.syncStatus).toBe('pending');
      expect(toolOutput?.businessSessionId).toBe('test-session');
      expect(toolOutput?.messageStableId).toBe('msg-1');
      expect(toolOutput?.options).toEqual({ route: 'simple_text' });

      // cards should remain empty (patch-only)
      expect(toolOutput?.cards).toEqual([]);
    });

    it('should not downgrade terminal block status when chunk arrives late', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });
      mockStore.updateBlockStatus('anki_cards-block-1', 'success');

      handler!.onChunk!(
        mockStore,
        'anki_cards-block-1',
        JSON.stringify({ front: 'Q-late', back: 'A-late' })
      );

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;
      expect(block?.status).toBe('success');
      expect(toolOutput?.cards?.length).toBe(1);
      expect(toolOutput?.cards?.[0]?.front).toBe('Q-late');
    });
  });

  describe('onEnd', () => {
    it('should set success status on end', () => {
      const handler = eventRegistry.get('anki_cards');
      expect(handler!.onEnd).toBeDefined();

      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });
      handler!.onEnd!(mockStore, 'anki_cards-block-1', undefined);

      expect(mockStore.updateBlockStatus).toHaveBeenCalledWith(
        'anki_cards-block-1',
        'success'
      );
    });

    it('should accept final cards array in result', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      const finalResult = {
        cards: [
          { front: 'Q1', back: 'A1' },
          { front: 'Q2', back: 'A2' },
        ],
      };

      handler!.onEnd!(mockStore, 'anki_cards-block-1', finalResult);

      // 验证最终卡片列表被设置（通过 updateBlock 更新 toolOutput）
      expect(mockStore.updateBlock).toHaveBeenCalledWith(
        'anki_cards-block-1',
        expect.objectContaining({
          toolOutput: expect.objectContaining({
            cards: expect.arrayContaining([
              expect.objectContaining({ front: 'Q1', back: 'A1' }),
              expect.objectContaining({ front: 'Q2', back: 'A2' }),
            ]),
          }),
        })
      );
    });

    it('should merge non-card fields in final result', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      const finalResult = {
        documentId: 'doc-final',
        progress: { stage: 'completed', completedRatio: 1 },
        ankiConnect: { available: false },
        cards: [{ front: 'Q', back: 'A' }],
      };

      handler!.onEnd!(mockStore, 'anki_cards-block-1', finalResult);

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;
      expect(toolOutput?.documentId).toBe('doc-final');
      expect(toolOutput?.progress?.stage).toBe('completed');
      expect(toolOutput?.ankiConnect?.available).toBe(false);
      expect(toolOutput?.cards?.length).toBe(1);
    });

    it('should preserve existing cards when final result has no cards (patch-only)', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      // 先追加卡片
      handler!.onChunk!(
        mockStore,
        'anki_cards-block-1',
        JSON.stringify({ front: 'Q1', back: 'A1' })
      );

      // patch-only final result（无 cards）
      handler!.onEnd!(mockStore, 'anki_cards-block-1', {
        documentId: 'doc-no-cards',
        progress: { stage: 'completed', completedRatio: 1 },
        ankiConnect: { available: true },
      });

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;

      expect(block?.status).toBe('success');
      expect(toolOutput?.documentId).toBe('doc-no-cards');
      expect(toolOutput?.progress?.stage).toBe('completed');
      expect(toolOutput?.ankiConnect?.available).toBe(true);

      // cards should be preserved
      expect(toolOutput?.cards?.length).toBe(1);
      expect(toolOutput?.cards?.[0]?.front).toBe('Q1');
    });

    it('should ignore premature end when result has no terminal signal and progress is still generating', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      mockStore.updateBlock('anki_cards-block-1', {
        toolOutput: {
          cards: [],
          progress: { stage: 'generating' },
        } as any,
        status: 'running',
      });

      handler!.onEnd!(mockStore, 'anki_cards-block-1', {
        documentId: 'doc-inflight',
        progress: { stage: 'generating' },
      });

      const block = mockStore.blocks.get('anki_cards-block-1');
      expect(block?.status).toBe('running');
      expect(mockStore.updateBlockStatus).not.toHaveBeenCalledWith('anki_cards-block-1', 'success');
    });
  });

  describe('onError', () => {
    it('should preserve cards on abort/error', () => {
      const handler = eventRegistry.get('anki_cards');

      // 创建块并添加一些卡片
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });
      handler!.onChunk!(
        mockStore,
        'anki_cards-block-1',
        JSON.stringify({ front: 'Q1', back: 'A1' })
      );

      // 触发错误
      handler!.onError!(mockStore, 'anki_cards-block-1', 'User aborted');

      // 验证错误被设置
      expect(mockStore.setBlockError).toHaveBeenCalledWith(
        'anki_cards-block-1',
        'User aborted'
      );

      // 验证卡片仍然保留（通过 updateBlock 更新 syncStatus 为 error）
      const updateBlockCalls = (mockStore.updateBlock as ReturnType<typeof vi.fn>).mock.calls;
      const lastUpdateCall = updateBlockCalls.at(-1);
      expect(lastUpdateCall?.[1]?.toolOutput?.syncStatus).toBe('error');

      const block = mockStore.blocks.get('anki_cards-block-1');
      const toolOutput = block?.toolOutput as any;
      expect(toolOutput?.cards?.length).toBe(1);
    });

    it('should set syncError in block data', () => {
      const handler = eventRegistry.get('anki_cards');
      handler!.onStart!(mockStore, 'msg-1', { blockType: 'anki_cards' });

      handler!.onError!(mockStore, 'anki_cards-block-1', 'Generation failed');

      const updateBlockCalls = (mockStore.updateBlock as ReturnType<typeof vi.fn>).mock.calls;
      const lastUpdateCall = updateBlockCalls.at(-1);
      expect(lastUpdateCall?.[1]?.toolOutput?.syncError).toBe('Generation failed');
    });
  });
});
