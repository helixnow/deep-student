/**
 * useWindowLifecycleAnim（O9）— 窗口进出场动画编排
 *
 * 消费 O11 的 transientPhases：
 *   opening    → 壳挂 data-wb-lifec=opening，animationend 后清除标记
 *   restoring  → 注入 Dock 收敛点 + data-wb-lifec=restoring
 *   minimizing → 注入 Dock 收敛点 + data-wb-lifec=minimizing，结束后才 minimizeWindow
 *   closing    → 壳挂 data-wb-lifec=closing，结束后才 closeWindow
 *
 * 壳元素通过 DOM 定位（`[data-wb-window-id]`），**不改 WindowShell.tsx**。
 * 动画相位用 `data-wb-lifec`（非 classList）：React 受控 className 重算不会剥掉相位。
 *
 * 最小化时序：store.minimizeWindow 会同步把 minimized=true 并 visibility:hidden，
 * 因此真正提交必须延后到 genie 播完。调用方应走 `requestMinimizeAnimated`
 *（先标 'minimizing'）；直接 minimizeWindow 仍即时隐藏（无动画）。
 * 关窗同理走 `requestCloseAnimated`。接线点见 O9.md。
 */
import { useLayoutEffect, useRef } from 'react';
import i18n from 'i18next';
import { getDockIconCenter } from '../components/dockGeometry';
import { confirmWindowClose } from '../core/windowCloseGuard';
import { recomputeLifecycles } from '../core/scheduler';
import {
  useWindowStore,
  useWindowTransientPhase,
} from '../core/windowStore';
import type { WindowTransientPhase } from '../core/types';
import { announceWorkbench } from './useWorkbenchA11y';

/**
 * 历史类名常量（测试/外部兼容）。运行时已改挂 `data-wb-lifec`，
 * CSS 选择器为 `[data-wb-lifec='…']`；此类名不再写入 DOM。
 */
export const LIFEC_CLASS = {
  popIn: 'wb-lifec-pop-in',
  popOut: 'wb-lifec-pop-out',
  genieMin: 'wb-lifec-genie-min',
  genieRestore: 'wb-lifec-genie-restore',
} as const;

/** data-wb-lifec 属性名（React 不管理，免疫 className 覆写） */
export const LIFEC_ATTR = 'data-wb-lifec';

/**
 * 静态兜底上限（ms）：仅在 getComputedStyle 读不到 animationDuration 时使用。
 * 与当前 token 对齐：window-open 220 / window-close 110 / genie 400；倍率约 ×1.7 留余量。
 * 正常路径优先读壳上实际 animationDuration + FALLBACK_SLACK_MS。
 */
const FALLBACK_MS: Record<WindowTransientPhase, number> = {
  opening: 380, // --wb-motion-window-open 220 × ~1.7
  closing: 190, // --wb-motion-window-close 110 × ~1.7
  minimizing: 680, // --wb-motion-genie 400 × ~1.7
  restoring: 680,
};

/** 读到真实时长后再加的余量，覆盖丢 animationend / 舍入 */
const FALLBACK_SLACK_MS = 80;

export function resolveWindowShell(windowId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(windowId)
      : windowId;
  return document.querySelector<HTMLElement>(`[data-wb-window-id="${escaped}"]`);
}

/**
 * 把 Dock 图标中心（视口坐标）换算为相对壳元素的 transform-origin 百分比，
 * 写入 --wb-minimize-origin-x/y。无坐标时回退 fallback
 * （genie 缺省 50% / 130%，向下方收敛；opening 传 50% / 50% 回退中心弹入）。
 */
export function injectMinimizeOrigin(
  shell: HTMLElement,
  typeId: string,
  fallback: { x: string; y: string } = { x: '50%', y: '130%' },
): void {
  const center = getDockIconCenter(typeId);
  const rect = shell.getBoundingClientRect();
  if (!center || rect.width <= 0 || rect.height <= 0) {
    shell.style.setProperty('--wb-minimize-origin-x', fallback.x);
    shell.style.setProperty('--wb-minimize-origin-y', fallback.y);
    return;
  }
  const xPct = ((center.x - rect.left) / rect.width) * 100;
  const yPct = ((center.y - rect.top) / rect.height) * 100;
  shell.style.setProperty('--wb-minimize-origin-x', `${xPct}%`);
  shell.style.setProperty('--wb-minimize-origin-y', `${yPct}%`);
}

function clearLifecAttr(shell: HTMLElement): void {
  shell.removeAttribute(LIFEC_ATTR);
  // 顺带清掉可能残留的旧类名（迁移期 / 热更新）
  shell.classList.remove(
    LIFEC_CLASS.popIn,
    LIFEC_CLASS.popOut,
    LIFEC_CLASS.genieMin,
    LIFEC_CLASS.genieRestore,
  );
}

function phaseLifecValue(phase: WindowTransientPhase): string {
  return phase;
}

/**
 * opening 也注入 Dock 源点：开窗动画从 Dock 图标中心「长出」
 * （无图标时回退窗口中心 scale 弹入）；genie 相位保持向下收敛回退。
 */
function needsDockOrigin(phase: WindowTransientPhase): boolean {
  return phase === 'minimizing' || phase === 'restoring' || phase === 'opening';
}

function dockOriginFallback(phase: WindowTransientPhase): { x: string; y: string } {
  return phase === 'opening' ? { x: '50%', y: '50%' } : { x: '50%', y: '130%' };
}

function parseCssDurationMs(raw: string): number | null {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let max = 0;
  let any = false;
  for (const v of parts) {
    if (v === '0' || v === '0s' || v === '0ms') {
      any = true;
      continue;
    }
    if (v.endsWith('ms')) {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) {
        any = true;
        max = Math.max(max, n);
      }
      continue;
    }
    if (v.endsWith('s')) {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) {
        any = true;
        max = Math.max(max, n * 1000);
      }
      continue;
    }
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) {
      any = true;
      max = Math.max(max, n);
    }
  }
  return any ? max : null;
}

/**
 * 挂上 data-wb-lifec 后读取实际 animationDuration（含 0ms 归零），
 * 再加 slack；读失败则回退 FALLBACK_MS[phase]。
 */
export function resolveLifecFallbackMs(
  shell: HTMLElement,
  phase: WindowTransientPhase,
): number {
  try {
    const dur = parseCssDurationMs(getComputedStyle(shell).animationDuration);
    if (dur != null) return Math.max(0, dur) + FALLBACK_SLACK_MS;
  } catch {
    /* jsdom / 无样式表 */
  }
  return FALLBACK_MS[phase];
}

/**
 * 无编排消费者时的收尾兜底：
 * - 无壳（快捷键单测等）→ 下一帧立即提交；
 * - 有壳 → 略晚于静态 FALLBACK_MS，若 hook 已收尾则 no-op，避免卡死。
 */
function scheduleOrphanPhaseFinish(windowId: string, phase: WindowTransientPhase): void {
  const delay = resolveWindowShell(windowId) ? FALLBACK_MS[phase] + FALLBACK_SLACK_MS : 0;
  const run = () => {
    const store = useWindowStore.getState();
    if (store.transientPhases?.[windowId] !== phase) return;
    finishPhase(windowId, phase);
  };
  if (typeof window === 'undefined') {
    run();
    return;
  }
  window.setTimeout(run, delay);
}

/**
 * 先标 'minimizing'，由 hook 播 genie 后再提交 minimizeWindow。
 * WindowShell / Dock / 快捷键等触发点需改调本函数（O20 接线）。
 */
export function requestMinimizeAnimated(windowId: string): void {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win || win.minimized) return;
  if (store.transientPhases?.[windowId] === 'minimizing') return;
  if (typeof store.setWindowTransient === 'function') {
    store.setWindowTransient(windowId, 'minimizing');
    scheduleOrphanPhaseFinish(windowId, 'minimizing');
    return;
  }
  store.minimizeWindow(windowId, true);
  recomputeLifecycles();
  announceWindowMinimized(win.title);
}

/**
 * canClose 通过后标 'closing'，由 hook 播 pop-out 后再 closeWindow。
 * 标题栏等仍走 workbenchBus 的路径需 O20 改调本函数。
 *
 * Promise 语义（勿混淆）：resolve(true) = 「关窗请求已被接受并开始退场」，
 * **不代表窗口已从 store 移除**——closeWindow + recomputeLifecycles 由
 * finishPhase 在退场动画结束后才提交。调用方在 resolve 后：
 * - 可以做「请求已通过」类的后续（如 ExposeOverlay 标 dissolve）；
 * - 不要立刻假设窗口已消失（如提前重算遮挡——动画期间窗口仍可见）。
 * resolve(false) = canClose 拒绝，未发生任何状态变更。
 * 需要真正关闭时机的调用方请订阅 windowStore（windows[id] 消失）。
 */
export async function requestCloseAnimated(windowId: string): Promise<boolean> {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return true;
  if (store.transientPhases?.[windowId] === 'closing') return true;
  if (!(await confirmWindowClose(windowId))) return false;
  const fresh = useWindowStore.getState();
  if (!fresh.windows[windowId]) return true;
  if (fresh.transientPhases?.[windowId] === 'closing') return true;
  if (typeof fresh.setWindowTransient === 'function') {
    fresh.setWindowTransient(windowId, 'closing');
    scheduleOrphanPhaseFinish(windowId, 'closing');
    return true;
  }
  fresh.closeWindow(windowId);
  recomputeLifecycles();
  announceWindowClosed(win.title);
  return true;
}

/**
 * ⌥+黄灯（P1）：最小化「同应用全部窗口」（含锚点窗自身）。
 *
 * 动画策略：逐窗走既有 genie 路径（requestMinimizeAnimated）。同应用窗口数
 * 通常为个位数，且 genie 期间壳层各自独立合成层、backdrop-filter 已被
 * data-wb-lifec 压制，同播未见性能问题；若未来出现掉帧，可退化为
 * 「锚点窗播 genie、其余经 store.minimizeWindow 直接提交」（store 的
 * batchSetDisplayModes 同款单次 set 思路），此处保持逐窗动画优先观感。
 */
export function requestMinimizeAppWindowsAnimated(windowId: string): void {
  const store = useWindowStore.getState();
  const anchor = store.windows[windowId];
  if (!anchor) return;
  const targets = Object.values(store.windows).filter(
    (win) => win.typeId === anchor.typeId && !win.minimized,
  );
  for (const win of targets) {
    requestMinimizeAnimated(win.id);
  }
}

/**
 * ⌥+红灯（P1）：关闭「同应用全部窗口」。逐窗走 requestCloseAnimated，
 * 尊重每窗 closeGuard——被 canClose 拦下的窗口留在桌面上。
 * 顺序 await（而非并行）：canClose 可能弹未保存确认对话框，并行会同时
 * 弹出多个确认框互相遮挡。
 */
export async function requestCloseAppWindowsAnimated(windowId: string): Promise<void> {
  const store = useWindowStore.getState();
  const anchor = store.windows[windowId];
  if (!anchor) return;
  const ids = Object.values(store.windows)
    .filter((win) => win.typeId === anchor.typeId)
    .map((win) => win.id);
  for (const id of ids) {
    await requestCloseAnimated(id);
  }
}

/**
 * 在 WindowBody（或任意每窗挂载点）调用：订阅该窗 transientPhases 并编排壳动画。
 */
export function useWindowLifecycleAnim(windowId: string): void {
  const phase = useWindowTransientPhase(windowId);
  const runIdRef = useRef(0);

  // useLayoutEffect（非 useEffect）：动画属性必须在首帧绘制前挂上，
  // 否则 opening/restoring 会先以终态闪现一帧再跳回起始 scale 重播（可见顿挫）。
  useLayoutEffect(() => {
    if (!phase) return;

    const shell = resolveWindowShell(windowId);
    if (!shell) {
      // 壳尚未挂载：下一帧再试一次；仍无则直接收尾，避免卡死标记
      const retry = window.setTimeout(() => {
        const el = resolveWindowShell(windowId);
        if (!el) {
          finishPhase(windowId, phase);
        }
      }, 0);
      return () => window.clearTimeout(retry);
    }

    const runId = ++runIdRef.current;
    const lifecValue = phaseLifecValue(phase);
    const win = useWindowStore.getState().windows[windowId];
    if (needsDockOrigin(phase) && win) {
      injectMinimizeOrigin(shell, win.typeId, dockOriginFallback(phase));
    }

    clearLifecAttr(shell);
    // 强制重启动画（同相重复标记时）
    void shell.offsetWidth;
    shell.setAttribute(LIFEC_ATTR, lifecValue);

    const fallbackMs = resolveLifecFallbackMs(shell, phase);

    const onEnd = (event: AnimationEvent) => {
      if (event.target !== shell) return;
      if (runId !== runIdRef.current) return;
      shell.removeEventListener('animationend', onEnd);
      window.clearTimeout(fallbackTimer);
      clearLifecAttr(shell);
      finishPhase(windowId, phase);
    };

    shell.addEventListener('animationend', onEnd);
    const fallbackTimer = window.setTimeout(() => {
      if (runId !== runIdRef.current) return;
      shell.removeEventListener('animationend', onEnd);
      clearLifecAttr(shell);
      finishPhase(windowId, phase);
    }, fallbackMs);

    return () => {
      window.clearTimeout(fallbackTimer);
      shell.removeEventListener('animationend', onEnd);
    };
  }, [windowId, phase]);
}

function announceWindowMinimized(title: string): void {
  announceWorkbench(
    i18n.t('workbench:a11y.windowMinimized', { title }),
  );
}

function announceWindowClosed(title: string): void {
  announceWorkbench(
    i18n.t('workbench:a11y.windowClosed', { title }),
  );
}

function finishPhase(windowId: string, phase: WindowTransientPhase): void {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return;

  if (phase === 'minimizing') {
    const title = win.title;
    // 提交最小化（store 会清 transient）；再重算生命周期
    store.minimizeWindow(windowId, true);
    recomputeLifecycles();
    announceWindowMinimized(title);
    return;
  }

  if (phase === 'closing') {
    const title = win.title;
    store.closeWindow(windowId);
    recomputeLifecycles();
    announceWindowClosed(title);
    return;
  }

  // opening / restoring：只清标记
  store.setWindowTransient?.(windowId, null);
}
