/**
 * finderDriver 用户/agent 可见错误文案 i18n 契约 — learningHub:agent.*
 *
 * key-echo mock：断言与语言无关（真实运行时由 learningHub.json 提供 zh-CN / en-US 文案，
 * driver 侧 defaultValue 兜底 namespace 异步加载窗口期）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

const { finderState, enterFolder, navigateTo } = vi.hoisted(() => {
  const finderState = {
    currentPath: { folderId: 'root-old' } as { folderId: string },
    inlineEdit: { editingId: null as string | null },
  };
  return {
    finderState,
    enterFolder: vi.fn(async (id: string) => {
      finderState.currentPath = { folderId: id };
    }),
    navigateTo: vi.fn((path: { folderId: string }) => {
      finderState.currentPath = path;
    }),
  };
});

vi.mock('@/features/learning-hub/stores/finderStore', () => ({
  useFinderStore: {
    getState: () => ({
      enterFolder,
      navigateTo,
      ...finderState,
    }),
  },
}));

import { finderDriver } from '../drivers/finderDriver';
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
    target: { typeId: 'files' },
    windowId: 'window',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume'),
    ledger,
  };
}

function openFolder(folderId: string, label = '打开目录'): AgentOp {
  return { kind: 'openFolder', destructive: false, label, payload: { folderId } };
}

beforeEach(() => {
  tSpy.mockClear();
  enterFolder.mockClear();
  enterFolder.mockImplementation(async (id: string) => {
    finderState.currentPath = { folderId: id };
  });
  navigateTo.mockClear();
  finderState.currentPath = { folderId: 'root-old' };
  finderState.inlineEdit.editingId = null;
});

describe('finderDriver apply — 错误文案走 learningHub:agent.* key', () => {
  it('非导航 op → unsupported_hint 出现在 undone 与 message', async () => {
    const receipt = await finderDriver.apply(makeRun('run-unsupported'), [
      { kind: 'dstu_write', destructive: true, label: '写数据', payload: {} },
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['写数据 — learningHub:agent.unsupported_hint']);
    expect(receipt.message).toBe('learningHub:agent.unsupported_hint');
    expect(tSpy).toHaveBeenCalledWith(
      'learningHub:agent.unsupported_hint',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
  });

  it('部分成功 + 非导航 op → sawUnsupported 标志驱动 message（不再嗅探 undone 字符串）', async () => {
    const receipt = await finderDriver.apply(makeRun('run-partial'), [
      openFolder('folder-new'),
      { kind: 'dstu_write', destructive: true, label: '写数据', payload: {} },
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.done).toEqual(['打开目录']);
    expect(receipt.undone).toEqual(['写数据 — learningHub:agent.unsupported_hint']);
    expect(receipt.message).toBe('learningHub:agent.unsupported_hint');
  });

  it('缺少 folderId → op_missing_folder_id（label 作插值参数）', async () => {
    const receipt = await finderDriver.apply(makeRun('run-missing-id'), [
      { kind: 'openFolder', destructive: false, label: '进目录', payload: {} },
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['learningHub:agent.op_missing_folder_id']);
    expect(tSpy).toHaveBeenCalledWith(
      'learningHub:agent.op_missing_folder_id',
      expect.objectContaining({ label: '进目录' }),
    );
  });

  it('enterFolder 抛错 → op_failed 携带 label 与底层错误', async () => {
    enterFolder.mockImplementation(async () => {
      throw new Error('store 拒绝导航');
    });
    const receipt = await finderDriver.apply(makeRun('run-op-failed'), [
      openFolder('folder-x'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['learningHub:agent.op_failed']);
    expect(tSpy).toHaveBeenCalledWith(
      'learningHub:agent.op_failed',
      expect.objectContaining({ label: '打开目录', error: 'store 拒绝导航' }),
    );
    // 全部失败时 message 回落到 unsupported hint（既有行为，仅文案换 key）
    expect(receipt.message).toBe('learningHub:agent.unsupported_hint');
  });

  it('op 无 label → done 与逆操作 label 用 open_folder_label（folderId 作插值参数）', async () => {
    const run = makeRun('run-default-label');
    const receipt = await finderDriver.apply(run, [
      { kind: 'openFolder', destructive: false, label: '', payload: { folderId: 'folder-new' } },
    ]);

    expect(receipt.status).toBe('completed');
    expect(receipt.done).toEqual(['learningHub:agent.open_folder_label']);
    expect(tSpy).toHaveBeenCalledWith(
      'learningHub:agent.open_folder_label',
      expect.objectContaining({ folderId: 'folder-new' }),
    );
    expect(run.ledger.record).toHaveBeenCalledWith(
      'run-default-label',
      expect.any(Function),
      'learningHub:agent.open_folder_label',
    );
  });

  it('导航逻辑不变：openFolder 成功后可经 ledger 逆操作恢复原路径', async () => {
    const run = makeRun('run-nav-intact');
    const receipt = await finderDriver.apply(run, [openFolder('folder-new')]);

    expect(receipt.status).toBe('completed');
    expect(enterFolder).toHaveBeenCalledWith('folder-new');
    expect(finderState.currentPath.folderId).toBe('folder-new');
    expect(run.ledger.record).toHaveBeenCalledTimes(1);
    await vi.mocked(run.ledger.record).mock.calls[0]![1]();
    expect(finderState.currentPath.folderId).toBe('root-old');
  });

  it('pacing 失败 → pacing_failed 携带底层错误', async () => {
    const run = makeRun('run-pacing');
    run.pacing.tick = vi.fn(async () => {
      throw new Error('pacer failed');
    });
    const receipt = await finderDriver.apply(run, [openFolder('folder-a')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('learningHub:agent.pacing_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'learningHub:agent.pacing_failed',
      expect.objectContaining({ error: 'pacer failed' }),
    );
  });

  it('暂停检查失败 → pause_check_failed 携带底层错误', async () => {
    const run = makeRun('run-pause');
    run.checkPaused = vi.fn(async () => {
      throw new Error('pause boom');
    });
    const receipt = await finderDriver.apply(run, [openFolder('folder-a')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('learningHub:agent.pause_check_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'learningHub:agent.pause_check_failed',
      expect.objectContaining({ error: 'pause boom' }),
    );
  });
});

describe('finderDriver abort — 回执文案走 learningHub:agent.* key', () => {
  it('运行中 abort → nav_aborted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    enterFolder.mockImplementationOnce(async (id: string) => {
      await gate;
      finderState.currentPath = { folderId: id };
    });

    const run = makeRun('run-abort-live');
    const applying = finderDriver.apply(run, [openFolder('folder-a')]);
    // 等 apply 走进 enterFolder 的 gate
    await new Promise((resolve) => setTimeout(resolve, 0));

    const abortReceipt = finderDriver.abort('run-abort-live');
    expect(abortReceipt.status).toBe('cancelled');
    expect(abortReceipt.message).toBe('learningHub:agent.nav_aborted');

    release();
    const finalReceipt = await applying;
    expect(finalReceipt.status).toBe('cancelled');
  });

  it('run 不存在 → run_not_found + run_ended', () => {
    const receipt = finderDriver.abort('run-ghost');
    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('learningHub:agent.run_not_found');
    expect(receipt.undone).toEqual(['learningHub:agent.run_ended']);
  });
});
