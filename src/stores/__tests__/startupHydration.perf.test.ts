/**
 * Scale performance regression tests for Frontend startup initialization & store hydration
 * (`useAppInitialization`, `useStudySpaceStore`, `useSuperAgentEnabledStore`,
 * `useReviewPlanStore`, `useUnifiedIndexStore`, `useQuestionBankStore`).
 *
 * Ensures startup initialization:
 * - Fires independent appearance settings in parallel (no sequential IPC waterfalls);
 * - Defers non-critical background checks past initial paint without blocking first render;
 * - Coalesces concurrent startup store hydration IPCs (zero N+1 loops on 200+ groups / 1,000+ notes / 5,000+ cards).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroup } from '@/features/chat/types/group';

const { invokeMock, listenMock, getSettingMock, syncNotifMock, getUnifiedStatusMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
  getSettingMock: vi.fn(),
  syncNotifMock: vi.fn(async () => undefined),
  getUnifiedStatusMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(async () => ({ setZoom: vi.fn(async () => undefined) })),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: getSettingMock,
}));

vi.mock('@/utils/systemNotification', () => ({
  syncSystemNotificationPolicyFromBackend: syncNotifMock,
}));

vi.mock('@/api/vfsUnifiedIndexApi', () => ({
  vfsUnifiedIndexApi: {
    getUnifiedIndexStatus: getUnifiedStatusMock,
    getResourceUnits: vi.fn(async () => []),
    reindexUnit: vi.fn(async () => true),
    batchIndexPending: vi.fn(async () => ({ successCount: 0, failCount: 0 })),
  },
}));

import { initializeFontSetting, useAppInitialization } from '@/hooks/useAppInitialization';
import { useStudySpaceStore } from '@/stores/studySpaceStore';
import { useSuperAgentEnabledStore, useSyncSuperAgentEnabled } from '@/stores/superAgentEnabledStore';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import { useUnifiedIndexStore } from '@/stores/unifiedIndexStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeScaleGroups(count: number): SessionGroup[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `grp_scale_${index}`,
    name: `Space ${index}`,
    systemPrompt: '',
    defaultSkillIds: [],
    pinnedResourceIds: [`fld_root_${index}`],
    rootFolderId: `fld_root_${index}`,
    sortOrder: index,
    persistStatus: 'active',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }));
}

describe('Frontend startup hydration scale regressions', () => {
  beforeEach(() => {
    vi.useRealTimers();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    getSettingMock.mockReset();
    syncNotifMock.mockReset();
    syncNotifMock.mockResolvedValue(undefined);
    getUnifiedStatusMock.mockReset();
    localStorage.clear();
    useStudySpaceStore.getState().resetForTests();
    useSuperAgentEnabledStore.setState({ enabled: false, sessionId: null, synced: false });
    useReviewPlanStore.getState().setCurrentExam(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializeFontSetting fetches font family and scale in parallel and coalesces concurrent calls', async () => {
    const fontDeferred = createDeferred<string | null>();
    const sizeDeferred = createDeferred<string | null>();
    const requestedKeys: string[] = [];

    getSettingMock.mockImplementation((key: string) => {
      requestedKeys.push(key);
      if (key === 'ui.fontFamily') return fontDeferred.promise;
      if (key === 'ui.fontScale') return sizeDeferred.promise;
      return Promise.resolve(null);
    });

    const p1 = initializeFontSetting();
    const p2 = initializeFontSetting();

    // Both keys must be dispatched before either settles (parallel, not sequential waterfall),
    // and concurrent callers must share the exact same in-flight reads.
    expect(requestedKeys).toEqual(['ui.fontFamily', 'ui.fontScale']);

    fontDeferred.resolve('system');
    sizeDeferred.resolve('1');
    await Promise.all([p1, p2]);
    expect(requestedKeys).toHaveLength(2);
  });

  it('useAppInitialization stays non-blocking on mount and defers non-critical health/policy checks', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    getSettingMock.mockImplementation(async (key: string) => {
      calls.push(key);
      return null;
    });

    const { result, unmount } = renderHook(() => useAppInitialization());

    // First render must be immediately ready without blocking on DB probe or notification sync.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(calls).not.toContain('app_initialized');
    expect(syncNotifMock).not.toHaveBeenCalled();

    // Once the deferred idle task runs, both background checks execute.
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(calls).toContain('app_initialized');
    expect(syncNotifMock).toHaveBeenCalledTimes(1);
    expect(result.current.steps.every((step) => step.completed)).toBe(true);

    unmount();
  });

  it('studySpaceStore coalesces concurrent hydrateFromGroups on 200+ groups into 1 profile+mount IPC pair', async () => {
    const groups = makeScaleGroups(200);
    const profilesDeferred = createDeferred<unknown[]>();
    const mountsDeferred = createDeferred<unknown[]>();

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'vfs_study_space_list_profiles') return profilesDeferred.promise;
      if (cmd === 'vfs_space_mount_list') return mountsDeferred.promise;
      return Promise.resolve([]);
    });

    const startedAt = performance.now();
    const h1 = useStudySpaceStore.getState().hydrateFromGroups(groups);
    const h2 = useStudySpaceStore.getState().hydrateFromGroups(groups);
    const h3 = useStudySpaceStore.getState().hydrateFromGroups(groups);

    // Zero N+1 per-group IPCs: 200 groups + 3 concurrent calls still issue exactly 1 pair.
    const profileCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'vfs_study_space_list_profiles');
    const mountCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'vfs_space_mount_list');
    expect(profileCalls).toHaveLength(1);
    expect(mountCalls).toHaveLength(1);
    expect(invokeMock.mock.calls).toHaveLength(2);

    profilesDeferred.resolve([]);
    mountsDeferred.resolve([]);
    await Promise.all([h1, h2, h3]);

    const elapsedMs = performance.now() - startedAt;
    expect(Object.keys(useStudySpaceStore.getState().groupsById)).toHaveLength(200);
    expect(Object.keys(useStudySpaceStore.getState().profilesBySpaceId)).toHaveLength(200);
    expect(useStudySpaceStore.getState().loading).toBe(false);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('superAgentEnabledStore coalesces concurrent state reads and shares one event listener across mounts', async () => {
    const stateDeferred = createDeferred<{ enabled: boolean; sessionId: string | null }>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'super_session_get_state') return stateDeferred.promise;
      return Promise.resolve(null);
    });

    const p1 = useSuperAgentEnabledStore.getState().syncFromBackend();
    const p2 = useSuperAgentEnabledStore.getState().refresh();
    const h1 = renderHook(() => useSyncSuperAgentEnabled());
    const h2 = renderHook(() => useSyncSuperAgentEnabled());

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'super_session_get_state')).toHaveLength(1);

    stateDeferred.resolve({ enabled: true, sessionId: 'sess_super_1' });
    await Promise.all([p1, p2]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(useSuperAgentEnabledStore.getState().sessionId).toBe('sess_super_1');

    h1.unmount();
    h2.unmount();
  });

  it('reviewPlanStore, unifiedIndexStore, and questionBankStore coalesce concurrent startup stats/refresh IPCs', async () => {
    const reviewStatsDeferred = createDeferred({
      exam_id: null, total_plans: 5003, new_count: 1000, learning_count: 500, reviewing_count: 3000,
      graduated_count: 500, suspended_count: 3, due_today: 120, overdue_count: 10, difficult_count: 50,
      total_reviews: 20000, total_correct: 18000, avg_correct_rate: 0.9, avg_ease_factor: 2.5,
      updated_at: '2026-11-25T00:00:00Z',
    });
    const reviewDueDeferred = createDeferred({ plans: [], total: 0, has_more: false });
    const qbankStatsDeferred = createDeferred({
      total_count: 5003, answered_count: 1000, correct_count: 900,
    });
    const unifiedStatusDeferred = createDeferred({
      totalUnits: 1003,
      textStats: { pending: 0, indexing: 0, indexed: 1003, failed: 0, disabled: 0 },
      mmStats: { pending: 0, indexing: 0, indexed: 0, failed: 0, disabled: 1003 },
      dimensions: [],
    });

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'review_plan_get_stats') return reviewStatsDeferred.promise;
      if (cmd === 'review_plan_get_due') return reviewDueDeferred.promise;
      if (cmd === 'qbank_get_stats') return qbankStatsDeferred.promise;
      return Promise.resolve(null);
    });
    getUnifiedStatusMock.mockReturnValue(unifiedStatusDeferred.promise);

    const tasks = [
      useReviewPlanStore.getState().loadStats(),
      useReviewPlanStore.getState().loadStats(),
      useReviewPlanStore.getState().loadDueReviews(),
      useReviewPlanStore.getState().loadDueReviews(),
      useUnifiedIndexStore.getState().refresh(),
      useUnifiedIndexStore.getState().refresh(),
      useQuestionBankStore.getState().loadStats('exam_scale_1'),
      useQuestionBankStore.getState().loadStats('exam_scale_1'),
    ];

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'review_plan_get_stats')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'review_plan_get_due')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'qbank_get_stats')).toHaveLength(1);
    expect(getUnifiedStatusMock).toHaveBeenCalledTimes(1);

    reviewStatsDeferred.resolve({
      exam_id: null, total_plans: 5003, new_count: 1000, learning_count: 500, reviewing_count: 3000,
      graduated_count: 500, suspended_count: 3, due_today: 120, overdue_count: 10, difficult_count: 50,
      total_reviews: 20000, total_correct: 18000, avg_correct_rate: 0.9, avg_ease_factor: 2.5,
      updated_at: '2026-11-25T00:00:00Z',
    });
    reviewDueDeferred.resolve({ plans: [], total: 0, has_more: false });
    qbankStatsDeferred.resolve({ total_count: 5003, answered_count: 1000, correct_count: 900 });
    unifiedStatusDeferred.resolve({
      totalUnits: 1003,
      textStats: { pending: 0, indexing: 0, indexed: 1003, failed: 0, disabled: 0 },
      mmStats: { pending: 0, indexing: 0, indexed: 0, failed: 0, disabled: 1003 },
      dimensions: [],
    });

    await Promise.all(tasks);
    expect(useReviewPlanStore.getState().stats?.total_plans).toBe(5003);
    expect(useUnifiedIndexStore.getState().summary?.totalUnits).toBe(1003);
  });
});
