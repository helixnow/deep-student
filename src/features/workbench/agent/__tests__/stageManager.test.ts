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
import * as workspaceRegistry from '../../apps/notes/workspaceRegistry';
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
registerTestApp('command-reject-app', {
  onActivation: async () => {
    throw new Error('async activation rejected');
  },
});
registerTestApp('chat');
registerTestApp('notes');

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

  it('app_command await 异步 activation rejection，不误报 handled 成功', async () => {
    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        args: {
          typeId: 'command-reject-app',
          instanceKey: 'reject-target',
          action: 'reject',
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.error!)).toMatchObject({
      code: 'INTERNAL',
      message: 'async activation rejected',
    });
  });

  it('workbench app_command 可聚焦、最小化和布局窗口', async () => {
    const minimize = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        args: {
          typeId: 'workbench',
          action: 'minimizeWindow',
          payload: { windowId: 'win-a' },
        },
      }),
    );
    expect(minimize.ok).toBe(true);
    expect(minimize.data).toMatchObject({
      handled: true,
      windowId: 'win-a',
      minimized: true,
      focused: false,
    });

    const tile = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        correlationId: 'corr-tile-right',
        runId: 'run-tile-right',
        args: {
          typeId: 'workbench',
          action: 'tileRight',
          payload: { windowId: 'win-a' },
        },
      }),
    );
    expect(tile.ok).toBe(true);
    expect(useWindowStore.getState().windows['win-a'].displayMode).toBe('tiled-right');

    const focus = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        correlationId: 'corr-focus-window',
        runId: 'run-focus-window',
        args: {
          typeId: 'workbench',
          action: 'focusWindow',
          payload: { windowId: 'win-a' },
        },
      }),
    );
    expect(focus.data).toMatchObject({ minimized: false, focused: true });
  });

  it('workbench app_command 对失效 windowId 返回可行动错误', async () => {
    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        args: {
          typeId: 'workbench',
          action: 'focusWindow',
          payload: { windowId: 'missing' },
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.error!)).toMatchObject({ code: 'WINDOW_NOT_FOUND' });
  });

  it('workbench tileAll/showDesktop 支持桌面级批量布局', async () => {
    useWindowStore.getState().openWindow({
      typeId: 'mock-app',
      instanceKey: 'res-2',
      title: 'Second',
    });
    const tile = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        correlationId: 'corr-tile-all',
        runId: 'run-tile-all',
        args: { typeId: 'workbench', action: 'tileAll' },
      }),
    );
    expect(tile.data).toMatchObject({ handled: true, overflow: 0 });
    expect(Object.values(useWindowStore.getState().windows).map((win) => win.displayMode).sort())
      .toEqual(['tiled-left', 'tiled-right']);

    const desktop = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'app_command',
        correlationId: 'corr-show-desktop',
        runId: 'run-show-desktop',
        args: { typeId: 'workbench', action: 'showDesktop' },
      }),
    );
    expect(desktop.data).toMatchObject({ handled: true });
    expect(Object.values(useWindowStore.getState().windows).every((win) => win.minimized)).toBe(true);
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

    const winA = useWindowStore.getState().windows['win-a'];
    useWindowStore.setState((state) => ({
      windows: {
        ...state.windows,
        'win-b': { ...winA, id: 'win-b', instanceKey: 'res-2', title: 'B' },
      },
      focusStack: [...state.focusStack, 'win-b'],
      lifecycles: { ...state.lifecycles, 'win-b': 'focused' },
    }));
    setAgentControlForTests('follow');
    useWindowStore.getState().focusWindow('win-b');

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
    expect(useWindowStore.getState().focusStack.at(-1)).toBe('win-b');

    release();
    const firstRes = await first;
    expect(firstRes.ok).toBe(true);
    expect((firstRes.data as AcrReceipt).status).toBe('completed');
  });

  it('wait_for aliases typeId note to the notes window for lease binding', async () => {
    const winA = useWindowStore.getState().windows['win-a'];
    useWindowStore.setState((state) => ({
      windows: {
        ...state.windows,
        'win-notes': {
          ...winA,
          id: 'win-notes',
          typeId: 'notes',
          instanceKey: null,
          title: 'Notes',
        },
      },
      focusStack: [...state.focusStack, 'win-notes'],
      lifecycles: { ...state.lifecycles, 'win-notes': 'focused' },
    }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitSpy = vi.spyOn(workbenchBus, 'waitForAgent').mockImplementation(async () => {
      await gate;
      return {
        matched: true,
        timedOut: false,
        elapsedMs: 1,
        failedConditions: [],
        observation: {
          windowId: 'win-notes',
          typeId: 'notes',
          revision: 'notes:1',
          state: {},
          selection: [],
          availableActions: [],
          entities: [],
          affordances: [],
        },
      };
    });

    try {
      const pending = stageManager.handleBridgeRequest(
        baseReq({
          command: 'wait_for',
          runId: 'run-alias-note',
          correlationId: 'corr-alias-note',
          args: {
            typeId: 'note',
            conditions: [{ kind: 'stateEquals', path: 'ready', value: true }],
            timeoutMs: 5_000,
          },
        }),
      );
      await vi.waitFor(() => {
        expect(stageManager.getDiagnostics().transactions).toEqual([
          expect.objectContaining({
            runId: 'run-alias-note',
            kind: 'wait_for',
            windowId: 'win-notes',
          }),
        ]);
      });
      release();
      const result = await pending;
      expect(result.ok).toBe(true);
    } finally {
      waitSpy.mockRestore();
    }
  });

  it('准备资源期间取消会阻止 driver.apply', async () => {
    const winA = useWindowStore.getState().windows['win-a'];
    useWindowStore.setState((state) => ({
      windows: {
        ...state.windows,
        'win-notes': {
          ...winA,
          id: 'win-notes',
          typeId: 'notes',
          instanceKey: null,
          title: 'Notes',
        },
      },
      focusStack: [...state.focusStack, 'win-notes'],
      lifecycles: { ...state.lifecycles, 'win-notes': 'focused' },
    }));
    vi.mocked(probeTarget).mockReturnValue({
      state: 'clean',
      windowId: 'win-notes',
    });
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const prepare = vi
      .spyOn(workspaceRegistry, 'prepareWorkspaceResource')
      .mockImplementation(async () => preparationGate);
    const driver = makeDriver({ typeId: 'note' });
    stageManager.registerDriver(driver);

    try {
      const pending = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: 'run-preparing',
          correlationId: 'corr-preparing',
          args: {
            target: { typeId: 'note', resourceId: 'note-preparing' },
            ops: [{ kind: 'append', destructive: false, label: 'append' }],
          },
        }),
      );
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      expect(stageManager.getDiagnostics().transactions).toEqual([
        expect.objectContaining({
          runId: 'run-preparing',
          kind: 'apply_ops',
          ownsLease: true,
        }),
      ]);

      stageManager.stopRun(JSON.stringify(['sess-1', 'run-preparing']));
      releasePreparation();
      const result = await pending;
      expect(result.data).toMatchObject({
        status: 'cancelled',
        applied: 0,
        undone: ['append'],
      });
      expect(driver.apply).not.toHaveBeenCalled();
      expect(stageManager.getDiagnostics().transactions).toEqual([]);
    } finally {
      prepare.mockRestore();
    }
  });

  it('不同会话复用外部 runId 时驱动取消与 presence 保持隔离', async () => {
    const winA = useWindowStore.getState().windows['win-a'];
    useWindowStore.setState((state) => ({
      windows: {
        ...state.windows,
        'win-b': {
          ...winA,
          id: 'win-b',
          instanceKey: 'res-2',
          title: 'Mock B',
          zIndex: 11,
        },
      },
      focusStack: ['win-a', 'win-b'],
      lifecycles: { ...state.lifecycles, 'win-b': 'focused' },
    }));
    vi.mocked(probeTarget).mockImplementation((target) => ({
      state: 'clean',
      windowId: target.resourceId === 'res-2' ? 'win-b' : 'win-a',
    }));

    let failFirst!: () => void;
    let finishSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      failFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const states = new Map<string, { aborted: boolean }>();
    const seenRunIds: string[] = [];
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        const state = { aborted: false };
        states.set(run.runId, state);
        seenRunIds.push(run.runId);
        if (run.sessionId === 'sess-a') {
          await firstGate;
          throw new Error('first session failed');
        }
        await secondGate;
        return {
          status: state.aborted ? 'cancelled' : 'completed',
          mode: 'frontend',
          applied: state.aborted ? 0 : 1,
          totalOps: 1,
          entityIds: [],
          done: state.aborted ? [] : ['second done'],
          undone: state.aborted ? ['second aborted'] : [],
        };
      }),
      abort: vi.fn((runId): AcrReceipt => {
        const state = states.get(runId);
        if (state) state.aborted = true;
        return {
          status: 'cancelled',
          mode: 'frontend',
          applied: 0,
          totalOps: 1,
          entityIds: [],
          done: [],
          undone: ['aborted'],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const externalRunId = 'shared-tool-call';
    const first = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        sessionId: 'sess-a',
        runId: externalRunId,
        correlationId: 'corr-a',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'set', destructive: false, label: 'first' }],
        },
      }),
    );
    const second = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        sessionId: 'sess-b',
        runId: externalRunId,
        correlationId: 'corr-b',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-2' },
          ops: [{ kind: 'set', destructive: false, label: 'second' }],
        },
      }),
    );

    await vi.waitFor(() => expect(seenRunIds).toHaveLength(2));
    expect(new Set(seenRunIds).size).toBe(2);
    expect(seenRunIds).toContain(JSON.stringify(['sess-a', externalRunId]));
    expect(seenRunIds).toContain(JSON.stringify(['sess-b', externalRunId]));

    failFirst();
    const firstResult = await first;
    expect(firstResult.data).toMatchObject({ status: 'failed' });
    expect(driver.abort).toHaveBeenCalledWith(
      JSON.stringify(['sess-a', externalRunId]),
    );
    expect(states.get(JSON.stringify(['sess-b', externalRunId]))?.aborted).toBe(
      false,
    );
    expect(usePresenceStore.getState().byWindow['win-b']).toMatchObject({
      runId: externalRunId,
      sessionId: 'sess-b',
      status: 'acting',
    });

    finishSecond();
    const secondResult = await second;
    expect(secondResult.data).toMatchObject({ status: 'completed' });
  });

  it('终态事务按 session/runId 重放，且拒绝同 ID 更换 payload', async () => {
    const driver = makeDriver();
    stageManager.registerDriver(driver);
    const args = {
      target: { typeId: 'mock-app', resourceId: 'res-1' },
      ops: [{ kind: 'set', destructive: false, label: 'set once' }],
    };
    const first = await stageManager.handleBridgeRequest(
      baseReq({ command: 'apply_ops', runId: 'run-terminal', args }),
    );
    const replay = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-terminal',
        correlationId: 'corr-terminal-replay',
        args,
      }),
    );

    expect(replay).toEqual({ ...first, correlationId: 'corr-terminal-replay' });
    expect(driver.apply).toHaveBeenCalledTimes(1);

    const reused = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-terminal',
        correlationId: 'corr-terminal-reuse',
        args: {
          ...args,
          ops: [{ kind: 'set', destructive: false, label: 'different payload' }],
        },
      }),
    );
    expect(reused.ok).toBe(false);
    expect(JSON.parse(reused.error!)).toMatchObject({
      code: 'RUN_ID_REUSE',
      retryable: false,
    });
    expect(driver.apply).toHaveBeenCalledTimes(1);
  });

  it('终态正文被 LRU 淘汰后仍拒绝重新执行已见 forward runId', async () => {
    const driver = makeDriver();
    stageManager.registerDriver(driver);
    const firstArgs = {
      target: { typeId: 'mock-app', resourceId: 'res-1' },
      ops: [{ kind: 'set', destructive: false, label: 'first' }],
    };
    await stageManager.handleBridgeRequest(
      baseReq({ command: 'apply_ops', runId: 'run-evicted', args: firstArgs }),
    );
    for (let index = 0; index < 101; index += 1) {
      await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: `run-fill-${index}`,
          correlationId: `corr-fill-${index}`,
          args: {
            target: { typeId: 'mock-app', resourceId: 'res-1' },
            ops: [{ kind: 'set', destructive: false, label: `fill ${index}` }],
          },
        }),
      );
    }
    const callsBeforeReplay = vi.mocked(driver.apply).mock.calls.length;
    const replay = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-evicted',
        correlationId: 'corr-evicted-replay',
        args: firstArgs,
      }),
    );
    expect(replay.ok).toBe(false);
    expect(JSON.parse(replay.error!)).toMatchObject({
      code: 'RUN_ID_EXPIRED',
      retryable: false,
    });
    expect(driver.apply).toHaveBeenCalledTimes(callsBeforeReplay);
  });

  it('revert_run 经账本逆序 invert，同事务重放终态且新事务返回 false', async () => {
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
    expect(res2.data).toEqual({ reverted: true });

    const res3 = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'revert_run',
        runId: 'run-new-revert-call',
        correlationId: 'corr-3',
        args: { runId: 'run-rev' },
      }),
    );
    expect(res3.data).toEqual({ reverted: false });

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
    expect(await stageManager.revertRun('run-1', 'sess-1')).toBe(true);
    expect(await stageManager.revertRun('run-1', 'sess-1')).toBe(false);
  });

  it('UI undo 与 apply_ops 共用窗口租约', async () => {
    let inverseStarted!: () => void;
    let releaseInverse!: () => void;
    const started = new Promise<void>((resolve) => {
      inverseStarted = resolve;
    });
    const inverseGate = new Promise<void>((resolve) => {
      releaseInverse = resolve;
    });
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        run.ledger.record(
          run.runId,
          async () => {
            inverseStarted();
            await inverseGate;
          },
          'undo set',
        );
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['set'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);
    await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-ui-undo',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'set', destructive: false, label: 'set' }],
        },
      }),
    );

    const undo = stageManager.revertRun('run-ui-undo', 'sess-1');
    await started;
    const blocked = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-during-ui-undo',
        correlationId: 'corr-during-ui-undo',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [],
        },
      }),
    );
    expect(JSON.parse(blocked.error!)).toMatchObject({
      code: ACR_ERROR_CODES.WINDOW_BUSY,
    });

    releaseInverse();
    expect(await undo).toBe(true);
    const after = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-during-ui-undo',
        correlationId: 'corr-after-ui-undo',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [],
        },
      }),
    );
    expect(after.ok).toBe(true);
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
    vi.mocked(probeTarget).mockImplementation((target) => ({
      state: 'clean',
      windowId: windows[Number(target.resourceId?.split('-').at(-1)) - 1] ?? null,
    }));
    const promises = windows.map((_wid, i) => {
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
    // ACR 4.0（A5 接线后）：直落原因走结构化 placementHint，label 不再拼中文后缀
    expect(usePresenceStore.getState().byWindow['win-c']?.placementHint).toBe(
      'stage-full',
    );
    expect(usePresenceStore.getState().byWindow['win-c']?.label).toBe('add');

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
      expect(updateStatus).toHaveBeenCalledWith(
        JSON.stringify(['sess-1', 'run-1']),
        'aborted',
      );
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

      stageManager.stopRun(JSON.stringify(['sess-1', 'run-1']));
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

    it('orphan deadline 隔离窗口直到底层任务真正结算', async () => {
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
        expect(getRecentReceiptSummariesForTests()).toEqual([]);
        expect(runLedger.hasRun('run-orphan')).toBe(true);
        stageManager.start();
        setAgentControlForTests('background');
        stageManager.registerDriver(makeDriver());
        expect(stageManager.getDiagnostics().transactions).toEqual([
          expect.objectContaining({
            runId: 'run-orphan',
            state: 'orphan-draining',
            ownsLease: true,
          }),
        ]);
        const blocked = await stageManager.handleBridgeRequest(
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
        expect(JSON.parse(blocked.error!)).toMatchObject({
          code: ACR_ERROR_CODES.WINDOW_BUSY,
        });
        release();
        const oldResult = await oldPending;
        expect(oldResult.data).toMatchObject({ status: 'completed' });
        expect(
          getRecentReceiptSummariesForTests().filter(
            (item) => item.runId === 'run-orphan',
          ),
        ).toHaveLength(1);
        const next = await stageManager.handleBridgeRequest(
          baseReq({
            command: 'apply_ops',
            runId: 'run-after-orphan',
            correlationId: 'corr-after-orphan-retry',
            args: {
              target: { typeId: 'mock-app', resourceId: 'res-1' },
              ops: [],
            },
          }),
        );
        expect(next.ok).toBe(true);
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
          runId: 'run-close-guard',
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
          correlationId: 'corr-background-command',
          runId: 'run-background-command',
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
          runId: 'run-follow-command',
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
