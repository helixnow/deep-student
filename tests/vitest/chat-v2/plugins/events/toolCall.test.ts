/**
 * Chat V2 - toolCall 事件处理插件单元测试
 *
 * 测试 tool_call 和 image_gen 事件处理器
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';
import type { ChatStore } from '@/chat-v2/core/types';

// 导入插件（触发自动注册）
import '@/chat-v2/plugins/events/toolCall';

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockStore(): ChatStore {
  return {
    sessionId: 'test-session',
    mode: 'chat',
    sessionStatus: 'streaming',
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: 'msg-1',
    activeBlockIds: new Set(),
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
    createBlock: vi.fn(() => 'mcp-tool-block-1'),
    updateBlockContent: vi.fn(),
    updateBlockStatus: vi.fn(),
    setBlockResult: vi.fn(),
    setBlockError: vi.fn(),
    updateBlock: vi.fn(),
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
  } as unknown as ChatStore;
}

// ============================================================================
// tool_call 事件处理器测试
// ============================================================================

describe('ToolCallEventHandler', () => {
  let mockStore: ChatStore;

  beforeEach(() => {
    mockStore = createMockStore();
    vi.clearAllMocks();
  });

  it('should be registered in eventRegistry', () => {
    expect(eventRegistry.has('tool_call')).toBe(true);
  });

  describe('onStart', () => {
    it('should create mcp_tool block with toolName and toolInput', () => {
      const handler = eventRegistry.get('tool_call');
      expect(handler).toBeDefined();
      expect(handler!.onStart).toBeDefined();

      const payload = {
        blockType: 'mcp_tool',
        toolName: 'read_file',
        toolInput: { path: '/test/file.txt' },
      };

      const blockId = handler!.onStart!(mockStore, 'msg-1', payload);

      // 验证创建了 mcp_tool 块
      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'mcp_tool');
      expect(blockId).toBe('mcp-tool-block-1');

      // 验证设置了工具信息
      expect(mockStore.updateBlock).toHaveBeenCalledWith(
        'mcp-tool-block-1',
        expect.objectContaining({
          toolName: 'read_file',
          toolInput: { path: '/test/file.txt' },
        })
      );
    });

    it('should return the created block id', () => {
      const handler = eventRegistry.get('tool_call');
      const payload = {
        blockType: 'mcp_tool',
        toolName: 'execute_code',
        toolInput: { code: 'print("hello")' },
      };

      const blockId = handler!.onStart!(mockStore, 'msg-1', payload);
      expect(blockId).toBe('mcp-tool-block-1');
    });
  });

  describe('onChunk', () => {
    it('should update content on chunk (streaming output like stdout)', () => {
      const handler = eventRegistry.get('tool_call');
      expect(handler!.onChunk).toBeDefined();

      handler!.onChunk!(mockStore, 'mcp-tool-block-1', 'Hello from stdout');

      expect(mockStore.updateBlockContent).toHaveBeenCalledWith(
        'mcp-tool-block-1',
        'Hello from stdout'
      );
    });

    it('should accumulate multiple chunks', () => {
      const handler = eventRegistry.get('tool_call');

      handler!.onChunk!(mockStore, 'mcp-tool-block-1', 'Line 1\n');
      handler!.onChunk!(mockStore, 'mcp-tool-block-1', 'Line 2\n');

      expect(mockStore.updateBlockContent).toHaveBeenCalledTimes(2);
    });
  });

  describe('onEnd', () => {
    it('should set toolOutput on end', () => {
      const handler = eventRegistry.get('tool_call');
      expect(handler!.onEnd).toBeDefined();

      const result = { success: true, data: 'file content here' };
      handler!.onEnd!(mockStore, 'mcp-tool-block-1', result);

      expect(mockStore.setBlockResult).toHaveBeenCalledWith('mcp-tool-block-1', result);
    });

    it('should handle undefined result', () => {
      const handler = eventRegistry.get('tool_call');
      handler!.onEnd!(mockStore, 'mcp-tool-block-1', undefined);

      expect(mockStore.setBlockResult).toHaveBeenCalledWith('mcp-tool-block-1', undefined);
    });
  });

  describe('onError', () => {
    it('should set error on block', () => {
      const handler = eventRegistry.get('tool_call');
      expect(handler!.onError).toBeDefined();

      handler!.onError!(mockStore, 'mcp-tool-block-1', 'Tool execution failed');

      expect(mockStore.setBlockError).toHaveBeenCalledWith(
        'mcp-tool-block-1',
        'Tool execution failed'
      );
    });
  });
});

// ============================================================================
// image_gen 事件处理器测试
// ============================================================================

describe('ImageGenEventHandler', () => {
  let mockStore: ChatStore;

  beforeEach(() => {
    mockStore = createMockStore();
    // 为 image_gen 块返回不同的 ID
    (mockStore.createBlock as ReturnType<typeof vi.fn>).mockReturnValue('image-gen-block-1');
    vi.clearAllMocks();
  });

  it('should be registered in eventRegistry', () => {
    expect(eventRegistry.has('image_gen')).toBe(true);
  });

  describe('onStart', () => {
    it('should create image_gen block with prompt', () => {
      const handler = eventRegistry.get('image_gen');
      expect(handler).toBeDefined();
      expect(handler!.onStart).toBeDefined();

      const payload = {
        blockType: 'image_gen',
        prompt: 'A beautiful sunset over the ocean',
        width: 1024,
        height: 768,
        model: 'dall-e-3',
      };

      const blockId = handler!.onStart!(mockStore, 'msg-1', payload);

      // 验证创建了 image_gen 块
      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'image_gen');
      expect(blockId).toBe('image-gen-block-1');

      // 验证设置了输入信息
      expect(mockStore.updateBlock).toHaveBeenCalledWith('image-gen-block-1', {
        toolInput: {
          prompt: 'A beautiful sunset over the ocean',
          width: 1024,
          height: 768,
          model: 'dall-e-3',
        },
      });
    });
  });

  describe('onChunk', () => {
    it('should not do anything on chunk (image gen has no streaming)', () => {
      const handler = eventRegistry.get('image_gen');
      expect(handler!.onChunk).toBeDefined();

      // 调用 onChunk 应该不会抛出错误，但也不会有任何操作
      handler!.onChunk!(mockStore, 'image-gen-block-1', 'some progress data');

      // 图片生成不使用流式内容更新
      expect(mockStore.updateBlockContent).not.toHaveBeenCalled();
    });
  });

  describe('onEnd', () => {
    it('should set image result on end', () => {
      const handler = eventRegistry.get('image_gen');
      expect(handler!.onEnd).toBeDefined();

      const result = {
        imageUrl: 'https://example.com/generated-image.png',
        width: 1024,
        height: 768,
        model: 'dall-e-3',
        prompt: 'A beautiful sunset over the ocean',
      };

      handler!.onEnd!(mockStore, 'image-gen-block-1', result);

      expect(mockStore.setBlockResult).toHaveBeenCalledWith('image-gen-block-1', result);
    });
  });

  describe('onError', () => {
    it('should set error on block', () => {
      const handler = eventRegistry.get('image_gen');
      expect(handler!.onError).toBeDefined();

      handler!.onError!(mockStore, 'image-gen-block-1', 'Image generation failed: rate limit');

      expect(mockStore.setBlockError).toHaveBeenCalledWith(
        'image-gen-block-1',
        'Image generation failed: rate limit'
      );
    });
  });
});
