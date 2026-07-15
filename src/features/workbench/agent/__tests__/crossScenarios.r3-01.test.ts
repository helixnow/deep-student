/**
 * ACR R3-01 — 交叉场景补测
 * - 同窗连续两 run（租约释放后第二路可申请）
 * - done 后 presence 短时保留（S-REV-02）
 * - 会话切换不中止异窗 run（租约按 windowId，list_windows 无副作用）
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
  probeTarget: vi.fn(() => ({ state: 'clean', windowId: 'win-cross' })),
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
import { resetRunLedgerForTests, runLedger } from '../ledger';
import { usePresenceStore } from '../presenceStore';
import { resetStageManagerForTests, stageManager } from '../stageManager';
import type { AcrBridgeRequest, AcrReceipt, AcrRunContext, AgentOp, CollabDriver } from '../types';

registerTestApp('acr-cross');

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command' | 'runId'>,
): AcrBridgeRequest {
  return {
    correlationId: `corr-${partial.runId}`,
    args: {},
    timeoutMs: 30_000,
    sessionId: 'sess-a',
    ...partial,
  };
}

describe('R3-01 cross scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetWindowStoreForTests({ w: 1400, h: 900 });
    usePresenceStore.getState().clearAll();
    useWindowStore.setState({
      windows: {
        'win-cross': {
          id: 'win-cross',
          typeId: 'acr-cross',
          instanceKey: 'n1',
          title: 'Cross',
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          zIndex: 1,
          minimized: false,
          maximized: false,
          createdAt: Date.now(),
          lastFocusedAt: Date.now(),
          launchPayload: null,
        },
      },
      focusStack: ['win-cross'],
      lifecycles: { 'win-cross': 'focused' },
    } as never);
    stageManager.start();
  });

  afterEach(() => {
    stageManager.stop();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    usePresenceStore.getState().clearAll();
  });

  it('同窗连续两 run：第一路完成后第二路不再 WINDOW_BUSY', async () => {
    const driver: CollabDriver = {
      typeId: 'acr-cross',
      probe: () => 'clean',
      async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
        run.ledger.record(run.runId, () => {}, ops[0]?.label ?? 'op');
        return {
          status: 'completed',
          mode: 'frontend',
          applied: ops.length,
          totalOps: ops.length,
          entityIds: ['n1'],
          done: ops.map((o) => o.label),
          undone: [],
        };
      },
      abort: () => ({
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 0,
        entityIds: [],
        done: [],
        undone: [],
      }),
    };
    stageManager.registerDriver(driver);

    const op: AgentOp = {
      kind: 'note_insert',
      destructive: false,
      label: 'step',
      payload: { content: 'x' },
    };

    const first = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-1',
        args: {
          target: { typeId: 'acr-cross', resourceId: 'n1' },
          ops: [op],
        },
      }),
    );
    expect(first.ok).toBe(true);
    expect((first.data as AcrReceipt).status).toBe('completed');

    const second = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-2',
        args: {
          target: { typeId: 'acr-cross', resourceId: 'n1' },
          ops: [op],
        },
      }),
    );
    expect(second.ok).toBe(true);
    expect((second.data as AcrReceipt).status).toBe('completed');
  });

  it('S-REV-02：completed 后 presence 短时保留且可 revert', async () => {
    let inverted = false;
    const driver: CollabDriver = {
      typeId: 'acr-cross',
      probe: () => 'clean',
      async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
        run.ledger.record(
          run.runId,
          () => {
            inverted = true;
          },
          ops[0]?.label ?? 'op',
        );
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: ['n1'],
          done: ['op'],
          undone: [],
        };
      },
      abort: () => ({
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 0,
        entityIds: [],
        done: [],
        undone: [],
      }),
    };
    stageManager.registerDriver(driver);

    await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-hold',
        args: {
          target: { typeId: 'acr-cross', resourceId: 'n1' },
          ops: [
            {
              kind: 'note_insert',
              destructive: false,
              label: 'op',
              payload: { content: 'y' },
            },
          ],
        },
      }),
    );

    const presence = usePresenceStore.getState().byWindow['win-cross'];
    expect(presence?.status).toBe('done');
    expect(presence?.runId).toBe('run-hold');
    expect(runLedger.hasRun('run-hold')).toBe(true);

    expect(await stageManager.revertRun('run-hold')).toBe(false);
    expect(usePresenceStore.getState().byWindow['win-cross']?.status).toBe('done');

    const ok = await stageManager.revertRun('run-hold', 'sess-a');
    expect(ok).toBe(true);
    expect(inverted).toBe(true);
    expect(usePresenceStore.getState().byWindow['win-cross']).toBeUndefined();
  });

  it('会话切换：异 sessionId 的 list_windows 不中止进行中的 apply_ops', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const driver: CollabDriver = {
      typeId: 'acr-cross',
      probe: () => 'clean',
      async apply(run: AcrRunContext): Promise<AcrReceipt> {
        await gate;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: [run.sessionId],
          undone: [],
        };
      },
      abort: () => ({
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 0,
        entityIds: [],
        done: [],
        undone: ['aborted'],
      }),
    };
    stageManager.registerDriver(driver);

    const p = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-sess-a',
        sessionId: 'sess-a',
        args: {
          target: { typeId: 'acr-cross', resourceId: 'n1' },
          ops: [
            {
              kind: 'note_insert',
              destructive: false,
              label: 'a',
              payload: { content: 'a' },
            },
          ],
        },
      }),
    );

    const q = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'list_windows',
        runId: 'run-sess-b',
        sessionId: 'sess-b',
        args: {},
      }),
    );
    expect(q.ok).toBe(true);
    expect(usePresenceStore.getState().byWindow['win-cross']?.runId).toBe(
      'run-sess-a',
    );

    release();
    const receipt = await p;
    expect(receipt.ok).toBe(true);
    expect((receipt.data as AcrReceipt).status).toBe('completed');
    expect((receipt.data as AcrReceipt).done).toContain('sess-a');
  });
});
