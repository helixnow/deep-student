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
 * 与当前 token 对齐：standard 280 / quick 150 / genie 480；倍率约 ×1.7 留余量。
 * 正常路径优先读壳上实际 animationDuration + FALLBACK_SLACK_MS。
 */
const FALLBACK_MS: Record<WindowTransientPhase, number> = {
  opening: 480, // --wb-motion-standard 280 × ~1.7
  closing: 260, // --wb-motion-quick 150 × ~1.7
  minimizing: 820, // --wb-motion-genie 480 × ~1.7
  restoring: 820,
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
 * 写入 --wb-minimize-origin-x/y。无坐标时回退 50% / 130%（向下方收敛）。
 */
export function injectMinimizeOrigin(shell: HTMLElement, typeId: string): void {
  const center = getDockIconCenter(typeId);
  const rect = shell.getBoundingClientRect();
  if (!center || rect.width <= 0 || rect.height <= 0) {
    shell.style.setProperty('--wb-minimize-origin-x', '50%');
    shell.style.setProperty('--wb-minimize-origin-y', '130%');
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

function needsDockOrigin(phase: WindowTransientPhase): boolean {
  return phase === 'minimizing' || phase === 'restoring';
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
      injectMinimizeOrigin(shell, win.typeId);
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
    i18n.t('workbench:a11y.windowMinimized', {
      title,
      defaultValue: `${title} 已最小化`,
    }),
  );
}

function announceWindowClosed(title: string): void {
  announceWorkbench(
    i18n.t('workbench:a11y.windowClosed', {
      title,
      defaultValue: `已关闭 ${title}`,
    }),
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
