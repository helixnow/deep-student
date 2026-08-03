import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/features/flashcards/events', () => ({
  requestFlashcardsDueRefresh: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { requestFlashcardsDueRefresh } from '@/features/flashcards/events';
import {
  mapFsrsRow,
  useFsrsReviewStore,
} from '@/features/flashcards/store/fsrsReviewStore';

const invokeMock = vi.mocked(invoke);
const refreshDueMock = vi.mocked(requestFlashcardsDueRefresh);

function mockInvokeByCommand(handlers: Record<string, unknown | (() => unknown)>): void {
  invokeMock.mockImplementation(async (command: string) => {
    const handler = handlers[command];
    if (typeof handler === 'function') return (handler as () => unknown)();
    if (handler !== undefined) return handler;
    throw new Error(`unexpected invoke: ${command}`);
  });
}


describe('fsrsReviewStore rate completion', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('en-US', 'flashcards')).toBe(true);
    });
    invokeMock.mockReset();
    refreshDueMock.mockClear();
    useFsrsReviewStore.setState({
      screen: 'today',
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

  it('localizes store-generated review errors while preserving backend error details', async () => {
    invokeMock.mockRejectedValueOnce(null);
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-rate', ankiCardId: 'anki-rate', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });
    await useFsrsReviewStore.getState().rate(1);
    expect(useFsrsReviewStore.getState().error).toBe('Rating failed');

    invokeMock.mockRejectedValueOnce(null);
    useFsrsReviewStore.setState({
      lastReview: { logId: 'log-undo', cardStateId: 'state-undo', queueIndex: 0 },
      ratingBusy: false,
      error: null,
    });
    await useFsrsReviewStore.getState().undoLastReview();
    expect(useFsrsReviewStore.getState().error).toBe('Failed to undo rating');

    invokeMock.mockRejectedValueOnce(null);
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-save-fallback', ankiCardId: 'anki-save-fallback', front: 'Q', back: 'A' }],
      queueIndex: 0,
      ratingBusy: false,
      error: null,
    });
    await useFsrsReviewStore.getState().updateCurrentCard('New Q', 'New A');
    expect(useFsrsReviewStore.getState().error).toBe('Failed to save card');

    invokeMock.mockRejectedValueOnce(null);
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-suspend', ankiCardId: 'anki-suspend', front: 'Q', back: 'A' }],
      queueIndex: 0,
      ratingBusy: false,
      error: null,
    });
    await useFsrsReviewStore.getState().suspendCurrent();
    expect(useFsrsReviewStore.getState().error).toBe('Failed to suspend card');

    invokeMock.mockRejectedValueOnce(null);
    useFsrsReviewStore.setState({
      lastSuspended: { cardStateId: 'state-resume', queueIndex: 0 },
      ratingBusy: false,
      error: null,
    });
    await useFsrsReviewStore.getState().resumeLastSuspended();
    expect(useFsrsReviewStore.getState().error).toBe('Failed to resume card');

    await i18n.changeLanguage('zh-CN');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('zh-CN', 'flashcards')).toBe(true);
    });
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-missing-id', front: 'Q', back: 'A' }],
      queueIndex: 0,
      error: null,
      errorKind: null,
    });
    await expect(useFsrsReviewStore.getState().updateCurrentCard('Q', 'A')).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().error).toBe('当前卡片缺少可更新的 Anki ID');

    useFsrsReviewStore.setState({
      queue: [{ id: 'state-empty', ankiCardId: 'anki-empty', front: 'Q', back: 'A' }],
      queueIndex: 0,
      error: null,
      errorKind: null,
    });
    await expect(useFsrsReviewStore.getState().updateCurrentCard('', '')).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().error).toBe('卡片正面和背面不能为空');

    invokeMock.mockRejectedValueOnce(new Error('backend detail'));
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-save', ankiCardId: 'anki-save', front: 'Q', back: 'A' }],
      queueIndex: 0,
      error: null,
      errorKind: null,
    });
    await useFsrsReviewStore.getState().updateCurrentCard('New Q', 'New A');
    expect(useFsrsReviewStore.getState().error).toBe('backend detail');
  });

  it('localizes structured diagnostic-card rating rejections', async () => {
    invokeMock.mockRejectedValueOnce({
      error_type: 'Validation',
      message: 'raw backend diagnostic detail',
      details: { errorCode: 'fsrs_diagnostic_card_not_reviewable' },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-diagnostic-en', ankiCardId: 'anki-diagnostic-en', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(3);

    expect(useFsrsReviewStore.getState().error).toBe('Diagnostic cards cannot be reviewed');
    expect(useFsrsReviewStore.getState().queueIndex).toBe(0);

    await i18n.changeLanguage('zh-CN');
    invokeMock.mockRejectedValueOnce(JSON.stringify({
      error_type: 'Validation',
      message: 'raw backend diagnostic detail',
      details: { errorCode: 'fsrs_diagnostic_card_not_reviewable' },
    }));
    useFsrsReviewStore.setState({
      queue: [{ id: 'state-diagnostic-zh', ankiCardId: 'anki-diagnostic-zh', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
      ratingBusy: false,
      error: null,
      errorKind: null,
    });

    await useFsrsReviewStore.getState().rate(3);

    expect(useFsrsReviewStore.getState().error).toBe('诊断错误卡不能参与复习');
    expect(useFsrsReviewStore.getState().queueIndex).toBe(0);
  });

  it('keeps session screen when last card is rated so done UI can show', async () => {
    invokeMock.mockResolvedValueOnce({ logId: 'log-b' });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 1,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(3);

    const state = useFsrsReviewStore.getState();
    expect(state.screen).toBe('session');
    expect(state.queueIndex).toBe(2);
    expect(state.queue[state.queueIndex]).toBeUndefined();
    expect(state.ratingBusy).toBe(false);
    expect(state.flipped).toBe(false);
    expect(state.lastReview).toMatchObject({
      logId: 'log-b',
      cardStateId: 'b',
      queueIndex: 1,
      rating: 3,
    });
    expect(state.lastReview?.queueSnapshot?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(refreshDueMock).toHaveBeenCalled();
  });

  it('advances to next card without leaving session mid-queue', async () => {
    invokeMock.mockResolvedValueOnce({ logId: 'log-a' });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(4);

    const state = useFsrsReviewStore.getState();
    expect(state.screen).toBe('session');
    expect(state.queueIndex).toBe(1);
    expect(state.queue[state.queueIndex]?.id).toBe('b');
  });

  it('keeps a learning card in the session when its due lands inside the learning-step window', async () => {
    const dueMs = Date.now() + 10 * 60 * 1000;
    mockInvokeByCommand({
      fsrs_rate: {
        logId: 'log-future-learning',
        dueMs,
        scheduledDays: 0,
        cardState: { state: 1, lastReviewMs: Date.now() },
      },
      fsrs_get_stats: { due: 0 },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'learning', front: 'Q', back: 'A' },
        { id: 'other', front: 'Q2', back: 'A2' },
      ],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(1);

    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((card) => card.id)).toEqual(['other', 'learning']);
    expect(state.queue[1]?.learningDueMs).toBe(dueMs);
    expect(state.queueIndex).toBe(0);
    expect(state.lastSchedule?.dueMs).toBe(dueMs);
  });

  it('keeps the session open while only a learning-step card remains', async () => {
    const dueMs = Date.now() + 60 * 1000;
    mockInvokeByCommand({
      fsrs_rate: {
        logId: 'log-lone-learning',
        dueMs,
        scheduledDays: 0,
        cardState: { state: 1, lastReviewMs: Date.now() },
      },
      fsrs_get_stats: { due: 0 },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'learning', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(1);

    const state = useFsrsReviewStore.getState();
    // 学习步卡留在本轮：会话不进入完成态，轮到时可提前展示
    expect(state.queue.map((card) => card.id)).toEqual(['learning']);
    expect(state.queueIndex).toBe(0);
    expect(state.queue[0]?.learningDueMs).toBe(dueMs);
  });

  it('dequeues a graduated card even when its due is near', async () => {
    const dueMs = Date.now() + 5 * 60 * 1000;
    mockInvokeByCommand({
      fsrs_rate: {
        logId: 'log-graduated',
        dueMs,
        scheduledDays: 1,
        cardState: { state: 2, lastReviewMs: Date.now() },
      },
      fsrs_get_stats: { due: 0 },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'graduated', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(3);

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.queue[state.queueIndex]).toBeUndefined();
  });

  it('dequeues a learning card whose due is beyond the learning-step window', async () => {
    const dueMs = Date.now() + 30 * 60 * 1000;
    mockInvokeByCommand({
      fsrs_rate: {
        logId: 'log-far-learning',
        dueMs,
        scheduledDays: 0,
        cardState: { state: 1, lastReviewMs: Date.now() },
      },
      fsrs_get_stats: { due: 0 },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'far-learning', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(1);

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.queue[state.queueIndex]).toBeUndefined();
    expect(state.lastSchedule?.dueMs).toBe(dueMs);
  });

  it('invokes fsrs_rate with cardStateId (not cardId)', async () => {
    invokeMock.mockResolvedValueOnce({ logId: 'log-1' });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-uuid-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(3);

    expect(invokeMock).toHaveBeenCalledWith('fsrs_rate', expect.objectContaining({
      cardStateId: 'state-uuid-1',
      rating: 3,
      clientOpId: expect.any(String),
    }));
  });

  it('does not advance when fsrs_rate omits the undo log id', async () => {
    invokeMock.mockResolvedValueOnce({ cardState: { id: 'state-1' } });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(3);

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(0);
    expect(state.lastReview).toBeNull();
    expect(state.errorKind).toBe('rate');
    expect(state.error).toContain('logId');
  });

  it('does not advance on rate failure; sets error and clears busy', async () => {
    invokeMock.mockRejectedValueOnce(new Error('rate failed'));
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
      error: null,
    });

    await useFsrsReviewStore.getState().rate(2);

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(0);
    expect(state.ratingBusy).toBe(false);
    expect(state.error).toBe('rate failed');
    expect(state.errorKind).toBe('rate');
    expect(refreshDueMock).not.toHaveBeenCalled();
  });

  it('treats empty due array as success, not mock fallback', async () => {
    mockInvokeByCommand({
      fsrs_get_due: [],
      fsrs_get_stats: { due: 0 },
    });
    const loaded = await useFsrsReviewStore.getState().loadDue();
    const state = useFsrsReviewStore.getState();
    expect(loaded).toBe(true);
    expect(state.dueCards).toEqual([]);
    expect(state.loading).toBe(false);

    useFsrsReviewStore.getState().startDueSession();
    const session = useFsrsReviewStore.getState();
    expect(session.queue).toEqual([]);
    expect(session.screen).toBe('today');
  });

  it('keeps loadDue failures explicit instead of substituting mock cards', async () => {
    mockInvokeByCommand({
      fsrs_get_due: () => { throw new Error('due service unavailable'); },
      fsrs_get_stats: { due: 0 },
    });

    const loaded = await useFsrsReviewStore.getState().loadDue();

    const state = useFsrsReviewStore.getState();
    expect(loaded).toBe(false);
    expect(state.dueCards).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBe('due service unavailable');
  });

  it('rejects a non-array due response as an explicit error', async () => {
    mockInvokeByCommand({
      fsrs_get_due: { cards: [] },
      fsrs_get_stats: { due: 0 },
    });

    const loaded = await useFsrsReviewStore.getState().loadDue();

    const state = useFsrsReviewStore.getState();
    expect(loaded).toBe(false);
    expect(state.dueCards).toEqual([]);
    expect(state.error).toBe('fsrs_get_due returned an invalid response');
  });

  it('localizes protocol errors in both languages without masking backend details', async () => {
    await i18n.changeLanguage('zh-CN');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('zh-CN', 'flashcards')).toBe(true);
    });

    mockInvokeByCommand({
      fsrs_get_due: { cards: [] },
      fsrs_get_stats: { due: 0 },
    });
    await expect(useFsrsReviewStore.getState().loadDue()).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().error).toBe('复习服务返回了无效的到期卡片数据');

    invokeMock.mockResolvedValueOnce({ enqueued: 1 });
    await expect(useFsrsReviewStore.getState().startBatchSession(
      ['anki-1'],
      [{ id: 'anki-1', ankiCardId: 'anki-1', front: '问题', back: '答案' }],
    )).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().error).toBe('复习服务返回了无效的入队数据');

    await i18n.changeLanguage('en-US');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('en-US', 'flashcards')).toBe(true);
    });

    mockInvokeByCommand({
      fsrs_get_due: { cards: [] },
      fsrs_get_stats: { due: 0 },
    });
    await expect(useFsrsReviewStore.getState().loadDue()).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().error).toBe(
      'fsrs_get_due returned an invalid response',
    );

    mockInvokeByCommand({
      fsrs_get_due: () => { throw new Error('specific backend detail'); },
      fsrs_get_stats: { due: 0 },
    });
    await expect(useFsrsReviewStore.getState().loadDue()).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().error).toBe('specific backend detail');
  });

  it('preserves a failed batch request and retries it with the original cards', async () => {
    const content = [
      { id: 'anki-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
    ];
    invokeMock
      .mockRejectedValueOnce(new Error('enqueue unavailable'))
      .mockResolvedValueOnce({
        states: [
          { id: 'state-1', anki_card_id: 'anki-1', front: '', back: '' },
        ],
      });

    await useFsrsReviewStore.getState().startBatchSession(['anki-1'], content);

    let state = useFsrsReviewStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.error).toBe('enqueue unavailable');
    expect(state.retryBatchRequest).toEqual({ cardIds: ['anki-1'], cards: content });

    await state.retryBatchSession();

    state = useFsrsReviewStore.getState();
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'fsrs_enqueue_cards', {
      ankiCardIds: ['anki-1'],
    });
    expect(state.queue).toEqual([
      expect.objectContaining({
        id: 'state-1',
        ankiCardId: 'anki-1',
        front: 'Q1',
        back: 'A1',
      }),
    ]);
    expect(state.error).toBeNull();
    expect(state.retryBatchRequest).toBeNull();
  });

  it('rejects enqueue responses without a states array and keeps retry state', async () => {
    invokeMock.mockResolvedValueOnce({ enqueued: 1 });

    await useFsrsReviewStore.getState().startBatchSession(
      ['anki-1'],
      [{ id: 'anki-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' }],
    );

    const state = useFsrsReviewStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.error).toBe('fsrs_enqueue_cards returned an invalid response');
    expect(state.retryBatchRequest?.cardIds).toEqual(['anki-1']);
  });

  it('uses batch content from the launch payload when enqueue rows omit content', async () => {
    invokeMock.mockResolvedValueOnce({
      states: [{ id: 'state-1', anki_card_id: 'anki-1', front: '', back: '' }],
    });

    useFsrsReviewStore.getState().applyLaunchPayload({
      screen: 'session',
      mode: 'batch',
      cardIds: ['anki-1'],
      cards: [{ id: 'anki-1', ankiCardId: 'anki-1', front: 'Question', back: 'Answer' }],
    });

    await vi.waitFor(() => {
      const state = useFsrsReviewStore.getState();
      expect(state.loading).toBe(false);
      expect(state.queue).toEqual([
        expect.objectContaining({
          id: 'state-1',
          ankiCardId: 'anki-1',
          front: 'Question',
          back: 'Answer',
        }),
      ]);
      expect(state.error).toBeNull();
    });
  });

  it('uses complete reviewCards for a skipped-only batch without caller content', async () => {
    invokeMock.mockResolvedValueOnce({
      enqueued: 0,
      skipped: 1,
      states: [{ id: 'state-existing', ankiCardId: 'anki-1' }],
      reviewCards: [
        {
          id: 'state-existing',
          ankiCardId: 'anki-1',
          front: 'Existing question',
          back: 'Existing answer',
          tags: ['existing'],
        },
      ],
    });

    const started = await useFsrsReviewStore.getState().startBatchSession(['anki-1']);

    const state = useFsrsReviewStore.getState();
    expect(started).toBe(true);
    expect(state.queue).toEqual([
      expect.objectContaining({
        id: 'state-existing',
        ankiCardId: 'anki-1',
        front: 'Existing question',
        back: 'Existing answer',
      }),
    ]);
    expect(state.error).toBeNull();
  });

  it('merges suspension from states before starting a skipped-only batch', async () => {
    invokeMock.mockResolvedValueOnce({
      enqueued: 0,
      skipped: 1,
      states: [{
        id: 'state-suspended',
        ankiCardId: 'anki-suspended',
        suspended: true,
      }],
      reviewCards: [{
        id: 'state-suspended',
        ankiCardId: 'anki-suspended',
        front: 'Suspended question',
        back: 'Suspended answer',
      }],
    });

    const started = await useFsrsReviewStore.getState().startBatchSession(['anki-suspended']);

    const state = useFsrsReviewStore.getState();
    expect(started).toBe(true);
    expect(state.queue).toEqual([
      expect.objectContaining({
        id: 'state-suspended',
        suspended: true,
      }),
    ]);
    expect(state.queueIndex).toBe(1);
  });

  it('uses text content for a Cloze-only reviewCards row', async () => {
    invokeMock.mockResolvedValueOnce({
      enqueued: 1,
      skipped: 0,
      states: [{ id: 'state-cloze', ankiCardId: 'anki-cloze' }],
      reviewCards: [
        {
          id: 'state-cloze',
          ankiCardId: 'anki-cloze',
          front: '',
          back: '',
          text: 'The capital is {{c1::Paris}}.',
        },
      ],
    });

    const started = await useFsrsReviewStore.getState().startBatchSession(['anki-cloze']);

    expect(started).toBe(true);
    expect(useFsrsReviewStore.getState().queue[0]).toMatchObject({
      id: 'state-cloze',
      front: '',
      back: '',
      text: 'The capital is {{c1::Paris}}.',
    });
  });

  it('rejects real review states whose content cannot be resolved', async () => {
    invokeMock.mockResolvedValueOnce({
      states: [{ id: 'state-1', anki_card_id: 'anki-1', front: '', back: '' }],
    });

    await useFsrsReviewStore.getState().startBatchSession(['anki-1']);

    const state = useFsrsReviewStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.error).toBe('Review content is unavailable for Anki card anki-1');
    expect(state.retryBatchRequest?.cardIds).toEqual(['anki-1']);
  });

  it('rejects incomplete or synthetic state identity instead of creating a blank queue', async () => {
    invokeMock.mockResolvedValueOnce({
      states: [{ id: 'chat-batch-1', anki_card_id: 'anki-1', front: 'Q', back: 'A' }],
    });

    await useFsrsReviewStore.getState().startBatchSession(['anki-1']);

    const state = useFsrsReviewStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.error).toBe('fsrs_enqueue_cards returned an invalid review state');
  });

  it('rejects enqueue responses that omit a requested card state', async () => {
    invokeMock.mockResolvedValueOnce({
      states: [{ id: 'state-1', anki_card_id: 'anki-1', front: 'Q1', back: 'A1' }],
    });

    await useFsrsReviewStore.getState().startBatchSession(['anki-1', 'anki-2']);

    const state = useFsrsReviewStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.error).toBe('fsrs_enqueue_cards did not return every requested review state');
  });

  it('applyLaunchPayload due session loads then starts', async () => {
    mockInvokeByCommand({
      fsrs_get_due: [
        { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
      ],
      fsrs_get_stats: { due: 1 },
    });
    useFsrsReviewStore.getState().applyLaunchPayload({
      screen: 'session',
      mode: 'due',
    });

    // loadDue + startDueSession are async
    await vi.waitFor(() => {
      const s = useFsrsReviewStore.getState();
      expect(s.screen).toBe('session');
      expect(s.queue.length).toBe(1);
      expect(s.queue[0]?.id).toBe('state-1');
    });
  });

  it('applyLaunchPayload keeps the current screen and error when due loading fails', async () => {
    mockInvokeByCommand({
      fsrs_get_due: () => { throw new Error('due launch unavailable'); },
      fsrs_get_stats: { due: 0 },
    });

    useFsrsReviewStore.getState().applyLaunchPayload({
      screen: 'session',
      mode: 'due',
    });

    await vi.waitFor(() => {
      const state = useFsrsReviewStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe('due launch unavailable');
    });
    const state = useFsrsReviewStore.getState();
    expect(state.screen).toBe('today');
    expect(state.queue).toEqual([]);
  });

  it('maps complete due metadata from camelCase and snake_case rows', () => {
    expect(mapFsrsRow({
      id: 'state-camel',
      ankiCardId: 'anki-camel',
      front: 'Front',
      back: 'Back',
      text: '{{c1::Text}}',
      tags: ['tag'],
      images: ['image.png'],
      templateId: 'template-camel',
      extraFields: { Hint: 'hint' },
      isErrorCard: true,
      errorContent: 'error',
    })).toEqual({
      id: 'state-camel',
      ankiCardId: 'anki-camel',
      front: 'Front',
      back: 'Back',
      text: '{{c1::Text}}',
      tags: ['tag'],
      images: ['image.png'],
      templateId: 'template-camel',
      extraFields: { Hint: 'hint' },
      isErrorCard: true,
      errorContent: 'error',
    });
    expect(mapFsrsRow({
      id: 'state-snake',
      anki_card_id: 'anki-snake',
      front: 'Question',
      back: 'Answer',
      template_id: 'template-snake',
      extra_fields: { Source: 'book' },
      is_error_card: false,
      error_content: null,
    })).toMatchObject({
      id: 'state-snake',
      ankiCardId: 'anki-snake',
      templateId: 'template-snake',
      extraFields: { Source: 'book' },
      isErrorCard: false,
      errorContent: null,
    });
  });

  it('keeps backend content when caller batch content has blank front/back', async () => {
    invokeMock.mockResolvedValueOnce({
      reviewCards: [{
        id: 'state-1',
        ankiCardId: 'anki-1',
        front: 'Backend front',
        back: 'Backend back',
        text: '{{c1::Backend text}}',
        templateId: 'template-1',
        extraFields: { Source: 'backend' },
      }],
    });

    const started = await useFsrsReviewStore.getState().startBatchSession(
      ['anki-1'],
      [{
        id: 'anki-1',
        ankiCardId: 'anki-1',
        front: '',
        back: '   ',
        text: '{{c1::Caller text}}',
      }],
    );

    expect(started).toBe(true);
    expect(useFsrsReviewStore.getState().queue[0]).toMatchObject({
      front: 'Backend front',
      back: 'Backend back',
      text: '{{c1::Caller text}}',
      templateId: 'template-1',
      extraFields: { Source: 'backend' },
    });
  });

  it('undoes the last rating and returns from the completion index', async () => {
    invokeMock.mockResolvedValueOnce({
      state: { id: 'state-last', ankiCardId: 'anki-last' },
      changed: true,
      undoneLogId: 'log-last',
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-last', ankiCardId: 'anki-last', front: 'Q', back: 'A' }],
      queueIndex: 1,
      flipped: false,
      lastReview: {
        logId: 'log-last',
        cardStateId: 'state-last',
        queueIndex: 0,
      },
    });

    const undone = await useFsrsReviewStore.getState().undoLastReview();

    expect(undone).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('fsrs_undo_last_review', {
      expectedLogId: 'log-last',
      cardStateId: 'state-last',
    });
    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(0);
    expect(state.lastReview).toBeNull();
    expect(state.ratingBusy).toBe(false);
    expect(refreshDueMock).toHaveBeenCalled();
  });

  it('keeps index and undo receipt when undo fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('newer review exists'));
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 1,
      lastReview: { logId: 'log-1', cardStateId: 'state-1', queueIndex: 0 },
    });

    const undone = await useFsrsReviewStore.getState().undoLastReview();

    const state = useFsrsReviewStore.getState();
    expect(undone).toBe(false);
    expect(state.queueIndex).toBe(1);
    expect(state.lastReview).toEqual({
      logId: 'log-1',
      cardStateId: 'state-1',
      queueIndex: 0,
    });
    expect(state.ratingBusy).toBe(false);
    expect(state.errorKind).toBe('undo');
    expect(refreshDueMock).not.toHaveBeenCalled();
  });

  it('updates the current card in place with a complete AnkiCard payload', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    useFsrsReviewStore.setState({
      screen: 'session',
      dueCards: [{
        id: 'state-1',
        ankiCardId: 'anki-1',
        front: 'Old front',
        back: 'Old back',
      }],
      queue: [{
        id: 'state-1',
        ankiCardId: 'anki-1',
        front: 'Old front',
        back: 'Old back',
        text: 'Keep {{c1::text}}',
        tags: ['tag'],
        images: ['image.png'],
        templateId: 'template-1',
        extraFields: {
          Hint: 'keep',
          Front: 'Old front',
          front: 'stale lowercase front',
          back: 'stale lowercase back',
        },
        isErrorCard: true,
        errorContent: 'keep error',
      }],
      queueIndex: 0,
      flipped: true,
    });

    const updated = await useFsrsReviewStore.getState().updateCurrentCard(
      'New front',
      'New back',
      { fields: ['Front', 'Back'], note_type: 'Basic' },
    );

    expect(updated).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('update_anki_card', {
      card: {
        id: 'anki-1',
        front: 'New front',
        back: 'New back',
        text: 'Keep {{c1::text}}',
        tags: ['tag'],
        images: ['image.png'],
        extra_fields: {
          Hint: 'keep',
          Front: 'New front',
          front: 'New front',
          back: 'New back',
          Back: 'New back',
        },
        template_id: 'template-1',
        is_error_card: true,
        error_content: 'keep error',
      },
    });
    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(0);
    expect(state.queue[0]).toMatchObject({
      front: 'New front',
      back: 'New back',
      images: ['image.png'],
      templateId: 'template-1',
      extraFields: {
        Hint: 'keep',
        Front: 'New front',
        front: 'New front',
        back: 'New back',
        Back: 'New back',
      },
      isErrorCard: true,
      errorContent: 'keep error',
    });
    expect(state.dueCards[0]).toMatchObject({ front: 'New front', back: 'New back' });
  });

  it('advances after suspend and can restore the suspended card', async () => {
    invokeMock
      .mockResolvedValueOnce({ state: { id: 'state-1' }, changed: true })
      .mockResolvedValueOnce({ state: { id: 'state-1' }, changed: true });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
        { id: 'state-2', ankiCardId: 'anki-2', front: 'Q2', back: 'A2' },
      ],
      queueIndex: 0,
      flipped: true,
    });

    expect(await useFsrsReviewStore.getState().suspendCurrent()).toBe(true);
    let state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.flipped).toBe(false);
    expect(state.lastSuspended).toEqual({ cardStateId: 'state-1', queueIndex: 0 });

    expect(await state.resumeLastSuspended()).toBe(true);
    state = useFsrsReviewStore.getState();
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'fsrs_unsuspend_card', {
      cardStateId: 'state-1',
    });
    expect(state.queueIndex).toBe(0);
    expect(state.lastSuspended).toBeNull();
  });

  it('leaves the current card rateable when suspend fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('suspend unavailable'));
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
    });

    expect(await useFsrsReviewStore.getState().suspendCurrent()).toBe(false);
    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(0);
    expect(state.flipped).toBe(true);
    expect(state.ratingBusy).toBe(false);
    expect(state.errorKind).toBe('suspend');
  });

  it('advances without offering resume when another window already suspended the card', async () => {
    invokeMock.mockResolvedValueOnce({
      state: { id: 'state-1', suspended: true },
      changed: false,
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
        { id: 'state-2', ankiCardId: 'anki-2', front: 'Q2', back: 'A2' },
      ],
      queueIndex: 0,
      flipped: true,
    });

    expect(await useFsrsReviewStore.getState().suspendCurrent()).toBe(true);
    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.lastSuspended).toBeNull();
  });

  it('endSession refreshes due badge count', () => {
    useFsrsReviewStore.setState({ screen: 'session' });
    useFsrsReviewStore.getState().endSession();
    expect(useFsrsReviewStore.getState().screen).toBe('today');
    expect(refreshDueMock).toHaveBeenCalled();
  });

  it('does not rate before the card is flipped', async () => {
    invokeMock.mockResolvedValueOnce({ logId: 'log-hidden' });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: false,
    });

    await useFsrsReviewStore.getState().rate(3);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useFsrsReviewStore.getState().queueIndex).toBe(0);
  });

  it('requeues learning cards only after they are actually due', async () => {
    const soon = Date.now() - 1;
    invokeMock.mockResolvedValueOnce({
      logId: 'log-learn',
      dueMs: soon,
      scheduledDays: 0,
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      dueTotal: 2,
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
    });

    await useFsrsReviewStore.getState().rate(1);

    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((card) => card.id)).toEqual(['b', 'a']);
    expect(state.queueIndex).toBe(0);
    expect(state.queue[0]?.id).toBe('b');
    expect(state.sessionRatedCount).toBe(1);
    expect(state.sessionAgainCount).toBe(1);
    expect(state.lastSchedule).toEqual({ dueMs: soon, scheduledDays: 0 });
    expect(state.lastRated).toBeNull();
  });

  it('loadDue sets dueTotal from stats in parallel with due cards', async () => {
    mockInvokeByCommand({
      fsrs_get_due: [
        { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
      ],
      fsrs_get_stats: { due: 12 },
    });

    const loaded = await useFsrsReviewStore.getState().loadDue();
    const state = useFsrsReviewStore.getState();
    expect(loaded).toBe(true);
    expect(state.dueCards).toHaveLength(1);
    expect(state.dueTotal).toBe(12);
  });

  it('sets remainingDueAfterSession when the rated batch finishes', async () => {
    mockInvokeByCommand({
      fsrs_rate: {
        logId: 'log-last',
        dueMs: Date.now() + 3 * 24 * 60 * 60 * 1000,
        scheduledDays: 3,
      },
      fsrs_get_stats: { due: 4 },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      dueTotal: 5,
      queue: [{ id: 'only', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
      sessionRatedCount: 0,
    });

    await useFsrsReviewStore.getState().rate(3);
    await vi.waitFor(() => {
      expect(useFsrsReviewStore.getState().remainingDueAfterSession).toBe(4);
    });

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.sessionRatedCount).toBe(1);
    expect(state.dueTotal).toBe(4);
  });

  it('reconcileExternalRate removes peer-rated cards but ignores local echo', () => {
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
      lastReview: null,
      recentLocalLogIds: [],
    });
    useFsrsReviewStore.getState().reconcileExternalRate(['a']);
    expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual(['b']);
    expect(useFsrsReviewStore.getState().queueIndex).toBe(0);
    expect(useFsrsReviewStore.getState().flipped).toBe(false);

    useFsrsReviewStore.setState({
      queue: [
        { id: 'b', front: 'B', back: 'b' },
        { id: 'a', front: 'A', back: 'a' },
      ],
      queueIndex: 0,
      flipped: false,
      lastReview: { logId: 'log-a', cardStateId: 'a', queueIndex: 0 },
      recentLocalLogIds: ['log-a'],
    });
    useFsrsReviewStore.getState().reconcileExternalRate(['a'], {
      cardLogPairs: [{ cardStateId: 'a', logId: 'log-a' }],
    });
    expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('undo after learning requeue restores queue order and counters', async () => {
    const soon = Date.now() - 1;
    mockInvokeByCommand({
      fsrs_rate: {
        logId: 'log-again',
        dueMs: soon,
        scheduledDays: 0,
        cardState: { id: 'a', lastReviewMs: 111 },
      },
      fsrs_undo_last_review: {
        changed: true,
        undoneLogId: 'log-again',
        state: { id: 'a', lastReviewMs: null },
      },
    });
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
      sessionRatedCount: 0,
      sessionAgainCount: 0,
    });

    await useFsrsReviewStore.getState().rate(1);
    expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual(['b', 'a']);
    expect(useFsrsReviewStore.getState().sessionRatedCount).toBe(1);
    expect(useFsrsReviewStore.getState().sessionAgainCount).toBe(1);

    const undone = await useFsrsReviewStore.getState().undoLastReview();
    expect(undone).toBe(true);
    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((c) => c.id)).toEqual(['a', 'b']);
    expect(state.queueIndex).toBe(0);
    expect(state.sessionRatedCount).toBe(0);
    expect(state.sessionAgainCount).toBe(0);
  });

});
