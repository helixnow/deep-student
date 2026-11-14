/**
 * L24 chatanki 所需的卡片/文档仓储（`dstu-storage/src/database/mod.rs`）。
 *
 * 这些 SQL 属于 L16 的 mistakes 库；L24 只通过 `anki` 服务消费，不直接查询
 * 本库。所有写操作在 `BEGIN IMMEDIATE` 事务内重复所有权与 CAS 校验，失败
 * 返回 Rust 的枚举结果而不是泄漏文档是否存在。
 */
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  AnkiCardVersionDelete,
  AnkiCardVersionUpdate,
  AnkiRetemplateBatchResult,
  AnkiRetemplateCardUpdate,
  AnkiRetemplateMissingField,
  AnkiRetemplateTarget,
} from '../api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { FsrsTransactionOwner } from '../src/fsrs-owner.ts';
import {
  decodeAnkiCardRow,
  type AnkiCardRow,
} from '../src/anki-cards.ts';
import { getReviewStatesForLibrary } from './anki-cards.ts';
import { nowRfc3339, rfc3339FromMillis } from '../src/time.ts';
import { expectedReviewVersionI64 } from '../src/library.ts';

const CARD_COLUMNS = `ac.id, ac.task_id, ac.front, ac.back, ac.text, ac.tags_json, ac.images_json,
  ac.is_error_card, ac.error_content, ac.created_at, ac.updated_at,
  COALESCE(ac.extra_fields_json, '{}') AS extra_fields_json, ac.template_id`;

export interface CardWithDocumentRow extends AnkiCardRow {
  document_id: string;
}

function mapCardWithDocument(row: CardWithDocumentRow): { card: AnkiCard; documentId: string } {
  return { card: decodeAnkiCardRow(row), documentId: row.document_id };
}

/** `is_document_owned_by_session`：全部活任务必须属于同一会话。 */
export function isDocumentOwnedBySession(
  db: SqlExecutor,
  documentId: string,
  sessionId: string,
): boolean {
  const row = db.one<{ task_count: number; owned_task_count: number }>(
    `SELECT COUNT(*) AS task_count,
            COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0) AS owned_task_count
     FROM document_tasks
     WHERE document_id = ?1
       AND deleted_at IS NULL`,
    [documentId, sessionId],
  );
  return row.task_count > 0 && row.task_count === row.owned_task_count;
}

/** `get_anki_card_with_document`：任意 live 文档。 */
export function getLiveCardWithDocument(
  db: SqlExecutor,
  cardId: string,
): { card: AnkiCard; documentId: string } | null {
  const row = db.get<CardWithDocumentRow>(
    `SELECT ${CARD_COLUMNS}, dt.document_id
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     WHERE ac.id = ?1
       AND ac.deleted_at IS NULL
       AND dt.deleted_at IS NULL
     LIMIT 1`,
    [cardId],
  );
  return row === undefined ? null : mapCardWithDocument(row);
}

/** `get_anki_card_for_session`：只检查卡片所属的单个任务。 */
export function getLiveCardForSession(
  db: SqlExecutor,
  cardId: string,
  sessionId: string,
): { card: AnkiCard; documentId: string } | null {
  const row = db.get<CardWithDocumentRow>(
    `SELECT ${CARD_COLUMNS}, dt.document_id
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     WHERE ac.id = ?1
       AND dt.source_session_id = ?2
       AND ac.deleted_at IS NULL
       AND dt.deleted_at IS NULL
     LIMIT 1`,
    [cardId, sessionId],
  );
  return row === undefined ? null : mapCardWithDocument(row);
}

/** `get_anki_card_for_owned_document_session`：整篇文档必须属于该会话。 */
export function getLiveCardForOwnedDocumentSession(
  db: SqlExecutor,
  cardId: string,
  sessionId: string,
): { card: AnkiCard; documentId: string } | null {
  const row = db.get<CardWithDocumentRow>(
    `SELECT ${CARD_COLUMNS}, dt.document_id
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     WHERE ac.id = ?1
       AND dt.source_session_id = ?2
       AND ac.deleted_at IS NULL
       AND dt.deleted_at IS NULL
       AND NOT EXISTS (
           SELECT 1
           FROM document_tasks sibling
           WHERE sibling.document_id = dt.document_id
             AND sibling.deleted_at IS NULL
             AND (sibling.source_session_id IS NULL OR sibling.source_session_id <> ?2)
       )
     LIMIT 1`,
    [cardId, sessionId],
  );
  return row === undefined ? null : mapCardWithDocument(row);
}

/** `get_anki_agent_library_cards_by_ids`：保序，任一缺失整批失败。 */
export function getLibraryCardsByIds(
  db: DatabaseHandle,
  cardIds: readonly string[],
): AnkiCard[] {
  if (cardIds.length === 0) throw new Error('library_card_ids_required');
  return db.transaction((tx) => {
    const cards: AnkiCard[] = [];
    const missing: string[] = [];
    for (const cardId of cardIds) {
      const row = tx.get<AnkiCardRow>(
        `SELECT ${CARD_COLUMNS}
         FROM anki_cards ac
         INNER JOIN document_tasks dt ON dt.id = ac.task_id
         WHERE ac.id = ?1
           AND ac.deleted_at IS NULL
           AND dt.deleted_at IS NULL`,
        [cardId],
      );
      if (row === undefined) missing.push(cardId);
      else cards.push(decodeAnkiCardRow(row));
    }
    if (missing.length > 0) {
      throw new Error(`library_cards_unavailable: ${missing.join(',')}`);
    }
    return cards;
  });
}

/** `insert_anki_card_with_order`：父任务必须存活；唯一索引命中的行被忽略。 */
function insertCardWithOrder(
  db: SqlExecutor,
  card: AnkiCard,
  order: number,
  sourceType: string,
  sourceId: string,
): boolean {
  return db.run(
    `INSERT OR IGNORE INTO anki_cards
       (id, task_id, front, back, text, tags_json, images_json,
        is_error_card, error_content, card_order_in_task, created_at, updated_at,
        extra_fields_json, template_id, source_type, source_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
     WHERE EXISTS (
         SELECT 1
         FROM document_tasks dt
         WHERE dt.id = ?2
           AND dt.deleted_at IS NULL
     )`,
    [
      card.id,
      card.task_id,
      card.front,
      card.back,
      card.text,
      JSON.stringify(card.tags),
      JSON.stringify(card.images),
      card.is_error_card ? 1 : 0,
      card.error_content,
      order,
      card.created_at,
      card.updated_at,
      JSON.stringify(card.extra_fields),
      card.template_id,
      sourceType,
      sourceId,
    ],
  ).changes > 0;
}

/**
 * `insert_anki_card`：按卡片所属任务推导 source_type/source_id，再按顺序 0 插入。
 * 父任务已软删除时 `insert_anki_card_with_order` 的 EXISTS 子句会拒绝写入。
 */
export function insertCard(db: SqlExecutor, card: AnkiCard): boolean {
  const task = db.get<{ document_id: string }>(
    `SELECT document_id
     FROM document_tasks
     WHERE id = ?1
       AND deleted_at IS NULL`,
    [card.task_id],
  );
  const sourceType = task === undefined ? 'task' : 'document';
  const sourceId = task === undefined ? card.task_id : task.document_id;
  return insertCardWithOrder(db, card, 0, sourceType, sourceId);
}

/**
 * `insert_anki_cards_for_document`：追加到文档最后一个任务，保持文档顺序；
 * 文档级唯一索引拒绝的重复卡直接省略。
 */
export function insertCardsForDocument(
  db: DatabaseHandle,
  documentId: string,
  sessionId: string,
  cards: readonly AnkiCard[],
): AnkiCard[] {
  if (cards.length === 0) return [];
  return db.transaction((tx) => {
    if (!isDocumentOwnedBySession(tx, documentId, sessionId)) {
      throw new Error('document_ownership_mismatch');
    }
    const taskId = tx.pluck<string>(
      `SELECT id
       FROM document_tasks
       WHERE document_id = ?1
         AND source_session_id = ?2
         AND deleted_at IS NULL
       ORDER BY segment_index DESC, created_at DESC, rowid DESC
       LIMIT 1`,
      [documentId, sessionId],
    );
    if (taskId === undefined) throw new Error('document_task_not_found');

    let nextOrder = (tx.pluck<number>(
      `SELECT COALESCE(MAX(card_order_in_task), -1) + 1
       FROM anki_cards
       WHERE task_id = ?1
         AND deleted_at IS NULL`,
      [taskId],
    ) ?? 0);
    const inserted: AnkiCard[] = [];
    for (const input of cards) {
      const card = { ...input, task_id: taskId };
      if (insertCardWithOrder(tx, card, nextOrder, 'document', documentId)) {
        inserted.push({
          ...card,
          tags: [...card.tags],
          images: [...card.images],
          extra_fields: { ...card.extra_fields },
        });
        nextOrder += 1;
      }
    }
    return inserted;
  }, { behavior: 'immediate' });
}

/** `update_anki_card_if_version_for_session`。 */
export function updateCardIfVersionForSession(
  db: DatabaseHandle,
  card: AnkiCard,
  expectedUpdatedAt: string,
  sessionId: string,
): AnkiCardVersionUpdate {
  return db.transaction((tx) => {
    const located = getLiveCardWithDocument(tx, card.id);
    if (located === null) return { kind: 'notFound' } as const;
    if (!isDocumentOwnedBySession(tx, located.documentId, sessionId)) {
      return { kind: 'notFound' } as const;
    }

    const nowMs = Date.now();
    let updatedAt = nowRfc3339();
    if (updatedAt === expectedUpdatedAt) {
      updatedAt = rfc3339FromMillis(nowMs + 1) ?? updatedAt;
    }
    const changes = tx.run(
      `UPDATE anki_cards SET
         front = ?1, back = ?2, text = ?3, tags_json = ?4, images_json = ?5,
         is_error_card = ?6, error_content = ?7, updated_at = ?8,
         extra_fields_json = ?9, template_id = ?10
       WHERE id = ?11
         AND updated_at = ?12
         AND deleted_at IS NULL
         AND EXISTS (
             SELECT 1
             FROM document_tasks dt
             WHERE dt.id = anki_cards.task_id
               AND dt.deleted_at IS NULL
         )`,
      [
        card.front,
        card.back,
        card.text,
        JSON.stringify(card.tags),
        JSON.stringify(card.images),
        card.is_error_card ? 1 : 0,
        card.error_content,
        updatedAt,
        JSON.stringify(card.extra_fields),
        card.template_id,
        card.id,
        expectedUpdatedAt,
      ],
    ).changes;

    const current = getLiveCardWithDocument(tx, card.id);
    if (changes === 1 && current !== null) {
      return { kind: 'updated', card: current.card } as const;
    }
    if (changes === 0 && current !== null) {
      return { kind: 'conflict', current: current.card } as const;
    }
    if (current === null) return { kind: 'notFound' } as const;
    throw new Error(`unexpected_anki_card_update_count: ${changes}`);
  }, { behavior: 'immediate' });
}

/**
 * `delete_anki_card_for_session`：内容版本 + 复习版本双 CAS；删除卡片、复习
 * 状态和日志在同一事务内完成。
 */
export function deleteCardForSession(
  db: DatabaseHandle,
  fsrs: FsrsTransactionOwner,
  cardId: string,
  expectedUpdatedAt: string,
  expectedReviewVersion: number | bigint | null,
  sessionId: string,
): AnkiCardVersionDelete {
  const trimmed = cardId.trim();
  if (trimmed === '' || expectedUpdatedAt.trim() === '' || sessionId.trim() === '') {
    throw new Error('cardId, expectedVersion, and sessionId are required');
  }
  const expectedReview = expectedReviewVersionI64(expectedReviewVersion);

  return db.transaction((tx) => {
    const located = getLiveCardWithDocument(tx, trimmed);
    if (located === null) return { kind: 'notFound' } as const;
    if (!isDocumentOwnedBySession(tx, located.documentId, sessionId)) {
      return { kind: 'notFound' } as const;
    }
    const current = located.card;
    if (current.updated_at !== expectedUpdatedAt) {
      return { kind: 'conflict', current } as const;
    }

    const review = getReviewStatesForLibrary(tx, [trimmed])[0] ?? null;
    const reviewMatches = review === null
      ? expectedReview === null
      : expectedReview !== null && review.reviewVersion === expectedReview;
    if (!reviewMatches) {
      return { kind: 'reviewConflict', current, review } as const;
    }

    // FSRS 状态/日志归 L15；清理与卡片删除共享当前 immediate 事务。
    fsrs.cleanupCardDeletionInTx(tx, [trimmed]);
    const deleted = tx.run(
      `DELETE FROM anki_cards
       WHERE id = ?1
         AND updated_at = ?2
         AND deleted_at IS NULL
         AND NOT EXISTS (
             SELECT 1
             FROM fsrs_card_states fs
             WHERE fs.anki_card_id = anki_cards.id
               AND fs.deleted_at IS NULL
         )
         AND EXISTS (
             SELECT 1
             FROM document_tasks dt
             WHERE dt.id = anki_cards.task_id
               AND dt.source_session_id = ?3
               AND dt.deleted_at IS NULL
         )`,
      [trimmed, expectedUpdatedAt, sessionId],
    ).changes;
    if (deleted === 1) return { kind: 'deleted' } as const;

    const latest = getLiveCardWithDocument(tx, trimmed);
    if (latest === null) return { kind: 'notFound' } as const;
    const latestReview = getReviewStatesForLibrary(tx, [trimmed])[0] ?? null;
    if (latest.card.updated_at !== expectedUpdatedAt) {
      return { kind: 'conflict', current: latest.card } as const;
    }
    return {
      kind: 'reviewConflict',
      current: latest.card,
      review: latestReview,
    } as const;
  }, { behavior: 'immediate' });
}

// ---------------------------------------------------------------- retemplate

/** `normalize_anki_template_field_key`：仅 ASCII 字母数字，小写。 */
function normalizeFieldKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** `str::to_ascii_lowercase`。 */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function nonemptyField(fields: ReadonlyMap<string, string>, key: string): string | null {
  const value = fields.get(key);
  return value === undefined || value.trim() === '' ? null : value;
}

/** Rust `String` ordering is code-point ordering, not JS UTF-16 ordering. */
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

/** `contains_valid_anki_cloze_markup`（database/mod.rs:510-541）。 */
export function containsValidAnkiClozeMarkup(text: string): boolean {
  let cursor = 0;
  while (cursor <= text.length) {
    const relativeStart = text.indexOf('{{c', cursor);
    if (relativeStart === -1) return false;
    const start = relativeStart + 3;
    let digitEnd = start;
    while (digitEnd < text.length) {
      const code = text.charCodeAt(digitEnd);
      if (code < 0x30 || code > 0x39) break;
      digitEnd += 1;
    }
    if (digitEnd === start) {
      cursor = start;
      continue;
    }
    const digits = text.slice(start, digitEnd);
    let clozeNumber = Number(digits);
    if (!Number.isSafeInteger(clozeNumber) || digits.length > 20) clozeNumber = 0;
    const afterNumber = text.slice(digitEnd);
    if (clozeNumber === 0 || !afterNumber.startsWith('::')) {
      cursor = start;
      continue;
    }
    const body = afterNumber.slice(2);
    const close = body.indexOf('}}');
    if (close === -1) {
      cursor = start;
      continue;
    }
    const answer = body.slice(0, close).split('::')[0] ?? '';
    if (answer.trim() !== '') return true;
    cursor = start + digits.length;
  }
  return false;
}

/** `map_anki_fields_for_template`（database/mod.rs:416-508）。 */
export function mapAnkiFieldsForTemplate(
  card: AnkiCard,
  target: AnkiRetemplateTarget,
): [Record<string, string>, AnkiRetemplateMissingField[]] {
  const mapped = new Map<string, string>(Object.entries(card.extra_fields));
  const baseFields = new Map<string, string>();
  const addBaseField = (lower: string, canonical: string, value: string): void => {
    if (value.trim() === '') return;
    baseFields.set(lower, value);
    baseFields.set(canonical, value);
  };
  addBaseField('front', 'Front', card.front);
  addBaseField('back', 'Back', card.back);
  if (card.text !== null) addBaseField('text', 'Text', card.text);
  addBaseField('tags', 'Tags', JSON.stringify(card.tags));

  const sourceFields = new Map<string, string>(Object.entries(card.extra_fields));
  for (const [key, value] of baseFields) sourceFields.set(key, value);

  const normalizedSources = new Map<string, string>();
  for (const key of [...sourceFields.keys()].sort(compareCodePoints)) {
    const normalized = normalizeFieldKey(key);
    if (normalized === '' || normalizedSources.has(normalized)) continue;
    const value = nonemptyField(sourceFields, key);
    if (value !== null) normalizedSources.set(normalized, value);
  }

  const front = card.front.trim() !== '' ? card.front : null;
  const back = card.back.trim() !== '' ? card.back : null;
  const missingFields: AnkiRetemplateMissingField[] = [];

  for (const field of target.fields) {
    if (field.trim() === '') continue;
    const lower = asciiLowercase(field);
    const normalized = normalizeFieldKey(field);
    const baseValue = nonemptyField(baseFields, field) ?? nonemptyField(baseFields, lower);
    if (baseValue !== null) {
      mapped.set(field, baseValue);
      continue;
    }
    if (nonemptyField(mapped, field) !== null) continue;
    const aliasValue = nonemptyField(sourceFields, lower)
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
        || normalizeFieldKey(requiredField) === normalized);
    missingFields.push({ field, required });
  }

  const entries = [...mapped.entries()].sort((left, right) => compareCodePoints(left[0], right[0]));
  return [Object.fromEntries(entries), missingFields];
}

function loadRetemplateDocument(
  db: SqlExecutor,
  documentId: string,
): Array<{ card: AnkiCard; documentId: string }> {
  return db.all<CardWithDocumentRow>(
    `SELECT ${CARD_COLUMNS}, dt.document_id
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     WHERE dt.document_id = ?1
       AND dt.deleted_at IS NULL
       AND ac.deleted_at IS NULL
     ORDER BY dt.segment_index, ac.card_order_in_task, ac.created_at, ac.id`,
    [documentId],
  ).map(mapCardWithDocument);
}

/** `retemplate_anki_cards_for_session` 的完整原子批次。 */
export function retemplateCardsForSession(
  db: DatabaseHandle,
  selector: { kind: 'document'; documentId: string } | { kind: 'cards'; cardIds: readonly string[] },
  target: AnkiRetemplateTarget,
  expectedVersions: ReadonlyMap<string, string>,
  sessionId: string,
  preflightedDocumentIds: readonly string[],
): AnkiRetemplateBatchResult {
  return db.transaction((tx) => {
    let loaded: Array<{ card: AnkiCard; documentId: string }>;
    if (selector.kind === 'document') {
      if (!isDocumentOwnedBySession(tx, selector.documentId, sessionId)) {
        return { kind: 'ownershipRejected' } as const;
      }
      loaded = loadRetemplateDocument(tx, selector.documentId);
    } else {
      if (selector.cardIds.length === 0) {
        return { kind: 'selectionNotFound', cardIds: [] } as const;
      }
      const placeholders = selector.cardIds.map(() => '?').join(',');
      const rows = tx.all<CardWithDocumentRow>(
        `SELECT ${CARD_COLUMNS}, dt.document_id
         FROM anki_cards ac
         INNER JOIN document_tasks dt ON dt.id = ac.task_id
         WHERE ac.id IN (${placeholders})
           AND dt.deleted_at IS NULL
           AND ac.deleted_at IS NULL`,
        [...selector.cardIds],
      );
      const byId = new Map(rows.map((row) => [row.id, mapCardWithDocument(row)]));
      const missing = selector.cardIds.filter((cardId) => !byId.has(cardId));
      if (missing.length > 0) {
        return {
          kind: 'selectionNotFound',
          cardIds: [...missing].sort(compareCodePoints),
        } as const;
      }
      loaded = [];
      for (const cardId of selector.cardIds) {
        const entry = byId.get(cardId);
        if (entry === undefined) {
          return { kind: 'selectionNotFound', cardIds: [cardId] } as const;
        }
        loaded.push(entry);
      }
    }

    if (loaded.length === 0) {
      return { kind: 'selectionNotFound', cardIds: [] } as const;
    }
    const documentIds = [...new Set(loaded.map((entry) => entry.documentId))]
      .sort(compareCodePoints);
    if (documentIds.length !== 1) {
      return { kind: 'crossDocumentSelection', documentIds } as const;
    }
    if (!isDocumentOwnedBySession(tx, documentIds[0]!, sessionId)) {
      return { kind: 'ownershipRejected' } as const;
    }

    const preflighted = [...new Set(
      preflightedDocumentIds
        .map((documentId) => documentId.trim())
        .filter((documentId) => documentId !== ''),
    )].sort(compareCodePoints);
    if (
      preflighted.length !== documentIds.length
      || preflighted.some((documentId, index) => documentId !== documentIds[index])
    ) {
      return { kind: 'documentSetChanged', documentIds } as const;
    }

    const liveIds = new Set(loaded.map((entry) => entry.card.id));
    const expectedIds = new Set(expectedVersions.keys());
    if (
      liveIds.size !== expectedIds.size
      || [...liveIds].some((cardId) => !expectedIds.has(cardId))
    ) {
      return {
        kind: 'expectedVersionsMismatch',
        missingVersionIds: [...liveIds]
          .filter((cardId) => !expectedIds.has(cardId))
          .sort(compareCodePoints),
        unexpectedVersionIds: [...expectedIds]
          .filter((cardId) => !liveIds.has(cardId))
          .sort(compareCodePoints),
      } as const;
    }

    const conflicts = loaded
      .filter((entry) => expectedVersions.get(entry.card.id) !== entry.card.updated_at)
      .map((entry) => ({
        cardId: entry.card.id,
        expectedVersion: expectedVersions.get(entry.card.id) ?? '',
        currentVersion: entry.card.updated_at,
      }));
    if (conflicts.length > 0) return { kind: 'versionConflict', conflicts } as const;

    if (target.noteType.trim().toLowerCase() === 'cloze') {
      const invalid = loaded
        .filter((entry) => {
          const text = entry.card.text?.trim() ?? '';
          return text === '' || !containsValidAnkiClozeMarkup(text);
        })
        .map((entry) => entry.card.id)
        .sort(compareCodePoints);
      if (invalid.length > 0) return { kind: 'invalidCloze', cardIds: invalid } as const;
    }

    const updates: AnkiRetemplateCardUpdate[] = loaded.map((entry) => {
      const [extraFields, missingFields] = mapAnkiFieldsForTemplate(entry.card, target);
      return {
        documentId: entry.documentId,
        card: { ...entry.card, extra_fields: extraFields },
        source: entry.card,
        missingFields,
      };
    });

    const expectedTokens = new Set(expectedVersions.values());
    let timestamp = Date.now();
    let updatedAt = rfc3339FromMillis(timestamp) ?? nowRfc3339();
    while (expectedTokens.has(updatedAt)) {
      timestamp += 1;
      updatedAt = rfc3339FromMillis(timestamp) ?? updatedAt;
    }

    for (const update of updates) {
      const expectedVersion = expectedVersions.get(update.card.id) ?? '';
      const affected = tx.run(
        `UPDATE anki_cards
         SET extra_fields_json = ?1,
             template_id = ?2,
             updated_at = ?3,
             local_version = COALESCE(local_version, 0) + 1
         WHERE id = ?4
           AND updated_at = ?5
           AND deleted_at IS NULL
           AND EXISTS (
               SELECT 1
               FROM document_tasks dt
               WHERE dt.id = anki_cards.task_id
                 AND dt.source_session_id = ?6
                 AND dt.deleted_at IS NULL
           )`,
        [
          JSON.stringify(update.card.extra_fields),
          target.templateId,
          updatedAt,
          update.card.id,
          expectedVersion,
          sessionId,
        ],
      ).changes;
      if (affected !== 1) {
        throw new Error(
          `unexpected_anki_retemplate_update_count: card=${update.card.id}, affected=${affected}`,
        );
      }
      update.card = {
        ...update.card,
        template_id: target.templateId,
        updated_at: updatedAt,
      };
    }

    return {
      kind: 'updated',
      targetNoteType: target.noteType,
      updates,
    } as const;
  }, { behavior: 'immediate' });
}

/** `get_document_session_source`。 */
export function getDocumentSessionSource(
  db: SqlExecutor,
  documentId: string,
): string | null {
  return db.pluck<string>(
    `SELECT source_session_id
     FROM document_tasks
     WHERE document_id = ?1
       AND source_session_id IS NOT NULL
       AND deleted_at IS NULL
     LIMIT 1`,
    [documentId],
  ) ?? null;
}

export type { DocumentTask };
