/**
 * 卡片库读取（`dstu-core/src/models.rs:1379-1436`、`dstu-storage/src/database/mod.rs:279-362,5330-5341`、
 * `src/cmd/enhanced_anki.rs:395-474`）：`AnkiLibraryCard` 的 JSON 形状与分页响应构造。
 */
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { decodeExtraFields, decodeJsonStringArray } from './anki-cards.ts';
import { rfc3339FromMillis } from './time.ts';

/** `AnkiLibraryCard`：`#[serde(flatten)] card` + `rename_all = "camelCase"` 的库字段。 */
export interface AnkiLibraryCard extends AnkiCard {
  sourceType: string | null;
  sourceId: string | null;
  sourceSessionId: string | null;
  sourceRef: unknown;
  stateId: string | null;
  state: number | null;
  dueMs: number | null;
  suspended: boolean;
  enqueued: boolean;
  isDue: boolean;
}

/** 卡片库读取共用的 22 列（列表查询额外读 `source_ref`，详情查询额外读 `document_id`）。 */
interface AnkiLibraryCardBaseRow {
  id: string;
  task_id: string;
  front: string | null;
  back: string | null;
  text: string | null;
  tags_json: string | null;
  images_json: string | null;
  is_error_card: number;
  error_content: string | null;
  created_at: string;
  updated_at: string;
  extra_fields_json: string | null;
  template_id: string | null;
  source_type: string | null;
  source_id: string | null;
  state_id: string | null;
  state: number | null;
  due_ms: number | null;
  suspended: number;
  enqueued: number;
  is_due: number;
  source_session_id: string | null;
}

/** `load_anki_library_card_record` 的 23 列。 */
export interface AnkiLibraryCardRow extends AnkiLibraryCardBaseRow {
  document_id: string;
}

/** `list_anki_library_cards_filtered` 的 23 列（`database/mod.rs:7904-7930`）。 */
export interface AnkiLibraryListRow extends AnkiLibraryCardBaseRow {
  source_ref_json: unknown;
}

/** `filter(|value| !value.trim().is_empty())`。 */
function nonBlank(value: string | null): string | null {
  return value !== null && value.trim() !== '' ? value : null;
}

function decodeCardFields(row: AnkiLibraryCardBaseRow, sourceRef: unknown): AnkiLibraryCard {
  return {
    front: row.front ?? '',
    back: row.back ?? '',
    text: row.text,
    tags: decodeJsonStringArray(row.tags_json),
    images: decodeJsonStringArray(row.images_json),
    id: row.id,
    task_id: row.task_id,
    is_error_card: row.is_error_card !== 0,
    error_content: row.error_content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    extra_fields: decodeExtraFields(row.extra_fields_json),
    template_id: row.template_id,
    sourceType: nonBlank(row.source_type),
    sourceId: nonBlank(row.source_id),
    sourceSessionId: nonBlank(row.source_session_id),
    sourceRef,
    stateId: row.state_id,
    state: row.state,
    dueMs: row.due_ms,
    suspended: row.suspended !== 0,
    enqueued: row.enqueued !== 0,
    isDue: row.is_due !== 0,
  };
}

/** `map_anki_library_record_row`（`database/mod.rs:279-329`）。 */
export function decodeAnkiLibraryCardRow(row: AnkiLibraryCardRow): AnkiLibraryCard {
  // 加载器不读 `anki_generation_options_json`，`source_ref` 恒为 None。
  return decodeCardFields(row, null);
}

/** `decodeAnkiLibraryListRow` 的 row mapper（`database/mod.rs:7933-7985`）。 */
export function decodeAnkiLibraryListRow(row: AnkiLibraryListRow): AnkiLibraryCard {
  let sourceRef: unknown = null;
  if (row.source_ref_json !== null && row.source_ref_json !== undefined) {
    if (typeof row.source_ref_json !== 'string') {
      throw new LibraryQueryError('database', 'source_ref 列不是文本');
    }
    try {
      sourceRef = JSON.parse(row.source_ref_json) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      sourceRef = null;
    }
  }
  return decodeCardFields(row, sourceRef);
}

/** 卡片库查询的校验 / 未找到 / 数据库错误（由命令层映射为 `AppError`）。 */
export class LibraryQueryError extends Error {
  readonly kind: 'validation' | 'not_found' | 'database';

  constructor(kind: 'validation' | 'not_found' | 'database', message: string) {
    super(message);
    this.kind = kind;
    this.name = 'LibraryQueryError';
  }
}

/** `AnkiLibraryListFilter`（`database/mod.rs:8045-8056`）。 */
export interface AnkiLibraryListFilter {
  status?: string | null;
  sort?: string | null;
  sortDesc?: boolean | null;
  deck?: string | null;
}

/** `AnkiLibraryStatusCounts`（`database/mod.rs:8071-8084`）。 */
export interface AnkiLibraryStatusCounts {
  all: number;
  due: number;
  new: number;
  learning: number;
  review: number;
  suspended: number;
  notEnqueued: number;
}

/** `AnkiLibraryDeckCount`（`database/mod.rs:8058-8069`）。 */
export interface AnkiLibraryDeckCount {
  name: string;
  all: number;
  due: number;
  new: number;
  notEnqueued: number;
}

/** `FsrsAgentLatestReviewSnapshot`（`dstu-anki/src/fsrs_review_service.rs:218-223` 的 wire 形式）。 */
export interface AgentLatestReviewSnapshot {
  logId: string;
  rating: number;
  reviewMs: number;
  undoable: boolean;
}

/** `FsrsAgentReviewStateSnapshot` 的内部形式；i64 CAS 版本保留 bigint，仅 IPC 出站转 wire。 */
export interface AgentReviewStateSnapshot {
  ankiCardId: string;
  cardStateId: string;
  state: number;
  suspended: boolean;
  dueMs: number;
  lastReviewMs: number | null;
  reviewVersion: bigint;
  latestReview: AgentLatestReviewSnapshot | null;
}

/** `FsrsCardState`（`dstu-anki/src/fsrs_review_service.rs:4719-4742` 读取的 20 列）。 */
interface FsrsCardStateRow {
  id: string;
  anki_card_id: string;
  deck_id: string | null;
  state: number;
  stability: number | null;
  difficulty: number | null;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  due_ms: number;
  last_review_ms: number | null;
  suspended: boolean;
  fsrs_params_version: string;
  desired_retention: number | null;
  created_at: string;
  updated_at: string;
  leech: boolean;
  buried_until_ms: number | null;
  learning_step: number;
}

/** `get_review_states_for_library` 的 SQL 行（STATE_COLUMNS + 联表附加列）。 */
export interface AgentReviewStateSqlRow {
  s_id: string | null;
  s_anki_card_id: string | null;
  s_deck_id: string | null;
  s_state: number | null;
  s_stability: number | null;
  s_difficulty: number | null;
  s_elapsed_days: number | null;
  s_scheduled_days: number | null;
  s_reps: number | null;
  s_lapses: number | null;
  s_due_ms: number | null;
  s_last_review_ms: number | null;
  s_suspended: number | null;
  s_fsrs_params_version: string | null;
  s_desired_retention: number | null;
  s_created_at: string | null;
  s_updated_at: string | null;
  s_leech: number;
  s_buried_until_ms: number | null;
  s_learning_step: number;
  s_local_version: string;
  s_local_version_type: string;
  ac_id: string;
  ac_is_error_card: number;
  latest_id: string | null;
  latest_anki_card_id: string | null;
  latest_rating: number | null;
  latest_review_ms: number | null;
  latest_state_before_json: string | null;
  latest_updated_at: string | null;
}

interface AgentReviewLogRow {
  log_id: string;
  anki_card_id: string;
  rating: number;
  review_ms: number;
  state_before_json: string | null;
  updated_at: string | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/** `FsrsStateBeforeSnapshot::validate_for`（`fsrs_review_service.rs:913-935`）的类型检查 + 语义校验。 */
function stateBeforeSnapshotIsValid(raw: string, state: FsrsCardStateRow): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;

  const optionalNumber = (key: string): boolean => {
    const item = snapshot[key];
    return item === undefined || item === null || isFiniteNumber(item);
  };

  const version = snapshot.snapshotVersion;
  const cardStateId = snapshot.cardStateId;
  const ankiCardId = snapshot.ankiCardId;
  const stateValue = snapshot.state;
  const elapsedDays = snapshot.elapsedDays;
  const scheduledDays = snapshot.scheduledDays;
  const reps = snapshot.reps;
  const lapses = snapshot.lapses;
  const paramsVersion = snapshot.fsrsParamsVersion;

  if (!isIntegerInRange(version, 0, 255)) return false;
  if (typeof cardStateId !== 'string') return false;
  if (typeof ankiCardId !== 'string') return false;
  if (snapshot.deckId != null && typeof snapshot.deckId !== 'string') return false;
  if (!isIntegerInRange(stateValue, -2_147_483_648, 2_147_483_647)) return false;
  if (!optionalNumber('stability')) return false;
  if (!optionalNumber('difficulty')) return false;
  if (!isFiniteNumber(elapsedDays)) return false;
  if (!isFiniteNumber(scheduledDays)) return false;
  if (!isIntegerInRange(reps, -2_147_483_648, 2_147_483_647)) return false;
  if (!isIntegerInRange(lapses, -2_147_483_648, 2_147_483_647)) return false;
  if (typeof snapshot.dueMs !== 'number' || !Number.isInteger(snapshot.dueMs)) return false;
  if (snapshot.lastReviewMs != null
    && (typeof snapshot.lastReviewMs !== 'number' || !Number.isInteger(snapshot.lastReviewMs))) return false;
  if (typeof snapshot.suspended !== 'boolean') return false;
  if (typeof paramsVersion !== 'string') return false;
  if (!optionalNumber('desiredRetention')) return false;
  if (snapshot.leech !== undefined && typeof snapshot.leech !== 'boolean') return false;
  if (snapshot.buriedUntilMs != null
    && (typeof snapshot.buriedUntilMs !== 'number' || !Number.isInteger(snapshot.buriedUntilMs))) return false;
  if (snapshot.learningStep !== undefined && !isIntegerInRange(snapshot.learningStep, 0, 4_294_967_295)) {
    return false;
  }

  return version === 1
    && cardStateId === state.id
    && ankiCardId === state.anki_card_id
    && stateValue >= 0
    && stateValue <= 3
    && (snapshot.stability == null || Number.isFinite(snapshot.stability as number))
    && (snapshot.difficulty == null || Number.isFinite(snapshot.difficulty as number))
    && elapsedDays >= 0
    && scheduledDays >= 0
    && reps >= 0
    && lapses >= 0
    && paramsVersion.trim() !== ''
    && (snapshot.desiredRetention == null || Number.isFinite(snapshot.desiredRetention as number));
}

/** `build_agent_snapshot`（`fsrs_review_service.rs:4902-4935`）。 */
function buildAgentSnapshot(
  state: FsrsCardStateRow,
  isErrorCard: boolean,
  latest: AgentReviewLogRow | null,
): AgentReviewStateSnapshot {
  const latestReview = latest === null ? null : {
    logId: latest.log_id,
    rating: latest.rating,
    reviewMs: latest.review_ms,
    undoable: !isErrorCard
      && latest.anki_card_id === state.anki_card_id
      && state.last_review_ms === latest.review_ms
      && latest.updated_at === state.updated_at
      && latest.state_before_json !== null
      && stateBeforeSnapshotIsValid(latest.state_before_json, state),
  };
  return {
    ankiCardId: state.anki_card_id,
    cardStateId: state.id,
    state: state.state,
    suspended: state.suspended,
    dueMs: state.due_ms,
    lastReviewMs: state.last_review_ms,
    reviewVersion: 0n,
    latestReview,
  };
}

/** `get_review_states_for_library` 的 row mapper（`fsrs_review_service.rs:1759-1804`）。 */
export function decodeAgentReviewStateRow(row: AgentReviewStateSqlRow): AgentReviewStateSnapshot | null {
  if (row.s_id === null || row.s_id === undefined) return null;
  const state: FsrsCardStateRow = {
    id: row.s_id,
    anki_card_id: row.s_anki_card_id!,
    deck_id: row.s_deck_id,
    state: row.s_state!,
    stability: row.s_stability,
    difficulty: row.s_difficulty,
    elapsed_days: row.s_elapsed_days!,
    scheduled_days: row.s_scheduled_days!,
    reps: row.s_reps!,
    lapses: row.s_lapses!,
    due_ms: row.s_due_ms!,
    last_review_ms: row.s_last_review_ms,
    suspended: (row.s_suspended ?? 0) !== 0,
    fsrs_params_version: row.s_fsrs_params_version!,
    desired_retention: row.s_desired_retention,
    created_at: row.s_created_at!,
    updated_at: row.s_updated_at!,
    leech: (row.s_leech ?? 0) !== 0,
    buried_until_ms: row.s_buried_until_ms,
    learning_step: row.s_learning_step ?? 0,
  };
  const latest: AgentReviewLogRow | null = row.latest_id === null ? null : {
    log_id: row.latest_id,
    anki_card_id: row.latest_anki_card_id!,
    rating: row.latest_rating!,
    review_ms: row.latest_review_ms!,
    state_before_json: row.latest_state_before_json,
    updated_at: row.latest_updated_at,
  };
  const snapshot = buildAgentSnapshot(state, row.ac_is_error_card !== 0, latest);
  if (row.s_local_version_type !== 'integer') {
    throw new Error(`local_version has SQLite type ${row.s_local_version_type}, expected integer`);
  }
  return { ...snapshot, reviewVersion: BigInt(row.s_local_version) };
}

/** Rust `Option<i64>` + 非负语义校验；旧 number 调用仍接受，CAS 比较不经过 Number。 */
export function expectedReviewVersionI64(value: number | bigint | null): bigint | null {
  if (value === null) return null;
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error('expectedReviewVersion must be a non-negative integer or null');
  }
  const exact = BigInt(value);
  if (exact < 0n || exact > 9_223_372_036_854_775_807n) {
    throw new Error('expectedReviewVersion must be a non-negative integer or null');
  }
  return exact;
}

/** `build_anki_library_list_response`（`enhanced_anki.rs:395-457`）。 */
export function buildAnkiLibraryListResponse(
  items: readonly AnkiLibraryCard[],
  page: number,
  pageSize: number,
  total: number,
  reviewStates: readonly AgentReviewStateSnapshot[],
): { items: Record<string, unknown>[]; page: number; pageSize: number; total: number } {
  const reviewsByCard = new Map<string, AgentReviewStateSnapshot>();
  for (const state of reviewStates) reviewsByCard.set(state.ankiCardId, state);

  const enriched = items.map((item) => {
    const reviewState = reviewsByCard.get(item.id);
    reviewsByCard.delete(item.id);
    const latestReview = reviewState?.latestReview ?? null;
    const value: Record<string, unknown> = { ...item };
    value.version = item.updated_at;
    value.reviewVersion = reviewState?.reviewVersion ?? null;
    value.latestReview = latestReview === null ? null : {
      logId: latestReview.logId,
      reviewedAt: rfc3339FromMillis(latestReview.reviewMs),
      rating: latestReview.rating,
      undoable: latestReview.undoable,
    };
    return value;
  });

  return { items: enriched, page, pageSize, total };
}
