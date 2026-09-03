import React, { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';
import { createWorkbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import {
  getFlashcardsDueCount,
  subscribeFlashcardsDueCount,
} from '../apps/system/flashcardsDueSource';
import {
  getTodoAgendaSnapshot,
  subscribeTodoAgenda,
} from '../apps/system/todoAgendaSource';
import { useWindowStore } from '../core/windowStore';
import { formatLocalDateKey } from './DesktopAgendaWidget';
import './DesktopAiBriefingWidget.css';

export const DesktopAiBriefingWidget: React.FC = React.memo(() => {
  const { t } = useTranslation(['workbench', 'generativeUi']);
  const dueCount = useSyncExternalStore(subscribeFlashcardsDueCount, getFlashcardsDueCount, () => 0);
  const agenda = useSyncExternalStore(subscribeTodoAgenda, getTodoAgendaSnapshot, getTodoAgendaSnapshot);

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

  const intent = useMemo(
    () =>
      buildLearningBriefingIntent(
        {
          dueFlashcards: dueCount,
          pendingTodos,
          overdueTodos,
        },
        {
          dueFlashcardsTitle: t('generativeUi:workbench.briefing.due_flashcards_title'),
          dueTrendDue: t('generativeUi:workbench.briefing.due_trend_due'),
          dueTrendNone: t('generativeUi:workbench.briefing.due_trend_none'),
          progressTitle: t('generativeUi:workbench.briefing.progress_title'),
          overdueLabel: t('generativeUi:workbench.briefing.overdue_label'),
          pendingLabel: t('generativeUi:workbench.briefing.pending_label'),
          startReview: t('generativeUi:workbench.briefing.start_review'),
          openQbank: t('generativeUi:workbench.briefing.open_qbank'),
        },
      ),
    [dueCount, overdueTodos, pendingTodos, t],
  );

  const actionHandlers = useMemo(
    () =>
      createWorkbenchLearningHandlers({
        startReview: t('generativeUi:workbench.briefing.start_review'),
        openQbank: t('generativeUi:workbench.briefing.open_qbank'),
      }),
    [t],
  );

  return (
    <section
      className="wb-ai-briefing-widget wb-glass wb-glass-highlight"
      data-testid="wb-ai-briefing-widget"
      data-wb-widget-dim={hasVisibleWindows || undefined}
      aria-label={t('generativeUi:workbench.briefing_label')}
    >
      <header className="wb-ai-briefing-header">
        <Sparkle className="h-4 w-4 text-primary" weight="fill" aria-hidden />
        {t('generativeUi:workbench.briefing_label')}
      </header>
      <div className="wb-ai-briefing-body">
        <GenerativeUIPanel
          intent={intent}
          showChrome={false}
          actionHandlers={actionHandlers}
        />
      </div>
    </section>
  );
});

DesktopAiBriefingWidget.displayName = 'DesktopAiBriefingWidget';

export default DesktopAiBriefingWidget;
