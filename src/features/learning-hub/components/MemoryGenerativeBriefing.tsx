import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import type { AutoExtractFrequency } from '@/api/memoryApi';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';
import { createMemoryBriefingActionHandlers } from '@/features/generative-ui/handlers/memoryBriefingActionHandlers';
import './MemoryGenerativeBriefing.css';

export interface MemoryGenerativeBriefingProps {
  memoryCount: number;
  rootFolderTitle?: string;
  autoExtractFrequency?: AutoExtractFrequency;
  onRefresh: () => void;
  onCreateMemory: () => void;
}

export const MemoryGenerativeBriefing: React.FC<MemoryGenerativeBriefingProps> = React.memo(
  ({ memoryCount, rootFolderTitle, autoExtractFrequency, onRefresh, onCreateMemory }) => {
    const { t } = useTranslation(['generativeUi']);

    const labels = useMemo(
      () => ({
        countTitle: t('generativeUi:memory.briefing.count_title'),
        activeTrend: t('generativeUi:memory.briefing.trend_active'),
        emptyTrend: t('generativeUi:memory.briefing.trend_empty'),
        overviewTitle: t('generativeUi:memory.briefing.overview_title'),
        rootFolderRow: t('generativeUi:memory.briefing.root_folder_row'),
        autoExtractRow: t('generativeUi:memory.briefing.auto_extract_row'),
        freqOff: t('generativeUi:memory.briefing.freq_off'),
        freqBalanced: t('generativeUi:memory.briefing.freq_balanced'),
        freqAggressive: t('generativeUi:memory.briefing.freq_aggressive'),
        refresh: t('generativeUi:memory.briefing.refresh'),
        createMemory: t('generativeUi:memory.briefing.create_memory'),
      }),
      [t],
    );

    const intent = useMemo(
      () =>
        buildMemoryBriefingIntent({
          memoryCount,
          rootFolderTitle,
          autoExtractFrequency,
          labels,
        }),
      [autoExtractFrequency, labels, memoryCount, rootFolderTitle],
    );

    const actionHandlers = useMemo(
      () =>
        createMemoryBriefingActionHandlers(
          { onRefresh, onCreateMemory },
          { refresh: labels.refresh, createMemory: labels.createMemory },
        ),
      [labels.createMemory, labels.refresh, onCreateMemory, onRefresh],
    );

    return (
      <section
        className="memory-generative-briefing"
        data-testid="memory-generative-briefing"
        aria-label={t('generativeUi:memory.briefing_label')}
      >
        <header className="memory-generative-briefing-header">
          <Sparkle className="h-3.5 w-3.5 text-primary" weight="fill" aria-hidden />
          {t('generativeUi:memory.briefing_label')}
        </header>
        <GenerativeUIPanel intent={intent} showChrome={false} actionHandlers={actionHandlers} />
      </section>
    );
  },
);

MemoryGenerativeBriefing.displayName = 'MemoryGenerativeBriefing';

export default MemoryGenerativeBriefing;
