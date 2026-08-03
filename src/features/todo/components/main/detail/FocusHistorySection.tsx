/**
 * FocusHistorySection — 详情面板专注历史时间线
 *
 * - 头部：完成番茄数 + 总时长摘要，今日累计单独高亮；「开始专注」内联入口
 *   （调用 pomodoro store 公开 action，由父组件注入回调）
 * - 每条记录带时长条（以 25 分钟为满格基准，超出封顶），完成 success / 中断 destructive
 * - 日期显示为相对时间（今天/昨天/N 天前，7 天以外回退本地化日期）
 * - 超过 8 条内联展开全部（InlineReveal，不再是只读的「还有 N 条」死文案）
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CheckCircle, Play, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type { PomodoroRecord } from '@/features/pomodoro/api';
import { InlineReveal } from './InlineReveal';

const DAY_MS = 86400000;
const VISIBLE_LIMIT = 8;
/** 时长条满格基准：一节标准番茄（25 分钟） */
const BAR_FULL_SECONDS = 25 * 60;

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function relativeDayLabel(t: TFunc, date: Date): string {
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);
  if (diffDays <= 0) return t('todo:dates.today');
  if (diffDays === 1) return t('todo:dates.yesterday');
  if (diffDays < 7) return t('todo:detail.daysAgo', { count: diffDays });
  return date.toLocaleDateString();
}

function formatDuration(t: TFunc, seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t('todo:focusHistory.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return t('todo:detail.durationHours', { count: hours });
  return t('todo:detail.durationHoursMinutes', { hours, minutes: rest });
}

const RecordRow: React.FC<{ record: PomodoroRecord; t: TFunc }> = ({ record, t }) => {
  const start = new Date(record.startTime);
  const completed = record.status === 'completed';
  const ratio = Math.min(1, Math.max(0.06, record.actualDuration / BAR_FULL_SECONDS));
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-shell-control)] px-1 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-[color:var(--interactive-hover)]">
      {completed ? (
        <CheckCircle size={13} className="flex-shrink-0 text-[color:hsl(var(--success))]" />
      ) : (
        <X size={13} className="flex-shrink-0 text-[color:hsl(var(--destructive))]/70" />
      )}
      <span className="w-[7.5rem] flex-shrink-0 truncate text-xs">
        {relativeDayLabel(t, start)}
        <span className="ml-1.5 tabular-nums text-muted-foreground/70">
          {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
      {/* 时长条：25 分钟满格封顶；中断节段用 destructive 淡色 */}
      <span
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]/60"
        role="presentation"
      >
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            completed
              ? 'bg-[color:hsl(var(--success))]/70'
              : 'bg-[color:hsl(var(--destructive))]/40',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
      <span className="flex-shrink-0 text-xs tabular-nums">
        {formatDuration(t, record.actualDuration)}
      </span>
    </div>
  );
};

export const FocusHistorySection: React.FC<{
  records: PomodoroRecord[];
  /** 「开始专注」内联入口（父组件桥接 pomodoro store 的公开 start action） */
  onStartFocus?: () => void;
}> = ({ records, onStartFocus }) => {
  const { t } = useTranslation(['todo']);
  const [expanded, setExpanded] = useState(false);

  const todayMinutes = useMemo(() => {
    const todayStart = startOfDay(new Date());
    const seconds = records
      .filter((r) => new Date(r.startTime).getTime() >= todayStart)
      .reduce((acc, r) => acc + r.actualDuration, 0);
    return Math.round(seconds / 60);
  }, [records]);

  if (records.length === 0) return null;

  const visible = records.slice(0, VISIBLE_LIMIT);
  const rest = records.slice(VISIBLE_LIMIT);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="block min-w-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('todo:focusHistory.title')}
          <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
            {t('todo:focusHistory.summary', {
              count: records.filter((r) => r.status === 'completed').length,
              minutes: Math.round(records.reduce((acc, r) => acc + r.actualDuration, 0) / 60),
            })}
          </span>
          {todayMinutes > 0 && (
            <span className="ml-1.5 font-normal normal-case text-[color:hsl(var(--success))]">
              {t('todo:focusHistory.todayTotal', { minutes: todayMinutes })}
            </span>
          )}
        </span>
        {onStartFocus && (
          <button
            type="button"
            onClick={onStartFocus}
            className="flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-shell-control)] px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))]"
            title={t('todo:actions.startFocusSession')}
          >
            <Play size={12} />
            {t('todo:actions.startFocusSession')}
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {visible.map((record) => (
          <RecordRow key={record.id} record={record} t={t} />
        ))}
        {rest.length > 0 && (
          <>
            <InlineReveal open={expanded}>
              <div className="space-y-0.5">
                {rest.map((record) => (
                  <RecordRow key={record.id} record={record} t={t} />
                ))}
              </div>
            </InlineReveal>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="flex items-center gap-1 rounded-[var(--radius-shell-control)] px-1 py-0.5 text-xs text-muted-foreground/70 transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))]"
            >
              <CaretDown
                size={11}
                className={cn(
                  'transition-transform duration-200 motion-reduce:transition-none',
                  expanded && 'rotate-180',
                )}
              />
              {expanded
                ? t('todo:focusHistory.showLess')
                : t('todo:focusHistory.more', { count: rest.length })}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default FocusHistorySection;
