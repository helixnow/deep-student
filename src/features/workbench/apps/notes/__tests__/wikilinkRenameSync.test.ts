import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { get, getContent, update, search, fetchBacklinksFromBackend } = vi.hoisted(() => ({
  get: vi.fn(),
  getContent: vi.fn(),
  update: vi.fn(),
  search: vi.fn(),
  fetchBacklinksFromBackend: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { get, getContent, update, search },
}));

vi.mock('../backlinksBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backlinksBackend')>();
  return { ...actual, fetchBacklinksFromBackend };
});

import {
  RENAME_SYNC_SOURCE_LIMIT,
  rewriteWikiLinkTargets,
  syncWikiLinksAfterNoteRename,
} from '../wikilinkRenameSync';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '../../content/contentDirtyRegistry';

const knownNotes = [
  { id: 'note_target', title: '旧标题' },
  { id: 'note_source', title: '来源笔记' },
  { id: 'note_other', title: '别的笔记' },
];

function sourceNode(id: string, updatedAt = 100): DstuNode {
  return {
    id, sourceId: id, path: `/${id}`, name: '来源笔记', type: 'note', createdAt: 1, updatedAt,
  } as DstuNode;
}

describe('rewriteWikiLinkTargets', () => {
  const request = { noteId: 'note_target', oldTitle: '旧标题', newTitle: '新标题', knownNotes };

  it('rewrites title links and preserves heading and alias suffixes', () => {
    const { content, rewritten } = rewriteWikiLinkTargets(
      '见 [[旧标题]] 与 [[旧标题#第一章]] 与 [[旧标题|别名]]。',
      request,
    );
    expect(content).toBe('见 [[新标题]] 与 [[新标题#第一章]] 与 [[新标题|别名]]。');
    expect(rewritten).toBe(3);
  });

  it('matches titles case-insensitively but leaves ID links and other titles alone', () => {
    const input = '[[Old Title]] [[note_target]] [[别的笔记]]';
    const { content, rewritten } = rewriteWikiLinkTargets(input, {
      noteId: 'note_a',
      oldTitle: 'old title',
      newTitle: 'Fresh Title',
      knownNotes: [{ id: 'note_a', title: 'old title' }],
    });
    // [[note_target]] 按 ID 解析（重命名后依旧有效）、[[别的笔记]] 是别的标题：都不动
    expect(content).toBe('[[Fresh Title]] [[note_target]] [[别的笔记]]');
    expect(rewritten).toBe(1);
  });

  it('does not hijack ambiguous titles that resolved to a different note', () => {
    const shared = [
      { id: 'note_first', title: '同名' },
      { id: 'note_second', title: '同名' },
    ];
    // 解析器确定性裁决到 note_first；以 note_second 名义重命名不得改写
    const { content, rewritten } = rewriteWikiLinkTargets('[[同名]]', {
      noteId: 'note_second', oldTitle: '同名', newTitle: '改名', knownNotes: shared,
    });
    expect(content).toBe('[[同名]]');
    expect(rewritten).toBe(0);

    const hit = rewriteWikiLinkTargets('[[同名]]', {
      noteId: 'note_first', oldTitle: '同名', newTitle: '改名', knownNotes: shared,
    });
    expect(hit.content).toBe('[[改名]]');
    expect(hit.rewritten).toBe(1);
  });

  it('is a no-op when the normalized titles are identical', () => {
    const { content, rewritten } = rewriteWikiLinkTargets('[[旧标题]]', {
      ...request,
      newTitle: '旧标题 ',
    });
    expect(content).toBe('[[旧标题]]');
    expect(rewritten).toBe(0);
  });
});

describe('syncWikiLinksAfterNoteRename', () => {
  const request = {
    noteId: 'note_target',
    oldTitle: '旧标题',
    newTitle: '新标题',
    knownNotes,
  };

  beforeEach(() => {
    get.mockReset();
    getContent.mockReset();
    update.mockReset();
    search.mockReset();
    fetchBacklinksFromBackend.mockReset();
    __resetContentDirtyRegistry();
    fetchBacklinksFromBackend.mockResolvedValue([{
      sourceId: 'note_source', sourceTitle: '来源笔记', heading: null, alias: null,
      position: 0, sourceUpdatedAt: '2026-01-01T00:00:00Z',
    }]);
    search.mockResolvedValue({ ok: true, value: [] });
    get.mockImplementation(async (path: string) => ({ ok: true, value: sourceNode(path.slice(1), 100) }));
    getContent.mockResolvedValue({ ok: true, value: '正文提到 [[旧标题#章节|别名]] 一次。' });
    update.mockResolvedValue({ ok: true, value: sourceNode('note_source', 101) });
  });

  afterEach(() => {
    __resetContentDirtyRegistry();
  });

  it('rewrites backend-discovered sources with an OCC baseline from the fresh node', async () => {
    const summary = await syncWikiLinksAfterNoteRename(request);

    expect(summary).toEqual({
      updatedSources: 1, rewrittenLinks: 1, skippedDirtySources: 0, failedSources: 0, scanFailed: false,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      '/note_source',
      '正文提到 [[新标题#章节|别名]] 一次。',
      'note',
      { expectedUpdatedAtMs: 100 },
    );
  });

  it('falls back to client search when the backend graph command is unavailable', async () => {
    fetchBacklinksFromBackend.mockRejectedValue(new Error('command unavailable'));
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[旧标题#' ? [sourceNode('note_source')] : [],
    }));

    const summary = await syncWikiLinksAfterNoteRename(request);

    expect(search).toHaveBeenCalledWith('[[旧标题]]', {
      typeFilter: 'note', limit: RENAME_SYNC_SOURCE_LIMIT,
    });
    expect(summary.updatedSources).toBe(1);
    expect(summary.scanFailed).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('reports scanFailed without touching any note when both discovery paths fail', async () => {
    fetchBacklinksFromBackend.mockRejectedValue(new Error('command unavailable'));
    search.mockResolvedValue({ ok: false, error: new Error('index offline') });

    const summary = await syncWikiLinksAfterNoteRename(request);

    expect(summary.scanFailed).toBe(true);
    expect(summary.updatedSources).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('skips sources with unsaved edits instead of overwriting them on disk', async () => {
    const unregister = registerContentDirtyChecker('note', 'note_source', () => true);
    try {
      const summary = await syncWikiLinksAfterNoteRename(request);
      expect(summary.skippedDirtySources).toBe(1);
      expect(summary.updatedSources).toBe(0);
      expect(update).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('counts an OCC conflict as a failed source instead of retrying blindly', async () => {
    update.mockResolvedValue({ ok: false, error: new Error('conflict') });

    const summary = await syncWikiLinksAfterNoteRename(request);

    expect(summary.failedSources).toBe(1);
    expect(summary.updatedSources).toBe(0);
  });

  it('leaves sources untouched when their fresh content no longer links the old title', async () => {
    getContent.mockResolvedValue({ ok: true, value: '这里只有 [[别的笔记]]。' });

    const summary = await syncWikiLinksAfterNoteRename(request);

    expect(summary).toEqual({
      updatedSources: 0, rewrittenLinks: 0, skippedDirtySources: 0, failedSources: 0, scanFailed: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('short-circuits when the rename does not change the normalized title', async () => {
    const summary = await syncWikiLinksAfterNoteRename({ ...request, newTitle: ' 旧标题 ' });

    expect(summary.updatedSources).toBe(0);
    expect(fetchBacklinksFromBackend).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
