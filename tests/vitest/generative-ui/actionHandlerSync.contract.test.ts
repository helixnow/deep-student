import { describe, it, expect } from 'vitest';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';
import { buildAiDashboardIntent } from '@/features/generative-ui/utils/buildAiDashboardIntent';
import { workbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { createNotesEditActionHandlers } from '@/features/generative-ui/handlers/notesEditActionHandlers';
import { buildHpiasResearchDashboardIntent } from '@/features/generative-ui/utils/buildHpiasResearchDashboardIntent';
import { createResearchBriefingActionHandlers } from '@/features/generative-ui/handlers/researchBriefingActionHandlers';
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
