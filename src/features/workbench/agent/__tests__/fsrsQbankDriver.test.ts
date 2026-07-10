/**
 * R1-15 — appendToQueue 铁律 + qbank 刷新守卫
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany: vi.fn(),
}));

import { useFsrsReviewStore, type ReviewCard } from '@/features/flashcards/store/fsrsReviewStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  __resetQbankDriverForTests,
  handleQbankDomainChange,
  isQbankInlineEditorActive,
  QBANK_FOCUS_EVENT,
  refreshQbankPreservingCurrent,
  qbankDriver,
} from '../drivers/qbankDriver';
import { fsrsDriver, handleFsrsDomainChange } from '../drivers/fsrsDriver';
import type { AcrRunContext, Pacer, RunLedger } from '../types';

const card = (id: string, front = id): ReviewCard => ({
  id,
  ankiCardId: id,
  front,
  back: `back-${id}`,
});

function makeRun(typeId: string): { run: AcrRunContext; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn();
  const ledger: RunLedger = {
    record,
    revertRun: vi.fn(async () => true),
    hasRun: vi.fn(() => false),
    sealRun: vi.fn(),
  };
  const pacing: Pacer = {
    profile: {
      name: 'fast',
      opIntervalMs: 0,
      typeBatchMin: 8,
      typeBatchMax: 40,
      typeIntervalMs: 0,
      instant: true,
    },
    tick: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return {
    record,
    run: {
      runId: `run-${typeId}`,
      sessionId: 'session',
      target: { typeId },
      windowId: 'window',
      pacing,
      reportProgress: vi.fn(),
      checkPaused: vi.fn(async () => 'resume' as const),
      ledger,
    },
  };
}

describe('appendToQueue 铁律（R1-15）', () => {
  beforeEach(() => {
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [card('a'), card('b'), card('c')],
      queueIndex: 1,
      flipped: true,
      loading: false,
      ratingBusy: false,
      usingMock: true,
      error: null,
      lastRated: null,
      dueCards: [],
    });
  });

  it('appendToQueue 去重入队且不重置 queueIndex / flipped', () => {
    const added = useFsrsReviewStore.getState().appendToQueue([
      card('b'), // 已在队列 → 忽略
      card('d'),
      card('e'),
    ]);
    expect(added).toBe(2);

    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(state.queueIndex).toBe(1);
    expect(state.flipped).toBe(true);
    expect(state.queue[state.queueIndex]?.id).toBe('b');
  });

  it('非 session 时 appendToQueue 为 no-op', () => {
    useFsrsReviewStore.setState({ screen: 'today', queueIndex: 0 });
    const added = useFsrsReviewStore.getState().appendToQueue([card('x')]);
    expect(added).toBe(0);
    expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('fsrs://changed 在 session 中仅 appendToQueue，不重置 queueIndex', () => {
    handleFsrsDomainChange({
      source: 'agent',
      action: 'enqueue',
      entityIds: ['d', 'a'],
      // driver 支持扩展 cards 字段（完整 ReviewCard）
      ...({ cards: [card('d'), card('a')] } as object),
    });

    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(state.queueIndex).toBe(1);
    expect(state.flipped).toBe(true);
    expect(state.screen).toBe('session');
  });

  it('R2-04：session 中 entity_ids 亦可 append（命名一致）', () => {
    handleFsrsDomainChange({
      source: 'agent',
      action: 'enqueue',
      ...({ entity_ids: ['z'] } as object),
    } as never);

    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((c) => c.id)).toContain('z');
    expect(state.queueIndex).toBe(1);
  });
});

describe('qbank 刷新守卫（R1-15）', () => {
  beforeEach(() => {
    __resetQbankDriverForTests();
    useQuestionBankStore.setState({
      currentExamId: 'exam-1',
      currentQuestionId: 'q-keep',
      questions: new Map([
        ['q-keep', { id: 'q-keep' } as never],
        ['q-other', { id: 'q-other' } as never],
      ]),
      questionOrder: ['q-keep', 'q-other'],
      filters: {},
      pagination: { page: 1, pageSize: 50, total: 2, hasMore: false },
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    __resetQbankDriverForTests();
    vi.restoreAllMocks();
  });

  it('refreshQbankPreservingCurrent 刷新后恢复 currentQuestionId', async () => {
    const refreshSpy = vi
      .spyOn(useQuestionBankStore.getState(), 'refreshQuestions')
      .mockImplementation(async () => {
        // 模拟 loadQuestions 把 current 重置为第一题
        useQuestionBankStore.setState({
          currentQuestionId: 'q-other',
          questions: new Map([
            ['q-keep', { id: 'q-keep' } as never],
            ['q-other', { id: 'q-other' } as never],
            ['q-new', { id: 'q-new' } as never],
          ]),
        });
      });

    await refreshQbankPreservingCurrent({
      source: 'agent',
      action: 'changed',
      entityIds: ['q-new'],
    });

    expect(refreshSpy).toHaveBeenCalled();
    expect(useQuestionBankStore.getState().currentQuestionId).toBe('q-keep');
  });

  it('行内编辑中延迟刷新（不立即调用 refreshQuestions）', async () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(isQbankInlineEditorActive()).toBe(true);

    const refreshSpy = vi
      .spyOn(useQuestionBankStore.getState(), 'refreshQuestions')
      .mockResolvedValue(undefined);

    // 编辑中：立即返回并排程，不 await 完整刷新
    void refreshQbankPreservingCurrent({
      source: 'agent',
      action: 'changed',
      entityIds: ['q-1'],
    });
    expect(refreshSpy).not.toHaveBeenCalled();

    // 结束编辑后再推进定时器，触发延迟刷新
    input.blur();
    document.body.removeChild(input);
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('handleQbankDomainChange 触发守卫刷新', async () => {
    const refreshSpy = vi
      .spyOn(useQuestionBankStore.getState(), 'refreshQuestions')
      .mockImplementation(async () => {
        useQuestionBankStore.setState({ currentQuestionId: 'q-other' });
      });

    handleQbankDomainChange({
      source: 'user',
      action: 'update',
      entityIds: ['q-keep'],
    });

    // 异步刷新
    await vi.waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    expect(useQuestionBankStore.getState().currentQuestionId).toBe('q-keep');
  });

  it('R2-04：QBANK_FOCUS_EVENT 与 onActivation focusQuestion 事件名一致', () => {
    expect(QBANK_FOCUS_EVENT).toBe('qbank:focus-question');
    const seen: string[] = [];
    const onFocus = (ev: Event) => {
      const detail = (ev as CustomEvent<{ questionId?: string }>).detail;
      if (detail?.questionId) seen.push(detail.questionId);
    };
    window.addEventListener(QBANK_FOCUS_EVENT, onFocus);
    try {
      window.dispatchEvent(
        new CustomEvent(QBANK_FOCUS_EVENT, { detail: { questionId: 'q-42' } }),
      );
      expect(seen).toEqual(['q-42']);
    } finally {
      window.removeEventListener(QBANK_FOCUS_EVENT, onFocus);
    }
  });
});


describe('driver undo truthfulness', () => {
  it('FSRS append-only enqueue does not create a fake inverse', async () => {
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [card('a')],
      queueIndex: 0,
      flipped: false,
    });
    const { run, record } = makeRun('flashcards');

    const receipt = await fsrsDriver.apply(run, [
      {
        kind: 'fsrs_enqueue',
        destructive: false,
        label: 'enqueue',
        payload: { cards: [card('b')] },
      },
    ]);

    expect(receipt.status).toBe('completed');
    expect(record).not.toHaveBeenCalled();
    expect(useFsrsReviewStore.getState().queue.map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('QBank focus records an inverse that restores the previous selection', async () => {
    useQuestionBankStore.setState({ currentQuestionId: 'q-keep' });
    const { run, record } = makeRun('exam');

    const receipt = await qbankDriver.apply(run, [
      {
        kind: 'qbank_focus_question',
        destructive: false,
        label: 'focus',
        payload: { questionId: 'q-new' },
      },
    ]);

    expect(receipt.status).toBe('completed');
    expect(useQuestionBankStore.getState().currentQuestionId).toBe('q-new');
    expect(record).toHaveBeenCalledTimes(1);

    const invert = record.mock.calls[0]![1] as () => void;
    invert();
    expect(useQuestionBankStore.getState().currentQuestionId).toBe('q-keep');
  });
});
