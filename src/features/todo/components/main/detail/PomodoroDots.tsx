/**
 * PomodoroDots — 预估/已完成番茄的迷你点阵
 *
 * ≤12 个预估时逐个圆点（完成 = warning 填充），更多时退化为细进度条。
 * 新完成一节番茄时，最新填充的点弹跳一次（reduced-motion 退化为纯变色）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

export const PomodoroDots: React.FC<{ done: number; total: number }> = ({ done, total }) => {
  const prefersReducedMotion = useReducedMotion();

  // 完成数上升时记录「新点亮」的点位，播放一次弹跳
  const prevDoneRef = useRef(done);
  const [popIndex, setPopIndex] = useState<number | null>(null);
  useEffect(() => {
    if (done > prevDoneRef.current) {
      setPopIndex(done - 1);
    }
    prevDoneRef.current = done;
  }, [done]);

  if (total <= 0) return null;
  if (total > 12) {
    const ratio = Math.min(1, Math.max(0, done / total));
    return (
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]"
        role="presentation"
      >
        <div
          className="h-full rounded-full bg-[color:hsl(var(--warning))] transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1" role="presentation">
      {Array.from({ length: total }).map((_, i) => (
        <motion.span
          key={i}
          initial={false}
          animate={
            !prefersReducedMotion && popIndex === i ? { scale: [0.4, 1.35, 1] } : { scale: 1 }
          }
          transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
          onAnimationComplete={() => {
            if (popIndex === i) setPopIndex(null);
          }}
          className={cn(
            'h-2 w-2 rounded-full transition-colors duration-150 motion-reduce:transition-none',
            i < done
              ? 'bg-[color:hsl(var(--warning))]'
              : 'bg-[color:var(--shell-workspace-border)]',
          )}
        />
      ))}
    </div>
  );
};

export default PomodoroDots;
