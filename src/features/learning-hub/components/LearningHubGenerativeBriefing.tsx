import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { workbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import { useFinderStore } from '../stores/finderStore';
import './LearningHubGenerativeBriefing.css';

export const LearningHubGenerativeBriefing: React.FC = React.memo(() => {
  const { t } = useTranslation(['generativeUi']);
  const items = useFinderStore((s) => s.items);
  const breadcrumbs = useFinderStore((s) => s.breadcrumbs);

  const folderLabel = breadcrumbs[breadcrumbs.length - 1]?.name ?? '资源库';

  const intent = useMemo(
    () =>
      buildLearningHubBriefingIntent({
        resourceCount: items.length,
        folderLabel,
      }),
    [folderLabel, items.length],
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
      <GenerativeUIPanel intent={intent} showChrome={false} actionHandlers={workbenchLearningHandlers} />
    </section>
  );
});

LearningHubGenerativeBriefing.displayName = 'LearningHubGenerativeBriefing';

export default LearningHubGenerativeBriefing;
