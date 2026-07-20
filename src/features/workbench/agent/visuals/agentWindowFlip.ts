/**
 * ACR 4.1：agent 驱动窗口编排的 FLIP 动画（move/resize/snap/tile）。
 *
 * 问题：desktop 虚拟目标的布局能力直写 windowStore，窗口瞬间跳位——
 * agent「整理桌面」在用户眼里是硬切。
 *
 * 手法（FLIP，纪律合规）：
 * - 布局属性（left/top/width/height）永不参与动画：store 更新后 DOM 已在终态；
 * - 记录更新前 rect，双 rAF 等 React 落位后测终态 rect，
 *   用 WAAPI 从「旧位姿的 transform 反推」播放到 identity——纯 transform，合成层；
 * - 位移用 translate，尺寸变化用 scale（transform-origin: top left，
 *   与 translate 联立即为旧 rect → 新 rect 的仿射映射）；
 * - prefers-reduced-motion → 直接跳过（保持瞬切）；
 * - 同窗新动画开始前取消旧 FLIP（id 标记）；用户正在拖拽的窗口跳过。
 *
 * 只作为装饰层：动画失败/元素缺失一律安全 no-op，不影响回执语义。
 */

const FLIP_ANIMATION_ID = 'acr-window-flip';
const MOVE_MS = 300;
const MORPH_MS = 340;
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** 低于该位移/尺寸差（px）不值得播动画 */
const MIN_DELTA_PX = 2;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function findWindowEl(windowId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const esc =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(windowId)
      : windowId.replace(/["\\]/g, '\\$&');
  return document.querySelector<HTMLElement>(`[data-wb-window-id="${esc}"]`);
}

function measure(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function cancelExistingFlip(el: HTMLElement): void {
  if (typeof el.getAnimations !== 'function') return;
  for (const anim of el.getAnimations()) {
    if (anim.id === FLIP_ANIMATION_ID) anim.cancel();
  }
}

function playFlip(el: HTMLElement, from: Rect): void {
  if (typeof el.animate !== 'function') return;
  // 用户拖拽/缩放跟手期不叠加 FLIP（跟手 transform 优先）
  if (el.classList.contains('wb-shell-dragging') || el.classList.contains('wb-shell-resizing')) {
    return;
  }
  const to = measure(el);
  if (to.w <= 0 || to.h <= 0 || from.w <= 0 || from.h <= 0) return;

  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const sx = from.w / to.w;
  const sy = from.h / to.h;
  const moved = Math.abs(dx) >= MIN_DELTA_PX || Math.abs(dy) >= MIN_DELTA_PX;
  const resized = Math.abs(from.w - to.w) >= MIN_DELTA_PX || Math.abs(from.h - to.h) >= MIN_DELTA_PX;
  if (!moved && !resized) return;

  cancelExistingFlip(el);
  const fromTransform = resized
    ? `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
    : `translate(${dx}px, ${dy}px)`;
  try {
    const anim = el.animate(
      [
        { transformOrigin: 'top left', transform: fromTransform },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      {
        duration: resized ? MORPH_MS : MOVE_MS,
        easing: EASE_OUT,
        composite: 'replace',
      },
    );
    anim.id = FLIP_ANIMATION_ID;
  } catch {
    // WAAPI 不可用（旧 WebView / jsdom）：保持瞬切
  }
}

/**
 * 记录一组窗口当前位姿，返回「落位后调用」的播放函数。
 *
 * 用法（desktop manifest 布局能力内）：
 *   const play = captureWindowFlip([windowId]);
 *   store.moveWindow(...); // 布局直写
 *   play();                // ACK 校验后触发（内部双 rAF 等 React 落位）
 */
export function captureWindowFlip(windowIds: readonly string[]): () => void {
  if (prefersReducedMotion()) return () => {};
  const before = new Map<string, { el: HTMLElement; rect: Rect }>();
  for (const id of windowIds) {
    const el = findWindowEl(id);
    if (el) before.set(id, { el, rect: measure(el) });
  }
  if (before.size === 0) return () => {};

  return () => {
    if (typeof requestAnimationFrame !== 'function') return;
    // 双 rAF：等 React commit + 布局稳定后再测终态
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const { el, rect } of before.values()) {
          // 窗口可能在间隙被关闭/最小化
          if (!el.isConnected) continue;
          playFlip(el, rect);
        }
      });
    });
  };
}
