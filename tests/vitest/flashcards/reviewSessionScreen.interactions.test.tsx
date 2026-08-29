import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { templateLoaderMock } = vi.hoisted(() => ({
  templateLoaderMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/features/flashcards/events', () => ({
  requestFlashcardsDueRefresh: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'card.noBack': '无背面',
      'card.untitled': '无正面',
      'session.again': '重来',
      'session.back': '背面',
      'session.backToday': '返回今日',
      'session.cancelEdit': '取消',
      'session.done': '本轮复习已完成',
      'session.emptyQueue': '当前没有可复习的卡片',
      'session.easy': '简单',
      'session.edit': '编辑卡片',
      'session.exit': '退出',
      'session.front': '正面',
      'session.good': '良好',
      'session.hard': '困难',
      'session.progress': '复习进度',
      'session.resume': '恢复卡片',
      'session.retry': '重试',
      'session.saveEdit': '保存',
      'session.showBack': '显示背面',
      'session.showFront': '显示正面',
      'session.suspend': '暂停卡片',
      'session.tapToFlip': '点击翻面',
      'session.undo': '撤销评分',
    }[key] ?? key),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: (templateId?: string | null) => templateLoaderMock(templateId),
}));

vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: ({
    side,
    template,
    fallbackText,
    emptyText,
  }: {
    side: string;
    template?: { id?: string } | null;
    fallbackText?: string;
    emptyText?: string;
  }) => (
    <div
      data-testid="anki-card-face"
      data-side={side}
      data-template-id={template?.id ?? ''}
    >
      {fallbackText || emptyText}
    </div>
  ),
}));

import { invoke } from '@tauri-apps/api/core';
import { ReviewSessionScreen } from '@/features/flashcards/screens/ReviewSessionScreen';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';

const invokeMock = vi.mocked(invoke);

describe('ReviewSessionScreen interactions', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    templateLoaderMock.mockReset();
    templateLoaderMock.mockReturnValue({ template: null, loading: false });
    useFsrsReviewStore.setState({
      screen: 'session',
      dueCards: [],
      dueTotal: 0,
      queue: [],
      queueIndex: 0,
      flipped: false,
      loading: false,
      ratingBusy: false,
      error: null,
      errorKind: null,
      lastRated: null,
      lastReview: null,
      lastSuspended: null,
      retryBatchRequest: null,
      sessionRatedCount: 0,
      sessionAgainCount: 0,
      remainingDueAfterSession: null,
      ratingPreviews: null,
      lastSchedule: null,
    });
  });

  afterEach(() => cleanup());

  it('drives the shared template face with controlled side and no nested buttons', () => {
    templateLoaderMock.mockReturnValue({
      template: { id: 'design-redaction' },
      loading: false,
    });
    useFsrsReviewStore.setState({
      queue: [{
        id: 'state-1',
        ankiCardId: 'anki-1',
        front: '',
        back: '',
        text: 'Capital: {{c1::Paris::city}}',
        templateId: 'design-redaction',
        extraFields: { Text: 'Capital: {{c1::Paris::city}}' },
      }],
    });

    render(<ReviewSessionScreen />);

    expect(templateLoaderMock).toHaveBeenCalledWith('design-redaction');
    const surface = screen.getByRole('button', { name: '显示背面' });
    expect(within(surface).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('anki-card-face')).toHaveAttribute('data-side', 'front');
    expect(screen.getByTestId('anki-card-face')).toHaveAttribute(
      'data-template-id',
      'design-redaction',
    );
    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('Capital: [city]');

    fireEvent.click(surface);

    expect(screen.getByRole('button', { name: '显示正面' })).toBeTruthy();
    expect(screen.getByTestId('anki-card-face')).toHaveAttribute('data-side', 'back');
    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('Capital: Paris');
  });

  it('falls back to plain Cloze text when the template cannot be loaded', () => {
    useFsrsReviewStore.setState({
      queue: [{
        id: 'state-1',
        ankiCardId: 'anki-1',
        front: '',
        back: '',
        text: '{{c1::Alpha}} and {{c2::Beta}}',
        templateId: 'missing-template',
      }],
    });

    render(<ReviewSessionScreen />);

    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('[...] and [...]');
    fireEvent.click(screen.getByRole('button', { name: '显示背面' }));
    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('Alpha and Beta');
  });

  it('Space flips first, then rates Good when already flipped', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_preview_intervals') {
        return {
          previews: {
            3: { dueMs: Date.now() + 86_400_000, scheduledDays: 1, intervalMs: 86_400_000 },
          },
        };
      }
      if (command === 'fsrs_rate') {
        return {
          logId: 'log-good',
          dueMs: Date.now() + 3 * 24 * 60 * 60 * 1000,
          scheduledDays: 3,
        };
      }
      return null;
    });
    useFsrsReviewStore.setState({
      queue: [
        { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
        { id: 'state-2', ankiCardId: 'anki-2', front: 'Q2', back: 'A2' },
      ],
      queueIndex: 0,
      flipped: false,
    });

    render(<ReviewSessionScreen />);
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(useFsrsReviewStore.getState().flipped).toBe(true);

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    await waitFor(() => expect(useFsrsReviewStore.getState().queueIndex).toBe(1));
    expect(invokeMock).toHaveBeenCalledWith('fsrs_rate', expect.objectContaining({
      cardStateId: 'state-1',
      rating: 3,
      clientOpId: expect.any(String),
    }));
  });

  it('only handles global review shortcuts while its desktop window is active', () => {
    useFsrsReviewStore.setState({
      queue: [
        { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
      ],
      queueIndex: 0,
      flipped: false,
    });

    const view = render(<ReviewSessionScreen isActive={false} />);
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(useFsrsReviewStore.getState().flipped).toBe(false);

    view.rerender(<ReviewSessionScreen isActive />);
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(useFsrsReviewStore.getState().flipped).toBe(true);
  });

  it('shows emptyQueue copy when the session has no cards', () => {
    useFsrsReviewStore.setState({
      queue: [],
      queueIndex: 0,
      loading: false,
    });

    render(<ReviewSessionScreen />);
    expect(screen.getByText('当前没有可复习的卡片')).toBeTruthy();
  });

  it('offers continue review from the completion summary when cards are still due', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_get_due') {
        return [{ id: 'state-next', ankiCardId: 'anki-next', front: 'Q2', back: 'A2' }];
      }
      if (command === 'fsrs_get_stats') return { due: 3 };
      return null;
    });
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 1,
      sessionRatedCount: 1,
      sessionRatingCounts: { 1: 0, 2: 0, 3: 1, 4: 0 },
      remainingDueAfterSession: 3,
    });

    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'session.continueReview' }));

    await waitFor(() => {
      const state = useFsrsReviewStore.getState();
      expect(state.screen).toBe('session');
      expect(state.queue.map((card) => card.id)).toEqual(['state-next']);
      expect(state.queueIndex).toBe(0);
    });
  });

  it('supports undo from the completion page with Z', async () => {
    invokeMock.mockResolvedValueOnce({
      state: { id: 'state-1', ankiCardId: 'anki-1' },
      changed: true,
      undoneLogId: 'log-1',
    });
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 1,
      lastReview: { logId: 'log-1', cardStateId: 'state-1', queueIndex: 0 },
    });

    render(<ReviewSessionScreen />);
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ' });

    await waitFor(() => expect(useFsrsReviewStore.getState().queueIndex).toBe(0));
    expect(invokeMock).toHaveBeenCalledWith('fsrs_undo_last_review', {
      expectedLogId: 'log-1',
      cardStateId: 'state-1',
    });
    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('Q');
  });

  it('does not run the Z shortcut from an input, during IME, or while busy', () => {
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      lastReview: { logId: 'log-0', cardStateId: 'state-0', queueIndex: 0 },
    });

    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }));
    fireEvent.keyDown(screen.getAllByRole('textbox')[0], { key: 'z', code: 'KeyZ' });
    expect(invokeMock).not.toHaveBeenCalled();

    act(() => useFsrsReviewStore.setState({ ratingBusy: true }));
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ' });
    expect(invokeMock).not.toHaveBeenCalled();

    act(() => useFsrsReviewStore.setState({ ratingBusy: false }));
    const composing = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    window.dispatchEvent(composing);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('keeps rating controls usable after a suspend failure', async () => {
    invokeMock.mockRejectedValueOnce(new Error('suspend unavailable'));
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      flipped: true,
    });

    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '暂停卡片' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '良好' })).toBeEnabled();
    expect(useFsrsReviewStore.getState().queueIndex).toBe(0);
  });
});
