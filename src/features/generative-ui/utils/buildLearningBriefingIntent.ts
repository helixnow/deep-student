import type { GenerativeUIIntent } from '../types';
import { buildTableIntent } from './buildTableIntent';

export interface LearningBriefingInput {
  dueFlashcards?: number;
  pendingTodos?: number;
  overdueTodos?: number;
  /** 传入错题 / 笔记任一条后，首卡改为三条复习线合计的「今日待复习」（需配 dueReviewTitle） */
  dueMistakes?: number;
  dueNotes?: number;
}

export interface LearningBriefingLabels {
  dueFlashcardsTitle: string;
  dueTrendDue: string;
  dueTrendNone: string;
  progressTitle: string;
  /** 待办统计卡标题（旧调用方未传时回退 progressTitle） */
  todosTitle?: string;
  /** 无逾期时的趋势文案（旧调用方未传时回退 pendingLabel） */
  noOverdueLabel?: string;
  overdueLabel: string;
  pendingLabel: string;
  startReview: string;
  openQbank: string;
  dueMistakesTitle?: string;
  dueNotesTitle?: string;
  dueReviewTitle?: string;
  /** 合计卡的分项说明，占位符 {{cards}} {{mistakes}} {{notes}} */
  dueBreakdown?: string;
}

function categoryFromCountLabel(template: string, fallback: string): string {
  const stripped = template.replace(/\{\{count\}\}/g, '').replace(/\s+/g, ' ').trim();
  return stripped || fallback;
}

export function buildLearningBriefingIntent(
  input: LearningBriefingInput,
  labels: LearningBriefingLabels,
): GenerativeUIIntent {
  const { dueFlashcards = 0, pendingTodos = 0, overdueTodos = 0 } = input;
  const combined = Boolean(labels.dueReviewTitle) && (input.dueMistakes !== undefined || input.dueNotes !== undefined);
  const dueMistakes = combined ? input.dueMistakes ?? 0 : 0;
  const dueNotes = combined ? input.dueNotes ?? 0 : 0;
  const totalDue = dueFlashcards + dueMistakes + dueNotes;
  const reviewRows = [
    { metric: labels.dueFlashcardsTitle, count: dueFlashcards },
    ...(combined && labels.dueMistakesTitle ? [{ metric: labels.dueMistakesTitle, count: dueMistakes }] : []),
    ...(combined && labels.dueNotesTitle ? [{ metric: labels.dueNotesTitle, count: dueNotes }] : []),
  ];
  const reviewCard = combined
    ? {
        title: labels.dueReviewTitle as string,
        value: totalDue,
        trend: totalDue > 0 ? ('up' as const) : ('neutral' as const),
        trendLabel: totalDue > 0 && labels.dueBreakdown
          ? labels.dueBreakdown
            .replace('{{cards}}', String(dueFlashcards))
            .replace('{{mistakes}}', String(dueMistakes))
            .replace('{{notes}}', String(dueNotes))
          : totalDue > 0 ? labels.dueTrendDue : labels.dueTrendNone,
      }
    : {
        title: labels.dueFlashcardsTitle,
        value: dueFlashcards,
        trend: dueFlashcards > 0 ? ('up' as const) : ('neutral' as const),
        trendLabel: dueFlashcards > 0 ? labels.dueTrendDue : labels.dueTrendNone,
      };
  const hasWorkload = totalDue > 0 || pendingTodos > 0 || overdueTodos > 0;
  const workloadTable = hasWorkload
    ? buildTableIntent({
        title: labels.progressTitle,
        columns: [
          { key: 'metric', label: labels.progressTitle.slice(0, 80) },
          { key: 'count', label: labels.dueTrendDue.slice(0, 80), align: 'right' },
        ],
        rows: [
          ...reviewRows,
          {
            metric: categoryFromCountLabel(labels.pendingLabel, labels.progressTitle),
            count: pendingTodos,
          },
          {
            metric: categoryFromCountLabel(labels.overdueLabel, labels.progressTitle),
            count: overdueTodos,
          },
        ],
        labels: {},
      }).blocks
    : [];

  return {
    version: '1',
    blocks: [
      {
        type: 'stat-card',
        props: reviewCard,
      },
      // 待办只有未完成清单、没有完成数：此前画成「(待办 − 逾期) / 待办」的进度条，
      // 1 项待办、0 逾期显示满格 100%，读起来像「全部完成」。改为统计卡：待办数 + 逾期提示。
      {
        type: 'stat-card',
        props: {
          title: labels.todosTitle ?? labels.progressTitle,
          value: pendingTodos,
          trend: overdueTodos > 0 ? 'down' : 'neutral',
          trendLabel:
            overdueTodos > 0
              ? labels.overdueLabel.replace('{{count}}', String(overdueTodos))
              : (labels.noOverdueLabel ?? labels.pendingLabel.replace('{{count}}', String(pendingTodos))),
        },
      },
      ...workloadTable,
      {
        type: 'action-bar',
        props: {
          actions: [
            { id: 'start-review', label: labels.startReview, variant: 'primary', riskLevel: 'low' },
            { id: 'open-qbank', label: labels.openQbank, variant: 'default', riskLevel: 'low' },
          ],
        },
      },
    ],
  };
}
