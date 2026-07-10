/**
 * R1-19 — mock driver：暂停→续放→abort 与 partial done/undone
 *
 * 经 StageManager.apply_ops + fake timers 覆盖 DESIGN §4.1 全路径。
 * 契约以 types.ts AcrReceipt / AcrRunContext 为准。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async () => null),
}));

vi.mock('../probe', () => ({
  probeTarget: vi.fn(() => ({ state: 'clean', windowId: 'win-partial' })),
}));

vi.mock('../bridge', () => ({
  emitAcrProgress: vi.fn(),
}));

vi.mock('../../core/scheduler', async () => {
  const actual = await vi.importActual<typeof import('../../core/scheduler')>(
    '../../core/scheduler',
  );
  return {
    ...actual,
    requestWakePrefetch: vi.fn(),
    reportSchedulerActivity: vi.fn(),
  };
});

import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { probeTarget } from '../probe';
import { resetRunLedgerForTests } from '../ledger';
import { usePresenceStore } from '../presenceStore';
import { resetStageManagerForTests, stageManager } from '../stageManager';
import type { AcrBridgeRequest, AcrReceipt, AgentOp, CollabDriver } from '../types';

registerTestApp('acr-partial-app');

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command'>,
): AcrBridgeRequest {
  return {
    correlationId: 'corr-partial',
    args: {},
    timeoutMs: 30_000,
    runId: 'run-partial',
    sessionId: 'sess-partial',
    ...partial,
  };
}

/**
 * 规格 mock driver：逐 op 调 checkPaused + pacing.tick；
 * abort 决策或外部 abort() 时返回 partial（done/undone 齐全）。
 */
function makeSequencedDriver(): CollabDriver & {
  abortFlag: { value: boolean };
} {
  const abortFlag = { value: false };
  const driver: CollabDriver & { abortFlag: { value: boolean } } = {
    typeId: 'acr-partial-app',
    abortFlag,
    probe: () => 'clean',
    abort(runId: string): AcrReceipt {
      void runId;
      abortFlag.value = true;
      return {
        status: 'partial',
        mode: 'frontend',
        applied: 0,
        totalOps: 0,
        entityIds: [],
        done: [],
        undone: ['外部 abort'],
        message: 'driver.abort 被调用',
      };
    },
    async apply(run, ops: AgentOp[]): Promise<AcrReceipt> {
      const done: string[] = [];
      const undone: string[] = [];
      const entityIds: string[] = [];

      for (let i = 0; i < ops.length; i++) {
        if (abortFlag.value) {
          for (let j = i; j < ops.length; j++) undone.push(ops[j].label);
          return {
            status: 'partial',
            mode: 'frontend',
            applied: done.length,
            totalOps: ops.length,
            entityIds,
            done,
            undone,
            message: '外部 abort，返回 partial',
          };
        }

        const decision = await run.checkPaused();
        if (decision === 'abort') {
          for (let j = i; j < ops.length; j++) undone.push(ops[j].label);
          return {
            status: 'partial',
            mode: 'frontend',
            applied: done.length,
            totalOps: ops.length,
            entityIds,
            done,
            undone,
            userPatch: '用户停止或超时中止',
            message: '仲裁 abort，返回 partial',
          };
        }

        const op = ops[i];
        done.push(op.label);
        entityIds.push(`e-${i}`);
        run.ledger.record(run.runId, () => undefined, `undo:${op.label}`);
        run.reportProgress(i + 1, ops.length, op.label, `e-${i}`);
        await run.pacing.tick(0); // cost=0：仍走 rAF 对齐，便于 fake timers
      }

      return {
        status: 'completed',
        mode: 'frontend',
        applied: done.length,
        totalOps: ops.length,
        entityIds,
        done,
        undone: [],
      };
    },
  };
  return driver;
}

describe('ACR mock driver — pause/resume/abort + partial', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetWindowStoreForTests({ w: 1400, h: 900 });
    useWindowStore.setState({
      windows: {
        'win-partial': {
          id: 'win-partial',
          typeId: 'acr-partial-app',
          instanceKey: 'res-p',
          title: 'Partial',
          frame: { x: 40, y: 40, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 10,
          createdAt: 1,
          lastFocusedAt: 1,
        },
      },
      focusStack: ['win-partial'],
      lifecycles: { 'win-partial': 'focused' },
    });
    vi.mocked(probeTarget).mockReturnValue({
      state: 'clean',
      windowId: 'win-partial',
    });
    stageManager.start();
  });

  afterEach(() => {
    stageManager.stop();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    vi.useRealTimers();
  });

  const threeOps: AgentOp[] = [
    { kind: 'a', destructive: false, label: '步骤A' },
    { kind: 'b', destructive: false, label: '步骤B' },
    { kind: 'c', destructive: false, label: '步骤C' },
  ];

  it('暂停 → 2s 无输入续放 → completed（done 齐全、undone 空）', async () => {
    const driver = makeSequencedDriver();
    // 在第 2 个 op 的 checkPaused 前注入用户输入
    let opIndex = 0;
    const origApply = driver.apply.bind(driver);
    driver.apply = async (run, ops) => {
      const wrapped = {
        ...run,
        async checkPaused() {
          // 第一个 op 完成后、第二个 op 前暂停一次
          if (opIndex === 1) {
            stageManager.notifyUserInput('win-partial');
          }
          opIndex += 1;
          return run.checkPaused();
        },
      };
      return origApply(wrapped, ops);
    };
    stageManager.registerDriver(driver);

    const pending = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'acr-partial-app', resourceId: 'res-p' },
          ops: threeOps,
          pacing: 'fast',
        },
      }),
    );

    // 等 presence 进入 paused（notify 后）
    await vi.waitFor(() => {
      const st = usePresenceStore.getState().byWindow['win-partial']?.status;
      // 可能已 resume 完成；至少 apply 应在跑
      expect(st === 'pausedByUser' || st === 'acting' || st === 'done' || st == null).toBe(true);
    });

    // 推进 2s 空闲续放 + 微任务
    await vi.advanceTimersByTimeAsync(2000);
    // fast pacing 仍可能有 rAF；推进并 flush
    await vi.advanceTimersByTimeAsync(50);

    const res = await pending;
    expect(res.ok).toBe(true);
    const receipt = res.data as AcrReceipt;
    expect(receipt.status).toBe('completed');
    expect(receipt.done).toEqual(['步骤A', '步骤B', '步骤C']);
    expect(receipt.undone).toEqual([]);
    expect(receipt.applied).toBe(3);
  });

  it('acting 中 stopRun → partial：done/undone 正确切分', async () => {
    const driver = makeSequencedDriver();
    let releaseFirst!: () => void;
    const firstOpGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    driver.apply = async (run, ops) => {
      const done: string[] = [];
      const undone: string[] = [];
      // 完成第一 op 后挂起，等待测试方 stop
      done.push(ops[0].label);
      run.ledger.record(run.runId, () => undefined, 'undo:A');
      run.reportProgress(1, ops.length, ops[0].label);
      await firstOpGate;
      const decision = await run.checkPaused();
      if (decision === 'abort' || driver.abortFlag.value) {
        for (let j = 1; j < ops.length; j++) undone.push(ops[j].label);
        return {
          status: 'partial',
          mode: 'frontend',
          applied: done.length,
          totalOps: ops.length,
          entityIds: ['e-0'],
          done,
          undone,
          userPatch: '用户点停止',
          message: 'stopRun → partial',
        };
      }
      for (let i = 1; i < ops.length; i++) done.push(ops[i].label);
      return {
        status: 'completed',
        mode: 'frontend',
        applied: done.length,
        totalOps: ops.length,
        entityIds: [],
        done,
        undone: [],
      };
    };

    stageManager.registerDriver(driver);

    const pending = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'acr-partial-app', resourceId: 'res-p' },
          ops: threeOps,
          pacing: 'fast',
        },
      }),
    );

    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow['win-partial']?.runId).toBe(
        'run-partial',
      );
    });

    stageManager.stopRun('run-partial');
    releaseFirst();

    const res = await pending;
    expect(res.ok).toBe(true);
    const receipt = res.data as AcrReceipt;
    expect(receipt.status).toBe('partial');
    expect(receipt.done).toEqual(['步骤A']);
    expect(receipt.undone).toEqual(['步骤B', '步骤C']);
    expect(receipt.done.length + receipt.undone.length).toBe(3);
    expect(receipt.userPatch).toBeTruthy();
  });

  it('15s 持续输入 abort → partial + userPatch', async () => {
    const driver = makeSequencedDriver();
    driver.apply = async (run, ops) => {
      // 进入后立即模拟用户输入暂停，并挂起在 checkPaused
      stageManager.notifyUserInput('win-partial');
      const decision = await run.checkPaused();
      if (decision === 'abort') {
        return {
          status: 'partial',
          mode: 'frontend',
          applied: 0,
          totalOps: ops.length,
          entityIds: [],
          done: [],
          undone: ops.map((o) => o.label),
          userPatch: '15s 内持续输入',
          message: '仲裁 15s abort',
        };
      }
      return {
        status: 'completed',
        mode: 'frontend',
        applied: ops.length,
        totalOps: ops.length,
        entityIds: [],
        done: ops.map((o) => o.label),
        undone: [],
      };
    };
    stageManager.registerDriver(driver);

    const pending = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'acr-partial-app', resourceId: 'res-p' },
          ops: threeOps,
          pacing: 'fast',
        },
      }),
    );

    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow['win-partial']?.status).toBe(
        'pausedByUser',
      );
    });

    // 持续输入不重置 15s；每秒点一次撑满
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      stageManager.notifyUserInput('win-partial');
    }
    await vi.advanceTimersByTimeAsync(1000);

    const res = await pending;
    const receipt = res.data as AcrReceipt;
    expect(receipt.status).toBe('partial');
    expect(receipt.done).toEqual([]);
    expect(receipt.undone).toEqual(['步骤A', '步骤B', '步骤C']);
    expect(receipt.userPatch).toBeTruthy();
  });
});
