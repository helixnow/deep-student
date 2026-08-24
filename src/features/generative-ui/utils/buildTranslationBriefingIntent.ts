/**
 * 翻译会话简报 — 确定性意图构建（Translation #7 POC）
 */
import type { GenerativeUIIntent } from '../types';
import type { ActionBarProps } from '../schema';
import { buildChartIntent } from './buildChartIntent';

export interface TranslationBriefingSegment {
  label: string;
  description?: string;
  badge?: string;
}

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
  emptySourceTitle?: string;
  emptySourceDescription?: string;
  segmentsTitle?: string;
  segmentsEmpty?: string;
  countChartTitle?: string;
  countChartSeries?: string;
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
  recentSegments?: TranslationBriefingSegment[];
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
    recentSegments = [],
    labels,
  } = input;

  const hasSource = sourceChars > 0;
  const hasTranslation = translatedChars > 0;

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

  const segmentItems = recentSegments
    .filter((item) => item.label.trim().length > 0)
    .slice(0, 8)
    .map((item) => ({
      label: item.label.slice(0, 200),
      ...(item.description ? { description: item.description.slice(0, 300) } : {}),
      ...(item.badge ? { badge: item.badge.slice(0, 40) } : {}),
    }));

  return {
    version: '1',
    blocks: [
      ...(!hasSource
        ? [
            {
              type: 'alert' as const,
              props: {
                variant: 'info' as const,
                title: labels.emptySourceTitle ?? labels.emptyTrend,
                description: labels.emptySourceDescription,
              },
            },
          ]
        : []),
      {
        type: 'stat-card',
        props: {
          title: labels.sourceStatTitle,
          value: sourceChars,
          trend: hasSource ? 'neutral' : 'down',
          trendLabel: hasSource ? undefined : labels.emptyTrend,
        },
      },
      {
        type: 'stat-card',
        props: {
          title: labels.translatedStatTitle,
          value: translatedChars,
          trend: hasTranslation ? 'up' : 'neutral',
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
      ...buildChartIntent({
        title: labels.countChartTitle ?? labels.progressTitle,
        kind: 'bar',
        categories: [labels.sourceStatTitle, labels.translatedStatTitle],
        series: [
          {
            name: (labels.countChartSeries ?? labels.sourceStatTitle).slice(0, 40),
            values: [sourceChars, translatedChars],
          },
        ],
        labels: {},
      }).blocks,
      {
        type: 'key-value-grid',
        props: { rows },
      },
      {
        type: 'list',
        props: {
          title: labels.segmentsTitle ?? labels.translatedStatTitle,
          items: segmentItems,
          emptyLabel: labels.segmentsEmpty ?? labels.emptyTrend,
        },
      },
      {
        type: 'action-bar',
        props: { actions },
      },
    ],
  };
}
