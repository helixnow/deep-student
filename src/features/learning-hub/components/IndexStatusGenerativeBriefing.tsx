import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import type { ResourceIndexStatusSummary } from '@/api/vfsUnifiedIndexApi';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildIndexStatusBriefingIntent } from '@/features/generative-ui/utils/buildIndexStatusBriefingIntent';
import { createIndexStatusBriefingActionHandlers } from '@/features/generative-ui/handlers/indexStatusBriefingActionHandlers';
import './IndexStatusGenerativeBriefing.css';

export interface IndexStatusGenerativeBriefingProps {
  summary: Pick<
    ResourceIndexStatusSummary,
    'totalResources' | 'indexedCount' | 'pendingCount' | 'failedCount' | 'indexingCount'
  >;
  onBatchIndex: () => void;
  onRefresh: () => void;
}

export const IndexStatusGenerativeBriefing: React.FC<IndexStatusGenerativeBriefingProps> = React.memo(
  ({ summary, onBatchIndex, onRefresh }) => {
    const { t } = useTranslation(['generativeUi']);

    const labels = useMemo(
      () => ({
        totalTitle: t('generativeUi:indexStatus.briefing.total_title'),
        progressTitle: t('generativeUi:indexStatus.briefing.progress_title'),
        indexedRow: t('generativeUi:indexStatus.briefing.indexed_row'),
        pendingRow: t('generativeUi:indexStatus.briefing.pending_row'),
        failedRow: t('generativeUi:indexStatus.briefing.failed_row'),
        indexingRow: t('generativeUi:indexStatus.briefing.indexing_row'),
        allIndexedTrend: t('generativeUi:indexStatus.briefing.trend_all_indexed'),
        needsAttentionTrend: t('generativeUi:indexStatus.briefing.trend_needs_attention'),
        batchIndex: t('generativeUi:indexStatus.briefing.batch_index'),
        refresh: t('generativeUi:indexStatus.briefing.refresh'),
        failedAlertTitle: t('generativeUi:indexStatus.briefing.failed_alert_title'),
        failedAlertDescription: t('generativeUi:indexStatus.briefing.failed_alert_description'),
        emptyIndexTitle: t('generativeUi:indexStatus.briefing.empty_index_title'),
        emptyIndexDescription: t('generativeUi:indexStatus.briefing.empty_index_description'),
        scanProgressTitle: t('generativeUi:indexStatus.briefing.scan_progress_title'),
        scanProgressLabel: t('generativeUi:indexStatus.briefing.scan_progress_label'),
        failedMarkdownTitle: t('generativeUi:indexStatus.briefing.failed_markdown_title'),
        failedMarkdownBody: t('generativeUi:indexStatus.briefing.failed_markdown_body'),
        statusTableTitle: t('generativeUi:indexStatus.briefing.status_table_title'),
        statusColName: t('generativeUi:indexStatus.briefing.status_col_name'),
        statusColCount: t('generativeUi:indexStatus.briefing.status_col_count'),
        indexedLabel: t('generativeUi:indexStatus.briefing.indexed_label'),
      }),
      [t],
    );

    const intent = useMemo(
      () => buildIndexStatusBriefingIntent({ summary, labels }),
      [labels, summary],
    );

    const actionHandlers = useMemo(
      () =>
        createIndexStatusBriefingActionHandlers(
          { onBatchIndex, onRefresh },
          { batchIndex: labels.batchIndex, refresh: labels.refresh },
        ),
      [labels.batchIndex, labels.refresh, onBatchIndex, onRefresh],
    );

    return (
      <section
        className="index-status-generative-briefing"
        data-testid="index-status-generative-briefing"
        aria-label={t('generativeUi:indexStatus.briefing_label')}
      >
        <header className="index-status-generative-briefing-header">
          <Sparkle className="h-3.5 w-3.5 text-primary" weight="fill" aria-hidden />
          {t('generativeUi:indexStatus.briefing_label')}
        </header>
        <GenerativeUIPanel intent={intent} showChrome={false} actionHandlers={actionHandlers} />
      </section>
    );
  },
);

IndexStatusGenerativeBriefing.displayName = 'IndexStatusGenerativeBriefing';

export default IndexStatusGenerativeBriefing;
