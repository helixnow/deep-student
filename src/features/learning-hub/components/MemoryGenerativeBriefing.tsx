import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import type { AutoExtractFrequency } from '@/api/memoryApi';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';
import { createMemoryBriefingActionHandlers } from '@/features/generative-ui/handlers/memoryBriefingActionHandlers';
import './MemoryGenerativeBriefing.css';

export interface MemoryGenerativeBriefingListItem {
  label: string;
  description?: string;
  badge?: string;
}

export interface MemoryGenerativeBriefingProps {
  memoryCount: number;
  rootFolderTitle?: string;
  autoExtractFrequency?: AutoExtractFrequency;
  recentItems?: MemoryGenerativeBriefingListItem[];
  onRefresh: () => void;
  onCreateMemory: () => void;
  onOpenMemory?: () => void;
}

export const MemoryGenerativeBriefing: React.FC<MemoryGenerativeBriefingProps> = React.memo(
  ({ memoryCount, rootFolderTitle, autoExtractFrequency, recentItems, onRefresh, onCreateMemory, onOpenMemory }) => {
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
        recentListTitle: t('generativeUi:memory.briefing.recent_list_title'),
        recentEmpty: t('generativeUi:memory.briefing.recent_empty'),
        openMemory: t('generativeUi:memory.briefing.open_memory'),
        emptyGuideTitle: t('generativeUi:memory.briefing.empty_guide_title'),
        emptyGuideBody: t('generativeUi:memory.briefing.empty_guide_body'),
        stepsTitle: t('generativeUi:memory.briefing.steps_title'),
        stepCreate: t('generativeUi:memory.briefing.step_create'),
        stepOpen: t('generativeUi:memory.briefing.step_open'),
        stepRefresh: t('generativeUi:memory.briefing.step_refresh'),
        recentColTitle: t('generativeUi:memory.briefing.recent_col_title'),
        recentColDetail: t('generativeUi:memory.briefing.recent_col_detail'),
      }),
      [t],
    );

    const intent = useMemo(
      () =>
        buildMemoryBriefingIntent({
          memoryCount,
          rootFolderTitle,
          autoExtractFrequency,
          recentItems,
          labels,
        }),
      [autoExtractFrequency, labels, memoryCount, recentItems, rootFolderTitle],
    );

    const actionHandlers = useMemo(
      () =>
        createMemoryBriefingActionHandlers(
          { onRefresh, onCreateMemory, onOpenMemory },
          {
            refresh: labels.refresh,
            createMemory: labels.createMemory,
            openMemory: labels.openMemory,
          },
        ),
      [labels.createMemory, labels.openMemory, labels.refresh, onCreateMemory, onOpenMemory, onRefresh],
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
