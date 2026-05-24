/**
 * useSmoothWheel — 给鼠标滚轮加上"惯性 / 缓动"手感
 *
 * 浏览器原生不会对鼠标滚轮做平滑。CSS `scroll-behavior: smooth` 也只
 * 影响编程滚动（scrollTo/scrollIntoView 等），对用户滚轮无效。
 *
 * 本 hook 拦截鼠标滚轮事件，把 deltaY 累加到一个目标 scrollTop，再用
 * rAF 把当前 scrollTop 缓动逼近目标，从而获得 Notion / VSCode 那种顺滑感。
 *
 * 设计要点：
 * 1. 仅拦截"鼠标滚轮"，不动触控板。
 *    macOS 触控板的 momentum 来自系统层，再加一层 JS 缓动会变粘且漂移。
 * 2. iOS WebView 直接退出（保留原生橡皮筋 + inertia）。
 * 3. 边界处不拦截，允许浏览器/父级处理 overscroll。
 * 4. 与外部 scrollTop 改写（ResizeObserver 跟底、scrollToBottom）协作：
 *    若检测到外部改写，重置 target 避免被拽回。
 * 5. passive: false（必须 preventDefault）。但事件不停止传播，已有的
 *    "向上滚释放粘底"监听仍然能收到。
 */

import { useEffect, useRef } from 'react';
import { detectScrollPlatform } from '@/lib/scroll-platform';

export interface SmoothWheelOptions {
  /** 缓动系数 0..1，越大越接近原生（snappy）。默认 0.2。 */
  intensity?: number;
  /** 关闭开关。iOS 永远视为关闭。默认 true。 */
  enabled?: boolean;
  /** 用户向上滚（释放粘底等场景）回调。 */
  onUserScrollUp?: () => void;
  /**
   * 解析真正可滚动元素。OverlayScrollbars 场景下 host !== viewport，
   * 调用方需返回真实 viewport（[data-overlayscrollbars-viewport]）。
   * 不传时退化为 hostElement 自身或其内 viewport。
   */
  getScrollElement?: () => HTMLElement | null;
}

/**
 * 仅拦截鼠标滚轮，触控板放行。
 *
 * macOS 触控板的 momentum 来自系统层，不应被 JS 二次缓动。
 *
 * 判定策略（Tauri WKWebView / Chromium 均适用）：
 *   1. deltaMode != 0（行/页模式）→ 必然是滚轮
 *   2. wheelDeltaY 是 120 的整数倍 → 标准鼠标滚轮（每格 120）
 *   3. 兜底：deltaY 是整数且绝对值 >= 10 → 鼠标（触控板 deltaY 几乎都是小数）
 *
 * 注意：macOS 开启"平滑滚动"时，一格鼠标滚轮可能被系统拆成多个小事件，
 * 此时 wheelDeltaY 可能不是 120 的倍数，兜底规则会捕获这些事件。
 */
function isMouseWheel(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return true;
  const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof wd === 'number' && wd !== 0) {
    if (Math.abs(wd) % 120 === 0) return true;
  }
  // 兜底：触控板 deltaY 几乎都是小数（如 3.14、7.5），鼠标是整数
  return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 10;
}

export function useSmoothWheel(
  hostElement: HTMLElement | null,
  options: SmoothWheelOptions = {},
): void {
  const {
    intensity = 0.2,
    enabled = true,
    onUserScrollUp,
    getScrollElement,
  } = options;

  // 通过 ref 把可变选项带进闭包，避免每次值变都重挂监听
  const optsRef = useRef({ intensity, onUserScrollUp, getScrollElement });
  optsRef.current = { intensity, onUserScrollUp, getScrollElement };

  useEffect(() => {
    if (!enabled || !hostElement) return;

    const platform = detectScrollPlatform();
    if (platform.preferNativeScrollbars) return;

    const resolveScrollEl = (): HTMLElement | null => {
      const custom = optsRef.current.getScrollElement?.();
      if (custom) return custom;
      const inner = hostElement.querySelector<HTMLElement>(
        '[data-overlayscrollbars-viewport]',
      );
      return inner ?? hostElement;
    };

    let target = 0;
    let lastApplied = 0;
    let rafId = 0;
    let active = false;

    const stop = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      active = false;
    };

    const tick = () => {
      const el = resolveScrollEl();
      if (!el) {
        stop();
        return;
      }
      // 外部改写检测：与上一帧写入差 > 1 视为外部介入，对齐到当前位置
      if (Math.abs(el.scrollTop - lastApplied) > 1) {
        target = el.scrollTop;
      }
      const max = el.scrollHeight - el.clientHeight;
      if (target < 0) target = 0;
      if (target > max) target = max;

      const cur = el.scrollTop;
      const diff = target - cur;
      if (Math.abs(diff) < 0.5) {
        el.scrollTop = target;
        lastApplied = target;
        stop();
        return;
      }
      const next = cur + diff * optsRef.current.intensity;
      el.scrollTop = next;
      lastApplied = next;
      rafId = requestAnimationFrame(tick);
    };

    const onWheel = (e: WheelEvent) => {
      // 横滚不处理，让浏览器自己来
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const el = resolveScrollEl();
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      if (!isMouseWheel(e)) return; // 触控板：放行原生

      // 边界放行（允许父级 overscroll / 软弹回）
      if (
        (e.deltaY < 0 && el.scrollTop <= 0) ||
        (e.deltaY > 0 && el.scrollTop >= max)
      ) {
        return;
      }

      e.preventDefault();

      if (!active) {
        target = el.scrollTop;
        lastApplied = el.scrollTop;
        active = true;
      }

      target += e.deltaY;
      if (target < 0) target = 0;
      if (target > max) target = max;

      if (e.deltaY < 0) optsRef.current.onUserScrollUp?.();
      if (!rafId) rafId = requestAnimationFrame(tick);
    };

    hostElement.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      hostElement.removeEventListener('wheel', onWheel as EventListener, { capture: true });
      stop();
    };
  }, [hostElement, enabled]);
}
