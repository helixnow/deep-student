import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuListOptions, DstuNode } from '@/dstu';
import type { Result } from '@/shared/result';

const { list } = vi.hoisted(() => ({
  list: vi.fn<(path: string, options?: DstuListOptions) => Promise<Result<DstuNode[]>>>(),
}));

vi.mock('@/dstu', async () => ({
  ...(await vi.importActual('@/dstu/inkFormat')),
  dstu: { list },
}));

import {
  NOTEBOOK_LIST_PAGE_SIZE, NotebookPaginationError, notebookFolder, notebookTitle,
  scanNotebookSource, selectNotebookEntries, toNotebookEntry,
} from '../NotebookLibrary';

function node(id: string, options: Partial<DstuNode> = {}): DstuNode {
  return {
    id, sourceId: id, path: `/课程/代数/${id}`, name: id,
    type: 'note', createdAt: 1, updatedAt: 1, ...options,
  };
}

beforeEach(() => { list.mockReset(); });

describe('notebook library model', () => {
  it('includes existing nested text notes and dsink files only, using the shared MIME/extension contract', () => {
    const text = node('note_text', { name: '课堂文字笔记', updatedAt: 3 });
    const ink = node('file_ink', { type: 'file', name: '课堂手写.DSINK', updatedAt: 4 });
    const mimeInk = node('file_mime', {
      type: 'file', name: '没有扩展名', updatedAt: 5,
      metadata: { mimeType: 'Application/Vnd.Deepstudent.Ink+Json; charset=utf-8' },
    });
    const canonicalInk = node('file_canonical', {
      type: 'file', name: '没有扩展名的画布', updatedAt: 6,
      metadata: { canonicalMime: 'application/vnd.deepstudent.ink+json', mimeType: 'application/pdf' },
    });
    const excluded = [
      node('file_pdf', { type: 'file', name: '课堂.pdf', metadata: { mimeType: 'application/pdf' } }),
      node('file_reclassified_pdf', {
        type: 'file', name: '重新识别的资料',
        metadata: { canonicalMime: 'application/pdf', mimeType: 'application/vnd.deepstudent.ink+json' },
      }),
      node('tb_pdf', { type: 'textbook', name: '课堂.pdf' }),
      node('image_1', { type: 'image', name: '课堂.png' }),
      node('fld_1', { type: 'folder', name: '课堂' }),
      node('note_internal', { name: '__user_profile__' }),
    ];
    expect(selectNotebookEntries([text, ink, mimeInk, canonicalInk, ...excluded]).map((entry) => entry.node.id))
      .toEqual(['file_canonical', 'file_mime', 'file_ink', 'note_text']);
    expect(toNotebookEntry({ ...mimeInk, metadata: { ...mimeInk.metadata, canonicalMime: null } })?.kind).toBe('ink');
    expect(toNotebookEntry({ ...ink, metadata: { canonicalMime: 'application/octet-stream' } })?.kind).toBe('ink');
    expect(excluded.every((candidate) => toNotebookEntry(candidate) === null)).toBe(true);
    expect(notebookTitle(toNotebookEntry(ink)!)).toBe('课堂手写');
    expect(notebookFolder(text)).toBe('课程 / 代数');
    expect(notebookFolder(node('note_root', { path: '/note_root' }))).toBe('');
  });

  it('searches the complete name/folder metadata case-insensitively, filters by kind, deduplicates, and sorts recent first', () => {
    const nodes = [
      node('note_a', { name: 'Algebra ideas', updatedAt: 4 }),
      node('file_b', { type: 'file', name: 'Algebra map.dsink', updatedAt: 6 }),
      node('note_c', { name: 'Geometry', updatedAt: 5, path: '/几何/note_c' }),
      node('note_a', { name: 'Algebra ideas', updatedAt: 8 }),
    ];
    expect(selectNotebookEntries(nodes, '  ALGEBRA   代数 ').map((entry) => entry.node.id))
      .toEqual(['note_a', 'file_b']);
    expect(selectNotebookEntries(nodes, 'algebra', 'ink').map((entry) => entry.node.id)).toEqual(['file_b']);
    expect(selectNotebookEntries(nodes, '', 'text').map((entry) => entry.node.id)).toEqual(['note_a', 'note_c']);
    expect(selectNotebookEntries(nodes, 'missing')).toEqual([]);
  });
});

describe('notebook DSTU list boundary', () => {
  it('uses global typeFilter and raw fixed-size offsets, continuing after filtered/short pages until an empty page', async () => {
    const pages = [
      [node('note_a', { path: '/嵌套/文件夹/note_a' })],
      [node('note_b', { path: '/另一个文件夹/note_b' })],
      [],
    ];
    list.mockImplementation(async (_path, options) => ({ ok: true, value: pages[(options?.offset ?? 0) / NOTEBOOK_LIST_PAGE_SIZE] ?? [] }));
    const received: DstuNode[] = [];
    await scanNotebookSource('note', (page) => received.push(...page), () => false);
    expect(received.map((candidate) => candidate.id)).toEqual(['note_a', 'note_b']);
    expect(list.mock.calls).toEqual([0, 100, 200].map((offset) => ['/', {
      typeFilter: 'note', sortBy: 'updatedAt', sortOrder: 'desc', limit: 100, offset,
    }]));
    expect(list.mock.calls[0][1]).not.toHaveProperty('recursive');
    expect(list.mock.calls[0][1]).not.toHaveProperty('types');
    expect(list.mock.calls[0][1]).not.toHaveProperty('folderId');
  });

  it('does not stop when an entire file page consists of ordinary PDFs before an older nested notebook', async () => {
    const pdfs = Array.from({ length: NOTEBOOK_LIST_PAGE_SIZE }, (_, index) => node(`tb_${index}`, { type: 'textbook', name: `${index}.pdf` }));
    list.mockImplementation(async (_path, options) => ({
      ok: true,
      value: options?.offset === 0 ? pdfs : options?.offset === 100
        ? [node('file_deep', { type: 'file', name: 'Old canvas.dsink' })] : [],
    }));
    const found: string[] = [];
    await scanNotebookSource('file', (page) => found.push(...selectNotebookEntries(page).map((entry) => entry.node.id)), () => false);
    expect(found).toEqual(['file_deep']);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('propagates later-page errors without discarding published rows and reports a non-advancing backend', async () => {
    const error = new Error('disk read failed');
    list.mockResolvedValueOnce({ ok: true, value: [node('note_saved')] }).mockRejectedValueOnce(error);
    const onPage = vi.fn();
    await expect(scanNotebookSource('note', onPage, () => false)).rejects.toBe(error);
    expect(onPage).toHaveBeenCalledTimes(1);

    list.mockReset().mockResolvedValue({ ok: true, value: [node('note_repeated')] });
    await expect(scanNotebookSource('note', vi.fn(), () => false)).rejects.toBeInstanceOf(NotebookPaginationError);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not publish a late page or request another page after cancellation', async () => {
    let resolve!: (result: Result<DstuNode[]>) => void;
    let cancelled = false;
    list.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onPage = vi.fn();
    const loading = scanNotebookSource('file', onPage, () => cancelled);
    cancelled = true;
    resolve({ ok: true, value: [node('file_late', { type: 'file', name: 'Late.dsink' })] });
    await loading;
    expect(onPage).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
