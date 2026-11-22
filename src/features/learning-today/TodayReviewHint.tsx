/**
 * 对话首页（空会话）输入框旁的「今日待复习」：学习者打开应用落在这里，
 * 不必绕到统计页 / 闪卡页才知道今天该复习什么。三条复习线与首页「今日学习」同口径；
 * 有作答记录后第二行给出薄弱知识点（一键讲练）与本周周报。
 * 还没有任何卡片、错题和作答记录的新用户，显示一行「三步走通」引导（可关）。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Books, Cards, ListChecks, Notebook, Play, WarningDiamond, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { openDailySprint, useSprintLauncherSnapshot } from '@/components/exam-sprint';
import { WeakConceptsStrip, useWeakConcepts } from '@/components/dashboard/WeakConceptsStrip';
import { WeeklyReportActions } from '@/components/dashboard/WeeklyReportActions';
import { getTodayLearningSnapshot, refreshTodayLearning, subscribeTodayLearning } from './todayLearningStore';
import { openResourceLibrary, openTodayReviewTarget } from './openTodayReview';
import { useTodayTodoCount } from './todayTodoCount';

const WEAK_CONCEPTS_ON_HOME = 3;
const STARTER_DISMISSED_KEY = 'learningToday.starterDismissed';
const starterDismissedListeners = new Set<() => void>();

function readStarterDismissed(): boolean {
  try {
    return localStorage.getItem(STARTER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeStarterDismissed(listener: () => void): () => void {
  starterDismissedListeners.add(listener);
  return () => {
    starterDismissedListeners.delete(listener);
  };
}

function dismissStarterGlobally(): void {
  try {
    localStorage.setItem(STARTER_DISMISSED_KEY, '1');
  } catch {
    /* 偏好写入失败只影响下次是否再显示 */
  }
  for (const listener of starterDismissedListeners) {
    listener();
  }
}

export interface TodayReviewHintAvailability {
  /** 是否存在可展示的今日待复习 / 薄弱点 / 周报 / 新手三步内容 */
  hasContent: boolean;
  /** 是否存在今天到期的卡片、错题、笔记或待办 */
  hasDueItems: boolean;
}

/**
 * 订阅 TodayReviewHint 是否有可展示内容，供移动端空态 Logo 徽标与切换入口判断使用。
 */
export function useTodayReviewHintAvailability(enabled = true): TodayReviewHintAvailability {
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  const todoDueCount = useTodayTodoCount();
  const weak = useWeakConcepts(WEAK_CONCEPTS_ON_HOME);
  const starterDismissed = useSyncExternalStore(subscribeStarterDismissed, readStarterDismissed, () => false);

  useEffect(() => {
    if (enabled) {
      void refreshTodayLearning();
    }
  }, [enabled]);

  if (!enabled) {
    return { hasContent: false, hasDueItems: false };
  }

  const dueCount = today.cards + today.mistakes + today.notes + todoDueCount;
  const hasWeak = Boolean(weak && weak.length > 0);
  const isNewLearner =
    today.cardsTotal === 0 && today.plansTotal === 0 && dueCount === 0 && weak !== null && !hasWeak;
  const showStarter = isNewLearner && !starterDismissed;
  const hasHistory = (today.cardsTotal ?? 0) > 0 || (today.plansTotal ?? 0) > 0;

  return {
    hasContent: showStarter || dueCount > 0 || hasWeak || hasHistory,
    hasDueItems: dueCount > 0,
  };
}

export interface TodayReviewHintProps {
  /** 嵌入到空态切换容器中时移除顶部外边距 */
  embedded?: boolean;
}

export const TodayReviewHint: React.FC<TodayReviewHintProps> = ({ embedded = false }) => {
  const { t } = useTranslation('data');
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  const todoDueCount = useTodayTodoCount();
  const { readiness: sprintReadiness } = useSprintLauncherSnapshot();
  const weak = useWeakConcepts(WEAK_CONCEPTS_ON_HOME);
  const starterDismissed = useSyncExternalStore(subscribeStarterDismissed, readStarterDismissed, () => false);
  useEffect(() => { void refreshTodayLearning(); }, []);

  const items = [
    { key: 'cards', count: today.cards, icon: <Cards size={14} aria-hidden="true" />, label: t('today_center.cards_due', { defaultValue: '到期卡片' }), onClick: () => openTodayReviewTarget('cards') },
    { key: 'mistakes', count: today.mistakes, icon: <WarningDiamond size={14} aria-hidden="true" />, label: t('today_center.mistakes_due', { defaultValue: '错题复习' }), onClick: () => openTodayReviewTarget('mistakes') },
    { key: 'notes', count: today.notes, icon: <Notebook size={14} aria-hidden="true" />, label: t('today_center.notes_due', { defaultValue: '待复习笔记' }), onClick: () => openTodayReviewTarget('notes') },
    { key: 'todos', count: todoDueCount, icon: <ListChecks size={14} aria-hidden="true" />, label: t('today_center.todo_due', { defaultValue: '今日待办' }), onClick: () => openTodayReviewTarget('todos') },
  ].filter((item) => item.count > 0);
  const hasWeak = Boolean(weak && weak.length > 0);
  // 只有两项总数都确实读到且为 0 才算新用户：读取失败（缺省）时不打扰
  const isNewLearner = today.cardsTotal === 0 && today.plansTotal === 0 && items.length === 0 && weak !== null && !hasWeak;
  const showStarter = isNewLearner && !starterDismissed;

  if (showStarter) {
    const dismiss = () => {
      dismissStarterGlobally();
    };
    return (
      <div
        className={cn(
          !embedded && 'mt-3',
          'flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-xs text-muted-foreground'
        )}
        data-testid="today-starter"
      >
        <span className="font-medium text-foreground">{t('today_center.starter_title', { defaultValue: '第一次用？三步走通' })}</span>
        <span>{t('today_center.starter_steps', { defaultValue: '导入资料 → 在资料菜单里选「用这份资料制卡」→ 每天回这里复习' })}</span>
        <button
          type="button"
          onClick={openResourceLibrary}
          className="native-touch-target inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-foreground transition-colors hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
        >
          <Books size={14} aria-hidden="true" />
          {t('today_center.starter_action', { defaultValue: '打开资源库' })}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('today_center.starter_dismiss', { defaultValue: '不再显示' })}
          title={t('today_center.starter_dismiss', { defaultValue: '不再显示' })}
          className="native-touch-target inline-flex items-center rounded-full p-1 transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)] [@media(pointer:coarse)]:justify-center"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    );
  }

  // 有卡片或复习计划（做过题）就留着周报入口：没到期、薄弱点又只有无标签题时也能看本周周报
  const hasHistory = (today.cardsTotal ?? 0) > 0 || (today.plansTotal ?? 0) > 0;
  if (items.length === 0 && !hasWeak && !hasHistory) return null;

  const hasSprintTargets = today.cards > 0 || today.mistakes > 0;
  const onlyNotesDue = !hasSprintTargets && today.notes > 0;
  const estimatedSprintMinutes =
    sprintReadiness && sprintReadiness.estimatedSprintMinutes > 0
      ? sprintReadiness.estimatedSprintMinutes
      : Math.max(
          1,
          Math.min(15, Math.ceil((today.cards * 15 + today.mistakes * 40) / 60)),
        );

  const metricsGridClassName =
    items.length === 1
      ? 'grid-cols-1'
      : items.length === 2
        ? 'grid-cols-2'
        : items.length === 3
          ? 'grid-cols-3'
          : 'grid-cols-2 sm:grid-cols-4';

  return (
    <div
      className={cn(
        !embedded && 'mt-3',
        'w-full max-w-[680px] mx-auto overflow-hidden rounded-2xl border border-border/55 bg-[color:var(--surface-elevated)]/85'
      )}
      data-testid="today-review-hint"
    >
      {/* 顶行：主冲刺行动按钮（仅剩待复习笔记时直达笔记列表，不诱发空冲刺） + 右侧本周周报 */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {hasSprintTargets ? (
            <button
              type="button"
              data-testid="today-sprint-cta"
              onClick={() => openDailySprint({ source: 'today-hint' })}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-primary/35 bg-primary/[0.12] px-3 py-1.5 font-mono text-xs font-medium tabular-nums text-primary transition-colors hover:bg-primary/[0.18] active:opacity-80"
            >
              <Play size={12} weight="fill" aria-hidden="true" />
              <span className="truncate">{t('review:examSprint.hud.startCta', { minutes: estimatedSprintMinutes })}</span>
            </button>
          ) : onlyNotesDue ? (
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              data-testid="today-review-notes-cta"
              onClick={() => openTodayReviewTarget('notes')}
              className="min-h-9 gap-1.5 rounded-full border border-primary/35 bg-primary/[0.12] px-3 py-1.5 font-mono text-xs font-medium tabular-nums text-primary hover:bg-primary/[0.18] hover:text-primary active:opacity-80"
            >
              <Notebook size={13} aria-hidden="true" />
              <span className="truncate">
                {t('today_center.review_notes_cta', {
                  count: today.notes,
                  defaultValue: '复习待看笔记 ({{count}})',
                })}
              </span>
            </DsButton>
          ) : items.length > 0 ? (
            <span className="text-xs font-medium text-foreground">
              {t('today_center.hint_title', { defaultValue: '今日待复习' })}
            </span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">
              {t('today_center.overview_title', { defaultValue: '学习概览' })}
            </span>
          )}
        </div>
        <div className="shrink-0 [&_button]:min-h-9">
          <WeeklyReportActions compact />
        </div>
      </div>

      {/* 中段：等宽 KPI 宫格（按实际项数自动 1/2/3/4 列，杜绝折行孤立项） */}
      {items.length > 0 && (
        <div className={cn('grid divide-x divide-border/40 border-t border-border/40', metricsGridClassName)}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              className="group/metric flex min-h-[54px] min-w-0 flex-col items-center justify-center gap-0.5 px-2 py-2 text-center transition-colors hover:bg-[var(--interactive-hover)]"
            >
              <span className="font-mono text-lg font-semibold leading-tight tabular-nums text-foreground">
                {item.count}
              </span>
              <span className="inline-flex max-w-full items-center gap-1 text-xs leading-none text-muted-foreground transition-colors group-hover/metric:text-foreground">
                <span className="shrink-0 opacity-80">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 底条：薄弱知识点一键讲练（有数据时显示） */}
      {hasWeak && (
        <div className="border-t border-border/40 bg-background/30 px-3 py-2">
          <WeakConceptsStrip
            concepts={weak}
            limit={WEAK_CONCEPTS_ON_HOME}
            className="mt-0 justify-start [&_button]:min-h-9 [&_button>span:first-child]:max-w-[min(16em,calc(100vw-8.5rem))] sm:[&_button>span:first-child]:max-w-[14em]"
          />
        </div>
      )}
    </div>
  );
};
