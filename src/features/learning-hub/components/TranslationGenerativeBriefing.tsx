import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import type { TranslationSession } from '@/dstu/adapters/translationDstuAdapter';
import { useTranslationStreamSnapshot } from '@/translation/translationStreamBridge';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildTranslationBriefingIntent } from '@/features/generative-ui/utils/buildTranslationBriefingIntent';
import { mergeTranslationBriefingMetrics } from '@/features/generative-ui/utils/mergeTranslationBriefingMetrics';
import { createTranslationBriefingActionHandlers } from '@/features/generative-ui/handlers/translationBriefingActionHandlers';
import './TranslationGenerativeBriefing.css';

export interface TranslationGenerativeBriefingProps {
  session: TranslationSession;
  /** DSTU node.id — 与 TranslateWorkbench publishKey 对齐 */
  streamKey?: string | null;
}

export const TranslationGenerativeBriefing: React.FC<TranslationGenerativeBriefingProps> = React.memo(
  ({ session, streamKey }) => {
    const { t } = useTranslation(['generativeUi', 'translation']);
    const streamSnapshot = useTranslationStreamSnapshot(streamKey);

    const metrics = useMemo(
      () =>
        mergeTranslationBriefingMetrics({
          sessionSourceText: session.sourceText,
          sessionTranslatedText: session.translatedText,
          stream: streamSnapshot,
        }),
      [session.sourceText, session.translatedText, streamSnapshot],
    );

    const srcLangLabel = t(`translation:languages.${session.srcLang}`, {
      defaultValue: session.srcLang,
    });
    const tgtLangLabel = t(`translation:languages.${session.tgtLang}`, {
      defaultValue: session.tgtLang,
    });
    const formalityLabel =
      session.formality && session.formality !== 'auto'
        ? t(`translation:formality_${session.formality}`, { defaultValue: session.formality })
        : undefined;

    const labels = useMemo(
      () => ({
        sourceStatTitle: t('generativeUi:translation.briefing.source_stat_title'),
        translatedStatTitle: t('generativeUi:translation.briefing.translated_stat_title'),
        emptyTrend: t('generativeUi:translation.briefing.empty_trend'),
        progressTitle: t('generativeUi:translation.briefing.progress_title'),
        streamingProgressTitle: t('generativeUi:translation.briefing.streaming_progress_title'),
        translatedRow: t('generativeUi:translation.briefing.translated_row'),
        languagePairRow: t('generativeUi:translation.briefing.language_pair_row'),
        formalityRow: t('generativeUi:translation.briefing.formality_row'),
        domainRow: t('generativeUi:translation.briefing.domain_row'),
        glossaryRow: t('generativeUi:translation.briefing.glossary_row'),
        openSettings: t('generativeUi:translation.briefing.open_settings'),
        copyTranslation: t('generativeUi:translation.briefing.copy_translation'),
        emptySourceTitle: t('generativeUi:translation.briefing.empty_source_title'),
        emptySourceDescription: t('generativeUi:translation.briefing.empty_source_description'),
        segmentsTitle: t('generativeUi:translation.briefing.segments_title'),
        segmentsEmpty: t('generativeUi:translation.briefing.segments_empty'),
        countChartTitle: t('generativeUi:translation.briefing.count_chart_title'),
        countChartSeries: t('generativeUi:translation.briefing.count_chart_series'),
      }),
      [t],
    );

    const intent = useMemo(
      () =>
        buildTranslationBriefingIntent({
          sourceChars: metrics.sourceChars,
          translatedChars: metrics.translatedChars,
          srcLangLabel,
          tgtLangLabel,
          formalityLabel,
          domainLabel: session.domain,
          glossaryCount: session.glossary?.length ?? 0,
          isStreaming: metrics.isStreaming,
          recentSegments: [
            ...(session.sourceText.trim()
              ? [{
                  label: session.sourceText.trim().split(/\n/)[0]?.slice(0, 200) ?? '',
                  badge: srcLangLabel.slice(0, 40),
                }]
              : []),
            ...(metrics.translatedText.trim()
              ? [{
                  label: metrics.translatedText.trim().split(/\n/)[0]?.slice(0, 200) ?? '',
                  badge: tgtLangLabel.slice(0, 40),
                }]
              : []),
          ],
          labels,
        }),
      [
        formalityLabel,
        labels,
        metrics.isStreaming,
        metrics.sourceChars,
        metrics.translatedChars,
        metrics.translatedText,
        session.domain,
        session.glossary?.length,
        session.sourceText,
        srcLangLabel,
        tgtLangLabel,
      ],
    );

    const onOpenSettings = useCallback(() => {
      window.dispatchEvent(new CustomEvent('translation:openSettings'));
    }, []);

    const actionHandlers = useMemo(
      () =>
        createTranslationBriefingActionHandlers(
          {
            onOpenSettings,
            getTranslatedText: () => metrics.translatedText,
          },
          {
            openSettings: labels.openSettings,
            copyTranslation: labels.copyTranslation,
          },
        ),
      [labels.copyTranslation, labels.openSettings, metrics.translatedText, onOpenSettings],
    );

    if (!session.sourceText && !session.translatedText && !metrics.isStreaming) {
      return null;
    }

    return (
      <section
        className="translation-generative-briefing"
        data-testid="translation-generative-briefing"
        data-streaming={metrics.isStreaming ? 'true' : 'false'}
        aria-label={t('generativeUi:translation.briefing_label')}
      >
        <header className="translation-generative-briefing-header">
          <Sparkle className="h-3.5 w-3.5 text-primary" weight="fill" aria-hidden />
          {t('generativeUi:translation.briefing_label')}
        </header>
        <GenerativeUIPanel
          intent={intent}
          isStreaming={metrics.isStreaming}
          showChrome={false}
          actionHandlers={actionHandlers}
        />
      </section>
    );
  },
);

TranslationGenerativeBriefing.displayName = 'TranslationGenerativeBriefing';

export default TranslationGenerativeBriefing;
