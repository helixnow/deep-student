/**
 * todoDriver 用户/agent 可见错误文案 i18n 契约 — todo:agent.*
 *
 * key-echo mock：断言与语言无关（真实运行时由 todo.json 提供 zh-CN / en-US 文案，
 * driver 侧 defaultValue 兜底 namespace 异步加载窗口期）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

const { todoState, setActiveList, reloadCurrentView } = vi.hoisted(() => {
  const todoState = {
    activeListId: null as string | null,
    selectedItemId: null as string | null,
    error: null as string | null,
    items: [] as unknown[],
    lists: [] as unknown[],
    overdueCount: 0,
    filter: { view: 'all', search: '' },
    isLoadingLists: false,
    isLoadingItems: false,
  };
  return {
    todoState,
    setActiveList: vi.fn((id: string | null) => {
      todoState.activeListId = id;
    }),
    reloadCurrentView: vi.fn(async () => undefined),
  };
});

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    getState: () => ({
      setActiveList,
      reloadCurrentView,
      selectItem: vi.fn(),
      ...todoState,
    }),
  },
}));

import { todoDriver } from '../drivers/todoDriver';
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
    target: { typeId: 'todo' },
    windowId: 'window',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume'),
    ledger,
  };
}

function showList(listId: string, label = '打开清单'): AgentOp {
  return { kind: 'todo_show_list', destructive: false, label, payload: { listId } };
}

beforeEach(() => {
  tSpy.mockClear();
  setActiveList.mockClear();
  setActiveList.mockImplementation((id: string | null) => {
    todoState.activeListId = id;
  });
  reloadCurrentView.mockClear();
  reloadCurrentView.mockImplementation(async () => undefined);
  todoState.activeListId = null;
  todoState.error = null;
});

describe('todoDriver apply — 错误文案走 todo:agent.* key', () => {
  it('目标清单未激活 → list_not_activated 包进 op_failed，不再硬编码中文', async () => {
    setActiveList.mockImplementation(() => {
      /* 清单激活失败：activeListId 保持 null */
    });
    const receipt = await todoDriver.apply(makeRun('run-not-activated'), [
      showList('list-a'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['todo:agent.op_failed']);
    expect(tSpy).toHaveBeenCalledWith(
      'todo:agent.list_not_activated',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
    expect(tSpy).toHaveBeenCalledWith(
      'todo:agent.op_failed',
      expect.objectContaining({
        label: '打开清单',
        error: 'todo:agent.list_not_activated',
      }),
    );
    // 全部失败时 message 回落到 unsupported hint（既有行为，仅文案换 key）
    expect(receipt.message).toBe('todo:agent.unsupported_hint');
  });

  it('撤销失败：原清单未恢复 → undo_list_not_restored', async () => {
    todoState.activeListId = 'list-old';
    const run = makeRun('run-undo-not-restored');
    const receipt = await todoDriver.apply(run, [showList('list-new')]);
    expect(receipt.status).toBe('completed');
    expect(run.ledger.record).toHaveBeenCalledTimes(1);

    setActiveList.mockImplementation(() => {
      /* 撤销时恢复失败：activeListId 停留在 list-new */
    });
    const inverse = vi.mocked(run.ledger.record).mock.calls[0]![1];
    await expect(inverse()).rejects.toThrow('todo:agent.undo_list_not_restored');
  });

  it('撤销失败：store error → undo_failed 携带 {{error}}', async () => {
    todoState.activeListId = 'list-old';
    const run = makeRun('run-undo-failed');
    await todoDriver.apply(run, [showList('list-new')]);
    expect(run.ledger.record).toHaveBeenCalledTimes(1);

    todoState.error = 'store 拒绝写入';
    const inverse = vi.mocked(run.ledger.record).mock.calls[0]![1];
    await expect(inverse()).rejects.toThrow('todo:agent.undo_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'todo:agent.undo_failed',
      expect.objectContaining({ error: 'store 拒绝写入' }),
    );
  });

  it('缺少 listId → op_missing_list_id（label 作插值参数）', async () => {
    const receipt = await todoDriver.apply(makeRun('run-missing-id'), [
      { kind: 'todo_show_list', destructive: false, label: '切清单', payload: {} },
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['todo:agent.op_missing_list_id']);
    expect(tSpy).toHaveBeenCalledWith(
      'todo:agent.op_missing_list_id',
      expect.objectContaining({ label: '切清单' }),
    );
  });

  it('非导航 op → unsupported_hint 出现在 undone 与 message', async () => {
    const receipt = await todoDriver.apply(makeRun('run-unsupported'), [
      { kind: 'todo_create', destructive: true, label: '写数据', payload: {} },
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['写数据 — todo:agent.unsupported_hint']);
    expect(receipt.message).toBe('todo:agent.unsupported_hint');
  });

  it('pacing 失败 → pacing_failed 携带底层错误', async () => {
    const run = makeRun('run-pacing');
    run.pacing.tick = vi.fn(async () => {
      throw new Error('pacer failed');
    });
    const receipt = await todoDriver.apply(run, [showList('list-a')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('todo:agent.pacing_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'todo:agent.pacing_failed',
      expect.objectContaining({ error: 'pacer failed' }),
    );
  });

  it('暂停检查失败 → pause_check_failed 携带底层错误', async () => {
    const run = makeRun('run-pause');
    run.checkPaused = vi.fn(async () => {
      throw new Error('pause boom');
    });
    const receipt = await todoDriver.apply(run, [showList('list-a')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('todo:agent.pause_check_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'todo:agent.pause_check_failed',
      expect.objectContaining({ error: 'pause boom' }),
    );
  });
});

describe('todoDriver abort — 回执文案走 todo:agent.* key', () => {
  it('运行中 abort → nav_aborted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reloadCurrentView.mockImplementationOnce(async () => {
      await gate;
    });

    const run = makeRun('run-abort-live');
    const applying = todoDriver.apply(run, [showList('list-a')]);
    // 等 apply 走进 reloadCurrentView 的 gate
    await new Promise((resolve) => setTimeout(resolve, 0));

    const abortReceipt = todoDriver.abort('run-abort-live');
    expect(abortReceipt.status).toBe('cancelled');
    expect(abortReceipt.message).toBe('todo:agent.nav_aborted');

    release();
    const finalReceipt = await applying;
    expect(finalReceipt.status).toBe('cancelled');
  });

  it('run 不存在 → run_not_found + run_ended', () => {
    const receipt = todoDriver.abort('run-ghost');
    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('todo:agent.run_not_found');
    expect(receipt.undone).toEqual(['todo:agent.run_ended']);
  });
});
