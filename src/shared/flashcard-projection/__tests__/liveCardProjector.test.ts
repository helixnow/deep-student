import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProjectedCardId,
  resetProjectedFlashcardCache,
  removeProjectedFlashcard,
  upsertProjectedFlashcard,
  upsertProjectedFlashcardsBatch,
  type ProjectedFlashcardHostAdapter,
} from '@/services/liveCardProjector';
import { fnv1a64Hex, type AnchorEdgeRecord, type PdfSemanticAnchor } from '@/ui-kernel/contracts/interop';

interface SimulatedFsrsState {
  cardId: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  dueMs: number;
  lastReviewMs: number | null;
}

describe('liveCardProjector (Universal Live Flashcard Projection Service)', () => {
  beforeEach(() => {
    resetProjectedFlashcardCache();
    vi.clearAllMocks();
  });

  const input = (front = '问题') => ({
    sourceKind: 'mindmap_node' as const,
    sourceId: 'map:node',
    front,
    back: '答案',
  });

  function host(overrides: ProjectedFlashcardHostAdapter = {}): ProjectedFlashcardHostAdapter {
    return {
      saveCards: vi.fn(async ({ cards }) => ({ savedIds: cards.map((card) => card.id!) })),
      enqueueNewCards: vi.fn(async () => {}),
      upsertAnchorEdges: vi.fn(async () => {}),
      pruneAnchorEdgesBySource: vi.fn(async () => {}),
      notifyFlashcardsChanged: vi.fn(),
      deleteCard: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('serializes rapid updates to the same document and enqueues only once', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.fn(async ({ cards }) => {
      if (cards[0].front === '旧') await blocked;
      return { savedIds: cards.map((card: { id: string }) => card.id) };
    });
    const adapter = host({ saveCards: save });
    const first = upsertProjectedFlashcard(input('旧'), { adapter });
    const second = upsertProjectedFlashcard(input('新'), { adapter });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(save.mock.calls.map(([args]) => args.cards[0].front)).toEqual(['旧', '新']);
    expect(adapter.enqueueNewCards).toHaveBeenCalledTimes(1);
  });

  it('participates in all document locks for mixed-document batches', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writes: string[] = [];
    const adapter = host({ saveCards: async ({ documentId, cards }) => {
      if (cards[0].front === '正在保存') await blocked;
      writes.push(`${documentId}:${cards[0].front}`);
      return { savedIds: cards.map((card) => card.id!) };
    } });
    const first = upsertProjectedFlashcard({ ...input('正在保存'), sourceId: 'second:node' }, { adapter });
    const batch = upsertProjectedFlashcardsBatch([
      input('首文档'), { ...input('末次更新'), sourceId: 'second:node' },
    ], { adapter });
    await vi.waitFor(() => expect(writes).toEqual(['map:首文档']));
    release();
    await Promise.all([first, batch]);
    expect(writes).toEqual(['map:首文档', 'second:正在保存', 'second:末次更新']);
  });

  it('prunes persisted stale edges even on the first sync after restart with no anchors', async () => {
    const adapter = host();
    const result = await upsertProjectedFlashcard(input(), { adapter });
    expect(adapter.pruneAnchorEdgesBySource).toHaveBeenCalledWith({
      sourceKind: 'flashcard', sourceResourceId: result.persistedCardId, keepEdgeIds: [],
    });
  });

  it('does not cache failed edge writes or leave an unhandled rejected lock promise', async () => {
    const adapter = host({ pruneAnchorEdgesBySource: vi.fn().mockRejectedValueOnce(new Error('离线')).mockResolvedValue(undefined) });
    await expect(upsertProjectedFlashcard(input(), { adapter })).rejects.toThrow('离线');
    await expect(upsertProjectedFlashcard(input(), { adapter })).resolves.toMatchObject({ skippedUnchanged: false });
    expect(adapter.saveCards).toHaveBeenCalledTimes(2);
  });

  it('does not mark a null save response successful', async () => {
    const adapter = host({ saveCards: vi.fn().mockResolvedValue(null) });
    await expect(upsertProjectedFlashcard(input(), { adapter })).rejects.toThrow('could not be saved');
    expect(adapter.enqueueNewCards).not.toHaveBeenCalled();
  });

  it('saves changes to deck and provenance labels rather than treating content as unchanged', async () => {
    const adapter = host();
    await upsertProjectedFlashcard(input(), { adapter });
    await upsertProjectedFlashcard({ ...input(), deckName: '新牌组', sourceLabel: '新来源' }, { adapter });
    expect(adapter.saveCards).toHaveBeenCalledTimes(2);
    expect(adapter.enqueueNewCards).toHaveBeenCalledTimes(1);
  });

  it('propagates deletion failure without forgetting the persisted identity', async () => {
    const adapter = host({
      saveCards: async () => ({ cardIdMappings: [{ inputId: buildProjectedCardId('mindmap_node', 'map:node'), persistedId: 'persisted' }] }),
      deleteCard: vi.fn().mockRejectedValueOnce(new Error('删除失败')).mockResolvedValue(undefined),
    });
    await upsertProjectedFlashcard(input(), { adapter });
    await expect(removeProjectedFlashcard('mindmap_node', 'map:node', { adapter })).rejects.toThrow('删除失败');
    await removeProjectedFlashcard('mindmap_node', 'map:node', { adapter });
    expect(adapter.deleteCard).toHaveBeenLastCalledWith('persisted');
  });

  it('derives deterministic card IDs across all 4 sourceKinds matching fnv1a64Hex', () => {
    expect(buildProjectedCardId('note_inline', 'note_1:blk_a')).toBe(
      `card_inline_${fnv1a64Hex('note_1:blk_a')}`,
    );
    expect(buildProjectedCardId('mindmap_node', 'mm_9:node_42')).toBe(
      `card_mm_${fnv1a64Hex('mm_9:node_42')}`,
    );
    expect(buildProjectedCardId('pdf_occlusion', 'pdf_1:vfs://img1:hide-one:2')).toBe(
      `card_io_${fnv1a64Hex('pdf_1:vfs://img1:hide-one:2')}`,
    );
    expect(buildProjectedCardId('qbank_mistake', 'bank_3:q_108')).toBe(
      `card_qb_${fnv1a64Hex('bank_3:q_108')}`,
    );
  });

  it('preserves existing FSRS stability/difficulty/reps/lapses/due when front, back, or anchors change, and cleans up on remove', async () => {
    const cardRows = new Map<
      string,
      { front: string; back: string; tags: string[]; fields: Record<string, string>; documentId: string }
    >();
    const fsrsRows = new Map<string, SimulatedFsrsState>();
    const edgeRows = new Map<string, AnchorEdgeRecord>();

    const enqueueSpy = vi.fn(async (cardIds: string[]) => {
      for (const id of cardIds) {
        // Naive initial enqueue sets reps=0, stability=0; projector MUST NOT re-call this on updates!
        fsrsRows.set(id, {
          cardId: id,
          stability: 0,
          difficulty: 5.0,
          reps: 0,
          lapses: 0,
          dueMs: 1700000000000,
          lastReviewMs: null,
        });
      }
    });

    const saveSpy = vi.fn(async ({ documentId, cards }) => {
      const savedIds: string[] = [];
      for (const card of cards) {
        const id = card.id!;
        cardRows.set(id, {
          front: card.front,
          back: card.back,
          tags: card.tags,
          fields: card.fields ?? {},
          documentId,
        });
        savedIds.push(id);
      }
      return { savedIds };
    });

    const deleteSpy = vi.fn(async (cardId: string) => {
      cardRows.delete(cardId);
      fsrsRows.delete(cardId);
    });

    const notifySpy = vi.fn();

    const adapter: ProjectedFlashcardHostAdapter = {
      saveCards: saveSpy,
      enqueueNewCards: enqueueSpy,
      deleteCard: deleteSpy,
      upsertAnchorEdges: async (inputs) => {
        const created: AnchorEdgeRecord[] = inputs.map((inp) => {
          const targetPage = inp.targetAnchor.kind === 'pdf' ? inp.targetAnchor.page : null;
          const edgeId = `edge_${inp.sourceResourceId}_p${targetPage ?? 0}`;
          const rec: AnchorEdgeRecord = {
            edgeId,
            sourceKind: 'flashcard',
            sourceResourceId: inp.sourceResourceId,
            sourceSubId: inp.sourceSubId ?? '',
            sourceAnchorUri: `ds-anchor://v1/custom/flashcard?id=${inp.sourceResourceId}&loc=node`,
            sourceLabel: inp.sourceLabel ?? '',
            targetKind: inp.targetAnchor.kind,
            targetResourceId: inp.targetAnchor.resourceId,
            targetLocatorKey: targetPage ? `p:${targetPage}` : '',
            targetPage,
            targetStartMs: null,
            targetEndMs: null,
            targetRect: null,
            targetAnchorUri: `ds-anchor://v1/pdf/${inp.targetAnchor.resourceId}?page=${targetPage ?? 1}`,
            studySpaceId: inp.studySpaceId ?? null,
            createdAt: 1000,
            updatedAt: 1000,
          };
          edgeRows.set(edgeId, rec);
          return rec;
        });
        return { upserted: created.length, edges: created };
      },
      pruneAnchorEdgesBySource: async ({ sourceResourceId, keepEdgeIds = [] }) => {
        const keep = new Set(keepEdgeIds);
        let deleted = 0;
        for (const [id, rec] of Array.from(edgeRows.entries())) {
          if (rec.sourceResourceId === sourceResourceId && !keep.has(id)) {
            edgeRows.delete(id);
            deleted += 1;
          }
        }
        return { deleted };
      },
      notifyFlashcardsChanged: notifySpy,
    };

    const pdfPage12: PdfSemanticAnchor = {
      kind: 'pdf',
      resourceId: 'pdf_calc',
      page: 12,
      quote: '闭区间上连续的函数必有界',
    };
    const pdfPage45: PdfSemanticAnchor = {
      kind: 'pdf',
      resourceId: 'pdf_calc',
      page: 45,
      quote: '拉格朗日中值定理推论',
    };

    // 1. Initial MindMap node -> Flashcard projection
    const created = await upsertProjectedFlashcard(
      {
        sourceKind: 'mindmap_node',
        sourceId: 'mm_calc:node_lagrange',
        spaceId: 'space_math',
        deckName: '高等数学导图',
        front: '[微分中值定理] 拉格朗日中值定理条件',
        back: '闭区间连续，开区间可导',
        anchors: [pdfPage12],
      },
      { adapter },
    );

    expect(created.created).toBe(true);
    expect(created.updated).toBe(false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(edgeRows.size).toBe(1);

    // 2. Simulate learner completing 7 FSRS reviews over 3 weeks!
    const maturedFsrs: SimulatedFsrsState = {
      cardId: created.persistedCardId,
      stability: 24.6,
      difficulty: 3.85,
      reps: 7,
      lapses: 1,
      dueMs: 1780000000000,
      lastReviewMs: 1778000000000,
    };
    fsrsRows.set(created.persistedCardId, { ...maturedFsrs });

    // 3. Learner edits MindMap node title, enriches back with merged excerpt p.45, and drops p.12
    const updated = await upsertProjectedFlashcard(
      {
        sourceKind: 'mindmap_node',
        sourceId: 'mm_calc:node_lagrange',
        spaceId: 'space_math',
        deckName: '高等数学导图',
        front: '[中值定理体系] 拉格朗日中值定理充要条件与几何意义',
        back: '1. [a,b] 连续\n2. (a,b) 可导\n3. 存在切线平行于割线',
        anchors: [pdfPage45],
      },
      { adapter },
    );

    expect(updated.cardId).toBe(created.cardId);
    expect(updated.created).toBe(false);
    expect(updated.updated).toBe(true);

    // CRITICAL FSRS INVARIANT: enqueueNewCards NOT called again; FSRS state 100% intact!
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(fsrsRows.get(created.persistedCardId)).toEqual(maturedFsrs);

    // Card content updated in-place under same documentId ('mm_calc')
    const updatedCard = cardRows.get(created.persistedCardId)!;
    expect(updatedCard.documentId).toBe('mm_calc');
    expect(updatedCard.front).toContain('几何意义');
    expect(updatedCard.back).toContain('存在切线平行于割线');
    expect(updatedCard.fields._source_anchor).toContain('page=45');

    // Stale p.12 anchor edge pruned; p.45 anchor edge active
    expect(Array.from(edgeRows.values()).map((e) => e.targetPage)).toEqual([45]);

    // 4. Repeat call with identical payload is a zero-IPC no-op
    const unchanged = await upsertProjectedFlashcard(
      {
        sourceKind: 'mindmap_node',
        sourceId: 'mm_calc:node_lagrange',
        spaceId: 'space_math',
        deckName: '高等数学导图',
        front: '[中值定理体系] 拉格朗日中值定理充要条件与几何意义',
        back: '1. [a,b] 连续\n2. (a,b) 可导\n3. 存在切线平行于割线',
        anchors: [pdfPage45],
      },
      { adapter },
    );
    expect(unchanged.skippedUnchanged).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(2);

    // 5. Untoggling Flashcard on MindMap node removes card & prunes its remaining edges
    const removed = await removeProjectedFlashcard('mindmap_node', 'mm_calc:node_lagrange', {
      adapter,
    });
    expect(removed.removed).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(created.persistedCardId);
    expect(cardRows.size).toBe(0);
    expect(edgeRows.size).toBe(0);
  });
});
