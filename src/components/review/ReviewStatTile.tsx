/**
 * 复习模块统计小卡
 *
 * 与题目集管理页（QuestionBankManageView）同一套设计语言：
 * bg-muted/20 面板 + border-border/50 细边框 + 语义色数值 + tabular-nums。
 * 供 ReviewPlanView / ReviewCalendarView 共用，避免两处各写一套预制块样式。
 */

import React from 'react';
import { cn } from '@/lib/utils';

export interface ReviewStatTileProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  description?: string;
  /** 语义色 text-* class，作用于数值与图标 */
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const ReviewStatTile: React.FC<ReviewStatTileProps> = ({
  icon,
  label,
  value,
  description,
  color = 'text-primary',
  className,
  style,
}) => (
  <div
    style={style}
    className={cn(
      'flex flex-col gap-1 rounded-lg border border-border/35 bg-muted/15 px-3 py-2',
      'transition-[background-color,border-color] duration-150 ease-standard',
      'hover:border-border/60 hover:bg-muted/25',
      className
    )}
  >
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className={cn('shrink-0 opacity-75', color)}>{icon}</span>
    </div>
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <p className={cn('text-base font-mono font-semibold leading-none tabular-nums', color)}>{value}</p>
      {description && (
        <p className="truncate text-[11px] font-mono tabular-nums text-muted-foreground/70">{description}</p>
      )}
    </div>
  </div>
);

export default ReviewStatTile;
