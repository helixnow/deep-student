import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, dispatchMock, openTarget, notify } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null as unknown),
  dispatchMock: vi.fn(),
  openTarget: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: () => <div data-testid="card-face" />,
}));
vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null, loading: false }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notify }));
vi.mock('@/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events')>()),
  dispatchAppEvent: dispatchMock,
}));
vi.mock('../cardSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cardSource')>()),
  openCardSourceTarget: openTarget,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { card?: string }) => ({
      'session.viewSource': '查看出处',
      'session.noSource': '没有出处',
      'session.askAi': '问 AI 这张卡',
      'session.front': '正面',
      'session.back': '背面',
      'session.askAiPrompt': `PROMPT\n${options?.card ?? ''}`,
    }[key] ?? key),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ReviewSessionScreen } from '../screens/ReviewSessionScreen';
import { useFsrsReviewStore, type ReviewCard } from '../store/fsrsReviewStore';

function seedCard(card: ReviewCard): void {
  useFsrsReviewStore.setState({
    screen: 'session',
    dueCards: [card],
    dueTotal: 1,
    queue: [card],
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
}

describe('ReviewSessionScreen — back to the source while reviewing', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    dispatchMock.mockReset();
    openTarget.mockReset();
    notify.mockReset();
  });

  it('does not touch IPC until the learner asks for the source', async () => {
    invokeMock.mockImplementation(async (cmd: string) => cmd === 'list_anki_library_cards'
      ? { items: [{ id: 'anki_1', front: '极限的定义', back: 'ε-δ', sourceRef: { kind: 'note', id: 'note_7', title: '高数笔记' } }] }
      : null);
    seedCard({ id: 'state_1', ankiCardId: 'anki_1', front: '极限的定义\n（课本 1.2）', back: 'ε-δ' });
    render(<ReviewSessionScreen />);
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('fc-review-view-source'));
    await waitFor(() => expect(openTarget).toHaveBeenCalledWith(
      { kind: 'ref', ref: { kind: 'note', id: 'note_7', title: '高数笔记' } },
      'flashcards-review',
    ));
    expect(invokeMock).toHaveBeenCalledWith('list_anki_library_cards', {
      request: expect.objectContaining({ search: '极限的定义' }),
    });
  });

  it('says so when the card has no recorded source', async () => {
    seedCard({ id: 'state_2', ankiCardId: 'anki_2', front: 'Q', back: 'A' });
    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByTestId('fc-review-view-source'));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('info', '没有出处'));
    expect(openTarget).not.toHaveBeenCalled();
  });

  it('asks AI about the forgotten card in a fresh conversation', () => {
    seedCard({ id: 'state_3', ankiCardId: 'anki_3', front: '<b>导数</b>的定义', back: '极限 [PDF@file_x:3]' });
    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByTestId('fc-review-ask-ai'));
    const [eventName, detail] = dispatchMock.mock.calls.find(([name]) => name === 'PREFILL_CHAT_INPUT') ?? [];
    expect(eventName).toBe('PREFILL_CHAT_INPUT');
    expect(detail).toMatchObject({ autoSend: false, newSession: true });
    expect(detail.content).toContain('正面：导数的定义');
    expect(detail.content).toContain('背面：极限 第 3 页');
  });
});
