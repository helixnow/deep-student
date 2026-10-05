import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, openMedia } = vi.hoisted(() => ({ invoke: vi.fn(), openMedia: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/features/learning-hub/apps/views/media/mediaRefEvents', () => ({ dispatchOpenMediaRef: openMedia }));

import { findLibraryCard, openCardSourceTarget, resolveCardSource } from '../cardSource';

describe('resolveCardSource', () => {
  it('prefers the generation source note / resource page', () => {
    const target = resolveCardSource(
      { sourceRef: { kind: 'note', id: 'note_1', title: '笔记' }, sourceSessionId: 'sess_1' },
      ['出处 [媒体@res_v:01:30]'],
    );
    expect(target).toEqual({ kind: 'ref', ref: { kind: 'note', id: 'note_1', title: '笔记' } });
  });

  it('falls back to the media timestamp, then a leftover [PDF@id:page] marker, then the chat that made it', () => {
    expect(resolveCardSource(null, ['背面 [媒体@res_v:01:30]'])).toEqual({
      kind: 'media',
      media: { resourceId: 'res_v', seconds: 90, label: '01:30' },
    });
    expect(resolveCardSource(null, ['出处：[PDF@file_abc:12]'])).toEqual({
      kind: 'ref',
      ref: { kind: 'resource', id: 'file_abc', page: 12 },
    });
    expect(resolveCardSource({ sourceSessionId: ' sess_9 ' }, ['plain'])).toEqual({ kind: 'chat', sessionId: 'sess_9' });
    expect(resolveCardSource({ sourceType: 'chat_session', sourceId: 'sess_old' }, [])).toEqual({ kind: 'chat', sessionId: 'sess_old' });
  });

  it('returns null when the card carries no source at all', () => {
    expect(resolveCardSource({ sourceType: 'apkg_import' }, ['正面', '背面'])).toBeNull();
  });
});

describe('findLibraryCard', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('searches the library by a hint and matches the exact card id', async () => {
    invoke.mockResolvedValue({ items: [{ id: 'other' }, { id: 'card_2', sourceRef: { id: 'tb_1' } }], page: 1, pageSize: 200, total: 2 });
    const card = await findLibraryCard('card_2', '  什么是 极限  ');
    expect(card?.id).toBe('card_2');
    expect(invoke).toHaveBeenCalledWith('list_anki_library_cards', {
      request: expect.objectContaining({ search: '什么是 极限', page: 1, pageSize: 200 }),
    });
  });

  it('does not query without a hint and returns null when the id is not on the page', async () => {
    expect(await findLibraryCard('card_2', '   ')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ items: [{ id: 'other' }] });
    expect(await findLibraryCard('card_2', 'hint')).toBeNull();
  });
});

describe('openCardSourceTarget', () => {
  it('opens notes through DSTU_OPEN_NOTE with the caller as source and plays media at the timestamp', () => {
    const onOpenNote = vi.fn();
    window.addEventListener('DSTU_OPEN_NOTE', onOpenNote);
    openCardSourceTarget({ kind: 'ref', ref: { kind: 'note', id: 'note_1' } }, 'flashcards-review');
    expect((onOpenNote.mock.calls[0][0] as CustomEvent).detail).toEqual({ noteId: 'note_1', source: 'flashcards-review' });
    window.removeEventListener('DSTU_OPEN_NOTE', onOpenNote);

    openCardSourceTarget({ kind: 'media', media: { resourceId: 'res_v', seconds: 90, label: '01:30' } });
    expect(openMedia).toHaveBeenCalledWith('res_v', 90);
  });
});
