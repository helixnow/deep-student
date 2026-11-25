import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const mocks = vi.hoisted(() => ({
  showGlobalNotification: vi.fn(),
  resolveOpenDesktopCanvasNoteId: vi.fn<() => string | undefined>(() => undefined),
  getWorkspaceActiveResource: vi.fn<() => { type: 'note' | 'mindmap'; id: string } | null>(() => null),
  appendTextToNote: vi.fn(),
  openSavedNote: vi.fn(),
  dstuGet: vi.fn(),
  dstuGetContent: vi.fn(),
  dstuUpdate: vi.fn(),
  saveAnkiCards: vi.fn(),
  enqueueAnkiLibraryCard: vi.fn(),
  requestFlashcardsDueRefresh: vi.fn(),
  upsertAnchorEdges: vi.fn(async () => ({ upserted: 1, edges: [] })),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.showGlobalNotification,
}));

vi.mock('@/features/workbench', () => ({
  resolveOpenDesktopCanvasNoteId: mocks.resolveOpenDesktopCanvasNoteId,
  getWorkspaceActiveResource: mocks.getWorkspaceActiveResource,
}));

vi.mock('@/shared/notes', () => ({
  appendTextToNote: mocks.appendTextToNote,
  openSavedNote: mocks.openSavedNote,
}));

vi.mock('@/dstu', () => ({
  dstu: {
    get: mocks.dstuGet,
    getContent: mocks.dstuGetContent,
    update: mocks.dstuUpdate,
  },
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: mocks.saveAnkiCards,
  },
}));

vi.mock('@/utils/chatApi', () => ({
  enqueueAnkiLibraryCard: mocks.enqueueAnkiLibraryCard,
}));

vi.mock('@/features/flashcards', () => ({
  requestFlashcardsDueRefresh: mocks.requestFlashcardsDueRefresh,
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    anchors: {
      upsertAnchorEdges: mocks.upsertAnchorEdges,
    },
  }),
}));

import {
  appendSelectionToActiveNote,
  buildPdfExcerptMarkdown,
  buildQuickCardDraft,
  createQuickLocalCard,
  hasLocalValidCloze,
  undoAppendedExcerptFromNote,
  wrapSelectionWithCloze,
} from '../selectionStudyActions';

const fakeT = ((key: string, options?: Record<string, unknown>) => {
  const template = (options?.defaultValue as string) ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
}) as unknown as TFunction;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Gap S2-A: 1-Click Append to Active Note with View & Undo', () => {
  it('formats > quote with clickable pdfref:// backlink', () => {
    const md = buildPdfExcerptMarkdown(
      {
        text: 'Multi-head attention allows the model to jointly attend.',
        sourceId: 'file_attention',
        documentTitle: 'Attention.pdf',
        page: 4,
      },
      fakeT,
    );
    expect(md).toContain('> Multi-head attention allows the model to jointly attend.');
    expect(md).toContain('](pdfref://file_attention?page=4&quote=');
  });

  it('returns no_active_note when no note is open so caller can fall back to folder picker', async () => {
    mocks.resolveOpenDesktopCanvasNoteId.mockReturnValue(undefined);
    mocks.getWorkspaceActiveResource.mockReturnValue(null);

    const res = await appendSelectionToActiveNote(
      { text: 'Some quote', sourceId: 'file_1', documentTitle: 'Paper.pdf', page: 2 },
      fakeT,
    );
    expect(res).toEqual({ ok: false, reason: 'no_active_note' });
    expect(mocks.appendTextToNote).not.toHaveBeenCalled();
  });

  it('appends to active note, records PDF backlink, fires Undo toast, and safely undoes exact suffix', async () => {
    mocks.resolveOpenDesktopCanvasNoteId.mockReturnValue('note_active_1');
    mocks.appendTextToNote.mockResolvedValue({
      ok: true,
      noteId: 'note_active_1',
      title: 'Reading Notes',
    });

    const result = await appendSelectionToActiveNote(
      {
        text: 'Scaled Dot-Product Attention divides by sqrt(d_k).',
        sourceId: 'file_arxiv',
        documentTitle: 'Attention.pdf',
        page: 3,
      },
      fakeT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mocks.appendTextToNote).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: 'note_active_1',
        content: expect.stringContaining('pdfref://file_arxiv?page=3'),
      }),
    );
    expect(mocks.upsertAnchorEdges).toHaveBeenCalledTimes(1);
    expect(mocks.showGlobalNotification).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('Reading Notes'),
      undefined,
      expect.objectContaining({
        action: expect.objectContaining({ label: '撤销' }),
      }),
    );

    result.openNote();
    expect(mocks.openSavedNote).toHaveBeenCalledWith('note_active_1', 'pdf-selection');

    const appendedTail = result.appendedMarkdown.trim();
    mocks.dstuGet.mockResolvedValue({ ok: true, value: { id: 'note_active_1', updatedAt: 100 } });
    mocks.dstuGetContent.mockResolvedValue({
      ok: true,
      value: `# Existing notes\n\n---\n\n${appendedTail}`,
    });
    mocks.dstuUpdate.mockResolvedValue({ ok: true, value: { id: 'note_active_1' } });

    const undoRes = await result.undo();
    expect(undoRes).toEqual({ ok: true });
    expect(mocks.dstuUpdate).toHaveBeenCalledWith(
      '/note_active_1',
      '# Existing notes',
      'note',
      { expectedUpdatedAtMs: 100 },
    );
  });

  it('refuses undo without clobbering if the user edited the note after appending', async () => {
    mocks.dstuGet.mockResolvedValue({ ok: true, value: { id: 'note_1', updatedAt: 200 } });
    mocks.dstuGetContent.mockResolvedValue({
      ok: true,
      value: '# Existing\n\n---\n\n> quote\n\nUser added another paragraph',
    });

    const res = await undoAppendedExcerptFromNote('note_1', '> quote');
    expect(res).toEqual({ ok: false, reason: 'modified' });
    expect(mocks.dstuUpdate).not.toHaveBeenCalled();
  });
});

describe('Gap S2-B: Quick Card (Local) zero-LLM flashcard creation with pdfref:// origin', () => {
  it('prefills valid Basic and Cloze drafts locally and wraps selections into numbered clozes', () => {
    const draft = buildQuickCardDraft({
      text: 'Self-Attention: relates different positions of a single sequence',
      documentTitle: 'Attention.pdf',
      page: 2,
    });
    expect(draft.front).toBe('Self-Attention');
    expect(draft.back).toBe('relates different positions of a single sequence');
    expect(hasLocalValidCloze(draft.clozeText)).toBe(true);
    expect(draft.clozeText).toContain('{{c1::relates different positions of a single sequence}}');

    const sample = 'LayerNorm stabilizes {{c1::gradients}} in transformers';
    const start = sample.indexOf('transformers');
    const wrapped = wrapSelectionWithCloze(sample, start, start + 'transformers'.length);
    expect(wrapped.text).toBe('LayerNorm stabilizes {{c1::gradients}} in {{c2::transformers}}');
  });

  it('persists a Basic flashcard locally with pdfref:// origin and ds-anchor backlink without LLM', async () => {
    mocks.saveAnkiCards.mockResolvedValue({
      savedIds: ['card_local_1'],
      taskId: 'task_local_1',
    });
    mocks.enqueueAnkiLibraryCard.mockResolvedValue({ ok: true });

    const res = await createQuickLocalCard(
      {
        mode: 'basic',
        front: 'What is d_k in Transformer base?',
        back: 'd_k = 64',
        sourceText: 'We use d_k = d_v = 64.',
        sourceId: 'file_arxiv_1',
        documentTitle: 'Attention.pdf',
        page: 5,
      },
      fakeT,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cardId).toBe('card_local_1');
    expect(res.pdfRefHref).toContain('pdfref://file_arxiv_1?page=5');
    expect(res.anchorUri).toContain('ds-anchor://v1/pdf/file_arxiv_1?page=5');

    expect(mocks.saveAnkiCards).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          deck_name: '划词制卡::Attention',
          note_type: 'Basic',
        }),
        cards: [
          expect.objectContaining({
            front: 'What is d_k in Transformer base?',
            back: expect.stringContaining('pdfref://file_arxiv_1?page=5'),
            extra_fields: expect.objectContaining({
              _origin_pdfref: expect.stringContaining('pdfref://file_arxiv_1?page=5'),
              _source_anchor: expect.stringContaining('ds-anchor://v1/pdf/file_arxiv_1?page=5'),
            }),
          }),
        ],
      }),
    );
    expect(mocks.enqueueAnkiLibraryCard).toHaveBeenCalledWith('card_local_1');
    expect(mocks.requestFlashcardsDueRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAnchorEdges).toHaveBeenCalledTimes(1);
  });

  it('validates and persists Cloze cards locally', async () => {
    const invalid = await createQuickLocalCard(
      {
        mode: 'cloze',
        front: 'No cloze syntax here',
        back: '',
        sourceText: 'No cloze syntax here',
      },
      fakeT,
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('invalid_cloze');
    expect(mocks.saveAnkiCards).not.toHaveBeenCalled();

    mocks.saveAnkiCards.mockResolvedValue({ savedIds: ['card_cloze_1'], taskId: 't2' });
    const valid = await createQuickLocalCard(
      {
        mode: 'cloze',
        front: 'Attention scales dot products by {{c1::1/sqrt(d_k)}}',
        back: 'Prevents softmax saturation',
        sourceText: 'Attention scales dot products by 1/sqrt(d_k)',
        sourceId: 'file_arxiv_1',
        documentTitle: 'Attention.pdf',
        page: 4,
      },
      fakeT,
    );
    expect(valid.ok).toBe(true);
    expect(mocks.saveAnkiCards).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ note_type: 'Cloze' }),
        cards: [
          expect.objectContaining({
            text: 'Attention scales dot products by {{c1::1/sqrt(d_k)}}',
          }),
        ],
      }),
    );
  });
});
