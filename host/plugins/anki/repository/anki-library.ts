/**
 * 卡片库（library）页的列表、牌组计数、按版本更新与删除（`dstu-storage/src/database/mod.rs`
 * 库查询段，入口 `list_anki_library_cards` 等）。
 */
import { type DatabaseHandle, type SqlExecutor, type SqlParam } from '../../../platform/storage/api.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { FsrsTransactionOwner } from '../src/fsrs-owner.ts';
import type { AnkiLibraryCardDeleteOutcome } from '../api.ts';
import { nowRfc3339, rfc3339FromMillis } from '../src/time.ts';
import {
  expectedReviewVersionI64,
  decodeAnkiLibraryCardRow,
  decodeAnkiLibraryListRow,
  type AnkiLibraryCard,
  type AnkiLibraryCardRow,
  type AnkiLibraryDeckCount,
  type AnkiLibraryListFilter,
  type AnkiLibraryListRow,
  type AnkiLibraryStatusCounts,
} from '../src/library.ts';
import { getReviewStatesForLibrary } from './anki-review-state.ts';

/**
 * `delete_anki_card_for_library`（`database/mod.rs:5887-6005`）：
 * 内容版本 + 复习版本双 CAS；FSRS 清理走 L15 同一事务，卡片行由本 lane 删除。
 */
export function deleteAnkiCardForLibrary(
  db: DatabaseHandle,
  fsrs: FsrsTransactionOwner,
  cardId: string,
  expectedUpdatedAt: string,
  expectedReviewVersion: number | bigint | null,
  nowMs: number,
): AnkiLibraryCardDeleteOutcome {
  const trimmed = cardId.trim();
  if (trimmed === '' || expectedUpdatedAt.trim() === '') {
    throw new Error('cardId and expectedVersion are required');
  }
  const expectedReview = expectedReviewVersionI64(expectedReviewVersion);
  return db.transaction((tx) => {
    const current = getLibraryCardRecord(tx, trimmed, nowMs);
    if (current === undefined) return { type: 'notFound' } as const;
    const currentCard = decodeAnkiLibraryCardRow(current);
    const review = getReviewStatesForLibrary(tx, [trimmed])[0] ?? null;
    if (currentCard.updated_at !== expectedUpdatedAt) {
      return { type: 'contentConflict', current: currentCard, review } as const;
    }
    const reviewMatches = review === null
      ? expectedReview === null
      : expectedReview !== null && review.reviewVersion === expectedReview;
    if (!reviewMatches) {
      return { type: 'reviewConflict', current: currentCard, review } as const;
    }

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
               AND dt.deleted_at IS NULL
         )`,
      [trimmed, expectedUpdatedAt],
    ).changes;
    if (deleted === 1) {
      return {
        type: 'deleted',
        locator: {
          documentId: current.document_id,
          sourceSessionId: current.source_session_id,
        },
      } as const;
    }

    const after = getLibraryCardRecord(tx, trimmed, nowMs);
    if (after === undefined) return { type: 'notFound' } as const;
    const afterReview = getReviewStatesForLibrary(tx, [trimmed])[0] ?? null;
    const afterCard = decodeAnkiLibraryCardRow(after);
    return afterCard.updated_at !== expectedUpdatedAt
      ? { type: 'contentConflict', current: afterCard, review: afterReview } as const
      : { type: 'reviewConflict', current: afterCard, review: afterReview } as const;
  }, { behavior: 'immediate' });
}

export type AnkiLibraryCardVersionUpdateRow =
  | { type: 'updated'; current: AnkiLibraryCardRow }
  | { type: 'conflict'; current: AnkiLibraryCardRow }
  | { type: 'notFound' };

/**
 * `update_anki_card_if_version_for_library`（`database/mod.rs:5392-5466`）：
 * 送审快照的 `updated_at` 作为 CAS 版本；成功后 `local_version + 1`。
 * 卡片与父任务必须同时存活，否则视为不存在。
 */
export function updateAnkiCardIfVersionForLibrary(
  db: DatabaseHandle,
  card: AnkiCard,
  expectedUpdatedAt: string,
  nowMs: number,
): AnkiLibraryCardVersionUpdateRow {
  if (card.id.trim() === '' || expectedUpdatedAt.trim() === '') {
    throw new Error('cardId and expectedVersion are required');
  }
  return db.transaction((tx) => {
    const current = getLibraryCardRecord(tx, card.id, nowMs);
    if (current === undefined) return { type: 'notFound' } as const;
    if (current.updated_at !== expectedUpdatedAt) {
      return { type: 'conflict', current } as const;
    }

    let updatedAt = nowRfc3339();
    if (updatedAt === expectedUpdatedAt) {
      updatedAt = rfc3339FromMillis(nowMs + 1) ?? updatedAt;
    }
    const updated = tx.run(
      `UPDATE anki_cards SET
         front = ?1, back = ?2, text = ?3, tags_json = ?4, images_json = ?5,
         is_error_card = ?6, error_content = ?7, updated_at = ?8,
         extra_fields_json = ?9, template_id = ?10,
         local_version = COALESCE(local_version, 0) + 1
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
    );
    if (updated.changes !== 1) {
      const after = getLibraryCardRecord(tx, card.id, nowMs);
      return after === undefined
        ? ({ type: 'notFound' } as const)
        : ({ type: 'conflict', current: after } as const);
    }
    const after = getLibraryCardRecord(tx, card.id, nowMs);
    if (after === undefined) {
      throw new Error('library card missing after content update');
    }
    return { type: 'updated', current: after } as const;
  });
}

// ------------------------------------------------------------ 卡片库读取

/**
 * `load_anki_library_card_record`（`database/mod.rs:331-362`）：
 * 卡片 + 任务定位 + 可选的 FSRS 状态快照（同库 LEFT JOIN）。
 */
export function getLibraryCardRecord(
  db: SqlExecutor,
  cardId: string,
  nowMs: number,
): AnkiLibraryCardRow | undefined {
  return db.get<AnkiLibraryCardRow>(
    `SELECT
       ac.id AS id, ac.task_id AS task_id, ac.front AS front, ac.back AS back,
       ac.text AS text, ac.tags_json AS tags_json, ac.images_json AS images_json,
       ac.is_error_card AS is_error_card, ac.error_content AS error_content,
       ac.created_at AS created_at, ac.updated_at AS updated_at,
       COALESCE(ac.extra_fields_json, '{}') AS extra_fields_json,
       ac.template_id AS template_id, ac.source_type AS source_type, ac.source_id AS source_id,
       fs.id AS state_id, fs.state AS state, fs.due_ms AS due_ms,
       COALESCE(fs.suspended, 0) AS suspended,
       CASE WHEN fs.id IS NULL THEN 0 ELSE 1 END AS enqueued,
       CASE
         WHEN fs.id IS NOT NULL
          AND COALESCE(fs.suspended, 0) = 0
          AND fs.due_ms <= ?2
         THEN 1 ELSE 0
       END AS is_due,
       dt.document_id AS document_id, dt.source_session_id AS source_session_id
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     LEFT JOIN fsrs_card_states fs
       ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
     WHERE ac.id = ?1
       AND ac.deleted_at IS NULL
       AND dt.deleted_at IS NULL`,
    [cardId, nowMs],
  );
}

// ------------------------------------------------------------ 卡片库列表

/** 卡片所属牌组（`database/mod.rs:8041-8043`）。 */
const LIBRARY_DECK_EXPR = `COALESCE(TRIM(CASE WHEN json_valid(dt.anki_generation_options_json) \
THEN json_extract(dt.anki_generation_options_json, '$.deck_name') END), '')`;

/** `sql_util::escape_like_pattern`（`database/sql_util.rs:6-11`）。 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function nonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * `list_anki_library_cards_filtered`（`database/mod.rs:7753-7990`）：
 * 模板 / 搜索 / 牌组 / 调度状态筛选、排序、分页与各状态计数。
 */
export function listAnkiLibraryCardsFiltered(
  db: SqlExecutor,
  templateId: string | null,
  search: string | null,
  filter: AnkiLibraryListFilter,
  page: number,
  pageSize: number,
  nowMs: number,
): { items: AnkiLibraryCard[]; total: number; statusCounts: AnkiLibraryStatusCounts } {
  const clauses: string[] = ['ac.deleted_at IS NULL', 'dt.deleted_at IS NULL'];
  const params: SqlParam[] = [];

  const templateValue = trimmedOrNull(templateId);
  if (templateValue !== null) {
    clauses.push('ac.template_id = ?');
    params.push(templateValue);
  }

  const searchValue = trimmedOrNull(search);
  if (searchValue !== null) {
    clauses.push("(ac.front LIKE ? ESCAPE '\\' OR ac.back LIKE ? ESCAPE '\\' OR ac.text LIKE ? ESCAPE '\\' OR ac.tags_json LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLikePattern(searchValue)}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  const deckValue = filter.deck === null || filter.deck === undefined ? null : filter.deck.trim();
  if (deckValue !== null) {
    if (deckValue === '') {
      clauses.push(`ac.task_id IN (SELECT dt.id FROM document_tasks dt WHERE ${LIBRARY_DECK_EXPR} = '')`);
    } else {
      const prefix = `${deckValue}::`;
      clauses.push(
        `ac.task_id IN (SELECT dt.id FROM document_tasks dt
         WHERE ${LIBRARY_DECK_EXPR} = ? OR substr(${LIBRARY_DECK_EXPR}, 1, ?) = ?)`,
      );
      params.push(deckValue, [...prefix].length, prefix);
    }
  }

  const baseWhere = `WHERE ${clauses.join(' AND ')}`;
  const countsSql = `SELECT
      COUNT(*) AS c_all,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.state != 0 AND fs.due_ms <= ? THEN 1 ELSE 0 END), 0) AS c_due,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.state = 0 THEN 1 ELSE 0 END), 0) AS c_new,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.state IN (1, 3) THEN 1 ELSE 0 END), 0) AS c_learning,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.state = 2 THEN 1 ELSE 0 END), 0) AS c_review,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 1 THEN 1 ELSE 0 END), 0) AS c_suspended,
      COALESCE(SUM(CASE WHEN fs.id IS NULL THEN 1 ELSE 0 END), 0) AS c_not_enqueued
    FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    LEFT JOIN fsrs_card_states fs
      ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
    ${baseWhere}`;
  const countsRow = db.one<{
    c_all: number;
    c_due: number;
    c_new: number;
    c_learning: number;
    c_review: number;
    c_suspended: number;
    c_not_enqueued: number;
  }>(countsSql, [nowMs, ...params]);
  const statusCounts: AnkiLibraryStatusCounts = {
    all: nonNegative(countsRow.c_all),
    due: nonNegative(countsRow.c_due),
    new: nonNegative(countsRow.c_new),
    learning: nonNegative(countsRow.c_learning),
    review: nonNegative(countsRow.c_review),
    suspended: nonNegative(countsRow.c_suspended),
    notEnqueued: nonNegative(countsRow.c_not_enqueued),
  };

  const active = 'fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0';
  const status = trimmedOrNull(filter.status);
  if (status === 'due') {
    clauses.push(`${active} AND fs.state != 0 AND fs.due_ms <= ?`);
    params.push(nowMs);
  } else if (status === 'new') {
    clauses.push(`${active} AND fs.state = 0`);
  } else if (status === 'learning') {
    clauses.push(`${active} AND fs.state IN (1, 3)`);
  } else if (status === 'review') {
    clauses.push(`${active} AND fs.state = 2`);
  } else if (status === 'suspended') {
    clauses.push('fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 1');
  } else if (status === 'notEnqueued') {
    clauses.push('fs.id IS NULL');
  }

  const whereClause = `WHERE ${clauses.join(' AND ')}`;
  const countSql = `SELECT COUNT(*) AS total
    FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    LEFT JOIN fsrs_card_states fs
      ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
    ${whereClause}`;
  const totalRow = db.one<{ total: number }>(countSql, params);

  const descending = filter.sortDesc ?? false;
  const dir = descending ? 'DESC' : 'ASC';
  const sort = trimmedOrNull(filter.sort);
  let orderBy: string;
  if (sort === 'due') {
    orderBy = `(fs.due_ms IS NULL) ASC, fs.due_ms ${dir}, ac.created_at DESC, ac.id DESC`;
  } else if (sort === 'created') {
    orderBy = `ac.created_at ${dir}, ac.id ${dir}`;
  } else if (sort === 'front') {
    orderBy = `ac.front COLLATE NOCASE ${dir}, ac.id ${dir}`;
  } else {
    orderBy = 'ac.created_at DESC, ac.id DESC';
  }

  const safePage = page < 1 ? 1 : page;
  const safePageSize = Math.min(200, Math.max(1, pageSize));
  const offset = (safePage - 1) * safePageSize;

  const dataSql = `SELECT
      ac.id AS id, ac.task_id AS task_id, ac.front AS front, ac.back AS back, ac.text AS text,
      COALESCE(ac.tags_json, '[]') AS tags_json, COALESCE(ac.images_json, '[]') AS images_json,
      ac.is_error_card AS is_error_card, ac.error_content AS error_content,
      ac.created_at AS created_at, ac.updated_at AS updated_at,
      COALESCE(ac.extra_fields_json, '{}') AS extra_fields_json,
      ac.template_id AS template_id, ac.source_type AS source_type, ac.source_id AS source_id,
      fs.id AS state_id, fs.state AS state, fs.due_ms AS due_ms, COALESCE(fs.suspended, 0) AS suspended,
      CASE WHEN fs.id IS NULL THEN 0 ELSE 1 END AS enqueued,
      CASE
        WHEN fs.id IS NOT NULL
         AND COALESCE(fs.suspended, 0) = 0
         AND fs.due_ms <= ?
        THEN 1 ELSE 0
      END AS is_due,
      dt.source_session_id AS source_session_id,
      CASE WHEN json_valid(dt.anki_generation_options_json)
        THEN json_extract(dt.anki_generation_options_json, '$.source_ref') END AS source_ref_json
    FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    LEFT JOIN fsrs_card_states fs
      ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`;
  const rows = db.all<AnkiLibraryListRow>(dataSql, [nowMs, ...params, safePageSize, offset]);
  const total = nonNegative(totalRow.total);
  return { items: rows.map(decodeAnkiLibraryListRow), total, statusCounts };
}

/** `list_anki_library_deck_counts`（`database/mod.rs:7998-8036`）。 */
export function listAnkiLibraryDeckCounts(db: SqlExecutor, nowMs: number): AnkiLibraryDeckCount[] {
  const sql = `WITH task_decks AS MATERIALIZED (
      SELECT dt.id AS task_id, ${LIBRARY_DECK_EXPR} AS deck
      FROM document_tasks dt
      WHERE dt.deleted_at IS NULL
    )
    SELECT
      td.deck AS deck,
      COUNT(*) AS d_all,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.state != 0 AND fs.due_ms <= ?1 THEN 1 ELSE 0 END), 0) AS d_due,
      COALESCE(SUM(CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.state = 0 THEN 1 ELSE 0 END), 0) AS d_new,
      COALESCE(SUM(CASE WHEN fs.id IS NULL THEN 1 ELSE 0 END), 0) AS d_not_enqueued
    FROM anki_cards ac
    INNER JOIN task_decks td ON td.task_id = ac.task_id
    LEFT JOIN fsrs_card_states fs
      ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
    WHERE ac.deleted_at IS NULL
    GROUP BY td.deck
    ORDER BY td.deck`;
  const rows = db.all<{
    deck: string | null;
    d_all: number;
    d_due: number;
    d_new: number;
    d_not_enqueued: number;
  }>(sql, [nowMs]);
  return rows.map((row) => ({
    name: row.deck ?? '',
    all: nonNegative(row.d_all),
    due: nonNegative(row.d_due),
    new: nonNegative(row.d_new),
    notEnqueued: nonNegative(row.d_not_enqueued),
  }));
}
