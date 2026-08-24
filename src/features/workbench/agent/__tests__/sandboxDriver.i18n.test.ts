/**
 * sandboxDriver 用户/agent 可见回执文案 i18n 契约 — console:agent.*
 *
 * key-echo mock：断言与语言无关（真实运行时由 console.json 提供 zh-CN / en-US 文案，
 * driver 侧 defaultValue 兜底 namespace 异步加载窗口期）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

const { sandboxOwnerState, storeApi } = vi.hoisted(() => {
  const sandboxOwnerState = {
    activeSession: null as { id: string; title: string } | null,
    viewportPreset: 'desktop',
    inspectorOpen: false,
    isOpen: false,
  };
  const storeApi = {
    refreshSession: vi.fn(),
    setViewportPreset: vi.fn(),
    setInspectorOpen: vi.fn(),
  };
  return { sandboxOwnerState, storeApi };
});

vi.mock('@/features/sandbox/store/useSandboxWorkbenchStore', () => ({
  LEGACY_SANDBOX_OWNER_KEY: 'legacy-sandbox-owner',
  selectSandboxWorkbenchOwnerState: vi.fn(() => sandboxOwnerState),
  useSandboxWorkbenchStore: {
    getState: () => ({ ...storeApi }),
  },
}));

import { SET_MODE_UNSUPPORTED, sandboxDriver } from '../drivers/sandboxDriver';
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
    target: { typeId: 'sandbox' },
    windowId: 'window',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume'),
    ledger,
  };
}

function op(kind: string, label: string, payload?: unknown): AgentOp {
  return { kind, destructive: false, label, payload } as AgentOp;
}

beforeEach(() => {
  tSpy.mockClear();
  storeApi.refreshSession.mockClear();
  storeApi.setViewportPreset.mockClear();
  storeApi.setInspectorOpen.mockClear();
  sandboxOwnerState.activeSession = null;
});

describe('sandboxDriver apply — 回执文案走 console:agent.* key', () => {
  it('sandbox_refresh 无活动会话 → no_active_session（label 作插值参数）', async () => {
    const receipt = await sandboxDriver.apply(makeRun('run-no-session'), [
      op('sandbox_refresh', '刷新预览'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['console:agent.no_active_session']);
    expect(storeApi.refreshSession).not.toHaveBeenCalled();
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.no_active_session',
      expect.objectContaining({ label: '刷新预览', defaultValue: expect.any(String) }),
    );
  });

  it('sandbox_set_viewport 非法预设 → viewport_invalid', async () => {
    const receipt = await sandboxDriver.apply(makeRun('run-bad-viewport'), [
      op('sandbox_set_viewport', '切换视口', { viewport: 'watch' }),
    ]);

    expect(receipt.undone).toEqual(['console:agent.viewport_invalid']);
    expect(storeApi.setViewportPreset).not.toHaveBeenCalled();
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.viewport_invalid',
      expect.objectContaining({ label: '切换视口', defaultValue: expect.any(String) }),
    );
  });

  it('sandbox_set_inspector open 非布尔 → open_invalid', async () => {
    const receipt = await sandboxDriver.apply(makeRun('run-bad-open'), [
      op('sandbox_set_inspector', '打开检查器', { open: 'yes' }),
    ]);

    expect(receipt.undone).toEqual(['console:agent.open_invalid']);
    expect(storeApi.setInspectorOpen).not.toHaveBeenCalled();
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.open_invalid',
      expect.objectContaining({ label: '打开检查器', defaultValue: expect.any(String) }),
    );
  });

  it('sandbox_set_mode → set_mode_undone（label + reason 插值），message 用 set_mode_unsupported', async () => {
    const receipt = await sandboxDriver.apply(makeRun('run-set-mode'), [
      op('sandbox_set_mode', '切换运行模式', { mode: 'sandbox-run' }),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['console:agent.set_mode_undone']);
    expect(receipt.message).toBe('console:agent.set_mode_unsupported');
    // defaultValue 必须沿用导出的原中文常量，保证 namespace 未就绪时文案不缺失
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.set_mode_unsupported',
      expect.objectContaining({ defaultValue: SET_MODE_UNSUPPORTED }),
    );
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.set_mode_undone',
      expect.objectContaining({
        label: '切换运行模式',
        reason: 'console:agent.set_mode_unsupported',
      }),
    );
  });

  it('未知 sandbox op → unsupported_op', async () => {
    const receipt = await sandboxDriver.apply(makeRun('run-unknown-op'), [
      op('sandbox_explode', '未知操作'),
    ]);

    expect(receipt.undone).toEqual(['console:agent.unsupported_op']);
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.unsupported_op',
      expect.objectContaining({ label: '未知操作', defaultValue: expect.any(String) }),
    );
  });

  it('checkPaused 抛错 → pause_check_failed（error 作插值参数）', async () => {
    const run = makeRun('run-pause-fail');
    run.checkPaused = vi.fn(async () => {
      throw new Error('boom');
    });

    const receipt = await sandboxDriver.apply(run, [op('sandbox_refresh', '刷新预览')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('console:agent.pause_check_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.pause_check_failed',
      expect.objectContaining({ error: 'boom', defaultValue: expect.any(String) }),
    );
  });

  it('pacing.tick 抛错 → pacing_failed（error 作插值参数）', async () => {
    sandboxOwnerState.activeSession = { id: 'session-1', title: 'Preview' };
    const run = makeRun('run-pacing-fail');
    vi.mocked(run.pacing.tick).mockRejectedValueOnce(new Error('tick down'));

    const receipt = await sandboxDriver.apply(run, [op('sandbox_refresh', '刷新预览')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('console:agent.pacing_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.pacing_failed',
      expect.objectContaining({ error: 'tick down', defaultValue: expect.any(String) }),
    );
  });
});

describe('sandboxDriver abort — 回执文案走 console:agent.* key', () => {
  it('运行中 abort → op_aborted', async () => {
    sandboxOwnerState.activeSession = { id: 'session-1', title: 'Preview' };
    const run = makeRun('run-abort-live');
    let abortReceipt: ReturnType<typeof sandboxDriver.abort> | null = null;
    vi.mocked(run.pacing.tick).mockImplementation(async () => {
      if (!abortReceipt) abortReceipt = sandboxDriver.abort(run.runId);
    });

    const receipt = await sandboxDriver.apply(run, [
      op('sandbox_refresh', '第一次刷新'),
      op('sandbox_refresh', '第二次刷新'),
    ]);

    expect(abortReceipt).toMatchObject({
      status: 'cancelled',
      message: 'console:agent.op_aborted',
    });
    expect(receipt.status).toBe('cancelled');
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.op_aborted',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
  });

  it('run 不存在 → undone 用 run_ended、message 用 run_not_found', () => {
    const receipt = sandboxDriver.abort('run-ghost');

    expect(receipt.status).toBe('cancelled');
    expect(receipt.undone).toEqual(['console:agent.run_ended']);
    expect(receipt.message).toBe('console:agent.run_not_found');
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.run_ended',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
    expect(tSpy).toHaveBeenCalledWith(
      'console:agent.run_not_found',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
  });
});
