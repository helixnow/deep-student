/**
 * Chat V2 - AnkiCardsBlock 单元测试（当前实现）
 *
 * 目标：
 * - 确保 blockRegistry 注册正常
 * - 预览组件接收正确的 status/cards
 * - 有卡片时渲染操作按钮，并在流式时禁用
 * - 点击预览/编辑会展开内联编辑器
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/features/chat/core/types';
import type { AnkiCardsBlockData } from '@/features/chat/plugins/blocks/ankiCardsBlock';
import { blockRegistry } from '@/features/chat/registry';

// Mock i18n（仅覆盖本组件使用的 key）
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const dict: Record<string, string> = {
        'blocks.ankiCards.edit': 'Edit',
        'blocks.ankiCards.save': 'Save',
        'blocks.ankiCards.addToLibrary': 'Add to card library',
        'blocks.ankiCards.addedToLibrary': 'Added to card library',
        'blocks.ankiCards.export': 'Export',
        'blocks.ankiCards.sync': 'Sync',
        'blocks.ankiCards.moreActions': 'More card actions',
        'blocks.ankiCards.reviewBatch': 'Review batch',
        'blocks.ankiCards.reviewBatchNeedsRealIds': 'Save every card to get real IDs before reviewing',
        'blocks.ankiCards.retryFailedSegments': 'Retry failed segments',
        'blocks.ankiCards.progress.segments.completedWithErrors': 'Completed with some failed segments',
        'blocks.ankiCards.progress.ankiConnect.refresh': 'Refresh AnkiConnect status',
        'blocks.ankiCards.progress.ankiConnect.checking': 'checking',
        'blocks.ankiCards.progress.ankiConnect.notConnected': 'not connected',
      };
      if (dict[key]) return dict[key];
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
  // Some modules initialize i18n in test environment and expect this export.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const mockSaveCardsToLibrary = vi.fn(async (..._args: unknown[]): Promise<any> => undefined);
const mockExportCardsAsApkg = vi.fn(async () => undefined);
const mockImportCardsViaAnkiConnect = vi.fn(async () => undefined);
const mockLogChatAnkiEvent = vi.fn();
const mockInvoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
const mockWorkbenchActivate = vi.fn(async () => ({ delivered: true, result: { handled: true } }));

vi.mock('@/features/chat/anki', () => ({
  saveCardsToLibrary: (...args: unknown[]) => mockSaveCardsToLibrary(...args),
  exportCardsAsApkg: (...args: unknown[]) => mockExportCardsAsApkg(...args),
  importCardsViaAnkiConnect: (...args: unknown[]) => mockImportCardsViaAnkiConnect(...args),
  logChatAnkiEvent: (...args: unknown[]) => mockLogChatAnkiEvent(...args),
  AnkiCardStackPreview: ({ status, cards, onClick, errorMessage }: any) => (
    <div>
      <button
        type="button"
        data-testid="anki-preview"
        data-status={status}
        data-count={cards?.length ?? 0}
        onClick={onClick}
      >
        preview
      </button>
      {errorMessage && <span data-testid="anki-preview-error">{errorMessage}</span>}
    </div>
  ),
  FullWidthCardWrapper: ({ children, className }: any) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    activate: (...args: unknown[]) => mockWorkbenchActivate(...args),
  },
}));

// 在 mocks 之后导入（触发注册）
import {
  AnkiCardsBlock,
  resolveZombieCompletionState,
} from '@/features/chat/plugins/blocks/ankiCardsBlock';
import { resetAnkiBlockUiState } from '@/features/chat/plugins/blocks/components/ankiCardsBlockState';

function createBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'anki-block-1',
    type: 'anki_cards',
    status: 'pending',
    messageId: 'msg-1',
    ...overrides,
  };
}

function createData(overrides?: Partial<AnkiCardsBlockData>): AnkiCardsBlockData {
  return {
    cards: [
      { id: 'card-1', front: 'Q1', back: 'A1' } as any,
      { id: 'card-2', front: 'Q2', back: 'A2' } as any,
    ],
    syncStatus: 'pending',
    templateId: undefined,
    businessSessionId: 'sess-1',
    messageStableId: 'stable-1',
    ...overrides,
  };
}

describe('AnkiCardsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveCardsToLibrary.mockReset();
    mockSaveCardsToLibrary.mockResolvedValue(undefined);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    // UI 状态（展开/编辑/多选）挂在模块级 Map（按 blockId），
    // 用例间复用同一 blockId，必须重置避免串状态。
    resetAnkiBlockUiState();
  });

  it('should be registered in blockRegistry', async () => {
    await import('@/features/chat/plugins/blocks/ankiCardsBlock');
    expect(blockRegistry.has('anki_cards')).toBe(true);
    expect(blockRegistry.get('anki_cards')?.onAbort).toBe('keep-content');
  });

  it('keeps watchdog partial completion as a successful block with an error-aware final status', () => {
    expect(resolveZombieCompletionState(['completed', 'failed', 'truncated'], [{}])).toEqual({
      finalStatus: 'completed_with_errors',
      blockStatus: 'success',
    });
    expect(resolveZombieCompletionState(['completed', 'completed'], [{}])).toEqual({
      finalStatus: 'completed',
      blockStatus: 'success',
    });
    expect(resolveZombieCompletionState(['failed', 'truncated'], [
      {},
      { is_error_card: true },
    ])).toEqual({
      finalStatus: 'completed_with_errors',
      blockStatus: 'success',
    });
  });

  it('keeps watchdog zero-card failure, cancellation, and unknown states as errors', () => {
    expect(resolveZombieCompletionState(['failed', 'truncated'])).toEqual({
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogFailedWithoutCards',
    });
    expect(resolveZombieCompletionState(['cancelled'])).toEqual({
      finalStatus: 'cancelled',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCancelledWithoutCards',
    });
    expect(resolveZombieCompletionState(['mystery'])).toEqual({
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogUnknownWithoutCards',
    });
    expect(resolveZombieCompletionState(['completed'])).toEqual({
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCompletedWithoutCards',
    });
    expect(resolveZombieCompletionState(['completed'], [
      { is_error_card: true },
      { isErrorCard: true },
    ])).toEqual({
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCompletedWithoutCards',
    });
    expect(resolveZombieCompletionState(['failed'], [
      { is_error_card: true },
      { isErrorCard: true },
    ])).toEqual({
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogFailedWithoutCards',
    });
  });

  it('should pass preview status "parsing" when pending', () => {
    const block = createBlock({ status: 'pending' });
    const data = createData({ cards: [] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'parsing');
    expect(preview).toHaveAttribute('data-count', '0');
  });

  it('should pass preview status "ready" when running with cards', () => {
    const block = createBlock({ status: 'running' });
    const data = createData();

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} isStreaming={true} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'ready');
    expect(preview).toHaveAttribute('data-count', '2');
  });

  it('should pass preview status "stored" when synced', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ syncStatus: 'synced' });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'stored');
  });

  it('should pass preview status "ready" when success but not synced', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ syncStatus: 'pending' });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'ready');
  });

  it('should pass preview status "error" when syncStatus is error (even if block is success)', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ syncStatus: 'error', syncError: 'Sync failed' });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'error');
  });

  it('should pass preview status "cancelled" when finalStatus is cancelled', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ finalStatus: 'cancelled' });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'cancelled');
  });

  it('should pass preview status "error" when block status is error and keep action buttons enabled', () => {
    const block = createBlock({ status: 'error', error: 'Generation failed' });
    const data = createData({ syncStatus: 'pending' });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const preview = screen.getByTestId('anki-preview');
    expect(preview).toHaveAttribute('data-status', 'error');

    // Error 状态但有卡片时，操作按钮不应被错误地禁用（只有流式时才禁用）
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add to card library' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'More card actions' }));
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeEnabled();
    // 未提供 ankiConnect 状态时，同步按钮应禁用
    expect(screen.getByRole('menuitem', { name: 'Sync · checking' })).toBeDisabled();
  });

  it('should keep browsing unlocked while streaming but gate batch delivery actions', () => {
    const block = createBlock({ status: 'running' });
    const data = createData();

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} isStreaming={true} />);

    // 生成中允许展开浏览（按动作粒度解锁）
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    // 整批交付动作（加入卡片库/导出/同步）仍等终态
    expect(screen.getByRole('button', { name: 'Add to card library' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'More card actions' }));
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Sync · checking' })).toBeDisabled();
  });

  it('should disable batch review when any card is missing a real id', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [
        { id: 'card-1', front: 'Q1', back: 'A1' } as any,
        { front: 'Q2', back: 'A2' } as any,
      ],
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const reviewButton = screen.getByRole('button', { name: 'Review batch' });
    expect(reviewButton).toBeDisabled();
    expect(reviewButton).toHaveAttribute(
      'title',
      'Save every card to get real IDs before reviewing',
    );
    fireEvent.click(reviewButton);
    expect(mockWorkbenchActivate).not.toHaveBeenCalled();
  });

  it.each(['anki_synthetic_msg-1-0', 'chat-batch-anki-block-1-0'])(
    'should disable batch review for non-persisted id %s',
    (syntheticId) => {
      const block = createBlock({ status: 'success' });
      const data = createData({
        cards: [{ id: syntheticId, front: 'Q1', back: 'A1' } as any],
      });

      render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

      const reviewButton = screen.getByRole('button', { name: 'Review batch' });
      expect(reviewButton).toBeDisabled();
      expect(reviewButton).toHaveAttribute(
        'title',
        'Save every card to get real IDs before reviewing',
      );
      fireEvent.click(reviewButton);
      expect(mockWorkbenchActivate).not.toHaveBeenCalled();
    },
  );

  it('should activate batch review only with the cards real ids', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [
        { id: 'card-1', front: 'Q1', back: 'A1' } as any,
        { id: 'card-2', front: 'Q2', back: 'A2' } as any,
      ],
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const reviewButton = screen.getByRole('button', { name: 'Review batch' });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);

    expect(mockWorkbenchActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        typeId: 'flashcards',
        action: 'startReview',
        payload: {
          screen: 'session',
          mode: 'batch',
          cardIds: ['card-1', 'card-2'],
          cards: [
            {
              id: 'card-1',
              ankiCardId: 'card-1',
              front: 'Q1',
              back: 'A1',
              tags: undefined,
            },
            {
              id: 'card-2',
              ankiCardId: 'card-2',
              front: 'Q2',
              back: 'A2',
              tags: undefined,
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(mockWorkbenchActivate.mock.calls[0])).not.toContain('chat-batch-');
  });

  it('persists durable ids after save and reviews the updated batch', async () => {
    const staleData = createData({
      cards: [
        { id: 'anki_synthetic_msg-1-0', front: 'Q1', back: 'A1' } as any,
        { front: 'Q2', back: 'A2' } as any,
      ],
    });
    const latestData = createData({
      ...staleData,
      cards: [
        ...staleData.cards,
        { id: 'streamed-real-id', front: 'Q3-streamed', back: 'A3-streamed' } as any,
      ],
      progress: { cardsGenerated: 3, stage: 'completed' } as any,
    });
    const block = createBlock({ status: 'success' });
    let storeBlock: Block = { ...block, toolOutput: latestData };
    const updateBlock = vi.fn((blockId: string, patch: Partial<Block>) => {
      expect(blockId).toBe(block.id);
      storeBlock = { ...storeBlock, ...patch };
    });
    const store = {
      getState: () => ({
        blocks: new Map([[block.id, storeBlock]]),
        updateBlock,
      }),
    } as any;
    mockSaveCardsToLibrary.mockResolvedValue({
      success: true,
      savedCount: 2,
      savedIds: ['durable-1', 'durable-2'],
      cardIdMappings: [
        {
          inputIndex: 0,
          inputId: 'anki_synthetic_msg-1-0',
          persistedId: 'durable-1',
        },
        { inputIndex: 1, inputId: null, persistedId: 'durable-2' },
      ],
    });

    const view = render(
      <AnkiCardsBlock block={{ ...block, toolOutput: staleData }} store={store} />,
    );
    expect(screen.getByRole('button', { name: 'Review batch' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add to card library' }));
    await waitFor(() => expect(updateBlock).toHaveBeenCalledTimes(1));

    const persistedData = storeBlock.toolOutput as AnkiCardsBlockData;
    expect(persistedData.cards).toEqual([
      expect.objectContaining({ id: 'durable-1', front: 'Q1' }),
      expect.objectContaining({ id: 'durable-2', front: 'Q2' }),
      expect.objectContaining({ id: 'streamed-real-id', front: 'Q3-streamed' }),
    ]);
    expect(persistedData.progress).toEqual(
      expect.objectContaining({ cardsGenerated: 3, stage: 'completed' }),
    );

    const persistenceCall = mockInvoke.mock.calls.find(
      ([command]) => command === 'chat_v2_update_block_tool_output',
    );
    expect(persistenceCall).toBeDefined();
    const serialized = (persistenceCall?.[1] as { toolOutputJson: string }).toolOutputJson;
    expect(serialized).not.toContain('anki_synthetic_');
    expect(serialized).not.toContain('chat-batch-');
    expect(JSON.parse(serialized).cards.map((card: { id: string }) => card.id)).toEqual([
      'durable-1',
      'durable-2',
      'streamed-real-id',
    ]);

    view.rerender(<AnkiCardsBlock block={storeBlock} store={store} />);
    const reviewButton = screen.getByRole('button', { name: 'Review batch' });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);

    expect(mockWorkbenchActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'startReview',
        payload: expect.objectContaining({
          cardIds: ['durable-1', 'durable-2', 'streamed-real-id'],
        }),
      }),
    );
    expect(JSON.stringify(mockWorkbenchActivate.mock.calls.at(-1))).not.toContain('anki_synthetic_');
    expect(JSON.stringify(mockWorkbenchActivate.mock.calls.at(-1))).not.toContain('chat-batch-');
  });

  it('keeps synthetic ids and batch review disabled when durable-id persistence fails', async () => {
    const staleData = createData({
      cards: [{ id: 'anki_synthetic_msg-1-0', front: 'Q1', back: 'A1' } as any],
    });
    const block = createBlock({ status: 'success' });
    let storeBlock: Block = { ...block, toolOutput: staleData };
    const updateBlock = vi.fn((blockId: string, patch: Partial<Block>) => {
      storeBlock = { ...storeBlock, ...patch };
    });
    const store = {
      getState: () => ({
        blocks: new Map([[block.id, storeBlock]]),
        updateBlock,
      }),
    } as any;
    mockSaveCardsToLibrary.mockResolvedValue({
      success: true,
      savedCount: 1,
      savedIds: ['durable-1'],
      cardIdMappings: [
        {
          inputIndex: 0,
          inputId: 'anki_synthetic_msg-1-0',
          persistedId: 'durable-1',
        },
      ],
    });
    mockInvoke.mockImplementation(async (command: unknown) => {
      if (command === 'chat_v2_update_block_tool_output') {
        throw new Error('synthetic persistence failure');
      }
      return undefined;
    });

    const view = render(
      <AnkiCardsBlock block={{ ...block, toolOutput: staleData }} store={store} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to card library' }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'chat_v2_update_block_tool_output',
        expect.objectContaining({ blockId: block.id }),
      ),
    );
    expect(updateBlock).not.toHaveBeenCalled();
    expect((storeBlock.toolOutput as AnkiCardsBlockData).cards[0].id).toBe(
      'anki_synthetic_msg-1-0',
    );

    view.rerender(<AnkiCardsBlock block={storeBlock} store={store} />);
    const reviewButton = screen.getByRole('button', { name: 'Review batch' });
    expect(reviewButton).toBeDisabled();
    fireEvent.click(reviewButton);
    expect(mockWorkbenchActivate).not.toHaveBeenCalled();
  });

  it('should expand inline editor when preview clicked', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ cards: [{ id: 'card-1', front: 'Q1', back: 'A1' } as any] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    fireEvent.click(screen.getByTestId('anki-preview'));

    expect(screen.queryByTestId('anki-preview')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'blocks.ankiCards.collapse' }).length).toBeGreaterThan(0);
  });

  it('should render progress and AnkiConnect status when provided', () => {
    const block = createBlock({ status: 'running' });
    const data = createData({
      cards: [],
      progress: { message: 'Routing...', completedRatio: 0.25, cardsGenerated: 10 } as any,
      ankiConnect: { available: false } as any,
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('chatanki-progress')).toBeInTheDocument();
    expect(screen.getByTestId('chatanki-progress-anki-connect')).toBeInTheDocument();
    expect(screen.getByTestId('chatanki-progress-percent')).toHaveTextContent('25%');
    expect(screen.getByTestId('chatanki-progress-metrics')).toHaveTextContent('10');
    expect(screen.getByTestId('chatanki-progress-message')).toHaveTextContent('Routing...');
    expect(
      screen.getByRole('button', { name: 'Refresh AnkiConnect status' }),
    ).toHaveClass('!h-10', '!w-10');
  });

  it('only shows importing when the selected route uses an import phase', () => {
    const block = createBlock({ status: 'running' });
    const simpleData = createData({
      cards: [],
      progress: { stage: 'generating', route: 'simple_text' },
    });
    const view = render(<AnkiCardsBlock block={{ ...block, toolOutput: simpleData }} />);

    expect(screen.queryByTestId('chatanki-progress-step-importing')).not.toBeInTheDocument();
    expect(screen.getByTestId('chatanki-progress-step-generating')).toBeInTheDocument();

    const visionData = createData({
      cards: [],
      progress: { stage: 'generating', route: 'vlm_light' },
    });
    view.rerender(<AnkiCardsBlock block={{ ...block, toolOutput: visionData }} />);

    expect(screen.getByTestId('chatanki-progress-step-importing')).toBeInTheDocument();
  });

  it('does not mark or render unreached phases after an early failure', () => {
    const block = createBlock({ status: 'error', error: 'Routing failed' });
    const data = createData({
      cards: [],
      progress: { stage: 'failed', route: 'simple_text', completedRatio: 0 },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('chatanki-progress-step-routing')).toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-progress-step-generating')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-progress-step-completed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-progress-step-failed')).not.toBeInTheDocument();
  });

  it('renders a workflow error once when the progress summary is visible', () => {
    const block = createBlock({ status: 'error', error: 'Generation failed' });
    const data = createData({
      cards: [{ id: 'card-1', front: 'Q1', back: 'A1' } as any],
      progress: { stage: 'failed', completedRatio: 0.5 },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('chatanki-progress-error')).toHaveTextContent('Generation failed');
    expect(screen.queryByTestId('anki-preview-error')).not.toBeInTheDocument();
    expect(screen.getAllByText('Generation failed')).toHaveLength(1);
  });

  it('should render warnings when progress is available', () => {
    const block = createBlock({ status: 'running' });
    const data = createData({
      cards: [],
      progress: { message: 'Generating...' } as any,
      warnings: [{ code: 'truncated', message: 'Some cards were truncated.' }],
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('chatanki-progress-warnings')).toHaveTextContent('Some cards were truncated.');
  });

  it('should not render progress widget when no progress or AnkiConnect data', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ cards: [], documentId: 'doc-123', progress: undefined, ankiConnect: undefined });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.queryByTestId('chatanki-progress')).not.toBeInTheDocument();
  });

  it('should inspect document tasks only after a document enters a terminal or error state', async () => {
    const runningBlock = createBlock({ status: 'running' });
    const runningData = createData({
      cards: [],
      documentId: 'doc-running',
      progress: {
        stage: 'generating',
        counts: { total: 2, processing: 2, failed: 0, truncated: 0 },
      },
    });

    const { unmount } = render(
      <AnkiCardsBlock block={{ ...runningBlock, toolOutput: runningData }} />,
    );

    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalledWith('get_document_tasks', expect.anything());
    });
    unmount();

    render(
      <AnkiCardsBlock
        block={{
          ...createBlock({ status: 'error' }),
          toolOutput: createData({ cards: [], documentId: undefined, progress: { stage: 'failed' } }),
        }}
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalledWith('get_document_tasks', expect.anything());
    });
  });

  it('should not show retry when the terminal document has no failed or truncated tasks', async () => {
    mockInvoke.mockImplementation(async (command: unknown) => {
      if (command === 'get_document_tasks') {
        return [{ id: 'task-completed', status: 'Completed' }];
      }
      return undefined;
    });
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [],
      documentId: 'doc-completed',
      progress: { stage: 'completed' },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_document_tasks', {
        documentId: 'doc-completed',
      });
    });
    expect(
      screen.queryByRole('button', { name: 'Retry failed segments' }),
    ).not.toBeInTheDocument();
  });

  it('should retry real failed task ids once and keep completed_with_errors on the completed step', async () => {
    let releaseRetries: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetries = resolve;
    });
    mockInvoke.mockImplementation(async (command: unknown) => {
      if (command === 'get_document_tasks') {
        return [
          { id: 'task-failed', status: 'Failed' },
          { id: 'task-completed', status: 'Completed' },
          { id: 'task-truncated', status: 'Truncated' },
        ];
      }
      if (command === 'trigger_task_processing') {
        return retryGate;
      }
      return undefined;
    });
    const block = createBlock({ status: 'error' });
    const data = createData({
      cards: [],
      documentId: 'doc-partial',
      finalStatus: 'error',
      progress: {
        stage: 'completed_with_errors',
        completedRatio: 0.5,
        counts: { total: 2, completed: 1, failed: 1, truncated: 1 },
      },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const retryButton = await screen.findByRole('button', { name: 'Retry failed segments' });
    expect(screen.getByTestId('chatanki-progress-step-completed')).toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-progress-step-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('chatanki-progress-completed-with-errors')).toHaveTextContent(
      'Completed with some failed segments',
    );

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => {
      const triggerCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === 'trigger_task_processing',
      );
      expect(triggerCalls).toEqual([
        ['trigger_task_processing', { taskId: 'task-failed' }],
        ['trigger_task_processing', { taskId: 'task-truncated' }],
      ]);
    });
    expect(retryButton).toBeDisabled();

    releaseRetries();
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry failed segments' }),
      ).not.toBeInTheDocument();
    });
  });

  it('should keep only retry submissions that failed in an actionable error state', async () => {
    mockInvoke.mockImplementation(async (command: unknown, args?: unknown) => {
      if (command === 'get_document_tasks') {
        return [
          { id: 'task-failed', status: 'Failed' },
          { id: 'task-truncated', status: 'Truncated' },
        ];
      }
      if (command === 'trigger_task_processing') {
        const taskId = (args as { taskId?: string } | undefined)?.taskId;
        if (taskId === 'task-truncated') throw new Error('queue unavailable');
      }
      return undefined;
    });
    const block = createBlock({ status: 'error' });
    const data = createData({
      cards: [],
      documentId: 'doc-partial-retry',
      progress: { stage: 'completed_with_errors' },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    const retryButton = await screen.findByRole('button', { name: 'Retry failed segments' });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByTestId('chatanki-retry-failed-segments-error')).toHaveTextContent(
        'queue unavailable',
      );
    });
    expect(retryButton).toBeEnabled();

    fireEvent.click(retryButton);
    await waitFor(() => {
      const retriedTaskIds = mockInvoke.mock.calls
        .filter(([command]) => command === 'trigger_task_processing')
        .map(([, args]) => (args as { taskId: string }).taskId);
      expect(retriedTaskIds).toEqual([
        'task-failed',
        'task-truncated',
        'task-truncated',
      ]);
    });
  });

  it('should render editable fields from card.fields and persist field edits', async () => {
    const updateBlock = vi.fn();
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [
        {
          id: 'card-1',
          front: '{"Question":"旧问题","optiona":"A","optionb":"B","correct":"B"}',
          back: 'A. A\nB. B',
          fields: {
            Question: '旧问题',
            optiona: 'A',
            optionb: 'B',
            correct: 'B',
          },
          tags: ['biology'],
        } as any,
      ],
    });
    const blockWithOutput = { ...block, toolOutput: data };
    const store = {
      getState: () => ({
        blocks: new Map([[block.id, blockWithOutput]]),
        updateBlock,
      }),
    } as any;

    render(<AnkiCardsBlock block={blockWithOutput} store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByText('{"Question":"旧问题","optiona":"A","optionb":"B","correct":"B"}'));

    expect(screen.getByDisplayValue('旧问题')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('B').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByDisplayValue('旧问题'), {
      target: { value: '新问题' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'chatV2.saveEdit' }));

    await waitFor(() => {
      expect(updateBlock).toHaveBeenCalledWith(
        'anki-block-1',
        expect.objectContaining({
          toolOutput: expect.objectContaining({
            cards: [
              expect.objectContaining({
                fields: expect.objectContaining({
                  Question: '新问题',
                  optiona: 'A',
                  optionb: 'B',
                }),
              }),
            ],
          }),
        })
      );
    });
    expect(mockInvoke).toHaveBeenCalledWith('update_anki_card', expect.objectContaining({
      card: expect.objectContaining({ id: 'card-1' }),
    }));
  });

  it('should merge card edits from latest store cards so streaming new cards are not overwritten', async () => {
    const updateBlock = vi.fn();
    // Use success so action buttons are enabled; store still holds fresher streamed cards
    // than the stale render closure (simulates race with concurrent store updates).
    const block = createBlock({ status: 'success' });
    const staleData = createData({
      cards: [{ id: 'card-1', front: 'Q1', back: 'A1' } as any],
    });
    const fresherData = createData({
      cards: [
        { id: 'card-1', front: 'Q1', back: 'A1' } as any,
        { id: 'card-2', front: 'Q2-streamed', back: 'A2-streamed' } as any,
      ],
      progress: { cardsGenerated: 2, stage: 'generating' } as any,
    });

    // Mutable store: render sees stale props/closure, but getState returns fresher cards
    let storeBlock: Block = { ...block, toolOutput: staleData };
    const store = {
      getState: () => ({
        blocks: new Map([[block.id, storeBlock]]),
        updateBlock,
      }),
    } as any;

    render(<AnkiCardsBlock block={{ ...block, toolOutput: staleData }} store={store} />);

    // Expand + enter edit on the only card visible from stale props
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByText('Q1'));

    // Simulate streaming update landing in store while editor still holds stale closure
    storeBlock = { ...block, toolOutput: fresherData };

    fireEvent.change(screen.getByDisplayValue('Q1'), {
      target: { value: 'Q1-edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'chatV2.saveEdit' }));

    await waitFor(() => {
      expect(updateBlock).toHaveBeenCalled();
    });

    const [, payload] = updateBlock.mock.calls[0];
    expect(payload.toolOutput.cards).toHaveLength(2);
    expect(payload.toolOutput.cards[0]).toEqual(
      expect.objectContaining({ id: 'card-1', front: 'Q1-edited', back: 'A1' })
    );
    expect(payload.toolOutput.cards[1]).toEqual(
      expect.objectContaining({ id: 'card-2', front: 'Q2-streamed', back: 'A2-streamed' })
    );
    // Preserve non-card fields from latest store (not stale closure)
    expect(payload.toolOutput.progress).toEqual(
      expect.objectContaining({ cardsGenerated: 2, stage: 'generating' })
    );
    expect(mockInvoke).toHaveBeenCalledWith('update_anki_card', expect.any(Object));
  });

  it('should not update store projection when DB sync fails on card edit', async () => {
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'update_anki_card') {
        throw new Error('db unavailable');
      }
      return undefined;
    });

    const updateBlock = vi.fn();
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [{ id: 'card-1', front: 'Q1', back: 'A1' } as any],
    });
    const blockWithOutput = { ...block, toolOutput: data };
    const store = {
      getState: () => ({
        blocks: new Map([[block.id, blockWithOutput]]),
        updateBlock,
      }),
    } as any;

    render(<AnkiCardsBlock block={blockWithOutput} store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByText('Q1'));
    fireEvent.change(screen.getByDisplayValue('Q1'), {
      target: { value: 'Q1-edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'chatV2.saveEdit' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('update_anki_card', expect.any(Object));
    });
    expect(updateBlock).not.toHaveBeenCalled();
  });
});
