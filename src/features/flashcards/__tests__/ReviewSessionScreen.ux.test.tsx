import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, dispatchMock, notifyMock, speakMock, stopTtsMock, replayAudioMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null as unknown),
  dispatchMock: vi.fn(),
  notifyMock: vi.fn(),
  speakMock: vi.fn(async () => undefined),
  stopTtsMock: vi.fn(async () => undefined),
  replayAudioMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: () => <div data-testid="card-face" />,
}));
vi.mock('@/components/anki/utils/cardMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/anki/utils/cardMedia')>()),
  replayCardAudio: replayAudioMock,
}));
vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null, loading: false }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notifyMock }));
vi.mock('@/utils/tts', () => ({
  speak: speakMock,
  stop: stopTtsMock,
}));
vi.mock('@/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events')>()),
  dispatchAppEvent: dispatchMock,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'card.noBack': '无背面',
        'card.untitled': '无正面',
        'session.again': '重来',
        'session.hard': '困难',
        'session.good': '良好',
        'session.easy': '简单',
        'session.front': '正面',
        'session.back': '背面',
        'session.edit': '编辑卡片',
        'session.saveEdit': '保存',
        'session.cancelEdit': '取消',
        'session.undo': '撤销评分',
        'session.resume': '恢复学习',
        'session.leechSuspended': '该卡多次遗忘已自动暂停',
        'session.backToday': '返回今日',
        'today.goLibrary': '去卡片库',
        'session.done': '本轮复习完成',
      };
      if (key in table) return table[key];
      const raw = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''));
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ReviewSessionScreen } from '../screens/ReviewSessionScreen';
import { SessionSummary } from '../review/SessionSummary';
import {
  FSRS_DUE_REFRESH_EVENT,
  useFsrsReviewStore,
  type ReviewCard,
} from '../store/fsrsReviewStore';

function seedSession(cards: ReviewCard[], extra: Partial<ReturnType<typeof useFsrsReviewStore.getState>> = {}): void {
  useFsrsReviewStore.setState({
    screen: 'session',
    sessionMode: 'due',
    dueCards: cards,
    dueTotal: cards.length,
    queue: cards,
    queueIndex: 0,
    flipped: false,
    loading: false,
    ratingBusy: false,
    error: null,
    errorKind: null,
    lastRated: null,
    lastReview: null,
    reviewHistory: [],
    lastSuspended: null,
    retryBatchRequest: null,
    sessionRatedCount: 0,
    sessionAgainCount: 0,
    sessionAgainCardIds: [],
    sessionRatingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    sessionStreak: 0,
    sessionBestStreak: 0,
    sessionStartedAtMs: Date.now(),
    remainingDueAfterSession: null,
    ratingPreviews: null,
    lastSchedule: null,
    ...extra,
  });
}

describe('ReviewSessionScreen TTS, audio replay, rescue flows, and mobile editing', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    dispatchMock.mockReset();
    notifyMock.mockReset();
    speakMock.mockReset();
    speakMock.mockResolvedValue(undefined);
    stopTtsMock.mockReset();
    stopTtsMock.mockResolvedValue(undefined);
    replayAudioMock.mockReset();
  });

  it('speaks the active card face via TTS and exposes clickable Replay Audio when card has APKG sound', async () => {
    seedSession([
      {
        id: 'state-audio',
        ankiCardId: 'anki-audio',
        front: 'Bonjour [sound:bonjour.mp3]',
        back: '你好',
      },
    ]);

    render(<ReviewSessionScreen />);

    const ttsBtn = screen.getByTestId('fc-review-tts');
    fireEvent.click(ttsBtn);
    await waitFor(() => expect(speakMock).toHaveBeenCalledWith('Bonjour'));

    const replayBtn = screen.getByTestId('fc-review-replay-audio');
    expect(replayBtn).toBeInTheDocument();
    fireEvent.click(replayBtn);
    expect(replayAudioMock).toHaveBeenCalledTimes(1);
  });

  it('records sessionAgainCardIds, dispatches FSRS_DUE_REFRESH_EVENT, and exposes Ask AI + Edit in UndoNudge', async () => {
    const refreshEvents: Event[] = [];
    const listener = (e: Event) => refreshEvents.push(e);
    window.addEventListener(FSRS_DUE_REFRESH_EVENT, listener);

    try {
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'fsrs_rate') {
          return {
            logId: 'log-again-1',
            dueMs: Date.now() + 60_000,
            scheduledDays: 0,
            cardState: { id: 'state-1', state: 1, suspended: false, lastReviewMs: Date.now() },
          };
        }
        return null;
      });

      seedSession(
        [
          { id: 'state-1', ankiCardId: 'anki-1', front: '难卡正面', back: '难卡背面', tags: ['高数'] },
          { id: 'state-2', ankiCardId: 'anki-2', front: '第二张卡', back: '第二张背面' },
        ],
        { flipped: true },
      );

      render(<ReviewSessionScreen />);

      await act(async () => {
        await useFsrsReviewStore.getState().rate(1, 2000);
      });

      expect(useFsrsReviewStore.getState().sessionAgainCardIds).toEqual(['state-1']);
      expect(refreshEvents.length).toBeGreaterThanOrEqual(1);

      const askAiBtn = await screen.findByTestId('fc-nudge-ask-ai');
      fireEvent.click(askAiBtn);
      const prefillCall = dispatchMock.mock.calls.find(([name]) => name === 'PREFILL_CHAT_INPUT');
      expect(prefillCall?.[1].content).toContain('难卡正面');

      const editBtn = screen.getByTestId('fc-nudge-edit-card');
      fireEvent.click(editBtn);
      expect(screen.getByLabelText('正面')).toHaveValue('难卡正面');
      expect(screen.getByTestId('fc-edit-tags')).toHaveValue('高数');

      // Insert cloze converts to Cloze mode and inserts {{c1::...}}
      fireEvent.click(screen.getByTestId('fc-edit-insert-cloze'));
      expect((screen.getByLabelText('正面') as HTMLTextAreaElement).value).toContain('{{c1::');
    } finally {
      window.removeEventListener(FSRS_DUE_REFRESH_EVENT, listener);
    }
  });

  it('exposes Ask AI and Edit shortcuts in the leech auto-suspend banner', () => {
    seedSession(
      [
        { id: 'state-leech', ankiCardId: 'anki-leech', front: '反复遗忘卡', back: '解析', suspended: true },
        { id: 'state-next', ankiCardId: 'anki-next', front: '下一张', back: '答案' },
      ],
      {
        queueIndex: 1,
        lastSuspended: { cardStateId: 'state-leech', queueIndex: 0, reason: 'leech' },
      },
    );

    render(<ReviewSessionScreen />);
    expect(screen.getByTestId('fc-leech-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('fc-leech-ask-ai'));
    const prefillCall = dispatchMock.mock.calls.find(([name]) => name === 'PREFILL_CHAT_INPUT');
    expect(prefillCall?.[1].content).toContain('反复遗忘卡');

    fireEvent.click(screen.getByTestId('fc-leech-edit-card'));
    expect(screen.getByLabelText('正面')).toHaveValue('反复遗忘卡');
  });

  it('shows mobile bottom actions and Again-card rescue actions in SessionSummary', () => {
    const onRetryAgain = vi.fn();
    const onAskAiAgain = vi.fn();
    const onOpenLibrary = vi.fn();
    const onBack = vi.fn();

    render(
      <SessionSummary
        empty={false}
        headline="本轮复习完成"
        ratedCount={4}
        ratingCounts={{ 1: 2, 2: 0, 3: 2, 4: 0 }}
        bestStreak={2}
        elapsedMs={45_000}
        remainingDue={0}
        busy={false}
        canUndo={false}
        canResume={false}
        onUndo={vi.fn()}
        onResume={vi.fn()}
        onBack={onBack}
        onOpenLibrary={onOpenLibrary}
        againCount={2}
        canRetryAgain
        onRetryAgain={onRetryAgain}
        onAskAiAgain={onAskAiAgain}
        hideChromeActions
      />,
    );

    expect(screen.getByTestId('fc-summary-back-today')).toBeInTheDocument();
    expect(screen.getByTestId('fc-summary-open-library')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fc-summary-retry-again'));
    expect(onRetryAgain).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('fc-summary-ask-ai'));
    expect(onAskAiAgain).toHaveBeenCalledOnce();
  });
});
