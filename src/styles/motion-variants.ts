/**
 * Framer Motion Variants（收敛后）
 *
 * 2026-07 动画体系收敛：原文件 36 个 export 中仅 newMessageVariants
 * 有消费者（src/features/chat/components/MessageList.tsx），其余已删除。
 * CSS 侧动画 token 单一来源见 src/styles/transitions-dev.css。
 */

import type { Variants } from 'framer-motion';

/** 标准 ease-out 曲线（退场用，对齐 --ease-material） */
const easeOut: [number, number, number, number] = [0.4, 0, 0.2, 1];

/**
 * 新消息入场动画 — 纯气泡弹出感
 *
 * 仅缩放 + 淡入，无位移。Discord / iMessage 风格。
 *  - scale: 0.95 → 1（从微缩弹出）
 *  - opacity: 0 → 1
 *  - 快速 spring，干净利落
 */
export const newMessageVariants: Variants = {
  initial: {
    opacity: 0,
    scale: 0.95,
  },
  animate: {
    opacity: 1,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 30,
      mass: 0.8,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: {
      duration: 0.12,
      ease: easeOut,
    },
  },
};
