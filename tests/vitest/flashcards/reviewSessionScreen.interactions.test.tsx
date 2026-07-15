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
      'session.suspend': '暂停卡片',
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
      queue: [],
      queueIndex: 0,
      flipped: false,
      loading: false,
      ratingBusy: false,
      usingMock: false,
      error: null,
      errorKind: null,
      lastRated: null,
      lastReview: null,
      lastSuspended: null,
      retryBatchRequest: null,
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
    const surface = screen.getByRole('button', { name: '背面' });
    expect(within(surface).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('anki-card-face')).toHaveAttribute('data-side', 'front');
    expect(screen.getByTestId('anki-card-face')).toHaveAttribute(
      'data-template-id',
      'design-redaction',
    );
    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('Capital: [city]');

    fireEvent.click(surface);

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
    fireEvent.click(screen.getByRole('button', { name: '背面' }));
    expect(screen.getByTestId('anki-card-face')).toHaveTextContent('Alpha and Beta');
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
