import { describe, it, expect } from 'vitest';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { workbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import { learningHubActionHandlers } from '@/features/generative-ui/handlers/learningHubActionHandlers';
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

  it('LEARNING_DASHBOARD_EXAMPLE action ids exist in workbenchLearningHandlers', () => {
    expectActionIdsRegistered(LEARNING_DASHBOARD_EXAMPLE, workbenchLearningHandlers, 'LEARNING_DASHBOARD_EXAMPLE');
  });
});
