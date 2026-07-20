/**
 * 倒计时进度环（限时练习 / 模拟考试共用）
 *
 * - SVG 圆环按剩余时间比例收缩，颜色随剩余比例切换 success → warning → destructive
 * - 最后 60 秒变色并脉动（暂停时停止脉动）；respects prefers-reduced-motion
 *   （animate-pulse 由 Tailwind 提供，reduce 时全局动画禁用策略生效）
 */

import React from 'react';
import { cn } from '@/lib/utils';

export interface CountdownRingProps {
  /** 剩余秒数 */
  remainingSeconds: number;
  /** 总时长（秒） */
  totalSeconds: number;
  /** 中心显示的格式化时间文本 */
  timeText: string;
  /** 中心副标题（如「剩余时间」/「已暂停」徽标） */
  subtitle?: React.ReactNode;
  /** 暂停时停止脉动 */
  isPaused?: boolean;
  className?: string;
}

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const CountdownRing: React.FC<CountdownRingProps> = ({
  remainingSeconds,
  totalSeconds,
  timeText,
  subtitle,
  isPaused = false,
  className,
}) => {
  const ratio = totalSeconds > 0 ? Math.max(0, Math.min(1, remainingSeconds / totalSeconds)) : 0;
  const isFinalMinute = remainingSeconds > 0 && remainingSeconds <= 60;

  const colorClass = isFinalMinute || ratio <= 0.1
    ? 'text-destructive'
    : ratio > 0.5
      ? 'text-success'
      : ratio > 0.25
        ? 'text-warning'
        : 'text-destructive';

  return (
    <div className={cn('relative mx-auto h-32 w-32 sm:h-36 sm:w-36', className)}>
      <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
        <circle
          cx="60" cy="60" r={RADIUS}
          fill="none" stroke="currentColor" strokeWidth="6"
          className="text-muted/30"
        />
        <circle
          cx="60" cy="60" r={RADIUS}
          fill="none" stroke="currentColor" strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          className={cn(
            'transition-[stroke-dashoffset,color] duration-500 ease-linear',
            colorClass,
            isFinalMinute && !isPaused && 'animate-pulse',
          )}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
        <span
          className={cn(
            'font-mono text-2xl font-semibold tabular-nums transition-colors sm:text-[1.7rem]',
            colorClass,
            isFinalMinute && !isPaused && 'animate-pulse',
          )}
        >
          {timeText}
        </span>
        {subtitle && (
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
    </div>
  );
};

export default CountdownRing;
