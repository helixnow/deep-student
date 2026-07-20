/**
 * ACR 仲裁状态机 — R1-06 / ACR 4.0
 * 见 docs/dev/acr/DESIGN.md §4.1：acting / pausedByUser(2s 续放, 15s 中止) / aborted。
 * ACR 4.0：进入 pausedByUser 时通过 onPauseChange 携带 abortDeadline（自动中止时刻，
 * epoch ms）与 explicit（是否显式暂停，可续放），供 StageManager 写入 presence。
 */
export type ArbitrationDecision = 'resume' | 'abort';

/** ACR 4.0：onPauseChange 附带的暂停元信息 */
export interface ArbitrationPauseMeta {
  /** 15s 自动中止时刻（epoch ms）；恢复 acting 后为 null */
  abortDeadline: number | null;
  /** 是否显式暂停（AgentStrip pause）——显式暂停可由用户续放 */
  explicit: boolean;
}

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
  /** ACR 4.0：当前暂停周期的自动中止时刻（epoch ms）；未暂停为 null */
  readonly abortDeadline: number | null;
}

const RESUME_IDLE_MS = 2000;
const ABORT_AFTER_MS = 15000;

export function createArbitrator(opts: {
  onPauseChange?: (paused: boolean, meta: ArbitrationPauseMeta) => void;
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
  /** ACR 4.0：本轮暂停的自动中止时刻；abort 计时器存续期间有效 */
  let abortDeadlineAt: number | null = null;
  let pending: ((decision: ArbitrationDecision) => void) | null = null;
  /** 同一暂停周期内多次 checkPaused 共享同一 Promise */
  let pendingPromise: Promise<ArbitrationDecision> | null = null;

  const notifyPause = (next: boolean) => {
    if (paused === next) return;
    paused = next;
    opts.onPauseChange?.(paused, {
      abortDeadline: abortDeadlineAt,
      explicit: explicitHold,
    });
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
    abortDeadlineAt = null;
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
    // 首次进入 paused 时启动 15s abort；后续输入不重置。
    // deadline 必须先于 notifyPause 计算，onPauseChange 的 meta 才拿得到。
    if (!wasPaused) {
      clearAbortTimer();
      abortDeadlineAt = Date.now() + abortAfterMs;
      abortTimer = setTimeout(() => {
        abortTimer = null;
        abortDeadlineAt = null;
        clearResumeTimer();
        explicitHold = false;
        notifyPause(false);
        resolvePending('abort');
      }, abortAfterMs);
    }
    notifyPause(true);
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

    get abortDeadline() {
      return abortDeadlineAt;
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
