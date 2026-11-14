/** FSRS 持久层：自有 `fsrs_*` SQL 与牌组读取；`anki_decks` 写入经 L16 公开同 conn 接缝。 */
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import { ensureDefaultFsrsDeckWithConn, writeFsrsDeckConfigWithConn } from '../../anki/api.ts';
import { appError, errorText } from '../src/errors.ts';
import {
  DEFAULT_DECK_ID, DEFAULT_DESIRED_RETENTION, FSRS_PARAMS_VERSION,
  MS_PER_DAY, decodeStateBeforeSnapshot, defaultSchedulerConfig, validateSnapshotFor,
  type FsrsAgentLatestReviewSnapshot, type FsrsAgentReviewStateSnapshot, type FsrsCardState,
  type FsrsDueCard, type FsrsEnqueuedCard, type FsrsFeedbackRow,
  type FsrsImportedSchedule, type FsrsPendingMasteryReview, type FsrsSchedulerConfig,
  type FsrsStateBeforeSnapshot,
} from '../src/fsrs-types.ts';
import { checkParametersUsable, sanitizeSteps } from '../src/fsrs-scheduler.ts';
import { asF64, asI64, asU64, getKey, parseSerdeJson } from '../src/serde-json.ts';
import { decodeStringArray, decodeStringMap, parseJsonArray, parseJsonObject } from './fsrs-json.ts';

export * from './fsrs-stats.ts';

export const STATE_COLUMNS = `s.id AS id, s.anki_card_id AS ankiCardId, s.deck_id AS deckId,
  s.state AS state, s.stability AS stability, s.difficulty AS difficulty,
  s.elapsed_days AS elapsedDays, s.scheduled_days AS scheduledDays,
  s.reps AS reps, s.lapses AS lapses, s.due_ms AS dueMs, s.last_review_ms AS lastReviewMs,
  s.suspended AS suspended, s.fsrs_params_version AS fsrsParamsVersion,
  s.desired_retention AS desiredRetention, s.created_at AS createdAt, s.updated_at AS updatedAt,
  COALESCE(s.leech, 0) AS leech, s.buried_until_ms AS buriedUntilMs,
  COALESCE(s.learning_step, 0) AS learningStep`;

const TRUNCATE_U32 = 4_294_967_295;

export function mapStateRow(row: Row): FsrsCardState {
  return {
    id: String(row.id),
    ankiCardId: String(row.ankiCardId),
    deckId: row.deckId === null || row.deckId === undefined ? null : String(row.deckId),
    state: Number(row.state),
    stability: row.stability === null || row.stability === undefined ? null : Number(row.stability),
    difficulty: row.difficulty === null || row.difficulty === undefined ? null : Number(row.difficulty),
    elapsedDays: Number(row.elapsedDays),
    scheduledDays: Number(row.scheduledDays),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    dueMs: Number(row.dueMs),
    lastReviewMs: row.lastReviewMs === null || row.lastReviewMs === undefined ? null : Number(row.lastReviewMs),
    suspended: Number(row.suspended) !== 0,
    fsrsParamsVersion: String(row.fsrsParamsVersion),
    desiredRetention: row.desiredRetention === null || row.desiredRetention === undefined ? null : Number(row.desiredRetention),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    leech: Number(row.leech) !== 0,
    buriedUntilMs: row.buriedUntilMs === null || row.buriedUntilMs === undefined ? null : Number(row.buriedUntilMs),
    learningStep: Math.min(TRUNCATE_U32, Math.max(0, Math.trunc(Number(row.learningStep)))),
  };
}

export function ensureDefaultDeck(db: SqlExecutor, now: string): void {
  try {
    ensureDefaultFsrsDeckWithConn(db, now);
  } catch (e) { throw appError('Database', `确保默认牌组失败: ${errorText(e)}`); }
}

export function loadSchedulerConfig(
  db: SqlExecutor, deckId: string, warn: (message: string) => void = () => undefined,
): FsrsSchedulerConfig {
  let raw: string | null = null;
  try {
    const row = db.get<{ config_json: string | null }>('SELECT config_json FROM anki_decks WHERE id = ?1 AND deleted_at IS NULL', [deckId]);
    raw = row?.config_json ?? null;
  } catch (e) { throw appError('Database', `读取牌组调度配置失败: ${errorText(e)}`); }
  const config = defaultSchedulerConfig();
  if (raw === null) return config;
  const value = parseSerdeJson(raw);
  if (value === undefined) {
    // Rust: warn! then fall back to the default scheduler config.
    warn(`[FsrsReviewService] 牌组 ${deckId} 的 config_json 解析失败，使用默认调度配置`);
    return config;
  }
  // Rust `value.get(snake).or_else(|| value.get(camel))`: a present snake key wins even when null.
  const field = (snake: string, camel: string): unknown => {
    const own = getKey(value, snake);
    return own !== undefined ? own : getKey(value, camel) ?? null;
  };
  const u32Sat = (n: bigint): number => Number(n > BigInt(TRUNCATE_U32) ? BigInt(TRUNCATE_U32) : n);
  const u64 = (snake: string, camel: string): bigint | null => asU64(field(snake, camel));
  let v: bigint | null;
  if ((v = u64('new_per_day', 'newPerDay')) !== null) config.newPerDay = u32Sat(v);
  if ((v = u64('reviews_per_day', 'reviewsPerDay')) !== null) config.reviewsPerDay = u32Sat(v);
  if ((v = u64('learn_ahead_minutes', 'learnAheadMinutes')) !== null && v <= 60n) config.learnAheadMinutes = Number(v);
  const retention = asF64(field('desired_retention', 'desiredRetention'));
  if (retention !== null && retention > 0 && retention < 1) config.desiredRetention = retention;
  if ((v = u64('leech_threshold', 'leechThreshold')) !== null) config.leechThreshold = u32Sat(v);
  const action = field('leech_action', 'leechAction');
  if (action === 'suspend' || action === 'mark') config.leechAction = action;
  const fuzz = field('enable_fuzz', 'enableFuzz');
  if (typeof fuzz === 'boolean') config.enableFuzz = fuzz;
  const numbers = (items: unknown): number[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed = items.map(asF64);
    return parsed.every(item => item !== null) ? parsed as number[] : null;
  };
  const learning = numbers(field('learning_steps', 'learningSteps'));
  if (learning !== null) config.learningSteps = sanitizeSteps(learning);
  const relearning = numbers(field('relearning_steps', 'relearningSteps'));
  if (relearning !== null) config.relearningSteps = sanitizeSteps(relearning);
  if ((v = u64('maximum_interval', 'maximumInterval')) !== null && v >= 1n && v <= 36_500n) config.maximumInterval = Number(v);
  if ((v = u64('day_rollover_hour', 'dayRolloverHour')) !== null && v <= 23n) config.dayRolloverHour = Number(v);
  const params = numbers(field('fsrs_params', 'fsrsParams'));
  if (params !== null) {
    const cast = params.map(item => Math.fround(item));
    if (checkParametersUsable(cast)) config.fsrsParams = cast;
  }
  const buryNew = field('bury_new_siblings', 'buryNewSiblings');
  if (typeof buryNew === 'boolean') config.buryNewSiblings = buryNew;
  const buryReview = field('bury_review_siblings', 'buryReviewSiblings');
  if (typeof buryReview === 'boolean') config.buryReviewSiblings = buryReview;
  const reviewOrder = field('review_order', 'reviewOrder');
  if (reviewOrder === 'due' || reviewOrder === 'retrievability' || reviewOrder === 'random') config.reviewOrder = reviewOrder;
  const newOrder = field('new_review_order', 'newReviewOrder');
  if (newOrder === 'after' || newOrder === 'before' || newOrder === 'mix') config.newReviewOrder = newOrder;
  if ((v = u64('max_answer_seconds', 'maxAnswerSeconds')) !== null && v >= 1n && v <= 3600n) config.maxAnswerSeconds = Number(v);
  const optimizedAt = asI64(getKey(value, 'fsrs_optimized_at_ms'));
  if (optimizedAt !== null && Number.isSafeInteger(Number(optimizedAt))) config.fsrsOptimizedAtMs = Number(optimizedAt);
  const optimizedCount = asU64(getKey(value, 'fsrs_optimized_review_count'));
  if (optimizedCount !== null) config.fsrsOptimizedReviewCount = u32Sat(optimizedCount);
  return config;
}

/** 默认牌组 config_json 原文（NULL/缺行为 null），供需要 serde 原样数字的读改写使用。 */
export function readConfigJsonText(db: SqlExecutor, deckId: string): string | null {
  try {
    const row = db.get<{ config_json: string | null }>('SELECT config_json FROM anki_decks WHERE id = ?1 AND deleted_at IS NULL', [deckId]);
    return row?.config_json ?? null;
  } catch (e) { throw appError('Database', `读取牌组调度配置失败: ${errorText(e)}`); }
}

export function writeConfigJson(db: SqlExecutor, deckId: string, value: Record<string, unknown>, now: string): void {
  try {
    writeFsrsDeckConfigWithConn(db, deckId, JSON.stringify(value), now);
  } catch (e) { throw appError('Database', `写入牌组调度配置失败: ${errorText(e)}`); }
}

export function loadStateById(db: SqlExecutor, id: string): FsrsCardState | null {
  try {
    const row = db.get<Row>(`SELECT ${STATE_COLUMNS} FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.id = ?1 AND s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL`, [id]);
    return row ? mapStateRow(row) : null;
  } catch (e) { throw appError('Database', `加载 card state 失败: ${errorText(e)}`); }
}

export function loadStateByAnkiCard(db: SqlExecutor, ankiCardId: string): FsrsCardState | null {
  try {
    const row = db.get<Row>(`SELECT ${STATE_COLUMNS} FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.anki_card_id = ?1 AND s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL`, [ankiCardId]);
    return row ? mapStateRow(row) : null;
  } catch (e) { throw appError('Database', `按 anki_card_id 加载失败: ${errorText(e)}`); }
}

export function loadStateForRate(db: SqlExecutor, id: string): { state: FsrsCardState; isErrorCard: boolean } | null {
  try {
    const row = db.get<Row>(`SELECT ${STATE_COLUMNS}, COALESCE(a.is_error_card, 0) AS isErrorCard
      FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.id = ?1 AND s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL`, [id]);
    return row ? { state: mapStateRow(row), isErrorCard: Number(row.isErrorCard) !== 0 } : null;
  } catch (e) { throw appError('Database', `加载待评分 card state 失败: ${errorText(e)}`); }
}

export interface CardSelection {
  documentId: string;
  sourceSessionId: string | null;
  isErrorCard: boolean;
  currentVersion: string;
}

export function loadCardSelection(db: SqlExecutor, cardId: string): CardSelection | null {
  try {
    const row = db.get<{ documentId: string; sourceSessionId: string | null; isErrorCard: number; currentVersion: string }>(
      `SELECT dt.document_id AS documentId, dt.source_session_id AS sourceSessionId,
              COALESCE(ac.is_error_card, 0) AS isErrorCard, ac.updated_at AS currentVersion
       FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
       WHERE ac.id = ?1 AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL LIMIT 1`, [cardId]);
    return row ? {
      documentId: String(row.documentId),
      sourceSessionId: row.sourceSessionId === null ? null : String(row.sourceSessionId),
      isErrorCard: Number(row.isErrorCard) !== 0,
      currentVersion: String(row.currentVersion),
    } : null;
  } catch (e) { throw appError('Database', `复验 Anki 卡片归属失败: ${errorText(e)}`); }
}

export function documentLiveCardIds(db: SqlExecutor, documentId: string, sessionId: string): string[] {
  try {
    return db.all<{ id: string }>(`SELECT ac.id AS id FROM anki_cards ac
      INNER JOIN document_tasks dt ON dt.id = ac.task_id
      WHERE dt.document_id = ?1 AND dt.source_session_id = ?2
        AND dt.deleted_at IS NULL AND ac.deleted_at IS NULL AND COALESCE(ac.is_error_card, 0) = 0
      ORDER BY dt.segment_index, ac.card_order_in_task, ac.created_at`, [documentId, sessionId])
      .map(row => String(row.id));
  } catch (e) { throw appError('Database', `查询文档 live cards 失败: ${errorText(e)}`); }
}

export function documentOwnedBySession(db: SqlExecutor, documentId: string, sessionId: string): boolean {
  try {
    const row = db.one<{ taskCount: number; ownedTaskCount: number }>(
      `SELECT COUNT(*) AS taskCount,
              COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0) AS ownedTaskCount
       FROM document_tasks WHERE document_id = ?1 AND deleted_at IS NULL`, [documentId, sessionId]);
    return Number(row.taskCount) > 0 && Number(row.taskCount) === Number(row.ownedTaskCount);
  } catch (e) { throw appError('Database', `复验制卡文档归属失败: ${errorText(e)}`); }
}

export function insertStateInTx(
  db: SqlExecutor, cardId: string, seed: FsrsImportedSchedule | null,
  desiredRetention: number, nowMs: number, nowRfc: string,
): { kind: 'inserted'; id: string } | { kind: 'already_live' } {
  let exists = false;
  try {
    exists = db.get(`SELECT 1 AS present FROM anki_cards ac
      INNER JOIN document_tasks dt ON dt.id = ac.task_id
      WHERE ac.id = ?1 AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL LIMIT 1`, [cardId]) !== undefined;
  } catch (e) { throw appError('Database', `查询 anki_cards 失败: ${errorText(e)}`); }
  if (!exists) throw appError('NotFound', `anki card not found: ${cardId}`);

  let existing: { id: string; deletedAt: string | null } | undefined;
  try {
    existing = db.get<{ id: string; deletedAt: string | null }>(
      'SELECT id AS id, deleted_at AS deletedAt FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId]);
  } catch (e) { throw appError('Database', `查询 fsrs_card_states 失败: ${errorText(e)}`); }
  if (existing) {
    if (existing.deletedAt === null) return { kind: 'already_live' };
    try {
      db.run('DELETE FROM fsrs_review_logs WHERE card_state_id = ?1', [existing.id]);
      db.run('DELETE FROM fsrs_card_states WHERE id = ?1', [existing.id]);
    } catch (e) { throw appError('Database', `清理已删除复习日志失败: ${errorText(e)}`); }
  }
  const actual = seed ?? newCardSeed(nowMs);
  const id = globalThis.crypto.randomUUID();
  try {
    db.run(`INSERT INTO fsrs_card_states (
      id, anki_card_id, deck_id, state, stability, difficulty,
      elapsed_days, scheduled_days, reps, lapses, due_ms, last_review_ms,
      suspended, fsrs_params_version, desired_retention, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
    [id, cardId, DEFAULT_DECK_ID, actual.state, actual.stability, actual.difficulty,
      actual.elapsedDays, actual.scheduledDays, actual.reps, actual.lapses, actual.dueMs,
      actual.lastReviewMs, actual.suspended ? 1 : 0, FSRS_PARAMS_VERSION, desiredRetention, nowRfc]);
  } catch (e) { throw appError('Database', `插入 fsrs_card_states 失败: ${errorText(e)}`); }
  return { kind: 'inserted', id };
}

export function newCardSeed(nowMs: number): FsrsImportedSchedule {
  return { state: 0, stability: null, difficulty: null, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, dueMs: nowMs, lastReviewMs: null, suspended: false };
}

export function loadReviewCardsForStates(db: SqlExecutor, states: readonly FsrsCardState[]): FsrsEnqueuedCard[] {
  const out: FsrsEnqueuedCard[] = [];
  for (const state of states) {
    let row: Row | undefined;
    try {
      row = db.get<Row>(`SELECT front, back, COALESCE(tags_json, '[]') AS tagsJson, text, template_id AS templateId,
        COALESCE(extra_fields_json, '{}') AS extraFieldsJson, COALESCE(images_json, '[]') AS imagesJson,
        COALESCE(is_error_card, 0) AS isErrorCard, error_content AS errorContent
        FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
        WHERE ac.id = ?1 AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL LIMIT 1`, [state.ankiCardId]);
    } catch (e) { throw appError('Database', `读取入队卡片正文失败 (${state.ankiCardId}): ${errorText(e)}`); }
    if (!row) throw appError('Database', `入队卡片正文不存在: ${state.ankiCardId}`);
    let tags: string[];
    try {
      tags = row.tagsJson === null ? [] : parseJsonArrayStrict(String(row.tagsJson));
    } catch (e) {
      throw appError('Database', `解析入队卡片标签失败 (${state.ankiCardId}): ${errorText(e)}`);
    }
    let extraFields: Record<string, string>;
    try {
      extraFields = row.extraFieldsJson === null ? {} : parseObjectStrict(String(row.extraFieldsJson));
    } catch (e) {
      throw appError('Database', `解析入队卡片扩展字段失败 (${state.ankiCardId}): ${errorText(e)}`);
    }
    let images: string[];
    try {
      images = row.imagesJson === null ? [] : parseJsonArrayStrict(String(row.imagesJson));
    } catch (e) {
      throw appError('Database', `解析入队卡片图片失败 (${state.ankiCardId}): ${errorText(e)}`);
    }
    const card: FsrsEnqueuedCard = {
      id: state.id, ankiCardId: state.ankiCardId,
      front: row.front === null ? '' : String(row.front),
      back: row.back === null ? '' : String(row.back),
      tags, extraFields, images,
      isErrorCard: Number(row.isErrorCard) !== 0,
    };
    if (row.text !== null) card.text = String(row.text);
    if (row.templateId !== null) card.templateId = String(row.templateId);
    if (row.errorContent !== null) card.errorContent = String(row.errorContent);
    out.push(card);
  }
  return out;
}

function parseJsonArrayStrict(raw: string): string[] {
  const value = decodeStringArray(raw);
  if (value === null) throw new Error('expected string array');
  return value;
}
function parseObjectStrict(raw: string): Record<string, string> {
  const value = decodeStringMap(raw);
  if (value === null) throw new Error('expected string map');
  return value;
}

// ---- 到期队列 ----

const DUE_SELECT = `SELECT ${STATE_COLUMNS},
  COALESCE(a.front, '') AS front, COALESCE(a.back, '') AS back, COALESCE(a.tags_json, '[]') AS tagsJson,
  a.text AS text, a.template_id AS templateId, COALESCE(a.extra_fields_json, '{}') AS extraFieldsJson,
  COALESCE(a.images_json, '[]') AS imagesJson, COALESCE(a.is_error_card, 0) AS isErrorCard, a.error_content AS errorContent
  FROM fsrs_card_states s
  INNER JOIN anki_cards a ON a.id = s.anki_card_id
  INNER JOIN document_tasks dt ON dt.id = a.task_id`;

const DUE_FILTER = `s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
  AND COALESCE(a.is_error_card, 0) = 0 AND s.suspended = 0
  AND (s.buried_until_ms IS NULL OR s.buried_until_ms <= ?1)`;

function mapDueRow(row: Row): FsrsDueCard {
  const card: FsrsDueCard = {
    ...mapStateRow(row),
    front: row.front === null ? '' : String(row.front),
    back: row.back === null ? '' : String(row.back),
    tags: parseJsonArray(row.tagsJson === null ? null : String(row.tagsJson)),
    extraFields: parseJsonObject(row.extraFieldsJson === null ? null : String(row.extraFieldsJson)),
    images: parseJsonArray(row.imagesJson === null ? null : String(row.imagesJson)),
    isErrorCard: Number(row.isErrorCard) !== 0,
  };
  if (row.text !== null) card.text = String(row.text);
  if (row.templateId !== null) card.templateId = String(row.templateId);
  if (row.errorContent !== null) card.errorContent = String(row.errorContent);
  return card;
}

export function dueLearning(db: SqlExecutor, nowMs: number, limit: number): FsrsDueCard[] {
  return dueQuery(db, `${DUE_FILTER} AND s.state IN (1, 3) AND s.due_ms <= ?2`, 's.due_ms ASC', nowMs, nowMs, limit);
}
export function dueReview(db: SqlExecutor, nowMs: number, nextDayStartMs: number, limit: number, order: string): FsrsDueCard[] {
  const orderBy = order === 'retrievability'
    ? '(?1 - COALESCE(s.last_review_ms, s.due_ms)) * 1.0 / MAX(COALESCE(s.stability, 0.0), 0.001) DESC, s.due_ms ASC'
    : order === 'random' ? 'random()' : 's.due_ms ASC';
  return dueQuery(db, `${DUE_FILTER} AND s.state = 2 AND s.due_ms < ?2`, orderBy, nowMs, nextDayStartMs, limit);
}
export function dueNew(db: SqlExecutor, nowMs: number, limit: number): FsrsDueCard[] {
  return dueQuery(db, `${DUE_FILTER} AND s.state = 0 AND s.due_ms <= ?2`, 's.due_ms ASC', nowMs, nowMs, limit);
}
function dueQuery(db: SqlExecutor, condition: string, order: string, nowMs: number, boundary: number, limit: number): FsrsDueCard[] {
  if (limit === 0) return [];
  try {
    return db.all<Row>(`${DUE_SELECT} WHERE ${condition} ORDER BY ${order} LIMIT ?3`, [nowMs, boundary, limit]).map(mapDueRow);
  } catch (e) { throw appError('Database', `查询到期卡片失败: ${errorText(e)}`); }
}

export function dailyCounters(db: SqlExecutor, dayStart: number, nextDayStart: number): { newIntroduced: number; reviewsDone: number } {
  try {
    const row = db.one<{ newIntroduced: number; reviewsDone: number }>(`SELECT
      COALESCE(SUM(CASE WHEN state_before = 0 THEN 1 ELSE 0 END), 0) AS newIntroduced,
      COALESCE(SUM(CASE WHEN state_before = 2 THEN 1 ELSE 0 END), 0) AS reviewsDone
      FROM fsrs_review_logs WHERE deleted_at IS NULL AND review_ms >= ?1 AND review_ms < ?2`, [dayStart, nextDayStart]);
    return { newIntroduced: Number(row.newIntroduced), reviewsDone: Number(row.reviewsDone) };
  } catch (e) { throw appError('Database', `读取每日复习计数失败: ${errorText(e)}`); }
}

export function updateStateAfterRate(
  db: SqlExecutor, cardId: string, outcome: FsrsScheduleOutcome, nowMs: number, nowRfc: string,
  retention: number, leech: boolean, suspended: boolean,
  cas: { expectedLastReviewMs: number | null } | null,
): number {
  const base = `UPDATE fsrs_card_states SET state = ?1, stability = ?2, difficulty = ?3,
    elapsed_days = ?4, scheduled_days = ?5, reps = ?6, lapses = ?7, due_ms = ?8,
    last_review_ms = ?9, fsrs_params_version = ?10, updated_at = ?11, leech = ?13,
    suspended = ?14, desired_retention = ?15, learning_step = ?16, buried_until_ms = NULL,
    local_version = COALESCE(local_version, 0) + 1 WHERE id = ?12 AND deleted_at IS NULL`;
  const values = [outcome.state, outcome.stability, outcome.difficulty, outcome.elapsedDays,
    outcome.scheduledDays, outcome.reps, outcome.lapses, outcome.dueMs, nowMs,
    outcome.modelVersion ?? FSRS_PARAMS_VERSION, nowRfc, cardId, leech ? 1 : 0, suspended ? 1 : 0, retention, outcome.learningStep];
  try {
    if (cas !== null) {
      return db.run(`${base} AND ((?17 IS NULL AND last_review_ms IS NULL) OR last_review_ms = ?17)`,
        [...values, cas.expectedLastReviewMs]).changes;
    }
    return db.run(base, values).changes;
  } catch (e) { throw appError('Database', `更新 fsrs_card_states 失败: ${errorText(e)}`); }
}

export interface FsrsScheduleOutcome {
  state: number; stability: number; difficulty: number; scheduledDays: number; elapsedDays: number;
  dueMs: number; reps: number; lapses: number; learningStep: number; modelVersion?: string; stabilityFast?: number;
}

export function insertReviewLog(
  db: SqlExecutor, logId: string, stateId: string, ankiCardId: string, rating: number,
  before: FsrsCardState, outcome: FsrsScheduleOutcome, nowMs: number, nowRfc: string,
  durationMs: number | null, snapshotJson: string,
): void {
  try {
    db.run(`INSERT INTO fsrs_review_logs (
      id, card_state_id, anki_card_id, rating, state_before, state_after,
      stability_before, stability_after, difficulty_before, difficulty_after,
      scheduled_days, elapsed_days, due_before_ms, due_after_ms,
      review_ms, duration_ms, fsrs_params_version, created_at, updated_at, state_before_json
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18, ?19)`,
    [logId, stateId, ankiCardId, rating, before.state, outcome.state,
      before.stability, outcome.stability, before.difficulty, outcome.difficulty,
      outcome.scheduledDays, outcome.elapsedDays, before.dueMs, outcome.dueMs,
      nowMs, durationMs, outcome.modelVersion ?? FSRS_PARAMS_VERSION, nowRfc, snapshotJson]);
    if (outcome.stabilityFast !== undefined) {
      db.run('INSERT INTO fsrs7_log_memory (log_id, stability_fast) VALUES (?1, ?2)', [logId, outcome.stabilityFast]);
    }
  } catch (e) {
    const message = errorText(e);
    if (message.includes('UNIQUE') || message.includes('unique')) {
      throw appError('Conflict', 'client op id already exists; retry with a new id');
    }
    throw appError('Database', `写入 fsrs_review_logs 失败: ${message}`);
  }
}

export type ExistingLogLookup =
  | { kind: 'missing' }
  | { kind: 'soft_deleted' }
  | { kind: 'replay'; logId: string; scheduledDays: number; dueMs: number };

export function loadExistingLog(db: SqlExecutor, logId: string, stateId: string, rating: number, trialV7 = false): ExistingLogLookup {
  try {
    const deleted = db.get('SELECT 1 AS present FROM fsrs_review_logs WHERE id = ?1 AND deleted_at IS NOT NULL LIMIT 1', [logId]);
    if (deleted) return { kind: 'soft_deleted' };
    const row = db.get<{ id: string; cardStateId: string; rating: number; scheduledDays: number; dueMs: number }>(
      `SELECT id, card_state_id AS cardStateId, rating, scheduled_days AS scheduledDays, due_after_ms AS dueMs
       FROM fsrs_review_logs WHERE id = ?1 AND deleted_at IS NULL`, [logId]);
    if (!row) return { kind: 'missing' };
    if (String(row.cardStateId) !== stateId) throw appError('Conflict', 'client op id belongs to a different card state');
    if (Number(row.rating) !== rating) throw appError('Conflict', 'client op id was committed with a different rating');
    const latest = latestActiveLogId(db, stateId, trialV7);
    if (latest !== logId) throw appError('Conflict', 'client op id is stale and is no longer the latest rating');
    return { kind: 'replay', logId, scheduledDays: Number(row.scheduledDays), dueMs: Number(row.dueMs) };
  } catch (e) {
    if (e instanceof Error && 'value' in e) throw e;
    throw appError('Database', `查询 fsrs_review_logs 失败: ${errorText(e)}`);
  }
}

export function latestActiveLogId(db: SqlExecutor, stateId: string, trialV7 = false): string | null {
  try {
    return db.pluck<string>(`SELECT id FROM fsrs_review_logs WHERE card_state_id = ?1 AND deleted_at IS NULL
      ORDER BY review_ms DESC, created_at DESC, ${trialV7 ? 'rowid' : 'id'} DESC LIMIT 1`, [stateId]) ?? null;
  } catch (e) { throw appError('Database', `校验最新复习日志失败: ${errorText(e)}`); }
}

export interface UndoLogRow {
  stateId: string; ankiCardId: string; reviewMs: number; snapshotJson: string | null; updatedAt: string | null;
}
/** Keep the exposed review eligible for the next undo after restoring its state. */
export function reanchorLatestUndoLog(db: SqlExecutor, stateId: string, nowRfc: string, trialV7 = false): void {
  try {
    db.run(`UPDATE fsrs_review_logs SET updated_at = ?1,
      local_version = COALESCE(local_version, 0) + 1
      WHERE id = (SELECT id FROM fsrs_review_logs WHERE card_state_id = ?2 AND deleted_at IS NULL
        ORDER BY review_ms DESC, created_at DESC, ${trialV7 ? 'rowid' : 'id'} DESC LIMIT 1)`, [nowRfc, stateId]);
  } catch (e) { throw appError('Database', `更新撤销日志基线失败: ${errorText(e)}`); }
}

export function loadLogForUndo(db: SqlExecutor, logId: string): UndoLogRow | null {
  try {
    const row = db.get<UndoLogRow>(`SELECT card_state_id AS stateId, anki_card_id AS ankiCardId, review_ms AS reviewMs,
      state_before_json AS snapshotJson, updated_at AS updatedAt FROM fsrs_review_logs
      WHERE id = ?1 AND deleted_at IS NULL`, [logId]);
    return row ? {
      stateId: String(row.stateId), ankiCardId: String(row.ankiCardId), reviewMs: Number(row.reviewMs),
      snapshotJson: row.snapshotJson === null ? null : String(row.snapshotJson),
      updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
    } : null;
  } catch (e) { throw appError('Database', `加载待撤销复习日志失败: ${errorText(e)}`); }
}

export function restoreStateFromSnapshot(
  db: SqlExecutor, stateId: string, snapshot: FsrsStateBeforeSnapshot,
  reviewMs: number, expectedUpdatedAt: string, nowRfc: string,
): number {
  try {
    return db.run(`UPDATE fsrs_card_states SET deck_id = ?1, state = ?2, stability = ?3,
      difficulty = ?4, elapsed_days = ?5, scheduled_days = ?6, reps = ?7, lapses = ?8,
      due_ms = ?9, last_review_ms = ?10, suspended = ?11, fsrs_params_version = ?12,
      desired_retention = ?13, leech = ?18, buried_until_ms = ?19, learning_step = ?20,
      updated_at = ?14, local_version = COALESCE(local_version, 0) + 1
      WHERE id = ?15 AND deleted_at IS NULL AND last_review_ms = ?16 AND updated_at = ?17`,
    [snapshot.deckId, snapshot.state, snapshot.stability, snapshot.difficulty,
      snapshot.elapsedDays, snapshot.scheduledDays, snapshot.reps, snapshot.lapses,
      snapshot.dueMs, snapshot.lastReviewMs, snapshot.suspended ? 1 : 0,
      snapshot.fsrsParamsVersion, snapshot.desiredRetention, nowRfc, stateId, reviewMs,
      expectedUpdatedAt, snapshot.leech ? 1 : 0, snapshot.buriedUntilMs, snapshot.learningStep]).changes;
  } catch (e) { throw appError('Database', `恢复 FSRS 卡片状态失败: ${errorText(e)}`); }
}

export function softDeleteLog(db: SqlExecutor, logId: string, stateId: string, nowRfc: string): number {
  try {
    return db.run(`UPDATE fsrs_review_logs SET deleted_at = ?1, updated_at = ?1,
      local_version = COALESCE(local_version, 0) + 1, mastery_revert_pending = 1
      WHERE id = ?2 AND card_state_id = ?3 AND deleted_at IS NULL`, [nowRfc, logId, stateId]).changes;
  } catch (e) { throw appError('Database', `软删除已撤销复习日志失败: ${errorText(e)}`); }
}

export function burySiblings(
  db: SqlExecutor, state: FsrsCardState, buryNew: boolean, buryReview: boolean,
  nowMs: number, nextDayStart: number, nowRfc: string,
): string[] {
  if (!buryNew && !buryReview) return [];
  let note: { taskId: string; noteKey: string | null } | undefined;
  try {
    note = db.get<{ taskId: string; noteKey: string | null }>(`SELECT task_id AS taskId,
      CASE WHEN json_valid(extra_fields_json) THEN COALESCE(
        CAST(json_extract(extra_fields_json, '$.AnkiNoteId') AS TEXT),
        json_extract(extra_fields_json, '$._note_key')) END AS noteKey
      FROM anki_cards WHERE id = ?1`, [state.ankiCardId]);
  } catch (e) { throw appError('Database', `读取兄弟卡笔记失败: ${errorText(e)}`); }
  if (!note || note.noteKey === null) return [];
  let siblings: { id: string }[];
  try {
    siblings = db.all<{ id: string }>(`SELECT s.id AS id FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      WHERE a.task_id = ?1 AND s.id != ?2 AND s.deleted_at IS NULL AND a.deleted_at IS NULL
        AND s.suspended = 0 AND (s.buried_until_ms IS NULL OR s.buried_until_ms < ?3)
        AND ((s.state = 0 AND ?4) OR (s.state = 2 AND ?5))
        AND json_valid(a.extra_fields_json)
        AND COALESCE(CAST(json_extract(a.extra_fields_json, '$.AnkiNoteId') AS TEXT),
                     json_extract(a.extra_fields_json, '$._note_key')) = ?6`,
    [note.taskId, state.id, nextDayStart, buryNew ? 1 : 0, buryReview ? 1 : 0, note.noteKey]);
  } catch (e) { throw appError('Database', `查询兄弟卡失败: ${errorText(e)}`); }
  const ids = siblings.map(row => String(row.id));
  for (const id of ids) {
    try {
      db.run(`UPDATE fsrs_card_states SET buried_until_ms = ?1, updated_at = ?2,
        local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3`, [nextDayStart, nowRfc, id]);
    } catch (e) { throw appError('Database', `埋藏兄弟卡失败: ${errorText(e)}`); }
  }
  return ids;
}

export function updateBuried(db: SqlExecutor, stateId: string, until: number | null, nowRfc: string): void {
  try {
    db.run(`UPDATE fsrs_card_states SET buried_until_ms = ?1, updated_at = ?2,
      local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL`,
    [until, nowRfc, stateId]);
  } catch (e) { throw appError('Database', `更新埋藏状态失败: ${errorText(e)}`); }
}

export function updateSuspended(db: SqlExecutor, stateId: string, suspended: boolean, expected: boolean, nowRfc: string): number {
  try {
    return db.run(`UPDATE fsrs_card_states SET suspended = ?1, updated_at = ?2,
      local_version = COALESCE(local_version, 0) + 1
      WHERE id = ?3 AND deleted_at IS NULL AND suspended = ?4`,
    [suspended ? 1 : 0, nowRfc, stateId, expected ? 1 : 0]).changes;
  } catch (e) { throw appError('Database', `更新卡片暂停状态失败: ${errorText(e)}`); }
}

// ---- outbox / feedback ----

export function pendingMasteryReviews(db: SqlExecutor, limit: number): FsrsPendingMasteryReview[] {
  try {
    return db.all<{ logId: string; ankiCardId: string; rating: number; revert: number }>(
      `SELECT id AS logId, anki_card_id AS ankiCardId, rating AS rating, mastery_revert_pending AS revert
       FROM fsrs_review_logs
       WHERE (mastery_synced_at IS NULL AND deleted_at IS NULL) OR mastery_revert_pending = 1
       ORDER BY created_at ASC, id ASC LIMIT ?1`, [limit]).map(row => ({
      logId: String(row.logId), ankiCardId: String(row.ankiCardId),
      rating: Number(row.rating), revert: Number(row.revert) !== 0,
    }));
  } catch (e) { throw appError('Database', errorText(e)); }
}

export function markMasterySynced(db: SqlExecutor, logId: string, now: string): void {
  try {
    db.run('UPDATE fsrs_review_logs SET mastery_synced_at = ?2, mastery_revert_pending = 0 WHERE id = ?1', [logId, now]);
  } catch (e) { throw appError('Database', errorText(e)); }
}

export function listFeedbackRows(db: SqlExecutor, limit: number): FsrsFeedbackRow[] {
  try {
    return db.all<Row>(`SELECT s.anki_card_id AS ankiCardId, COALESCE(a.front, '') AS front,
      a.template_id AS templateId, COALESCE(a.tags_json, '[]') AS tagsJson,
      s.state AS state, s.stability AS stability, s.lapses AS lapses, s.reps AS reps,
      s.due_ms AS dueMs, s.last_review_ms AS lastReviewMs
      FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0
      ORDER BY s.lapses DESC, s.due_ms ASC LIMIT ?1`, [limit]).map(row => ({
      ankiCardId: String(row.ankiCardId), front: row.front === null ? '' : String(row.front),
      templateId: row.templateId === null ? null : String(row.templateId),
      tags: parseJsonArray(row.tagsJson === null ? null : String(row.tagsJson)),
      state: Number(row.state),
      stability: row.stability === null ? null : Number(row.stability),
      lapses: Number(row.lapses), reps: Number(row.reps), dueMs: Number(row.dueMs),
      lastReviewMs: row.lastReviewMs === null ? null : Number(row.lastReviewMs),
    }));
  } catch (e) { throw appError('Database', `执行反馈回流查询失败: ${errorText(e)}`); }
}

// ---- 历史重算 ----

export interface ReviewHistoryRow {
  cardStateId: string; rating: number; reviewMs: number; stateBefore: number;
  stabilityBefore: number | null; difficultyBefore: number | null;
  elapsedDays: number | null; snapshotJson: string | null;
}
export function reviewHistoryRows(db: SqlExecutor): ReviewHistoryRow[] {
  try {
    return db.all<ReviewHistoryRow>(`SELECT l.card_state_id AS cardStateId, l.rating AS rating,
      l.review_ms AS reviewMs, l.state_before AS stateBefore, l.stability_before AS stabilityBefore,
      l.difficulty_before AS difficultyBefore, l.elapsed_days AS elapsedDays, l.state_before_json AS snapshotJson
      FROM fsrs_review_logs l
      INNER JOIN fsrs_card_states s ON s.id = l.card_state_id
      INNER JOIN anki_cards a ON a.id = l.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE l.deleted_at IS NULL AND s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0
      ORDER BY l.card_state_id, l.review_ms ASC, l.created_at ASC, l.id ASC`).map(row => ({
      cardStateId: String(row.cardStateId), rating: Number(row.rating), reviewMs: Number(row.reviewMs),
      stateBefore: Number(row.stateBefore),
      stabilityBefore: row.stabilityBefore === null ? null : Number(row.stabilityBefore),
      difficultyBefore: row.difficultyBefore === null ? null : Number(row.difficultyBefore),
      elapsedDays: row.elapsedDays === null ? null : Number(row.elapsedDays),
      snapshotJson: row.snapshotJson === null ? null : String(row.snapshotJson),
    }));
  } catch (e) { throw appError('Database', `查询复习历史失败: ${errorText(e)}`); }
}

export function updateMemoryState(db: SqlExecutor, stateId: string, stability: number, difficulty: number, now: string): number {
  try {
    return db.run(`UPDATE fsrs_card_states SET stability = ?1, difficulty = ?2, updated_at = ?3,
      local_version = COALESCE(local_version, 0) + 1
      WHERE id = ?4 AND deleted_at IS NULL AND state != 0
        AND (stability IS NULL OR difficulty IS NULL OR ABS(stability - ?1) > 1e-6 OR ABS(difficulty - ?2) > 1e-6)`,
    [stability, difficulty, now, stateId]).changes;
  } catch (e) { throw appError('Database', `写入重算记忆状态失败: ${errorText(e)}`); }
}

export function memoryStateVersion(db: SqlExecutor): string | null {
  try {
    const row = db.get<{ version: string | null }>(`SELECT CASE WHEN json_valid(config_json)
      THEN json_extract(config_json, '$.memory_state_version') END AS version
      FROM anki_decks WHERE id = ?1 AND deleted_at IS NULL`, [DEFAULT_DECK_ID]);
    return row?.version === null || row?.version === undefined ? null : String(row.version);
  } catch (e) { throw appError('Database', `读取记忆状态版本失败: ${errorText(e)}`); }
}

// ---- 重置 ----

export function deleteProgress(db: SqlExecutor, stateId: string): number {
  try {
    const logs = db.run('DELETE FROM fsrs_review_logs WHERE card_state_id = ?1', [stateId]).changes;
    db.run('DELETE FROM fsrs_card_states WHERE id = ?1', [stateId]);
    return logs;
  } catch (e) { throw appError('Database', `清理复习日志失败: ${errorText(e)}`); }
}

export function insertFreshState(
  db: SqlExecutor, ankiCardId: string, deckId: string, dueMs: number,
  desiredRetention: number, nowRfc: string,
): string {
  const id = globalThis.crypto.randomUUID();
  try {
    db.run(`INSERT INTO fsrs_card_states (
      id, anki_card_id, deck_id, state, stability, difficulty, elapsed_days, scheduled_days,
      reps, lapses, due_ms, last_review_ms, suspended, fsrs_params_version, desired_retention,
      created_at, updated_at) VALUES (?1, ?2, ?3, 0, NULL, NULL, 0, 0, 0, 0, ?4, NULL, 0, ?5, ?6, ?7, ?7)`,
    [id, ankiCardId, deckId, dueMs, FSRS_PARAMS_VERSION, desiredRetention, nowRfc]);
  } catch (e) { throw appError('Database', `重建卡片调度状态失败: ${errorText(e)}`); }
  return id;
}

// ---- Agent 状态 ----

export interface AgentStateRecord { state: FsrsCardState; reviewVersion: bigint }
export interface AgentLogRecord {
  logId: string; ankiCardId: string; rating: number; reviewMs: number;
  snapshotJson: string | null; updatedAt: string | null;
}

/**
 * Rust reads `local_version` with `row.get::<i64>`: a non-INTEGER cell is an error.
 * Keep the full INTEGER range exact for owner reads, comparisons and SQL bindings (D3).
 */
function exactReviewVersion(row: Row): bigint {
  if (row.reviewVersionType !== 'integer') {
    throw new Error(`local_version has SQLite type ${String(row.reviewVersionType)}, expected integer`);
  }
  return BigInt(String(row.reviewVersionText));
}

export function loadAgentStateRecord(db: SqlExecutor, ankiCardId: string): AgentStateRecord | null {
  try {
    const row = db.get<Row>(`SELECT ${STATE_COLUMNS},
      typeof(COALESCE(s.local_version, 0)) AS reviewVersionType,
      CAST(COALESCE(s.local_version, 0) AS TEXT) AS reviewVersionText
      FROM fsrs_card_states s
      INNER JOIN anki_cards ac ON ac.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = ac.task_id
      WHERE s.anki_card_id = ?1 AND s.deleted_at IS NULL AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL`, [ankiCardId]);
    return row ? { state: mapStateRow(row), reviewVersion: exactReviewVersion(row) } : null;
  } catch (e) { throw appError('Database', `加载 Agent FSRS 状态失败: ${errorText(e)}`); }
}

export function loadLatestAgentReview(db: SqlExecutor, stateId: string, trialV7 = false): AgentLogRecord | null {
  try {
    const row = db.get<AgentLogRecord>(`SELECT id AS logId, anki_card_id AS ankiCardId, rating,
      review_ms AS reviewMs, state_before_json AS snapshotJson, updated_at AS updatedAt
      FROM fsrs_review_logs WHERE card_state_id = ?1 AND deleted_at IS NULL
      ORDER BY review_ms DESC, created_at DESC, ${trialV7 ? 'rowid' : 'id'} DESC LIMIT 1`, [stateId]);
    return row ? {
      logId: String(row.logId), ankiCardId: String(row.ankiCardId), rating: Number(row.rating),
      reviewMs: Number(row.reviewMs),
      snapshotJson: row.snapshotJson === null ? null : String(row.snapshotJson),
      updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
    } : null;
  } catch (e) { throw appError('Database', `加载 Agent 最新复习日志失败: ${errorText(e)}`); }
}

export function buildAgentSnapshot(
  record: AgentStateRecord, isErrorCard: boolean, latest: AgentLogRecord | null,
): FsrsAgentReviewStateSnapshot {
  let latestReview: FsrsAgentLatestReviewSnapshot | null = null;
  if (latest) {
    let valid = false;
    if (latest.snapshotJson !== null) {
      const snapshot = decodeStateBeforeSnapshot(latest.snapshotJson);
      valid = snapshot !== null && validateSnapshotFor(snapshot, record.state);
    }
    latestReview = {
      logId: latest.logId, rating: latest.rating, reviewMs: latest.reviewMs,
      undoable: !isErrorCard && latest.ankiCardId === record.state.ankiCardId
        && record.state.lastReviewMs === latest.reviewMs
        && latest.updatedAt === record.state.updatedAt && valid,
    };
  }
  return {
    ankiCardId: record.state.ankiCardId, cardStateId: record.state.id,
    state: record.state.state, suspended: record.state.suspended, dueMs: record.state.dueMs,
    lastReviewMs: record.state.lastReviewMs, reviewVersion: record.reviewVersion,
    latestReview,
  };
}


export function updateAgentSuspended(
  db: SqlExecutor, stateId: string, ankiCardId: string, expectedVersion: bigint,
  currentSuspended: boolean, suspended: boolean, nowRfc: string,
): number {
  try {
    return db.run(`UPDATE fsrs_card_states SET suspended = ?1, updated_at = ?2,
      local_version = COALESCE(local_version, 0) + 1
      WHERE id = ?3 AND anki_card_id = ?4 AND COALESCE(local_version, 0) = ?5
        AND suspended = ?6 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
          WHERE ac.id = fsrs_card_states.anki_card_id AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL)`,
    [suspended ? 1 : 0, nowRfc, stateId, ankiCardId, expectedVersion, currentSuspended ? 1 : 0]).changes;
  } catch (e) { throw appError('Database', `更新 Agent 卡片暂停状态失败: ${errorText(e)}`); }
}

export function restoreAgentState(
  db: SqlExecutor, stateId: string, ankiCardId: string, expectedVersion: bigint,
  snapshot: FsrsStateBeforeSnapshot, reviewMs: number, expectedUpdatedAt: string, nowRfc: string,
): number {
  try {
    return db.run(`UPDATE fsrs_card_states SET deck_id = ?1, state = ?2, stability = ?3,
      difficulty = ?4, elapsed_days = ?5, scheduled_days = ?6, reps = ?7, lapses = ?8,
      due_ms = ?9, last_review_ms = ?10, suspended = ?11, fsrs_params_version = ?12,
      desired_retention = ?13, leech = ?20, buried_until_ms = ?21, learning_step = ?22,
      updated_at = ?14, local_version = COALESCE(local_version, 0) + 1
      WHERE id = ?15 AND anki_card_id = ?16 AND COALESCE(local_version, 0) = ?17
        AND last_review_ms = ?18 AND updated_at = ?19 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
          WHERE ac.id = fsrs_card_states.anki_card_id AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL)`,
    [snapshot.deckId, snapshot.state, snapshot.stability, snapshot.difficulty,
      snapshot.elapsedDays, snapshot.scheduledDays, snapshot.reps, snapshot.lapses,
      snapshot.dueMs, snapshot.lastReviewMs, snapshot.suspended ? 1 : 0,
      snapshot.fsrsParamsVersion, snapshot.desiredRetention, nowRfc, stateId, ankiCardId,
      expectedVersion, reviewMs, expectedUpdatedAt, snapshot.leech ? 1 : 0,
      snapshot.buriedUntilMs, snapshot.learningStep]).changes;
  } catch (e) { throw appError('Database', `恢复 Agent FSRS 卡片状态失败: ${errorText(e)}`); }
}

export function softDeleteAgentLog(
  db: SqlExecutor, logId: string, stateId: string, ankiCardId: string,
  expectedUpdatedAt: string, nowRfc: string,
): number {
  try {
    return db.run(`UPDATE fsrs_review_logs SET deleted_at = ?1, updated_at = ?1,
      local_version = COALESCE(local_version, 0) + 1, mastery_revert_pending = 1
      WHERE id = ?2 AND card_state_id = ?3 AND anki_card_id = ?4 AND updated_at = ?5 AND deleted_at IS NULL`,
    [nowRfc, logId, stateId, ankiCardId, expectedUpdatedAt]).changes;
  } catch (e) { throw appError('Database', `软删除 Agent 复习日志失败: ${errorText(e)}`); }
}

export function cardTags(db: SqlExecutor, ankiCardId: string): string[] {
  try {
    const row = db.get<{ tagsJson: string | null }>('SELECT tags_json AS tagsJson FROM anki_cards WHERE id = ?1 AND deleted_at IS NULL', [ankiCardId]);
    if (!row) return [];
    return parseJsonArray(row.tagsJson === null ? null : String(row.tagsJson));
  } catch (e) { throw appError('Database', `查询卡片 tags 失败: ${errorText(e)}`); }
}

export function cardDocumentName(db: SqlExecutor, ankiCardId: string): string | null {
  try {
    const row = db.get<{ name: string | null }>(`SELECT dt.original_document_name AS name FROM anki_cards c
      JOIN document_tasks dt ON dt.id = c.task_id WHERE c.id = ?1 AND c.deleted_at IS NULL`, [ankiCardId]);
    return row?.name === null || row?.name === undefined ? null : String(row.name);
  } catch (e) { throw appError('Database', `查询卡片所属文档失败: ${errorText(e)}`); }
}

export { DEFAULT_DESIRED_RETENTION, MS_PER_DAY };


/** 删除一张或多张 Anki 卡对应的 FSRS 日志与状态（调用方事务内）。 */
export function deleteFsrsRowsForCards(db: SqlExecutor, cardIds: readonly string[]): void {
  if (cardIds.length === 0) return;
  const placeholders = cardIds.map((_, index) => `?${index + 1}`).join(', ');
  try {
    db.run(`DELETE FROM fsrs_review_logs WHERE anki_card_id IN (${placeholders})`, [...cardIds]);
    db.run(`DELETE FROM fsrs_card_states WHERE anki_card_id IN (${placeholders})`, [...cardIds]);
  } catch (e) { throw appError('Database', `清理卡片 FSRS 数据失败: ${errorText(e)}`); }
}

/** 删除一个文档任务下全部卡片的 FSRS 日志与状态（调用方事务内）。 */
export function deleteFsrsRowsForTask(db: SqlExecutor, taskId: string): void {
  try {
    db.run(`DELETE FROM fsrs_review_logs
      WHERE anki_card_id IN (SELECT id FROM anki_cards WHERE task_id = ?1)`, [taskId]);
    db.run(`DELETE FROM fsrs_card_states
      WHERE anki_card_id IN (SELECT id FROM anki_cards WHERE task_id = ?1)`, [taskId]);
  } catch (e) { throw appError('Database', `清理任务 FSRS 数据失败: ${errorText(e)}`); }
}

/** 删除一个文档会话下全部卡片的 FSRS 日志与状态（调用方事务内）。 */
export function deleteFsrsRowsForDocument(db: SqlExecutor, documentId: string): void {
  try {
    db.run(`DELETE FROM fsrs_review_logs
      WHERE anki_card_id IN (
        SELECT a.id FROM anki_cards a
        INNER JOIN document_tasks t ON t.id = a.task_id
        WHERE t.document_id = ?1)`, [documentId]);
    db.run(`DELETE FROM fsrs_card_states
      WHERE anki_card_id IN (
        SELECT a.id FROM anki_cards a
        INNER JOIN document_tasks t ON t.id = a.task_id
        WHERE t.document_id = ?1)`, [documentId]);
  } catch (e) { throw appError('Database', `清理文档会话 FSRS 数据失败: ${errorText(e)}`); }
}
