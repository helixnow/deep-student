/**
 * ★ 5.1 首页「今日指挥中心」行动区
 *
 * 仪表盘从纯回顾性统计升级为可行动入口：
 * - 今日到期复习 n（直达学习资源）
 * - 今日待办 m（直达待办页）
 * - 运行中制卡任务 k（直达任务页）
 *
 * 数据加载失败时静默降级（显示 0 / 不显示徽标），不阻塞统计区渲染。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, CheckSquare, CircleNotch, ArrowRight } from '@phosphor-icons/react';

type ActionView = 'learning-hub' | 'todo' | 'task-dashboard';

interface TodayCommandCenterProps {
  onNavigate?: (view: ActionView) => void;
}

interface TodayCounts {
  reviewDue: number;
  todoDue: number;
  activeJobs: number;
}

const REFRESH_INTERVAL_MS = 60_000;

async function loadCounts(): Promise<TodayCounts> {
  const [reviewDue, todoDue, activeJobs] = await Promise.all([
    invoke<{ due_today?: number; overdue_count?: number }>('review_plan_get_stats', { examId: null })
      .then((s) => (s?.due_today ?? 0) + (s?.overdue_count ?? 0))
      .catch(() => 0),
    import('@/features/todo/api')
      .then((m) => m.listTodayItems(false))
      .then((items) => items.length)
      .catch(() => 0),
    invoke<Array<{ activeTasks?: number }>>('list_document_sessions', { limit: 100 })
      .then((sessions) => sessions.filter((s) => (s.activeTasks ?? 0) > 0).length)
      .catch(() => 0),
  ]);
  return { reviewDue, todoDue, activeJobs };
}

interface ActionCardProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  hint: string;
  highlight: boolean;
  spinning?: boolean;
  onClick?: () => void;
}

const ActionCard: React.FC<ActionCardProps> = ({ icon, label, count, hint, highlight, spinning, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={[
      'group flex flex-1 min-w-[180px] items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
      highlight
        ? 'border-[color:hsl(var(--primary)/0.35)] bg-[color:hsl(var(--primary)/0.06)] hover:bg-[color:hsl(var(--primary)/0.1)]'
        : 'border-border bg-card hover:bg-muted/50',
    ].join(' ')}
  >
    <span
      className={[
        'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md',
        highlight ? 'bg-[color:hsl(var(--primary)/0.12)] text-[color:hsl(var(--primary))]' : 'bg-muted text-muted-foreground',
      ].join(' ')}
    >
      {spinning ? <CircleNotch size={18} className="animate-spin" /> : icon}
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-[13px] text-muted-foreground">{label}</span>
      <span className="block text-[20px] font-semibold leading-tight tabular-nums text-foreground">
        {count}
      </span>
    </span>
    <span className="flex items-center gap-0.5 text-[12px] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground">
      {hint}
      <ArrowRight size={12} />
    </span>
  </button>
);

export const TodayCommandCenter: React.FC<TodayCommandCenterProps> = ({ onNavigate }) => {
  const { t } = useTranslation('data');
  const [counts, setCounts] = useState<TodayCounts | null>(null);

  const refresh = useCallback(() => {
    loadCounts().then(setCounts).catch(() => setCounts({ reviewDue: 0, todoDue: 0, activeJobs: 0 }));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  if (!counts) return null;

  const nothingToDo = counts.reviewDue === 0 && counts.todoDue === 0 && counts.activeJobs === 0;

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t('today_center.title')}</h2>
        {nothingToDo && (
          <span className="text-[12px] text-muted-foreground/60">{t('today_center.all_clear')}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <ActionCard
          icon={<BookOpen size={18} />}
          label={t('today_center.review_due')}
          count={counts.reviewDue}
          hint={t('today_center.go')}
          highlight={counts.reviewDue > 0}
          onClick={() => onNavigate?.('learning-hub')}
        />
        <ActionCard
          icon={<CheckSquare size={18} />}
          label={t('today_center.todo_due')}
          count={counts.todoDue}
          hint={t('today_center.go')}
          highlight={counts.todoDue > 0}
          onClick={() => onNavigate?.('todo')}
        />
        <ActionCard
          icon={<CircleNotch size={18} />}
          label={t('today_center.active_jobs')}
          count={counts.activeJobs}
          hint={t('today_center.go')}
          highlight={false}
          spinning={counts.activeJobs > 0}
          onClick={() => onNavigate?.('task-dashboard')}
        />
      </div>
    </div>
  );
};
