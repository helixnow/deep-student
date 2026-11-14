/**
 * Multi-card Image Occlusion compiler & FSRS persistence helper.
 *
 * Builds directly on top of the Rust-compatible `_occlusion` JSON protocol
 * (`src/components/anki/utils/imageOcclusion.ts`) while generating 1..N distinct
 * cards per unique `clozeIndex` with deterministic IDs and distinct `front`/`text`
 * fingerprints so SQLite `idx_anki_cards_dedup_unique` never collides.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  MAX_OCCLUSION_BOXES,
  OCCLUSION_FIELD,
  OCCLUSION_TAG,
  normalizeOcclusionSpec,
  type OcclusionSpec,
} from '@/components/anki/utils/imageOcclusion';
import { ankiApiAdapter, type SaveAnkiCardsResponse } from '@/services/ankiApiAdapter';
import {
  buildProjectedCardId,
  upsertProjectedFlashcardsBatch,
  type ProjectedFlashcardInput,
} from '@/services/liveCardProjector';
import type { AnkiCard } from '@/types';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  serializeSemanticAnchor,
  type SemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { emitFlashcardsChanged } from '@/events/flashcards';

export type OcclusionStudyMode = 'hide-one' | 'hide-all';

export interface OcclusionDraftBoxInput {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  clozeIndex?: number;
}

export interface CompileOcclusionCardsParams {
  /** Scope ID for deterministic card IDs (e.g., sourceAnchor.resourceId or uploaded VFS sourceId). */
  documentScopeId: string;
  /** Persistent image reference: `vfs://<sourceId>` or `data:image/...` fallback in tests. */
  imageRef: string;
  /** 1..12 normalized boxes in [0, 1]. */
  boxes: ReadonlyArray<OcclusionDraftBoxInput>;
  mode: OcclusionStudyMode;
  title?: string;
  extraNote?: string;
  deckName?: string;
  sourceAnchor?: SemanticAnchor;
}

export interface CompiledOcclusionBundle {
  spec: OcclusionSpec;
  cards: AnkiCard[];
  targetClozeIndices: number[];
  cardTitle: string;
  sourceAnchorUri?: string;
}

export interface SaveCompiledOcclusionResult extends CompiledOcclusionBundle {
  savedIds: string[];
  persistedIds: string[];
}

export const MIN_OCCLUSION_BOX_RATIO = 0.01;
const GEOMETRY_EPS = 1e-6;

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isValidDraftBox(box: OcclusionDraftBoxInput): boolean {
  if (!box || typeof box !== 'object') return false;
  const { x, y, w, h } = box;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return false;
  }
  if (x < -GEOMETRY_EPS || y < -GEOMETRY_EPS || x + w > 1 + GEOMETRY_EPS || y + h > 1 + GEOMETRY_EPS) {
    return false;
  }
  const clampedLeft = Math.max(0, Math.min(1, x));
  const clampedTop = Math.max(0, Math.min(1, y));
  const clampedRight = Math.max(0, Math.min(1, x + w));
  const clampedBottom = Math.max(0, Math.min(1, y + h));
  const effectiveW = clampedRight - clampedLeft;
  const effectiveH = clampedBottom - clampedTop;
  return effectiveW >= MIN_OCCLUSION_BOX_RATIO - GEOMETRY_EPS && effectiveH >= MIN_OCCLUSION_BOX_RATIO - GEOMETRY_EPS;
}

function extractPersistedCardIds(
  response: SaveAnkiCardsResponse | Record<string, unknown> | null | undefined,
  fallbackIds: readonly string[],
): { savedIds: string[]; persistedIds: string[] } {
  const raw = (response ?? {}) as Record<string, unknown>;
  const savedRaw = Array.isArray(raw.savedIds)
    ? raw.savedIds
    : Array.isArray(raw.saved_ids)
      ? raw.saved_ids
      : [];
  const savedIds = savedRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  const dupRaw = Array.isArray(raw.duplicatedIds)
    ? raw.duplicatedIds
    : Array.isArray(raw.duplicated_ids)
      ? raw.duplicated_ids
      : [];
  const duplicatedIds = dupRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  const mappingsRaw = Array.isArray(raw.cardIdMappings)
    ? raw.cardIdMappings
    : Array.isArray(raw.card_id_mappings)
      ? raw.card_id_mappings
      : [];
  const mappedIds = mappingsRaw
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const rec = m as Record<string, unknown>;
      const pid = rec.persistedId ?? rec.persisted_id;
      return typeof pid === 'string' && pid.trim() ? pid.trim() : null;
    })
    .filter((id): id is string => id !== null);

  const persistedSet = new Set<string>([...savedIds, ...duplicatedIds, ...mappedIds]);
  if (persistedSet.size === 0) {
    for (const id of fallbackIds) {
      if (id) persistedSet.add(id);
    }
  }
  return {
    savedIds,
    persistedIds: Array.from(persistedSet),
  };
}

/**
 * Pure multi-card Image Occlusion compiler.
 * Filters out out-of-bounds or tiny (`< 0.01`) boxes, caps at 12 regions,
 * and generates 1 card per unique `clozeIndex`.
 */
export function compileOcclusionCards(params: CompileOcclusionCardsParams): CompiledOcclusionBundle {
  const scopeId = params.documentScopeId?.trim();
  if (!scopeId) {
    throw new Error('documentScopeId is required for Image Occlusion cards');
  }
  const imageRef = params.imageRef?.trim();
  if (!imageRef) {
    throw new Error('imageRef is required for Image Occlusion cards');
  }

  const validInputBoxes = (params.boxes ?? [])
    .filter(isValidDraftBox)
    .slice(0, MAX_OCCLUSION_BOXES);

  const spec = normalizeOcclusionSpec({
    imageRef,
    boxes: validInputBoxes,
  });
  if (!spec || spec.boxes.length === 0) {
    throw new Error('At least one valid occlusion box (>= 1% width and height within [0, 1]) is required');
  }

  const mode: OcclusionStudyMode = params.mode === 'hide-all' ? 'hide-all' : 'hide-one';
  const cardTitle =
    params.title?.trim() ||
    params.sourceAnchor?.label?.trim() ||
    '图片遮挡';
  const extraNote = params.extraNote?.trim() || '';

  let sourceAnchorUri: string | undefined;
  if (params.sourceAnchor) {
    try {
      sourceAnchorUri = serializeSemanticAnchor(params.sourceAnchor);
    } catch {
      sourceAnchorUri = undefined;
    }
  }

  const uniqueTargets = Array.from(new Set(spec.boxes.map((box) => box.clozeIndex))).sort(
    (a, b) => a - b,
  );
  const specJson = JSON.stringify(spec);
  const escapedImg = escapeHtmlAttr(spec.imageRef);
  const modeTag = mode === 'hide-all' ? 'io-hide-all' : 'io-hide-one';

  const cards: AnkiCard[] = uniqueTargets.map((targetClozeIndex) => {
    const id = buildProjectedCardId(
      'pdf_occlusion',
      `${scopeId}:${spec.imageRef}:${mode}:${targetClozeIndex}`,
    );
    const matchingBoxes = spec.boxes.filter((box) => box.clozeIndex === targetClozeIndex);
    const targetLabel =
      matchingBoxes
        .map((box) => box.label.trim())
        .filter(Boolean)
        .join(' / ') || `区域 ${targetClozeIndex}`;

    const front = `${cardTitle} · #${targetClozeIndex}\n<img src="${escapedImg}" />`;
    const back = extraNote ? `${targetLabel}\n\n${extraNote}` : targetLabel;
    const text = `${cardTitle} {{c${targetClozeIndex}::${targetLabel}}}`;

    const fields: Record<string, string> = {
      [OCCLUSION_FIELD]: specJson,
      _occlusion_mode: mode,
      _occlusion_target: String(targetClozeIndex),
      ...(sourceAnchorUri ? { _source_anchor: sourceAnchorUri } : {}),
      ...(extraNote ? { Extra: extraNote } : {}),
    };

    return {
      id,
      front,
      back,
      text,
      tags: [OCCLUSION_TAG, modeTag],
      images: [spec.imageRef],
      fields,
      extra_fields: { ...fields },
    };
  });

  return {
    spec,
    cards,
    targetClozeIndices: uniqueTargets,
    cardTitle,
    ...(sourceAnchorUri ? { sourceAnchorUri } : {}),
  };
}

/**
 * Compiles, saves to SQLite `anki_cards`, enqueues into FSRS review queue,
 * emits flashcards refresh events, and records incoming `vfs_anchor_edges` backlinks.
 */
export async function saveCompiledOcclusionCards(
  params: CompileOcclusionCardsParams,
): Promise<SaveCompiledOcclusionResult> {
  const compiled = compileOcclusionCards(params);
  const scopeId = params.documentScopeId.trim();
  const deckName = params.deckName?.trim() || compiled.cardTitle;
  let rawResponse: SaveAnkiCardsResponse | null | undefined;

  const projectedInputs: ProjectedFlashcardInput[] = compiled.cards.map((card, idx) => {
    const clozeIdx = compiled.targetClozeIndices[idx];
    return {
      sourceKind: 'pdf_occlusion',
      sourceId: `${scopeId}:${compiled.spec.imageRef}:${params.mode}:${clozeIdx}`,
      cardId: card.id,
      documentId: scopeId,
      deckName,
      front: card.front,
      back: card.back,
      clozeText: card.text,
      noteType: 'Basic',
      tags: card.tags,
      images: card.images,
      extraFields: card.fields,
      anchors: params.sourceAnchor ? [params.sourceAnchor] : [],
      sourceLabel: `${compiled.cardTitle} · #${clozeIdx}`.slice(0, 120),
      ...(compiled.sourceAnchorUri ? { sourceRef: compiled.sourceAnchorUri } : {}),
      edgeSourceSubId: String(clozeIdx),
    };
  });

  const batchResult = await upsertProjectedFlashcardsBatch(projectedInputs, {
    reason: 'image-occlusion-create',
    adapter: {
      saveCards: async ({ documentId, cards, options }) => {
        rawResponse = await ankiApiAdapter.saveAnkiCards({
          documentId,
          cards,
          options,
        });
        return rawResponse;
      },
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
      pruneAnchorEdgesBySource: async (pruneParams) => {
        const kernel = getAppKernel();
        if (!kernel?.anchors) return undefined;
        return kernel.anchors.pruneAnchorEdgesBySource(pruneParams);
      },
      notifyFlashcardsChanged: (reason) => emitFlashcardsChanged(reason),
    },
  });

  const fallbackIds = compiled.cards.map((card) => card.id ?? '').filter(Boolean);
  const { savedIds, persistedIds } = rawResponse
    ? extractPersistedCardIds(rawResponse, fallbackIds)
    : { savedIds: batchResult.savedIds, persistedIds: batchResult.persistedIds };

  return {
    ...compiled,
    savedIds,
    persistedIds,
  };
}
