import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { learningHubActionHandlers } from '@/features/generative-ui/handlers/learningHubActionHandlers';
import { useFinderStore } from '../stores/finderStore';
import './LearningHubGenerativeBriefing.css';

export const LearningHubGenerativeBriefing: React.FC = React.memo(() => {
  const { t } = useTranslation(['generativeUi']);
  const items = useFinderStore((s) => s.items);
  const breadcrumbs = useFinderStore((s) => s.currentPath.breadcrumbs);

  const folderLabel = breadcrumbs?.[breadcrumbs.length - 1]?.name ?? t('generativeUi:learningHub.briefing.default_folder');

  const intent = useMemo(
    () =>
      buildLearningHubBriefingIntent({
        resourceCount: items.length,
        folderLabel,
        recentResources: items.slice(0, 8).map((item) => ({
          label: item.name,
        })),
        labels: {
          statTitle: t('generativeUi:learningHub.briefing.stat_title'),
          emptyTrend: t('generativeUi:learningHub.briefing.trend_empty'),
          activeTrend: t('generativeUi:learningHub.briefing.trend_active'),
          startReview: t('generativeUi:learningHub.briefing.start_review'),
          openQbank: t('generativeUi:learningHub.briefing.open_qbank'),
          dueReviewTitle: t('generativeUi:learningHub.briefing.due_review_title'),
          dueReviewTrend: t('generativeUi:learningHub.briefing.due_review_trend'),
          reviewCalendarTitle: t('generativeUi:learningHub.briefing.review_calendar_title'),
          recentListTitle: t('generativeUi:learningHub.briefing.recent_list_title'),
          recentEmpty: t('generativeUi:learningHub.briefing.recent_empty'),
          emptyAlertTitle: t('generativeUi:learningHub.briefing.empty_alert_title'),
          emptyAlertDescription: t('generativeUi:learningHub.briefing.empty_alert_description'),
        },
      }),
    [folderLabel, items, t],
  );

  return (
    <section
      className="lh-generative-briefing"
      data-testid="lh-generative-briefing"
      aria-label={t('generativeUi:learningHub.briefing_label', { defaultValue: 'AI 资源简报' })}
    >
      <header className="lh-generative-briefing-header">
        <Sparkle className="h-3.5 w-3.5 text-primary" weight="fill" aria-hidden />
        {t('generativeUi:learningHub.briefing_label', { defaultValue: 'AI 资源简报' })}
      </header>
      <GenerativeUIPanel intent={intent} showChrome={false} actionHandlers={learningHubActionHandlers} />
    </section>
  );
});

LearningHubGenerativeBriefing.displayName = 'LearningHubGenerativeBriefing';

export default LearningHubGenerativeBriefing;
