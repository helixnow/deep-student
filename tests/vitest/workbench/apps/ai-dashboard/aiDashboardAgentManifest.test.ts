import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiDashboardAgentManifest } from '@/features/workbench/apps/ai-dashboard/agentManifest';

const launchSpy = vi.fn(() => 'win-task');
const activateSpy = vi.fn(async () => ({
  delivered: true,
  result: { handled: true, acknowledged: true },
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    launch: (...args: unknown[]) => launchSpy(...args),
    activateDetailed: (...args: unknown[]) => activateSpy(...args),
  },
}));

vi.mock('@/features/workbench/apps/system/flashcardsDueSource', () => ({
  getFlashcardsDueCount: () => 3,
  refreshFlashcardsDueCount: vi.fn(async () => {}),
}));

vi.mock('@/features/workbench/apps/system/todoAgendaSource', () => ({
  getTodoAgendaSnapshot: () => ({
    items: [{ id: 't1', dueDate: '2099-01-01', status: 'pending' }],
    lists: [],
    isLoading: false,
    error: null,
    updatedAt: 1,
  }),
  refreshTodoAgenda: vi.fn(async () => {}),
}));

vi.mock('@/features/workbench/apps/system/ankiTaskSource', () => ({
  getActiveAnkiTaskCount: () => 1,
  refreshAnkiTaskCount: vi.fn(async () => {}),
}));

const ctx = { windowId: 'ai-dash', typeId: 'aiDashboard', instanceKey: null };

describe('aiDashboardAgentManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('observes briefing metrics', () => {
    const obs = aiDashboardAgentManifest.observe?.(ctx);
    expect(obs?.state).toMatchObject({
      dueFlashcards: 3,
      pendingTodos: 1,
      activeAnkiTasks: 1,
    });
    expect(obs?.availableActions).toContain('openTaskDashboard');
  });

  it('opens task dashboard via execute', async () => {
    const result = await aiDashboardAgentManifest.execute?.(ctx, {
      name: 'openTaskDashboard',
      args: {},
    });
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'taskDashboard', reason: 'api' });
    expect(result).toMatchObject({ handled: true, acknowledged: true });
  });

  it('starts due review via execute', async () => {
    const result = await aiDashboardAgentManifest.execute?.(ctx, {
      name: 'startReview',
      args: {},
    });
    expect(activateSpy).toHaveBeenCalled();
    expect(result).toMatchObject({ handled: true, acknowledged: true });
  });
});
