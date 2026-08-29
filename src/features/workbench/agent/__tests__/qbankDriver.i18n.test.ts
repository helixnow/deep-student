/**
 * qbankDriver 用户/agent 可见回执文案 i18n 契约 — exam_sheet:agent.*
 *
 * key-echo mock：断言与语言无关（真实运行时由 exam_sheet.json 提供 zh-CN / en-US 文案，
 * driver 侧 defaultValue 兜底 namespace 异步加载窗口期）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

const { qbankState, setCurrentQuestion } = vi.hoisted(() => {
  const qbankState = { currentQuestionId: null as string | null };
  return {
    qbankState,
    setCurrentQuestion: vi.fn((id: string | null) => {
      qbankState.currentQuestionId = id;
    }),
  };
});

vi.mock('@/stores/questionBankStore', () => ({
  useQuestionBankStore: {
    getState: () => ({
      currentQuestionId: qbankState.currentQuestionId,
      setCurrentQuestion,
    }),
  },
}));

vi.mock('../visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany: vi.fn(),
}));

import {
  QBANK_FOCUS_EVENT,
  qbankDriver,
  type QbankFocusEventDetail,
} from '../drivers/qbankDriver';
import type { AcrRunContext, AgentOp, Pacer, RunLedger } from '../types';

function makeRun(runId: string): AcrRunContext {
  const pacing: Pacer = {
    profile: {
      name: 'fast',
      opIntervalMs: 0,
      typeBatchMin: 1,
      typeBatchMax: 1,
      typeIntervalMs: 0,
      instant: true,
    },
    tick: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const ledger: RunLedger = {
    record: vi.fn(),
    revertRun: vi.fn(async () => true),
    hasRun: vi.fn(() => false),
    sealRun: vi.fn(),
  };
  return {
    runId,
    sessionId: 'session',
    target: { typeId: 'exam' },
    windowId: 'window',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume'),
    ledger,
  };
}

function focusOp(questionId: string, label?: string): AgentOp {
  return {
    kind: 'qbank_focus_question',
    destructive: false,
    ...(label ? { label } : {}),
    payload: { questionId },
  };
}

/** 挂一个焦点监听器并保证用例结束后移除 */
async function withFocusListener(
  respond: (detail: QbankFocusEventDetail) => void,
  body: () => Promise<void>,
): Promise<void> {
  const onFocus = (event: Event) => {
    respond((event as CustomEvent<QbankFocusEventDetail>).detail);
  };
  window.addEventListener(QBANK_FOCUS_EVENT, onFocus);
  try {
    await body();
  } finally {
    window.removeEventListener(QBANK_FOCUS_EVENT, onFocus);
  }
}

beforeEach(() => {
  tSpy.mockClear();
  setCurrentQuestion.mockClear();
  qbankState.currentQuestionId = null;
});

describe('qbankDriver apply — 回执文案走 exam_sheet:agent.* key', () => {
  it('可见题库未找到该题 → question_not_visible（label 作插值参数）', async () => {
    await withFocusListener(
      (detail) => detail.acknowledge?.({ handled: false, previousQuestionId: 'q-keep' }),
      async () => {
        const receipt = await qbankDriver.apply(makeRun('run-not-visible'), [
          focusOp('q-missing', 'focus missing'),
        ]);

        expect(receipt.status).toBe('failed');
        expect(receipt.undone).toEqual(['exam_sheet:agent.question_not_visible']);
        expect(tSpy).toHaveBeenCalledWith(
          'exam_sheet:agent.question_not_visible',
          expect.objectContaining({
            label: 'focus missing',
            defaultValue: expect.any(String),
          }),
        );
      },
    );
  });

  it('无 label 的聚焦成功 → focus_question_done（questionId 作插值参数）', async () => {
    await withFocusListener(
      (detail) => detail.acknowledge?.({ handled: true, previousQuestionId: null }),
      async () => {
        const receipt = await qbankDriver.apply(makeRun('run-focus-done'), [
          focusOp('q-new'),
        ]);

        expect(receipt.status).toBe('completed');
        expect(receipt.done).toEqual(['exam_sheet:agent.focus_question_done']);
        expect(tSpy).toHaveBeenCalledWith(
          'exam_sheet:agent.focus_question_done',
          expect.objectContaining({ questionId: 'q-new' }),
        );
      },
    );
  });

  it('撤销时恢复目标已不可见 → undo_question_missing', async () => {
    let firstDispatch = true;
    const run = makeRun('run-undo-missing');
    await withFocusListener(
      (detail) => {
        if (firstDispatch) {
          firstDispatch = false;
          detail.acknowledge?.({ handled: true, previousQuestionId: 'q-old' });
        } else {
          detail.acknowledge?.({ handled: false, previousQuestionId: 'q-new' });
        }
      },
      async () => {
        const receipt = await qbankDriver.apply(run, [focusOp('q-new')]);
        expect(receipt.status).toBe('completed');
        expect(run.ledger.record).toHaveBeenCalledTimes(1);

        const invert = vi.mocked(run.ledger.record).mock.calls[0]![1] as () => void;
        expect(() => invert()).toThrow('exam_sheet:agent.undo_question_missing');
        expect(tSpy).toHaveBeenCalledWith(
          'exam_sheet:agent.undo_question_missing',
          expect.objectContaining({ questionId: 'q-old' }),
        );
      },
    );
  });

  it('非导航 op 全部失败 → unsupported_hint 作为 message', async () => {
    const receipt = await qbankDriver.apply(makeRun('run-unsupported'), [
      { kind: 'qbank_update', destructive: true, label: '写数据', payload: {} },
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['写数据']);
    expect(receipt.message).toBe('exam_sheet:agent.unsupported_hint');
    expect(tSpy).toHaveBeenCalledWith(
      'exam_sheet:agent.unsupported_hint',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
  });
});

describe('qbankDriver abort — 回执文案走 exam_sheet:agent.* key', () => {
  it('运行中 abort → nav_aborted', async () => {
    const run = makeRun('run-abort-live');
    let abortReceipt: ReturnType<typeof qbankDriver.abort> | null = null;
    vi.mocked(run.pacing.tick).mockImplementation(async () => {
      if (!abortReceipt) abortReceipt = qbankDriver.abort(run.runId);
    });

    await withFocusListener(
      (detail) => detail.acknowledge?.({ handled: true, previousQuestionId: null }),
      async () => {
        const receipt = await qbankDriver.apply(run, [
          focusOp('q-1', 'first'),
          focusOp('q-2', 'second'),
        ]);

        expect(abortReceipt).toMatchObject({
          status: 'cancelled',
          message: 'exam_sheet:agent.nav_aborted',
        });
        expect(receipt.status).toBe('cancelled');
        expect(tSpy).toHaveBeenCalledWith(
          'exam_sheet:agent.nav_aborted',
          expect.objectContaining({ defaultValue: expect.any(String) }),
        );
      },
    );
  });

  it('run 不存在 → run_not_found（runId 作插值参数）', () => {
    const receipt = qbankDriver.abort('run-ghost');

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('exam_sheet:agent.run_not_found');
    expect(tSpy).toHaveBeenCalledWith(
      'exam_sheet:agent.run_not_found',
      expect.objectContaining({ runId: 'run-ghost' }),
    );
  });
});
