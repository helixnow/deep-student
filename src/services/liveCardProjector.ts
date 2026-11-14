/**
 * Universal Live Flashcard Projection Service (`C7 §2.5`).
 *
 * Platform-layer persistence service. Pure deterministic ID helpers live in shared.
 *
 * CRITICAL FSRS INVARIANT:
 * - Projected card IDs are strictly deterministic (`buildProjectedCardId(sourceKind, sourceId)`).
 * - When an existing projected card's `front` / `back` / `clozeText` / `tags` / `anchors`
 *   change (e.g. editing a MindMap node title, merging a second PDF excerpt into a node,
 *   or editing a Note `>>` line), ONLY card content (`anki_cards` row via `document_id`)
 *   and `vfs_anchor_edges` provenance links are updated in-place.
 * - Existing FSRS scheduling parameters (`stability`, `difficulty`, `reps`, `lapses`, `due`,
 *   `last_review_ms`, and review history logs) are NEVER overwritten, reset, or re-initialized.
 */
import { invoke } from '@tauri-apps/api/core';
import { dispatchTypedEvent } from '@/events';
import { buildProjectedCardId, fnv1a64HexFoundation } from '@/shared/flashcard-projection';
export { buildProjectedCardId, fnv1a64HexFoundation } from '@/shared/flashcard-projection';
import type { AnkiCard, AnkiGenerationOptions } from '@/types';
import type {
  AnchorEdgeRecord,
  AnchorEdgeUpsertInput,
  NormalizedRect,
  SemanticAnchor,
} from '@/ui-kernel/contracts/interop';

export type ProjectedFlashcardSourceKind =
  | 'note_inline'
  | 'mindmap_node'
  | 'pdf_occlusion'
  | 'qbank_mistake';

export interface ProjectedFlashcardInput {
  sourceKind: ProjectedFlashcardSourceKind;
  /**
   * Stable source identifier within `sourceKind`
   * (e.g. `${noteId}:${blockId}`, `${mindmapId}:${nodeId}`, `${scopeId}:${imageRef}:${mode}:${k}`).
   */
  sourceId: string;
  /** Optional explicit cardId override (defaults to `buildProjectedCardId(sourceKind, sourceId)`). */
  cardId?: string;
  /**
   * Owning container/document ID passed as `document_id` to `save_anki_cards` so SQLite
   * updates `anki_cards` in-place (`WHERE id = ? AND source_id = ?`) without touching FSRS tables.
   * Defaults to the prefix before `:` in `sourceId` (or `sourceId` itself).
   */
  documentId?: string;
  /** Optional Study Space scope (`study_space_id` on `vfs_anchor_edges`). */
  spaceId?: string | null;
  /** Target Anki/FSRS deck name. */
  deckName?: string;
  /** Front prompt (Markdown / HTML / plain text). */
  front: string;
  /** Back answer (Markdown / HTML / plain text). */
  back: string;
  /** Optional Anki Cloze raw text (`{{c1::...}}`). */
  clozeText?: string;
  /** Optional note type (`'Basic' | 'Cloze'`, auto-inferred from `clozeText` if omitted). */
  noteType?: string;
  /** Optional additional tags (merged with canonical source tags). */
  tags?: readonly string[];
  /** Optional media image refs (`vfs://...` or `data:image/...`). */
  images?: readonly string[];
  /** Optional extra protocol fields (`_occlusion`, `_occlusion_mode`, `Extra`, etc.). */
  extraFields?: Readonly<Record<string, string>>;
  /** Provenance anchors (`SemanticAnchor` objects or `ds-anchor://v1/...` URI strings). */
  anchors?: ReadonlyArray<SemanticAnchor | string>;
  /** Short human label for backlink pills (defaults to trimmed `front` preview). */
  sourceLabel?: string;
  /** Optional `options.source_ref` override passed to `save_anki_cards`. */
  sourceRef?: string;
  /**
   * Optional override for `vfs_anchor_edges.source_resource_id` (defaults to `persistedCardId`).
   * Used by whole-note batch sync where edges are grouped under `noteId`.
   */
  edgeSourceResourceId?: string;
  /** Optional override for `vfs_anchor_edges.source_sub_id`. */
  edgeSourceSubId?: string;
  /** Whether single-card upsert should prune removed edges for this card (default: true). */
  pruneStaleEdges?: boolean;
}

export interface ProjectedSaveCardsParams {
  documentId: string;
  cards: AnkiCard[];
  options: AnkiGenerationOptions & { source_ref?: string };
}

export interface ProjectedSaveCardsResponse {
  savedIds?: string[];
  saved_ids?: string[];
  duplicatedIds?: string[];
  duplicated_ids?: string[];
  cardIdMappings?: Array<{
    inputIndex?: number;
    inputId?: string | null;
    input_id?: string | null;
    persistedId?: string;
    persisted_id?: string;
  }>;
  card_id_mappings?: Array<{
    input_index?: number;
    input_id?: string | null;
    persisted_id?: string;
  }>;
}

export interface ProjectedFlashcardHostAdapter {
  saveCards?: (params: ProjectedSaveCardsParams) => Promise<ProjectedSaveCardsResponse | null | undefined>;
  enqueueNewCards?: (cardIds: string[]) => Promise<void>;
  deleteCard?: (cardId: string) => Promise<void>;
  upsertAnchorEdges?: (
    edges: readonly AnchorEdgeUpsertInput[],
  ) => Promise<{ upserted: number; edges: AnchorEdgeRecord[] } | void>;
  pruneAnchorEdgesBySource?: (params: {
    sourceKind: 'flashcard';
    sourceResourceId: string;
    keepEdgeIds?: readonly string[];
  }) => Promise<{ deleted: number } | void>;
  notifyFlashcardsChanged?: (reason: string) => void;
}

export interface ProjectedFlashcardCallOptions {
  adapter?: ProjectedFlashcardHostAdapter;
  reason?: string;
  /** Skip per-card edge pruning when caller performs a container-wide batch prune afterwards. */
  skipEdgePrune?: boolean;
}

export interface ProjectedFlashcardUpsertResult {
  cardId: string;
  persistedCardId: string;
  documentId: string;
  contentHash: string;
  created: boolean;
  updated: boolean;
  skippedUnchanged: boolean;
  edgeIds: string[];
}

export interface ProjectedFlashcardBatchResult {
  results: ProjectedFlashcardUpsertResult[];
  savedIds: string[];
  duplicatedIds: string[];
  persistedIds: string[];
  edgeIds: string[];
  skippedUnchanged: boolean;
}

export interface ProjectedFlashcardRemoveResult {
  cardId: string;
  persistedCardId: string;
  removed: boolean;
}

// ============================================================================
// Pure deterministic hashing & URI helpers (zero upward-layer imports)
// ============================================================================

const DS_ANCHOR_PREFIX = 'ds-anchor://v1/';

const SOURCE_KIND_DEFAULT_DECK: Readonly<Record<ProjectedFlashcardSourceKind, string>> = {
  note_inline: '笔记内联卡',
  mindmap_node: '导图闪卡',
  pdf_occlusion: '图片遮挡',
  qbank_mistake: '错题精练',
};

const SOURCE_KIND_TAG: Readonly<Record<ProjectedFlashcardSourceKind, string>> = {
  note_inline: 'inline-card',
  mindmap_node: 'mindmap-card',
  pdf_occlusion: 'image-occlusion',
  qbank_mistake: 'qbank-mistake',
};

function deriveDefaultDocumentId(sourceId: string): string {
  const trimmed = sourceId.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    return trimmed.slice(0, colonIdx).trim() || trimmed;
  }
  return trimmed;
}

function formatRectParam(rect: NormalizedRect): string {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const cx = clamp(rect.x);
  const cy = clamp(rect.y);
  const cw = Math.min(1 - cx, Math.max(0, rect.w));
  const ch = Math.min(1 - cy, Math.max(0, rect.h));
  return `${cx.toFixed(4)},${cy.toFixed(4)},${cw.toFixed(4)},${ch.toFixed(4)}`;
}

function serializeAnchorFoundation(anchor: SemanticAnchor): string {
  const pairs: Array<[string, string]> = [];
  const pushEncoded = (key: string, value: string | undefined) => {
    if (value !== undefined && value.length > 0) {
      pairs.push([key, encodeURIComponent(value)]);
    }
  };
  const pushRaw = (key: string, value: string) => {
    pairs.push([key, value]);
  };

  let head: string;
  switch (anchor.kind) {
    case 'pdf':
      head = `${DS_ANCHOR_PREFIX}pdf/${encodeURIComponent(anchor.resourceId)}`;
      pushRaw('page', String(anchor.page));
      if (anchor.rect) pushRaw('rect', formatRectParam(anchor.rect));
      pushEncoded('quote', anchor.quote);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    case 'media':
      head = `${DS_ANCHOR_PREFIX}media/${encodeURIComponent(anchor.resourceId)}`;
      pushRaw('t', String(anchor.startMs));
      if (anchor.endMs !== undefined) pushRaw('end', String(anchor.endMs));
      pushEncoded('quote', anchor.quote);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    case 'note':
      head = `${DS_ANCHOR_PREFIX}note/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('block', anchor.blockId);
      pushEncoded('heading', anchor.heading);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    case 'mindmap':
      head = `${DS_ANCHOR_PREFIX}mindmap/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('node', anchor.nodeId);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    case 'qbank':
      head = `${DS_ANCHOR_PREFIX}qbank/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('q', anchor.questionId);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    case 'epub':
      head = `${DS_ANCHOR_PREFIX}epub/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('cfi', anchor.cfi);
      pushEncoded('quote', anchor.quote);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    case 'custom':
      head = `${DS_ANCHOR_PREFIX}custom/${encodeURIComponent(anchor.namespace)}`;
      pushEncoded('id', anchor.resourceId);
      pushEncoded('loc', anchor.locator);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      if (anchor.params) {
        for (const k of Object.keys(anchor.params).sort()) {
          pairs.push([`p.${encodeURIComponent(k)}`, encodeURIComponent(anchor.params[k])]);
        }
      }
      break;
  }
  return pairs.length === 0
    ? head
    : `${head}?${pairs.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

function parseMinimalAnchorUri(uri: string): SemanticAnchor | null {
  if (typeof uri !== 'string' || !uri.startsWith(DS_ANCHOR_PREFIX) || uri.length > 2048) {
    return null;
  }
  const rest = uri.slice(DS_ANCHOR_PREFIX.length);
  const qIndex = rest.indexOf('?');
  const pathPart = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
  const queryPart = qIndex >= 0 ? rest.slice(qIndex + 1) : '';
  const slashIdx = pathPart.indexOf('/');
  if (slashIdx <= 0) return null;
  const kind = pathPart.slice(0, slashIdx);
  let primarySegment: string;
  try {
    primarySegment = decodeURIComponent(pathPart.slice(slashIdx + 1)).trim();
  } catch {
    return null;
  }
  if (!primarySegment) return null;

  const q = new Map<string, string>();
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : '';
      try {
        const dk = decodeURIComponent(k.replace(/\+/g, '%20'));
        const dv = decodeURIComponent(v.replace(/\+/g, '%20'));
        if (!q.has(dk)) q.set(dk, dv);
      } catch {
        return null;
      }
    }
  }

  const aliasResourceId = q.get('alias')?.trim() || undefined;
  const label = q.get('label')?.trim() || undefined;

  switch (kind) {
    case 'pdf': {
      const page = Number(q.get('page'));
      if (!Number.isInteger(page) || page < 1) return null;
      let rect: NormalizedRect | undefined;
      const rectRaw = q.get('rect');
      if (rectRaw) {
        const nums = rectRaw.split(',').map(Number);
        if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
          rect = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
        }
      }
      return {
        kind: 'pdf',
        resourceId: primarySegment,
        page,
        ...(rect ? { rect } : {}),
        ...(q.get('quote') ? { quote: q.get('quote') } : {}),
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    }
    case 'media': {
      const startMs = Number(q.get('t'));
      if (!Number.isInteger(startMs) || startMs < 0) return null;
      const endRaw = q.get('end');
      const endMs = endRaw !== undefined ? Number(endRaw) : undefined;
      return {
        kind: 'media',
        resourceId: primarySegment,
        startMs,
        ...(endMs !== undefined && Number.isFinite(endMs) ? { endMs: Math.max(startMs, Math.floor(endMs)) } : {}),
        ...(q.get('quote') ? { quote: q.get('quote') } : {}),
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    }
    case 'note':
      return {
        kind: 'note',
        resourceId: primarySegment,
        ...(q.get('block') ? { blockId: q.get('block') } : {}),
        ...(q.get('heading') ? { heading: q.get('heading') } : {}),
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    case 'mindmap':
      return {
        kind: 'mindmap',
        resourceId: primarySegment,
        ...(q.get('node') ? { nodeId: q.get('node') } : {}),
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    case 'qbank':
      return {
        kind: 'qbank',
        resourceId: primarySegment,
        ...(q.get('q') ? { questionId: q.get('q') } : {}),
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    case 'epub': {
      const cfi = q.get('cfi')?.trim();
      if (!cfi) return null;
      return {
        kind: 'epub',
        resourceId: primarySegment,
        cfi,
        ...(q.get('quote') ? { quote: q.get('quote') } : {}),
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    }
    case 'custom': {
      const resourceId = q.get('id')?.trim();
      const locator = q.get('loc')?.trim();
      if (!resourceId || !locator) return null;
      return {
        kind: 'custom',
        namespace: primarySegment,
        resourceId,
        locator,
        ...(aliasResourceId ? { aliasResourceId } : {}),
        ...(label ? { label } : {}),
      };
    }
    default:
      return null;
  }
}

interface NormalizedAnchorEntry {
  anchor: SemanticAnchor;
  uri: string;
}

function normalizeAnchorInputs(
  anchors: ReadonlyArray<SemanticAnchor | string> | undefined,
): NormalizedAnchorEntry[] {
  if (!anchors || anchors.length === 0) return [];
  const seen = new Set<string>();
  const out: NormalizedAnchorEntry[] = [];
  for (const item of anchors) {
    let anchor: SemanticAnchor | null = null;
    let uri = '';
    if (typeof item === 'string') {
      anchor = parseMinimalAnchorUri(item.trim());
      if (anchor) uri = serializeAnchorFoundation(anchor);
    } else if (item && typeof item === 'object') {
      try {
        uri = serializeAnchorFoundation(item);
        anchor = item;
      } catch {
        anchor = null;
      }
    }
    if (anchor && uri && !seen.has(uri)) {
      seen.add(uri);
      out.push({ anchor, uri });
    }
  }
  return out;
}

function deriveTargetLocatorKeyFoundation(anchor: SemanticAnchor): string {
  switch (anchor.kind) {
    case 'pdf':
      return `p:${anchor.page}`;
    case 'media':
      return `ms:${anchor.startMs}`;
    case 'note':
      if (anchor.blockId) return `blk:${anchor.blockId}`;
      if (anchor.heading) return `hd:${anchor.heading}`;
      return '';
    case 'mindmap':
      return anchor.nodeId ? `node:${anchor.nodeId}` : '';
    case 'qbank':
      return anchor.questionId ? `q:${anchor.questionId}` : '';
    case 'epub':
      return `cfi:${anchor.cfi}`;
    case 'custom':
      return `${anchor.namespace}:${anchor.locator}`;
  }
}

function buildEdgeRecordFoundation(
  input: AnchorEdgeUpsertInput,
  now = Date.now(),
): AnchorEdgeRecord {
  const sourceSubId = (input.sourceSubId ?? '').trim();
  const sourceAnchorUri = serializeAnchorFoundation(input.sourceAnchor);
  const targetAnchorUri = serializeAnchorFoundation(input.targetAnchor);
  const edgeId =
    input.edgeId?.trim() ||
    `edge_${fnv1a64HexFoundation(`${input.sourceKind}:${input.sourceResourceId}:${sourceSubId}:${targetAnchorUri}`)}`;

  return {
    edgeId,
    sourceKind: input.sourceKind,
    sourceResourceId: input.sourceResourceId,
    sourceSubId,
    sourceAnchorUri,
    sourceLabel: (input.sourceLabel ?? input.sourceAnchor.label ?? '').trim().slice(0, 120),
    targetKind: input.targetAnchor.kind,
    targetResourceId: input.targetAnchor.resourceId,
    targetLocatorKey: deriveTargetLocatorKeyFoundation(input.targetAnchor),
    targetPage: input.targetAnchor.kind === 'pdf' ? input.targetAnchor.page : null,
    targetStartMs: input.targetAnchor.kind === 'media' ? input.targetAnchor.startMs : null,
    targetEndMs: input.targetAnchor.kind === 'media' ? (input.targetAnchor.endMs ?? null) : null,
    targetRect: input.targetAnchor.kind === 'pdf' ? (input.targetAnchor.rect ?? null) : null,
    targetAnchorUri,
    studySpaceId: input.studySpaceId?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
}

export function computeProjectedCardFingerprint(input: ProjectedFlashcardInput): string {
  const normalizedTags = Array.from(
    new Set(['projected-card', SOURCE_KIND_TAG[input.sourceKind], ...(input.tags ?? [])].filter(Boolean)),
  ).sort();
  const normalizedImages = [...(input.images ?? [])];
  const extraEntries = Object.entries(input.extraFields ?? {})
    .filter(([k]) => k !== '_inline_hash' && k !== '_projected_hash')
    .sort(([a], [b]) => a.localeCompare(b));
  const anchorUris = normalizeAnchorInputs(input.anchors).map((a) => a.uri);

  const raw = JSON.stringify({
    k: input.sourceKind,
    id: input.cardId ?? '',
    doc: input.documentId ?? '',
    deck: input.deckName ?? '',
    note: input.noteType ?? '',
    label: input.sourceLabel ?? '',
    ref: input.sourceRef ?? '',
    edgeSource: input.edgeSourceResourceId ?? '',
    edgeSub: input.edgeSourceSubId ?? '',
    f: input.front,
    b: input.back,
    c: input.clozeText ?? '',
    t: normalizedTags,
    i: normalizedImages,
    e: extraEntries,
    a: anchorUris,
    s: input.spaceId ?? '',
  });
  return fnv1a64HexFoundation(raw);
}

// ============================================================================
// Session state & Default Tauri IPC Host Adapter
// ============================================================================

interface ProjectedSessionEntry {
  cardId: string;
  persistedCardId: string;
  documentId: string;
  edgeSourceResourceId: string;
  contentHash: string;
  enqueued: boolean;
  edgeIds: string[];
}

const sessionEntries = new Map<string, ProjectedSessionEntry>();
const inFlightLocks = new Map<string, Promise<unknown>>();
let configuredHostAdapter: ProjectedFlashcardHostAdapter | null = null;

export function configureProjectedFlashcardHost(
  adapter: ProjectedFlashcardHostAdapter | null,
): void {
  configuredHostAdapter = adapter;
}

export function resetProjectedFlashcardCache(
  sourceKind?: ProjectedFlashcardSourceKind,
  sourceId?: string,
): void {
  if (sourceKind && sourceId) {
    sessionEntries.delete(`${sourceKind}::${sourceId.trim()}`);
    return;
  }
  if (sourceKind) {
    const prefix = `${sourceKind}::`;
    for (const key of Array.from(sessionEntries.keys())) {
      if (key.startsWith(prefix)) sessionEntries.delete(key);
    }
    return;
  }
  sessionEntries.clear();
}

function dispatchDomEvent(name: string, detail: Record<string, unknown>): void {
  dispatchTypedEvent(name, detail);
}

const defaultIpcAdapter: Required<ProjectedFlashcardHostAdapter> = {
  async saveCards(params) {
    const cardsPayload = params.cards.map((card) => ({
      id: card.id ?? null,
      front: card.front ?? '',
      back: card.back ?? '',
      text: card.text ?? null,
      tags: card.tags ?? [],
      images: card.images ?? [],
      fields: card.fields ?? card.extra_fields ?? {},
      template_id: card.template_id ?? null,
    }));
    return invoke<ProjectedSaveCardsResponse>('save_anki_cards', {
      request: {
        document_id: params.documentId,
        business_session_id: null,
        message_stable_id: null,
        block_id: null,
        template_id: null,
        cards: cardsPayload,
        options: params.options,
      },
    });
  },
  async enqueueNewCards(cardIds) {
    if (cardIds.length === 0) return;
    // The host uses insert-if-missing and leaves live FSRS states untouched, including
    // after a frontend restart when our session cache is empty.
    await invoke('fsrs_enqueue_cards', { ankiCardIds: cardIds });
  },
  async deleteCard(cardId) {
    await invoke('delete_anki_card', { cardId });
  },
  async upsertAnchorEdges(inputs) {
    if (inputs.length === 0) return { upserted: 0, edges: [] };
    const records = inputs.map((item) => buildEdgeRecordFoundation(item));
    await invoke('vfs_anchor_edges_upsert', { edges: records });
    const targetResourceIds = Array.from(new Set(records.map((r) => r.targetResourceId)));
    dispatchDomEvent('ds:anchor-edges-changed', {
      targetResourceIds,
      sourceResourceId: records[0]?.sourceResourceId,
    });
    return { upserted: records.length, edges: records };
  },
  async pruneAnchorEdgesBySource(params) {
    await invoke('vfs_anchor_edges_delete_by_source', {
        sourceKind: params.sourceKind,
        sourceResourceId: params.sourceResourceId,
        keepEdgeIds: params.keepEdgeIds ? [...params.keepEdgeIds] : [],
    });
    dispatchDomEvent('ds:anchor-edges-changed', {
      targetResourceIds: [],
      sourceResourceId: params.sourceResourceId,
    });
    return { deleted: 0 };
  },
  notifyFlashcardsChanged(reason) {
    dispatchDomEvent('fsrs:library-refresh', { reason });
    dispatchDomEvent('fsrs:stats-refresh', { reason });
    dispatchDomEvent('ds:flashcards-changed', { reason });
  },
};

function resolveAdapter(
  override?: ProjectedFlashcardHostAdapter,
): Required<ProjectedFlashcardHostAdapter> {
  return {
    saveCards: override?.saveCards ?? configuredHostAdapter?.saveCards ?? defaultIpcAdapter.saveCards,
    enqueueNewCards:
      override?.enqueueNewCards ??
      configuredHostAdapter?.enqueueNewCards ??
      defaultIpcAdapter.enqueueNewCards,
    deleteCard: override?.deleteCard ?? configuredHostAdapter?.deleteCard ?? defaultIpcAdapter.deleteCard,
    upsertAnchorEdges:
      override?.upsertAnchorEdges ??
      configuredHostAdapter?.upsertAnchorEdges ??
      defaultIpcAdapter.upsertAnchorEdges,
    pruneAnchorEdgesBySource:
      override?.pruneAnchorEdgesBySource ??
      configuredHostAdapter?.pruneAnchorEdgesBySource ??
      defaultIpcAdapter.pruneAnchorEdgesBySource,
    notifyFlashcardsChanged:
      override?.notifyFlashcardsChanged ??
      configuredHostAdapter?.notifyFlashcardsChanged ??
      defaultIpcAdapter.notifyFlashcardsChanged,
  };
}

function normalizeSaveCardsResponse(
  response: ProjectedSaveCardsResponse | null | undefined,
): {
  savedIds: string[];
  duplicatedIds: string[];
  mappedByInputId: Map<string, string>;
  hasExplicitIdLists: boolean;
} {
  const raw = response ?? {};
  const hasExplicitIdLists =
    Array.isArray(raw.savedIds) ||
    Array.isArray(raw.saved_ids) ||
    Array.isArray(raw.duplicatedIds) ||
    Array.isArray(raw.duplicated_ids) ||
    Array.isArray(raw.cardIdMappings) ||
    Array.isArray(raw.card_id_mappings);

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
  const duplicatedIds = dupRaw.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );

  const mappingsRaw = Array.isArray(raw.cardIdMappings)
    ? raw.cardIdMappings
    : Array.isArray(raw.card_id_mappings)
      ? raw.card_id_mappings
      : [];
  const mappedByInputId = new Map<string, string>();
  for (const m of mappingsRaw) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Record<string, unknown>;
    const input = rec.inputId ?? rec.input_id;
    const persisted = rec.persistedId ?? rec.persisted_id;
    if (typeof input === 'string' && input.trim() && typeof persisted === 'string' && persisted.trim()) {
      mappedByInputId.set(input.trim(), persisted.trim());
    }
  }

  return { savedIds, duplicatedIds, mappedByInputId, hasExplicitIdLists };
}

function withSerialLock<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const prev = inFlightLocks.get(lockKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  inFlightLocks.set(lockKey, next);
  const cleanup = () => {
    if (inFlightLocks.get(lockKey) === next) {
      inFlightLocks.delete(lockKey);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

// ============================================================================
// Public Projection Operations
// ============================================================================

/**
 * Upserts a batch of projected flashcards belonging to the same `documentId` in a single
 * atomic `save_anki_cards` round-trip while preserving existing FSRS memory state.
 */
export async function upsertProjectedFlashcardsBatch(
  inputs: readonly ProjectedFlashcardInput[],
  options?: ProjectedFlashcardCallOptions,
): Promise<ProjectedFlashcardBatchResult> {
  if (inputs.length === 0) {
    return {
      results: [],
      savedIds: [],
      duplicatedIds: [],
      persistedIds: [],
      edgeIds: [],
      skippedUnchanged: true,
    };
  }

  const primaryDocId =
    inputs[0].documentId?.trim() || deriveDefaultDocumentId(inputs[0].sourceId);

  // A mixed-document batch must participate in every document's queue, not just
  // the first one's lock. Split before locking to avoid nested-lock deadlocks.
  const documents = new Map<string, ProjectedFlashcardInput[]>();
  for (const input of inputs) {
    const id = input.documentId?.trim() || deriveDefaultDocumentId(input.sourceId);
    const group = documents.get(id) ?? [];
    group.push(input);
    documents.set(id, group);
  }
  if (documents.size > 1) {
    const batches = [];
    for (const group of documents.values()) batches.push(await upsertProjectedFlashcardsBatch(group, options));
    return {
      results: batches.flatMap((batch) => batch.results),
      savedIds: batches.flatMap((batch) => batch.savedIds),
      duplicatedIds: batches.flatMap((batch) => batch.duplicatedIds),
      persistedIds: batches.flatMap((batch) => batch.persistedIds),
      edgeIds: batches.flatMap((batch) => batch.edgeIds),
      skippedUnchanged: batches.every((batch) => batch.skippedUnchanged),
    };
  }

  return withSerialLock(`doc::${primaryDocId}`, async () => {
    const adapter = resolveAdapter(options?.adapter);

    const prepared = inputs.map((input) => {
      const normalizedSourceId = input.sourceId.trim();
      if (!normalizedSourceId) {
        throw new Error('ProjectedFlashcardInput.sourceId must be non-empty');
      }
      const sessionKey = `${input.sourceKind}::${normalizedSourceId}`;
      const cardId = input.cardId?.trim() || buildProjectedCardId(input.sourceKind, normalizedSourceId);
      const documentId = input.documentId?.trim() || deriveDefaultDocumentId(normalizedSourceId);
      const contentHash = computeProjectedCardFingerprint(input);
      const normalizedAnchors = normalizeAnchorInputs(input.anchors);
      const prev = sessionEntries.get(sessionKey);
      return {
        input,
        normalizedSourceId,
        sessionKey,
        cardId,
        documentId,
        contentHash,
        normalizedAnchors,
        prev,
        changed: !prev || prev.contentHash !== contentHash,
      };
    });

    const changedItems = prepared.filter((item) => item.changed);
    if (changedItems.length === 0) {
      const results: ProjectedFlashcardUpsertResult[] = prepared.map((item) => ({
        cardId: item.cardId,
        persistedCardId: item.prev!.persistedCardId,
        documentId: item.documentId,
        contentHash: item.contentHash,
        created: false,
        updated: false,
        skippedUnchanged: true,
        edgeIds: item.prev!.edgeIds,
      }));
      return {
        results,
        savedIds: [],
        duplicatedIds: [],
        persistedIds: results.map((r) => r.persistedCardId),
        edgeIds: results.flatMap((r) => r.edgeIds),
        skippedUnchanged: true,
      };
    }

    // Group changed items by documentId (normally 1 group).
    const savedIdsAll: string[] = [];
    const duplicatedIdsAll: string[] = [];
    const mappedByInputAll = new Map<string, string>();
    let anyImplicitResponse = false;

    const byDoc = new Map<string, typeof changedItems>();
    for (const item of changedItems) {
      const list = byDoc.get(item.documentId) ?? [];
      list.push(item);
      byDoc.set(item.documentId, list);
    }

    for (const [documentId, group] of byDoc) {
      const first = group[0];
      const deckName =
        first.input.deckName?.trim() ||
        SOURCE_KIND_DEFAULT_DECK[first.input.sourceKind] ||
        'DeepStudent';
      const primarySourceUri =
        first.input.sourceRef?.trim() || first.normalizedAnchors[0]?.uri;

      const cardsPayload: AnkiCard[] = group.map((item) => {
        const primaryUri = item.normalizedAnchors[0]?.uri;
        const secondaryUris = item.normalizedAnchors.slice(1).map((a) => a.uri);
        const mergedTags = Array.from(
          new Set(
            [
              SOURCE_KIND_TAG[item.input.sourceKind],
              ...(item.input.tags ?? []),
            ].filter(Boolean),
          ),
        );
        const fields: Record<string, string> = {
          ...(item.input.extraFields ?? {}),
          _projected_kind: item.input.sourceKind,
          _projected_source_id: item.normalizedSourceId,
          _projected_hash: item.contentHash,
          ...(primaryUri ? { _source_anchor: primaryUri } : {}),
          ...(secondaryUris.length > 0 ? { _source_anchors_extra: JSON.stringify(secondaryUris) } : {}),
          ...(item.input.clozeText && !(item.input.extraFields && 'Text' in item.input.extraFields)
            ? { Text: item.input.clozeText }
            : {}),
        };
        if (item.input.sourceKind === 'note_inline' && !('_inline_hash' in fields)) {
          fields._inline_hash = item.contentHash;
        }

        return {
          id: item.cardId,
          front: item.input.front,
          back: item.input.back,
          text: item.input.clozeText,
          tags: mergedTags,
          images: [...(item.input.images ?? [])],
          fields,
          extra_fields: { ...fields },
        };
      });

      const noteType =
        first.input.noteType ||
        (group.every((g) => Boolean(g.input.clozeText)) ? 'Cloze' : 'Basic');

      const generationOptions: AnkiGenerationOptions & { source_ref?: string } = {
        deck_name: deckName,
        note_type: noteType,
        enable_images: group.some((g) => (g.input.images?.length ?? 0) > 0),
        max_cards_per_source: Math.max(1, group.length),
        max_cards_per_mistake: Math.max(1, group.length),
        ...(primarySourceUri ? { source_ref: primarySourceUri } : {}),
      };

      const resp = await adapter.saveCards({
        documentId,
        cards: cardsPayload,
        options: generationOptions,
      });
      if (resp === null) throw new Error('Projected flashcards could not be saved');
      const norm = normalizeSaveCardsResponse(resp);
      if (!norm.hasExplicitIdLists && resp !== null) {
        anyImplicitResponse = true;
      }
      savedIdsAll.push(...norm.savedIds);
      duplicatedIdsAll.push(...norm.duplicatedIds);
      for (const [inId, pId] of norm.mappedByInputId) {
        mappedByInputAll.set(inId, pId);
      }
    }

    // CRITICAL FSRS INVARIANT:
    // Only enqueue cards that have NOT already been enqueued in FSRS, so existing FSRS
    // stability, difficulty, reps, lapses, and due timestamps are NEVER touched or reset!
    const newlyCreatedIdsToEnqueue: string[] = [];
    for (const item of changedItems) {
      const persistedId =
        mappedByInputAll.get(item.cardId) ??
        item.prev?.persistedCardId ??
        item.cardId;
      const alreadyEnqueued = Boolean(item.prev?.enqueued);
      if (alreadyEnqueued) continue;
      if (
        savedIdsAll.includes(persistedId) ||
        savedIdsAll.includes(item.cardId) ||
        mappedByInputAll.has(item.cardId) ||
        anyImplicitResponse
      ) {
        newlyCreatedIdsToEnqueue.push(persistedId);
      }
    }

    if (newlyCreatedIdsToEnqueue.length > 0) {
      await adapter.enqueueNewCards(Array.from(new Set(newlyCreatedIdsToEnqueue)));
    }

    // Sync provenance anchor edges for all items in the batch.
    const allEdgeInputs: AnchorEdgeUpsertInput[] = [];
    const edgeCountPerItem: number[] = [];

    for (const item of prepared) {
      const persistedId =
        mappedByInputAll.get(item.cardId) ??
        item.prev?.persistedCardId ??
        item.cardId;
      const edgeSourceResourceId = item.input.edgeSourceResourceId?.trim() || persistedId;
      const edgeSourceSubId = item.input.edgeSourceSubId?.trim() ?? item.cardId;
      const label = (item.input.sourceLabel ?? item.input.front).replace(/\s+/g, ' ').trim().slice(0, 120);

      let count = 0;
      for (const { anchor } of item.normalizedAnchors) {
        allEdgeInputs.push({
          sourceKind: 'flashcard',
          sourceResourceId: edgeSourceResourceId,
          sourceSubId: edgeSourceSubId,
          sourceAnchor: {
            kind: 'custom',
            namespace: 'flashcard',
            resourceId: persistedId,
            locator: item.normalizedSourceId.slice(0, 120),
            ...(label ? { label } : {}),
          },
          ...(label ? { sourceLabel: label } : {}),
          targetAnchor: anchor,
          ...(item.input.spaceId ? { studySpaceId: item.input.spaceId } : {}),
        });
        count += 1;
      }
      edgeCountPerItem.push(count);
    }

    let upsertedRecords: AnchorEdgeRecord[] = [];
    if (allEdgeInputs.length > 0) {
      const edgeRes = await adapter.upsertAnchorEdges(allEdgeInputs);
      upsertedRecords = edgeRes && Array.isArray(edgeRes.edges)
        ? edgeRes.edges
        : allEdgeInputs.map((e) => buildEdgeRecordFoundation(e));
    }

    // Slice edge IDs back per item and prune stale per-card edges when requested.
    let offset = 0;
    const results: ProjectedFlashcardUpsertResult[] = [];
    const allPersistedIds: string[] = [];
    const allEdgeIds: string[] = [];

    for (let i = 0; i < prepared.length; i += 1) {
      const item = prepared[i];
      const count = edgeCountPerItem[i];
      const itemEdges = upsertedRecords.slice(offset, offset + count);
      offset += count;
      const itemEdgeIds = itemEdges.map((e) => e.edgeId);

      const persistedCardId =
        mappedByInputAll.get(item.cardId) ??
        item.prev?.persistedCardId ??
        item.cardId;
      const edgeSourceResourceId = item.input.edgeSourceResourceId?.trim() || persistedCardId;
      const wasExisting = Boolean(item.prev);

      const shouldPrunePerCard =
        !options?.skipEdgePrune &&
        item.input.pruneStaleEdges !== false &&
        edgeSourceResourceId === persistedCardId;

      if (shouldPrunePerCard && item.changed) {
        await adapter.pruneAnchorEdgesBySource({
          sourceKind: 'flashcard',
          sourceResourceId: edgeSourceResourceId,
          keepEdgeIds: itemEdgeIds,
        });
      }

      const enqueued =
        Boolean(item.prev?.enqueued) || newlyCreatedIdsToEnqueue.includes(persistedCardId);

      sessionEntries.set(item.sessionKey, {
        cardId: item.cardId,
        persistedCardId,
        documentId: item.documentId,
        edgeSourceResourceId,
        contentHash: item.contentHash,
        enqueued,
        edgeIds: itemEdgeIds,
      });

      allPersistedIds.push(persistedCardId);
      allEdgeIds.push(...itemEdgeIds);

      results.push({
        cardId: item.cardId,
        persistedCardId,
        documentId: item.documentId,
        contentHash: item.contentHash,
        created: item.changed && !wasExisting,
        updated: item.changed && wasExisting,
        skippedUnchanged: !item.changed,
        edgeIds: itemEdgeIds,
      });
    }

    if (savedIdsAll.length > 0 || duplicatedIdsAll.length > 0 || anyImplicitResponse) {
      adapter.notifyFlashcardsChanged(options?.reason ?? `projected-${inputs[0].sourceKind}`);
    }

    return {
      results,
      savedIds: savedIdsAll,
      duplicatedIds: duplicatedIdsAll,
      persistedIds: allPersistedIds,
      edgeIds: allEdgeIds,
      skippedUnchanged: false,
    };
  });
}

/**
 * Upserts a single projected flashcard (`note_inline | mindmap_node | pdf_occlusion | qbank_mistake`),
 * updating content & provenance anchors in-place while preserving existing FSRS scheduling memory.
 */
export async function upsertProjectedFlashcard(
  input: ProjectedFlashcardInput,
  options?: ProjectedFlashcardCallOptions,
): Promise<ProjectedFlashcardUpsertResult> {
  const batch = await upsertProjectedFlashcardsBatch([input], options);
  return batch.results[0];
}

/**
 * Removes a projected flashcard when its source block/node is untoggled or deleted,
 * cleaning up both the card record and its `vfs_anchor_edges` provenance backlinks.
 */
export async function removeProjectedFlashcard(
  sourceKind: ProjectedFlashcardSourceKind,
  sourceId: string,
  options?: ProjectedFlashcardCallOptions,
): Promise<ProjectedFlashcardRemoveResult> {
  const normalizedSourceId = sourceId.trim();
  if (!normalizedSourceId) {
    return { cardId: '', persistedCardId: '', removed: false };
  }
  const documentId = deriveDefaultDocumentId(normalizedSourceId);
  return withSerialLock(`doc::${documentId}`, async () => {
    const adapter = resolveAdapter(options?.adapter);
    const sessionKey = `${sourceKind}::${normalizedSourceId}`;
    const prev = sessionEntries.get(sessionKey);
    const cardId = prev?.cardId ?? buildProjectedCardId(sourceKind, normalizedSourceId);
    const persistedCardId = prev?.persistedCardId ?? cardId;
    const edgeSourceResourceId = prev?.edgeSourceResourceId ?? persistedCardId;

    await adapter.deleteCard(persistedCardId);
    const removed = true;

    if (!options?.skipEdgePrune && edgeSourceResourceId === persistedCardId) {
      await adapter.pruneAnchorEdgesBySource({
        sourceKind: 'flashcard',
        sourceResourceId: edgeSourceResourceId,
        keepEdgeIds: [],
      });
    }

    if (removed) {
      sessionEntries.delete(sessionKey);
      adapter.notifyFlashcardsChanged(options?.reason ?? `projected-remove-${sourceKind}`);
    }

    return {
      cardId,
      persistedCardId,
      removed,
    };
  });
}
