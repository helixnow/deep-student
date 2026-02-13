/**
 * Chat V2 - InputBar 单元测试
 *
 * 测试要点：
 * - canSend 为 false 时应该禁用发送按钮
 * - 流式时应该显示停止按钮
 * - 提交时应该调用 sendMessage
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { InputBar } from '@/chat-v2/components/InputBar';
import type { ChatStore } from '@/chat-v2/core/types';
import type { StoreApi } from 'zustand';

// Mock hooks
vi.mock('@/chat-v2/hooks/useChatStore', () => ({
  useSessionStatus: vi.fn(),
  useInputValue: vi.fn(),
  useCanSend: vi.fn(),
  useAttachments: vi.fn(),
}));

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'inputBar.placeholder': 'Type a message...',
        'inputBar.send': 'Send',
        'inputBar.stop': 'Stop',
        'inputBar.addAttachment': 'Add attachment',
        'inputBar.shortcut': 'Press Enter to send',
      };
      return translations[key] || key;
    },
  }),
}));

import {
  useSessionStatus,
  useInputValue,
  useCanSend,
  useAttachments,
} from '@/chat-v2/hooks/useChatStore';

// 创建 Mock Store
function createMockStore(overrides: Partial<ChatStore> = {}): StoreApi<ChatStore> {
  const mockStore: ChatStore = {
    sessionId: 'test-session',
    mode: 'chat',
    sessionStatus: 'idle',
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: null,
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
    canSend: vi.fn(() => true),
    canEdit: vi.fn(() => true),
    canDelete: vi.fn(() => true),
    canAbort: vi.fn(() => false),
    isBlockLocked: vi.fn(() => false),
    isMessageLocked: vi.fn(() => false),
    // Actions
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn(),
    abortStream: vi.fn(),
    createBlock: vi.fn(),
    updateBlockContent: vi.fn(),
    updateBlockStatus: vi.fn(),
    setBlockResult: vi.fn(),
    setBlockError: vi.fn(),
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
    saveSession: vi.fn(),
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn(() => []),
    getOrderedMessages: vi.fn(() => []),
    ...overrides,
  };

  return {
    getState: () => mockStore,
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    destroy: vi.fn(),
  } as unknown as StoreApi<ChatStore>;
}

describe('InputBar', () => {
  let mockStore: StoreApi<ChatStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();

    // 默认 hook 返回值
    vi.mocked(useSessionStatus).mockReturnValue('idle');
    vi.mocked(useInputValue).mockReturnValue('');
    vi.mocked(useCanSend).mockReturnValue(true);
    vi.mocked(useAttachments).mockReturnValue([]);
  });

  it('should disable send button when canSend is false', () => {
    vi.mocked(useCanSend).mockReturnValue(false);
    vi.mocked(useSessionStatus).mockReturnValue('idle');

    render(<InputBar store={mockStore} />);

    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).toBeDisabled();
  });

  it('should enable send button when canSend is true', () => {
    vi.mocked(useCanSend).mockReturnValue(true);
    vi.mocked(useSessionStatus).mockReturnValue('idle');

    render(<InputBar store={mockStore} />);

    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).not.toBeDisabled();
  });

  it('should show stop button when streaming', () => {
    vi.mocked(useSessionStatus).mockReturnValue('streaming');
    vi.mocked(useCanSend).mockReturnValue(false);

    render(<InputBar store={mockStore} />);

    const stopButton = screen.getByRole('button', { name: /stop/i });
    expect(stopButton).toBeInTheDocument();
  });

  it('should call sendMessage on submit', async () => {
    const user = userEvent.setup();
    vi.mocked(useCanSend).mockReturnValue(true);
    vi.mocked(useSessionStatus).mockReturnValue('idle');
    vi.mocked(useInputValue).mockReturnValue('');

    render(<InputBar store={mockStore} />);

    // 输入文本
    const textarea = screen.getByPlaceholderText(/type a message/i);
    await user.type(textarea, 'Hello, AI!');

    // 点击发送
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);

    // 验证调用了 sendMessage
    await waitFor(() => {
      expect(mockStore.getState().sendMessage).toHaveBeenCalled();
    });
  });

  it('should call abortStream when clicking stop during streaming', async () => {
    const user = userEvent.setup();
    vi.mocked(useSessionStatus).mockReturnValue('streaming');
    vi.mocked(useCanSend).mockReturnValue(false);

    render(<InputBar store={mockStore} />);

    const stopButton = screen.getByRole('button', { name: /stop/i });
    await user.click(stopButton);

    expect(mockStore.getState().abortStream).toHaveBeenCalled();
  });

  it('should disable textarea when streaming', () => {
    vi.mocked(useSessionStatus).mockReturnValue('streaming');
    vi.mocked(useCanSend).mockReturnValue(false);

    render(<InputBar store={mockStore} />);

    const textarea = screen.getByPlaceholderText(/type a message/i);
    // 流式输出时允许提前输入下一条消息
    expect(textarea).not.toBeDisabled();
  });
});
