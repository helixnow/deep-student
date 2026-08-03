/**
 * ProgressRing — 子任务完成度 SVG 圆环（默认 14px）
 *
 * 轨道用 --border-default，进度用 primary，全部完成切到 success；
 * stroke-dashoffset 过渡 200ms 签名缓动，motion-reduce 下瞬时。
 */

import React from 'react';
import { cn } from '@/lib/utils';

const RADIUS = 5.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ProgressRing: React.FC<{
  done: number;
  total: number;
  size?: number;
  className?: string;
}> = ({ done, total, size = 14, className }) => {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const complete = total > 0 && done >= total;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={cn('-rotate-90 flex-shrink-0', className)}
    >
      <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="var(--border-default)" strokeWidth="1.75" />
      <circle
        cx="7"
        cy="7"
        r={RADIUS}
        fill="none"
        stroke={complete ? 'hsl(var(--success))' : 'hsl(var(--primary))'}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
        className="transition-[stroke-dashoffset,stroke] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      />
    </svg>
  );
};

export default ProgressRing;
