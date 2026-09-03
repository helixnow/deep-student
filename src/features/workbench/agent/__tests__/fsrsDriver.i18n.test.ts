/**
 * fsrsDriver 用户/agent 可见错误文案 i18n 契约 — workspace:agent.fsrs.*
 *
 * key-echo mock：断言与语言无关（真实运行时由 workspace.json 提供 zh-CN / en-US 文案，
 * driver 侧 defaultValue 兜底 namespace 异步加载窗口期）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

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
import zhWorkspace from '@/locales/zh-CN/workspace.json';
import enWorkspace from '@/locales/en-US/workspace.json';
import { fsrsDriver } from '../drivers/fsrsDriver';
import type { AcrRunContext, AgentOp, Pacer, RunLedger } from '../types';

const card = (id: string, front = id): ReviewCard => ({
  id,
  ankiCardId: id,
  front,
  back: `back-${id}`,
});

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
    target: { typeId: 'flashcards' },
    windowId: 'window',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume'),
    ledger,
  };
}

function enqueueOp(cards: ReviewCard[], label = ''): AgentOp {
  return { kind: 'fsrs_enqueue', destructive: false, label, payload: { cards } };
}

beforeEach(() => {
  tSpy.mockClear();
  useFsrsReviewStore.setState({
    screen: 'session',
    queue: [card('a')],
    queueIndex: 0,
    flipped: false,
    loading: false,
    ratingBusy: false,
    usingMock: true,
    error: null,
    errorKind: null,
    lastRated: null,
    lastReview: null,
    lastSuspended: null,
    dueCards: [],
  });
});

describe('fsrsDriver apply — 回执文案走 workspace:agent.fsrs.* key', () => {
  it('checkPaused → abort：cancelled 回执 message 为 queue_not_reset，不再硬编码中文', async () => {
    const run = makeRun('run-abort-pause');
    run.checkPaused = vi.fn(async () => 'abort');

    const receipt = await fsrsDriver.apply(run, [enqueueOp([card('d')], '入队新卡')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('workspace:agent.fsrs.queue_not_reset');
    expect(receipt.undone).toEqual(['入队新卡']);
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.fsrs.queue_not_reset',
      expect.objectContaining({ defaultValue: '用户中断，复习队列未重置' }),
    );
  });

  it('screen ≠ session：failed 回执 message 为 enqueue_requires_session', async () => {
    useFsrsReviewStore.setState({ screen: 'today' });

    const receipt = await fsrsDriver.apply(makeRun('run-not-session'), [
      enqueueOp([card('d')], '入队新卡'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.message).toBe('workspace:agent.fsrs.enqueue_requires_session');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.fsrs.enqueue_requires_session',
      expect.objectContaining({
        defaultValue: '无可应用的 fsrs_enqueue（需处于复习 session）',
      }),
    );
  });

  it('op.label 缺省时 done 兜底为 enqueued_cards（携带 count）', async () => {
    const receipt = await fsrsDriver.apply(makeRun('run-done-fallback'), [
      enqueueOp([card('d'), card('e')]),
    ]);

    expect(receipt.status).toBe('completed');
    expect(receipt.done).toEqual(['workspace:agent.fsrs.enqueued_cards']);
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.fsrs.enqueued_cards',
      expect.objectContaining({ count: 2 }),
    );
  });

  it('全部卡已在队列时 undone 兜底为 already_in_queue（携带 kind）', async () => {
    const receipt = await fsrsDriver.apply(makeRun('run-dup'), [
      enqueueOp([card('a')]),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['workspace:agent.fsrs.already_in_queue']);
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.fsrs.already_in_queue',
      expect.objectContaining({ kind: 'fsrs_enqueue' }),
    );
  });
});

describe('fsrsDriver abort — 回执文案走 workspace:agent.fsrs.* key', () => {
  it('运行中 abort → abort_queue_not_reset；apply 收尾回执为 queue_not_reset', async () => {
    let release!: (value: 'resume' | 'abort') => void;
    const gate = new Promise<'resume' | 'abort'>((resolve) => {
      release = resolve;
    });
    const run = makeRun('run-abort-live');
    run.checkPaused = vi.fn(() => gate);

    const applying = fsrsDriver.apply(run, [enqueueOp([card('d')], '入队新卡')]);
    // 等 apply 走进 checkPaused 的 gate
    await new Promise((resolve) => setTimeout(resolve, 0));

    const abortReceipt = fsrsDriver.abort('run-abort-live');
    expect(abortReceipt.status).toBe('cancelled');
    expect(abortReceipt.message).toBe('workspace:agent.fsrs.abort_queue_not_reset');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.fsrs.abort_queue_not_reset',
      expect.objectContaining({ defaultValue: 'flashcards 入队已中止（队列未重置）' }),
    );

    release('abort');
    const finalReceipt = await applying;
    expect(finalReceipt.status).toBe('cancelled');
    expect(finalReceipt.message).toBe('workspace:agent.fsrs.queue_not_reset');
  });

  it('run 不存在 → abort_run_not_found（runId 作插值参数）', () => {
    const receipt = fsrsDriver.abort('run-ghost');

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('workspace:agent.fsrs.abort_run_not_found');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.fsrs.abort_run_not_found',
      expect.objectContaining({ runId: 'run-ghost' }),
    );
  });
});

describe('workspace.json 契约 — agent.fsrs 键在 zh-CN / en-US 均存在', () => {
  const keys = [
    'queue_not_reset',
    'enqueue_requires_session',
    'enqueued_cards',
    'already_in_queue',
    'abort_queue_not_reset',
    'abort_run_not_found',
  ] as const;

  it.each(keys)('agent.fsrs.%s', (key) => {
    const zh = (zhWorkspace as { agent: { fsrs: Record<string, string> } }).agent.fsrs;
    const en = (enWorkspace as { agent: { fsrs: Record<string, string> } }).agent.fsrs;
    expect(zh[key], `zh-CN 缺少 agent.fsrs.${key}`).toBeTruthy();
    expect(en[key], `en-US 缺少 agent.fsrs.${key}`).toBeTruthy();
  });
});
