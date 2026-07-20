/**
 * createFromWikilink / wikilinkNotesCache 轻量单测
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: {
    createNote: vi.fn(),
    listNotes: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import {
  createNoteFromWikilinkTitle,
  parseCreateFromWikilinkEvent,
  setWikilinkCreateContext,
} from '../createFromWikilink';
import {
  getWikilinkNotesCache,
  resolveWikilinkTarget,
  upsertWikilinkNoteCache,
  refreshWikilinkNotesCache,
} from '../wikilinkNotesCache';

describe('parseCreateFromWikilinkEvent', () => {
  it('reads trimmed title from detail', () => {
    const event = new CustomEvent('notes:create-from-wikilink', {
      detail: { title: '  Hello  ' },
    });
    expect(parseCreateFromWikilinkEvent(event)).toBe('Hello');
  });

  it('returns null for empty title', () => {
    const event = new CustomEvent('notes:create-from-wikilink', {
      detail: { title: '   ' },
    });
    expect(parseCreateFromWikilinkEvent(event)).toBeNull();
  });
});

describe('wikilinkNotesCache', () => {
  beforeEach(() => {
    // reset via refresh empty list
    vi.mocked(notesDstuAdapter.listNotes).mockResolvedValue({
      ok: true,
      value: [],
    } as never);
  });

  it('upserts and resolves by title', async () => {
    await refreshWikilinkNotesCache();
    upsertWikilinkNoteCache({ id: 'n1', title: 'Alpha' });
    expect(getWikilinkNotesCache()).toEqual([{ id: 'n1', title: 'Alpha' }]);
    expect(resolveWikilinkTarget('Alpha')).toEqual({
      resolved: true,
      noteId: 'n1',
    });
    expect(resolveWikilinkTarget('Missing').resolved).toBe(false);
  });

  // B13：同名笔记时 resolve 附带 ambiguous + candidateIds（非歧义时形状不变，见上）
  it('flags duplicate titles as ambiguous with all candidate ids', async () => {
    await refreshWikilinkNotesCache();
    upsertWikilinkNoteCache({ id: 'n2', title: 'Same' });
    upsertWikilinkNoteCache({ id: 'n1', title: 'Same' });
    expect(resolveWikilinkTarget('Same')).toEqual({
      resolved: true,
      noteId: 'n1',
      ambiguous: true,
      candidateIds: ['n1', 'n2'],
    });
  });
});

describe('createNoteFromWikilinkTitle', () => {
  beforeEach(() => {
    vi.mocked(notesDstuAdapter.createNote).mockReset();
  });

  it('creates note, upserts cache, and dispatches DSTU_OPEN_NOTE once for concurrent calls', async () => {
    vi.mocked(notesDstuAdapter.createNote).mockResolvedValue({
      ok: true,
      value: { id: 'note-42', name: 'New Title' },
    } as never);

    const opens: unknown[] = [];
    const onOpen = (e: Event) => {
      opens.push((e as CustomEvent).detail);
    };
    window.addEventListener('DSTU_OPEN_NOTE', onOpen);

    const [a, b] = await Promise.all([
      createNoteFromWikilinkTitle('New Title'),
      createNoteFromWikilinkTitle('New Title'),
    ]);

    window.removeEventListener('DSTU_OPEN_NOTE', onOpen);

    expect(a).toBe('note-42');
    expect(b).toBe('note-42');
    expect(notesDstuAdapter.createNote).toHaveBeenCalledTimes(1);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      noteId: 'note-42',
      source: 'wikilink',
      target: 'New Title',
    });
    expect(resolveWikilinkTarget('New Title').noteId).toBe('note-42');
  });

  // B1：in-flight 改为按标题分槽，异标题并发互不覆盖、同标题仍合并
  it('keeps concurrent creations of different titles independent', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    vi.mocked(notesDstuAdapter.createNote).mockImplementation(
      (title: string) =>
        new Promise((resolve) => {
          pending.set(title, resolve);
        }) as never,
    );

    const alpha = createNoteFromWikilinkTitle('Alpha');
    const beta = createNoteFromWikilinkTitle('Beta');
    // Alpha 仍在飞行中：应合并进第一次调用而不是再次 create
    const alphaAgain = createNoteFromWikilinkTitle('Alpha');

    pending.get('Alpha')?.({ ok: true, value: { id: 'id-alpha', name: 'Alpha' } });
    pending.get('Beta')?.({ ok: true, value: { id: 'id-beta', name: 'Beta' } });

    await expect(alpha).resolves.toBe('id-alpha');
    await expect(alphaAgain).resolves.toBe('id-alpha');
    await expect(beta).resolves.toBe('id-beta');
    expect(notesDstuAdapter.createNote).toHaveBeenCalledTimes(2);

    // 槽位清理后可重新创建
    vi.mocked(notesDstuAdapter.createNote).mockResolvedValue({
      ok: true,
      value: { id: 'id-alpha-2', name: 'Alpha' },
    } as never);
    await expect(createNoteFromWikilinkTitle('Alpha')).resolves.toBe('id-alpha-2');
  });

  // B2：宿主 onCreated（openResource）成功时不再派发 DSTU_OPEN_NOTE，避免双开
  it('skips DSTU_OPEN_NOTE when host onCreated succeeds', async () => {
    vi.mocked(notesDstuAdapter.createNote).mockResolvedValue({
      ok: true,
      value: { id: 'note-77', name: 'Ghost' },
    } as never);

    const onCreated = vi.fn().mockResolvedValue(undefined);
    const restore = setWikilinkCreateContext({ folderId: null, onCreated });

    const opens: unknown[] = [];
    const onOpen = (e: Event) => {
      opens.push((e as CustomEvent).detail);
    };
    window.addEventListener('DSTU_OPEN_NOTE', onOpen);
    try {
      await expect(createNoteFromWikilinkTitle('Ghost')).resolves.toBe('note-77');
    } finally {
      window.removeEventListener('DSTU_OPEN_NOTE', onOpen);
      restore();
    }

    expect(onCreated).toHaveBeenCalledWith('note-77', 'Ghost');
    expect(opens).toHaveLength(0);
  });

  it('falls back to DSTU_OPEN_NOTE when host onCreated throws', async () => {
    vi.mocked(notesDstuAdapter.createNote).mockResolvedValue({
      ok: true,
      value: { id: 'note-88', name: 'Ghost2' },
    } as never);

    const onCreated = vi.fn().mockRejectedValue(new Error('open failed'));
    const restore = setWikilinkCreateContext({ folderId: null, onCreated });

    const opens: unknown[] = [];
    const onOpen = (e: Event) => {
      opens.push((e as CustomEvent).detail);
    };
    window.addEventListener('DSTU_OPEN_NOTE', onOpen);
    try {
      await expect(createNoteFromWikilinkTitle('Ghost2')).resolves.toBe('note-88');
    } finally {
      window.removeEventListener('DSTU_OPEN_NOTE', onOpen);
      restore();
    }

    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ noteId: 'note-88', source: 'wikilink', target: 'Ghost2' });
  });
});
