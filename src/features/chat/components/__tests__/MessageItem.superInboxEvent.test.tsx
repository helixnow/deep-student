import React from 'react';
import { createStore, type StoreApi } from 'zustand';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { MessageItem } from '../MessageItem';

const displayBlockIds = ['blk_user'];
const testMeta = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/features/chat/superSession/SuperInboxEventCard', () => ({
  SuperInboxEventMessage: ({ messageId }: { messageId: string }) => (
    <div data-testid="super-inbox-event-message">{messageId}</div>
  ),
}));

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
      i18n: { resolvedLanguage: 'en', language: 'en' },
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
      role: 'user',
      blockIds: displayBlockIds,
      timestamp: Date.now(),
      _meta: testMeta.current,
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
  MessageActions: () => <div data-testid="message-actions">message-actions</div>,
  MessageInlineEdit: () => null,
  UserMessageBubble: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../Variant', () => ({
  ParallelVariantView: () => null,
}));

vi.mock('../ContextRefsDisplay', () => ({
  ContextRefsDisplay: () => null,
  hasContextRefs: () => false,
  CONTEXT_REFS_VISIBLE_COUNT: 8,
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

vi.mock('@/components/ui/DsButton', () => ({
  DsButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
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
  formatMessageTime: () => '17:21',
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

function createStoreWithUserMessage() {
  return createStore(() => ({
    sessionStatus: 'idle',
    activeBlockIds: new Set<string>(),
    sessionId: 'sess_super',
    mode: 'chat',
    sessionMetadata: { super_agent: { active: true } },
    blocks: new Map([
      ['blk_user', { id: 'blk_user', type: 'content', content: 'user typed text', status: 'success', messageId: 'msg_test' }],
    ]),
  }));
}

describe('MessageItem super inbox event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the inbox event card instead of the user bubble when _meta.inboundOrigin is set', () => {
    testMeta.current = { inboundOrigin: { items: [{ kind: 'worker', status: 'completed', title: 'x' }] } };
    render(<MessageItem messageId="msg_test" store={createStoreWithUserMessage() as unknown as StoreApi<any>} />);
    expect(screen.getByTestId('super-inbox-event-message')).toHaveTextContent('msg_test');
    expect(screen.queryByText('user typed text')).toBeNull();
    expect(screen.queryByTestId('message-actions')).toBeNull();
  });

  it('keeps the normal user bubble for regular user messages', () => {
    testMeta.current = {};
    render(<MessageItem messageId="msg_test" store={createStoreWithUserMessage() as unknown as StoreApi<any>} />);
    expect(screen.queryByTestId('super-inbox-event-message')).toBeNull();
    expect(screen.getByText('user typed text')).toBeInTheDocument();
  });
});
