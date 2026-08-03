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
      'flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 p-3',
      'transition-[background-color,border-color] duration-150 ease-standard',
      'hover:border-border hover:bg-muted/30',
      className
    )}
  >
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn('shrink-0 opacity-80', color)}>{icon}</span>
    </div>
    <div className="min-w-0">
      <p className={cn('text-xl font-semibold leading-none tabular-nums', color)}>{value}</p>
      {description && (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground/70">{description}</p>
      )}
    </div>
  </div>
);

export default ReviewStatTile;
