/**
 * Idempotent RemNote-style inline flashcard -> FSRS sync service.
 *
 * Dogfoods the Universal Live Flashcard Projection Service (`@/shared/flashcard-projection`)
 * so deterministic `(noteId, blockId)` card IDs (`card_inline_<fnv1a64>`) update card
 * content & `vfs_anchor_edges` in-place while preserving existing FSRS stability,
 * difficulty, reps, lapses, and due dates across note edits.
 */
import { invoke } from '@tauri-apps/api/core';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { dispatchTypedEvent } from '@/events';
import { ankiApiAdapter } from '@/services/ankiApiAdapter';
import {
  resetProjectedFlashcardCache,
  upsertProjectedFlashcardsBatch,
  type ProjectedFlashcardHostAdapter,
  type ProjectedFlashcardInput,
} from '@/services/liveCardProjector';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { serializeSemanticAnchor } from '@/ui-kernel/contracts/interop';
import {
  compileInlineCardsFromDoc,
  compileInlineCardsFromMarkdown,
  type ParsedInlineCard,
} from './inlineCardParser';

export interface SyncInlineCardsForNoteParams {
  noteId: string;
  noteTitle?: string;
  deckName?: string;
  studySpaceId?: string;
  /** Optional pre-parsed inline cards; otherwise extracted from `doc` or `markdown`. */
  cards?: readonly ParsedInlineCard[];
  /** Live ProseMirror doc (`view.state.doc`), preferred when syncing from Crepe. */
  doc?: ProseNode | null;
  /** Markdown fallback when no live ProseMirror doc is provided. */
  markdown?: string;
}

export interface InlineCardSyncResult {
  noteId: string;
  totalParsed: number;
  dedupedCards: ParsedInlineCard[];
  changedCards: ParsedInlineCard[];
  savedIds: string[];
  duplicatedIds: string[];
  skippedUnchanged: boolean;
}

/** Tracks active `cardId -> sourceId` per note so removed blocks are pruned cleanly. */
const activeSourcesByNote = new Map<string, Map<string, { sourceId: string; contentHash: string }>>();

/** Per-note promise queue so overlapping sync calls execute sequentially. */
const inFlightSyncByNote = new Map<string, Promise<InlineCardSyncResult>>();

export function resetInlineCardSyncCache(noteId?: string): void {
  if (noteId !== undefined) {
    const key = noteId.trim();
    const prev = activeSourcesByNote.get(key);
    if (prev) {
      for (const { sourceId } of prev.values()) {
        resetProjectedFlashcardCache('note_inline', sourceId);
      }
    }
    activeSourcesByNote.delete(key);
    return;
  }
  activeSourcesByNote.clear();
  resetProjectedFlashcardCache('note_inline');
}

export function computeInlineCardDedupFingerprint(card: ParsedInlineCard): string {
  if (card.kind === 'cloze') {
    return `cloze:${(card.clozeText ?? '').trim()}`;
  }
  return `qa:${card.front.length}:${card.front}|${card.back}`;
}

export function deduplicateInlineCards(cards: readonly ParsedInlineCard[]): ParsedInlineCard[] {
  const seenCardIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const out: ParsedInlineCard[] = [];

  for (const card of cards) {
    if (!card.cardId || seenCardIds.has(card.cardId)) continue;
    const fingerprint = computeInlineCardDedupFingerprint(card);
    if (seenFingerprints.has(fingerprint)) continue;
    seenCardIds.add(card.cardId);
    seenFingerprints.add(fingerprint);
    out.push(card);
  }
  return out;
}

function buildInlineNoteProjectorAdapter(): ProjectedFlashcardHostAdapter {
  return {
    saveCards: ({ documentId, cards, options }) =>
      ankiApiAdapter.saveAnkiCards({ documentId, cards, options }),
    enqueueNewCards: async (cardIds) => {
      if (cardIds.length === 0) return;
      await invoke('fsrs_enqueue_cards', { ankiCardIds: cardIds });
    },
    deleteCard: (cardId) => ankiApiAdapter.deleteAnkiCards({ cardIds: [cardId] }),
    upsertAnchorEdges: async (edges) => {
      const kernel = getAppKernel();
      if (!kernel?.anchors) return undefined;
      return kernel.anchors.upsertAnchorEdges(edges);
    },
    pruneAnchorEdgesBySource: async (params) => {
      const kernel = getAppKernel();
      if (!kernel?.anchors) return undefined;
      return kernel.anchors.pruneAnchorEdgesBySource(params);
    },
    notifyFlashcardsChanged: (reason) => {
      for (const name of ['fsrs:library-refresh', 'fsrs:stats-refresh', 'ds:flashcards-changed']) {
        dispatchTypedEvent(name, { reason });
      }
    },
  };
}

async function executeInlineCardSync(
  params: SyncInlineCardsForNoteParams,
): Promise<InlineCardSyncResult> {
  const trimmedNoteId = params.noteId?.trim();
  if (!trimmedNoteId) {
    return {
      noteId: '',
      totalParsed: 0,
      dedupedCards: [],
      changedCards: [],
      savedIds: [],
      duplicatedIds: [],
      skippedUnchanged: true,
    };
  }

  const noteTitle = params.noteTitle?.trim() || undefined;
  const rawCards: readonly ParsedInlineCard[] =
    params.cards ??
    (params.doc
      ? compileInlineCardsFromDoc(params.doc, { noteId: trimmedNoteId, noteTitle }).map(
          (m) => m.card,
        )
      : compileInlineCardsFromMarkdown(params.markdown ?? '', {
          noteId: trimmedNoteId,
          noteTitle,
        }));

  const dedupedCards = deduplicateInlineCards(rawCards);
  const hadPreviousRun = activeSourcesByNote.has(trimmedNoteId);
  const prevMap =
    activeSourcesByNote.get(trimmedNoteId) ??
    new Map<string, { sourceId: string; contentHash: string }>();

  const changedCards = dedupedCards.filter(
    (card) => prevMap.get(card.cardId)?.contentHash !== card.contentHash,
  );

  const currentCardIdSet = new Set(dedupedCards.map((card) => card.cardId));
  const removedEntries: Array<{ cardId: string; sourceId: string }> = [];
  for (const [prevCardId, meta] of prevMap.entries()) {
    if (!currentCardIdSet.has(prevCardId)) {
      removedEntries.push({ cardId: prevCardId, sourceId: meta.sourceId });
    }
  }

  if (hadPreviousRun && changedCards.length === 0 && removedEntries.length === 0) {
    return {
      noteId: trimmedNoteId,
      totalParsed: rawCards.length,
      dedupedCards,
      changedCards: [],
      savedIds: [],
      duplicatedIds: [],
      skippedUnchanged: true,
    };
  }

  const deckName = params.deckName?.trim() || noteTitle || '笔记内联卡';
  const noteAnchorUri = serializeSemanticAnchor({
    kind: 'note',
    resourceId: trimmedNoteId,
    ...(noteTitle ? { label: noteTitle } : {}),
  });

  const adapter = buildInlineNoteProjectorAdapter();

  for (const removed of removedEntries) {
    await adapter.deleteCard!(removed.cardId);
    resetProjectedFlashcardCache('note_inline', removed.sourceId);
  }

  const projectedInputs: ProjectedFlashcardInput[] = dedupedCards.map((card) => ({
    sourceKind: 'note_inline',
    sourceId: `${trimmedNoteId}:${card.blockId}:${card.cardId}`,
    cardId: card.cardId,
    documentId: trimmedNoteId,
    spaceId: params.studySpaceId,
    deckName,
    front: card.front,
    back: card.back,
    clozeText: card.clozeText,
    tags: [card.kind === 'cloze' ? 'cloze' : 'qa'],
    extraFields: {
      _inline_hash: card.contentHash,
    },
    anchors: [card.sourceAnchor],
    sourceLabel: card.front.slice(0, 120),
    sourceRef: noteAnchorUri,
    edgeSourceResourceId: trimmedNoteId,
    edgeSourceSubId: card.cardId,
    pruneStaleEdges: false,
  }));

  const batchResult = await upsertProjectedFlashcardsBatch(projectedInputs, {
    adapter,
    reason: 'inline-note-sync',
    skipEdgePrune: true,
  });

  const kernel = getAppKernel();
  if (kernel?.anchors && (removedEntries.length > 0 || dedupedCards.length > 0)) {
    await kernel.anchors.pruneAnchorEdgesBySource({
      sourceKind: 'flashcard',
      sourceResourceId: trimmedNoteId,
      keepEdgeIds: batchResult.edgeIds,
    });
  }

  const nextMap = new Map<string, { sourceId: string; contentHash: string }>();
  for (const card of dedupedCards) {
    nextMap.set(card.cardId, {
      sourceId: `${trimmedNoteId}:${card.blockId}:${card.cardId}`,
      contentHash: card.contentHash,
    });
  }
  activeSourcesByNote.set(trimmedNoteId, nextMap);
  if (removedEntries.length > 0) adapter.notifyFlashcardsChanged?.('inline-note-sync');

  return {
    noteId: trimmedNoteId,
    totalParsed: rawCards.length,
    dedupedCards,
    changedCards,
    savedIds: batchResult.savedIds,
    duplicatedIds: batchResult.duplicatedIds,
    skippedUnchanged: false,
  };
}

export function syncInlineCardsForNote(
  params: SyncInlineCardsForNoteParams,
): Promise<InlineCardSyncResult> {
  const key = params.noteId?.trim() || '';
  if (!key) {
    return executeInlineCardSync(params);
  }
  const previous = inFlightSyncByNote.get(key) ?? Promise.resolve(undefined);
  const run = previous
    .catch(() => undefined)
    .then(() => executeInlineCardSync(params));

  inFlightSyncByNote.set(key, run);
  const cleanup = () => {
    if (inFlightSyncByNote.get(key) === run) {
      inFlightSyncByNote.delete(key);
    }
  };
  void run.then(cleanup, cleanup);
  return run;
}
