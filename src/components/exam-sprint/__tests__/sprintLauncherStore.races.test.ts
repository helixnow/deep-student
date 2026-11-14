import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyExamReadiness,
  fetchExamHorizonConfig,
  fetchExamReadiness,
  saveExamHorizonConfig,
} from '../sprintBridge';
import {
  getSprintLauncherSnapshot,
  refreshSprintReadiness,
  resetSprintLauncherStoreForTest,
  updateSprintHorizonSettings,
} from '../sprintLauncherStore';

vi.mock('../sprintBridge', async (original) => ({
  ...await original<typeof import('../sprintBridge')>(),
  fetchExamReadiness: vi.fn(),
  fetchExamHorizonConfig: vi.fn(),
  saveExamHorizonConfig: vi.fn(),
}));

const config = (spaceId: string) => ({
  spaceId, rootFolderId: null, defaultDeckId: null, examDate: null,
  sprintBudgetMinutes: 15, baseTargetRetention: 0.88, dayRolloverHour: 4,
});

describe('sprint readiness races', () => {
  beforeEach(() => {
    resetSprintLauncherStoreForTest();
    vi.clearAllMocks();
    vi.mocked(fetchExamHorizonConfig).mockImplementation(async (id) => config(id!));
  });

  it('clears the previous space while loading and ignores its late response', async () => {
    let release!: (value: ReturnType<typeof createEmptyExamReadiness>) => void;
    vi.mocked(fetchExamReadiness)
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(createEmptyExamReadiness('new'));
    const old = refreshSprintReadiness({ spaceId: 'old' });
    await refreshSprintReadiness({ spaceId: 'new' });
    release(createEmptyExamReadiness('old'));
    await old;
    expect(getSprintLauncherSnapshot().readiness?.spaceId).toBe('new');
    let finish!: (value: ReturnType<typeof createEmptyExamReadiness>) => void;
    vi.mocked(fetchExamReadiness).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = refreshSprintReadiness({ spaceId: 'third' });
    expect(getSprintLauncherSnapshot().readiness).toBeNull();
    expect(getSprintLauncherSnapshot().config).toBeNull();
    finish(createEmptyExamReadiness('third'));
    await loading;
  });

  it('does not navigate back to the old space when an outstanding config save completes', async () => {
    vi.mocked(fetchExamReadiness).mockImplementation(async ({ spaceId }) => createEmptyExamReadiness(spaceId));
    await refreshSprintReadiness({ spaceId: 'old' });
    let release!: (value: ReturnType<typeof config>) => void;
    vi.mocked(saveExamHorizonConfig).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const saving = updateSprintHorizonSettings({ sprintBudgetMinutes: 30 });
    await refreshSprintReadiness({ spaceId: 'new' });
    release(config('old'));
    await saving;
    expect(getSprintLauncherSnapshot().spaceId).toBe('new');
    expect(getSprintLauncherSnapshot().config?.spaceId).toBe('new');
  });
});
