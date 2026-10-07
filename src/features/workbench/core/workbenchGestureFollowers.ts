const SETTLING_ATTR = 'data-wb-settling';
const POST_SETTLE_FRAMES = 2;

export type WorkbenchGestureFollowPhase = 'drag' | 'release' | 'settle';

export interface WorkbenchGestureFrameSignal {
  phase: WorkbenchGestureFollowPhase;
  /** Drag offset from the shell anchor; zero for release/resize. */
  x?: number;
  y?: number;
}

export type WorkbenchGestureFollower = (signal: WorkbenchGestureFrameSignal) => void;

const followers = new Set<WorkbenchGestureFollower>();
let settleFrameId: number | ReturnType<typeof setTimeout> | null = null;
let settleTrailingFrames = 0;

function isWorkbenchSettleActive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.hasAttribute(SETTLING_ATTR);
}

function requestSettleFrame(callback: () => void): number | ReturnType<typeof setTimeout> {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  if (typeof setTimeout === 'function') return setTimeout(callback, 16);
  return 0;
}

function cancelSettleFrame(handle: number | ReturnType<typeof setTimeout> | null): void {
  if (handle == null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
  else if (typeof clearTimeout === 'function') clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function notifyFollowers(signal: WorkbenchGestureFrameSignal): void {
  for (const follower of followers) follower(signal);
}

function runSettleFrame(): void {
  settleFrameId = null;
  if (followers.size === 0) {
    settleTrailingFrames = 0;
    return;
  }
  if (isWorkbenchSettleActive()) {
    settleTrailingFrames = 0;
    notifyFollowers({ phase: 'settle' });
    settleFrameId = requestSettleFrame(runSettleFrame);
    return;
  }
  if (settleTrailingFrames > 0) {
    settleTrailingFrames -= 1;
    notifyFollowers({ phase: 'settle' });
    if (settleTrailingFrames > 0) {
      settleFrameId = requestSettleFrame(runSettleFrame);
    }
    return;
  }
  notifyFollowers({ phase: 'settle' });
}

function ensureSettleFrameLoop(): void {
  if (settleFrameId != null || typeof window === 'undefined') return;
  settleFrameId = requestSettleFrame(runSettleFrame);
}

let settleRootObserver: MutationObserver | null = null;

function ensureSettleRootObserver(): void {
  if (settleRootObserver || typeof document === 'undefined') return;
  if (typeof MutationObserver !== 'function') return;
  settleRootObserver = new MutationObserver(() => {
    if (followers.size === 0) return;
    if (isWorkbenchSettleActive()) {
      settleTrailingFrames = 0;
      ensureSettleFrameLoop();
    }
  });
  settleRootObserver.observe(document.documentElement, {
    attributeFilter: [SETTLING_ATTR],
  });
}

function startSettleRootObserver(): void {
  if (settleRootObserver || typeof document === 'undefined') return;
  ensureSettleRootObserver();
}

function stopSettleRootObserver(): void {
  settleRootObserver?.disconnect();
  settleRootObserver = null;
}

/**
 * WindowShell calls this after it has written the current gesture frame.
 * Drag followers must be updated synchronously in the same task/frame;
 * a separate rAF would race with the shell rAF and lag by one frame.
 */
export function notifyWorkbenchGestureFrame(signal: WorkbenchGestureFrameSignal): void {
  if (followers.size === 0) return;
  notifyFollowers(signal);
}

export function subscribeWorkbenchGestureFrames(callback: WorkbenchGestureFollower): () => void {
  followers.add(callback);
  startSettleRootObserver();
  if (isWorkbenchSettleActive()) {
    settleTrailingFrames = Math.max(settleTrailingFrames, 1);
    ensureSettleFrameLoop();
  }
  return () => {
    followers.delete(callback);
    if (followers.size > 0) return;
    settleTrailingFrames = 0;
    if (settleFrameId != null) {
      cancelSettleFrame(settleFrameId);
      settleFrameId = null;
    }
    stopSettleRootObserver();
  };
}

export function resetWorkbenchGestureFollowerStateForTests(): void {
  settleTrailingFrames = 0;
  if (settleFrameId != null) {
    cancelSettleFrame(settleFrameId);
    settleFrameId = null;
  }
  stopSettleRootObserver();
}
