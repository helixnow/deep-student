import React from 'react';
import { createStore, type StoreApi } from 'zustand';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { MessageItem } from '../MessageItem';

const displayBlockIds = ['blk_thinking', 'blk_content'];

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    initReactI18next: {
      type: '3rdParty',
      init: () => undefined,
    },
    useTranslation: () => ({
      t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
    }),
  };
});

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/features/chat/hooks/useVariantUI', () => ({
  useVariantUI: () => ({
    message: {
      id: 'msg_test',
      role: 'assistant',
      blockIds: displayBlockIds,
      timestamp: Date.now(),
      _meta: {},
      variants: [],
    },
    variants: [],
    activeVariant: undefined,
    activeVariantId: undefined,
    isMultiVariant: false,
    streamingCount: 0,
    displayBlockIds,
    sharedContext: undefined,
    getVariantBlocks: () => [],
    switchVariant: vi.fn(),
    cancelVariant: vi.fn(),
    retryVariant: vi.fn(),
    deleteVariant: vi.fn(),
    stopAllVariants: vi.fn(),
    retryAllVariants: vi.fn(),
    canSwitchTo: () => false,
    canRetry: () => false,
    canCancel: () => false,
    canDelete: () => false,
  }),
}));

vi.mock('../BlockRenderer', () => ({
  BlockRendererWithStore: ({
    store,
    blockId,
  }: {
    store: StoreApi<any>;
    blockId: string;
  }) => {
    const block = useStore(store, (state) => state.blocks.get(blockId));
    if (!block) return null;
    return <div data-testid={`block-${blockId}`}>{block.content}</div>;
  },
}));

vi.mock('../ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div>thinking-indicator</div>,
}));

vi.mock('../ui/ThreadContentShell', () => ({
  ThreadContentShell: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock('../message', () => ({
  MessageActions: () => null,
  MessageInlineEdit: () => null,
  UserMessageBubble: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../Variant', () => ({
  ParallelVariantView: () => null,
}));

vi.mock('../ContextRefsDisplay', () => ({
  ContextRefsDisplay: () => null,
  hasContextRefs: () => false,
}));

vi.mock('../panels', () => ({
  SourcePanelV2: () => null,
  hasSourcesInBlocks: () => false,
}));

vi.mock('../TokenUsageDisplay', () => ({
  TokenUsageDisplay: () => null,
}));

vi.mock('../ActivityTimeline', () => ({
  ActivityTimelineWithStore: () => null,
  isTimelineBlockType: () => false,
}));

vi.mock('@/features/chat/hooks/useImagePreviewsFromRefs', () => ({
  useImagePreviewsFromRefs: () => ({ imagePreviews: [], isLoading: false }),
}));

vi.mock('@/features/chat/hooks/useFilePreviewsFromRefs', () => ({
  useFilePreviewsFromRefs: () => ({ filePreviews: [], isLoading: false }),
}));

vi.mock('@/features/chat/hooks/useTextSelection', () => ({
  useTextSelection: () => ({
    selectedText: '',
    selectionRect: null,
    contextBefore: '',
    contextAfter: '',
    clearSelection: vi.fn(),
  }),
}));

vi.mock('../SelectionToolbar', () => ({
  SelectionToolbar: () => null,
}));

vi.mock('../TranslationPopover', () => ({
  TranslationPopover: () => null,
}));

vi.mock('../ExplainPopover', () => ({
  ExplainPopover: () => null,
}));

vi.mock('@/components/shared/AiContentLabel', () => ({
  AiContentLabel: () => null,
}));

vi.mock('@/components/ui/PulseDot', () => ({
  PulseDot: () => null,
}));

vi.mock('@/components/ui/NotionButton', () => ({
  NotionButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/features/chat/debug/chatV2Logger', () => ({
  logChatV2: vi.fn(),
}));

vi.mock('@/features/chat/debug/exportSessionDebug', () => ({
  copyDebugInfoToClipboard: vi.fn(),
}));

vi.mock('@/features/chat/hooks/useDevShowRawRequest', () => ({
  useDevShowRawRequest: () => false,
  useCopyFilterConfig: () => ({ images: 'remove', tools: 'remove', messages: 'summary', thinking: 'remove', messageTruncateLength: 200 }),
}));

vi.mock('@/features/chat/utils/contextRefPreview', () => ({
  dispatchContextRefPreview: vi.fn(),
}));

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: { createNote: vi.fn() },
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: { saveTextFile: vi.fn() },
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock('./message/variantMetaResolver', () => ({
  resolveSingleVariantDisplayMeta: () => ({ resolvedUsage: undefined, resolvedModelId: undefined }),
}));

vi.mock('@/utils/formatUtils', () => ({
  getModelDisplayName: () => '',
  formatMessageTime: () => '',
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/errorUtils', () => ({
  getErrorMessage: (error: unknown) => String(error),
}));

vi.mock('@/features/chat/debug/sessionSwitchPerf', () => ({
  sessionSwitchPerf: {
    mark: vi.fn(),
  },
}));

interface TestBlock {
  id: string;
  type: 'thinking' | 'content';
  content: string;
  status: 'success' | 'running' | 'pending';
  messageId: string;
}

interface TestState {
  sessionStatus: 'idle' | 'streaming' | 'sending' | 'aborting';
  activeBlockIds: Set<string>;
  blocks: Map<string, TestBlock>;
}

function createMessageItemStore() {
  return createStore<TestState>(() => ({
    sessionStatus: 'idle',
    activeBlockIds: new Set(),
    blocks: new Map<string, TestBlock>([
      [
        'blk_thinking',
        {
          id: 'blk_thinking',
          type: 'thinking',
          content: 'thinking text',
          status: 'success',
          messageId: 'msg_test',
        },
      ],
      [
        'blk_content',
        {
          id: 'blk_content',
          type: 'content',
          content: '',
          status: 'success',
          messageId: 'msg_test',
        },
      ],
    ]),
  }));
}

describe('MessageItem streaming content visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders late-arriving content when only the block content changes', async () => {
    const store = createMessageItemStore();

    render(<MessageItem messageId="msg_test" store={store as unknown as StoreApi<any>} />);

    expect(screen.getByText('thinking text')).toBeInTheDocument();
    expect(screen.queryByText('final answer')).toBeNull();

    store.setState((state) => ({
      ...state,
      blocks: new Map(state.blocks).set('blk_content', {
        ...state.blocks.get('blk_content')!,
        content: 'final answer',
      }),
    }));

    await waitFor(() => {
      expect(screen.getByText('final answer')).toBeInTheDocument();
    });
  });
});
