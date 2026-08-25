/**
 * LH-HOST：访达按宿主分桶
 *
 * 契约：
 * - 不同宿主（page / page-mobile / canvas / group-picker…）的 currentPath、
 *   searchQuery、selectedIds、viewMode 互不污染。
 * - 移动端 `page-mobile` 是独立桶，不与桌面 `page` 共享。
 * - workbench Files 窗口（`files`）继续落在 default 桶，与直接引用
 *   `useFinderStore` 的 activation / agent driver 保持同一份状态。
 * - 旧单例持久化数据（键 `learning-hub-finder`）迁移到 default 桶；
 *   新桶首次创建时继承旧偏好而不是回到出厂默认。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createFinderPath,
  createFinderStore,
  finderPersistKey,
  getActiveFinderHostId,
  getFinderStore,
  resolveFinderHostId,
  resolveInitialViewPreferences,
  resetFinderStoreRegistryForTests,
  sanitizeFinderViewPreferences,
  setActiveFinderHostId,
  useActiveFinderState,
  useFinderStore,
  DEFAULT_FINDER_HOST_ID,
  FINDER_HOST_IDS,
  FINDER_PERSIST_KEY_PREFIX,
  DEFAULT_FINDER_VIEW_PREFERENCES,
} from '@/features/learning-hub/stores/finderStore';

describe('finderStore host buckets', () => {
  beforeEach(() => {
    resetFinderStoreRegistryForTests();
  });

  afterEach(() => {
    resetFinderStoreRegistryForTests();
  });

  it('keeps currentPath isolated between two hosts', () => {
    const pageStore = getFinderStore('page');
    const mobileStore = getFinderStore('page-mobile');

    expect(pageStore).not.toBe(mobileStore);

    pageStore.getState().navigateTo(createFinderPath({ folderId: 'folder-desktop' }));

    expect(pageStore.getState().currentPath.folderId).toBe('folder-desktop');
    expect(mobileStore.getState().currentPath.folderId).toBeNull();

    mobileStore.getState().navigateTo(createFinderPath({ folderId: 'folder-mobile' }));

    expect(mobileStore.getState().currentPath.folderId).toBe('folder-mobile');
    expect(pageStore.getState().currentPath.folderId).toBe('folder-desktop');
  });

  it('keeps searchQuery / selectedIds / viewMode isolated between two hosts', () => {
    const pageStore = getFinderStore('page');
    const canvasStore = getFinderStore('canvas');

    pageStore.getState().setSearchQuery('desktop query');
    pageStore.getState().setSelectedIds(new Set(['a', 'b']));
    pageStore.getState().setViewMode('list');

    expect(canvasStore.getState().searchQuery).toBe('');
    expect(canvasStore.getState().selectedIds.size).toBe(0);
    expect(canvasStore.getState().viewMode).not.toBe('list');

    canvasStore.getState().setSearchQuery('canvas query');
    canvasStore.getState().setSelectedIds(new Set(['c']));

    expect(pageStore.getState().searchQuery).toBe('desktop query');
    expect(Array.from(pageStore.getState().selectedIds)).toEqual(['a', 'b']);
    expect(pageStore.getState().viewMode).toBe('list');
  });

  it('gives page-mobile its own bucket, separate from page and from default', () => {
    const mobileStore = getFinderStore('page-mobile');

    expect(resolveFinderHostId('page-mobile')).toBe('page-mobile');
    expect(mobileStore).not.toBe(getFinderStore('page'));
    expect(mobileStore).not.toBe(useFinderStore);

    mobileStore.getState().setSearchQuery('mobile only');
    expect(useFinderStore.getState().searchQuery).toBe('');
    expect(getFinderStore('page').getState().searchQuery).toBe('');
  });

  it('returns a stable instance per host and maps files/undefined to the default bucket', () => {
    expect(getFinderStore('page')).toBe(getFinderStore('page'));
    expect(getFinderStore('files')).toBe(useFinderStore);
    expect(getFinderStore(undefined)).toBe(useFinderStore);
    expect(resolveFinderHostId('files')).toBe(DEFAULT_FINDER_HOST_ID);
    expect(resolveFinderHostId(undefined)).toBe(DEFAULT_FINDER_HOST_ID);
  });

  it('keeps the legacy persist key for the default bucket and namespaces the others', () => {
    expect(finderPersistKey(DEFAULT_FINDER_HOST_ID)).toBe(FINDER_PERSIST_KEY_PREFIX);
    expect(finderPersistKey('page-mobile')).toBe(`${FINDER_PERSIST_KEY_PREFIX}:page-mobile`);
  });

  it('gives every declared host its own bucket, except files which shares default', () => {
    const hosts = Object.values(FINDER_HOST_IDS);
    const buckets = hosts.map(resolveFinderHostId);
    // 每个宿主一个桶，谁也不和别人共用
    expect(new Set(buckets).size).toBe(hosts.length);
    expect(resolveFinderHostId(FINDER_HOST_IDS.files)).toBe(DEFAULT_FINDER_HOST_ID);
    expect(getFinderStore(FINDER_HOST_IDS.canvas))
      .not.toBe(getFinderStore(FINDER_HOST_IDS.canvasMobile));
    expect(getFinderStore(FINDER_HOST_IDS.canvas))
      .not.toBe(getFinderStore(FINDER_HOST_IDS.page));
  });

  it('does not leak the learning hub path into the chat canvas bucket', () => {
    const hubStore = getFinderStore(FINDER_HOST_IDS.page);
    const canvasStore = getFinderStore(FINDER_HOST_IDS.canvasMobile);

    hubStore.getState().navigateTo(createFinderPath({
      folderId: 'folder-hub',
      breadcrumbs: [{ id: 'folder-hub', name: '教材', dstuPath: '/教材' }],
    }));

    expect(canvasStore.getState().currentPath.folderId).toBeNull();
    expect(canvasStore.getState().currentPath.breadcrumbs).toEqual([]);
  });
});

describe('finderStore active host', () => {
  beforeEach(() => {
    resetFinderStoreRegistryForTests();
  });

  afterEach(() => {
    resetFinderStoreRegistryForTests();
  });

  it('falls back to the default bucket when nobody registered', () => {
    expect(getActiveFinderHostId()).toBe(DEFAULT_FINDER_HOST_ID);
  });

  it('maps the registered host through the same bucket resolution', () => {
    setActiveFinderHostId(FINDER_HOST_IDS.files);
    expect(getActiveFinderHostId()).toBe(DEFAULT_FINDER_HOST_ID);

    setActiveFinderHostId(FINDER_HOST_IDS.pageMobile);
    expect(getActiveFinderHostId()).toBe(FINDER_HOST_IDS.pageMobile);
  });

  it('re-points the global navigation shell at whichever host is active', () => {
    const pageStore = getFinderStore(FINDER_HOST_IDS.page);
    const mobileStore = getFinderStore(FINDER_HOST_IDS.pageMobile);
    pageStore.getState().navigateTo(createFinderPath({ folderId: 'folder-desktop' }));
    mobileStore.getState().navigateTo(createFinderPath({ folderId: 'folder-mobile' }));

    const { result } = renderHook(() => useActiveFinderState((state) => state.currentPath.folderId));

    expect(result.current).toBeNull();

    act(() => setActiveFinderHostId(FINDER_HOST_IDS.page));
    expect(result.current).toBe('folder-desktop');

    act(() => setActiveFinderHostId(FINDER_HOST_IDS.pageMobile));
    expect(result.current).toBe('folder-mobile');
  });

  it('drives goBack on the active host only', () => {
    const pageStore = getFinderStore(FINDER_HOST_IDS.page);
    const canvasStore = getFinderStore(FINDER_HOST_IDS.canvas);
    pageStore.getState().navigateTo(createFinderPath({ folderId: 'folder-desktop' }));
    canvasStore.getState().navigateTo(createFinderPath({ folderId: 'folder-canvas' }));

    setActiveFinderHostId(FINDER_HOST_IDS.page);
    const { result } = renderHook(() => useActiveFinderState((state) => state.goBack));
    act(() => result.current());

    expect(pageStore.getState().currentPath.folderId).toBeNull();
    expect(canvasStore.getState().currentPath.folderId).toBe('folder-canvas');
  });
});

describe('finderStore persisted preference migration', () => {
  const legacyPayload = JSON.stringify({
    state: { viewMode: 'list', sortBy: 'name', sortOrder: 'asc', quickAccessCollapsed: true },
    version: 0,
  });

  it('treats legacy singleton data as the default bucket', () => {
    const storage = new Map<string, string>([[FINDER_PERSIST_KEY_PREFIX, legacyPayload]]);
    const prefs = resolveInitialViewPreferences(DEFAULT_FINDER_HOST_ID, {
      getItem: (key) => storage.get(key) ?? null,
    });

    expect(prefs).toEqual({
      viewMode: 'list',
      sortBy: 'name',
      sortOrder: 'asc',
      quickAccessCollapsed: true,
    });
  });

  it('seeds a brand-new host bucket from the legacy singleton data', () => {
    const storage = new Map<string, string>([[FINDER_PERSIST_KEY_PREFIX, legacyPayload]]);
    const prefs = resolveInitialViewPreferences('page-mobile', {
      getItem: (key) => storage.get(key) ?? null,
    });

    expect(prefs.viewMode).toBe('list');
    expect(prefs.sortBy).toBe('name');
  });

  it('prefers the host bucket own data over the legacy singleton', () => {
    const storage = new Map<string, string>([
      [FINDER_PERSIST_KEY_PREFIX, legacyPayload],
      [
        finderPersistKey('page-mobile'),
        JSON.stringify({ state: { viewMode: 'grid' }, version: 0 }),
      ],
    ]);
    const prefs = resolveInitialViewPreferences('page-mobile', {
      getItem: (key) => storage.get(key) ?? null,
    });

    expect(prefs.viewMode).toBe('grid');
    // 本桶未覆盖的字段回到出厂默认，而不是继续读旧单例
    expect(prefs.sortBy).toBe(DEFAULT_FINDER_VIEW_PREFERENCES.sortBy);
  });

  it('falls back to factory defaults when storage is unavailable or corrupt', () => {
    expect(resolveInitialViewPreferences('page', null)).toEqual(DEFAULT_FINDER_VIEW_PREFERENCES);
    expect(
      resolveInitialViewPreferences('page', { getItem: () => 'not json' }),
    ).toEqual(DEFAULT_FINDER_VIEW_PREFERENCES);
  });

  it('whitelists structurally valid JSON instead of trusting persisted field types', () => {
    expect(sanitizeFinderViewPreferences({
      viewMode: { value: 'list' },
      sortBy: 'name',
      sortOrder: 'sideways',
      quickAccessCollapsed: 'yes',
      currentPath: { folderId: 'must-not-hydrate' },
    })).toEqual({ sortBy: 'name' });
  });

  it('does not let Zustand hydration re-inject rejected v0 preferences', () => {
    const bucketId = 'corrupt-upgrade-test';
    const key = finderPersistKey(bucketId);
    window.localStorage.setItem(key, JSON.stringify({
      state: {
        viewMode: null,
        sortBy: 'name',
        sortOrder: ['desc'],
        quickAccessCollapsed: 1,
        currentPath: { folderId: 'stale-folder' },
      },
      version: 0,
    }));

    try {
      const store = createFinderStore(bucketId);
      expect(store.getState().viewMode).toBe(DEFAULT_FINDER_VIEW_PREFERENCES.viewMode);
      expect(store.getState().sortBy).toBe('name');
      expect(store.getState().sortOrder).toBe(DEFAULT_FINDER_VIEW_PREFERENCES.sortOrder);
      expect(store.getState().quickAccessCollapsed)
        .toBe(DEFAULT_FINDER_VIEW_PREFERENCES.quickAccessCollapsed);
      expect(store.getState().currentPath.folderId).toBeNull();
    } finally {
      window.localStorage.removeItem(key);
    }
  });

  it('writes each bucket to its own persist key', () => {
    const store = createFinderStore('group-picker');
    store.getState().setViewMode('list');

    expect(window.localStorage.getItem(finderPersistKey('group-picker'))).toContain('"viewMode":"list"');
  });
});
