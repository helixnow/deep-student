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
import { Cards, CheckSquare, CircleNotch, ArrowRight, Notebook, WarningDiamond } from '@phosphor-icons/react';
import { loadTodayLearning } from '@/features/learning-today/todayLearning';
import { openTodayReviewTarget } from '@/features/learning-today/openTodayReview';
import { WeakConceptsStrip } from './WeakConceptsStrip';
import { WeeklyReportActions } from './WeeklyReportActions';

type ActionView = 'learning-hub' | 'todo' | 'task-dashboard' | 'flashcards';

interface TodayCommandCenterProps {
  onNavigate?: (view: ActionView) => void;
}

interface TodayCounts {
  cardsDue: number;
  mistakesDue: number;
  notesDue: number;
  todoDue: number;
  activeJobs: number;
}

const REFRESH_INTERVAL_MS = 60_000;

async function loadCounts(): Promise<TodayCounts> {
  // 三条复习线统一口径（卡片 / 错题 / 笔记），见 learning-today/todayLearning
  const [learning, todoDue, activeJobs] = await Promise.all([
    loadTodayLearning().catch(() => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] })),
    import('@/features/todo/api')
      .then((m) => m.listTodayItems(false))
      .then((items) => items.length)
      .catch(() => 0),
    invoke<Array<{ activeTasks?: number }>>('list_document_sessions', { limit: 100 })
      .then((sessions) => sessions.filter((s) => (s.activeTasks ?? 0) > 0).length)
      .catch(() => 0),
  ]);
  return { cardsDue: learning.cards, mistakesDue: learning.mistakes, notesDue: learning.notes, todoDue, activeJobs };
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
    {/* 触屏无 hover：常显"前往"提示，保证入口可发现 */}
    <span className="flex items-center gap-0.5 text-[12px] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground [@media(pointer:coarse)]:text-muted-foreground/70">
      {hint}
      <ArrowRight size={12} />
    </span>
  </button>
);

export const TodayCommandCenter: React.FC<TodayCommandCenterProps> = ({ onNavigate }) => {
  const { t } = useTranslation('data');
  const [counts, setCounts] = useState<TodayCounts | null>(null);

  const refresh = useCallback(() => {
    loadCounts().then(setCounts).catch(() => setCounts({ cardsDue: 0, mistakesDue: 0, notesDue: 0, todoDue: 0, activeJobs: 0 }));
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

  const nothingToDo = counts.cardsDue === 0 && counts.mistakesDue === 0 && counts.notesDue === 0
    && counts.todoDue === 0 && counts.activeJobs === 0;

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t('today_center.title')}</h2>
        {nothingToDo && (
          <span className="text-[12px] text-muted-foreground/60">{t('today_center.all_clear')}</span>
        )}
        <WeeklyReportActions />
      </div>
      <div className="flex flex-wrap gap-3">
        <ActionCard
          icon={<Cards size={18} />}
          label={t('today_center.cards_due', { defaultValue: '到期卡片' })}
          count={counts.cardsDue}
          hint={t('today_center.go')}
          highlight={counts.cardsDue > 0}
          onClick={() => onNavigate?.('flashcards')}
        />
        <ActionCard
          icon={<WarningDiamond size={18} />}
          label={t('today_center.mistakes_due', { defaultValue: '错题复习' })}
          count={counts.mistakesDue}
          hint={t('today_center.go')}
          highlight={counts.mistakesDue > 0}
          onClick={() => openTodayReviewTarget('mistakes')}
        />
        <ActionCard
          icon={<Notebook size={18} />}
          label={t('today_center.notes_due', { defaultValue: '待复习笔记' })}
          count={counts.notesDue}
          hint={t('today_center.go')}
          highlight={counts.notesDue > 0}
          onClick={() => openTodayReviewTarget('notes')}
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
      <WeakConceptsStrip />
    </div>
  );
};
