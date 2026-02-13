/**
 * Chat V2 - AnkiCardsBlock 单元测试（当前实现）
 *
 * 目标：
 * - 确保 blockRegistry 注册正常
 * - 预览组件接收正确的 status/cards
 * - 有卡片时渲染操作按钮，并在流式时禁用
 * - 点击预览/编辑会触发打开面板事件
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/chat-v2/core/types';
import type { AnkiCardsBlockData } from '@/chat-v2/plugins/blocks/ankiCardsBlock';
import { blockRegistry } from '@/chat-v2/registry';

// Mock i18n（仅覆盖本组件使用的 key）
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const dict: Record<string, string> = {
        'blocks.ankiCards.edit': 'Edit',
        'blocks.ankiCards.save': 'Save',
        'blocks.ankiCards.export': 'Export',
        'blocks.ankiCards.sync': 'Sync',
      };
      if (dict[key]) return dict[key];
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
  // Some modules initialize i18n in test environment and expect this export.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const mockDispatchOpenAnkiPanelEvent = vi.fn();
const mockSaveCardsToLibrary = vi.fn(async () => undefined);
const mockExportCardsAsApkg = vi.fn(async () => undefined);
const mockImportCardsViaAnkiConnect = vi.fn(async () => undefined);
const mockLogChatAnkiEvent = vi.fn();
const mockInvoke = vi.fn(async () => undefined);

vi.mock('@/chat-v2/anki', () => ({
  dispatchOpenAnkiPanelEvent: (...args: unknown[]) => mockDispatchOpenAnkiPanelEvent(...args),
  saveCardsToLibrary: (...args: unknown[]) => mockSaveCardsToLibrary(...args),
  exportCardsAsApkg: (...args: unknown[]) => mockExportCardsAsApkg(...args),
  importCardsViaAnkiConnect: (...args: unknown[]) => mockImportCardsViaAnkiConnect(...args),
  logChatAnkiEvent: (...args: unknown[]) => mockLogChatAnkiEvent(...args),
  AnkiCardStackPreview: ({ status, cards, onClick }: any) => (
    <button
      type="button"
      data-testid="anki-preview"
      data-status={status}
      data-count={cards?.length ?? 0}
      onClick={onClick}
    >
      preview
    </button>
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// 在 mocks 之后导入（触发注册）
import { AnkiCardsBlock } from '@/chat-v2/plugins/blocks/ankiCardsBlock';

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
  });

  it('should be registered in blockRegistry', async () => {
    await import('@/chat-v2/plugins/blocks/ankiCardsBlock');
    expect(blockRegistry.has('anki_cards')).toBe(true);
    expect(blockRegistry.get('anki_cards')?.onAbort).toBe('keep-content');
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
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    // 未提供 ankiConnect 状态时，同步按钮应禁用
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('should render action buttons when has cards and disable them while streaming', () => {
    const block = createBlock({ status: 'running' });
    const data = createData();

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} isStreaming={true} />);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('should dispatch open panel event when preview clicked', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ cards: [{ id: 'card-1', front: 'Q1', back: 'A1' } as any] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    fireEvent.click(screen.getByTestId('anki-preview'));

    expect(mockDispatchOpenAnkiPanelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        blockId: 'anki-block-1',
        messageId: 'msg-1',
        businessSessionId: 'sess-1',
      })
    );
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

  it('should render editable fields from card.fields and persist field edits', () => {
    const updateBlock = vi.fn();
    const store = {
      getState: () => ({
        updateBlock,
      }),
    } as any;

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

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByText('{"Question":"旧问题","optiona":"A","optionb":"B","correct":"B"}'));

    expect(screen.getByDisplayValue('旧问题')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('B').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByDisplayValue('旧问题'), {
      target: { value: '新问题' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'chatV2.saveEdit' }));

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
});
