import { describe, it, expect } from 'vitest';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';
import { buildAiDashboardIntent } from '@/features/generative-ui/utils/buildAiDashboardIntent';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { buildExamBriefingIntent } from '@/features/generative-ui/utils/buildExamBriefingIntent';
import { workbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import { learningHubActionHandlers } from '@/features/generative-ui/handlers/learningHubActionHandlers';
import { createExamBriefingActionHandlers } from '@/features/generative-ui/handlers/examBriefingActionHandlers';
import { createIndexStatusBriefingActionHandlers } from '@/features/generative-ui/handlers/indexStatusBriefingActionHandlers';
import { createMemoryBriefingActionHandlers } from '@/features/generative-ui/handlers/memoryBriefingActionHandlers';
import { buildIndexStatusBriefingIntent } from '@/features/generative-ui/utils/buildIndexStatusBriefingIntent';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { createNotesEditActionHandlers } from '@/features/generative-ui/handlers/notesEditActionHandlers';
import { buildTranslationBriefingIntent } from '@/features/generative-ui/utils/buildTranslationBriefingIntent';
import { buildHpiasResearchDashboardIntent } from '@/features/generative-ui/utils/buildHpiasResearchDashboardIntent';
import { createResearchBriefingActionHandlers } from '@/features/generative-ui/handlers/researchBriefingActionHandlers';
import { createTranslationBriefingActionHandlers } from '@/features/generative-ui/handlers/translationBriefingActionHandlers';
import {
  COPY_INTENT_ACTION_ID,
  createCopyIntentActionHandlers,
} from '@/features/generative-ui/handlers/copyIntentActionHandlers';
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

  it('ai dashboard intent action ids exist in workbenchLearningHandlers', () => {
    const intent = buildAiDashboardIntent(
      { dueFlashcards: 2, pendingTodos: 1, overdueTodos: 0, activeAnkiTasks: 3 },
      {
        ...briefingLabels,
        ankiTasksTitle: 'Tasks',
        ankiTasksTrendActive: 'Running',
        openTaskDashboard: 'Tasks panel',
      },
    );
    expectActionIdsRegistered(intent, workbenchLearningHandlers, 'buildAiDashboardIntent');
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
        openMemory: 'Open',
      },
    });
    const handlers = createMemoryBriefingActionHandlers(
      { onRefresh: () => {}, onCreateMemory: () => {}, onOpenMemory: () => {} },
      { refresh: 'Refresh', createMemory: 'Create', openMemory: 'Open' },
    );
    expectActionIdsRegistered(intent, handlers, 'buildMemoryBriefingIntent');
  });

  it('LEARNING_DASHBOARD_EXAMPLE action ids exist in workbenchLearningHandlers', () => {
    expectActionIdsRegistered(LEARNING_DASHBOARD_EXAMPLE, workbenchLearningHandlers, 'LEARNING_DASHBOARD_EXAMPLE');
  });

  it('note edit suggestion action ids exist in createNotesEditActionHandlers', () => {
    const intent = buildNoteEditSuggestionIntent({
      operation: 'append',
      operationLabel: 'Append',
      previewText: 'preview',
      labels: {
        metaTitle: 'Suggestion',
        metaDescription: 'Confirm in editor',
        operationKey: 'Op',
        previewTitle: 'Preview',
        applyEdit: 'Apply',
        dismissSuggestion: 'Dismiss',
      },
    });
    const handlers = createNotesEditActionHandlers(
      { noteId: 'note-1', operation: 'append', content: 'text' },
      { applyEdit: 'Apply', dismissSuggestion: 'Dismiss' },
    );
    expectActionIdsRegistered(intent, handlers, 'buildNoteEditSuggestionIntent');
  });

  it('translation briefing action ids exist in createTranslationBriefingActionHandlers', () => {
    const intent = buildTranslationBriefingIntent({
      sourceChars: 10,
      translatedChars: 5,
      srcLangLabel: 'EN',
      tgtLangLabel: 'ZH',
      labels: {
        sourceStatTitle: 'Source',
        translatedStatTitle: 'Translated',
        emptyTrend: 'Empty',
        progressTitle: 'Progress',
        translatedRow: '{{count}}',
        languagePairRow: 'Pair',
        formalityRow: 'Tone',
        domainRow: 'Domain',
        glossaryRow: 'Glossary',
        openSettings: 'Settings',
        copyTranslation: 'Copy',
      },
    });
    const handlers = createTranslationBriefingActionHandlers(
      { onOpenSettings: () => {}, getTranslatedText: () => 'text' },
      { openSettings: 'Settings', copyTranslation: 'Copy' },
    );
    expectActionIdsRegistered(intent, handlers, 'buildTranslationBriefingIntent');
  });

  it('hpias research dashboard action ids exist in createResearchBriefingActionHandlers', () => {
    const intent = buildHpiasResearchDashboardIntent({
      snapshot: {
        sessionId: 's1',
        round: 1,
        plan: { core: { queries: ['Q1'] } },
        synthesis: 'Finding [paper-1]',
        retrievalCount: 5,
        selectedCount: 2,
        subAgents: {},
      },
      question: 'Test?',
      labels: {
        metaTitle: 'Research',
        roundLabel: 'Round',
        planTitle: 'Task',
        stepPlan: 'Plan',
        stepRetrieval: 'Retrieval',
        stepSelection: 'Selection',
        stepSubagents: 'Subagents',
        stepSynthesis: 'Synthesis',
        subagentFallback: 'Sub {{id}}',
        retrievalStatTitle: 'Retrieved',
        selectedStatTitle: 'Selected',
        reportMetaTitle: 'Report',
        citationStatTitle: 'Citations',
        copyReport: 'Copy',
        exportPlan: 'Export',
        exportIntent: 'Export intent',
      },
    });
    expect(intent).not.toBeNull();
    const handlers = createResearchBriefingActionHandlers(
      { getReportBody: () => 'Finding', getExportMarkdown: () => '# export', getIntent: () => intent },
      { copyReport: 'Copy', exportPlan: 'Export', exportIntent: 'Export intent' },
    );
    expectActionIdsRegistered(intent!, handlers, 'buildHpiasResearchDashboardIntent');
  });

  it('hpias research dashboard copy-intent is registered when copyIntent label is present', () => {
    const intent = buildHpiasResearchDashboardIntent({
      snapshot: {
        sessionId: 's1',
        round: 1,
        plan: { core: { queries: ['Q1'] } },
        synthesis: 'Finding [paper-1]',
        retrievalCount: 5,
        selectedCount: 2,
        subAgents: {},
      },
      question: 'Test?',
      labels: {
        metaTitle: 'Research',
        roundLabel: 'Round',
        planTitle: 'Task',
        stepPlan: 'Plan',
        stepRetrieval: 'Retrieval',
        stepSelection: 'Selection',
        stepSubagents: 'Subagents',
        stepSynthesis: 'Synthesis',
        subagentFallback: 'Sub {{id}}',
        retrievalStatTitle: 'Retrieved',
        selectedStatTitle: 'Selected',
        reportMetaTitle: 'Report',
        citationStatTitle: 'Citations',
        copyReport: 'Copy',
        exportPlan: 'Export',
        exportIntent: 'Export intent',
        copyIntent: 'Copy intent',
      },
    });
    expect(intent).not.toBeNull();
    const handlers = {
      ...createResearchBriefingActionHandlers(
        { getReportBody: () => 'Finding', getExportMarkdown: () => '# export', getIntent: () => intent },
        { copyReport: 'Copy', exportPlan: 'Export', exportIntent: 'Export intent' },
      ),
      ...createCopyIntentActionHandlers(intent!, { copyIntent: 'Copy intent' }),
    };
    expectActionIdsRegistered(intent!, handlers, 'buildHpiasResearchDashboardIntent+copy-intent');
    expect(handlers[COPY_INTENT_ACTION_ID]).toBeDefined();
  });

  it('copy-intent action id exists in createCopyIntentActionHandlers as low risk', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'action-bar',
          props: {
            actions: [{ id: COPY_INTENT_ACTION_ID, label: 'Copy intent', riskLevel: 'low' }],
          },
        },
      ],
    };
    const handlers = createCopyIntentActionHandlers(intent, { copyIntent: 'Copy intent' });
    expectActionIdsRegistered(intent, handlers, 'copy-intent');
    expect(handlers[COPY_INTENT_ACTION_ID]?.riskLevel).toBe('low');
  });
});
