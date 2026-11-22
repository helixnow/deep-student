import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MindMapNode } from '../../types';

const { invokeMock, saveAnkiCardsMock, deleteAnkiCardsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveAnkiCardsMock: vi.fn(),
  deleteAnkiCardsMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: saveAnkiCardsMock,
    deleteAnkiCards: deleteAnkiCardsMock,
  },
}));

import {
  __resetMindMapCardProjectionForTests,
  buildMindMapFlashcardId,
  hydrateMindMapProjectedFlashcardStates,
  loadMindMapMasterySummary,
  removeProjectedFlashcard,
  seedMindMapProjectedFlashcardsBaseline,
} from '../mindmapCardProjection';
import { saveReciteStats } from '../../utils/reciteStats';

describe('mindmapCardProjection — restart-safe FSRS suspend & mastery summary', () => {
  beforeEach(() => {
    __resetMindMapCardProjectionForTests();
    invokeMock.mockReset();
    saveAnkiCardsMock.mockReset();
    deleteAnkiCardsMock.mockReset();
    globalThis.localStorage?.clear();
  });

  it('hydrates FSRS stateId from backend after restart and suspends instead of physically deleting', async () => {
    const mapId = 'mm_restart_safe';
    const nodeId = 'n_calculus';
    const cardId = buildMindMapFlashcardId(mapId, nodeId);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return {
          items: [
            {
              id: cardId,
              documentId: mapId,
              stateId: 'fsrs_state_persisted_42',
              state: 2,
              enqueued: true,
              suspended: false,
              isDue: false,
            },
          ],
          page: 1,
          pageSize: 200,
          total: 1,
        };
      }
      if (cmd === 'fsrs_suspend_card') {
        return { changed: true };
      }
      return null;
    });

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId });

    expect(invokeMock).toHaveBeenCalledWith('list_anki_library_cards', {
      request: { search: 'mindmap-card', page: 1, pageSize: 200 },
    });
    expect(invokeMock).toHaveBeenCalledWith('fsrs_suspend_card', {
      cardStateId: 'fsrs_state_persisted_42',
    });
    expect(deleteAnkiCardsMock).not.toHaveBeenCalled();
  });

  it('falls back to fsrs_get_due / fsrs_get_memory_overview when library search does not include the card', async () => {
    const mapId = 'mm_fallback';
    const nodeId = 'n_due';
    const cardId = buildMindMapFlashcardId(mapId, nodeId);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return { items: [], page: 1, pageSize: 200, total: 0 };
      }
      if (cmd === 'fsrs_get_due') {
        return [{ id: 'fsrs_due_state_7', ankiCardId: cardId, state: 2 }];
      }
      if (cmd === 'fsrs_get_memory_overview') {
        return { recent: [] };
      }
      if (cmd === 'fsrs_suspend_card') {
        return { changed: true };
      }
      return null;
    });

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId });

    expect(invokeMock).toHaveBeenCalledWith('fsrs_suspend_card', {
      cardStateId: 'fsrs_due_state_7',
    });
    expect(deleteAnkiCardsMock).not.toHaveBeenCalled();
  });

  it('never physically deletes when backend lookup fails (unverified FSRS history)', async () => {
    const mapId = 'mm_offline';
    const nodeId = 'n_offline';
    const cardId = buildMindMapFlashcardId(mapId, nodeId);

    invokeMock.mockRejectedValue(new Error('IPC unavailable'));

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId });

    expect(deleteAnkiCardsMock).not.toHaveBeenCalled();
  });

  it('deletes only when backend confirms the card has zero FSRS state or review history', async () => {
    const mapId = 'mm_draft';
    const nodeId = 'n_draft';
    const cardId = buildMindMapFlashcardId(mapId, nodeId);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return {
          items: [
            {
              id: cardId,
              documentId: mapId,
              stateId: null,
              state: null,
              enqueued: false,
              suspended: false,
              isDue: false,
              latestReview: null,
            },
          ],
          page: 1,
          pageSize: 200,
          total: 1,
        };
      }
      return null;
    });
    deleteAnkiCardsMock.mockResolvedValue(undefined);

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId });

    expect(deleteAnkiCardsMock).toHaveBeenCalledWith({ cardIds: [cardId] });
  });

  it('pre-warms fsrsStateIdByCardId on seedMindMapProjectedFlashcardsBaseline', async () => {
    const mapId = 'mm_warmup';
    const cardId = buildMindMapFlashcardId(mapId, 'n1');
    const root: MindMapNode = {
      id: 'root',
      text: 'Root',
      children: [{ id: 'n1', text: 'Card Node', isFlashcard: true, children: [] }],
    };

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return {
          items: [{ id: cardId, documentId: mapId, stateId: 'fsrs_warmed_1', enqueued: true }],
          page: 1,
          pageSize: 200,
          total: 1,
        };
      }
      if (cmd === 'fsrs_suspend_card') return { changed: true };
      return null;
    });

    seedMindMapProjectedFlashcardsBaseline(mapId, root);
    await hydrateMindMapProjectedFlashcardStates(mapId, [cardId]);
    invokeMock.mockClear();

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId: 'n1' });

    // Cached stateId used directly without another library query
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('fsrs_suspend_card', {
      cardStateId: 'fsrs_warmed_1',
    });
  });

  it('loads and fuses mastery summary across backend FSRS states and local reciteStats', async () => {
    const mapId = 'mm_mastery';
    const dueMs = Date.now() - 60_000;
    const futureMs = Date.now() + 86_400_000 * 14;

    saveReciteStats(mapId, {
      // Only local reciteStats (struggling: 2/2 misses -> Laplace 3/4 = 0.75)
      n_recite_weak: { 0: { attempts: 2, misses: 2 } },
      // Only local reciteStats (mastered: 3/3 recalled -> Laplace 1/5 = 0.2)
      n_recite_strong: { 0: { attempts: 3, misses: 0 } },
      // High recite error rate upgrades an FSRS learning card to struggling
      n_learning_but_missed: { 0: { attempts: 2, misses: 2 } },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return {
          items: [
            {
              id: buildMindMapFlashcardId(mapId, 'n_mastered'),
              documentId: mapId,
              stateId: 'st_mastered',
              state: 2,
              dueMs: futureMs,
              enqueued: true,
              suspended: false,
              isDue: false,
            },
            {
              id: buildMindMapFlashcardId(mapId, 'n_learning_but_missed'),
              documentId: mapId,
              stateId: 'st_learn',
              state: 1,
              dueMs: futureMs,
              enqueued: true,
              suspended: false,
              isDue: false,
            },
            {
              id: buildMindMapFlashcardId(mapId, 'n_suspended'),
              documentId: mapId,
              stateId: 'st_susp',
              state: 2,
              dueMs,
              enqueued: true,
              suspended: true,
              isDue: true,
            },
          ],
          page: 1,
          pageSize: 200,
          total: 3,
        };
      }
      if (cmd === 'fsrs_get_due') {
        return [
          {
            id: 'st_due',
            ankiCardId: buildMindMapFlashcardId(mapId, 'n_due'),
            state: 2,
            stability: 4,
            lapses: 0,
            dueMs,
            suspended: false,
            leech: false,
          },
          {
            id: 'st_struggling',
            ankiCardId: buildMindMapFlashcardId(mapId, 'n_struggling'),
            state: 3,
            stability: 1.2,
            lapses: 3,
            dueMs,
            suspended: false,
            leech: true,
          },
        ];
      }
      if (cmd === 'fsrs_get_memory_overview') {
        return {
          recent: [
            {
              cardStateId: 'st_mastered',
              ankiCardId: buildMindMapFlashcardId(mapId, 'n_mastered'),
              state: 2,
              stability: 18,
              reps: 5,
              lapses: 0,
              dueMs: futureMs,
              lastRating: 3,
            },
          ],
        };
      }
      return null;
    });

    const summary = await loadMindMapMasterySummary(mapId);

    expect(summary.n_mastered).toMatchObject({
      status: 'mastered',
      lapses: 0,
      cardId: buildMindMapFlashcardId(mapId, 'n_mastered'),
    });
    expect(summary.n_due).toMatchObject({
      status: 'due',
      dueAt: new Date(dueMs).toISOString(),
      lapses: 0,
      cardId: buildMindMapFlashcardId(mapId, 'n_due'),
    });
    expect(summary.n_struggling).toMatchObject({
      status: 'struggling',
      lapses: 3,
      cardId: buildMindMapFlashcardId(mapId, 'n_struggling'),
    });
    expect(summary.n_learning_but_missed.status).toBe('struggling');
    expect(summary.n_recite_weak).toMatchObject({
      status: 'struggling',
      lapses: 2,
    });
    expect(summary.n_recite_strong).toMatchObject({
      status: 'mastered',
    });
    expect(summary.n_suspended).toBeUndefined();
  });

  it('never physically deletes when target card is missing from library results (pagination truncation >1000 or removed tag)', async () => {
    const mapId = 'mm_truncated';
    const nodeId = 'n_missing';
    const cardId = buildMindMapFlashcardId(mapId, nodeId);

    // Case 1: >1000 cards paginated across 5 pages without matching cardId
    invokeMock.mockImplementation(async (cmd: string, args?: { request?: { page?: number } }) => {
      if (cmd === 'list_anki_library_cards') {
        const page = args?.request?.page ?? 1;
        return {
          items: Array.from({ length: 200 }, (_, i) => ({
            id: `card_other_${page}_${i}`,
            sourceId: 'mm_other',
            stateId: null,
            enqueued: false,
            suspended: false,
            isDue: false,
          })),
          page,
          pageSize: 200,
          total: 1500,
        };
      }
      if (cmd === 'fsrs_get_due') return [];
      if (cmd === 'fsrs_get_memory_overview') return { recent: [] };
      return null;
    });

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId });
    expect(deleteAnkiCardsMock).not.toHaveBeenCalled();

    // Case 2: card tag 'mindmap-card' was removed by user so search returns empty complete list
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return { items: [], page: 1, pageSize: 200, total: 0 };
      }
      if (cmd === 'fsrs_get_due') return [];
      if (cmd === 'fsrs_get_memory_overview') return { recent: [] };
      return null;
    });

    await removeProjectedFlashcard({ id: cardId, mapId, nodeId });
    expect(deleteAnkiCardsMock).not.toHaveBeenCalled();
  });

  it('does not mark new cards (state=0) as due, does not optimistically mark missing-stability review cards as mastered, and matches cards by sourceId', async () => {
    const mapId = 'mm_contract_align';
    const nowMs = Date.now();
    const soonFutureMs = nowMs + 86_400_000 * 2;
    const farFutureMs = nowMs + 86_400_000 * 10;

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return {
          items: [
            // Matched strictly via backend sourceId (no documentId/sourceRef, custom card id with extra_fields)
            {
              id: 'custom_source_id_card',
              sourceId: mapId,
              extra_fields: { SourceMindMapId: mapId, SourceNodeId: 'n_source_id' },
              stateId: 'st_src',
              state: 2,
              dueMs: farFutureMs,
              enqueued: true,
              suspended: false,
              isDue: false,
            },
            // state=2 with missing stability and near dueMs (< 7d) -> must stay conservative 'learning'
            {
              id: buildMindMapFlashcardId(mapId, 'n_no_stab_near'),
              sourceId: mapId,
              stateId: 'st_no_stab_near',
              state: 2,
              dueMs: soonFutureMs,
              enqueued: true,
              suspended: false,
              isDue: false,
            },
            // state=2 with missing stability and null dueMs -> must stay conservative 'learning'
            {
              id: buildMindMapFlashcardId(mapId, 'n_no_stab_null'),
              sourceId: mapId,
              stateId: 'st_no_stab_null',
              state: 2,
              dueMs: null,
              enqueued: true,
              suspended: false,
              isDue: false,
            },
            // state=0 new card flagged isDue=true by backend -> must NOT be 'due'
            {
              id: buildMindMapFlashcardId(mapId, 'n_new_card'),
              sourceId: mapId,
              stateId: 'st_new',
              state: 0,
              dueMs: nowMs - 10_000,
              enqueued: true,
              suspended: false,
              isDue: true,
            },
          ],
          page: 1,
          pageSize: 200,
          total: 4,
        };
      }
      if (cmd === 'fsrs_get_due') {
        return [
          {
            id: 'st_new_from_due',
            ankiCardId: buildMindMapFlashcardId(mapId, 'n_new_from_due'),
            state: 0,
            stability: null,
            lapses: 0,
            dueMs: nowMs - 5_000,
            suspended: false,
            leech: false,
          },
        ];
      }
      if (cmd === 'fsrs_get_memory_overview') {
        return { recent: [] };
      }
      return null;
    });

    const summary = await loadMindMapMasterySummary(mapId);

    // Matched via sourceId + dueMs >= 7d & lapses === 0 -> inferred mastered
    expect(summary.n_source_id).toMatchObject({
      status: 'mastered',
      cardId: 'custom_source_id_card',
    });
    // Missing stability with <7d horizon or null dueMs -> conservatively learning
    expect(summary.n_no_stab_near.status).toBe('learning');
    expect(summary.n_no_stab_null.status).toBe('learning');
    // New cards (state=0) from library or fsrs_get_due -> never 'due'
    expect(summary.n_new_card.status).toBe('learning');
    expect(summary.n_new_from_due.status).toBe('learning');
  });

  it('degrades safely to an empty object without throwing when backend fails', async () => {
    invokeMock.mockRejectedValue(new Error('No Tauri backend'));

    await expect(loadMindMapMasterySummary('mm_broken')).resolves.toEqual({});
    await expect(loadMindMapMasterySummary('')).resolves.toEqual({});
  });
});
