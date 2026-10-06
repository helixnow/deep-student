import { describe, expect, it } from 'vitest';
import { normalizeLibraryItem, normalizeRelatedNote, toMillis, type MediaLibraryItem } from '../api';
import {
  commonTitlePrefix,
  countByFilter,
  groupLibraryItems,
  listMediaFolders,
  selectAllState,
  selectedVisibleItems,
  toggleSelectAll,
  formatDuration,
  isWatching,
  matchesFilter,
  selectLibraryItems,
  sortByRecent,
  transcriptChip,
  watchRatio,
} from '../libraryModel';

const T0 = 1_760_000_000_000;

function item(over: Partial<MediaLibraryItem> & { id: string }): MediaLibraryItem {
  return {
    name: `${over.id}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    isLink: false,
    coverUrl: null,
    size: 1,
    folderId: null,
    folderName: null,
    folderPath: [],
    createdAt: T0,
    updatedAt: T0,
    durationMs: 600_000,
    transcript: { status: 'none', completedSegments: 0, totalSegments: 0, failedSegments: 0, source: null },
    progress: { lastPositionMs: 0, watchedMs: 0, finished: false },
    lastWatchedAt: null,
    handoutCount: 0,
    ...over,
  };
}

describe('api normalization (media_library_list shape)', () => {
  it('maps the backend camelCase item and folds error/cancelled into the transcript vocabulary', () => {
    const raw = {
      id: 'file_a', resourceId: 'res_a', name: 'L1.mp4', folderId: 'fld_1', folderName: '高数', folderPath: ['高数'],
      size: 10, mimeType: 'video/mp4', kind: 'video', createdAt: T0, updatedAt: T0 + 1,
      durationMs: 1000, transcript: { status: 'error', completedSegments: 1, totalSegments: 3, failedSegments: 2, source: 'asr' },
      progress: { lastPositionMs: 0, watchedMs: 0, finished: false }, lastWatchedAt: null, handoutCount: 2, lastActivityAt: T0 + 1,
    };
    const parsed = normalizeLibraryItem(raw)!;
    expect(parsed).toMatchObject({ id: 'file_a', kind: 'video', folderName: '高数', folderPath: ['高数'], durationMs: 1000, handoutCount: 2 });
    expect(parsed.transcript.status).toBe('failed');
    expect(normalizeLibraryItem({ ...raw, transcript: { status: 'cancelled' } })!.transcript.status).toBe('partial');
  });

  it('infers kind from mime / extension and tolerates snake_case and second timestamps', () => {
    const parsed = normalizeLibraryItem({ id: 'file_b', name: 'talk.m4a', mime_type: '', updated_at: 1_760_000_000 })!;
    expect(parsed.kind).toBe('audio');
    expect(parsed.updatedAt).toBe(1_760_000_000_000);
    expect(parsed.progress).toBeNull();
    expect(parsed.folderPath).toEqual([]);
    expect(normalizeLibraryItem({ name: 'no id' })).toBeNull();
    expect(toMillis('2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  it('keeps a link cover only when it is an https URL', () => {
    const base = { id: 'file_c', name: '线代.bilibili', mimeType: 'video/x-bilibili', kind: 'video', isLink: true };
    expect(normalizeLibraryItem({ ...base, coverUrl: 'https://i0.hdslb.com/bfs/archive/a.jpg' })!.coverUrl)
      .toBe('https://i0.hdslb.com/bfs/archive/a.jpg');
    expect(normalizeLibraryItem({ ...base, cover_url: 'https://i1.hdslb.com/b.jpg' })!.coverUrl).toBe('https://i1.hdslb.com/b.jpg');
    expect(normalizeLibraryItem({ ...base, coverUrl: 'javascript:alert(1)' })!.coverUrl).toBeNull();
    expect(normalizeLibraryItem({ ...base, coverUrl: 'http://i0.hdslb.com/a.jpg' })!.coverUrl).toBeNull();
    expect(normalizeLibraryItem({ ...base })!.coverUrl).toBeNull();
  });

  it('marks Bilibili link items from the backend flag or the link MIME / extension', () => {
    expect(normalizeLibraryItem({ id: 'file_l', name: '线代.bilibili', mimeType: 'video/x-bilibili', kind: 'video', isLink: true })!)
      .toMatchObject({ kind: 'video', isLink: true });
    expect(normalizeLibraryItem({ id: 'file_m', name: '课.bilibili', mime_type: 'application/octet-stream' })!.isLink).toBe(true);
    expect(normalizeLibraryItem({ id: 'file_v', name: 'L1.mp4', mimeType: 'video/mp4' })!.isLink).toBe(false);
  });

  it('maps related notes', () => {
    expect(normalizeRelatedNote({ id: 'note_1', title: '讲义', updatedAt: T0 })).toEqual({
      id: 'note_1', title: '讲义', createdAt: 0, updatedAt: T0,
    });
  });
});

describe('library filtering and sorting', () => {
  const fresh = item({ id: 'fresh' });
  const watching = item({ id: 'watching', progress: { lastPositionMs: 30_000, watchedMs: 30_000, finished: false }, lastWatchedAt: T0 + 50 });
  const finished = item({ id: 'finished', progress: { lastPositionMs: 600_000, watchedMs: 600_000, finished: true }, lastWatchedAt: T0 + 10 });
  const done = item({ id: 'done', transcript: { status: 'completed', completedSegments: 9, totalSegments: 9, failedSegments: 0, source: 'asr' }, updatedAt: T0 + 100 });
  const partial = item({ id: 'partial', transcript: { status: 'partial', completedSegments: 3, totalSegments: 9, failedSegments: 6, source: 'asr' } });
  const all = [fresh, watching, finished, done, partial];

  it('classifies watching (played, not finished) and transcribed (completed or partial with lines)', () => {
    expect(isWatching(watching)).toBe(true);
    expect(isWatching(finished)).toBe(false);
    expect(isWatching(fresh)).toBe(false);
    expect(matchesFilter(done, 'transcribed')).toBe(true);
    expect(matchesFilter(partial, 'transcribed')).toBe(true);
    expect(matchesFilter(fresh, 'untranscribed')).toBe(true);
    expect(countByFilter(all)).toEqual({ all: 5, watching: 1, untranscribed: 3, transcribed: 2 });
  });

  it('sorts by most recent activity (watched or modified) and searches by name', () => {
    expect(sortByRecent(all).map((i) => i.id).slice(0, 3)).toEqual(['done', 'watching', 'finished']);
    expect(selectLibraryItems(all, 'all', 'WATCH').map((i) => i.id)).toEqual(['watching']);
    expect(selectLibraryItems(all, 'untranscribed', '').map((i) => i.id)).toEqual(['watching', 'finished', 'fresh']);
  });

  it('draws progress only once playback started, full when finished', () => {
    expect(watchRatio(fresh)).toBeNull();
    expect(watchRatio(watching)).toBeCloseTo(0.05);
    expect(watchRatio(finished)).toBe(1);
    expect(watchRatio(item({ id: 'x', durationMs: null, progress: { lastPositionMs: 5, watchedMs: 5, finished: false } }))).toBeNull();
  });

  it('formats durations', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(null)).toBeNull();
  });
});

describe('transcript status chips', () => {
  it.each([
    [{ status: 'none' }, { key: 'none', tone: 'neutral' }],
    [{ status: 'queued' }, { key: 'queued', tone: 'primary', busy: true }],
    [{ status: 'running', completedSegments: 2, totalSegments: 5 }, { key: 'running', completed: 2, total: 5, busy: true }],
    [{ status: 'completed', source: 'asr' }, { key: 'completed', tone: 'success' }],
    [{ status: 'completed', source: 'import' }, { key: 'imported', tone: 'success' }],
    [{ status: 'partial', completedSegments: 3, totalSegments: 9 }, { key: 'partial', tone: 'warning' }],
    [{ status: 'failed' }, { key: 'failed', tone: 'danger' }],
  ] as const)('%o → %o', (transcript, expected) => {
    const chip = transcriptChip(item({
      id: 'c',
      transcript: { status: 'none', completedSegments: 0, totalSegments: 0, failedSegments: 0, source: null, ...transcript },
    }));
    expect(chip).toMatchObject(expected);
  });
});

describe('grouping by folder', () => {
  const inFolder = (id: string, folderId: string, path: string[]) =>
    item({ id, folderId, folderName: path[path.length - 1], folderPath: path });

  it('groups by folder id with natural label order, keeps item order, root files last', () => {
    const items = [
      item({ id: 'loose1' }),
      inFolder('c10a', 'fld_10', ['第 10 章']),
      inFolder('c2a', 'fld_2', ['第 2 章']),
      item({ id: 'loose2' }),
      inFolder('c10b', 'fld_10', ['第 10 章']),
      inFolder('nested', 'fld_n', ['高数', '习题课']),
    ];
    const groups = groupLibraryItems(items);
    expect(groups.map((g) => [g.folderId, g.label, g.items.map((i) => i.id)])).toEqual([
      ['fld_2', '第 2 章', ['c2a']],
      ['fld_10', '第 10 章', ['c10a', 'c10b']],
      ['fld_n', '高数 / 习题课', ['nested']],
      [null, '', ['loose1', 'loose2']],
    ]);
    expect(groupLibraryItems([inFolder('a', 'fld_a', ['A'])]).some((g) => g.folderId === null)).toBe(false);
    expect(groupLibraryItems([])).toEqual([]);
  });

  it('falls back to folderName when the path is missing; lists distinct media folders', () => {
    const items = [
      item({ id: 'a', folderId: 'fld_b', folderName: 'B', folderPath: [] }),
      item({ id: 'b', folderId: 'fld_a', folderName: 'A', folderPath: ['A'] }),
      item({ id: 'c', folderId: 'fld_b', folderName: 'B', folderPath: [] }),
      item({ id: 'd' }),
    ];
    expect(listMediaFolders(items)).toEqual([{ id: 'fld_a', label: 'A' }, { id: 'fld_b', label: 'B' }]);
  });
});

describe('selection over visible items', () => {
  const visible = [item({ id: 'a' }), item({ id: 'b' })];

  it('reports none / some / all for the visible items only', () => {
    expect(selectAllState(visible, new Set())).toBe('none');
    expect(selectAllState(visible, new Set(['a', 'hidden']))).toBe('some');
    expect(selectAllState(visible, new Set(['a', 'b']))).toBe('all');
    expect(selectAllState([], new Set(['a']))).toBe('none');
  });

  it('select-all adds every visible item and keeps hidden selections; toggling again clears only the visible ones', () => {
    const all = toggleSelectAll(visible, new Set(['hidden', 'a']));
    expect([...all].sort()).toEqual(['a', 'b', 'hidden']);
    expect([...toggleSelectAll(visible, all)]).toEqual(['hidden']);
    expect(selectedVisibleItems(visible, all).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('commonTitlePrefix', () => {
  it.each([
    [['线性代数 P2 矩阵.bilibili', '线性代数 P3 向量.bilibili'], '线性代数'],
    [['线性代数P10 特征值', '线性代数P11 二次型'], '线性代数'],
    [['高数 第1讲.mp4', '高数 第2讲.mp4', '高数 第12讲.mp4'], '高数'],
    [['CS229 Lecture 1.mp4', 'CS229 Lecture 2.mp4'], 'CS229 Lecture'],
    [['机器学习-01-绪论.mp4', '机器学习-02-线性模型.mp4'], '机器学习'],
    [['abc.mp4', 'xyz.mp4'], ''],
    [['只有一个.mp4'], ''],
    [['A1.mp4', 'A2.mp4'], ''],
  ])('%o → %s', (names, expected) => {
    expect(commonTitlePrefix(names)).toBe(expected);
  });
});
