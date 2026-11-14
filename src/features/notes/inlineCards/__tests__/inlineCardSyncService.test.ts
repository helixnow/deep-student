import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnchorRegistry } from '@/ui-kernel/services/anchors';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  saveAnkiCards: vi.fn(),
  deleteAnkiCards: vi.fn(),
  dispatchTypedEvent: vi.fn(),
  anchors: null as AnchorRegistry | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: mocks.saveAnkiCards,
    deleteAnkiCards: mocks.deleteAnkiCards,
  },
}));

vi.mock('@/events', () => ({ dispatchTypedEvent: mocks.dispatchTypedEvent }));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => (mocks.anchors ? { anchors: mocks.anchors } : null),
}));

import {
  resetInlineCardSyncCache,
  syncInlineCardsForNote,
} from '../inlineCardSyncService';

describe('inlineCardSyncService (Idempotent FSRS Sync & Edge Pruning)', () => {
  beforeEach(() => {
    resetInlineCardSyncCache();
    vi.clearAllMocks();
    mocks.anchors = new AnchorRegistry();
    mocks.invoke.mockResolvedValue({ enqueued: 1 });
    mocks.saveAnkiCards.mockImplementation(async ({ cards }) => ({
      savedIds: cards.map((c: { id: string }) => c.id),
      taskId: 'task_inline_1',
    }));
  });

  it('syncs once and skips unchanged subsequent runs via contentHash cache', async () => {
    const markdown = [
      '自由扩散 >> 顺浓度梯度、不需要载体和能量的跨膜运输 <!-- ds:block-id=blk_diff -->',
      '协助扩散需要 {{转运蛋白}}，但 {{不消耗}} 能量 <!-- ds:block-id=blk_fac -->',
    ].join('\n\n');

    const first = await syncInlineCardsForNote({
      noteId: 'note_membrane',
      noteTitle: '物质跨膜运输',
      markdown,
    });

    expect(first.skippedUnchanged).toBe(false);
    expect(first.changedCards).toHaveLength(2);
    expect(mocks.saveAnkiCards).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('fsrs_enqueue_cards', {
      ankiCardIds: first.savedIds,
    });
    expect(mocks.dispatchTypedEvent).toHaveBeenCalledWith('ds:flashcards-changed', { reason: 'inline-note-sync' });

    const edges = await mocks.anchors!.queryAnchorEdgesByTarget({
      targetResourceIds: ['note_membrane'],
      targetKind: 'note',
    });
    expect(edges).toHaveLength(2);

    // Second sync with identical markdown is a zero-IPC no-op
    const second = await syncInlineCardsForNote({
      noteId: 'note_membrane',
      noteTitle: '物质跨膜运输',
      markdown,
    });
    expect(second.skippedUnchanged).toBe(true);
    expect(mocks.saveAnkiCards).toHaveBeenCalledTimes(1);
  });

  it('updates edited block in-place with identical cardId and documentId without re-enqueuing FSRS, and prunes deleted blocks', async () => {
    const v1 = [
      '光合作用光反应场所 >> 类囊体薄膜 <!-- ds:block-id=blk_1 -->',
      '暗反应场所 >> 叶绿体基质 <!-- ds:block-id=blk_2 -->',
    ].join('\n\n');

    const first = await syncInlineCardsForNote({
      noteId: 'note_photo',
      noteTitle: '光合作用',
      markdown: v1,
    });
    const originalCard1Id = first.dedupedCards[0].cardId;
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // Edit blk_1's right-hand definition & delete blk_2
    const v2 = '光合作用光反应场所 >> 叶绿体类囊体薄膜（含光合色素与酶） <!-- ds:block-id=blk_1 -->';
    const second = await syncInlineCardsForNote({
      noteId: 'note_photo',
      noteTitle: '光合作用',
      markdown: v2,
    });

    expect(second.changedCards).toHaveLength(1);
    expect(second.changedCards[0].cardId).toBe(originalCard1Id);

    // Updated in-place under documentId === 'note_photo' with exact same cardId
    const secondSaveArg = mocks.saveAnkiCards.mock.calls[1][0];
    expect(secondSaveArg.documentId).toBe('note_photo');
    expect(secondSaveArg.cards).toHaveLength(1);
    expect(secondSaveArg.cards[0].id).toBe(originalCard1Id);
    expect(secondSaveArg.cards[0].back).toBe('叶绿体类囊体薄膜（含光合色素与酶）');

    // FSRS enqueue was NOT re-invoked for the already-enqueued card!
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // Deleted blk_2's anchor edge was pruned cleanly
    expect(mocks.deleteAnkiCards).toHaveBeenCalledWith({ cardIds: [first.dedupedCards[1].cardId] });
    const remainingEdges = await mocks.anchors!.queryAnchorEdgesByTarget({
      targetResourceIds: ['note_photo'],
      targetKind: 'note',
    });
    expect(remainingEdges).toHaveLength(1);
    expect(remainingEdges[0].targetAnchorUri).toContain('block=blk_1');
  });

  it('deduplicates identical inline cards within the same note before invoking saveAnkiCards', async () => {
    const dupMarkdown = [
      '熵增原理 >> 孤立系统的熵永不减少 <!-- ds:block-id=blk_a -->',
      '熵增原理 >> 孤立系统的熵永不减少 <!-- ds:block-id=blk_b -->',
    ].join('\n\n');

    const res = await syncInlineCardsForNote({
      noteId: 'note_thermo',
      markdown: dupMarkdown,
    });

    expect(res.totalParsed).toBe(2);
    expect(res.dedupedCards).toHaveLength(1);
    expect(mocks.saveAnkiCards).toHaveBeenCalledTimes(1);
    expect(mocks.saveAnkiCards.mock.calls[0][0].cards).toHaveLength(1);
  });

  it('deletes the last removed card and broadcasts the change even without a save batch', async () => {
    const first = await syncInlineCardsForNote({ noteId: 'note', markdown: '题目 >> 答案 <!-- ds:block-id=one -->' });
    mocks.dispatchTypedEvent.mockClear();
    await syncInlineCardsForNote({ noteId: 'note', markdown: '' });
    expect(mocks.deleteAnkiCards).toHaveBeenCalledWith({ cardIds: first.savedIds });
    expect(mocks.dispatchTypedEvent).toHaveBeenCalledWith('ds:flashcards-changed', { reason: 'inline-note-sync' });
    expect(await mocks.anchors!.queryAnchorEdgesByTarget({ targetResourceIds: ['note'], targetKind: 'note' })).toEqual([]);
  });

  it('recovers the per-note queue after a failed save', async () => {
    mocks.saveAnkiCards.mockRejectedValueOnce(new Error('保存失败'));
    const params = { noteId: 'note', markdown: '题目 >> 答案 <!-- ds:block-id=one -->' };
    await expect(syncInlineCardsForNote(params)).rejects.toThrow('保存失败');
    await expect(syncInlineCardsForNote(params)).resolves.toMatchObject({ skippedUnchanged: false });
  });
});
