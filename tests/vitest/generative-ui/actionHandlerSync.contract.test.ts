import { describe, it, expect } from 'vitest';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { buildExamBriefingIntent } from '@/features/generative-ui/utils/buildExamBriefingIntent';
import { workbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import { learningHubActionHandlers } from '@/features/generative-ui/handlers/learningHubActionHandlers';
import { createExamBriefingActionHandlers } from '@/features/generative-ui/handlers/examBriefingActionHandlers';
import { createIndexStatusBriefingActionHandlers } from '@/features/generative-ui/handlers/indexStatusBriefingActionHandlers';
import { createMemoryBriefingActionHandlers } from '@/features/generative-ui/handlers/memoryBriefingActionHandlers';
import { buildIndexStatusBriefingIntent } from '@/features/generative-ui/utils/buildIndexStatusBriefingIntent';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

function collectActionBarIds(intent: GenerativeUIIntent): string[] {
  return intent.blocks
    .filter((b) => b.type === 'action-bar')
    .flatMap((b) => {
      const actions = (b.props as { actions?: Array<{ id: string }> })?.actions ?? [];
      return actions.map((a) => a.id);
    });
}

function expectActionIdsRegistered(
  intent: GenerativeUIIntent,
  handlers: Record<string, unknown>,
  source: string,
) {
  for (const id of collectActionBarIds(intent)) {
    expect(handlers, `${source}: missing handler for action "${id}"`).toHaveProperty(id);
  }
}

describe('generativeUI actionHandlerSync contract', () => {
  const briefingLabels = {
    dueFlashcardsTitle: 'Due',
    dueTrendDue: 'Due',
    dueTrendNone: 'None',
    progressTitle: 'Todos',
    overdueLabel: '{{n}} overdue',
    pendingLabel: '{{n}} pending',
    startReview: 'Review',
    openQbank: 'QBank',
  };

  it('briefing intent action ids exist in workbenchLearningHandlers', () => {
    const intent = buildLearningBriefingIntent(
      { dueFlashcards: 1, pendingTodos: 2, overdueTodos: 0 },
      briefingLabels,
    );
    expectActionIdsRegistered(intent, workbenchLearningHandlers, 'buildLearningBriefingIntent');
  });

  it('learning hub briefing action ids exist in learningHubActionHandlers', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 3,
      folderLabel: 'Notes',
      labels: {
        statTitle: 'Resources',
        emptyTrend: 'Empty',
        activeTrend: 'Active',
        startReview: 'Review',
        openQbank: 'QBank',
      },
    });
    expectActionIdsRegistered(intent, learningHubActionHandlers, 'buildLearningHubBriefingIntent');
  });

  it('exam briefing action ids exist in createExamBriefingActionHandlers', () => {
    const intent = buildExamBriefingIntent({
      stats: {
        total: 10,
        mastered: 4,
        review: 2,
        inProgress: 2,
        newCount: 2,
        correctRate: 0.6,
      },
      labels: {
        totalTitle: 'Total',
        masteryTrend: '{{percent}}%',
        emptyTrend: 'Empty',
        progressTitle: 'Progress',
        masteredRow: '{{count}}',
        reviewRow: 'Review',
        correctRateRow: 'Correct',
        startReview: 'Review',
        openPractice: 'Practice',
      },
    });
    const handlers = createExamBriefingActionHandlers(
      { onStartReview: () => {}, onOpenPractice: () => {} },
      { startReview: 'Review', openPractice: 'Practice' },
    );
    expectActionIdsRegistered(intent, handlers, 'buildExamBriefingIntent');
  });

  it('index status briefing action ids exist in createIndexStatusBriefingActionHandlers', () => {
    const intent = buildIndexStatusBriefingIntent({
      summary: {
        totalResources: 5,
        indexedCount: 2,
        pendingCount: 2,
        failedCount: 1,
        indexingCount: 0,
      },
      labels: {
        totalTitle: 'Total',
        progressTitle: 'Progress',
        indexedRow: '{{count}}',
        pendingRow: 'Pending',
        failedRow: 'Failed',
        indexingRow: 'Indexing',
        allIndexedTrend: 'Ready',
        needsAttentionTrend: 'Attention',
        batchIndex: 'Index',
        refresh: 'Refresh',
      },
    });
    const handlers = createIndexStatusBriefingActionHandlers(
      { onBatchIndex: () => {}, onRefresh: () => {} },
      { batchIndex: 'Index', refresh: 'Refresh' },
    );
    expectActionIdsRegistered(intent, handlers, 'buildIndexStatusBriefingIntent');
  });

  it('memory briefing action ids exist in createMemoryBriefingActionHandlers', () => {
    const intent = buildMemoryBriefingIntent({
      memoryCount: 3,
      labels: {
        countTitle: 'Count',
        activeTrend: 'Active',
        emptyTrend: 'Empty',
        overviewTitle: 'Overview',
        rootFolderRow: 'Root',
        autoExtractRow: 'Auto',
        freqOff: 'Off',
        freqBalanced: 'Balanced',
        freqAggressive: 'Aggressive',
        refresh: 'Refresh',
        createMemory: 'Create',
      },
    });
    const handlers = createMemoryBriefingActionHandlers(
      { onRefresh: () => {}, onCreateMemory: () => {} },
      { refresh: 'Refresh', createMemory: 'Create' },
    );
    expectActionIdsRegistered(intent, handlers, 'buildMemoryBriefingIntent');
  });

  it('LEARNING_DASHBOARD_EXAMPLE action ids exist in workbenchLearningHandlers', () => {
    expectActionIdsRegistered(LEARNING_DASHBOARD_EXAMPLE, workbenchLearningHandlers, 'LEARNING_DASHBOARD_EXAMPLE');
  });
});
