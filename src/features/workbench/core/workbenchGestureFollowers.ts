const SETTLING_ATTR = 'data-wb-settling';
const POST_SETTLE_FRAMES = 2;

export type WorkbenchGestureFollowPhase = 'drag' | 'release' | 'settle';

export interface WorkbenchGestureFrameSignal {
  phase: WorkbenchGestureFollowPhase;
  /** Drag offset from the shell anchor; zero for release/resize. */
  x?: number;
  y?: number;
  /** 发出信号的窗口；带上它时，drag / release 只送给挂在这个窗口里的浮层 */
  windowId?: string;
}

/** 浮层的锚点（触发器、输入栏）：用它所在的窗口判断这次拖拽是不是自己的 */
export type WorkbenchGestureFollowerScope = () => Element | null | undefined;

export type WorkbenchGestureFollower = (signal: WorkbenchGestureFrameSignal) => void;

const followers = new Map<WorkbenchGestureFollower, WorkbenchGestureFollowerScope | undefined>();
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

/**
 * 拖窗口 A 时，窗口 B 里开着的菜单不能跟着动：标题栏的 pointer 处理会吞掉 mousedown，
 * 别的窗口里的菜单不会因为这次按下而关闭。带 windowId 的信号只送给锚点在该窗口里的浮层；
 * 没给锚点的订阅者、settle 信号照旧全量送达。
 */
function followsWindow(scope: WorkbenchGestureFollowerScope | undefined, windowId: string): boolean {
  if (!scope) return true;
  const anchor = scope();
  if (!anchor) return false;
  return anchor.closest('[data-wb-window-id]')?.getAttribute('data-wb-window-id') === windowId;
}

function notifyFollowers(signal: WorkbenchGestureFrameSignal): void {
  for (const [follower, scope] of followers) {
    if (signal.windowId && signal.phase !== 'settle' && !followsWindow(scope, signal.windowId)) continue;
    follower(signal);
  }
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

export function subscribeWorkbenchGestureFrames(
  callback: WorkbenchGestureFollower,
  scope?: WorkbenchGestureFollowerScope,
): () => void {
  followers.set(callback, scope);
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
