/**
 * ACR sandbox Driver — ACR 4.0（A6）
 *
 * 覆盖：setMode 诚实化（op 进 undone、store 不动、queryState 报真实渲染形态）、
 * abort 运行追踪（真实 applied 前缀）、常规 op 回执。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { sandboxDriver } from '../drivers/sandboxDriver';
import type { AcrRunContext, AgentOp, Pacer, RunLedger } from '../types';

function makeRun(runId = 'run-sandbox'): AcrRunContext {
  const pacing: Pacer = {
    profile: { name: 'fast', opIntervalMs: 0, typeBatchMin: 1, typeBatchMax: 1, typeIntervalMs: 0, instant: true },
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

function ownerState() {
  return selectSandboxWorkbenchOwnerState(
    useSandboxWorkbenchStore.getState(),
    LEGACY_SANDBOX_OWNER_KEY,
  );
}

describe('sandboxDriver', () => {
  beforeEach(() => {
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });
    useSandboxWorkbenchStore.getState().openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'message-1',
      language: 'html',
      title: 'Preview',
      content: '<h1>Preview</h1>',
    }, LEGACY_SANDBOX_OWNER_KEY);
  });

  it('sandbox_set_mode 诚实进 undone：不改 store、不记 inverse、message 说明原因', async () => {
    const run = makeRun();
    const receipt = await sandboxDriver.apply(run, [
      op('sandbox_set_mode', '切换运行模式', { mode: 'sandbox-run' }),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.applied).toBe(0);
    expect(receipt.done).toEqual([]);
    expect(receipt.undone).toHaveLength(1);
    expect(receipt.undone[0]).toContain('切换运行模式');
    expect(receipt.undone[0]).toContain('安全预览');
    expect(receipt.message).toContain('安全预览');
    expect(run.ledger.record).not.toHaveBeenCalled();
    // store 侧会话 mode 保持 safe-preview（真实渲染形态）
    expect(ownerState().activeSession?.mode).toBe('safe-preview');
  });

  it('混合 ops：set_viewport 成功、set_mode 进 undone → partial 且 applied 只计真实生效', async () => {
    const run = makeRun();
    const receipt = await sandboxDriver.apply(run, [
      op('sandbox_set_viewport', '切换视口', { viewport: 'mobile' }),
      op('sandbox_set_mode', '切换运行模式', { mode: 'sandbox-run' }),
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.applied).toBe(1);
    expect(receipt.done).toEqual(['切换视口']);
    expect(receipt.undone[0]).toContain('切换运行模式');
    expect(ownerState().viewportPreset).toBe('mobile');
    // 仅视口 op 记 inverse
    expect(run.ledger.record).toHaveBeenCalledTimes(1);
  });

  it('queryState 报告真实渲染形态：即使 store mode 被外部改为 sandbox-run 也报 safe-preview', () => {
    expect(sandboxDriver.queryState()).toMatchObject({
      title: 'Preview',
      mode: 'safe-preview',
    });
    useSandboxWorkbenchStore.getState().setWorkbenchMode('sandbox-run', LEGACY_SANDBOX_OWNER_KEY);
    expect(sandboxDriver.queryState()).toMatchObject({ mode: 'safe-preview' });
  });

  it('abort 返回真实 applied 前缀：已完成 op 计入 done，剩余进 undone', async () => {
    const run = makeRun('run-abort');
    let releaseTick: () => void = () => undefined;
    const tickGate = new Promise<void>((resolve) => { releaseTick = resolve; });
    run.pacing.tick = vi.fn(async () => { await tickGate; });

    const applyPromise = sandboxDriver.apply(run, [
      op('sandbox_set_viewport', '切换到平板', { viewport: 'tablet' }),
      op('sandbox_set_inspector', '打开检查器', { open: true }),
    ]);

    await vi.waitFor(() => {
      expect(ownerState().viewportPreset).toBe('tablet');
    });

    const abortReceipt = sandboxDriver.abort('run-abort');
    expect(abortReceipt.status).toBe('cancelled');
    expect(abortReceipt.applied).toBe(1);
    expect(abortReceipt.totalOps).toBe(2);
    expect(abortReceipt.done).toEqual(['切换到平板']);
    expect(abortReceipt.undone).toEqual(['打开检查器']);

    releaseTick();
    const finalReceipt = await applyPromise;
    expect(finalReceipt.status).toBe('cancelled');
    expect(finalReceipt.applied).toBe(1);
    expect(finalReceipt.done).toEqual(['切换到平板']);
    expect(finalReceipt.undone).toEqual(['打开检查器']);
    // 第二个 op 从未执行
    expect(ownerState().inspectorOpen).toBe(false);
  });

  it('abort 未知 run 返回明确 message，不假装有 applied', () => {
    const receipt = sandboxDriver.abort('run-unknown');
    expect(receipt.status).toBe('cancelled');
    expect(receipt.applied).toBe(0);
    expect(receipt.message).toContain('不存在或已结束');
  });
});
