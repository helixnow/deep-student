/**
 * shellGestureFlags — OS 模式拖/缩/settle 全局旗 + 内容暂停
 *
 * `<html data-wb-dragging>`：壳层跟手或 settle 桥接期。
 * `<html data-wb-settling>`：平铺 FLIP 进行中。
 *
 * ANTI-REGRESSION：
 * - data-wb-dragging 必须 pointerdown **同步**挂上（CSS / imperative 立刻可读）。
 * - per-host `data-wb-render-paused` **禁止**与 pointerdown 同栈 flush：
 *   querySelectorAll + N 次 setAttribute 会在设置等重窗上触发整树 style，
 *   正是 arm 150–200ms 的主因之一。动画暂停优先走 `:root[data-wb-dragging]`；
 *   per-host attr 与 scheduler 一样双 rAF 后补。
 * - scheduler hint 刷新禁止在起拖路径调用。
 */
import { beginSchedulerDragActivity } from './scheduler';

const DRAGGING_ATTR = 'data-wb-dragging';
const SETTLING_ATTR = 'data-wb-settling';
export const WB_RENDER_PAUSED_ATTR = 'data-wb-render-paused';

/**
 * 可被暂停的重内容宿主（禁止通配 *）。
 * 故意不含 settings：跟手期 setAttribute(data-wb-render-paused) 会弄脏其合成层；
 * 设置窗动画暂停只走 `:root[data-wb-dragging] [data-wb-settings-host]` CSS。
 */
const HEAVY_HOST_SELECTOR = [
  '[data-wb-content-host]',
  '[data-wb-mindmap-host]',
  '.wb-files-host',
  '[data-wb-chat-session]',
  '[data-wb-browser-chrome]',
].join(',');

/** 松手 → settle 启动之间的桥接上限 */
const SETTLE_BRIDGE_MS = 120;

let shellGestureDepth = 0;
let shellGestureEnterGen = 0;
let settlingDepth = 0;
let releaseDragSchedulerActivity: (() => void) | null = null;
let settleBridgeTimer: ReturnType<typeof setTimeout> | 0 = 0;

function setAttr(name: string, on: boolean): void {
  if (typeof document === 'undefined') return;
  if (on) document.documentElement.setAttribute(name, '');
  else document.documentElement.removeAttribute(name);
}

/**
 * 给重内容宿主挂/摘 paused。
 * 起拖路径必须延后调用；settle / 测试 / 松手清理可同步。
 */
export function flushHeavyContentPause(paused: boolean): void {
  if (typeof document === 'undefined') return;
  const nodes = document.querySelectorAll(HEAVY_HOST_SELECTOR);
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    if (paused) el.setAttribute(WB_RENDER_PAUSED_ATTR, '');
    else el.removeAttribute(WB_RENDER_PAUSED_ATTR);
  }
}

function clearSettleBridgeTimer(): void {
  if (settleBridgeTimer) {
    clearTimeout(settleBridgeTimer);
    settleBridgeTimer = 0;
  }
}

function releaseSchedulerIfIdle(): void {
  if (shellGestureDepth > 0 || settlingDepth > 0) return;
  releaseDragSchedulerActivity?.();
  releaseDragSchedulerActivity = null;
  setAttr(DRAGGING_ATTR, false);
  setAttr(SETTLING_ATTR, false);
  flushHeavyContentPause(false);
}

export function isShellGestureActive(): boolean {
  return shellGestureDepth > 0 || settlingDepth > 0;
}

export function isShellDraggingAttr(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute(DRAGGING_ATTR);
}

export function isShellSettlingAttr(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute(SETTLING_ATTR);
}

export function shouldPauseHeavyContent(): boolean {
  return isShellDraggingAttr() || isShellSettlingAttr() || isShellGestureActive();
}

export function enterShellGestureGlobal(): void {
  shellGestureDepth += 1;
  if (shellGestureDepth !== 1) return;

  clearSettleBridgeTimer();
  // 只做廉价根旗；重内容 flush / scheduler 深度一律双 rAF 后
  setAttr(DRAGGING_ATTR, true);

  const gen = ++shellGestureEnterGen;
  const armDeferred = () => {
    if (gen !== shellGestureEnterGen || shellGestureDepth === 0) return;
    flushHeavyContentPause(true);
    if (!releaseDragSchedulerActivity) {
      releaseDragSchedulerActivity = beginSchedulerDragActivity({ refreshHints: false });
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      requestAnimationFrame(armDeferred);
    });
  } else {
    armDeferred();
  }
}

export function leaveShellGestureGlobal(): void {
  shellGestureDepth = Math.max(0, shellGestureDepth - 1);
  if (shellGestureDepth !== 0) return;
  shellGestureEnterGen += 1;

  clearSettleBridgeTimer();
  settleBridgeTimer = setTimeout(() => {
    settleBridgeTimer = 0;
    if (settlingDepth === 0 && shellGestureDepth === 0) {
      releaseSchedulerIfIdle();
    }
  }, SETTLE_BRIDGE_MS);
}

export function beginShellSettling(): void {
  clearSettleBridgeTimer();
  settlingDepth += 1;
  setAttr(SETTLING_ATTR, true);
  setAttr(DRAGGING_ATTR, true);
  flushHeavyContentPause(true);
  if (!releaseDragSchedulerActivity) {
    releaseDragSchedulerActivity = beginSchedulerDragActivity({ refreshHints: false });
  }
}

export function endShellSettling(): void {
  settlingDepth = Math.max(0, settlingDepth - 1);
  if (settlingDepth !== 0) return;
  setAttr(SETTLING_ATTR, false);
  if (shellGestureDepth === 0) {
    releaseSchedulerIfIdle();
  }
}

export function resetShellGestureFlagsForTests(): void {
  clearSettleBridgeTimer();
  shellGestureDepth = 0;
  shellGestureEnterGen = 0;
  settlingDepth = 0;
  releaseDragSchedulerActivity?.();
  releaseDragSchedulerActivity = null;
  setAttr(DRAGGING_ATTR, false);
  setAttr(SETTLING_ATTR, false);
  flushHeavyContentPause(false);
}
