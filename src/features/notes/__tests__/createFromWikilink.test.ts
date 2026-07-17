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
});
