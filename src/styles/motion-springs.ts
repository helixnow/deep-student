/**
 * motion-springs — 全局 framer-motion 动画预设（单一来源）。
 *
 * 背景：全库多处组件各自手写 spring 参数（400/30、420/28、380/34、350/28、
 * 300/24、160/22 …），手感不一致且无法统一调优。本文件收敛为 4 档语义预设，
 * 后续新代码一律 import 预设，不再手写 stiffness/damping。
 *
 * 与 CSS token 的对应关系（src/styles/transitions-dev.css）：
 * - `tweenFast`  ≈ `--ease-standard` / `--panel-ease`（cubic-bezier(0.22,1,0.36,1)）+ 150ms 档
 * - `springSheet` 视觉节奏对齐 `--panel-open-dur`（400ms 量级的面板入场）
 * - `springSnap` 视觉节奏对齐 `--dropdown-close-dur`（150ms 量级的快速反馈）
 *
 * 接入示例：
 * ```tsx
 * import { motion } from 'framer-motion';
 * import { springSheet, motionSafe } from '@/styles/motion-springs';
 *
 * <motion.div
 *   initial={{ y: 24, opacity: 0 }}
 *   animate={{ y: 0, opacity: 1 }}
 *   transition={motionSafe(springSheet)}
 * />
 * ```
 */

import type { Transition } from 'framer-motion';

/**
 * 快速 UI 反馈（按钮态、图标切换、小元素归位）。
 * 收敛目标：400/30、420/28 等"快弹"参数。约 150–200ms 内落定。
 */
export const springSnap: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};

/**
 * 面板 / 对话框 / 底部 sheet 入场与归位。
 * 收敛目标：380/34、350/28 等"面板弹"参数。略缓于 springSnap，无明显过冲。
 */
export const springSheet: Transition = {
  type: 'spring',
  stiffness: 380,
  damping: 30,
};

/**
 * 列表项重排 / 温和位移（拖拽让位、卡片流）。
 * 收敛目标：300/24、160/22 等"软弹"参数。柔和、允许极轻微过冲。
 */
export const springSoft: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 26,
};

/**
 * 快速 tween（透明度、颜色等不适合 spring 的属性）。
 * 与 CSS `--ease-standard` / `--panel-ease`（cubic-bezier(0.22,1,0.36,1)）
 * 完全同曲线，保证 CSS 过渡与 framer-motion 动画并存时节奏一致。
 */
export const tweenFast: Transition = {
  type: 'tween',
  duration: 0.15,
  ease: [0.22, 1, 0.36, 1],
};

/** reduced-motion 下的替代 transition：立即完成，不产生位移动画。 */
export const transitionInstant: Transition = { duration: 0 };

/**
 * 当前是否处于 prefers-reduced-motion: reduce。
 * 一次性读取（非响应式）；需要响应式请用
 * `useMediaQuery('(prefers-reduced-motion: reduce)')`（src/hooks/useMediaQuery.ts）。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  return Boolean(media?.matches);
}

/**
 * 包一层 reduced-motion 保护：用户偏好减少动态时退化为瞬时完成。
 * 适合在 render 期对单个 transition 使用；整棵子树建议用
 * `<MotionConfig reducedMotion="user">` 一次性处理。
 */
export function motionSafe(transition: Transition): Transition {
  return prefersReducedMotion() ? transitionInstant : transition;
}
