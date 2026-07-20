import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { handleExamActivation } from '../../apps/content/register';
import {
  clearResourceWorkspaceActive,
  setResourceWorkspaceActive,
} from '../../apps/content/resourceWorkspaceRegistry';
import { handleSandboxActivation } from '../../apps/sandbox/register';
import { handleFlashcardsActivation } from '../../apps/system/register';
import { createFlashcardsAgentManifest } from '../../apps/system/agentManifests';
import { fsrsDriver } from '../drivers/fsrsDriver';
import { qbankDriver } from '../drivers/qbankDriver';
import { sandboxDriver } from '../drivers/sandboxDriver';

const invokeMock = vi.mocked(invoke);

describe('ACR 非 Notes 应用 activation', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
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
    clearResourceWorkspaceActive('exam');
  });

  it('exam 水合后端练习 handoff，并拒绝任何 Agent 预填答案', async () => {
    setResourceWorkspaceActive('exam', 'exam-1');
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{
        action: string;
        payload?: { handoff?: unknown };
        acknowledge?: (result: Record<string, unknown>) => void;
      }>).detail;
      if (detail.action !== 'hydratePracticeSession') return;
      const hydration = useQuestionBankStore
        .getState()
        .hydratePracticeHandoff(detail.payload?.handoff, 'exam-1');
      detail.acknowledge?.(hydration.ok
        ? {
            handled: true,
            acknowledged: true,
            hydratedSessionId: hydration.handoffId,
            practiceMode: hydration.mode,
          }
        : { handled: false, code: hydration.code, hint: hydration.hint });
    };
    window.addEventListener('qbank:control', listener);

    const handoff = {
      version: 1,
      kind: 'qbank_practice_session',
      handoff_id: 'mock-1',
      exam_id: 'exam-1',
      mode: 'mock_exam',
      agentCanAnswer: false,
      session: {
        id: 'mock-1',
        exam_id: 'exam-1',
        config: {
          duration_minutes: 60,
          type_distribution: {},
          difficulty_distribution: {},
          total_count: 2,
          shuffle: true,
          include_mistakes: true,
        },
        question_ids: ['q1', 'q2'],
        started_at: '2026-07-14T08:00:00.000Z',
        ended_at: null,
        answers: {},
        results: {},
        is_submitted: false,
        score: null,
        correct_rate: null,
      },
    };

    await expect(handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'hydratePracticeSession',
      payload: { handoff },
    })).resolves.toEqual({ handled: true, acknowledged: true });
    expect(useQuestionBankStore.getState()).toMatchObject({
      practiceMode: 'mock_exam',
      mockExamSession: { id: 'mock-1', answers: {}, results: {} },
    });

    const prefilled = structuredClone(handoff);
    prefilled.handoff_id = 'mock-agent-answer';
    prefilled.session.id = 'mock-agent-answer';
    prefilled.session.answers = { q1: 'A' };
    prefilled.session.results = { q1: true };
    await expect(handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'hydratePracticeSession',
      payload: { handoff: prefilled },
    })).resolves.toMatchObject({
      handled: false,
      code: 'INVALID_PRACTICE_HANDOFF',
    });
    expect(useQuestionBankStore.getState().mockExamSession?.id).toBe('mock-1');

    window.removeEventListener('qbank:control', listener);
  });

  it('exam 支持前后题、练习模式、专注模式和筛选', async () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{
        action: string;
        acknowledge?: (result: { handled: boolean; currentQuestionId?: string }) => void;
      }>).detail;
      detail.acknowledge?.({
        handled: true,
        currentQuestionId: detail.action === 'nextQuestion' ? 'q2' : undefined,
      });
    };
    // ACR 4.0（A7）：setFocusMode 走 exam:setFocusMode 表面 ACK，视图写全局 store
    const focusModeListener = (event: Event) => {
      const detail = (event as CustomEvent<{
        enabled?: boolean;
        acknowledge?: (result: {
          handled: boolean;
          changed?: boolean;
          previousEnabled?: boolean;
        }) => void;
      }>).detail;
      const previous = useQuestionBankStore.getState().focusMode;
      useQuestionBankStore.getState().setFocusMode(detail.enabled === true);
      detail.acknowledge?.({
        handled: true,
        changed: previous !== (detail.enabled === true),
        previousEnabled: previous,
      });
    };
    window.addEventListener('qbank:control', listener);
    window.addEventListener('exam:setFocusMode', focusModeListener);
    try {
      // handleExamActivation 为 async（题库 store 在 handler 内动态 import）
      await expect(handleExamActivation({
        windowId: 'exam-win',
        instanceKey: 'exam-1',
        action: 'nextQuestion',
      })).resolves.toEqual({ handled: true, currentQuestionId: 'q2' });
      expect(useQuestionBankStore.getState().currentQuestionId).toBe('q2');

      await handleExamActivation({
        windowId: 'exam-win',
        instanceKey: 'exam-1',
        action: 'setPracticeMode',
        payload: { mode: 'review_only' },
      });
      await handleExamActivation({
        windowId: 'exam-win',
        instanceKey: 'exam-1',
        action: 'setFocusMode',
        payload: { enabled: true },
      });
      await handleExamActivation({
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
    } finally {
      window.removeEventListener('qbank:control', listener);
      window.removeEventListener('exam:setFocusMode', focusModeListener);
    }
  });

  it('exam setFocusMode 无挂载视图时诚实失败', async () => {
    await expect(handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'setFocusMode',
      payload: { enabled: true },
    })).resolves.toMatchObject({ handled: false, code: 'WINDOW_NOT_FOUND' });
  });

  it('exam 设置 action 仅在目标视图确认接收后返回 handled', async () => {
    const received: { targetResourceId?: string; open?: boolean }[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{
        targetResourceId?: string;
        open?: boolean;
        acknowledge?: (result: { handled: boolean }) => void;
      }>).detail;
      received.push(detail);
      detail.acknowledge?.({ handled: true });
    };
    window.addEventListener('exam:openSettings', listener);

    await expect(handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'showSettings',
      payload: { open: true },
    })).resolves.toEqual({ handled: true, acknowledged: true });
    expect(received).toEqual([{ targetResourceId: 'exam-1', open: true, acknowledge: expect.any(Function) }]);

    window.removeEventListener('exam:openSettings', listener);
    await expect(handleExamActivation({
      windowId: 'exam-win',
      instanceKey: 'exam-1',
      action: 'showSettings',
      payload: { open: false },
    })).resolves.toMatchObject({ handled: false, code: 'WINDOW_NOT_FOUND' });
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

  it('flashcards due 加载失败时所有 Workbench 入口都不会进入空会话', async () => {
    invokeMock.mockRejectedValueOnce(new Error('due activation unavailable'));

    const activationResult = await handleFlashcardsActivation({
      windowId: 'fc-win',
      instanceKey: null,
      action: 'startDueReview',
    });

    expect(activationResult).toMatchObject({
      handled: false,
      code: 'LOAD_FAILED',
      hint: 'due activation unavailable',
    });
    expect(useFsrsReviewStore.getState()).toMatchObject({
      screen: 'today',
      queue: [],
      error: 'due activation unavailable',
    });

    useFsrsReviewStore.setState({ screen: 'today', queue: [], error: null });
    invokeMock.mockRejectedValueOnce(new Error('due manifest unavailable'));
    const manifest = createFlashcardsAgentManifest(handleFlashcardsActivation);
    const manifestResult = await manifest.execute!(
      { windowId: 'fc-win', typeId: 'flashcards', instanceKey: null },
      { name: 'startReview', args: { screen: 'session', mode: 'due' } },
    );

    expect(manifestResult).toMatchObject({
      handled: false,
      changed: false,
      code: 'LOAD_FAILED',
      hint: 'due manifest unavailable',
    });
    expect(useFsrsReviewStore.getState()).toMatchObject({
      screen: 'today',
      queue: [],
      error: 'due manifest unavailable',
    });
  });

  it('flashcards agent batch 依据完整 reviewCards 返回真实成功或失败回执', async () => {
    invokeMock.mockResolvedValueOnce({
      enqueued: 0,
      skipped: 1,
      states: [{ id: 'state-existing', ankiCardId: 'anki-1' }],
      reviewCards: [
        {
          id: 'state-existing',
          ankiCardId: 'anki-1',
          front: 'Question',
          back: 'Answer',
        },
      ],
    });
    const manifest = createFlashcardsAgentManifest(handleFlashcardsActivation);

    const success = await manifest.execute!(
      { windowId: 'fc-win', typeId: 'flashcards', instanceKey: null },
      { name: 'startReview', args: { screen: 'session', mode: 'batch', cardIds: ['anki-1'] } },
    );

    expect(success).toMatchObject({ handled: true, changed: true });
    expect(useFsrsReviewStore.getState().queue[0]).toMatchObject({
      id: 'state-existing',
      ankiCardId: 'anki-1',
      front: 'Question',
      back: 'Answer',
    });

    useFsrsReviewStore.setState({ screen: 'today', queue: [], error: null });
    invokeMock.mockResolvedValueOnce({ states: [{ id: 'state-2', ankiCardId: 'anki-2' }] });
    const failure = await manifest.execute!(
      { windowId: 'fc-win', typeId: 'flashcards', instanceKey: null },
      { name: 'startReview', args: { screen: 'session', mode: 'batch', cardIds: ['anki-2'] } },
    );

    expect(failure).toMatchObject({
      handled: false,
      changed: false,
      code: 'ENQUEUE_FAILED',
      hint: i18n.t('flashcards:session.errors.reviewContentUnavailable', {
        cardId: 'anki-2',
      }),
    });
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

  it('sandbox 支持刷新、视口、检查器与状态查询；setMode 诚实拒绝（无真实渲染差异）', () => {
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
    })).toEqual({ handled: true, acknowledged: true });
    handleSandboxActivation({
      windowId: 'sandbox-win',
      instanceKey: null,
      action: 'setInspector',
      payload: { open: true },
    });
    // ACR 4.0（A6 诚实化）：渲染面固定 chat-safe 安全预览，切模式无真实效果 → 拒绝
    expect(handleSandboxActivation({
      windowId: 'sandbox-win',
      instanceKey: null,
      action: 'setMode',
      payload: { mode: 'sandbox-run' },
    })).toMatchObject({
      handled: false,
      code: 'ACTION_UNAVAILABLE',
      hint: expect.stringContaining('安全预览'),
    });

    expect(sandboxDriver.queryState()).toMatchObject({
      title: 'Preview',
      viewportPreset: 'mobile',
      inspectorOpen: true,
      // mode 报告真实渲染形态（固定 safe-preview）
      mode: 'safe-preview',
    });
  });
});
