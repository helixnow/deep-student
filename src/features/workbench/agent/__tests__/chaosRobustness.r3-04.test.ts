/**
 * R3-04 — 稳健性混沌：取消/完成竞态、桥超时注入、driver 异常、
 * partial 后重试不误杀 doom-loop、AgentOp 幂等（todo/闪卡）、revert 两次安全。
 *
 * 见 docs/dev/acr/ROUND3.md R3-04、DESIGN §0.7 / §2.2。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { setActiveList } = vi.hoisted(() => ({
  setActiveList: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async () => null),
}));

vi.mock('../probe', () => ({
  probeTarget: vi.fn(() => ({ state: 'clean', windowId: 'win-chaos' })),
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

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany: vi.fn(),
}));

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    getState: () => ({
      setActiveList,
    }),
  },
}));

import {
  resetWindowStoreForTests,
  useWindowStore,
} from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import {
  useFsrsReviewStore,
  type ReviewCard,
} from '@/features/flashcards/store/fsrsReviewStore';
import { fsrsDriver } from '../drivers/fsrsDriver';
import { todoDriver } from '../drivers/todoDriver';
import { resetRunLedgerForTests, runLedger } from '../ledger';
import { usePresenceStore } from '../presenceStore';
import { resetStageManagerForTests, stageManager } from '../stageManager';
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

registerTestApp('acr-chaos-app');
registerTestApp('todo');
registerTestApp('flashcards');

const CHAOS_ITERS = 1000;

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command'>,
): AcrBridgeRequest {
  return {
    correlationId: 'corr-chaos',
    args: {},
    timeoutMs: 30_000,
    runId: 'run-chaos',
    sessionId: 'sess-chaos',
    ...partial,
  };
}

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

function seedWindow(windowId = 'win-chaos', typeId = 'acr-chaos-app'): void {
  useWindowStore.setState({
    windows: {
      [windowId]: {
        id: windowId,
        typeId,
        instanceKey: 'res-chaos',
        title: 'chaos',
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        zIndex: 1,
      },
    },
    focusStack: [windowId],
    lifecycles: { [windowId]: 'focused' },
  });
}

/**
 * 镜像 Rust DoomLoopGuard（context.rs）：同指纹连续 ≥3 Skip，≥5 Abort。
 * 前端单测验证「partial 后改参重试不误杀」。
 */
const DOOM_WARN = 3;
const DOOM_ABORT = 5;

type DoomVerdict = 'execute' | 'skip' | 'abort';

class DoomLoopGuardMirror {
  private last: string | null = null;
  private count = 0;

  observe(toolName: string, args: unknown): DoomVerdict {
    const fp = createHash('sha256')
      .update(toolName)
      .update('\x1f')
      .update(JSON.stringify(args ?? {}))
      .digest('hex');
    if (this.last === fp) this.count += 1;
    else {
      this.last = fp;
      this.count = 1;
    }
    if (this.count >= DOOM_ABORT) return 'abort';
    if (this.count >= DOOM_WARN) return 'skip';
    return 'execute';
  }
}

/** 镜像 tool_loop::is_transient_tool_error 的 ACR 排除面（partial 不自动重试） */
function isTransientToolErrorMirror(error: string): boolean {
  const lower = error.toLowerCase();
  if (
    lower.includes('cancel') ||
    lower.includes('partial') ||
    lower.includes('workbench_disabled') ||
    lower.includes('workbench_unavailable') ||
    lower.includes('window_busy') ||
    lower.includes('strict_mode') ||
    lower.includes('"retryable":false') ||
    lower.includes('"retryable": false')
  ) {
    return false;
  }
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('connection') ||
    lower.includes('429')
  );
}

function card(id: string): ReviewCard {
  return { id, ankiCardId: id, front: id, back: `b-${id}` };
}

describe('R3-04 chaos robustness', () => {
  beforeEach(() => {
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetWindowStoreForTests();
    usePresenceStore.getState().clearAll();
    setActiveList.mockClear();
    seedWindow();
    stageManager.start();
  });

  afterEach(() => {
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetWindowStoreForTests();
    usePresenceStore.getState().clearAll();
  });

  describe('取消与完成竞态 ×1000', () => {
    it('stopRun 与 apply 完成交错：无双写、无 presence/租约泄漏、Promise 均结算', async () => {
      let writeCount = 0;
      const abortFlag = { value: false };

      const driver: CollabDriver = {
        typeId: 'acr-chaos-app',
        probe: () => 'clean',
        abort() {
          abortFlag.value = true;
          return {
            status: 'partial',
            mode: 'frontend',
            applied: writeCount,
            totalOps: 1,
            entityIds: writeCount > 0 ? ['e1'] : [],
            done: writeCount > 0 ? ['wrote'] : [],
            undone: writeCount > 0 ? [] : ['未写'],
            message: 'aborted',
          };
        },
        async apply(run, ops) {
          // 勿在此清 abortFlag：stopRun 可能已先于 apply 置位
          const pause = await run.checkPaused();
          if (pause === 'abort' || abortFlag.value) {
            return {
              status: 'partial',
              mode: 'frontend',
              applied: writeCount,
              totalOps: ops.length,
              entityIds: writeCount > 0 ? ['e1'] : [],
              done: writeCount > 0 ? ['wrote'] : [],
              undone: ['竞态中止'],
            };
          }
          await Promise.resolve();
          if (abortFlag.value) {
            return {
              status: 'partial',
              mode: 'frontend',
              applied: writeCount,
              totalOps: ops.length,
              entityIds: writeCount > 0 ? ['e1'] : [],
              done: writeCount > 0 ? ['wrote'] : [],
              undone: ['竞态中止'],
            };
          }
          writeCount += 1;
          return {
            status: 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: ops.length,
            entityIds: ['e1'],
            done: ['wrote'],
            undone: [],
          };
        },
      };

      stageManager.registerDriver(driver);

      let hung = 0;
      for (let i = 0; i < CHAOS_ITERS; i++) {
        writeCount = 0;
        abortFlag.value = false;
        const runId = `run-race-${i}`;
        const applyPromise = stageManager.handleBridgeRequest(
          baseReq({
            command: 'apply_ops',
            correlationId: `corr-race-${i}`,
            runId,
            args: {
              target: { typeId: 'acr-chaos-app', resourceId: 'res-chaos' },
              ops: [
                {
                  kind: 'noop',
                  payload: {},
                  destructive: false,
                  label: `op-${i}`,
                },
              ] satisfies AgentOp[],
            },
          }),
        );

        const mode = i % 3;
        if (mode === 0) {
          stageManager.stopRun(runId);
        } else if (mode === 1) {
          queueMicrotask(() => stageManager.stopRun(runId));
        }

        const res = await applyPromise;
        hung += 1;
        expect(res.ok).toBe(true);
        const receipt = res.data as AcrReceipt;
        expect(['completed', 'partial', 'cancelled', 'failed']).toContain(
          receipt.status,
        );
        expect(writeCount).toBeLessThanOrEqual(1);
        const presence = usePresenceStore.getState().byWindow['win-chaos'];
        if (receipt.status === 'completed' || receipt.status === 'partial') {
          // S-REV-02：terminal presence 短时保留供 AgentStrip 撤销；这不是活跃租约。
          expect(presence).toMatchObject({
            runId,
            status: receipt.status === 'completed' ? 'done' : 'aborted',
          });
        } else {
          expect(presence).toBeUndefined();
        }
      }
      expect(hung).toBe(CHAOS_ITERS);

      // 租约未泄漏：同窗可再申请
      const leaseCheck = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          correlationId: 'corr-lease-final',
          runId: 'run-lease-final',
          args: {
            target: { typeId: 'acr-chaos-app', resourceId: 'res-chaos' },
            ops: [
              {
                kind: 'noop',
                payload: {},
                destructive: false,
                label: 'lease-check',
              },
            ],
          },
        }),
      );
      if (!leaseCheck.ok) {
        const err = JSON.parse(leaseCheck.error!);
        expect(err.code).not.toBe(ACR_ERROR_CODES.WINDOW_BUSY);
      } else {
        expect((leaseCheck.data as AcrReceipt).status).toBeDefined();
        expect(usePresenceStore.getState().byWindow['win-chaos']?.runId).toBe(
          'run-lease-final',
        );
      }
      resetStageManagerForTests();
      expect(usePresenceStore.getState().byWindow['win-chaos']).toBeUndefined();
    }, 120_000);
  });

  describe('桥超时注入', () => {
    it('前端模拟超时：挂起 apply 被 stop 后回执可行动且 presence 清空', async () => {
      let resolveApply: (() => void) | null = null;
      const abortFlag = { value: false };
      const driver: CollabDriver = {
        typeId: 'acr-chaos-app',
        probe: () => 'clean',
        abort: () => {
          abortFlag.value = true;
          resolveApply?.();
          return {
            status: 'partial',
            mode: 'frontend',
            applied: 0,
            totalOps: 1,
            entityIds: [],
            done: [],
            undone: ['timeout-abort'],
            message: '桥超时注入：已中止',
          };
        },
        async apply(_run) {
          await new Promise<void>((r) => {
            resolveApply = r;
          });
          // stop/abort 可能在挂起期间触发；以 abortFlag 为准（对齐真实 driver）
          if (abortFlag.value) {
            return {
              status: 'partial',
              mode: 'frontend',
              applied: 0,
              totalOps: 1,
              entityIds: [],
              done: [],
              undone: ['timeout'],
              message: 'ACR bridge timed out — 请改走数据面或缩短 ops',
            };
          }
          return {
            status: 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: 1,
            entityIds: ['e'],
            done: ['ok'],
            undone: [],
          };
        },
      };
      stageManager.registerDriver(driver);

      const p = stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          timeoutMs: 50,
          args: {
            target: { typeId: 'acr-chaos-app', resourceId: 'res-chaos' },
            ops: [
              { kind: 'noop', payload: {}, destructive: false, label: 'slow' },
            ],
          },
        }),
      );

      await vi.waitFor(() => {
        expect(usePresenceStore.getState().byWindow['win-chaos']).toBeDefined();
      });

      // 模拟 Rust 超时后 emit cancel → stopRun（abort 会唤醒挂起）
      stageManager.stopRun('run-chaos');

      const res = await p;
      expect(res.ok).toBe(true);
      const receipt = res.data as AcrReceipt;
      expect(receipt.status).toBe('partial');
      expect(`${receipt.message ?? ''} ${receipt.undone.join(' ')}`).toMatch(
        /timeout|中止/i,
      );
      expect(usePresenceStore.getState().byWindow['win-chaos']).toMatchObject({
        runId: 'run-chaos',
        status: 'aborted',
      });
      resetStageManagerForTests();
      expect(usePresenceStore.getState().byWindow['win-chaos']).toBeUndefined();
      expect(isTransientToolErrorMirror(JSON.stringify(receipt))).toBe(false);
    });

    it('桥超时文案可识别；含 ACR 码 / partial 则不进瞬态自动重试', () => {
      // 纯网络超时 → 可读作瞬态（ReadOnly 工具路径）
      expect(
        isTransientToolErrorMirror('ACR bridge timed out after 3000ms'),
      ).toBe(true);
      // 带 WORKBENCH_UNAVAILABLE / partial → tool_loop 排除（避免双写）
      expect(
        isTransientToolErrorMirror(
          JSON.stringify({
            code: 'WORKBENCH_UNAVAILABLE',
            message: 'ACR bridge timed out after 3000ms',
            hint: '改走领域工具',
            retryable: true,
          }),
        ),
      ).toBe(false);
      expect(isTransientToolErrorMirror('status=partial done/undone')).toBe(
        false,
      );
    });
  });

  describe('driver 抛异常 → failed + 清 presence', () => {
    it('apply throw → failed 回执、abort 被调用、presence/租约清理', async () => {
      const abort = vi.fn((): AcrReceipt => ({
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 1,
        entityIds: [],
        done: [],
        undone: ['abort'],
      }));
      const driver: CollabDriver = {
        typeId: 'acr-chaos-app',
        probe: () => 'clean',
        abort,
        async apply() {
          throw new Error('driver boom');
        },
      };
      stageManager.registerDriver(driver);

      const res = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          args: {
            target: { typeId: 'acr-chaos-app', resourceId: 'res-chaos' },
            ops: [
              { kind: 'noop', payload: {}, destructive: false, label: 'boom' },
            ],
          },
        }),
      );

      expect(res.ok).toBe(true);
      const receipt = res.data as AcrReceipt;
      expect(receipt.status).toBe('failed');
      expect(receipt.message).toMatch(/driver boom/);
      expect(abort).toHaveBeenCalledWith('run-chaos');
      expect(usePresenceStore.getState().byWindow['win-chaos']).toBeUndefined();

      const again = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'apply_ops',
          correlationId: 'corr-2',
          runId: 'run-2',
          args: {
            target: { typeId: 'acr-chaos-app', resourceId: 'res-chaos' },
            ops: [
              { kind: 'noop', payload: {}, destructive: false, label: 'ok' },
            ],
          },
        }),
      );
      expect(again.ok).toBe(true);
      expect((again.data as AcrReceipt).status).toBe('failed');
    });
  });

  describe('连续 partial 后重试不误杀 doom-loop', () => {
    it('同参连续 ≥3 拦截；改参（partial 后续）重置计数可执行', () => {
      const guard = new DoomLoopGuardMirror();
      const tool = 'builtin-workbench_apply_ops';
      const sameArgs = {
        target: { typeId: 'todo' },
        ops: [{ kind: 'todo_show_list' }],
      };

      expect(guard.observe(tool, sameArgs)).toBe('execute');
      expect(guard.observe(tool, sameArgs)).toBe('execute');
      expect(guard.observe(tool, sameArgs)).toBe('skip');
      expect(guard.observe(tool, sameArgs)).toBe('skip');
      expect(guard.observe(tool, sameArgs)).toBe('abort');

      const nextArgs = {
        target: { typeId: 'todo' },
        ops: [{ kind: 'todo_show_list', payload: { listId: 'list-b' } }],
      };
      const guard2 = new DoomLoopGuardMirror();
      expect(guard2.observe(tool, sameArgs)).toBe('execute');
      expect(guard2.observe(tool, sameArgs)).toBe('execute');
      expect(guard2.observe(tool, nextArgs)).toBe('execute');
      expect(guard2.observe(tool, nextArgs)).toBe('execute');
      expect(guard2.observe(tool, nextArgs)).toBe('skip');
    });

    it('partial 回执文本不会被当成瞬态错误自动重试', () => {
      expect(
        isTransientToolErrorMirror(
          JSON.stringify({
            status: 'partial',
            done: ['已切换清单'],
            undone: ['未创建项'],
            message: '用户打断，请根据 done/undone 继续',
          }),
        ),
      ).toBe(false);
    });
  });

  describe('幂等：AgentOp 重放 / revert 两次', () => {
    it('fsrs_enqueue 重放同 cardId 不重复入队', async () => {
      useFsrsReviewStore.setState({
        screen: 'session',
        queue: [card('a')],
        queueIndex: 0,
        flipped: false,
        loading: false,
        ratingBusy: false,
        usingMock: true,
        error: null,
        lastRated: null,
        dueCards: [],
      });

      const runCtx = (runId: string): AcrRunContext => ({
        runId,
        sessionId: 's',
        target: { typeId: 'flashcards' },
        windowId: 'win-fc',
        pacing: makePacer(),
        reportProgress: vi.fn(),
        checkPaused: async () => 'resume',
        ledger: makeLedger(),
      });

      const op: AgentOp = {
        kind: 'fsrs_enqueue',
        payload: { cards: [card('b'), card('a')] },
        destructive: false,
        label: '入队',
      };

      const r1 = await fsrsDriver.apply(runCtx('run-fc-1'), [op]);
      expect(r1.status).toBe('completed');
      expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual([
        'a',
        'b',
      ]);

      const r2 = await fsrsDriver.apply(runCtx('run-fc-2'), [op]);
      expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual([
        'a',
        'b',
      ]);
      expect(r2.applied).toBe(0);
      expect(r2.status).toBe('failed');
    });

    it('todo_show_list 重放幂等（仅导航，不造实体）', async () => {
      const op: AgentOp = {
        kind: 'todo_show_list',
        payload: { listId: 'list-1' },
        destructive: false,
        label: '切清单',
      };
      const ctx = (id: string): AcrRunContext => ({
        runId: id,
        sessionId: 's',
        target: { typeId: 'todo' },
        windowId: null,
        pacing: makePacer(),
        reportProgress: vi.fn(),
        checkPaused: async () => 'resume',
        ledger: makeLedger(),
      });

      const a = await todoDriver.apply(ctx('t1'), [op]);
      const b = await todoDriver.apply(ctx('t2'), [op]);
      expect(a.status).toBe('completed');
      expect(b.status).toBe('completed');
      expect(a.entityIds).toEqual(['list-1']);
      expect(b.entityIds).toEqual(['list-1']);
      expect(setActiveList).toHaveBeenCalledTimes(2);
      expect(setActiveList).toHaveBeenNthCalledWith(1, 'list-1');
      expect(setActiveList).toHaveBeenNthCalledWith(2, 'list-1');
    });

    it('revert_run 两次安全：第二次 reverted=false', async () => {
      let inverted = 0;
      runLedger.record(
        'run-rev',
        () => {
          inverted += 1;
        },
        'step',
      );
      runLedger.sealRun('run-rev');

      const first = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'revert_run',
          runId: 'run-rev',
          args: { runId: 'run-rev' },
        }),
      );
      const second = await stageManager.handleBridgeRequest(
        baseReq({
          command: 'revert_run',
          correlationId: 'corr-rev-2',
          runId: 'run-rev',
          args: { runId: 'run-rev' },
        }),
      );

      expect(first.ok).toBe(true);
      expect((first.data as { reverted: boolean }).reverted).toBe(true);
      expect(second.ok).toBe(true);
      expect((second.data as { reverted: boolean }).reverted).toBe(false);
      expect(inverted).toBe(1);
    });
  });
});
