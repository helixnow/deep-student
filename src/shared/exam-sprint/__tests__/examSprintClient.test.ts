import { beforeEach, describe, expect, it, vi } from 'vitest';
import { examSprintClient } from '../examSprintClient';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => invoke.mockReset());

describe('Exam Sprint remote wire contract', () => {
  it.each([
    ['getExamHorizonConfig', ['space_1'], ['space_1']],
    ['updateExamHorizonConfig', [{ spaceId: 'space_1', examDate: null, defaultDeckId: undefined }], [{ spaceId: 'space_1', examDate: null }]],
    ['getExamReadiness', ['space_1'], [{ spaceId: 'space_1', rootFolderId: null, examDateOverride: null,
      sprintBudgetMinutesOverride: null, defaultDeckIdOverride: null, clientMindmapSignals: null }]],
    ['buildDailySprintPlan', [{ spaceId: 'space_1' }], [{ spaceId: 'space_1', rootFolderId: null,
      examDateOverride: null, sprintBudgetMinutesOverride: null, defaultDeckIdOverride: null,
      clientMindmapSignals: null, enableAiVariants: true, maxLiveVariants: 2 }]],
    ['generateMistakeVariant', [{ questionId: 'q_1' }], [{ questionId: 'q_1', planId: null, forceRegenerate: false }]],
  ])('sends %s through the existing review remote without snake_case conversion', async (method, input, args) => {
    const result = { marker: method };
    invoke.mockResolvedValue(result);
    const call = examSprintClient[method as keyof typeof examSprintClient] as (...args: unknown[]) => Promise<unknown>;
    expect(await call(...input as unknown[])).toBe(result);
    expect(invoke).toHaveBeenCalledWith('plugin:host|call', {
      caller: 'dstu.review', service: 'review', method, args,
    });
    expect(JSON.parse(JSON.stringify(invoke.mock.calls[0]![1]))).toEqual(invoke.mock.calls[0]![1]);
  });

  it('preserves the settlement request and returned DTO without changing item identifiers', async () => {
    const request = { planSessionId: 'sprint_1', spaceId: 'space_1', readinessBefore: {},
      totalElapsedSeconds: 5, completedItems: [] };
    const settlement = { planSessionId: 'sprint_1', totalCompleted: 0 };
    invoke.mockResolvedValue(settlement);
    expect(await examSprintClient.settleSprintSession(request as never)).toBe(settlement);
    expect(invoke.mock.calls[0]![1]).toEqual({ caller: 'dstu.review', service: 'review', method: 'settleSprintSession',
      args: [{ ...request, rootFolderId: null, examDateOverride: null, sprintBudgetMinutesOverride: null,
        defaultDeckIdOverride: null, clientMindmapSignalsAfter: null }] });
  });
});
