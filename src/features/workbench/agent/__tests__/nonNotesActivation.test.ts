import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { handleExamActivation } from '../../apps/content/register';
import { handleSandboxActivation } from '../../apps/sandbox/register';
import { handleFlashcardsActivation } from '../../apps/system/register';
import { fsrsDriver } from '../drivers/fsrsDriver';
import { qbankDriver } from '../drivers/qbankDriver';
import { sandboxDriver } from '../drivers/sandboxDriver';

describe('ACR 非 Notes 应用 activation', () => {
  beforeEach(() => {
    useQuestionBankStore.setState({
      questions: new Map([
        ['q1', { id: 'q1', status: 'new', question_type: 'single_choice' } as never],
        ['q2', { id: 'q2', status: 'review', question_type: 'multiple_choice' } as never],
      ]),
      questionOrder: ['q1', 'q2'],
      currentQuestionId: 'q1',
      filters: {},
      practiceMode: 'sequential',
      focusMode: false,
      showSettingsPanel: false,
    });
    useFsrsReviewStore.setState({
      screen: 'today',
      dueCards: [],
      queue: [],
      queueIndex: 0,
      flipped: false,
      loading: false,
      ratingBusy: false,
      error: null,
      lastRated: null,
    });
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });
  });

  it('exam 支持前后题、练习模式、专注模式和筛选', () => {
    expect(handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'nextQuestion',
    })).toEqual({ handled: true });
    expect(useQuestionBankStore.getState().currentQuestionId).toBe('q2');

    handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'setPracticeMode',
      payload: { mode: 'review_only' },
    });
    handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'setFocusMode',
      payload: { enabled: true },
    });
    handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'setFilters',
      payload: { filters: { is_favorite: true } },
    });

    expect(useQuestionBankStore.getState()).toMatchObject({
      practiceMode: 'review_only',
      focusMode: true,
      filters: { is_favorite: true },
    });
  });

  it('flashcards 支持页面切换、翻面和结束会话，但不提供评分 action', async () => {
    await handleFlashcardsActivation({
      windowId: 'fc-win',
      instanceKey: null,
      action: 'showScreen',
      payload: { screen: 'session' },
    });
    useFsrsReviewStore.setState({
      queue: [{ id: 'card-1', front: 'front', back: 'back' }],
      queueIndex: 0,
    });
    expect((await handleFlashcardsActivation({
      windowId: 'fc-win',
      instanceKey: null,
      action: 'flipCard',
    })).handled).toBe(true);
    expect(useFsrsReviewStore.getState().flipped).toBe(true);

    await handleFlashcardsActivation({
      windowId: 'fc-win',
      instanceKey: null,
      action: 'endReview',
    });
    expect(useFsrsReviewStore.getState().screen).toBe('today');

    const rate = await handleFlashcardsActivation({
      windowId: 'fc-win',
      instanceKey: null,
      action: 'rate',
      payload: { rating: 4 },
    });
    expect(rate).toMatchObject({ handled: false, code: 'UNKNOWN_ACTION' });
  });

  it('Driver queryState 返回题库和复习会话的高信号摘要', () => {
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'card-1', ankiCardId: 'anki-1', front: 'front', back: 'back' }],
      queueIndex: 0,
      flipped: true,
    });

    expect(qbankDriver.queryState()).toMatchObject({
      currentQuestionId: 'q1',
      questionCount: 2,
      practiceMode: 'sequential',
    });
    expect(fsrsDriver.queryState()).toMatchObject({
      screen: 'session',
      currentCardId: 'card-1',
      currentAnkiCardId: 'anki-1',
      flipped: true,
    });
  });

  it('sandbox 支持刷新、视口、检查器、运行模式与状态查询', () => {
    useSandboxWorkbenchStore.getState().openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'message-1',
      language: 'html',
      title: 'Preview',
      content: '<h1>Preview</h1>',
    }, LEGACY_SANDBOX_OWNER_KEY);

    expect(handleSandboxActivation({
      windowId: 'sandbox-win',
      instanceKey: null,
      action: 'setViewport',
      payload: { viewport: 'mobile' },
    })).toEqual({ handled: true });
    handleSandboxActivation({
      windowId: 'sandbox-win',
      instanceKey: null,
      action: 'setInspector',
      payload: { open: true },
    });
    handleSandboxActivation({
      windowId: 'sandbox-win',
      instanceKey: null,
      action: 'setMode',
      payload: { mode: 'sandbox-run' },
    });

    expect(sandboxDriver.queryState()).toMatchObject({
      title: 'Preview',
      viewportPreset: 'mobile',
      inspectorOpen: true,
      mode: 'sandbox-run',
    });
  });
});
