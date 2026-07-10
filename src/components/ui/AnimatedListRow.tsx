import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * motion.div 与原生 DOM 事件签名冲突的属性（framer-motion 自带同名手势 props），
 * 列表行场景不使用它们，直接从透传属性中剔除。
 */
type ConflictingMotionProps = 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd';

export interface AnimatedListRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, ConflictingMotionProps> {
  children: React.ReactNode;
}

/**
 * 列表行进出场动画（transitions-dev 观感语言）：
 * - 新增行：fade + 高度 0→auto 展开（150ms，签名缓动）
 * - 移除行：fade + 高度收合（150ms）
 * - 顺序变化：其余行平滑补位（layout="position"）
 *
 * 使用要求：
 * - 外层必须包 <AnimatePresence initial={false}>（initial=false 保证首屏列表不整体播放入场）
 * - 自身需带稳定 key（如 session.id）
 * - prefers-reduced-motion 时退化为普通 div，瞬时增删
 */
export const AnimatedListRow: React.FC<AnimatedListRowProps> = ({ children, className, ...rest }) => {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
      className={cn('overflow-hidden', className)}
      {...rest}
    >
      {children}
    </motion.div>
  );
};

export default AnimatedListRow;
