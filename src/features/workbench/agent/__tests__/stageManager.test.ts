/**
 * R1-06 — StageManager 租约互斥 / DRIVER_NOT_FOUND / revert 路径
 * 仲裁状态机测试归 R1-19，本文件不重复。
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
  probeTarget: vi.fn(() => ({ state: 'clean', windowId: 'win-a' })),
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

import {
  resetWindowStoreForTests,
  useWindowStore,
} from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { probeTarget } from '../probe';
import { resetRunLedgerForTests, runLedger } from '../ledger';
import {
  getRecentReceiptSummariesForTests,
  resetDomainEventRingForTests,
} from '../domainEvents';
import { usePresenceStore } from '../presenceStore';
import {
  ORPHAN_DRAIN_MS,
  resetStageManagerForTests,
  setAgentControlForTests,
  stageManager,
} from '../stageManager';
import type { AcrBridgeRequest, AcrReceipt, CollabDriver } from '../types';
import { ACR_ERROR_CODES } from '../types';

registerTestApp('mock-app');
registerTestApp('close-guard-app', { canClose: async () => false });
registerTestApp('command-app', { onActivation: () => true });
registerTestApp('chat');

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command'>,
): AcrBridgeRequest {
  return {
    correlationId: 'corr-1',
    args: {},
    timeoutMs: 30_000,
    runId: 'run-1',
    sessionId: 'sess-1',
    ...partial,
  };
}

function makeDriver(overrides: Partial<CollabDriver> = {}): CollabDriver {
  return {
    typeId: 'mock-app',
    probe: () => 'clean',
    apply: vi.fn(async () => ({
      status: 'completed',
      mode: 'frontend',
      applied: 1,
      totalOps: 1,
      entityIds: ['e1'],
      done: ['ok'],
      undone: [],
    })),
    abort: vi.fn((): AcrReceipt => ({
      status: 'cancelled',
      mode: 'frontend',
      applied: 0,
      totalOps: 1,
      entityIds: [],
      done: [],
      undone: ['aborted'],
    })),
    ...overrides,
  };
}

describe('StageManager R1-06', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetDomainEventRingForTests();
    workbenchBus.setEnabled(true);
    resetWindowStoreForTests({ w: 1400, h: 900 });
    useWindowStore.setState({
      windows: {
        'win-a': {
          id: 'win-a',
          typeId: 'mock-app',
          instanceKey: 'res-1',
          title: 'Mock',
          frame: { x: 40, y: 40, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 10,
          createdAt: 1,
          lastFocusedAt: 1,
        },
      },
      focusStack: ['win-a'],
      lifecycles: { 'win-a': 'focused' },
    });
    vi.mocked(probeTarget).mockReturnValue({
      state: 'clean',
      windowId: 'win-a',
    });
    stageManager.start();
    setAgentControlForTests('background');
  });

  afterEach(() => {
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetDomainEventRingForTests();
    workbenchBus.setEnabled(false);
  });

  it('无 driver 时 apply_ops 返回 DRIVER_NOT_FOUND 结构化错误', async () => {
    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'missing-driver', resourceId: 'x' },
          ops: [{ kind: 'noop', destructive: false, label: 'noop' }],
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    const parsed = JSON.parse(res.error!);
    expect(parsed.code).toBe(ACR_ERROR_CODES.DRIVER_NOT_FOUND);
    expect(parsed.retryable).toBe(false);
  });

  it('同 windowId 已有活跃 run 时返回 WINDOW_BUSY', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const driver = makeDriver({
      apply: vi.fn(async () => {
        await gate;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['done'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const first = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-busy-1',
        correlationId: 'corr-busy-1',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'add', destructive: false, label: 'add' }],
        },
      }),
    );

    // 等 presence/租约写入（apply 进入 await gate 之前同步完成）
    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow['win-a']?.runId).toBe(
        'run-busy-1',
      );
    });

    const second = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-busy-2',
        correlationId: 'corr-busy-2',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'add', destructive: false, label: 'add2' }],
        },
      }),
    );

    expect(second.ok).toBe(false);
    const parsed = JSON.parse(second.error!);
    expect(parsed.code).toBe(ACR_ERROR_CODES.WINDOW_BUSY);
    expect(parsed.retryable).toBe(true);

    release();
    const firstRes = await first;
    expect(firstRes.ok).toBe(true);
    expect((firstRes.data as AcrReceipt).status).toBe('completed');
  });

  it('revert_run 经账本逆序 invert，二次调用幂等返回 false', async () => {
    const order: string[] = [];
    runLedger.record(
      'run-rev',
      () => {
        order.push('a');
      },
      'a',
    );
    runLedger.record(
      'run-rev',
      () => {
        order.push('b');
      },
      'b',
    );
    runLedger.sealRun('run-rev');

    const res1 = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'revert_run',
        runId: 'run-rev',
        args: { runId: 'run-rev' },
      }),
    );
    expect(res1.ok).toBe(true);
    expect(res1.data).toEqual({ reverted: true });
    expect(order).toEqual(['b', 'a']);

    const res2 = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'revert_run',
        runId: 'run-rev',
        correlationId: 'corr-2',
        args: { runId: 'run-rev' },
      }),
    );
    expect(res2.data).toEqual({ reverted: false });

    // stageManager.revertRun 同步路径
    expect(await stageManager.revertRun('run-rev')).toBe(false);
  });

  it('apply_ops 成功后 seal 账本并可 revert', async () => {
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        run.ledger.record(run.runId, () => undefined, 'undo-add');
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: ['n1'],
          done: ['添加'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'add_node', destructive: false, label: '添加' }],
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(runLedger.hasRun('run-1')).toBe(true);
    expect(await stageManager.revertRun('run-1')).toBe(true);
    expect(await stageManager.revertRun('run-1')).toBe(false);
  });

  it('R2-07：第三路演出超限时 pacer 直落 instant（不拒）', async () => {
    resetWindowStoreForTests({ w: 1400, h: 900 });
    useWindowStore.setState({
      windows: {
        'win-a': {
          id: 'win-a',
          typeId: 'mock-app',
          instanceKey: 'res-1',
          title: 'A',
          frame: { x: 40, y: 40, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 10,
          createdAt: 1,
          lastFocusedAt: 1,
        },
        'win-b': {
          id: 'win-b',
          typeId: 'mock-app',
          instanceKey: 'res-2',
          title: 'B',
          frame: { x: 80, y: 80, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 11,
          createdAt: 2,
          lastFocusedAt: 2,
        },
        'win-c': {
          id: 'win-c',
          typeId: 'mock-app',
          instanceKey: 'res-3',
          title: 'C',
          frame: { x: 120, y: 120, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 12,
          createdAt: 3,
          lastFocusedAt: 3,
        },
      },
      focusStack: ['win-a', 'win-b', 'win-c'],
      lifecycles: {
        'win-a': 'visible',
        'win-b': 'visible',
        'win-c': 'focused',
      },
    });

    const gates: Array<() => void> = [];
    const seenInstant: boolean[] = [];

    let call = 0;
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        const slot = call++;
        seenInstant[slot] = run.pacing.profile.instant === true;
        await new Promise<void>((r) => {
          gates[slot] = r;
        });
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['done'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const windows = ['win-a', 'win-b', 'win-c'] as const;
    const promises = windows.map((wid, i) => {
      vi.mocked(probeTarget).mockReturnValueOnce({
        state: 'clean',
        windowId: wid,
      });
      return stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: `run-stage-${i}`,
          correlationId: `corr-stage-${i}`,
          args: {
            target: { typeId: 'mock-app', resourceId: `res-${i + 1}` },
            ops: [{ kind: 'add', destructive: false, label: 'add' }],
            pacing: 'normal',
          },
        }),
      );
    });

    await vi.waitFor(() => {
      expect(gates.filter(Boolean)).toHaveLength(3);
    });

    // 前两路占演出槽（非 instant）；第三路超限直落
    expect(seenInstant[0]).toBe(false);
    expect(seenInstant[1]).toBe(false);
    expect(seenInstant[2]).toBe(true);
    expect(usePresenceStore.getState().byWindow['win-c']?.label).toContain(
      '演出槽满',
    );

    for (const g of gates) g?.();
    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('R2-07：background 窗 apply_ops 强制 instant', async () => {
    useWindowStore.setState({
      lifecycles: { 'win-a': 'background' },
    });
    vi.mocked(probeTarget).mockReturnValue({
      state: 'clean',
      windowId: 'win-a',
    });

    let sawInstant = false;
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        sawInstant = run.pacing.profile.instant === true;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['done'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'add', destructive: false, label: 'add' }],
          pacing: 'normal',
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(sawInstant).toBe(true);
  });

  describe('权威终态与生命周期回归', () => {
    it.each([
      ['completed', 1],
      ['partial', 1],
      ['cancelled', 0],
      ['failed', 0],
    ] as const)('记录 %s apply 终态且只记录一次', async (status, applied) => {
      const receipt: AcrReceipt = {
        status,
        mode: 'frontend',
        applied,
        totalOps: 1,
        entityIds: [],
        done: applied ? ['done'] : [],
        undone: applied ? [] : ['undone'],
        message: status,
      };
      stageManager.registerDriver(
        makeDriver({ apply: vi.fn(async () => receipt) }),
      );

      const res = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [{ kind: 'set', destructive: false, label: 'set' }],
          },
        }),
      );

      expect(res.data).toEqual(receipt);
      expect(getRecentReceiptSummariesForTests()).toEqual([
        expect.objectContaining({
          runId: 'run-1',
          status,
          applied,
          totalOps: 1,
        }),
      ]);
    });

    it('apply 异常记录 failed，并将 presence 宣布为 aborted 而非 done', async () => {
      const updateStatus = vi.spyOn(
        usePresenceStore.getState(),
        'updateStatus',
      );
      stageManager.registerDriver(
        makeDriver({
          apply: vi.fn(async () => {
            throw new Error('boom');
          }),
        }),
      );

      const res = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [{ kind: 'set', destructive: false, label: 'set' }],
          },
        }),
      );

      expect((res.data as AcrReceipt).status).toBe('failed');
      expect(updateStatus).toHaveBeenCalledWith('run-1', 'aborted');
      expect(getRecentReceiptSummariesForTests()).toEqual([
        expect.objectContaining({
          runId: 'run-1',
          status: 'failed',
          message: 'apply 异常: boom',
        }),
      ]);
    });

    it('当前 op 中取消不提前 seal，迟到 ledger 仍可记录，真实 partial 为权威回执', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let abortRequested = false;
      const driver = makeDriver({
        apply: vi.fn(async (run) => {
          await gate;
          run.ledger.record(run.runId, () => undefined, 'late-invert');
          return {
            status: abortRequested ? 'partial' : 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: 1,
            entityIds: ['late-entity'],
            done: ['current op committed'],
            undone: abortRequested ? ['remaining work'] : [],
          };
        }),
        abort: vi.fn(() => {
          abortRequested = true;
          return {
            status: 'cancelled',
            mode: 'frontend',
            applied: 0,
            totalOps: 1,
            entityIds: [],
            done: [],
            undone: ['rough snapshot'],
          };
        }),
      });
      stageManager.registerDriver(driver);
      const pending = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [{ kind: 'set', destructive: false, label: 'set' }],
          },
        }),
      );
      await vi.waitFor(() =>
        expect(usePresenceStore.getState().byWindow['win-a']).toBeTruthy(),
      );

      stageManager.stopRun('run-1');
      expect(runLedger.hasRun('run-1')).toBe(false);
      release();
      const res = await pending;

      expect(res.data as AcrReceipt).toMatchObject({
        status: 'partial',
        applied: 1,
      });
      expect(runLedger.hasRun('run-1')).toBe(true);
      expect(getRecentReceiptSummariesForTests()).toEqual([
        expect.objectContaining({
          runId: 'run-1',
          status: 'partial',
          applied: 1,
        }),
      ]);
    });

    it('inactive 时统一拒绝写命令，probe disabled，只读命令仍可查询', async () => {
      stageManager.stop();
      const mutating = [
        ['open_app', { typeId: 'mock-app' }],
        ['app_command', { typeId: 'mock-app', action: 'select' }],
        ['close_window', { windowId: 'win-a' }],
        [
          'apply_ops',
          {
            target: { typeId: 'missing-driver', resourceId: 'res-1' },
            ops: [],
          },
        ],
        ['revert_run', { runId: 'run-missing' }],
      ] as const;
      for (const [command, args] of mutating) {
        const res = await stageManager.handleBridgeRequest(
          baseReq({ command, correlationId: 'inactive-' + command, args }),
        );
        expect(res.ok).toBe(false);
        expect(JSON.parse(res.error!).code).toBe(
          ACR_ERROR_CODES.WORKBENCH_DISABLED,
        );
      }
      const probe = await stageManager.handleBridgeRequest(
        baseReq({ command: 'probe', correlationId: 'inactive-probe' }),
      );
      expect(probe.data).toEqual({ state: 'disabled', windowId: null });
      const list = await stageManager.handleBridgeRequest(
        baseReq({ command: 'list_windows', correlationId: 'inactive-list' }),
      );
      const query = await stageManager.handleBridgeRequest(
        baseReq({ command: 'query_state', correlationId: 'inactive-query' }),
      );
      expect(list.ok).toBe(true);
      expect(query.ok).toBe(true);
    });

    it('false→true 时旧 apply 未退出前保留窗口租约，拒绝同窗新 run', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aborted = false;
      const driver = makeDriver({
        apply: vi.fn(async () => {
          await gate;
          return {
            status: aborted ? 'partial' : 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: 1,
            entityIds: [],
            done: ['old current op'],
            undone: aborted ? ['old remaining'] : [],
          };
        }),
        abort: vi.fn(() => {
          aborted = true;
          return {
            status: 'cancelled',
            mode: 'frontend',
            applied: 0,
            totalOps: 1,
            entityIds: [],
            done: [],
            undone: ['rough snapshot'],
          };
        }),
      });
      stageManager.registerDriver(driver);
      const oldPending = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: 'run-old',
          correlationId: 'corr-old',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [],
          },
        }),
      );
      await vi.waitFor(() =>
        expect(usePresenceStore.getState().byWindow['win-a']).toBeTruthy(),
      );
      stageManager.stop();
      stageManager.start();
      setAgentControlForTests('background');
      stageManager.registerDriver(driver);
      const blocked = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: 'run-new',
          correlationId: 'corr-new',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [],
          },
        }),
      );
      expect(JSON.parse(blocked.error!).code).toBe(ACR_ERROR_CODES.WINDOW_BUSY);
      release();
      await oldPending;
      const next = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: 'run-after-drain',
          correlationId: 'corr-after-drain',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [],
          },
        }),
      );
      expect(next.ok).toBe(true);
    });

    it('orphan deadline 产出明确 partial 并释放租约，迟到 finally 不覆盖回执', async () => {
      vi.useFakeTimers();
      try {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const oldDriver = makeDriver({
          apply: vi.fn(async (run) => {
            run.ledger.record(run.runId, () => undefined, 'before-orphan');
            await gate;
            run.ledger.record(run.runId, () => undefined, 'after-orphan');
            return {
              status: 'completed',
              mode: 'frontend',
              applied: 1,
              totalOps: 1,
              entityIds: ['late-old'],
              done: ['late old completion'],
              undone: [],
            };
          }),
        });
        stageManager.registerDriver(oldDriver);
        const oldPending = stageManager.handleBridgeRequest(
          baseReq({
            command: 'apply_ops',
            runId: 'run-orphan',
            correlationId: 'corr-orphan',
            args: {
              target: { typeId: 'mock-app', resourceId: 'res-1' },
              ops: [{ kind: 'set', destructive: false, label: 'set' }],
            },
          }),
        );
        expect(usePresenceStore.getState().byWindow['win-a']).toBeTruthy();
        stageManager.stop();
        await vi.advanceTimersByTimeAsync(ORPHAN_DRAIN_MS + 1);
        expect(getRecentReceiptSummariesForTests()).toEqual([
          expect.objectContaining({
            runId: 'run-orphan',
            status: 'partial',
            message: expect.stringContaining('orphan partial'),
          }),
        ]);
        expect(runLedger.hasRun('run-orphan')).toBe(true);
        stageManager.start();
        setAgentControlForTests('background');
        stageManager.registerDriver(makeDriver());
        const next = await stageManager.handleBridgeRequest(
          baseReq({
            command: 'apply_ops',
            runId: 'run-after-orphan',
            correlationId: 'corr-after-orphan',
            args: {
              target: { typeId: 'mock-app', resourceId: 'res-1' },
              ops: [],
            },
          }),
        );
        expect(next.ok).toBe(true);
        release();
        const oldResult = await oldPending;
        expect(oldResult.data).toMatchObject({ status: 'partial' });
        expect(
          getRecentReceiptSummariesForTests().filter(
            (item) => item.runId === 'run-orphan',
          ),
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('宿主 stop 在当前 op 中仅脱离运行态，迟到 ledger 仍由真实 partial 封账', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let abortRequested = false;
      const driver = makeDriver({
        apply: vi.fn(async (run) => {
          await gate;
          run.ledger.record(
            run.runId,
            () => undefined,
            'host-stop-late-invert',
          );
          return {
            status: abortRequested ? 'partial' : 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: 1,
            entityIds: ['host-stop-entity'],
            done: ['current op committed'],
            undone: abortRequested ? ['remaining work'] : [],
          };
        }),
        abort: vi.fn(() => {
          abortRequested = true;
          return {
            status: 'cancelled',
            mode: 'frontend',
            applied: 0,
            totalOps: 1,
            entityIds: [],
            done: [],
            undone: ['rough host snapshot'],
          };
        }),
      });
      stageManager.start();
      setAgentControlForTests('background');
      stageManager.registerDriver(driver);
      const pending = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [{ kind: 'set', destructive: false, label: 'set' }],
          },
        }),
      );
      await vi.waitFor(() =>
        expect(usePresenceStore.getState().byWindow['win-a']).toBeTruthy(),
      );

      stageManager.stop();
      expect(runLedger.hasRun('run-1')).toBe(false);
      expect(getRecentReceiptSummariesForTests()).toEqual([]);
      expect(usePresenceStore.getState().byWindow['win-a']).toBeUndefined();

      release();
      const res = await pending;
      expect(res.data).toMatchObject({ status: 'partial', applied: 1 });
      expect(runLedger.hasRun('run-1')).toBe(true);
      expect(getRecentReceiptSummariesForTests()).toEqual([
        expect.objectContaining({
          runId: 'run-1',
          status: 'partial',
          applied: 1,
        }),
      ]);
    });

    it('重复活跃 runId 被拒绝，迟到 finally 不会清理原 run 之外的状态', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      stageManager.registerDriver(
        makeDriver({
          apply: vi.fn(async () => {
            await gate;
            return {
              status: 'completed',
              mode: 'frontend',
              applied: 1,
              totalOps: 1,
              entityIds: [],
              done: ['done'],
              undone: [],
            };
          }),
        }),
      );
      const first = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [],
          },
        }),
      );
      await vi.waitFor(() =>
        expect(usePresenceStore.getState().byWindow['win-a']).toBeTruthy(),
      );
      const duplicate = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          correlationId: 'corr-duplicate',
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [],
          },
        }),
      );
      expect(duplicate.ok).toBe(false);
      expect(JSON.parse(duplicate.error!).code).toBe('DUPLICATE_RUN_ID');
      release();
      await first;
    });

    it('canClose 拒绝时窗口和活跃 run 均保持不变', async () => {
      const windowId = useWindowStore.getState().openWindow({
        typeId: 'close-guard-app',
        instanceKey: 'guard-1',
      });
      vi.mocked(probeTarget).mockReturnValue({ state: 'clean', windowId });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const driver = makeDriver({
        typeId: 'close-guard-app',
        apply: vi.fn(async () => {
          await gate;
          return {
            status: 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: 1,
            entityIds: [],
            done: ['done'],
            undone: [],
          };
        }),
      });
      stageManager.registerDriver(driver);
      const pending = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'close-guard-app', resourceId: 'guard-1' },
            ops: [],
          },
        }),
      );
      await vi.waitFor(() =>
        expect(usePresenceStore.getState().byWindow[windowId]).toBeTruthy(),
      );

      const close = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'close_window',
          correlationId: 'corr-close-guard',
          args: { windowId },
        }),
      );
      expect(close.data).toEqual({ closed: false });
      expect(useWindowStore.getState().windows[windowId]).toBeTruthy();
      expect(driver.abort).not.toHaveBeenCalled();
      expect(usePresenceStore.getState().byWindow[windowId]?.runId).toBe(
        'run-1',
      );
      release();
      await pending;
    });

    it('close_window 对缺失窗口返回 WINDOW_NOT_FOUND，桌面关闭时先返回 gate', async () => {
      const missing = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'close_window',
          args: { windowId: 'missing-window' },
        }),
      );
      expect(JSON.parse(missing.error!).code).toBe(
        ACR_ERROR_CODES.WINDOW_NOT_FOUND,
      );

      const existing = useWindowStore
        .getState()
        .openWindow({ typeId: 'mock-app', instanceKey: 'res-gate' });
      workbenchBus.setEnabled(false);
      const disabled = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'close_window',
          correlationId: 'corr-close-disabled',
          args: { windowId: existing },
        }),
      );
      expect(JSON.parse(disabled.error!).code).toBe(
        ACR_ERROR_CODES.WORKBENCH_DISABLED,
      );
      expect(useWindowStore.getState().windows[existing]).toBeTruthy();
    });

    it('app_command background 不抢焦点，follow 保持目标跟随', async () => {
      const original = useWindowStore
        .getState()
        .openWindow({ typeId: 'mock-app', instanceKey: 'origin' });
      const target = useWindowStore
        .getState()
        .openWindow({ typeId: 'command-app', instanceKey: 'target' });
      useWindowStore.getState().focusWindow(original);

      setAgentControlForTests('background');
      await stageManager.handleBridgeRequest(
        baseReq({
          command: 'app_command',
          args: {
            typeId: 'command-app',
            instanceKey: 'target',
            action: 'selectItem',
          },
        }),
      );
      expect(useWindowStore.getState().focusStack.at(-1)).toBe(original);

      setAgentControlForTests('follow');
      await stageManager.handleBridgeRequest(
        baseReq({
          command: 'app_command',
          correlationId: 'corr-follow-command',
          args: {
            typeId: 'command-app',
            instanceKey: 'target',
            action: 'selectItem',
          },
        }),
      );
      expect(useWindowStore.getState().focusStack.at(-1)).toBe(target);
    });

    it('open_app 拒绝资源型空 instanceKey，但允许 chat 多实例空 key', async () => {
      const resource = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'open_app',
          args: { typeId: 'note' },
        }),
      );
      expect(JSON.parse(resource.error!).code).toBe('INVALID_ARGS');

      const chat = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'open_app',
          correlationId: 'corr-open-chat',
          args: { typeId: 'chat' },
        }),
      );
      expect(chat.ok).toBe(true);
      expect(chat.data).toEqual(expect.objectContaining({ created: true }));
    });
  });
});
