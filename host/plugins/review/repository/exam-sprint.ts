/**
 * Exam-Horizon Sprint repository:
 * - Persists per-space ExamHorizonConfig inside DEFAULT_DECK_ID's `anki_decks.config_json`
 *   using `ensureDefaultDeck` + `writeConfigJson` from `./fsrs.ts` (preserving serde numbers).
 * - Performs read-only queries against `vfs` (`vfs_study_space_profiles`, `folder_items`,
 *   `vfs_space_mounts`, `vfs_anchor_edges`, `review_history`) with graceful fallback when
 *   sibling migration tables are absent in standalone plugin tests.
 * - Hydrates active FSRS card states and `anki_cards` content for Smart Triage and Sprint playback.
 */
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import { readConfigObjectExact } from '../src/config-json.ts';
import { appError, errorText } from '../src/errors.ts';
import { DEFAULT_DECK_ID } from '../src/fsrs-types.ts';
import {
  STATE_COLUMNS,
  dailyCounters,
  ensureDefaultDeck,
  loadSchedulerConfig,
  mapStateRow,
  readConfigJsonText,
  writeConfigJson,
} from './fsrs.ts';
import { parseJsonArray, parseJsonObject } from './fsrs-json.ts';
import type { SprintSessionSettlement } from '../src/examHorizonScheduler.ts';

export const DEFAULT_SPACE_CONFIG_KEY = '__default__';
const EXAM_HORIZON_MAP_KEY = 'exam_horizon_by_space';

export interface PersistedExamHorizonEntry {
  rootFolderId: string | null;
  examDate: string | null;
  sprintBudgetMinutes: number;
  baseTargetRetention: number;
  defaultDeckId: string | null;
}

export interface StudySpaceProfileRow {
  spaceId: string;
  rootFolderId: string | null;
  examDate: string | null;
  dailyBudgetMinutes: number | null;
  targetRetention: number | null;
  defaultDeckId: string | null;
}

export interface FolderScopeResourceIds {
  folderIds: Set<string>;
  itemIds: Set<string>;
}

export interface OutboundAnchorEdgeRow {
  targetAnchorUri: string | null;
  targetKind: string;
  targetResourceId: string;
  targetPage: number | null;
  targetStartMs: number | null;
  sourceLabel: string | null;
}

export interface HydratedAnkiSprintCard {
  ankiCardId: string;
  deckName: string | null;
  front: string;
  back: string;
  text: string | null;
  templateId: string | null;
  tags: string[];
  extraFields: Record<string, string>;
  images: string[];
  sourceType: string | null;
  sourceId: string | null;
  documentId: string;
  originalDocumentName: string | null;
  sourceRefJson: string | null;
}

export interface ActiveFsrsSprintRow {
  state: ReturnType<typeof mapStateRow>;
  card: HydratedAnkiSprintCard;
}

export interface HistoricalDurationStat {
  reviewCount: number;
  meanSeconds: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nullableTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

export function spaceScopeKey(spaceId: string | null | undefined): string {
  const normalized = nullableTrimmedString(spaceId);
  return normalized ?? DEFAULT_SPACE_CONFIG_KEY;
}

export function readSprintSettlement(db: SqlExecutor, sessionId: string): SprintSessionSettlement | null {
  const config = parseJsonRecord(readConfigJsonText(db, DEFAULT_DECK_ID));
  const receipts = config?.sprint_session_receipts;
  if (!isPlainRecord(receipts)) return null;
  const receipt = receipts[sessionId];
  return isPlainRecord(receipt) ? receipt as unknown as SprintSessionSettlement : null;
}

export function writeSprintSettlement(db: SqlExecutor, settlement: SprintSessionSettlement, nowRfc: string): void {
  ensureDefaultDeck(db, nowRfc);
  const config = readConfigObjectExact(readConfigJsonText(db, DEFAULT_DECK_ID));
  const parsed = parseJsonRecord(readConfigJsonText(db, DEFAULT_DECK_ID));
  const existing = parsed?.sprint_session_receipts;
  config.sprint_session_receipts = {
    ...(isPlainRecord(existing) ? existing : {}),
    [settlement.planSessionId]: settlement,
  };
  writeConfigJson(db, DEFAULT_DECK_ID, config, nowRfc);
}

function decodePersistedEntry(raw: unknown): PersistedExamHorizonEntry | null {
  if (!isPlainRecord(raw)) return null;
  const budget = nullableFiniteNumber(raw.sprintBudgetMinutes);
  const retention = nullableFiniteNumber(raw.baseTargetRetention);
  return {
    rootFolderId: nullableTrimmedString(raw.rootFolderId),
    examDate: nullableTrimmedString(raw.examDate),
    sprintBudgetMinutes: budget ?? 15,
    baseTargetRetention: retention ?? 0.88,
    defaultDeckId: nullableTrimmedString(raw.defaultDeckId),
  };
}

export function readPersistedExamHorizonMap(
  mistakesDb: SqlExecutor,
  debug: (message: string) => void = () => undefined,
): Record<string, PersistedExamHorizonEntry> {
  let rawText: string | null = null;
  try {
    rawText = readConfigJsonText(mistakesDb, DEFAULT_DECK_ID);
  } catch (error) {
    debug(`[exam-sprint] Failed to read config_json for exam horizon: ${errorText(error)}`);
    return {};
  }
  const root = parseJsonRecord(rawText);
  if (root === null) return {};
  const mapRaw = root[EXAM_HORIZON_MAP_KEY];
  if (!isPlainRecord(mapRaw)) return {};
  const out: Record<string, PersistedExamHorizonEntry> = {};
  for (const [key, item] of Object.entries(mapRaw)) {
    const decoded = decodePersistedEntry(item);
    if (decoded !== null) {
      out[key] = decoded;
    }
  }
  return out;
}

export function readPersistedExamHorizonEntry(
  mistakesDb: SqlExecutor,
  spaceId: string | null,
  debug: (message: string) => void = () => undefined,
): PersistedExamHorizonEntry | null {
  const map = readPersistedExamHorizonMap(mistakesDb, debug);
  const key = spaceScopeKey(spaceId);
  return map[key] ?? null;
}

export function writePersistedExamHorizonEntry(
  mistakesDb: SqlExecutor,
  spaceId: string | null,
  entry: PersistedExamHorizonEntry,
  nowRfc: string,
  debug: (message: string) => void = () => undefined,
): void {
  ensureDefaultDeck(mistakesDb, nowRfc);
  const rawText = readConfigJsonText(mistakesDb, DEFAULT_DECK_ID);
  const exactConfig = readConfigObjectExact(rawText);
  const existingMap = readPersistedExamHorizonMap(mistakesDb, debug);
  const serializedMap: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(existingMap)) {
    serializedMap[key] = {
      rootFolderId: item.rootFolderId,
      examDate: item.examDate,
      sprintBudgetMinutes: item.sprintBudgetMinutes,
      baseTargetRetention: item.baseTargetRetention,
      defaultDeckId: item.defaultDeckId,
    };
  }
  serializedMap[spaceScopeKey(spaceId)] = {
    rootFolderId: entry.rootFolderId,
    examDate: entry.examDate,
    sprintBudgetMinutes: entry.sprintBudgetMinutes,
    baseTargetRetention: entry.baseTargetRetention,
    defaultDeckId: entry.defaultDeckId,
  };
  exactConfig[EXAM_HORIZON_MAP_KEY] = serializedMap;
  writeConfigJson(mistakesDb, DEFAULT_DECK_ID, exactConfig, nowRfc);
}

export function loadDefaultDeckSchedulerSummary(
  mistakesDb: SqlExecutor,
  dayStartMs: number,
  nextDayStartMs: number,
  warn: (message: string) => void = () => undefined,
): {
  dayRolloverHour: number;
  desiredRetention: number;
  newPerDay: number;
  fsrsParams: number[];
  newIntroducedToday: number;
} {
  const scheduler = loadSchedulerConfig(mistakesDb, DEFAULT_DECK_ID, warn);
  const counters = dailyCounters(mistakesDb, dayStartMs, nextDayStartMs);
  return {
    dayRolloverHour: scheduler.dayRolloverHour,
    desiredRetention: scheduler.desiredRetention,
    newPerDay: scheduler.newPerDay,
    fsrsParams: scheduler.fsrsParams,
    newIntroducedToday: counters.newIntroduced,
  };
}

export function readStudySpaceProfileRow(
  vfsDb: SqlExecutor | null,
  spaceId: string | null,
  debug: (message: string) => void = () => undefined,
): StudySpaceProfileRow | null {
  const normalizedSpaceId = nullableTrimmedString(spaceId);
  if (vfsDb === null || normalizedSpaceId === null) return null;
  try {
    const row = vfsDb.get<Row>(
      `SELECT space_id, root_folder_id, exam_date, daily_budget_minutes, target_retention, default_deck_id
       FROM vfs_study_space_profiles
       WHERE space_id = ?1 AND deleted_at IS NULL
       LIMIT 1`,
      [normalizedSpaceId],
    );
    if (row === undefined) return null;
    return {
      spaceId: String(row.space_id),
      rootFolderId: nullableTrimmedString(row.root_folder_id),
      examDate: nullableTrimmedString(row.exam_date),
      dailyBudgetMinutes: nullableFiniteNumber(
        row.daily_budget_minutes === null || row.daily_budget_minutes === undefined
          ? null
          : Number(row.daily_budget_minutes),
      ),
      targetRetention: nullableFiniteNumber(
        row.target_retention === null || row.target_retention === undefined
          ? null
          : Number(row.target_retention),
      ),
      defaultDeckId: nullableTrimmedString(row.default_deck_id),
    };
  } catch (error) {
    debug(`[exam-sprint] vfs_study_space_profiles unavailable: ${errorText(error)}`);
    return null;
  }
}

function expandDescendantFolders(
  vfsDb: SqlExecutor,
  seedFolderId: string,
  outFolders: Set<string>,
  debug: (message: string) => void,
): void {
  outFolders.add(seedFolderId);
  try {
    const rows = vfsDb.all<{ id: string }>(
      `WITH RECURSIVE folder_tree(id) AS (
         SELECT ?1
         UNION
         SELECT f.id
         FROM folders f
         INNER JOIN folder_tree ft ON f.parent_id = ft.id
         WHERE f.deleted_at IS NULL
       )
       SELECT id FROM folder_tree`,
      [seedFolderId],
    );
    for (const row of rows) {
      const id = nullableTrimmedString(row.id);
      if (id !== null) outFolders.add(id);
    }
  } catch (error) {
    debug(`[exam-sprint] folders recursion skipped for ${seedFolderId}: ${errorText(error)}`);
  }
}

export function readFolderResourceIds(
  vfsDb: SqlExecutor | null,
  rootFolderId: string | null,
  debug: (message: string) => void = () => undefined,
): FolderScopeResourceIds | null {
  const normalizedRoot = nullableTrimmedString(rootFolderId);
  if (normalizedRoot === null) return null;
  if (vfsDb === null) return { folderIds: new Set([normalizedRoot]), itemIds: new Set() };

  const folderIds = new Set<string>();
  const itemIds = new Set<string>();
  expandDescendantFolders(vfsDb, normalizedRoot, folderIds, debug);

  try {
    // Set iteration includes newly discovered mounted folders; cycles are visited once.
    for (const folderId of folderIds) {
      try {
        const mountRows = vfsDb.all<{ item_type: string; item_id: string }>(
          `SELECT item_type, item_id
           FROM vfs_space_mounts
           WHERE target_folder_id = ?1 AND deleted_at IS NULL`,
          [folderId],
        );
        for (const mount of mountRows) {
          const mountedId = nullableTrimmedString(mount.item_id);
          if (mountedId === null) continue;
          if (mount.item_type === 'folder') {
            expandDescendantFolders(vfsDb, mountedId, folderIds, debug);
          } else {
            itemIds.add(mountedId);
          }
        }
      } catch (mountError) {
        debug(`[exam-sprint] vfs_space_mounts unavailable: ${errorText(mountError)}`);
        break;
      }
    }

    for (const folderId of folderIds) {
      const rows = vfsDb.all<{ item_type: string; item_id: string }>(
        `SELECT item_type, item_id
         FROM folder_items
         WHERE folder_id = ?1 AND deleted_at IS NULL`,
        [folderId],
      );
      for (const row of rows) {
        const id = nullableTrimmedString(row.item_id);
        if (id !== null) itemIds.add(id);
      }
    }

    if (itemIds.size > 0) {
      try {
        const snapshotIds = [...itemIds];
        for (const candidateId of snapshotIds) {
          const resRows = vfsDb.all<{ id: string; source_id: string | null }>(
            `SELECT id, source_id
             FROM resources
             WHERE (id = ?1 OR source_id = ?1) AND deleted_at IS NULL
             LIMIT 4`,
            [candidateId],
          );
          for (const res of resRows) {
            const rid = nullableTrimmedString(res.id);
            const sid = nullableTrimmedString(res.source_id);
            if (rid !== null) itemIds.add(rid);
            if (sid !== null) itemIds.add(sid);
          }
        }
      } catch (resError) {
        debug(`[exam-sprint] resources alias expansion skipped: ${errorText(resError)}`);
      }
    }

    return { folderIds, itemIds };
  } catch (error) {
    debug(`[exam-sprint] folder_items lookup unavailable: ${errorText(error)}`);
    return { folderIds, itemIds };
  }
}

export function readOutboundAnchorForSource(
  vfsDb: SqlExecutor | null,
  sourceKind: string,
  sourceResourceId: string,
  sourceSubId: string,
  debug: (message: string) => void = () => undefined,
): OutboundAnchorEdgeRow | null {
  if (vfsDb === null) return null;
  const resourceId = nullableTrimmedString(sourceResourceId);
  if (resourceId === null) return null;
  const subId = sourceSubId.trim();
  try {
    const row = vfsDb.get<Row>(
      `SELECT target_anchor_uri, target_kind, target_resource_id, target_page, target_start_ms, source_label
       FROM vfs_anchor_edges
       WHERE source_kind = ?1
         AND source_resource_id = ?2
         AND (source_sub_id = ?3 OR ?3 = '')
       ORDER BY CASE WHEN source_sub_id = ?3 THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
      [sourceKind, resourceId, subId],
    );
    if (row === undefined) return null;
    const targetResourceId = nullableTrimmedString(row.target_resource_id);
    const targetKind = nullableTrimmedString(row.target_kind);
    if (targetResourceId === null || targetKind === null) return null;
    return {
      targetAnchorUri: nullableTrimmedString(row.target_anchor_uri),
      targetKind,
      targetResourceId,
      targetPage:
        row.target_page === null || row.target_page === undefined
          ? null
          : Math.trunc(Number(row.target_page)),
      targetStartMs:
        row.target_start_ms === null || row.target_start_ms === undefined
          ? null
          : Math.trunc(Number(row.target_start_ms)),
      sourceLabel: nullableTrimmedString(row.source_label),
    };
  } catch (error) {
    debug(`[exam-sprint] vfs_anchor_edges lookup skipped: ${errorText(error)}`);
    return null;
  }
}

const ANKI_DECK_NAME_EXPR = `CASE WHEN json_valid(dt.anki_generation_options_json)
  THEN TRIM(CAST(json_extract(dt.anki_generation_options_json, '$.deck_name') AS TEXT))
  END`;

const ANKI_SOURCE_REF_EXPR = `CASE WHEN json_valid(dt.anki_generation_options_json)
  THEN json_extract(dt.anki_generation_options_json, '$.source_ref')
  END`;

function mapHydratedCard(row: Row): HydratedAnkiSprintCard {
  const deckRaw = nullableTrimmedString(row.deckName);
  return {
    ankiCardId: String(row.ankiCardId),
    deckName: deckRaw,
    front: row.front === null || row.front === undefined ? '' : String(row.front),
    back: row.back === null || row.back === undefined ? '' : String(row.back),
    text: row.text === null || row.text === undefined ? null : String(row.text),
    templateId: nullableTrimmedString(row.templateId),
    tags: parseJsonArray(row.tagsJson === null || row.tagsJson === undefined ? null : String(row.tagsJson)),
    extraFields: parseJsonObject(
      row.extraFieldsJson === null || row.extraFieldsJson === undefined ? null : String(row.extraFieldsJson),
    ),
    images: parseJsonArray(
      row.imagesJson === null || row.imagesJson === undefined ? null : String(row.imagesJson),
    ),
    sourceType: nullableTrimmedString(row.sourceType),
    sourceId: nullableTrimmedString(row.sourceId),
    documentId: String(row.documentId),
    originalDocumentName: nullableTrimmedString(row.originalDocumentName),
    sourceRefJson:
      row.sourceRefJson === null || row.sourceRefJson === undefined
        ? null
        : String(row.sourceRefJson),
  };
}

export function readAnkiCardsForSprint(
  mistakesDb: SqlExecutor,
  cardIds: readonly string[],
): Map<string, HydratedAnkiSprintCard> {
  const out = new Map<string, HydratedAnkiSprintCard>();
  if (cardIds.length === 0) return out;
  const uniqueIds = [...new Set(cardIds.filter((id) => id.trim().length > 0))];
  const chunkSize = 200;
  for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
    const chunk = uniqueIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
    try {
      const rows = mistakesDb.all<Row>(
        `SELECT ac.id AS ankiCardId,
                ${ANKI_DECK_NAME_EXPR} AS deckName,
                COALESCE(ac.front, '') AS front,
                COALESCE(ac.back, '') AS back,
                ac.text AS text,
                ac.template_id AS templateId,
                COALESCE(ac.tags_json, '[]') AS tagsJson,
                COALESCE(ac.extra_fields_json, '{}') AS extraFieldsJson,
                COALESCE(ac.images_json, '[]') AS imagesJson,
                ac.source_type AS sourceType,
                ac.source_id AS sourceId,
                dt.document_id AS documentId,
                dt.original_document_name AS originalDocumentName,
                ${ANKI_SOURCE_REF_EXPR} AS sourceRefJson
         FROM anki_cards ac
         INNER JOIN document_tasks dt ON dt.id = ac.task_id
         WHERE ac.id IN (${placeholders})
           AND ac.deleted_at IS NULL
           AND dt.deleted_at IS NULL
           AND COALESCE(ac.is_error_card, 0) = 0`,
        chunk,
      );
      for (const row of rows) {
        const card = mapHydratedCard(row);
        out.set(card.ankiCardId, card);
      }
    } catch (error) {
      throw appError('Database', `Failed to hydrate Anki cards for Sprint: ${errorText(error)}`);
    }
  }
  return out;
}

export function listActiveFsrsSprintRows(
  mistakesDb: SqlExecutor,
  limit?: number,
): ActiveFsrsSprintRow[] {
  const safeLimit = limit !== undefined && Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : -1;
  try {
    const rows = mistakesDb.all<Row>(
      `SELECT ${STATE_COLUMNS},
              ${ANKI_DECK_NAME_EXPR} AS deckName,
              COALESCE(a.front, '') AS front,
              COALESCE(a.back, '') AS back,
              a.text AS text,
              a.template_id AS templateId,
              COALESCE(a.tags_json, '[]') AS tagsJson,
              COALESCE(a.extra_fields_json, '{}') AS extraFieldsJson,
              COALESCE(a.images_json, '[]') AS imagesJson,
              a.source_type AS sourceType,
              a.source_id AS sourceId,
              dt.document_id AS documentId,
              dt.original_document_name AS originalDocumentName,
              ${ANKI_SOURCE_REF_EXPR} AS sourceRefJson
       FROM fsrs_card_states s
       INNER JOIN anki_cards a ON a.id = s.anki_card_id
       INNER JOIN document_tasks dt ON dt.id = a.task_id
       WHERE s.deleted_at IS NULL
         AND a.deleted_at IS NULL
         AND dt.deleted_at IS NULL
         AND COALESCE(a.is_error_card, 0) = 0
         AND s.suspended = 0
       ORDER BY s.due_ms ASC, s.id ASC
       LIMIT ?1`,
      [safeLimit],
    );
    return rows.map((row) => ({
      state: mapStateRow(row),
      card: mapHydratedCard(row),
    }));
  } catch (error) {
    throw appError('Database', `Failed to list active FSRS sprint rows: ${errorText(error)}`);
  }
}

export function readFsrsHistoricalDurations(
  mistakesDb: SqlExecutor,
  debug: (message: string) => void = () => undefined,
): Map<string, HistoricalDurationStat> {
  const out = new Map<string, HistoricalDurationStat>();
  try {
    const rows = mistakesDb.all<{
      cardStateId: string;
      reviewCount: number;
      meanSeconds: number;
    }>(
      `SELECT card_state_id AS cardStateId,
              COUNT(*) AS reviewCount,
              AVG(duration_ms) / 1000.0 AS meanSeconds
       FROM fsrs_review_logs
       WHERE deleted_at IS NULL
         AND duration_ms IS NOT NULL
         AND duration_ms > 0
       GROUP BY card_state_id`,
    );
    for (const row of rows) {
      const count = Number(row.reviewCount);
      const mean = Number(row.meanSeconds);
      if (Number.isFinite(count) && count > 0 && Number.isFinite(mean) && mean > 0) {
        out.set(String(row.cardStateId), { reviewCount: count, meanSeconds: mean });
      }
    }
  } catch (error) {
    debug(`[exam-sprint] fsrs_review_logs duration aggregation skipped: ${errorText(error)}`);
  }
  return out;
}

export function readReviewPlanHistoricalDurations(
  vfsDb: SqlExecutor | null,
  debug: (message: string) => void = () => undefined,
): Map<string, HistoricalDurationStat> {
  const out = new Map<string, HistoricalDurationStat>();
  if (vfsDb === null) return out;
  try {
    const rows = vfsDb.all<{
      planId: string;
      reviewCount: number;
      meanSeconds: number;
    }>(
      `SELECT plan_id AS planId,
              COUNT(*) AS reviewCount,
              AVG(time_spent_seconds) AS meanSeconds
       FROM review_history
       WHERE time_spent_seconds IS NOT NULL
         AND time_spent_seconds > 0
       GROUP BY plan_id`,
    );
    for (const row of rows) {
      const count = Number(row.reviewCount);
      const mean = Number(row.meanSeconds);
      if (Number.isFinite(count) && count > 0 && Number.isFinite(mean) && mean > 0) {
        out.set(String(row.planId), { reviewCount: count, meanSeconds: mean });
      }
    }
  } catch (error) {
    debug(`[exam-sprint] review_history duration aggregation skipped: ${errorText(error)}`);
  }
  return out;
}
