import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import type { TranslationSession } from '@/dstu/adapters/translationDstuAdapter';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildTranslationBriefingIntent } from '@/features/generative-ui/utils/buildTranslationBriefingIntent';
import { createTranslationBriefingActionHandlers } from '@/features/generative-ui/handlers/translationBriefingActionHandlers';
import './TranslationGenerativeBriefing.css';

export interface TranslationGenerativeBriefingProps {
  session: TranslationSession;
}

export const TranslationGenerativeBriefing: React.FC<TranslationGenerativeBriefingProps> = React.memo(
  ({ session }) => {
    const { t } = useTranslation(['generativeUi', 'translation']);

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
        translatedRow: t('generativeUi:translation.briefing.translated_row'),
        languagePairRow: t('generativeUi:translation.briefing.language_pair_row'),
        formalityRow: t('generativeUi:translation.briefing.formality_row'),
        domainRow: t('generativeUi:translation.briefing.domain_row'),
        glossaryRow: t('generativeUi:translation.briefing.glossary_row'),
        openSettings: t('generativeUi:translation.briefing.open_settings'),
        copyTranslation: t('generativeUi:translation.briefing.copy_translation'),
      }),
      [t],
    );

    const intent = useMemo(
      () =>
        buildTranslationBriefingIntent({
          sourceChars: session.sourceText.length,
          translatedChars: session.translatedText.length,
          srcLangLabel,
          tgtLangLabel,
          formalityLabel,
          domainLabel: session.domain,
          glossaryCount: session.glossary?.length ?? 0,
          labels,
        }),
      [formalityLabel, labels, session.domain, session.glossary?.length, session.sourceText.length, session.translatedText.length, srcLangLabel, tgtLangLabel],
    );

    const onOpenSettings = useCallback(() => {
      window.dispatchEvent(new CustomEvent('translation:openSettings'));
    }, []);

    const actionHandlers = useMemo(
      () =>
        createTranslationBriefingActionHandlers(
          {
            onOpenSettings,
            getTranslatedText: () => session.translatedText,
          },
          {
            openSettings: labels.openSettings,
            copyTranslation: labels.copyTranslation,
          },
        ),
      [labels.copyTranslation, labels.openSettings, onOpenSettings, session.translatedText],
    );

    if (!session.sourceText && !session.translatedText) {
      return null;
    }

    return (
      <section
        className="translation-generative-briefing"
        data-testid="translation-generative-briefing"
        aria-label={t('generativeUi:translation.briefing_label')}
      >
        <header className="translation-generative-briefing-header">
          <Sparkle className="h-3.5 w-3.5 text-primary" weight="fill" aria-hidden />
          {t('generativeUi:translation.briefing_label')}
        </header>
        <GenerativeUIPanel intent={intent} showChrome={false} actionHandlers={actionHandlers} />
      </section>
    );
  },
);

TranslationGenerativeBriefing.displayName = 'TranslationGenerativeBriefing';

export default TranslationGenerativeBriefing;
