import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
const exportMock = vi.fn();
vi.mock('@/utils/chatApi', () => ({ listAnkiLibraryCards: (...a: unknown[]) => listMock(...a) }));
vi.mock('@/features/chat/anki', () => ({ exportCardsAsApkg: (...a: unknown[]) => exportMock(...a) }));

import { exportLibraryApkg } from '../exportLibrary';

const card = (id: string) => ({ id, task_id: 't', front: id, back: '', tags: [], images: [], created_at: '', updated_at: '', suspended: false, enqueued: true, isDue: false, template_id: 'design-lab' });

describe('exportLibraryApkg', () => {
  beforeEach(() => {
    listMock.mockReset();
    exportMock.mockReset().mockResolvedValue({ success: true, filePath: '/x.apkg', skippedErrorCards: 0 });
  });

  it('exports only the selection when cards are selected', async () => {
    const out = await exportLibraryApkg([card('a')] as never, 'Deck');
    expect(listMock).not.toHaveBeenCalled();
    expect(exportMock.mock.calls[0][0].cards.map((c: { id: string }) => c.id)).toEqual(['a']);
    expect(out).toEqual({ status: 'exported', count: 1, filePath: '/x.apkg', missingMedia: 0 });
  });

  it('pages through the whole library when nothing is selected and keeps template ids', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => card(`p1-${i}`));
    listMock.mockResolvedValueOnce({ items: page1, total: 201 }).mockResolvedValueOnce({ items: [card('last')], total: 201 });
    const out = await exportLibraryApkg([], 'Deck');
    const sent = exportMock.mock.calls[0][0].cards;
    expect(sent).toHaveLength(201);
    expect(sent[0].template_id).toBe('design-lab');
    expect(out.status).toBe('exported');
  });

  it('reports cancel and empty library', async () => {
    exportMock.mockResolvedValueOnce({ success: false, cancelled: true });
    await expect(exportLibraryApkg([card('a')] as never, 'Deck')).resolves.toEqual({ status: 'cancelled' });
    listMock.mockResolvedValueOnce({ items: [], total: 0 });
    await expect(exportLibraryApkg([], 'Deck')).resolves.toEqual({ status: 'empty' });
  });
});
