/**
 * previewPersistence i18n 契约
 *
 * 预览阅读进度 / 书签持久化失败的 reportError 标签必须走
 * practice:preview_persist.*（defaultValue = 主干中文原文），
 * 不允许在 reportError / toVfsError 调用点硬编码中文。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhPractice from '@/locales/zh-CN/practice.json';
import enPractice from '@/locales/en-US/practice.json';

const { setMetadata, updateBookmarks, reportError, toVfsError, translate } = vi.hoisted(() => ({
  setMetadata: vi.fn(),
  updateBookmarks: vi.fn(),
  reportError: vi.fn(),
  toVfsError: vi.fn((error: unknown) => error),
  translate: vi.fn((key: string) => `t:${key}`),
}));

vi.mock('@/dstu', () => ({ dstu: { setMetadata } }));
vi.mock('@/api/vfsFileApi', () => ({ vfsFileApi: { updateBookmarks } }));
vi.mock('@/shared/result', () => ({ reportError, toVfsError }));
vi.mock('@/i18n', () => ({ default: { t: translate } }));

import { createPreviewPersistController } from '../previewPersistence';

const SOURCE_PATH = 'src/features/learning-hub/apps/views/previewPersistence.ts';

const ZH_LABELS = {
  save_progress: '保存阅读进度',
  save_bookmarks: '保存书签',
  save_bookmarks_failed: '保存书签失败',
  flush_unsaved: '保存未持久化的阅读进度/书签',
} as const;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function makeController(kind: 'textbook' | 'file') {
  return createPreviewPersistController(
    {
      kind,
      nodeId: 'node-1',
      nodePath: '/node-1.pdf',
      getMetadata: () => ({}),
    },
    { progressDebounceMs: 5, bookmarksDebounceMs: 5 },
  );
}

describe('previewPersistence i18n locales', () => {
  it('zh-CN keeps the original main-branch copy under practice:preview_persist', () => {
    expect(zhPractice.preview_persist).toEqual(ZH_LABELS);
  });

  it('en-US mirrors the preview_persist leaf keys with translated copy', () => {
    expect(Object.keys(enPractice.preview_persist).sort()).toEqual(
      Object.keys(zhPractice.preview_persist).sort(),
    );
    for (const value of Object.values(enPractice.preview_persist)) {
      expect(value).toBeTruthy();
      expect(value).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe('previewPersistence i18n source contract', () => {
  const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8');

  it('imports the app i18n instance', () => {
    expect(source).toContain("import i18n from '@/i18n';");
  });

  it('routes every user-facing label through practice:preview_persist keys', () => {
    for (const key of Object.keys(ZH_LABELS)) {
      expect(source).toContain(`i18n.t('practice:preview_persist.${key}'`);
    }
  });

  it('only carries the Chinese copy as defaultValue, never as a raw label', () => {
    for (const label of Object.values(ZH_LABELS)) {
      const quoted = countOccurrences(source, `'${label}'`);
      expect(quoted).toBeGreaterThan(0);
      expect(quoted).toBe(countOccurrences(source, `defaultValue: '${label}'`));
    }
    expect(source).not.toContain("reportError(result.error, '");
    expect(source).not.toContain("toVfsError(err, '");
  });
});

describe('previewPersistence i18n runtime labels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMetadata.mockReset();
    updateBookmarks.mockReset();
    reportError.mockClear();
    toVfsError.mockClear();
    translate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports progress save failures with the save_progress label', async () => {
    const error = new Error('meta write failed');
    setMetadata.mockResolvedValue({ ok: false, error });
    const controller = makeController('file');

    controller.scheduleProgress({ page: 3, lastReadAt: 30 });
    await vi.advanceTimersByTimeAsync(5);

    expect(reportError).toHaveBeenCalledWith(error, 't:practice:preview_persist.save_progress');
    expect(translate).toHaveBeenCalledWith('practice:preview_persist.save_progress', {
      defaultValue: zhPractice.preview_persist.save_progress,
    });
  });

  it('reports bookmark save failures with the save_bookmarks label', async () => {
    const error = new Error('meta write failed');
    setMetadata.mockResolvedValue({ ok: false, error });
    const controller = makeController('file');

    controller.scheduleBookmarks([{ id: 'b1', page: 7, title: 'Seven', createdAt: 10 }]);
    await vi.advanceTimersByTimeAsync(5);

    expect(reportError).toHaveBeenCalledWith(error, 't:practice:preview_persist.save_bookmarks');
    expect(translate).toHaveBeenCalledWith('practice:preview_persist.save_bookmarks', {
      defaultValue: zhPractice.preview_persist.save_bookmarks,
    });
  });

  it('labels flush failures for the dual-write channel and pending metadata', async () => {
    const dualWriteError = new Error('bookmarks channel down');
    const metaError = new Error('meta write failed');
    updateBookmarks.mockRejectedValue(dualWriteError);
    setMetadata.mockResolvedValue({ ok: false, error: metaError });
    const controller = makeController('textbook');

    controller.scheduleProgress({ page: 8, lastReadAt: 20 });
    controller.scheduleBookmarks([{ id: 'b1', page: 7, title: 'Seven', createdAt: 10 }]);
    await controller.flush();

    expect(toVfsError).toHaveBeenCalledWith(
      dualWriteError,
      't:practice:preview_persist.save_bookmarks_failed',
    );
    expect(reportError).toHaveBeenCalledWith(
      dualWriteError,
      't:practice:preview_persist.save_bookmarks',
    );
    expect(reportError).toHaveBeenCalledWith(
      metaError,
      't:practice:preview_persist.flush_unsaved',
    );
    expect(translate).toHaveBeenCalledWith('practice:preview_persist.save_bookmarks_failed', {
      defaultValue: zhPractice.preview_persist.save_bookmarks_failed,
    });
    expect(translate).toHaveBeenCalledWith('practice:preview_persist.flush_unsaved', {
      defaultValue: zhPractice.preview_persist.flush_unsaved,
    });
  });
});
