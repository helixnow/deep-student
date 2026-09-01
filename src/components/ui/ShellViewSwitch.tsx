import React from 'react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import { cn } from '@/lib/utils';

type ShellViewSwitchProps = {
  viewKey: string;
  /**
   * 导航方向：1 = 前进（新页自右滑入、旧页向左滑出），-1 = 后退（镜像）。
   * 经 AnimatePresence 的 custom 传递，退出中的旧页会拿到「当前」方向而不是
   * 它挂载时的旧方向，因此前进/后退互为镜像。平级切换省略（默认 1）。
   */
  direction?: 1 | -1;
  className?: string;
  children: React.ReactNode;
};

const SLIDE_PX = 8;

// Duration/easing 与 `--page-slide-*` 对齐（200ms / 0.22,1,0.36,1）。
const slideVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: SLIDE_PX * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: -SLIDE_PX * direction }),
};

export function ShellViewSwitch({ viewKey, direction = 1, className, children }: ShellViewSwitchProps) {
  const reduced = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false} custom={direction}>
      <motion.div
        key={viewKey}
        className={cn('h-full min-h-0', className)}
        custom={direction}
        variants={slideVariants}
        initial={reduced ? false : 'enter'}
        animate="center"
        exit={reduced ? { opacity: 1, x: 0 } : 'exit'}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
