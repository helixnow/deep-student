import type { IntentExportMarkdownLabels } from './buildIntentExportMarkdown';
import type { ResearchExportMarkdownLabels } from './buildResearchExportMarkdown';

type Translate = (key: string) => string;

export interface ExportMarkdownI18nLabels {
  intent: IntentExportMarkdownLabels;
  research: ResearchExportMarkdownLabels;
}

/** Resolve export-only labels at a React i18n boundary; markdown builders stay pure. */
export function buildExportMarkdownI18nLabels(t: Translate): ExportMarkdownI18nLabels {
  return {
    intent: {
      emptyTable: t('export_markdown.empty_table'),
      chartKind: t('export_markdown.chart_kind'),
      chartUnit: t('export_markdown.chart_unit'),
      chartCategories: t('export_markdown.chart_categories'),
      chartSeriesFallback: t('export_markdown.chart_series'),
      statFallbackTitle: t('export_markdown.stat'),
      flashcardDeck: t('export_markdown.flashcard_deck'),
      flashcardFront: t('export_markdown.flashcard_front'),
      flashcardBack: t('export_markdown.flashcard_back'),
      flashcardTags: t('export_markdown.flashcard_tags'),
      reviewDayFallback: t('export_markdown.review_day'),
      reviewDue: t('export_markdown.review_due'),
      reviewDone: t('export_markdown.review_done'),
      mistakeErrorRate: t('export_markdown.mistake_error_rate'),
      mistakeCount: t('export_markdown.mistake_count'),
    },
    research: {
      researchPlan: t('export_markdown.research_plan'),
      queries: t('export_markdown.queries'),
      retrieval: t('export_markdown.retrieval'),
      retrieved: t('export_markdown.retrieved'),
      selected: t('export_markdown.selected'),
      report: t('export_markdown.report'),
    },
  };
}
