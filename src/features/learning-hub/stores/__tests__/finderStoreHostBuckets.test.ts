/**
 * LH-HOST Step2：finderStore 按 hostId 分桶的契约测试。
 *
 * 锁定三件事：
 * 1. 同一逻辑宿主（page / page-mobile，canvas / canvas-mobile）共用一个桶
 * 2. 不同宿主桶之间导航位置 / 选中 / viewMode 互不影响
 * 3. 默认桶仍是历史 `useFinderStore`，persist key 不变（刷新后不串台）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/dstu/api', () => ({
  dstu: {
    list: vi.fn(async () => ({ ok: true, value: [] })),
    get: vi.fn(async () => ({ ok: false, error: { message: 'not found' } })),
    search: vi.fn(async () => ({ ok: true, value: [] })),
    searchInFolder: vi.fn(async () => ({ ok: true, value: [] })),
    listDeleted: vi.fn(async () => ({ ok: true, value: [] })),
  },
}));

vi.mock('@/dstu', () => ({
  folderApi: {
    getBreadcrumbs: vi.fn(async (folderId: string) => ({
      ok: true,
      value: [{ id: folderId, name: folderId }],
    })),
  },
  trashApi: { listTrash: vi.fn(async () => ({ ok: true, value: [] })) },
}));

import {
  DEFAULT_FINDER_BUCKET,
  FINDER_HOST_IDS,
  createFinderPath,
  getFinderStoreForHost,
  resolveFinderBucketId,
  useFinderStore,
} from '../finderStore';

const pathAt = (folderId: string) =>
  createFinderPath({ folderId, breadcrumbs: [{ id: folderId, name: folderId, dstuPath: `/${folderId}` }] });

describe('resolveFinderBucketId', () => {
  it('maps every declared hostId to a bucket', () => {
    expect(resolveFinderBucketId(FINDER_HOST_IDS.files)).toBe(DEFAULT_FINDER_BUCKET);
    expect(resolveFinderBucketId(FINDER_HOST_IDS.page)).toBe('page');
    expect(resolveFinderBucketId(FINDER_HOST_IDS.pageMobile)).toBe('page');
    expect(resolveFinderBucketId(FINDER_HOST_IDS.canvas)).toBe('canvas');
    expect(resolveFinderBucketId(FINDER_HOST_IDS.canvasMobile)).toBe('canvas');
    expect(resolveFinderBucketId(FINDER_HOST_IDS.groupPicker)).toBe('group-picker');
  });

  it('falls back to the default bucket for missing / unknown hosts', () => {
    expect(resolveFinderBucketId(undefined)).toBe(DEFAULT_FINDER_BUCKET);
    expect(resolveFinderBucketId(null)).toBe(DEFAULT_FINDER_BUCKET);
    expect(resolveFinderBucketId('some-future-host')).toBe(DEFAULT_FINDER_BUCKET);
  });
});

describe('finder store host buckets', () => {
  beforeEach(() => {
    getFinderStoreForHost(FINDER_HOST_IDS.page).getState().reset();
    getFinderStoreForHost(FINDER_HOST_IDS.canvas).getState().reset();
    getFinderStoreForHost(FINDER_HOST_IDS.groupPicker).getState().reset();
    useFinderStore.getState().reset();
  });

  it('shares one store between page and page-mobile', () => {
    expect(getFinderStoreForHost(FINDER_HOST_IDS.page))
      .toBe(getFinderStoreForHost(FINDER_HOST_IDS.pageMobile));
  });

  it('shares one store between canvas and canvas-mobile', () => {
    expect(getFinderStoreForHost(FINDER_HOST_IDS.canvas))
      .toBe(getFinderStoreForHost(FINDER_HOST_IDS.canvasMobile));
  });

  it('keeps the default bucket pointing at the legacy global store', () => {
    expect(getFinderStoreForHost(FINDER_HOST_IDS.files)).toBe(useFinderStore);
    expect(getFinderStoreForHost(undefined)).toBe(useFinderStore);
  });

  it('does not leak currentFolder between two hosts', () => {
    const page = getFinderStoreForHost(FINDER_HOST_IDS.page);
    const canvas = getFinderStoreForHost(FINDER_HOST_IDS.canvas);

    page.getState().navigateTo(pathAt('folder-lesson'));
    canvas.getState().navigateTo(pathAt('folder-scratch'));

    expect(page.getState().currentPath.folderId).toBe('folder-lesson');
    expect(canvas.getState().currentPath.folderId).toBe('folder-scratch');
    expect(useFinderStore.getState().currentPath.folderId).toBeNull();
  });

  it('does not leak currentFolder between the mobile hosts either', () => {
    const pageMobile = getFinderStoreForHost(FINDER_HOST_IDS.pageMobile);
    const canvasMobile = getFinderStoreForHost(FINDER_HOST_IDS.canvasMobile);

    pageMobile.getState().navigateTo(pathAt('mobile-lesson'));
    canvasMobile.getState().navigateTo(pathAt('mobile-scratch'));

    expect(pageMobile.getState().currentPath.folderId).toBe('mobile-lesson');
    expect(canvasMobile.getState().currentPath.folderId).toBe('mobile-scratch');
    // page 与 page-mobile 同桶：窄宽屏切换保留落点
    expect(getFinderStoreForHost(FINDER_HOST_IDS.page).getState().currentPath.folderId)
      .toBe('mobile-lesson');
  });

  it('keeps history stacks per bucket', () => {
    const page = getFinderStoreForHost(FINDER_HOST_IDS.page);
    const canvas = getFinderStoreForHost(FINDER_HOST_IDS.canvas);

    page.getState().navigateTo(pathAt('a'));
    page.getState().navigateTo(pathAt('b'));
    canvas.getState().navigateTo(pathAt('z'));

    expect(page.getState().historyIndex).toBe(2);
    expect(canvas.getState().historyIndex).toBe(1);

    page.getState().goBack();
    expect(page.getState().currentPath.folderId).toBe('a');
    expect(canvas.getState().currentPath.folderId).toBe('z');
  });

  it('keeps selection per bucket', () => {
    const page = getFinderStoreForHost(FINDER_HOST_IDS.page);
    const groupPicker = getFinderStoreForHost(FINDER_HOST_IDS.groupPicker);

    page.getState().setSelectedIds(new Set(['res-1', 'res-2']));
    groupPicker.getState().setSelectedIds(new Set(['res-9']));

    expect(Array.from(page.getState().selectedIds)).toEqual(['res-1', 'res-2']);
    expect(Array.from(groupPicker.getState().selectedIds)).toEqual(['res-9']);
  });

  it('keeps viewMode per bucket', () => {
    const page = getFinderStoreForHost(FINDER_HOST_IDS.page);
    const canvas = getFinderStoreForHost(FINDER_HOST_IDS.canvas);

    page.getState().setViewMode('list');
    canvas.getState().setViewMode('grid');

    expect(page.getState().viewMode).toBe('list');
    expect(canvas.getState().viewMode).toBe('grid');
  });

  it('persists each bucket under its own storage key', () => {
    getFinderStoreForHost(FINDER_HOST_IDS.page).getState().setViewMode('list');
    getFinderStoreForHost(FINDER_HOST_IDS.canvas).getState().setViewMode('grid');
    useFinderStore.getState().setViewMode('columns');

    expect(localStorage.getItem('learning-hub-finder')).toContain('"viewMode":"columns"');
    expect(localStorage.getItem('learning-hub-finder:page')).toContain('"viewMode":"list"');
    expect(localStorage.getItem('learning-hub-finder:canvas')).toContain('"viewMode":"grid"');
  });
});
