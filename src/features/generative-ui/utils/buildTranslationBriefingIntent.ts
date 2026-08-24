/**
 * 翻译会话简报 — 确定性意图构建（Translation #7 POC）
 */
import type { GenerativeUIIntent } from '../types';
import type { ActionBarProps } from '../schema';

export interface TranslationBriefingLabels {
  sourceStatTitle: string;
  translatedStatTitle: string;
  emptyTrend: string;
  progressTitle: string;
  streamingProgressTitle?: string;
  translatedRow: string;
  languagePairRow: string;
  formalityRow: string;
  domainRow: string;
  glossaryRow: string;
  openSettings: string;
  copyTranslation: string;
}

export interface TranslationBriefingInput {
  sourceChars: number;
  translatedChars: number;
  srcLangLabel: string;
  tgtLangLabel: string;
  formalityLabel?: string;
  domainLabel?: string;
  glossaryCount?: number;
  isStreaming?: boolean;
  labels: TranslationBriefingLabels;
}

export function buildTranslationBriefingIntent(input: TranslationBriefingInput): GenerativeUIIntent {
  const {
    sourceChars,
    translatedChars,
    srcLangLabel,
    tgtLangLabel,
    formalityLabel,
    domainLabel,
    glossaryCount = 0,
    isStreaming = false,
    labels,
  } = input;

  const hasSource = sourceChars > 0;
  const hasTranslation = translatedChars > 0;
  const completionRatio = hasSource ? Math.min(1, translatedChars / sourceChars) : 0;

  const rows: Array<{ key: string; value: string }> = [
    {
      key: labels.languagePairRow,
      value: `${srcLangLabel} → ${tgtLangLabel}`,
    },
  ];
  if (formalityLabel) {
    rows.push({ key: labels.formalityRow, value: formalityLabel });
  }
  if (domainLabel) {
    rows.push({ key: labels.domainRow, value: domainLabel });
  }
  if (glossaryCount > 0) {
    rows.push({
      key: labels.glossaryRow,
      value: String(glossaryCount),
    });
  }

  const actions: ActionBarProps['actions'] = [
    {
      id: 'open-settings',
      label: labels.openSettings,
      variant: 'default' as const,
      riskLevel: 'low' as const,
    },
  ];
  if (hasTranslation) {
    actions.unshift({
      id: 'copy-translation',
      label: labels.copyTranslation,
      variant: 'primary' as const,
      riskLevel: 'low' as const,
    });
  }

  return {
    version: '1',
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: labels.sourceStatTitle,
          value: sourceChars,
          trend: hasSource ? 'neutral' : 'down',
          trendLabel: hasSource ? undefined : labels.emptyTrend,
        },
      },
      ...(hasSource
        ? [
            {
              type: 'progress' as const,
              props: {
                title: isStreaming
                  ? (labels.streamingProgressTitle ?? labels.progressTitle)
                  : labels.progressTitle,
                current: translatedChars,
                total: Math.max(sourceChars, 1),
                label: labels.translatedRow.replace('{{count}}', String(translatedChars)),
              },
            },
          ]
        : []),
      {
        type: 'key-value-grid',
        props: { rows },
      },
      {
        type: 'action-bar',
        props: { actions },
      },
    ],
  };
}
