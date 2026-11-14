/**
 * Smart/batch writes, curation and learner-profile tool bodies — Rust
 * `src-tauri/src/chat_v2/tools/memory_executor.rs` (`execute_write_smart` .. `execute_learner_profile_update`).
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { ExecutionContext } from '../../chat/api.ts';
import type { MemoryPurpose, MemoryType } from '../api.ts';
import { localDate } from './daily-log.ts';
import { parseProfileUpdate } from './evolution.ts';
import { f32 } from './f32.ts';
import { containsSensitivePattern } from './json.ts';
import {
  LEARNER_PROFILE_MAX_CHARS, isProfileUpdateEmpty, learnerProfilePublicValue, renderLearnerProfile,
  renderedCharCount, type LearnerProfileUpdate, type WeakPoint,
} from './learner-profile.ts';
import { exportPage, exportPagination, parseBatchMoveArgs, parseTags, truncateExportContent } from './memory-executor.ts';
import { CONTENT_LIMITS } from './memory-utils.ts';
import { cryptoOf } from './crypto.ts';
import type { MemoryServiceImpl } from './service.ts';
import { withLocalizedMessage } from './tool-errors.ts';

export const MEMORY_CHANGED_EVENT = 'memory://changed';
const MEMORY_FOLDER_PATH_CHARS = 1_000;
const MEMORY_LOG_ACTIVITY_MAX_CHARS = 80;
const U32_MAX = 0xffffffff;
const TOOL_PREFIX = 'builtin-';

type Args = Record<string, unknown>;

export interface CurationEnv {
  log: { info(message: string): void; warn(message: string): void; debug(message: string): void };
  emit(event: string, payload: unknown): void;
  cancellable<T>(ctx: ExecutionContext, task: Promise<T>, message: string, label: string): Promise<T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function charLength(value: string): number {
  return Array.from(value).length;
}

/** memory_executor.rs:102 `invalid_args`. */
export function invalidArgs(field: string, zhCn: string, enUs: string): string {
  return JSON.stringify(withLocalizedMessage({ code: 'MEMORY_INVALID_ARGS', field, retryable: false },
    'chat.tools.memory.invalid_args', { field }, zhCn, enUs));
}

/** memory_executor.rs:117 `required_string` (trimmed, non-empty). */
function requiredString(args: Args, key: string): string {
  const value = asStr(args[key])?.trim();
  if (value === undefined || value === '') {
    throw new Error(invalidArgs(key, `缺少必需参数 ${key}`, `Required parameter ${key} is missing.`));
  }
  return value;
}

/** memory_executor.rs:132 `required_string_allow_empty`. */
function requiredStringAllowEmpty(args: Args, key: string): string {
  const value = asStr(args[key]);
  if (value === null) throw new Error(invalidArgs(key, `参数 ${key} 必须是字符串`, `Parameter ${key} must be a string.`));
  return value.trim();
}

/** memory_executor.rs:86 `parse_memory_type` (exact, case-sensitive). */
function parseToolMemoryType(raw: unknown, fallback: MemoryType): MemoryType {
  const value = asStr(raw);
  if (value === null) return fallback;
  if (value === 'fact' || value === 'study' || value === 'note') return value;
  throw new Error(`Invalid memory_type '${value}': expected fact, study, or note`);
}

/** `MemoryPurpose::from_str` (unknown → memorized). */
function parseToolPurpose(raw: unknown): MemoryPurpose | null {
  const value = asStr(raw);
  if (value === null) return null;
  const lower = value.toLowerCase();
  return lower === 'internalized' || lower === 'supplementary' || lower === 'systemic' ? lower : 'memorized';
}

/** memory_executor.rs:2044 `resolve_idempotency_key`. */
function resolveIdempotencyKey(service: MemoryServiceImpl, callArgs: Args, ctx: ExecutionContext,
  folder: string | null, title: string, content: string, memoryType: MemoryType, purpose: MemoryPurpose | null): string {
  const raw = Object.hasOwn(callArgs, 'idempotency_key') ? callArgs.idempotency_key : callArgs.idempotencyKey;
  const explicit = asStr(raw);
  if (explicit !== null && rustTrim(explicit) !== '') return rustTrim(explicit);
  const digest = cryptoOf(service.hostContext).sha256HexSync(
    idempotencyDigestInput(folder, title, content, memoryType, purpose));
  return `mem:${ctx.session_id}:${ctx.message_id}:${digest}`;
}

/** The `format!("{}|{}|{}|{}|{}", …)` text hashed by `resolve_idempotency_key` (Rust `str::trim` / `to_lowercase`). */
export function idempotencyDigestInput(folder: string | null, title: string, content: string,
  memoryType: MemoryType, purpose: MemoryPurpose | null): string {
  return [rustTrim(folder ?? '').toLowerCase(), rustTrim(title).toLowerCase(),
    rustTrim(content).toLowerCase(), memoryType, purpose ?? ''].join('|');
}

function refsOf(tags: readonly string[]): string[] {
  return tags.filter(tag => tag.startsWith('_ref:')).map(tag => tag.slice('_ref:'.length));
}

/** memory_executor.rs:356 `current_note_state`. */
function currentNoteState(service: MemoryServiceImpl, noteId: string): unknown {
  try {
    const note = service.read(noteId);
    if (note === null) return null;
    const [content, contentTruncated] = truncateExportContent(note.content);
    return { note_id: note.noteId, title: note.title, content, content_truncated: contentTruncated,
      folder_path: note.folderPath, tags: service.getTags(noteId), updated_at: note.updatedAt };
  } catch {
    return null;
  }
}

type VfsErrorKind = 'conflict' | 'not_found' | 'other';

/** VfsError variant of a thrown memory/VFS error (`VfsRepositoryError.code` or the Rust Display prefix). */
function vfsErrorKind(error: unknown): VfsErrorKind {
  const code = isRecord(error) ? error.code : undefined;
  const message = errorText(error);
  if (code === 'VFS_CONFLICT' || message.startsWith('CONFLICT(')) return 'conflict';
  if (code === 'VFS_NOT_FOUND' || /^[A-Za-z]+ not found: /.test(message)) return 'not_found';
  return 'other';
}

/** memory_executor.rs:378 `service_error`. */
function serviceError(service: MemoryServiceImpl, action: string, noteIds: readonly string[], error: unknown): string {
  const kind = vfsErrorKind(error);
  if (kind === 'other') {
    return JSON.stringify(withLocalizedMessage({ code: 'MEMORY_OPERATION_FAILED', action, details: errorText(error),
      retryable: false }, 'chat.tools.memory.operation_failed', { action }, '记忆操作失败', 'The memory operation failed.'));
  }
  const current = noteIds.map(noteId => currentNoteState(service, noteId));
  if (kind === 'conflict') {
    return JSON.stringify(withLocalizedMessage({ code: 'MEMORY_CONFLICT', action, current, retryable: false,
      hint: '重新读取记忆并使用返回的 updated_at；不要盲目重试 / Read the memories again and use their returned updated_at values; do not retry blindly.',
    }, 'chat.tools.memory.conflict', { action }, '记忆已被其他操作更新，请读取当前值后再重试',
    'The memory changed elsewhere. Read its current value before retrying.'));
  }
  return JSON.stringify(withLocalizedMessage({ code: 'MEMORY_NOT_FOUND', action, current, retryable: false },
    'chat.tools.memory.not_found', { action }, '未找到指定记忆，或该笔记不在记忆根目录内',
    'The requested memory was not found or is outside the memory root.'));
}

function serviceCall<T>(service: MemoryServiceImpl, action: string, noteIds: readonly string[], run: () => T): T {
  try { return run(); }
  catch (error) { throw new Error(serviceError(service, action, noteIds, error)); }
}

/** memory_executor.rs:432 `emit_memory_changed` (no window ⇒ nothing to emit to). */
function emitMemoryChanged(env: CurationEnv, ctx: ExecutionContext, action: string, noteIds: readonly string[]): void {
  if (ctx.tryWindow() === null) {
    env.log.debug('[MemoryToolExecutor] Failed to emit memory://changed: no window');
    return;
  }
  env.emit(MEMORY_CHANGED_EVENT, { source: 'agent', action, entityIds: [...noteIds], runId: ctx.runId() });
}

function filteredOutput(reason: string): Record<string, unknown> {
  return { note_id: '', event: 'FILTERED', is_new: false, confidence: 1, reason, downgraded: false };
}

function auditFiltered(service: MemoryServiceImpl, title: string, content: string, reason: string): void {
  service.audit({ source: 'tool_call', operation: 'write_smart', success: false, title, contentPreview: content,
    event: 'FILTERED', reason, durationMs: 0 });
}

/** memory_executor.rs:1027 `execute_write_smart`. */
export async function writeSmart(args: Args, service: MemoryServiceImpl, ctx: ExecutionContext,
  env: CurationEnv): Promise<unknown> {
  const title = asStr(args.title);
  if (title === null) throw new Error("Missing 'title' parameter");
  const content = asStr(args.content);
  if (content === null) throw new Error("Missing 'content' parameter");
  const folder = asStr(args.folder);
  const memoryType = parseToolMemoryType(args.memory_type, 'fact');
  const purpose = parseToolPurpose(args.memory_purpose);
  if (containsSensitivePattern(content) || containsSensitivePattern(title)) {
    auditFiltered(service, title, content, '包含敏感信息（手机号/身份证/银行卡/邮箱/密码）');
    return filteredOutput('内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。请勿在记忆中存储个人敏感信息。');
  }
  const maxChars = CONTENT_LIMITS[memoryType];
  if (charLength(content) > maxChars) {
    auditFiltered(service, title, content, `内容超过 ${maxChars} 字限制（类型: ${memoryType}）`);
    const hint = memoryType === 'fact'
      ? `原子事实记忆内容过长（超过 ${maxChars} 字）。请拆分为多条简短事实，或使用 memory_type='study' / 'note'。`
      : memoryType === 'study'
        ? `学习记忆内容过长（超过 ${maxChars} 字）。请精简或拆分为多条。`
        : `经验笔记内容过长（超过 ${maxChars} 字）。请精简内容。`;
    return filteredOutput(hint);
  }
  const key = resolveIdempotencyKey(service, args, ctx, folder, title, content, memoryType, purpose);
  const result = await env.cancellable(ctx,
    service.writeSmart(folder, title, content, memoryType, purpose, key, 'tool_call', ctx.session_id),
    'Memory write_smart cancelled during execution', 'write_smart');
  if (result.event !== 'NONE' && result.event !== 'FILTERED') void service.spawnPostWriteMaintenance();
  return { note_id: result.noteId, event: result.event, is_new: result.isNew, confidence: f32(result.confidence),
    reason: result.reason, downgraded: result.downgraded };
}

const MEMORY_WRITE_BATCH_CONCURRENCY = 4;

function throwIfBatchCancelled(ctx: ExecutionContext): void {
  if (ctx.isCancelled() || ctx.cancellation_token?.aborted === true) {
    throw new Error('Memory write_batch cancelled during execution');
  }
}

async function raceBatchCancellation<T>(ctx: ExecutionContext, task: Promise<T>): Promise<T> {
  const signal = ctx.cancellation_token;
  if (signal === null || signal === undefined) return task;
  task.catch(error => { void error; });
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new Error('Memory write_batch cancelled during execution'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** memory_executor.rs:1187 `execute_write_batch`. */
export async function writeBatch(args: Args, service: MemoryServiceImpl, ctx: ExecutionContext): Promise<unknown> {
  const items = args.items;
  if (!Array.isArray(items)) throw new Error("Missing 'items' parameter");
  throwIfBatchCancelled(ctx);
  const defaultFolder = asStr(args.folder);
  const defaultType = parseToolMemoryType(args.memory_type, 'study');
  const defaultPurpose = parseToolPurpose(args.memory_purpose);
  const prepared = items.map((item, index) => {
    const entry = isRecord(item) ? item : {};
    const title = asStr(entry.title);
    if (title === null) throw new Error("Each batch item requires 'title'");
    const content = asStr(entry.content);
    if (content === null) throw new Error("Each batch item requires 'content'");
    const folder = asStr(entry.folder !== undefined ? entry.folder : entry.folder_path) ?? defaultFolder;
    const memoryType = parseToolMemoryType(entry.memory_type, defaultType);
    const purpose = parseToolPurpose(entry.memory_purpose) ?? defaultPurpose;
    const key = asStr(entry.idempotency_key)
      ?? `${ctx.message_id}:${index}:${resolveIdempotencyKey(service, args, ctx, folder, title, content, memoryType, purpose)}`;
    return { index, title, content, folder, memoryType, purpose, key };
  });

  type WriteOutput = ReturnType<MemoryServiceImpl['writeExplicit']>;
  const outcomes = new Array<{ title: string; output: WriteOutput } | undefined>(prepared.length);
  const workerCount = Math.min(MEMORY_WRITE_BATCH_CONCURRENCY, prepared.length);
  let cursor = 0;
  let aborted = false;

  const runWorker = async (): Promise<void> => {
    while (!aborted) {
      if (ctx.isCancelled() || ctx.cancellation_token?.aborted === true) {
        aborted = true;
        throw new Error('Memory write_batch cancelled during execution');
      }
      const nextIndex = cursor;
      cursor += 1;
      if (nextIndex >= prepared.length) return;
      const item = prepared[nextIndex]!;
      const output = item.memoryType === 'fact'
        ? await service.writeSmart(item.folder, item.title, item.content, item.memoryType, item.purpose, item.key, 'tool_call', ctx.session_id)
        : service.writeExplicit(item.folder, item.title, item.content, item.memoryType, item.purpose);
      outcomes[item.index] = { title: item.title, output };
    }
  };

  if (workerCount > 0) {
    try {
      await raceBatchCancellation(
        ctx,
        Promise.all(Array.from({ length: workerCount }, () => runWorker())),
      );
    } catch (error) {
      aborted = true;
      throw error;
    }
  }

  let added = 0; let updated = 0; let skipped = 0; let filtered = 0;
  const results: unknown[] = [];
  const resourceIds: string[] = [];
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    const { title, output } = outcome;
    if (output.event === 'ADD') added += 1;
    else if (output.event === 'UPDATE' || output.event === 'APPEND' || output.event === 'DELETE') updated += 1;
    else if (output.event === 'FILTERED') filtered += 1;
    else skipped += 1;
    if (output.resourceId !== null && output.resourceId !== undefined) resourceIds.push(output.resourceId);
    results.push({ title, note_id: output.noteId, event: output.event, is_new: output.isNew,
      confidence: f32(output.confidence), reason: output.reason, downgraded: output.downgraded });
  }
  if (added + updated > 0) {
    for (const resourceId of resourceIds) void service.triggerImmediateIndex(resourceId);
    void service.spawnPostWriteMaintenance();
  }
  return { total: items.length, succeeded: added + updated, failed: filtered, added, updated, skipped, filtered, results };
}

/** memory_executor.rs:1330 `execute_batch_move`. */
export async function batchMove(args: Args, service: MemoryServiceImpl, ctx: ExecutionContext,
  env: CurationEnv): Promise<unknown> {
  const expectedVersions = parseBatchMoveArgs(args);
  const target = requiredStringAllowEmpty(args, 'target_folder_path');
  if (charLength(target) > MEMORY_FOLDER_PATH_CHARS) {
    throw new Error(invalidArgs('target_folder_path', `目标文件夹路径最多允许 ${MEMORY_FOLDER_PATH_CHARS} 个字符`,
      `target_folder_path may contain at most ${MEMORY_FOLDER_PATH_CHARS} characters.`));
  }
  const total = expectedVersions.length;
  const succeededIds: string[] = [];
  const results: Record<string, unknown>[] = [];
  const undo: unknown[] = [];
  let cancelled = false;
  for (const [noteId, expected] of expectedVersions) {
    if (ctx.cancellation_token?.aborted === true) { cancelled = true; break; }
    try {
      const [moved, previousFolderPath] = service.moveToFolderWithOcc(noteId, expected, target, 'tool_call', ctx.session_id);
      succeededIds.push(noteId);
      undo.push({ tool: `${TOOL_PREFIX}memory_batch_move`, note_ids: [noteId], target_folder_path: previousFolderPath,
        expected_updated_at_by_id: { [noteId]: moved.updatedAt } });
      results.push({ success: true, note_id: noteId, previous_folder_path: previousFolderPath, folder_path: target,
        updated_at: moved.updatedAt });
    } catch (error) {
      const structured = serviceError(service, 'batch_move', [noteId], error);
      let errorValue: unknown;
      try { errorValue = JSON.parse(structured); }
      catch { errorValue = { message: structured }; }
      results.push({ success: false, note_id: noteId, error: errorValue });
    }
  }
  const failed = results.filter(item => item.success === false).length;
  if (succeededIds.length > 0) {
    emitMemoryChanged(env, ctx, 'batch_move', succeededIds);
    void service.spawnPostWriteMaintenance();
  }
  const succeeded = succeededIds.length;
  const processed = results.length;
  return withLocalizedMessage({
    success: failed === 0 && !cancelled && succeeded === total, total, processed,
    remaining: Math.max(0, total - processed), succeeded, failed, cancelled, target_folder_path: target, results,
    reversible: succeeded > 0, undo,
  }, 'chat.tools.memory.batch_move_completed', { succeeded, failed, total },
  `批量移动完成：成功 ${succeeded} 条，失败 ${failed} 条`, `Batch move completed: ${succeeded} succeeded and ${failed} failed.`);
}

/** memory_executor.rs:1460 `execute_relation`. */
export async function relation(args: Args, service: MemoryServiceImpl, ctx: ExecutionContext, env: CurationEnv,
  add: boolean): Promise<unknown> {
  const noteIdA = requiredString(args, 'note_id_a');
  const noteIdB = requiredString(args, 'note_id_b');
  if (noteIdA === noteIdB) {
    throw new Error(invalidArgs('note_id_b', '关联的两个记忆 ID 必须不同', 'The two relation endpoints must be different.'));
  }
  const expectedA = requiredString(args, 'expected_updated_at_a');
  const expectedB = requiredString(args, 'expected_updated_at_b');
  const action = add ? 'add_relation' : 'remove_relation';
  const { noteA, noteB, changed } = serviceCall(service, action, [noteIdA, noteIdB], () => (add
    ? service.addRelationWithOcc(noteIdA, expectedA, noteIdB, expectedB, 'tool_call', ctx.session_id)
    : service.removeRelationWithOcc(noteIdA, expectedA, noteIdB, expectedB, 'tool_call', ctx.session_id)));
  if (changed) emitMemoryChanged(env, ctx, action, [noteIdA, noteIdB]);
  const inverse = add ? 'memory_remove_relation' : 'memory_add_relation';
  return withLocalizedMessage({
    success: true, changed,
    note_a: { note_id: noteA.id, updated_at: noteA.updatedAt, related_note_ids: refsOf(noteA.tags) },
    note_b: { note_id: noteB.id, updated_at: noteB.updatedAt, related_note_ids: refsOf(noteB.tags) },
    reversible: changed,
    undo: changed ? { tool: `${TOOL_PREFIX}${inverse}`, note_id_a: noteIdA, note_id_b: noteIdB,
      expected_updated_at_a: noteA.updatedAt, expected_updated_at_b: noteB.updatedAt } : null,
  }, add ? 'chat.tools.memory.relation_added' : 'chat.tools.memory.relation_removed', { changed },
  add ? '记忆关联已添加' : '记忆关联已移除', add ? 'The memory relation was added.' : 'The memory relation was removed.');
}

/** memory_executor.rs:1650 `execute_update_tags`. */
export async function updateTags(args: Args, service: MemoryServiceImpl, ctx: ExecutionContext,
  env: CurationEnv): Promise<unknown> {
  const noteId = requiredString(args, 'note_id');
  const expected = requiredString(args, 'expected_updated_at');
  const tags = parseTags(args);
  const removeStale = args.remove_stale === true;
  const [previous, first] = serviceCall(service, 'update_tags', [noteId],
    () => service.updateTagsWithOcc(noteId, expected, tags, 'tool_call', ctx.session_id));
  let updated = first;
  let staleRemoved = false;
  if (removeStale && updated.tags.includes('_stale')) {
    const current = updated;
    updated = serviceCall(service, 'update_tags', [noteId], () => service.removeStaleTag(current, ctx.session_id));
    staleRemoved = true;
  }
  emitMemoryChanged(env, ctx, 'update_tags', [noteId]);
  const userTags = (values: readonly string[]) => values.filter(tag => !tag.startsWith('_'));
  return withLocalizedMessage({
    success: true, note_id: noteId, tags: updated.tags, user_tags: userTags(updated.tags), system_tags_preserved: true,
    stale_removed: staleRemoved, updated_at: updated.updatedAt, reversible: true,
    undo: { tool: `${TOOL_PREFIX}memory_update_tags`, note_id: updated.id, tags: userTags(previous.tags),
      expected_updated_at: updated.updatedAt },
  }, 'chat.tools.memory.tags_updated', { noteId: updated.id }, '记忆标签已更新', 'The memory tags were updated.');
}

/** memory_executor.rs:1755 `execute_log_activity`. */
export async function logActivity(args: Args, service: MemoryServiceImpl): Promise<unknown> {
  const activity = requiredString(args, 'activity');
  if (charLength(activity) > MEMORY_LOG_ACTIVITY_MAX_CHARS) {
    throw new Error(invalidArgs('activity',
      `activity 最多允许 ${MEMORY_LOG_ACTIVITY_MAX_CHARS} 个字符（一句话概括即可）`,
      `activity may contain at most ${MEMORY_LOG_ACTIVITY_MAX_CHARS} characters.`));
  }
  const outcome = serviceCall(service, 'log_activity', [], () => service.appendDailyLog(localDate(), activity));
  const appended = outcome.appended;
  return withLocalizedMessage({
    success: true, appended, note_id: outcome.noteId, date: localDate(), reason: outcome.reason,
  }, appended ? 'chat.tools.memory.activity_logged' : 'chat.tools.memory.activity_skipped', { appended },
  appended ? '学习活动已记入今日学习日志' : '该学习活动今日已有相同记录，已跳过',
  appended ? "The activity was appended to today's study log." : "Today's log already contains this activity; skipped.");
}

/** memory_executor.rs:1819 `execute_export_all`. */
export async function exportAll(args: Args, service: MemoryServiceImpl): Promise<unknown> {
  const [page, pageSize, offset] = exportPagination(args);
  const { items, hasMore } = serviceCall(service, 'export_all', [], () => exportPage(service, pageSize, offset));
  const returned = items.length;
  return withLocalizedMessage({
    success: true, items, page, page_size: pageSize, returned, has_more: hasMore,
    next_page: hasMore && page < U32_MAX ? page + 1 : null,
    truncated: items.some(item => item.content_truncated), content_limit_chars: 2000,
  }, 'chat.tools.memory.export_page_ready', { page, returned, hasMore },
  `记忆导出第 ${page} 页已生成，共 ${returned} 条`, `Memory export page ${page} is ready with ${returned} items.`);
}

/** memory_executor.rs:1870 `execute_learner_profile_get`. */
export async function learnerProfileGet(service: MemoryServiceImpl): Promise<unknown> {
  const profile = service.loadProfile();
  if (profile === null) {
    return { found: false,
      hint: '学习者画像尚未建立。可通过 learner_profile_update 写入首批内容，或等待系统从每日学习日志自动晋升。' };
  }
  return { found: true, version: profile.version, updated_at: profile.updated_at,
    profile: learnerProfilePublicValue(profile), rendered_markdown: renderLearnerProfile(profile) };
}

function weakPointJson(wp: WeakPoint): Record<string, unknown> {
  return { subject: wp.subject, knowledge_point: wp.knowledge_point, error_pattern: wp.error_pattern,
    evidence_count: wp.evidence_count, last_seen: wp.last_seen ?? null,
    ...(wp.source === null || wp.source === undefined ? {} : { source: wp.source }) };
}

/** `serde_json::to_string(&LearnerProfileUpdate)`. */
function profileUpdateJson(update: LearnerProfileUpdate): string {
  const preferences = update.preferences ?? null;
  return JSON.stringify({
    weak_points_add: update.weak_points_add.map(weakPointJson),
    weak_points_remove: update.weak_points_remove.map(key => ({ subject: key.subject, knowledge_point: key.knowledge_point })),
    preferences: preferences === null ? null : {
      explanation_style: preferences.explanation_style ?? null, language: preferences.language ?? null,
      pace: preferences.pace ?? null, others_add: preferences.others_add, others_remove: preferences.others_remove,
    },
    goals_add: update.goals_add.map(goal => ({ goal: goal.goal, deadline: goal.deadline ?? null })),
    goals_remove: update.goals_remove,
    recent_status: update.recent_status ?? null,
  });
}

const PROFILE_LIMIT_PREFIX = "Invalid argument 'profile': ";

/** memory_executor.rs:1913 `execute_learner_profile_update`. */
export async function learnerProfileUpdate(args: Args, service: MemoryServiceImpl,
  ctx: ExecutionContext): Promise<unknown> {
  const update = parseProfileUpdate(args);
  if (update === null) {
    throw new Error('Invalid learner_profile_update arguments: invalid type for a LearnerProfileUpdate field');
  }
  if (isProfileUpdateEmpty(update)) {
    return { success: false,
      error: '更新内容为空：请至少提供 weak_points_add / preferences / goals_add / recent_status 之一。' };
  }
  if (containsSensitivePattern(profileUpdateJson(update))) {
    return { success: false, error: '更新内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。' };
  }
  let outcome;
  try {
    outcome = service.applyProfileUpdate(update, {
      source: 'tool_call', sessionId: ctx.session_id, reason: 'learner_profile_update 工具更新', limitPolicy: 'reject',
      isCancelled: () => ctx.cancellation_token?.aborted ?? false,
    });
  } catch (error) {
    const message = errorText(error);
    if (!message.startsWith(PROFILE_LIMIT_PREFIX)) throw error;
    const reason = message.slice(PROFILE_LIMIT_PREFIX.length);
    const counted = /^合并后画像 ([0-9]+) 字符/.exec(reason);
    const renderedChars = counted === null ? LEARNER_PROFILE_MAX_CHARS + 1 : Number(counted[1]);
    let currentProfile: string | null = null;
    try {
      const profile = service.loadProfile();
      const rendered = profile === null ? null : renderLearnerProfile(profile);
      currentProfile = rendered !== null && rendered.trim() !== '' ? rendered : null;
    } catch {
      currentProfile = null;
    }
    let text = `${reason} 画像是策展层而非日志，容量不会自动扩容。请在本轮内先腾出空间再重试本次更新：`
      + '1) 用 weak_points_remove / goals_remove 移除已克服、已达成或过时的条目；'
      + '2) 合并语义重叠的条目（remove 旧条目 + add 一条更短的合并描述）；'
      + '3) 精简 recent_status 与 error_pattern 中的长描述。';
    text += currentProfile === null
      ? '\n\n当前画像内容请先调用 builtin-learner_profile_get 获取。'
      : `\n\n当前画像全文（用于决定合并/移除对象）：\n${currentProfile}`;
    return { success: false, error: text, rendered_chars: renderedChars, max_chars: LEARNER_PROFILE_MAX_CHARS,
      current_profile: currentProfile };
  }
  return { success: true, changed: outcome.changed, version: outcome.profile.version,
    rendered_chars: renderedCharCount(outcome.profile),
    reason: outcome.changed ? '画像已更新' : '更新与当前画像一致，无变更' };
}
