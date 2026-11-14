import type {
  AnkiCard, AnkiCardVersionDelete, AnkiCardVersionUpdate, AnkiRetemplateBatchResult,
  AnkiRetemplateCardUpdate, AnkiRetemplateMissingField, AnkiRetemplateTarget,
  ChatAnkiCardRepository, ChatAnkiDocumentTaskRepository, DocumentTask,
  FsrsAgentReviewStateSnapshot, FsrsEnqueueResult,
} from '../api.ts';
import { ChatAnkiReviewStateError } from '../api.ts';
import { textHasValidClozeMarkup } from '../src/transform-script.ts';

interface TaskRow {
  id: string;
  documentId: string;
  sessionId: string;
  deleted: boolean;
}

interface CardRow {
  card: AnkiCard;
  documentId: string;
  taskId: string;
  deletedAt: string | null;
  /** dstu-storage anki_cards.card_order_in_task. */
  order: number;
  /** dstu-storage anki_cards.local_version. */
  localVersion: number;
}

interface ReviewRow {
  state: FsrsAgentReviewStateSnapshot;
  logs: Array<{ logId: string; rating: number; reviewMs: number }>;
}

/**
 * In-memory stand-in for L16's mistakes-DB card repository. Owns the SQL
 * semantics the executor cannot test itself (document ownership, CAS version
 * comparison, review CAS, soft-deleted rows); production consumes L16's real
 * repository when published.
 */
export class CardStoreDouble implements ChatAnkiCardRepository, ChatAnkiDocumentTaskRepository {
  private readonly tasks = new Map<string, TaskRow>();
  private readonly documentTasks = new Map<string, string[]>();
  private readonly cards = new Map<string, CardRow>();
  private readonly reviews = new Map<string, ReviewRow>();
  private readonly taskRecords = new Map<string, DocumentTask>();
  private readonly sessionSources = new Map<string, string>();
  private readonly settings = new Map<string, string>();

  seedDocument(documentId: string, sessionId: string, taskId = `task-${documentId}`): string {
    this.addTask(documentId, taskId, sessionId);
    return taskId;
  }

  addTask(documentId: string, taskId: string, sessionId: string): void {
    const now = '2026-08-24T00:00:00Z';
    this.tasks.set(taskId, { id: taskId, documentId, sessionId, deleted: false });
    this.taskRecords.set(taskId, {
      id: taskId, document_id: documentId, original_document_name: '', segment_index: 0,
      content_segment: '', status: 'Completed', created_at: now, updated_at: now,
      error_message: null, anki_generation_options_json: '{}',
    });
    this.sessionSources.set(documentId, sessionId);
    const list = this.documentTasks.get(documentId) ?? [];
    list.push(taskId);
    this.documentTasks.set(documentId, list);
  }

  getTasksForDocument(documentId: string): DocumentTask[] {
    return (this.documentTasks.get(documentId) ?? [])
      .map((id) => this.tasks.get(id))
      .filter((task): task is TaskRow => task !== undefined && !task.deleted)
      .map((task) => ({ ...(this.taskRecords.get(task.id) as DocumentTask) }));
  }

  insertDocumentTask(task: DocumentTask): void {
    this.tasks.set(task.id, {
      id: task.id, documentId: task.document_id, sessionId: '', deleted: false,
    });
    this.taskRecords.set(task.id, { ...task });
    const list = this.documentTasks.get(task.document_id) ?? [];
    list.push(task.id);
    this.documentTasks.set(task.document_id, list);
  }

  getDocumentSessionSource(documentId: string): string | null {
    return this.sessionSources.get(documentId) ?? null;
  }

  setDocumentSessionSource(documentId: string, sessionId: string): void {
    this.sessionSources.set(documentId, sessionId);
    for (const id of this.documentTasks.get(documentId) ?? []) {
      const task = this.tasks.get(id);
      if (task !== undefined) task.sessionId = sessionId;
    }
  }

  insertCard(card: AnkiCard, documentId?: string): boolean {
    if (this.cards.has(card.id)) return false;
    const task = this.tasks.get(card.task_id);
    const targetDocument = documentId ?? task?.documentId ?? '';
    this.cards.set(card.id, {
      card: cloneCard(card), documentId: targetDocument, taskId: card.task_id,
      deletedAt: null, order: 0, localVersion: 0,
    });
    return true;
  }

  isDocumentOwnedBySession(documentId: string, sessionId: string): boolean {
    const ids = this.documentTasks.get(documentId) ?? [];
    const live = ids.map((id) => this.tasks.get(id)).filter(
      (task): task is TaskRow => task !== undefined && !task.deleted,
    );
    return live.length > 0 && live.every((task) => task.sessionId === sessionId);
  }

  getCardsForDocumentForSession(documentId: string, sessionId: string): AnkiCard[] | null {
    if (!this.isDocumentOwnedBySession(documentId, sessionId)) return null;
    return this.getCardsForDocument(documentId);
  }

  getCardsForDocument(documentId: string): AnkiCard[] {
    return [...this.cards.values()]
      .filter((row) => row.documentId === documentId && row.deletedAt === null)
      .map((row) => cloneCard(row.card));
  }

  getCardWithDocument(cardId: string): { card: AnkiCard; documentId: string } | null {
    const row = this.cards.get(cardId);
    if (row === undefined || row.deletedAt !== null) return null;
    return { card: cloneCard(row.card), documentId: row.documentId };
  }

  getCardForSession(cardId: string, sessionId: string): { card: AnkiCard; documentId: string } | null {
    const row = this.cards.get(cardId);
    if (row === undefined || row.deletedAt !== null) return null;
    const task = this.tasks.get(row.taskId);
    if (task === undefined || task.deleted || task.sessionId !== sessionId) return null;
    return { card: cloneCard(row.card), documentId: row.documentId };
  }

  getLibraryCardsByIds(cardIds: readonly string[]): AnkiCard[] {
    const cards: AnkiCard[] = [];
    const missing: string[] = [];
    for (const cardId of cardIds) {
      const row = this.cards.get(cardId);
      const task = row === undefined ? undefined : this.tasks.get(row.taskId);
      if (row === undefined || row.deletedAt !== null || task === undefined || task.deleted) {
        missing.push(cardId);
        continue;
      }
      cards.push(cloneCard(row.card));
    }
    if (missing.length > 0) {
      throw new Error(`library_cards_unavailable: ${missing.join(',')}`);
    }
    return cards;
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  saveSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  loadOwnedCard(cardId: string, sessionId: string): { card: AnkiCard; documentId: string } | null {
    const row = this.cards.get(cardId);
    if (row === undefined || row.deletedAt !== null) return null;
    if (!this.isDocumentOwnedBySession(row.documentId, sessionId)) return null;
    return { card: cloneCard(row.card), documentId: row.documentId };
  }

  insertCardsForDocument(
    documentId: string, sessionId: string, cards: readonly AnkiCard[],
  ): AnkiCard[] {
    if (cards.length === 0) return [];
    if (!this.isDocumentOwnedBySession(documentId, sessionId)) {
      throw new Error('document_ownership_mismatch');
    }
    const taskId = [...(this.documentTasks.get(documentId) ?? [])]
      .reverse()
      .map((id) => this.tasks.get(id))
      .find((task): task is TaskRow => task !== undefined && !task.deleted)?.id;
    if (taskId === undefined) throw new Error('document_task_not_found');
    const liveOrders = [...this.cards.values()]
      .filter((row) => row.taskId === taskId && row.deletedAt === null)
      .map((row) => row.order);
    let nextOrder = liveOrders.length === 0 ? 0 : Math.max(...liveOrders) + 1;
    const inserted: AnkiCard[] = [];
    for (const card of cards) {
      const dedupeKey = cardDedupeKey(card);
      const duplicate = [...this.cards.values()].some((row) => row.documentId === documentId
        && row.deletedAt === null && !row.card.is_error_card
        && cardDedupeKey(row.card) === dedupeKey);
      if (duplicate || this.cards.has(card.id)) continue;
      const stored = cloneCard({ ...card, task_id: taskId });
      this.cards.set(card.id, {
        card: stored, documentId, taskId, deletedAt: null, order: nextOrder, localVersion: 0,
      });
      nextOrder += 1;
      inserted.push(cloneCard(stored));
    }
    return inserted;
  }

  updateCardIfVersionForSession(
    card: AnkiCard, expectedVersion: string, sessionId: string,
  ): AnkiCardVersionUpdate {
    const row = this.cards.get(card.id);
    if (row === undefined || row.deletedAt !== null) return { kind: 'notFound' };
    if (!this.isDocumentOwnedBySession(row.documentId, sessionId)) return { kind: 'notFound' };
    if (row.card.updated_at !== expectedVersion) {
      return { kind: 'conflict', current: cloneCard(row.card) };
    }
    const parsed = Date.parse(expectedVersion);
    const updated: AnkiCard = {
      ...cloneCard(card),
      task_id: row.card.task_id,
      created_at: row.card.created_at,
      updated_at: new Date((Number.isNaN(parsed) ? Date.now() : parsed) + 1_000).toISOString(),
    };
    this.cards.set(card.id, {
      card: updated, documentId: row.documentId, taskId: row.taskId, deletedAt: null,
      order: row.order, localVersion: row.localVersion,
    });
    return { kind: 'updated', card: cloneCard(updated) };
  }

  deleteCardForSession(
    cardId: string, expectedVersion: string, expectedReviewVersion: number | bigint | null,
    sessionId: string,
  ): AnkiCardVersionDelete {
    const row = this.cards.get(cardId);
    if (row === undefined || row.deletedAt !== null) return { kind: 'notFound' };
    if (!this.isDocumentOwnedBySession(row.documentId, sessionId)) return { kind: 'notFound' };
    if (row.card.updated_at !== expectedVersion) {
      return { kind: 'conflict', current: cloneCard(row.card) };
    }
    const review = this.reviews.get(cardId) ?? null;
    const reviewMatches = review === null && expectedReviewVersion === null
      || review !== null && expectedReviewVersion !== null
        && review.state.reviewVersion === BigInt(expectedReviewVersion);
    if (!reviewMatches) {
      return {
        kind: 'reviewConflict', current: cloneCard(row.card),
        review: review === null ? null : cloneReview(review.state),
      };
    }
    this.reviews.delete(cardId);
    // Rust `DELETE FROM anki_cards` removes the row; there is no tombstone.
    this.cards.delete(cardId);
    return { kind: 'deleted' };
  }

  retemplateCardsForSession(
    selector: { kind: 'document'; documentId: string } | { kind: 'cards'; cardIds: readonly string[] },
    target: AnkiRetemplateTarget,
    expectedVersions: ReadonlyMap<string, string>,
    sessionId: string,
    preflightedDocumentIds: readonly string[],
  ): AnkiRetemplateBatchResult {
    const loaded: Array<{ card: AnkiCard; documentId: string }> = [];
    if (selector.kind === 'document') {
      if (!this.isDocumentOwnedBySession(selector.documentId, sessionId)) {
        return { kind: 'ownershipRejected' };
      }
      loaded.push(...this.loadRetemplateDocument(selector.documentId));
    } else {
      if (selector.cardIds.length === 0) {
        return { kind: 'selectionNotFound', cardIds: [] };
      }
      const byId = new Map<string, { card: AnkiCard; documentId: string }>();
      for (const cardId of selector.cardIds) {
        const row = this.cards.get(cardId);
        const task = row === undefined ? undefined : this.tasks.get(row.taskId);
        if (row === undefined || row.deletedAt !== null
          || task === undefined || task.deleted) continue;
        byId.set(cardId, { card: cloneCard(row.card), documentId: row.documentId });
      }
      const missing = selector.cardIds.filter((cardId) => !byId.has(cardId)).sort();
      if (missing.length > 0) return { kind: 'selectionNotFound', cardIds: missing };
      for (const cardId of selector.cardIds) loaded.push(byId.get(cardId)!);
    }

    if (loaded.length === 0) return { kind: 'selectionNotFound', cardIds: [] };
    const documentIds = [...new Set(loaded.map((entry) => entry.documentId))].sort();
    if (documentIds.length !== 1) {
      return { kind: 'crossDocumentSelection', documentIds };
    }
    if (!this.isDocumentOwnedBySession(documentIds[0]!, sessionId)) {
      return { kind: 'ownershipRejected' };
    }
    const preflighted = [...new Set(preflightedDocumentIds
      .map((documentId) => documentId.trim())
      .filter((documentId) => documentId.length > 0))].sort();
    if (preflighted.length !== documentIds.length
      || preflighted.some((documentId, index) => documentId !== documentIds[index])) {
      return { kind: 'documentSetChanged', documentIds };
    }

    const liveIds = new Set(loaded.map((entry) => entry.card.id));
    const expectedIds = new Set(expectedVersions.keys());
    if (liveIds.size !== expectedIds.size
      || [...liveIds].some((cardId) => !expectedIds.has(cardId))) {
      const missingVersionIds = [...liveIds]
        .filter((cardId) => !expectedIds.has(cardId)).sort();
      const unexpectedVersionIds = [...expectedIds]
        .filter((cardId) => !liveIds.has(cardId)).sort();
      return { kind: 'expectedVersionsMismatch', missingVersionIds, unexpectedVersionIds };
    }

    const conflicts = loaded
      .filter((entry) => expectedVersions.get(entry.card.id) !== entry.card.updated_at)
      .map((entry) => ({
        cardId: entry.card.id,
        expectedVersion: expectedVersions.get(entry.card.id) ?? '',
        currentVersion: entry.card.updated_at,
      }));
    if (conflicts.length > 0) return { kind: 'versionConflict', conflicts };

    if (target.noteType.trim().toLowerCase() === 'cloze') {
      const invalid = loaded
        .filter((entry) => {
          const text = entry.card.text?.trim() ?? '';
          return text.length === 0 || !textHasValidClozeMarkup(text);
        })
        .map((entry) => entry.card.id)
        .sort();
      if (invalid.length > 0) return { kind: 'invalidCloze', cardIds: invalid };
    }

    const updates: AnkiRetemplateCardUpdate[] = loaded.map((entry) => {
      const [extraFields, missingFields] = mapAnkiFieldsForTemplate(entry.card, target);
      return {
        documentId: entry.documentId,
        card: { ...cloneCard(entry.card), extra_fields: extraFields },
        source: cloneCard(entry.card),
        missingFields,
      };
    });

    const expectedTokens = new Set(expectedVersions.values());
    let timestamp = new Date();
    let updatedAt = timestamp.toISOString();
    while (expectedTokens.has(updatedAt)) {
      timestamp = new Date(timestamp.getTime() + 1);
      updatedAt = timestamp.toISOString();
    }
    for (const update of updates) {
      const row = this.cards.get(update.card.id);
      if (row === undefined) throw new Error(`unexpected_anki_retemplate_update_count: card=${update.card.id}`);
      update.card = {
        ...cloneCard(update.card),
        template_id: target.templateId,
        updated_at: updatedAt,
      };
      this.cards.set(update.card.id, {
        ...row,
        card: cloneCard(update.card),
        localVersion: row.localVersion + 1,
      });
    }
    return { kind: 'updated', targetNoteType: target.noteType, updates };
  }

  private loadRetemplateDocument(documentId: string): Array<{ card: AnkiCard; documentId: string }> {
    const taskOrder = new Map<string, number>();
    (this.documentTasks.get(documentId) ?? []).forEach((taskId, index) => {
      taskOrder.set(taskId, index);
    });
    return [...this.cards.values()]
      .filter((row) => row.documentId === documentId && row.deletedAt === null)
      .sort((left, right) => {
        const taskDelta = (taskOrder.get(left.taskId) ?? 0) - (taskOrder.get(right.taskId) ?? 0);
        if (taskDelta !== 0) return taskDelta;
        if (left.order !== right.order) return left.order - right.order;
        if (left.card.created_at !== right.card.created_at) {
          return left.card.created_at < right.card.created_at ? -1 : 1;
        }
        return left.card.id.localeCompare(right.card.id);
      })
      .map((row) => ({ card: cloneCard(row.card), documentId: row.documentId }));
  }

  localVersion(cardId: string): number | null {
    return this.cards.get(cardId)?.localVersion ?? null;
  }

  templateId(cardId: string): string | null {
    return this.cards.get(cardId)?.card.template_id ?? null;
  }

  enqueueReview(cardId: string, sessionId: string): FsrsAgentReviewStateSnapshot | null {
    const owned = this.loadOwnedCard(cardId, sessionId);
    if (owned === null) return null;
    const state: FsrsAgentReviewStateSnapshot = {
      ankiCardId: cardId,
      cardStateId: `state-${cardId}`,
      state: 2,
      suspended: false,
      dueMs: 1_725_000_000_000,
      lastReviewMs: null,
      reviewVersion: 0n,
      latestReview: null,
    };
    this.reviews.set(cardId, { state, logs: [] });
    return cloneReview(state);
  }

  rateReview(cardId: string, rating: number, reviewMs = 1_724_000_000_000): void {
    const row = this.reviews.get(cardId);
    if (row === undefined) throw new Error('review_state_not_found');
    const logId = `log-${cardId}-${row.state.reviewVersion + 1n}`;
    row.logs.push({ logId, rating, reviewMs });
    row.state = {
      ...row.state,
      reviewVersion: row.state.reviewVersion + 1n,
      lastReviewMs: reviewMs,
      latestReview: { logId, rating, reviewMs, undoable: true },
    };
  }

  getReviewStatesForSession(
    cardIds: readonly string[], sessionId: string,
  ): FsrsAgentReviewStateSnapshot[] {
    if (sessionId.trim().length === 0) {
      throw new ChatAnkiReviewStateError('Validation', 'sessionId is required');
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawId of cardIds) {
      const cardId = rawId.trim();
      if (cardId.length === 0) {
        throw new ChatAnkiReviewStateError(
          'Validation', 'ankiCardIds must not contain empty IDs',
        );
      }
      if (!seen.has(cardId)) { seen.add(cardId); normalized.push(cardId); }
    }
    const states: FsrsAgentReviewStateSnapshot[] = [];
    for (const cardId of normalized) {
      if (this.loadOwnedCard(cardId, sessionId) === null) {
        throw new ChatAnkiReviewStateError('NotFound', `anki card not found: ${cardId}`);
      }
      const row = this.reviews.get(cardId);
      if (row === undefined) continue;
      states.push(cloneReview(row.state));
    }
    return states;
  }

  /**
   * FsrsReviewService::enqueue_cards_for_session: a document selector re-resolves
   * the live card set, explicit ids are deduped, unowned cards are not enrolled.
   */
  enqueueCardsForSession(
    cardIds: readonly string[], sessionId: string, documentId: string | null,
  ): FsrsEnqueueResult {
    if (documentId !== null) {
      if (!this.isDocumentOwnedBySession(documentId, sessionId)) {
        throw new Error('blocks.ankiCards.errors.statusNotFound');
      }
      cardIds = this.getCardsForDocument(documentId).map((card) => card.id);
    }
    let enqueued = 0;
    let skipped = 0;
    const enqueuedStateIds: string[] = [];
    const seen = new Set<string>();
    for (const rawId of cardIds) {
      const cardId = rawId.trim();
      if (cardId.length === 0) throw new Error('cardIds must not contain empty IDs');
      if (seen.has(cardId)) continue;
      seen.add(cardId);
      if (this.loadOwnedCard(cardId, sessionId) === null || this.reviews.has(cardId)) {
        skipped += 1;
        continue;
      }
      const state = this.enqueueReview(cardId, sessionId);
      if (state !== null) enqueuedStateIds.push(state.cardStateId);
      enqueued += 1;
    }
    return { enqueued, skipped, enqueuedStateIds, states: [], reviewCards: [] };
  }

  cardOrder(cardId: string): number | null {
    const row = this.cards.get(cardId);
    return row === undefined || row.deletedAt !== null ? null : row.order;
  }

  deletedAt(cardId: string): string | null {
    return this.cards.get(cardId)?.deletedAt ?? null;
  }

  /** Rust test fixture `UPDATE anki_cards SET deleted_at = ...` (not the delete handler). */
  softDeleteCard(cardId: string): void {
    const row = this.cards.get(cardId);
    if (row === undefined) throw new Error(`missing card ${cardId}`);
    this.cards.set(cardId, { ...row, deletedAt: new Date().toISOString() });
  }

  cardRowCount(cardId: string): number {
    return this.cards.has(cardId) ? 1 : 0;
  }

  reviewRowCount(cardId: string): number {
    const row = this.reviews.get(cardId);
    return row === undefined ? 0 : 1 + row.logs.length;
  }
}

function cardDedupeKey(card: AnkiCard): string {
  const text = card.text ?? '';
  if (text.length > 0) return `text:${text}`;
  return `fields:${[...card.front].length}:${card.front}|${card.back}`;
}

/** dstu-storage `normalize_anki_template_field_key` (ASCII alnum, lowercased). */
function normalizeAnkiTemplateFieldKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function nonemptyAnkiFieldValue(
  fields: ReadonlyMap<string, string>, key: string,
): string | null {
  const value = fields.get(key);
  return value === undefined || value.trim().length === 0 ? null : value;
}

/** `str::to_ascii_lowercase`: only A-Z are folded. */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** Rust `String` ordering is code-point ordering; JS default sort is UTF-16. */
function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((char) => char.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((char) => char.codePointAt(0) ?? 0);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const delta = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * dstu-storage `map_anki_fields_for_template`: base front/back/text/tags win,
 * then case/alias matching, then unmapped template fields fall through as
 * missing (required when the target marks them required by any normalization).
 */
export function mapAnkiFieldsForTemplate(
  card: AnkiCard, target: AnkiRetemplateTarget,
): [Record<string, string>, AnkiRetemplateMissingField[]] {
  const mapped = new Map<string, string>(Object.entries(card.extra_fields));
  const baseFields = new Map<string, string>();
  const addBaseField = (lower: string, canonical: string, value: string): void => {
    if (value.trim().length === 0) return;
    baseFields.set(lower, value);
    baseFields.set(canonical, value);
  };
  addBaseField('front', 'Front', card.front);
  addBaseField('back', 'Back', card.back);
  if (card.text !== null) addBaseField('text', 'Text', card.text);
  addBaseField('tags', 'Tags', JSON.stringify(card.tags));

  const sourceFields = new Map<string, string>(Object.entries(card.extra_fields));
  for (const [key, value] of baseFields) sourceFields.set(key, value);

  const sortedKeys = [...sourceFields.keys()].sort(compareCodePoints);
  const normalizedSources = new Map<string, string>();
  for (const key of sortedKeys) {
    const normalized = normalizeAnkiTemplateFieldKey(key);
    if (normalized.length === 0 || normalizedSources.has(normalized)) continue;
    const value = nonemptyAnkiFieldValue(sourceFields, key);
    if (value !== null) normalizedSources.set(normalized, value);
  }

  const front = card.front.trim().length > 0 ? card.front : null;
  const back = card.back.trim().length > 0 ? card.back : null;
  const missingFields: AnkiRetemplateMissingField[] = [];

  for (const field of target.fields) {
    if (field.trim().length === 0) continue;
    const lower = asciiLowercase(field);
    const normalized = normalizeAnkiTemplateFieldKey(field);
    const baseValue = nonemptyAnkiFieldValue(baseFields, field)
      ?? nonemptyAnkiFieldValue(baseFields, lower);
    if (baseValue !== null) {
      mapped.set(field, baseValue);
      continue;
    }
    if (nonemptyAnkiFieldValue(mapped, field) !== null) continue;
    const aliasValue = nonemptyAnkiFieldValue(sourceFields, lower)
      ?? normalizedSources.get(normalized)
      ?? (lower === 'question' || lower === 'word' || lower === 'name' ? front : null)
      ?? (lower === 'back' || lower === 'explanation' || lower === 'definition'
        || lower === 'desc' || lower === 'expl' || lower === 'backdetail'
        || lower === 'answer' ? back : null);
    if (aliasValue !== null) {
      mapped.set(field, aliasValue);
      continue;
    }
    if (!mapped.has(field)) mapped.set(field, '');
    const required = target.requiredFields.includes(field)
      || target.requiredFields.some((requiredField) =>
        asciiLowercase(requiredField) === lower
        || normalizeAnkiTemplateFieldKey(requiredField) === normalized);
    missingFields.push({ field, required });
  }

  const entries: Array<[string, string]> = [];
  for (const [key, value] of mapped) entries.push([key, value]);
  entries.sort((left, right) => compareCodePoints(left[0], right[0]));
  return [Object.fromEntries(entries), missingFields];
}

export function cloneCard(card: AnkiCard): AnkiCard {
  return {
    ...card,
    tags: [...card.tags],
    images: [...card.images],
    extra_fields: { ...card.extra_fields },
  };
}

function cloneReview(state: FsrsAgentReviewStateSnapshot): FsrsAgentReviewStateSnapshot {
  return {
    ...state,
    latestReview: state.latestReview === null ? null : { ...state.latestReview },
  };
}
