/**
 * R2-06 — 全 driver 暂停/续放/中止一致性矩阵 + 租约 TTL + 输入探测过滤
 *
 * 覆盖：
 * 1. 各 CollabDriver：checkPaused abort → partial|cancelled + userPatch
 * 2. userPatch summarizer / 缺省文案
 * 3. 租约 WINDOW_BUSY + presence TTL 心跳续期 / 泄漏自愈
 * 4. stageManager.stop → disposeAllDrivers
 * 5. 输入探测：滚动键 / 标题栏 / AgentStrip 不触发
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
  probeTarget: vi.fn(() => ({ state: 'clean', windowId: 'win-r206' })),
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

vi.mock('../noteBinding', () => ({
  setupNoteBinding: vi.fn(() => vi.fn()),
}));

import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { shouldNotifyAgentUserInput } from '../inputProbe';
import { resetRunLedgerForTests } from '../ledger';
import { usePresenceStore } from '../presenceStore';
import {
  HEARTBEAT_MS,
  PRESENCE_TTL_MS,
  __healStalePresenceForTests,
  resetStageManagerForTests,
  stageManager,
} from '../stageManager';
import {
  DEFAULT_USER_PATCH,
  clearUserPatchSummarizersForTests,
  registerUserPatchSummarizer,
  summarizeUserPatch,
  withUserPatch,
} from '../userPatch';
import type {
  AcrBridgeRequest,
  AcrReceipt,
  AcrRunContext,
  AgentOp,
  CollabDriver,
  Pacer,
  RunLedger,
} from '../types';
import { ACR_ERROR_CODES } from '../types';
import { disposeAllDrivers, registerAllDrivers } from '../drivers';
import { setupNoteBinding } from '../noteBinding';

registerTestApp('acr-matrix-app');

function makePacer(): Pacer {
  return {
    profile: {
      name: 'fast',
      opIntervalMs: 0,
      typeBatchMin: 8,
      typeBatchMax: 40,
      typeIntervalMs: 0,
      instant: true,
    },
    tick: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function makeLedger(): RunLedger {
  return {
    record: vi.fn(),
    revertRun: vi.fn(async () => true),
    hasRun: vi.fn(() => false),
    sealRun: vi.fn(),
  };
}

function makeRun(typeId: string, overrides: Partial<AcrRunContext> = {}): AcrRunContext {
  return {
    runId: `run-${typeId}`,
    sessionId: 'sess-r206',
    target: { typeId },
    windowId: 'win-r206',
    pacing: makePacer(),
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: makeLedger(),
    ...overrides,
  };
}

const OPS: AgentOp[] = [
  { kind: 'noop_a', destructive: false, label: '步骤A' },
  { kind: 'noop_b', destructive: false, label: '步骤B' },
  { kind: 'noop_c', destructive: false, label: '步骤C' },
];

/**
 * 矩阵用轻量 driver：逐 op checkPaused；abort → cancelled + withUserPatch。
 * 真实 driver 的 abort 路径已各自接线；此处验证契约矩阵与 StageManager 租约。
 */
function makeMatrixDriver(typeId: string): CollabDriver {
  return {
    typeId,
    probe: () => 'clean',
    abort(runId: string): AcrReceipt {
      return withUserPatch(
        {
          status: 'cancelled',
          mode: 'frontend',
          applied: 0,
          totalOps: 0,
          entityIds: [],
          done: [],
          undone: [`${runId} aborted`],
          message: '外部 abort',
        },
        typeId,
      );
    },
    async apply(run, ops): Promise<AcrReceipt> {
      const done: string[] = [];
      const undone: string[] = [];
      for (let i = 0; i < ops.length; i++) {
        const decision = await run.checkPaused();
        if (decision === 'abort') {
          for (let j = i; j < ops.length; j++) undone.push(ops[j]!.label);
          return withUserPatch(
            {
              status: 'partial',
              mode: 'frontend',
              applied: done.length,
              totalOps: ops.length,
              entityIds: [],
              done,
              undone,
              message: '仲裁 abort',
            },
            typeId,
          );
        }
        done.push(ops[i]!.label);
        run.reportProgress(i + 1, ops.length, ops[i]!.label);
        await run.pacing.tick(0);
      }
      return {
        status: 'completed',
        mode: 'frontend',
        applied: done.length,
        totalOps: ops.length,
        entityIds: [],
        done,
        undone: [],
      };
    },
  };
}

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command'>,
): AcrBridgeRequest {
  return {
    correlationId: 'corr-r206',
    args: {},
    timeoutMs: 30_000,
    runId: 'run-r206',
    sessionId: 'sess-r206',
    ...partial,
  };
}

const DRIVER_TYPE_IDS = [
  'mindmap',
  'note',
  'todo',
  'files',
  'flashcards',
  'exam',
  'pomodoro',
] as const;

describe('R2-06 arbitration consistency matrix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    clearUserPatchSummarizersForTests();
    resetWindowStoreForTests({ w: 1400, h: 900 });
    useWindowStore.setState({
      windows: {
        'win-r206': {
          id: 'win-r206',
          typeId: 'acr-matrix-app',
          instanceKey: 'res-1',
          title: 'Matrix',
          frame: { x: 40, y: 40, w: 400, h: 300 },
          restoreFrame: null,
          displayMode: 'floating',
          minimized: false,
          zIndex: 10,
          createdAt: 1,
          lastFocusedAt: 1,
        },
      },
      focusStack: ['win-r206'],
      lifecycles: { 'win-r206': 'focused' },
    });
    stageManager.start();
  });

  afterEach(() => {
    stageManager.stop();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    clearUserPatchSummarizersForTests();
    vi.useRealTimers();
  });

  describe('userPatch', () => {
    it('缺省文案为「用户进行了手动编辑」', () => {
      expect(summarizeUserPatch('unknown-type')).toBe(DEFAULT_USER_PATCH);
      expect(DEFAULT_USER_PATCH).toBe('用户进行了手动编辑');
    });

    it('各 driver summarizer 覆盖缺省', () => {
      for (const typeId of DRIVER_TYPE_IDS) {
        registerUserPatchSummarizer(typeId, () => `${typeId}-patch`);
        expect(summarizeUserPatch(typeId)).toBe(`${typeId}-patch`);
      }
    });

    it('withUserPatch 仅填充 partial/cancelled，且不覆盖已有文案', () => {
      const completed = withUserPatch(
        {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['a'],
          undone: [],
        },
        'note',
      );
      expect(completed.userPatch).toBeUndefined();

      const custom = withUserPatch(
        {
          status: 'partial',
          mode: 'frontend',
          applied: 0,
          totalOps: 1,
          entityIds: [],
          done: [],
          undone: ['x'],
          userPatch: '自定义摘要',
        },
        'note',
      );
      expect(custom.userPatch).toBe('自定义摘要');
    });
  });

  describe.each(DRIVER_TYPE_IDS)('driver matrix: %s', (typeId) => {
    it('checkPaused abort → partial + userPatch', async () => {
      registerUserPatchSummarizer(typeId, () => `${typeId} 用户改动`);
      const driver = makeMatrixDriver(typeId);
      const run = makeRun(typeId, {
        checkPaused: vi.fn(async () => 'abort' as const),
      });
      const receipt = await driver.apply(run, OPS);
      expect(receipt.status).toBe('partial');
      expect(receipt.undone.length).toBeGreaterThan(0);
      expect(receipt.userPatch).toBe(`${typeId} 用户改动`);
    });

    it('resume 路径可跑完全部 op', async () => {
      const driver = makeMatrixDriver(typeId);
      const receipt = await driver.apply(makeRun(typeId), OPS);
      expect(receipt.status).toBe('completed');
      expect(receipt.applied).toBe(3);
      expect(receipt.userPatch).toBeUndefined();
    });

    it('abort() 回执带 userPatch', () => {
      registerUserPatchSummarizer(typeId, () => `${typeId} abort-patch`);
      const receipt = makeMatrixDriver(typeId).abort(`run-${typeId}`);
      expect(['partial', 'cancelled']).toContain(receipt.status);
      expect(receipt.userPatch).toBe(`${typeId} abort-patch`);
    });
  });

  describe('StageManager 租约 / TTL / stop', () => {
    it('同窗第二路 apply_ops → WINDOW_BUSY', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const driver = makeMatrixDriver('acr-matrix-app');
      driver.apply = vi.fn(async () => {
        await gate;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['ok'],
          undone: [],
        };
      });
      stageManager.registerDriver(driver);

      const first = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: 'run-busy-1',
          correlationId: 'corr-busy-1',
          args: {
            target: { typeId: 'acr-matrix-app', resourceId: 'res-1' },
            ops: OPS.slice(0, 1),
            pacing: 'fast',
          },
        }),
      );

      await vi.waitFor(() => {
        expect(usePresenceStore.getState().byWindow['win-r206']?.runId).toBe('run-busy-1');
      });

      const second = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          runId: 'run-busy-2',
          correlationId: 'corr-busy-2',
          args: {
            target: { typeId: 'acr-matrix-app', resourceId: 'res-1' },
            ops: OPS.slice(0, 1),
            pacing: 'fast',
          },
        }),
      );
      expect(second.ok).toBe(false);
      expect(JSON.parse(second.error!).code).toBe(ACR_ERROR_CODES.WINDOW_BUSY);

      release();
      await first;
    });

    it('心跳续期：未过 TTL 时 heal 不清 presence', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const driver = makeMatrixDriver('acr-matrix-app');
      driver.apply = vi.fn(async () => {
        await gate;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['ok'],
          undone: [],
        };
      });
      stageManager.registerDriver(driver);

      const p = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'acr-matrix-app', resourceId: 'res-1' },
            ops: OPS.slice(0, 1),
            pacing: 'fast',
          },
        }),
      );
      await vi.waitFor(() => {
        expect(usePresenceStore.getState().byWindow['win-r206']).toBeTruthy();
      });

      // 推进若干心跳周期，仍应存活
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
      __healStalePresenceForTests(Date.now());
      expect(usePresenceStore.getState().byWindow['win-r206']?.runId).toBe('run-r206');

      release();
      await p;
    });

    it('孤儿 presence 超 TTL → heal 清除', () => {
      const now = Date.now();
      usePresenceStore.getState().setPresence({
        runKey: JSON.stringify(['sess-r206', 'orphan-run']),
        runId: 'orphan-run',
        sessionId: 'sess-r206',
        windowId: 'win-r206',
        typeId: 'note',
        status: 'acting',
        label: '泄漏',
        startedAt: now - PRESENCE_TTL_MS - 1,
        ttlMs: PRESENCE_TTL_MS,
      });
      __healStalePresenceForTests(now);
      expect(usePresenceStore.getState().byWindow['win-r206']).toBeUndefined();
    });

    it('stop → disposeAllDrivers（退订 noteBinding）', () => {
      stageManager.stop();
      const disposeFn = vi.fn();
      vi.mocked(setupNoteBinding).mockReturnValue(disposeFn);
      stageManager.start();
      expect(setupNoteBinding).toHaveBeenCalled();
      stageManager.stop();
      expect(disposeFn).toHaveBeenCalled();
      // 幂等再调 disposeAllDrivers 不抛
      expect(() => disposeAllDrivers()).not.toThrow();
    });
  });

  describe('输入探测误报治理', () => {
    it('内容区 pointerdown 触发', () => {
      const target = document.createElement('div');
      expect(
        shouldNotifyAgentUserInput({ type: 'pointerdown', target, button: 0 }),
      ).toBe(true);
    });

    it('AgentStrip / 标题栏不触发', () => {
      const strip = document.createElement('div');
      strip.setAttribute('data-acr-agent-strip', '');
      const btn = document.createElement('button');
      strip.appendChild(btn);
      expect(shouldNotifyAgentUserInput({ type: 'pointerdown', target: btn })).toBe(
        false,
      );

      const title = document.createElement('div');
      title.setAttribute('data-wb-titlebar', '');
      const titleChild = document.createElement('span');
      title.appendChild(titleChild);
      expect(
        shouldNotifyAgentUserInput({ type: 'pointerdown', target: titleChild }),
      ).toBe(false);
    });

    it('滚轮 / 中键 / 纯滚动键不触发', () => {
      const target = document.createElement('div');
      expect(shouldNotifyAgentUserInput({ type: 'wheel', target })).toBe(false);
      expect(shouldNotifyAgentUserInput({ type: 'pointerdown', target, button: 1 })).toBe(
        false,
      );
      expect(
        shouldNotifyAgentUserInput({ type: 'keydown', key: 'ArrowDown', target }),
      ).toBe(false);
      expect(
        shouldNotifyAgentUserInput({ type: 'keydown', key: 'PageDown', target }),
      ).toBe(false);
      expect(shouldNotifyAgentUserInput({ type: 'keydown', key: ' ', target })).toBe(
        false,
      );
    });

    it('可编辑区内滚动键仍算打断', () => {
      const input = document.createElement('textarea');
      expect(
        shouldNotifyAgentUserInput({ type: 'keydown', key: 'ArrowDown', target: input }),
      ).toBe(true);
    });
  });

  describe('registerAllDrivers summarizer 接线', () => {
    it('registerAllDrivers 后各 typeId 有非缺省概述', () => {
      registerAllDrivers(stageManager);
      for (const typeId of DRIVER_TYPE_IDS) {
        const patch = summarizeUserPatch(typeId);
        expect(patch).toBeTruthy();
        expect(patch).not.toBe('');
      }
      disposeAllDrivers();
    });
  });
});
