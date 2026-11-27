/**
 * 统一「今日学习汇总」卡片（待办 / 今日学习入口共用）：
 * 一处清晰聚合展示全部到期项（到期闪卡、到期错题 FSRS、待复习笔记、今日待办），
 * 并提供每一项的一键直达按钮与一键开启「今日冲刺」入口，消除分散入口的迷茫感。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Cards, ListChecks, Notebook, Play, WarningDiamond } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { openDailySprint, useSprintLauncherSnapshot } from '@/components/exam-sprint';
import { getTodayLearningSnapshot, refreshTodayLearning, subscribeTodayLearning } from './todayLearningStore';
import { openTodayReviewTarget } from './openTodayReview';
import { useTodayTodoCount } from './todayTodoCount';

export interface TodayStudySummaryCardProps {
  /** 外部已知的今日未完成待办数（如 TodoMainPanel 当前视图计数）；未传时自动通过 IPC 获取 */
  todoDueCount?: number;
  /** 当前是否已处于待办「今日」视图（为 true 时只要存在任一到期复习或今日待办即展示） */
  inTodayTodoView?: boolean;
  /** 当前处于空的收件箱/清单视图（避免「今日待办 N」与下方「暂无待办事项」混为一谈） */
  inEmptyListView?: boolean;
  /** 点击「今日待办」入口时的回调；未传时默认调用 openTodayReviewTarget('todos') */
  onOpenTodos?: () => void;
  className?: string;
}

export const TodayStudySummaryCard: React.FC<TodayStudySummaryCardProps> = ({
  todoDueCount,
  inTodayTodoView = false,
  inEmptyListView = false,
  onOpenTodos,
  className,
}) => {
  const { t } = useTranslation(['todo', 'review']);
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  const { readiness: sprintReadiness } = useSprintLauncherSnapshot();
  const resolvedTodoDue = useTodayTodoCount(todoDueCount);

  useEffect(() => {
    void refreshTodayLearning();
  }, []);

  const hasSprintTargets = today.cards > 0 || today.mistakes > 0;
  const onlyNotesDue = !hasSprintTargets && today.notes > 0;
  const reviewDueTotal = today.cards + today.mistakes + today.notes;
  const totalDue = reviewDueTotal + resolvedTodoDue;

  // 在非今日待办视图下（如收件箱），仅当存在待复习内容时提示跨模块汇总；在今日视图下，有任何待完成项即完整展示四路概览
  if (inTodayTodoView ? totalDue <= 0 : reviewDueTotal <= 0) {
    return null;
  }

  const estimatedSprintMinutes =
    sprintReadiness && sprintReadiness.estimatedSprintMinutes > 0
      ? sprintReadiness.estimatedSprintMinutes
      : Math.max(
          1,
          Math.min(15, Math.ceil((today.cards * 15 + today.mistakes * 40) / 60)),
        );

  const handleOpenTodos = () => {
    if (onOpenTodos) {
      onOpenTodos();
      return;
    }
    openTodayReviewTarget('todos');
  };

  const categories = [
    {
      key: 'cards',
      testId: 'today-summary-cards',
      icon: <Cards size={14} aria-hidden="true" />,
      label: t('todo:reviewLink.cardsLabel', { defaultValue: '到期闪卡' }),
      count: today.cards,
      onClick: () => openTodayReviewTarget('cards'),
    },
    {
      key: 'mistakes',
      testId: 'today-summary-mistakes',
      icon: <WarningDiamond size={14} aria-hidden="true" />,
      label: t('todo:reviewLink.mistakesLabel', { defaultValue: '错题 FSRS' }),
      count: today.mistakes,
      onClick: () => openTodayReviewTarget('mistakes'),
    },
    {
      key: 'notes',
      testId: 'today-summary-notes',
      icon: <Notebook size={14} aria-hidden="true" />,
      label: t('todo:reviewLink.notesLabel', { defaultValue: '待复习笔记' }),
      count: today.notes,
      onClick: () => openTodayReviewTarget('notes'),
    },
    {
      key: 'todos',
      testId: 'today-summary-todos',
      icon: <ListChecks size={14} aria-hidden="true" />,
      label: inEmptyListView
        ? t('todo:reviewLink.todosGlobalLabel', { defaultValue: '全局今日待办' })
        : t('todo:reviewLink.todosLabel', { defaultValue: '今日待办' }),
      count: resolvedTodoDue,
      onClick: handleOpenTodos,
    },
  ];

  const activeCategories = categories.filter((cat) => cat.count > 0);

  return (
    <section
      data-testid="today-study-summary-card"
      aria-label={t('todo:reviewLink.hubTitle', { defaultValue: '今日学习汇总' })}
      className={cn(
        'flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/20 px-4 py-2 sm:px-6',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Brain size={14} weight="duotone" className="shrink-0 text-primary" aria-hidden="true" />
        <span className="font-medium text-foreground">
          {t('todo:reviewLink.hubTitle', { defaultValue: '今日学习汇总' })}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {t('todo:reviewLink.hubTotal', { count: totalDue, defaultValue: '共 {{count}} 项待完成' })}
        </span>
      </div>

      {activeCategories.length > 0 && (
        <>
          <span className="hidden h-3 w-px bg-border/40 sm:inline-block" aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-1">
            {activeCategories.map((cat) => (
              <DsButton
                key={cat.key}
                type="button"
                variant="ghost"
                size="sm"
                data-testid={cat.testId}
                data-active="true"
                onClick={cat.onClick}
                className="gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <span className="shrink-0 text-primary/80">{cat.icon}</span>
                <span className="truncate">{cat.label}</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {cat.count}
                </span>
              </DsButton>
            ))}
          </div>
        </>
      )}

      <div className="ml-auto flex shrink-0 items-center">
        {hasSprintTargets ? (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            data-testid="today-summary-sprint"
            onClick={() => openDailySprint({ source: 'todo-today' })}
            className="gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 font-mono text-xs font-medium tabular-nums text-primary hover:bg-primary/15"
          >
            <Play size={11} weight="fill" aria-hidden="true" />
            <span>{t('review:examSprint.hud.startCta', { minutes: estimatedSprintMinutes })}</span>
          </DsButton>
        ) : onlyNotesDue ? (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            data-testid="today-summary-review-notes"
            onClick={() => openTodayReviewTarget('notes')}
            className="gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 font-mono text-xs font-medium tabular-nums text-primary hover:bg-primary/15"
          >
            <Notebook size={13} aria-hidden="true" />
            <span>
              {t('todo:reviewLink.reviewNotesCta', {
                count: today.notes,
                defaultValue: '复习待看笔记 ({{count}})',
              })}
            </span>
          </DsButton>
        ) : null}
      </div>
    </section>
  );
};

export default TodayStudySummaryCard;
