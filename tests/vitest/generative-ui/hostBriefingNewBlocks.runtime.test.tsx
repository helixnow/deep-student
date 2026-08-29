/**
 * 宿主简报运行时：真实 builder → GenerativeUIRenderer，
 * DOM 必须能看到新块 table / chart / steps / markdown。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui';
import type { GenerativeUIIntent } from '@/features/generative-ui';
import { buildExamBriefingIntent } from '@/features/generative-ui/utils/buildExamBriefingIntent';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';
import { buildIndexStatusBriefingIntent } from '@/features/generative-ui/utils/buildIndexStatusBriefingIntent';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { buildTranslationBriefingIntent } from '@/features/generative-ui/utils/buildTranslationBriefingIntent';
import { buildAiDashboardIntent } from '@/features/generative-ui/utils/buildAiDashboardIntent';
import { buildNoteSummaryIntent } from '@/features/generative-ui/utils/buildNoteSummaryIntent';
import { buildHpiasResearchDashboardIntent } from '@/features/generative-ui/utils/buildHpiasResearchDashboardIntent';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析',
        unknown_block_title: `未知：${params?.type ?? ''}`,
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
        'blocks.table.empty': '暂无数据',
        'blocks.chart.empty': '暂无图表数据',
        'blocks.markdown.empty': '暂无正文',
        'blocks.steps.status_pending': '待开始',
        'blocks.steps.status_active': '进行中',
        'blocks.steps.status_done': '已完成',
        'a11y.table_caption': '数据表',
        'a11y.table_label': '表格',
        'a11y.chart_label': `${params?.title ?? ''} ${params?.kind ?? ''} 图表`.trim(),
        'a11y.chart_empty': '暂无图表数据',
        'a11y.steps_label': '步骤',
        'a11y.markdown_label': '正文',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import '@/features/generative-ui/blocks';

const NEW_BLOCK_INNER: Record<'table' | 'chart' | 'steps' | 'markdown', string> = {
  table: '[data-generative-table]',
  chart: '[data-generative-chart]',
  steps: '[data-generative-steps]',
  markdown: '[data-generative-markdown]',
};

function expectNewBlocksInDom(
  container: HTMLElement,
  types: Array<keyof typeof NEW_BLOCK_INNER>,
): void {
  expect(container.querySelector('[data-generative-validation-error]')).toBeNull();
  expect(container.querySelector('[data-generative-unknown-block]')).toBeNull();
  expect(container.querySelector('[data-block-invalid]')).toBeNull();
  for (const type of types) {
    const slot = container.querySelector(`[data-generative-block="${type}"]`);
    expect(slot, `missing [data-generative-block="${type}"]`).toBeTruthy();
    const inner = container.querySelector(NEW_BLOCK_INNER[type]);
    expect(inner, `missing inner ${type} block ${NEW_BLOCK_INNER[type]}`).toBeTruthy();
  }
}

function renderIntent(intent: GenerativeUIIntent) {
  return render(<GenerativeUIRenderer intent={intent} showChrome={false} />);
}

const EXAM_LABELS = {
  totalTitle: 'Total',
  masteryTrend: 'Mastery {{percent}}%',
  emptyTrend: 'Empty',
  progressTitle: 'Progress',
  masteredRow: '{{count}} mastered',
  reviewRow: 'Review',
  correctRateRow: 'Correct',
  startReview: 'Start review',
  openPractice: 'Practice',
  tableTitle: 'Mastery table',
  tableMetricColumn: 'Metric',
  tableValueColumn: 'Value',
  chartTitle: 'Distribution',
  chartSeries: 'Questions',
  masteredCategory: 'Mastered',
  inProgressRow: 'In progress',
};

const MEMORY_LABELS = {
  countTitle: 'Memories',
  activeTrend: 'Active',
  emptyTrend: 'Empty',
  overviewTitle: 'Overview',
  rootFolderRow: 'Root',
  autoExtractRow: 'Auto extract',
  freqOff: 'Off',
  freqBalanced: 'Balanced',
  freqAggressive: 'Aggressive',
  refresh: 'Refresh',
  createMemory: 'Create',
  recentListTitle: 'Recent',
  recentEmpty: 'No entries',
  openMemory: 'Open',
  emptyGuideTitle: 'Get started',
  emptyGuideBody: 'Create your first memory card.',
  stepsTitle: 'Next steps',
};

const INDEX_LABELS = {
  totalTitle: 'Total',
  progressTitle: 'Progress',
  indexedRow: '{{count}} indexed',
  pendingRow: 'Pending',
  failedRow: 'Failed',
  indexingRow: 'Indexing',
  allIndexedTrend: 'Ready',
  needsAttentionTrend: 'Attention',
  batchIndex: 'Index all',
  refresh: 'Refresh',
  failedAlertTitle: 'Index errors',
  failedAlertDescription: 'Retry failed items',
  failedMarkdownTitle: 'Failed notes',
  failedMarkdownBody: '2 resources failed indexing.',
  statusTableTitle: 'Index status',
};

const HUB_LABELS = {
  statTitle: 'Resources',
  emptyTrend: 'Empty',
  activeTrend: 'Active',
  startReview: 'Review',
  openQbank: 'QBank',
  dueReviewTitle: 'Due',
  dueReviewTrend: 'Items due',
  reviewCalendarTitle: 'Calendar',
  recentListTitle: 'Recent',
  recentEmpty: 'No resources',
  pathStepsTitle: 'Path',
  chartTitle: 'Due trend',
  chartDue: 'Due today',
  chartSeries: 'Cards',
};

const TRANSLATION_LABELS = {
  sourceStatTitle: 'Source',
  translatedStatTitle: 'Translated',
  emptyTrend: 'Empty',
  progressTitle: 'Progress',
  translatedRow: '{{count}} done',
  languagePairRow: 'Languages',
  formalityRow: 'Tone',
  domainRow: 'Domain',
  glossaryRow: 'Glossary',
  openSettings: 'Settings',
  copyTranslation: 'Copy',
  countChartTitle: 'Char counts',
  countChartSeries: 'Chars',
};

const DASHBOARD_LABELS = {
  dueFlashcardsTitle: 'Due flashcards',
  dueTrendDue: 'To review',
  dueTrendNone: 'None due',
  progressTitle: 'Todo progress',
  overdueLabel: '{{count}} overdue',
  pendingLabel: '{{count}} pending',
  startReview: 'Start review',
  openQbank: 'Open qbank',
  ankiTasksTitle: 'Active tasks',
  ankiTasksTrendActive: 'Running',
  ankiTasksTrendIdle: 'Idle',
  openTaskDashboard: 'Open tasks',
  workloadChartTitle: 'Workload',
  chartPending: 'Pending',
  chartOverdue: 'Overdue',
  workloadChartSeries: 'Items',
};

const NOTE_LABELS = {
  defaultTitle: 'Summary',
  updatedPrefix: 'Updated',
  headingStatTitle: 'Sections',
  overviewTitle: 'Overview',
  charCountKey: 'Chars',
  tagsKey: 'Tags',
  tagsEmpty: '—',
  headingsTitle: 'Headings',
  markdownOverviewTitle: 'Note overview',
};

const HPIAS_LABELS = {
  stepPlan: 'Plan',
  stepRetrieval: 'Retrieval',
  stepSelection: 'Selection',
  stepSubagents: 'Subagents',
  stepSynthesis: 'Synthesis',
  subagentFallback: 'Sub {{id}}',
  metaTitle: 'Research',
  roundLabel: 'Round',
  planTitle: 'Task',
  retrievalStatTitle: 'Retrieved',
  selectedStatTitle: 'Selected',
  reportMetaTitle: 'Report',
  citationStatTitle: 'Citations',
  copyReport: 'Copy report',
  exportPlan: 'Export plan',
  exportIntent: 'Export all intents',
  stepsBlockTitle: 'Pipeline',
};

describe('hostBriefingNewBlocks.runtime — builder + Renderer', () => {
  it.each([
    {
      host: 'ExamGenerativeBriefing',
      blocks: ['chart', 'table'] as const,
      build: () =>
        buildExamBriefingIntent({
          stats: {
            total: 20,
            mastered: 10,
            review: 3,
            inProgress: 5,
            newCount: 2,
            correctRate: 0.75,
          },
          examName: 'Linear Algebra',
          labels: EXAM_LABELS,
        }),
    },
    {
      host: 'MemoryGenerativeBriefing',
      blocks: ['steps', 'table'] as const,
      build: () =>
        buildMemoryBriefingIntent({
          memoryCount: 8,
          rootFolderTitle: 'Study Notes',
          autoExtractFrequency: 'balanced',
          recentItems: [{ label: 'Eigenvalues', badge: 'note' }],
          labels: MEMORY_LABELS,
        }),
    },
    {
      host: 'MemoryGenerativeBriefing (empty)',
      blocks: ['steps', 'table', 'markdown'] as const,
      build: () => buildMemoryBriefingIntent({ memoryCount: 0, labels: MEMORY_LABELS }),
    },
    {
      host: 'IndexStatusGenerativeBriefing',
      blocks: ['table', 'markdown'] as const,
      build: () =>
        buildIndexStatusBriefingIntent({
          summary: {
            totalResources: 15,
            indexedCount: 10,
            pendingCount: 3,
            failedCount: 2,
            indexingCount: 0,
          },
          labels: INDEX_LABELS,
        }),
    },
    {
      host: 'LearningHubGenerativeBriefing',
      blocks: ['steps', 'chart'] as const,
      build: () =>
        buildLearningHubBriefingIntent({
          resourceCount: 12,
          folderLabel: 'Notes',
          dueReviewCount: 3,
          reviewDays: [{ date: '2026-08-24', dueCount: 3, label: 'Mon' }],
          recentResources: [{ label: 'note.md' }],
          labels: HUB_LABELS,
        }),
    },
    {
      host: 'TranslationGenerativeBriefing',
      blocks: ['chart'] as const,
      build: () =>
        buildTranslationBriefingIntent({
          sourceChars: 100,
          translatedChars: 60,
          srcLangLabel: 'English',
          tgtLangLabel: 'Chinese',
          formalityLabel: 'Formal',
          domainLabel: 'Technical',
          glossaryCount: 2,
          labels: TRANSLATION_LABELS,
        }),
    },
    {
      host: 'AiDashboard',
      blocks: ['chart'] as const,
      build: () =>
        buildAiDashboardIntent(
          { dueFlashcards: 5, pendingTodos: 2, overdueTodos: 1, activeAnkiTasks: 2 },
          DASHBOARD_LABELS,
        ),
    },
    {
      host: 'NotesGenerativeSummary',
      blocks: ['markdown'] as const,
      build: () =>
        buildNoteSummaryIntent({
          title: 'Linear Algebra',
          tags: ['math'],
          headingCount: 2,
          charCount: 1200,
          topHeadings: ['Eigenvalues'],
          labels: NOTE_LABELS,
        }),
    },
    {
      host: 'HpiasGenerativeResearchPanel',
      blocks: ['steps'] as const,
      build: () => {
        const intent = buildHpiasResearchDashboardIntent({
          snapshot: {
            sessionId: 's1',
            round: 1,
            plan: { core: { queries: ['Q1'] } },
            synthesis: 'Finding summary.',
            retrievalCount: 20,
            selectedCount: 5,
            subAgents: {},
          },
          question: 'Test question?',
          labels: HPIAS_LABELS,
        });
        if (!intent) {
          throw new Error('expected HPIAS dashboard intent');
        }
        return intent;
      },
    },
  ])('$host intent exposes $blocks in the DOM', ({ blocks, build }) => {
    const { container } = renderIntent(build());
    expectNewBlocksInDom(container, [...blocks]);
  });

  it('covers all four new block types across host builders', () => {
    const seen = new Set<string>();
    const hosts: Array<{ build: () => GenerativeUIIntent; types: Array<keyof typeof NEW_BLOCK_INNER> }> = [
      {
        types: ['chart', 'table'],
        build: () =>
          buildExamBriefingIntent({
            stats: {
              total: 12,
              mastered: 6,
              review: 2,
              inProgress: 3,
              newCount: 1,
              correctRate: 0.8,
            },
            labels: EXAM_LABELS,
          }),
      },
      {
        types: ['steps', 'markdown'],
        build: () => buildMemoryBriefingIntent({ memoryCount: 0, labels: MEMORY_LABELS }),
      },
    ];
    for (const { build, types } of hosts) {
      const { container, unmount } = renderIntent(build());
      expectNewBlocksInDom(container, types);
      for (const type of types) seen.add(type);
      unmount();
    }
    expect([...seen].sort()).toEqual(['chart', 'markdown', 'steps', 'table']);
  });
});
