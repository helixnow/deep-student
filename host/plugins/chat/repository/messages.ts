/**
 * `chat_v2_messages` persistence. Rust source: `chat_v2/repo.rs:1268-1763`.
 * SQL stays in this repository; callers use an F3 `DatabaseHandle`.
 */
import type { ChatMessage, MessageMeta, Variant, VariantMeta, ReplaySkillPayloadSnapshot } from '../api.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { ChatV2Error } from '../src/error.ts';
import { errorText, type ChatLogger } from '../src/logger.ts';
import { databaseOperation } from './errors.ts';
import { rs, toRustJson } from '../../../platform/serde-compat/index.ts';
import { rowToBlock, type BlockRow, type StoredBlock, BLOCK_COLUMNS_QUALIFIED } from './blocks.ts';

/**
 * `util.isDeepStrictEqual` for JSON-like data (primitives by `Object.is`, arrays, and objects with the same
 * prototype and the same own enumerable keys, compared recursively).
 */
function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    if (left.length !== other.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!isDeepStrictEqual(left[index], other[index])) return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key)
    && isDeepStrictEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export const MESSAGE_COLUMNS = 'id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id, supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json';

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  block_ids_json: string;
  timestamp: number;
  persistent_stable_id: string | null;
  parent_id: string | null;
  supersedes: string | null;
  meta_json: string | null;
  attachments_json: string | null;
  active_variant_id: string | null;
  variants_json: string | null;
  shared_context_json: string | null;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return Symbol.for('invalid'); }
}

function parseOptional<T>(value: string | null): T | undefined {
  const parsed = parseJson(value);
  // These callers decode Vec/struct fields, not arbitrary Value: SQL NULL and
  // JSON null both produce None in Rust. Nested Value nulls remain untouched.
  return parsed === null || parsed === Symbol.for('invalid') ? undefined : parsed as T;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `ReplaySkillPayloadSnapshot::without_skill_contents`: skill bodies never persist. */
function normalizeReplaySnapshot(snapshot: unknown): void {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
  const value = snapshot as Record<string, unknown>;
  const fields = ['activeSkillIds', 'executionAllowedTools', 'skillDependencies', 'skillEmbeddedTools', 'mcpToolSchemas', 'selectedMcpServers'];
  for (const key of Object.keys(value)) {
    if (!fields.includes(key) || value[key] == null) { delete value[key]; continue; }
    if (key === 'executionAllowedTools') continue;
    if (Array.isArray(value[key]) && value[key].length === 0) delete value[key];
    else if (typeof value[key] === 'object' && Object.keys(value[key] as object).length === 0) delete value[key];
  }
}

/** types.rs:1098-1105 excludes private bodies but includes Some(empty execution policy). */
export function hasReplayMetadata(snapshot: ReplaySkillPayloadSnapshot): boolean {
  return (snapshot.activeSkillIds?.length ?? 0) > 0 || snapshot.executionAllowedTools != null
    || Object.keys(snapshot.skillDependencies ?? {}).length > 0
    || Object.keys(snapshot.skillEmbeddedTools ?? {}).length > 0
    || (snapshot.mcpToolSchemas?.length ?? 0) > 0 || (snapshot.selectedMcpServers?.length ?? 0) > 0;
}

/** `collapse_redundant_skill_runtime_after`: after == before persists only before. */
function normalizeRuntimePair(container: Record<string, unknown>): void {
  normalizeReplaySnapshot(container.skillRuntimeBefore);
  normalizeReplaySnapshot(container.skillRuntimeAfter);
  const before = container.skillRuntimeBefore;
  const after = container.skillRuntimeAfter;
  if (before !== undefined && after !== undefined && isDeepStrictEqual(before, after)) {
    delete container.skillRuntimeAfter;
  }
}

/** types.rs `MessageMeta` field order; every field is `Option` + `skip_serializing_if = "Option::is_none"`. */
const MESSAGE_META_FIELDS = ['modelId', 'executionSnapshot', 'canonicalContent', 'chatParams', 'sources',
  'toolResults', 'ankiCards', 'usage', 'contextSnapshot', 'skillSnapshotBefore', 'skillSnapshotAfter',
  'skillRuntimeBefore', 'skillRuntimeAfter', 'replaySource', 'responseReasoningItems', 'skillInjectionAnchors',
  'openai_responses_web_search_items', 'inboundOrigin'] as const;

/** serde struct shape: field order, JSON null → None → omitted, unknown keys dropped. */
function serdeMessageMetaShape(meta: Record<string, unknown>): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const key of MESSAGE_META_FIELDS) if (meta[key] != null) shaped[key] = meta[key];
  const plan = (shaped.executionSnapshot as { generationPlan?: Record<string, unknown> } | undefined)?.generationPlan;
  // ChatGenerationPlan.auxiliary_multimodal_config_id: skip_serializing_if = "Option::is_none".
  if (plan != null && typeof plan === 'object' && plan.auxiliaryMultimodalConfigId === null) {
    delete plan.auxiliaryMultimodalConfigId;
  }
  return shaped;
}

const noneSkipped = (schema: ReturnType<typeof rs.value>) => rs.field(rs.option(schema), { skipIf: 'none' });

/** dstu-vfs retrieval_planner.rs:154 `CapabilityState`. */
const CAPABILITY_STATE = rs.struct({
  configured: rs.bool, healthy: rs.bool, circuit_open: rs.bool, protocol_compatible: rs.bool, index_compatible: rs.bool,
  reason: rs.field(rs.option(rs.string), { skipIf: 'none' }),
}, { renameAll: 'camelCase' });
/** retrieval_planner.rs:257,264 `ActiveGenerationModel` / `GenerationRoute`. */
const ACTIVE_GENERATION_MODEL = rs.enum({ Text: null, Multimodal: null }, { renameAll: 'snake_case' });
const GENERATION_ROUTE = rs.enum({ TextModelDirect: null, MultimodalModelDirect: null,
  MultimodalObservationThenTextModel: null, OcrThenTextModel: null, TextModelWithoutImage: null, Unavailable: null },
{ renameAll: 'snake_case' });
/** types.rs:1402 `ModelExecutionSnapshot` (+ :1389 `ChatGenerationPlan`, retrieval_planner.rs:206,275). */
const MODEL_EXECUTION_SNAPSHOT = rs.struct({
  requested_model_id: rs.field(rs.option(rs.string), { skipIf: 'none' }),
  resolved_model_id: rs.string,
  resolved_model_name: rs.string,
  resolved_model_is_multimodal: rs.bool,
  capability_snapshot: rs.struct({ text_embedding: CAPABILITY_STATE, multimodal_embedding: CAPABILITY_STATE,
    text_model: CAPABILITY_STATE, multimodal_model: CAPABILITY_STATE, ocr: CAPABILITY_STATE }, { renameAll: 'camelCase' }),
  generation_plan: rs.struct({
    planner: rs.struct({ route: GENERATION_ROUTE, active_model: rs.option(ACTIVE_GENERATION_MODEL),
      fallback_from: rs.option(ACTIVE_GENERATION_MODEL), sends_original_images: rs.bool, uses_ocr: rs.bool,
      degraded: rs.bool }, { renameAll: 'camelCase' }),
    auxiliary_multimodal_config_id: rs.field(rs.option(rs.string), { skipIf: 'none' }),
    image_budget: rs.usize,
    history_image_budget: rs.usize,
  }, { renameAll: 'camelCase' }),
  execution_route: rs.field(rs.option(GENERATION_ROUTE), { skipIf: 'none' }),
  frozen_at: rs.i64,
}, { renameAll: 'camelCase' });

/**
 * types.rs:1802 `MessageMeta`. Only `executionSnapshot` is typed; a snapshot Rust could not have
 * deserialized keeps the previous verbatim write instead of failing the save.
 */
const MESSAGE_META = rs.struct(Object.fromEntries(MESSAGE_META_FIELDS.map(key => [key, key === 'executionSnapshot'
  ? noneSkipped(rs.union(MODEL_EXECUTION_SNAPSHOT, rs.value()))
  : noneSkipped(rs.value())])));

/** `MessageMeta::normalized_for_storage` (types.rs:1921-1934). */
export function normalizeMessageMeta(meta: MessageMeta): MessageMeta {
  const next = cloneJson(meta) as Record<string, unknown>;
  normalizeRuntimePair(next);
  if (Array.isArray(next.toolResults)) {
    for (const result of next.toolResults as Array<Record<string, unknown>>) {
      if (typeof result.blockId === 'string' && result.blockId !== '') {
        result.input = null;
        result.output = null;
      }
    }
  }
  return serdeMessageMetaShape(next) as MessageMeta;
}

/** `VariantMeta::normalized_for_storage` (types.rs:1465-1474). */
export function normalizeVariantMeta(meta: VariantMeta): VariantMeta {
  const next = cloneJson(meta) as Record<string, unknown>;
  normalizeRuntimePair(next);
  return next as VariantMeta;
}

export function normalizeVariant(variant: Variant): Variant {
  if (variant.meta === undefined || variant.meta === null) return variant;
  return { ...variant, meta: normalizeVariantMeta(variant.meta) };
}

function serializeMeta(message: ChatMessage): string | null {
  return message._meta === undefined || message._meta === null
    ? null
    : toRustJson(normalizeMessageMeta(message._meta), MESSAGE_META);
}

/** Rust mutates the caller's owned vector; create/update pass a normalized copy. */
export function enforceVariantsJsonSizeLimit(
  json: string, variants: Variant[], messageId: string, log?: ChatLogger,
): string {
  const warn = 64 * 1024;
  const limit = 256 * 1024;
  const size = utf8ByteLength(json);
  if (size < warn) return json;
  if (size < limit) {
    log?.warn(`[ChatV2::Repo] variants_json size ${size} bytes approaching limit (warn=${warn}, limit=${limit}, count=${variants.length}, message_id=${messageId})`);
    return json;
  }
  log?.error(`[ChatV2::Repo] variants_json size ${size} bytes exceeded hard limit ${limit} (count=${variants.length}, message_id=${messageId}); truncating oldest variants`);
  if (variants.length <= 1) {
    log?.error(`[ChatV2::Repo] cannot truncate: single variant already exceeds limit (size=${size}, message_id=${messageId})`);
    return json;
  }
  let current = json;
  while (utf8ByteLength(current) >= limit && variants.length > 1) {
    const removed = variants.shift()!;
    log?.warn(`[ChatV2::Repo] truncated oldest variant ${removed.id} (model=${removed.modelId}, message_id=${messageId})`);
    try { current = JSON.stringify(variants); }
    catch (error) {
      log?.error(`[ChatV2::Repo] re-serialize after truncation failed (message_id=${messageId}): ${errorText(error)}`);
      return current;
    }
  }
  if (utf8ByteLength(current) >= limit) {
    log?.error(`[ChatV2::Repo] variants_json still ${utf8ByteLength(current)} bytes after truncation (message_id=${messageId})`);
  }
  return current;
}

export function serializeVariants(variants: Variant[], messageId: string, log?: ChatLogger): string {
  const sanitized = variants.map(normalizeVariant);
  return enforceVariantsJsonSizeLimit(JSON.stringify(sanitized), sanitized, messageId, log);
}

export function rowToMessage(row: MessageRow, log?: ChatLogger): ChatMessage {
  const role: ChatMessage['role'] = row.role === 'assistant' ? 'assistant' : 'user';
  const parsedBlockIds = parseOptional<string[]>(row.block_ids_json);
  if (parsedBlockIds === undefined && row.block_ids_json !== null && row.block_ids_json !== '') {
    log?.warn(`[ChatV2Repo] malformed block_ids_json (message_id=${row.id}): ${row.block_ids_json}`);
  }
  const blockIds = parsedBlockIds ?? [];
  const rawMeta = parseJson(row.meta_json);
  const meta = rawMeta === null || rawMeta === Symbol.for('invalid') ? undefined : normalizeMessageMeta(rawMeta as MessageMeta);
  const attachments = parseOptional<ChatMessage['attachments']>(row.attachments_json);
  const variants = parseOptional<Variant[]>(row.variants_json)?.map(normalizeVariant);
  const sharedContext = parseOptional<ChatMessage['sharedContext']>(row.shared_context_json);
  const message: ChatMessage = {
    id: row.id,
    sessionId: row.session_id,
    role,
    blockIds,
    timestamp: row.timestamp,
  };
  if (row.persistent_stable_id !== null) message.persistentStableId = row.persistent_stable_id;
  if (row.parent_id !== null) message.parentId = row.parent_id;
  if (row.supersedes !== null) message.supersedes = row.supersedes;
  if (meta !== undefined) message._meta = meta;
  if (attachments !== undefined) message.attachments = attachments;
  if (row.active_variant_id !== null) message.activeVariantId = row.active_variant_id;
  if (variants !== undefined) message.variants = variants;
  if (sharedContext !== undefined) message.sharedContext = sharedContext;
  return message;
}

export function createMessage(db: SqlExecutor, message: ChatMessage, log?: ChatLogger): void {
  databaseOperation(() => {
    db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id, supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id, role = excluded.role, block_ids_json = excluded.block_ids_json,
        timestamp = excluded.timestamp, persistent_stable_id = excluded.persistent_stable_id,
        parent_id = excluded.parent_id, supersedes = excluded.supersedes, meta_json = excluded.meta_json,
        attachments_json = excluded.attachments_json, active_variant_id = excluded.active_variant_id,
        variants_json = excluded.variants_json, shared_context_json = excluded.shared_context_json`,
    [
      message.id, message.sessionId, message.role, JSON.stringify(message.blockIds), message.timestamp,
      message.persistentStableId ?? null, message.parentId ?? null, message.supersedes ?? null,
      serializeMeta(message),
      message.attachments === undefined || message.attachments === null ? null : JSON.stringify(message.attachments),
      message.activeVariantId ?? null,
      message.variants === undefined || message.variants === null ? null : serializeVariants(message.variants, message.id, log),
      message.sharedContext === undefined || message.sharedContext === null ? null : JSON.stringify(message.sharedContext),
    ]);
  });
}

export function getMessage(db: SqlExecutor, messageId: string): ChatMessage | null {
  return databaseOperation(() => {
    const row = db.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM chat_v2_messages WHERE id = ?1`, [messageId]);
    return row ? rowToMessage(row) : null;
  });
}

export function getSessionMessages(db: SqlExecutor, sessionId: string, log?: ChatLogger): ChatMessage[] {
  return databaseOperation(() => {
    const rows = db.all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM chat_v2_messages
      WHERE session_id = ?1 ORDER BY timestamp ASC, rowid ASC`, [sessionId]);
    return rows.flatMap(row => {
      try { return [rowToMessage(row, log)]; } catch (error) {
        log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error));
        return [];
      }
    });
  });
}

export function getSessionMessageIds(db: SqlExecutor, sessionId: string): string[] {
  return databaseOperation(() => db.all<{ id: string }>(
    'SELECT id FROM chat_v2_messages WHERE session_id = ?1 ORDER BY timestamp ASC, rowid ASC',
    [sessionId]).map(row => row.id));
}

/** Hydrate messages in the caller's order, bounded to 400 ids per query. */
export function getMessagesByIds(db: SqlExecutor, sessionId: string, messageIds: string[], log?: ChatLogger): ChatMessage[] {
  return databaseOperation(() => {
    const found = new Map<string, ChatMessage>();
    for (let offset = 0; offset < messageIds.length; offset += 400) {
      const chunk = messageIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(',');
      const rows = db.all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM chat_v2_messages
        WHERE session_id = ?1 AND id IN (${placeholders})`, [sessionId, ...chunk]);
      for (const row of rows) {
        try { found.set(row.id, rowToMessage(row, log)); } catch (error) {
          log?.warn('[ChatV2Repo] Skipping malformed history message: ' + errorText(error));
        }
      }
    }
    return messageIds.flatMap(id => {
      const message = found.get(id);
      return message ? [message] : [];
    });
  });
}

export function updateMessage(db: SqlExecutor, message: ChatMessage, log?: ChatLogger): void {
  databaseOperation(() => {
    const result = db.run(`UPDATE chat_v2_messages
      SET block_ids_json = ?2, meta_json = ?3, attachments_json = ?4, parent_id = ?5,
          supersedes = ?6, active_variant_id = ?7, variants_json = ?8, shared_context_json = ?9
      WHERE id = ?1`,
    [
      message.id, JSON.stringify(message.blockIds), serializeMeta(message),
      message.attachments === undefined || message.attachments === null ? null : JSON.stringify(message.attachments),
      message.parentId ?? null, message.supersedes ?? null, message.activeVariantId ?? null,
      message.variants === undefined || message.variants === null ? null : serializeVariants(message.variants, message.id, log),
      message.sharedContext === undefined || message.sharedContext === null ? null : JSON.stringify(message.sharedContext),
    ]);
    if (!result.changes) throw new ChatV2Error('MessageNotFound', message.id);
  });
}

export function deleteMessage(db: SqlExecutor, messageId: string): void {
  databaseOperation(() => {
    if (!db.run('DELETE FROM chat_v2_messages WHERE id = ?1', [messageId]).changes) {
      throw new ChatV2Error('MessageNotFound', messageId);
    }
  });
}

export interface MessageWindow {
  messages: ChatMessage[];
  blocks: StoredBlock[];
  total: number;
}

/** repo.rs:1477-1491: page is one-based; multiplication stays u64 before SQL binding. */
export function loadSessionMessagesPage(db: SqlExecutor, sessionId: string, page: number,
  pageSize: number, roleFilter: string | null, log?: ChatLogger): [ChatMessage[], StoredBlock[], number] {
  const offset = BigInt(Math.max(page - 1, 0)) * BigInt(pageSize);
  const result = loadSessionMessagesWindow(db, sessionId, offset, pageSize, roleFilter, log);
  return [result.messages, result.blocks, result.total];
}

/** `load_session_messages_window_with_conn` (repo.rs:1497-1579). */
export function loadSessionMessagesWindow(
  db: SqlExecutor,
  sessionId: string,
  offset: number | bigint,
  limit: number,
  roleFilter: string | null,
  log?: ChatLogger,
): MessageWindow {
  return databaseOperation(() => {
    const total = db.pluck<number>(`SELECT COUNT(*) FROM chat_v2_messages
      WHERE session_id = ?1 AND (?2 IS NULL OR role = ?2)`, [sessionId, roleFilter])!;
    const messageRows = db.all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM chat_v2_messages
      WHERE session_id = ?1 AND (?2 IS NULL OR role = ?2)
      ORDER BY timestamp ASC, rowid ASC LIMIT ?3 OFFSET ?4`,
    [sessionId, roleFilter, limit, offset]);
    const messages = messageRows.flatMap(row => {
      try { return [rowToMessage(row, log)]; } catch (error) {
        log?.warn('[ChatV2Repo] Skipping malformed paged message row: ' + errorText(error));
        return [];
      }
    });
    const blockRows = db.all<BlockRow>(`SELECT ${BLOCK_COLUMNS_QUALIFIED} FROM chat_v2_blocks b
      INNER JOIN (
        SELECT id, timestamp, rowid AS message_rowid FROM chat_v2_messages
        WHERE session_id = ?1 AND (?2 IS NULL OR role = ?2)
        ORDER BY timestamp ASC, rowid ASC LIMIT ?3 OFFSET ?4
      ) page_messages ON b.message_id = page_messages.id
      ORDER BY page_messages.timestamp ASC, page_messages.message_rowid ASC, b.block_index ASC`,
    [sessionId, roleFilter, limit, offset]);
    const blocks = blockRows.flatMap(row => {
      try { return [rowToBlock(row)]; } catch (error) {
        log?.warn('[ChatV2Repo] Skipping malformed paged block row: ' + errorText(error));
        return [];
      }
    });
    return { messages, blocks, total };
  });
}

/** `chat_v2_session_message_count` (manage_session.rs:1080-1105) with its exact error text. */
export function countSessionMessages(db: SqlExecutor, sessionId: string): number {
  try {
    return db.pluck<number>('SELECT COUNT(*) FROM chat_v2_messages WHERE session_id = ?1', [sessionId]) ?? 0;
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ChatV2Error('Database', `Failed to count messages for session ${sessionId}: ${error.message}`);
    }
    throw error;
  }
}

/** Global message summary; `MessageSummary` has no rename_all, so keys stay snake_case. */
export function messageSummary(db: SqlExecutor): {
  total_messages: number; user_messages: number; assistant_messages: number;
} {
  let counts: { total: number; user: number; assistant: number };
  try {
    counts = db.get<{ total: number; user: number; assistant: number }>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS user,
      COALESCE(SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant
    FROM chat_v2_messages`)!;
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ChatV2Error('Database', `Failed to summarize messages: ${error.message}`);
    }
    throw error;
  }
  return {
    total_messages: counts.total, user_messages: counts.user, assistant_messages: counts.assistant,
  };
}
