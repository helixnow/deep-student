/**
 * 桌面右栏「AI 学习简报」小组件：今天该做的四件事一眼看完，点哪项进哪项。
 *
 * 此前复用 AI 仪表盘的 GenerativeUI intent（两张统计卡 + 把同样五个数字再列一遍的表 + 按钮），
 * 在日程下方的窄栏里纵向堆得很高、常被截断。桌面组件改为紧凑布局：
 * - 卡片 / 错题 / 笔记 / 待办四格一行，数字为主、标签为辅；0 弱化，逾期待办单独标红；
 * - 每格可点：三条复习线进各自的复习（与对话首页「今日待复习」同一入口），待办打开待办；
 * - 底部「开始复习」（无到期时隐藏）与「打开题目集」。
 * AI 仪表盘窗口仍用完整 intent（buildLearningBriefingIntent），不受影响。
 */
import React, { useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretUp, Sparkle } from '@phosphor-icons/react';
import { createWorkbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import { openTodayReviewTarget, type TodayReviewTarget } from '@/features/learning-today/openTodayReview';
import {
  getTodayLearningSnapshot,
  subscribeTodayLearning,
} from '@/features/learning-today/todayLearningStore';
import { WallpaperReplica } from '../core/liquidGlassLens';
import { workbenchBus } from '../core/workbenchBus';
import { useWindowStore } from '../core/windowStore';
import {
  getFlashcardsDueCount,
  subscribeFlashcardsDueCount,
} from '../apps/system/flashcardsDueSource';
import {
  getTodoAgendaSnapshot,
  subscribeTodoAgenda,
} from '../apps/system/todoAgendaSource';
import { formatLocalDateKey } from './DesktopAgendaWidget';
import { useDesktopWidgetCollapsed } from './desktopWidgetCollapse';
import './DesktopAiBriefingWidget.css';

interface BriefingTile {
  key: TodayReviewTarget | 'todos';
  label: string;
  count: number;
  /** 逾期提示（仅待办） */
  alert?: string;
  onOpen: () => void;
}

export const DesktopAiBriefingWidget: React.FC = React.memo(() => {
  const { t } = useTranslation(['workbench', 'generativeUi']);
  const widgetRef = useRef<HTMLElement | null>(null);
  const [collapsed, toggleCollapsed] = useDesktopWidgetCollapsed('briefing');
  const dueCards = useSyncExternalStore(subscribeFlashcardsDueCount, getFlashcardsDueCount, () => 0);
  const agenda = useSyncExternalStore(subscribeTodoAgenda, getTodoAgendaSnapshot, getTodoAgendaSnapshot);
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);

  const hasVisibleWindows = useWindowStore((s) => {
    for (const win of Object.values(s.windows)) {
      if (!win.minimized) return true;
    }
    return false;
  });

  const { pendingTodos, overdueTodos } = useMemo(() => {
    const todayKey = formatLocalDateKey(new Date());
    let overdue = 0;
    for (const item of agenda.items) {
      if (item.dueDate && item.dueDate < todayKey) overdue += 1;
    }
    return { pendingTodos: agenda.items.length, overdueTodos: overdue };
  }, [agenda.items]);

  const actions = useMemo(
    () =>
      createWorkbenchLearningHandlers({
        startReview: t('generativeUi:workbench.briefing.start_review'),
        openQbank: t('generativeUi:workbench.briefing.open_qbank'),
      }),
    [t],
  );

  const totalDue = dueCards + today.mistakes + today.notes;
  const tiles: BriefingTile[] = [
    { key: 'cards', label: t('generativeUi:workbench.briefing.tile_cards'), count: dueCards, onOpen: () => openTodayReviewTarget('cards') },
    { key: 'mistakes', label: t('generativeUi:workbench.briefing.tile_mistakes'), count: today.mistakes, onOpen: () => openTodayReviewTarget('mistakes') },
    { key: 'notes', label: t('generativeUi:workbench.briefing.tile_notes'), count: today.notes, onOpen: () => openTodayReviewTarget('notes') },
    {
      key: 'todos',
      label: t('generativeUi:workbench.briefing.todos_title'),
      count: pendingTodos,
      alert: overdueTodos > 0 ? t('generativeUi:workbench.briefing.overdue_short', { count: overdueTodos }) : undefined,
      onOpen: () => workbenchBus.launch({ typeId: 'todo', reason: 'api' }),
    },
  ];

  const startReview = actions['start-review'];
  const openQbank = actions['open-qbank'];

  return (
    <section
      ref={widgetRef}
      className="wb-ai-briefing-widget wb-glass wb-glass-highlight"
      data-testid="wb-ai-briefing-widget"
      data-wb-widget-dim={hasVisibleWindows || undefined}
      data-collapsed={collapsed || undefined}
      aria-label={t('generativeUi:workbench.briefing_label')}
    >
      <WallpaperReplica hostRef={widgetRef} />
      <header className="wb-ai-briefing-header">
        <Sparkle className="h-4 w-4 text-primary" weight="fill" aria-hidden />
        <span>{t('generativeUi:workbench.briefing_label')}</span>
        <span className="wb-ai-briefing-summary" data-testid="wb-ai-briefing-summary">
          {totalDue > 0
            ? t('generativeUi:workbench.briefing.due_total', { count: totalDue })
            : t('generativeUi:workbench.briefing.all_clear')}
        </span>
        <button
          type="button"
          className="wb-ai-briefing-collapse"
          data-testid="wb-ai-briefing-collapse"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('workbench:desktopWidgets.expand') : t('workbench:desktopWidgets.collapse')}
          title={collapsed ? t('workbench:desktopWidgets.expand') : t('workbench:desktopWidgets.collapse')}
        >
          {collapsed ? <CaretDown size={14} weight="bold" /> : <CaretUp size={14} weight="bold" />}
        </button>
      </header>

      {collapsed ? null : (
        <>
          <div className="wb-ai-briefing-tiles">
            {tiles.map((tile) => (
              <button
                key={tile.key}
                type="button"
                className="wb-ai-briefing-tile"
                data-testid={`wb-ai-briefing-tile-${tile.key}`}
                data-empty={tile.count === 0 || undefined}
                onClick={tile.onOpen}
              >
                <span className="wb-ai-briefing-tile-count">{tile.count}</span>
                <span className="wb-ai-briefing-tile-label">{tile.label}</span>
                {tile.alert ? <span className="wb-ai-briefing-tile-alert">{tile.alert}</span> : null}
              </button>
            ))}
          </div>

          <div className="wb-ai-briefing-actions">
            {totalDue > 0 && startReview ? (
              <button
                type="button"
                className="wb-ai-briefing-action wb-ai-briefing-action-primary"
                onClick={() => { void startReview.handler(); }}
              >
                {startReview.label}
              </button>
            ) : null}
            {openQbank ? (
              <button
                type="button"
                className="wb-ai-briefing-action"
                onClick={() => { void openQbank.handler(); }}
              >
                {openQbank.label}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
});

DesktopAiBriefingWidget.displayName = 'DesktopAiBriefingWidget';

export default DesktopAiBriefingWidget;
