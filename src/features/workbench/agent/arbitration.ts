/**
 * ACR 仲裁状态机 — R1-06
 * 见 docs/dev/acr/DESIGN.md §4.1：acting / pausedByUser(2s 续放, 15s 中止) / aborted。
 */
export type ArbitrationDecision = 'resume' | 'abort';

export interface Arbitrator {
  /** driver 每 op 之间调用 */
  checkPaused(): Promise<ArbitrationDecision>;
  /** 用户输入命中目标窗 */
  onUserInput(): void;
  /** AgentStrip 显式暂停/停止 */
  pause(): void;
  /** R3-01：显式续放（hot 等待结束 / AgentStrip 续放） */
  resume(): void;
  stop(): void;
  dispose(): void;
  readonly paused: boolean;
}

const RESUME_IDLE_MS = 2000;
const ABORT_AFTER_MS = 15000;

export function createArbitrator(opts: {
  onPauseChange?: (paused: boolean) => void;
  /** 无新输入自动续放（默认 2s） */
  resumeIdleMs?: number;
  /** 持续 paused 后中止（默认 15s） */
  abortAfterMs?: number;
}): Arbitrator {
  const resumeIdleMs = opts.resumeIdleMs ?? RESUME_IDLE_MS;
  const abortAfterMs = opts.abortAfterMs ?? ABORT_AFTER_MS;

  let paused = false;
  /** 显式 pause：不启动 2s 自动续放，仍受 15s abort 约束 */
  let explicitHold = false;
  let disposed = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let abortTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: ((decision: ArbitrationDecision) => void) | null = null;
  /** 同一暂停周期内多次 checkPaused 共享同一 Promise */
  let pendingPromise: Promise<ArbitrationDecision> | null = null;

  const notifyPause = (next: boolean) => {
    if (paused === next) return;
    paused = next;
    opts.onPauseChange?.(paused);
  };

  const clearResumeTimer = () => {
    if (resumeTimer != null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  };

  const clearAbortTimer = () => {
    if (abortTimer != null) {
      clearTimeout(abortTimer);
      abortTimer = null;
    }
  };

  const resolvePending = (decision: ArbitrationDecision) => {
    const resolve = pending;
    pending = null;
    pendingPromise = null;
    if (resolve) resolve(decision);
  };

  const enterPaused = (explicit: boolean) => {
    if (disposed) return;
    explicitHold = explicit;
    const wasPaused = paused;
    notifyPause(true);
    // 首次进入 paused 时启动 15s abort；后续输入不重置
    if (!wasPaused) {
      clearAbortTimer();
      abortTimer = setTimeout(() => {
        abortTimer = null;
        clearResumeTimer();
        notifyPause(false);
        explicitHold = false;
        resolvePending('abort');
      }, abortAfterMs);
    }
    // 用户输入路径：重置 2s 续放；显式 pause 不自动续放
    clearResumeTimer();
    if (!explicitHold) {
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        clearAbortTimer();
        notifyPause(false);
        explicitHold = false;
        resolvePending('resume');
      }, resumeIdleMs);
    }
  };

  return {
    get paused() {
      return paused;
    },

    async checkPaused() {
      if (disposed) return 'abort';
      if (!paused) return 'resume';
      if (pendingPromise) return pendingPromise;
      pendingPromise = new Promise<ArbitrationDecision>((resolve) => {
        pending = resolve;
      });
      return pendingPromise;
    },

    onUserInput() {
      if (disposed) return;
      // A user gesture must not downgrade an explicit operator hold into the
      // 2-second auto-resume path. Only resume() may release an explicit pause.
      enterPaused(explicitHold);
    },

    pause() {
      if (disposed) return;
      enterPaused(true);
    },

    resume() {
      if (disposed) return;
      if (!paused) return;
      clearResumeTimer();
      clearAbortTimer();
      notifyPause(false);
      explicitHold = false;
      resolvePending('resume');
    },

    stop() {
      if (disposed) return;
      clearResumeTimer();
      clearAbortTimer();
      notifyPause(false);
      explicitHold = false;
      resolvePending('abort');
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearResumeTimer();
      clearAbortTimer();
      notifyPause(false);
      explicitHold = false;
      resolvePending('abort');
    },
  };
}
