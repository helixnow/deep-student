/**
 * ACR pomodoro Driver — R1-16
 *
 * 纯前端驱动：probe 恒 clean；apply 直调 usePomodoroStore。
 * strictMode 下专注中拒绝 pause：该 op 进 undone，receipt.message 带结构化码。
 *
 * 设计：docs/dev/acr/DESIGN.md §5.5
 */
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import type {
  AcrReceipt,
  AcrRunContext,
  AgentOp,
  AcrTarget,
  CollabDriver,
  StageManagerApi,
} from '../types';
import { ACR_ERROR_CODES } from '../types';
import { withUserPatch } from '../userPatch';

const TYPE_ID = 'pomodoro';

const STRICT_MODE_HINT = '严格模式下专注中不可暂停';

async function flushRecords(): Promise<void> {
  await usePomodoroStore.getState().flushPendingRecords();
}

function strictModeBlocksPause(): boolean {
  const { settings, mode, status } = usePomodoroStore.getState();
  return Boolean(settings.strictMode && mode === 'work' && status === 'running');
}

function payloadTask(payload: unknown): { taskId?: string; taskTitle?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as { taskId?: unknown; taskTitle?: unknown };
  return {
    taskId: typeof p.taskId === 'string' ? p.taskId : undefined,
    taskTitle: typeof p.taskTitle === 'string' ? p.taskTitle : undefined,
  };
}

function controlStateChanged(
  before: ReturnType<typeof usePomodoroStore.getState>,
  after: ReturnType<typeof usePomodoroStore.getState>,
): boolean {
  return (
    before.mode !== after.mode ||
    before.status !== after.status ||
    before.currentTaskId !== after.currentTaskId ||
    before.currentTaskTitle !== after.currentTaskTitle ||
    before.sessionStartTime !== after.sessionStartTime ||
    before.phaseEndsAt !== after.phaseEndsAt ||
    before.phaseStartedAt !== after.phaseStartedAt
  );
}

function emptyReceipt(totalOps: number, status: AcrReceipt['status'] = 'completed'): AcrReceipt {
  return {
    status,
    mode: 'frontend',
    applied: 0,
    totalOps,
    entityIds: [],
    done: [],
    undone: [],
  };
}

interface PendingInverse {
  invert: () => void;
  label: string;
}

interface ActiveRunSnapshot {
  runId: string;
  ops: AgentOp[];
  nextOpIndex: number;
  applied: number;
  totalOps: number;
  done: string[];
  undone: string[];
  pendingInverses: PendingInverse[];
  fullyReversible: boolean;
  inversesCommitted: boolean;
  remainingMarked: boolean;
  aborted: boolean;
  ledger: AcrRunContext['ledger'];
}

const abortSnapshots = new Map<string, ActiveRunSnapshot>();

function commitPendingInverses(state: ActiveRunSnapshot): void {
  if (state.inversesCommitted || !state.fullyReversible) return;
  for (const entry of state.pendingInverses) {
    state.ledger.record(state.runId, entry.invert, entry.label);
  }
  state.inversesCommitted = true;
}

function markRemainingUndone(state: ActiveRunSnapshot): void {
  if (state.remainingMarked) return;
  for (let i = state.nextOpIndex; i < state.ops.length; i++) {
    state.undone.push(state.ops[i].label || state.ops[i].kind);
  }
  state.remainingMarked = true;
}

function cancelledReceipt(state: ActiveRunSnapshot): AcrReceipt {
  markRemainingUndone(state);
  commitPendingInverses(state);
  abortSnapshots.delete(state.runId);
  return withUserPatch(
    {
      status: 'cancelled',
      mode: 'frontend',
      applied: state.applied,
      totalOps: state.totalOps,
      entityIds: [],
      done: [...state.done],
      undone: [...state.undone],
      message: '运行已中止',
    },
    TYPE_ID,
  );
}

export const pomodoroDriver: CollabDriver = {
  typeId: TYPE_ID,

  probe(_target: AcrTarget) {
    // 番茄钟无脏文档概念；开窗与否由 StageManager/probe 模块判定，driver 侧恒 clean
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const done: string[] = [];
    const undone: string[] = [];
    const messages: string[] = [];
    let persistenceFailed = false;
    const totalOps = ops.length;
    const state: ActiveRunSnapshot = {
      runId: run.runId,
      ops,
      nextOpIndex: 0,
      applied: 0,
      totalOps,
      done,
      undone,
      pendingInverses: [],
      fullyReversible: true,
      inversesCommitted: false,
      remainingMarked: false,
      aborted: false,
      ledger: run.ledger,
    };

    abortSnapshots.set(run.runId, state);

    for (let i = 0; i < ops.length; i++) {
      state.nextOpIndex = i;
      let pauseDecision: 'resume' | 'abort';
      try {
        pauseDecision = state.aborted ? 'abort' : await run.checkPaused();
      } catch (err) {
        state.aborted = true;
        state.undone.push(`暂停检查失败（${err instanceof Error ? err.message : String(err)}）`);
        return cancelledReceipt(state);
      }
      if (pauseDecision === 'abort') {
        state.aborted = true;
        return cancelledReceipt(state);
      }

      const op = ops[i];
      const label = op.label || op.kind;
      run.reportProgress(i + 1, totalOps, label);

      try {
        switch (op.kind) {
        case 'pomodoro_start': {
          const before = usePomodoroStore.getState();
          const { taskId, taskTitle } = payloadTask(op.payload);
          usePomodoroStore.getState().start(taskId, taskTitle);
          const after = usePomodoroStore.getState();
          if (!controlStateChanged(before, after)) {
            undone.push(`${label}（当前状态无需启动或恢复）`);
            break;
          }
          done.push(label);
          state.applied += 1;
          if (before.mode === 'idle') {
            state.pendingInverses.push({
              // ACR undo 不是一次真实“中断”，不能写入中断番茄记录。
              invert: () => usePomodoroStore.getState().stop(false),
              label,
            });
          } else {
            state.fullyReversible = false;
          }
          await flushRecords();
          break;
        }
        case 'pomodoro_pause': {
          if (strictModeBlocksPause()) {
            undone.push(label);
            messages.push(
              JSON.stringify({
                code: ACR_ERROR_CODES.STRICT_MODE,
                hint: STRICT_MODE_HINT,
              }),
            );
            break;
          }
          const beforeStatus = usePomodoroStore.getState().status;
          usePomodoroStore.getState().pause();
          if (usePomodoroStore.getState().status === beforeStatus) {
            undone.push(`${label}（当前状态不可暂停）`);
            break;
          }
          done.push(label);
          state.applied += 1;
          if (
            beforeStatus === 'running' &&
            usePomodoroStore.getState().status === 'paused'
          ) {
            state.pendingInverses.push({
              invert: () => usePomodoroStore.getState().resume(),
              label,
            });
          }
          break;
        }
        case 'pomodoro_resume': {
          const beforeStatus = usePomodoroStore.getState().status;
          usePomodoroStore.getState().resume();
          if (usePomodoroStore.getState().status === beforeStatus) {
            undone.push(`${label}（当前状态无需恢复）`);
            break;
          }
          done.push(label);
          state.applied += 1;
          if (
            beforeStatus === 'paused' &&
            usePomodoroStore.getState().status === 'running'
          ) {
            state.pendingInverses.push({
              invert: () => usePomodoroStore.getState().pause(),
              label,
            });
          }
          break;
        }
        case 'pomodoro_stop': {
          const beforeMode = usePomodoroStore.getState().mode;
          usePomodoroStore.getState().stop(true);
          if (usePomodoroStore.getState().mode === beforeMode) {
            undone.push(`${label}（当前未运行番茄钟）`);
            break;
          }
          done.push(label);
          state.applied += 1;
          if (beforeMode !== 'idle') {
            state.fullyReversible = false;
            state.pendingInverses.length = 0;
          }
          await flushRecords();
          break;
        }
        default: {
          undone.push(label);
          messages.push(`不支持的 pomodoro op: ${op.kind}`);
          break;
        }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        persistenceFailed = true;
        messages.push(`后端记录保存失败: ${detail}`);
      }

      state.nextOpIndex = i + 1;
      try {
        await run.pacing.tick();
      } catch (err) {
        state.aborted = true;
        messages.push(
          `节奏控制失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        return cancelledReceipt(state);
      }
    }

    if (state.aborted) return cancelledReceipt(state);

    abortSnapshots.delete(run.runId);
    commitPendingInverses(state);

    let status: AcrReceipt['status'] = persistenceFailed ? 'partial' : 'completed';
    if ((undone.length > 0 || persistenceFailed) && state.applied === 0) {
      status = 'failed';
    } else if (undone.length > 0) {
      status = 'partial';
    }

    return {
      status,
      mode: 'frontend',
      applied: state.applied,
      totalOps,
      entityIds: [],
      done,
      undone,
      message: messages.length > 0 ? messages.join('\n') : undefined,
    };
  },

  abort(runId: string): AcrReceipt {
    const snap = abortSnapshots.get(runId);
    if (!snap) {
      return withUserPatch(emptyReceipt(0, 'cancelled'), TYPE_ID);
    }
    snap.aborted = true;
    return cancelledReceipt(snap);
  },
};

export function registerPomodoroDriver(stage: StageManagerApi): void {
  stage.registerDriver(pomodoroDriver);
}
