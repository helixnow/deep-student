/**
 * `SessionToolExecutor` (chat_v2/tools/session_executor.rs): session list/search/get/messages/export/import,
 * group and tag management, archive/restore and batch operations against the chat_v2 database.
 */
import {
  addManualTagWithConn, archiveGroupWithConn, createBlocksBatchWithConn, createGroupWithConn,
  createMessageWithConn, createSessionWithConn, getGroupWithConn, getSessionTagsWithConn,
  getSessionWithConn, listAllTagsWithConn, listGroupsWithConn, removeTagWithConn,
  restoreGroupWithConn, searchContentWithDateRange, softDeleteGroupWithConn, updateGroupWithConn,
  updateSessionWithConn,
  type ChatExecutionContext, type ChatSession, type SessionGroup, type ToolCall, type ToolConcurrency,
  type ToolResultInfo,
} from '../../chat/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { createdEvent, noteToDstuNode } from '../../vfs/portable.ts';
import { agentOrchestrationWorkspaceRuntime } from './workspace-runtime.ts';
import type { NotesService } from '../../notes/api.ts';
import { countSessions, getSessionById, updateSessionGroup, type SessionImportRepository } from '../repository/session-tools.ts';
import { stripToolNamespace } from './automation-tool-args.ts';
import {
  batchMoveConfirmationRequired, batchOpsConfirmationRequired, batchTagConfirmationRequired, canHandleSessionTool,
  executeSessionGetMessagesWithDb, executeSessionListWithDb, hasDynamicSessionSensitivity, importSessionPayload,
  markdownExportToToolValue, optionalNonEmptyString, parseSearchDateRange, prepareSessionExportWithDb,
  requiredNonEmptyString, sessionSensitivityLevel, sessionSensitivityLevelForCall,
} from './session-tools.ts';

const LOG_PREFIX = '[SessionExecutor]';
const SESSION_MGMT_EVENT = 'session_management_change';
const MAX_BATCH_OPS_PER_CALL = 200;
const MANUALLY_ARCHIVED_BY_KEY = 'manuallyArchivedBy';
const MAX_SESSION_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_IMPORT_CONTENT_CHARS = 2_000_000;
const READ_ONLY_TOOLS = new Set(['session_list', 'session_search', 'session_get', 'session_get_messages',
  'session_stats', 'tag_list_all', 'group_list']);
const NON_WRITE_TOOLS = new Set(['session_list', 'session_search', 'session_get', 'session_get_messages',
  'session_export', 'group_list', 'tag_list_all', 'session_stats']);

type Args = Record<string, unknown>;
const errorText = (error: unknown): string => typeof error === 'string' ? error
  : error instanceof Error ? error.message : String(error);
const objectOf = (value: unknown): Args =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
const str = (args: Args, key: string): string | null => typeof args[key] === 'string' ? args[key] as string : null;
const required = (args: Args, key: string): string => {
  const value = str(args, key);
  if (value === null) throw new Error(`缺少必需参数: ${key}`);
  return value;
};
const u64 = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const debugStatus = (status: string): string => status.charAt(0).toUpperCase() + status.slice(1);
const nowRfc3339 = (): string => chronoRfc3339();

/** tool_args.rs::coerce_json_array: native array or a stringified JSON array. */
function jsonArrayArg(args: Args, key: string): unknown[] | null {
  const value = args[key];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
const stringArrayArg = (args: Args, key: string): string[] | null =>
  jsonArrayArg(args, key)?.filter((item): item is string => typeof item === 'string') ?? null;

function chatDb(ctx: ChatExecutionContext): DatabaseHandle {
  if (ctx.chat_v2_db === null) throw new Error(`${LOG_PREFIX} chat_v2_db not available in ExecutionContext`);
  return ctx.chat_v2_db.getConnSafe();
}

function ensureNotCurrentSession(sessionId: string, ctx: ChatExecutionContext, action: string): void {
  if (sessionId === ctx.session_id) throw new Error(`不能对当前正在使用的会话执行${action}`);
}

function existingSession(db: SqlExecutor, sessionId: string): ChatSession {
  const session = getSessionWithConn(db, sessionId);
  if (session === null) throw new Error(`会话不存在: ${sessionId}`);
  return session;
}

function activeGroup(db: SqlExecutor, groupId: string): SessionGroup {
  const group = getGroupWithConn(db, groupId);
  if (group === null) throw new Error(`分组不存在: ${groupId}`);
  if (group.persistStatus !== 'active') throw new Error(`分组已被删除: ${groupId}`);
  return group;
}

/** session_executor.rs:1399–1417. */
function ensureSessionGroupRestorable(db: SqlExecutor, session: ChatSession): void {
  const groupId = session.groupId ?? null;
  if (groupId === null) return;
  const group = getGroupWithConn(db, groupId);
  if (group === null) throw new Error(`会话归属课题不存在: ${groupId}`);
  if (group.persistStatus === 'archived') {
    throw new Error('该会话属于已归档课题，请先恢复整个课题，避免历史会话脱离课题分组。');
  }
  if (group.persistStatus === 'deleted') throw new Error(`会话归属课题已删除: ${groupId}`);
}

/** session_executor.rs:1419–1443. */
function manuallyArchiveSession(existing: ChatSession): ChatSession {
  const now = nowRfc3339();
  const raw = existing.metadata;
  const metadata: Args = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw as Args } : {};
  metadata[MANUALLY_ARCHIVED_BY_KEY] = { archivedAt: now };
  return { ...existing, persistStatus: 'archived', updatedAt: now, metadata };
}

function archiveSession(db: SqlExecutor, sessionId: string): ChatSession {
  const existing = existingSession(db, sessionId);
  if (existing.persistStatus !== 'active') {
    throw new Error(`只能归档活跃会话，当前状态: ${debugStatus(existing.persistStatus)}`);
  }
  const archived = manuallyArchiveSession(existing);
  updateSessionWithConn(db, archived);
  return archived;
}

function restoreSession(db: SqlExecutor, sessionId: string): ChatSession {
  const existing = existingSession(db, sessionId);
  if (existing.persistStatus === 'active') throw new Error('会话已是活跃状态，无需恢复');
  ensureSessionGroupRestorable(db, existing);
  const restored: ChatSession = { ...existing, persistStatus: 'active', updatedAt: nowRfc3339() };
  updateSessionWithConn(db, restored);
  return restored;
}

function renameSession(db: SqlExecutor, sessionId: string, title: string): void {
  updateSessionWithConn(db, { ...existingSession(db, sessionId), title, updatedAt: nowRfc3339() });
}

function sessionSearch(db: SqlExecutor, args: Args): Record<string, unknown> {
  const query = required(args, 'query');
  const limit = Math.min(u64(args.limit) ?? 20, 50);
  const { dateFrom, dateTo } = parseSearchDateRange(args);
  const results = searchContentWithDateRange(db, query, limit, dateFrom, dateTo).map(result => ({
    sessionId: result.sessionId, sessionTitle: result.sessionTitle, messageId: result.messageId,
    role: result.role, snippet: result.snippet, updatedAt: result.updatedAt,
  }));
  return { results, count: results.length, query, dateFrom, dateTo };
}

function sessionGet(db: SqlExecutor, args: Args): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  const session = getSessionById(db, sessionId);
  if (session === null) throw new Error(`会话不存在: ${sessionId}`);
  const tags = getSessionTagsWithConn(db, sessionId);
  let groupName: string | null = null;
  if (session.groupId !== null) {
    try { groupName = getGroupWithConn(db, session.groupId)?.name ?? null; } catch { groupName = null; }
  }
  return {
    id: session.id, mode: session.mode, title: session.title, description: session.description,
    persistStatus: session.persistStatus, createdAt: session.createdAt, updatedAt: session.updatedAt,
    groupId: session.groupId, groupName, tags, metadata: session.metadata ?? null,
  };
}

function systemPromptPreview(prompt: string | null | undefined): string | null {
  if (prompt === null || prompt === undefined) return null;
  const chars = Array.from(prompt);
  return chars.length > 50 ? `${chars.slice(0, 50).join('')}...` : prompt;
}

function groupList(db: SqlExecutor): Record<string, unknown> {
  const groups = listGroupsWithConn(db, 'active', null).map(group => ({
    id: group.id, name: group.name, description: group.description ?? null, icon: group.icon ?? null,
    color: group.color ?? null, sortOrder: group.sortOrder, defaultSkillIds: group.defaultSkillIds,
    defaultRuntimeRootId: group.defaultRuntimeRootId ?? null,
    preferredProjectRootPath: group.preferredProjectRootPath ?? null,
    systemPromptPreview: systemPromptPreview(group.systemPrompt),
  }));
  return { groups, count: groups.length };
}

function tagListAll(db: SqlExecutor): Record<string, unknown> {
  const tags = listAllTagsWithConn(db).map(([tag, count]) => ({ tag, count }));
  return { tags, totalTags: tags.length };
}

function sessionStats(db: SqlExecutor): Record<string, unknown> {
  const active = countSessions(db, 'active', null);
  const archived = countSessions(db, 'archived', null);
  const deleted = countSessions(db, 'deleted', null);
  const groups = listGroupsWithConn(db, 'active', null);
  const countOrZero = (groupId: string): number => { try { return countSessions(db, 'active', groupId); } catch { return 0; } };
  const ungroupedCount = countOrZero('');
  const distribution = groups.map(group => ({ groupId: group.id, groupName: group.name, sessionCount: countOrZero(group.id) }));
  const tags = listAllTagsWithConn(db);
  return {
    total: active + archived + deleted, active, archived, deleted,
    groups: { count: groups.length, distribution, ungroupedCount },
    tags: { uniqueCount: tags.length, top10: tags.slice(0, 10).map(([tag, count]) => ({ tag, count })) },
  };
}

function notesService(ctx: ChatExecutionContext): NotesService | null {
  try { return (ctx.services.get('notes') as NotesService | undefined) ?? null; } catch { return null; }
}

function emitWatchEvent(ctx: ChatExecutionContext, event: { type: string; path: string; node?: unknown }): void {
  const window = ctx.tryWindow();
  if (window === null) return;
  const target = { kind: 'Window' as const, label: window.window };
  ctx.services.backendEvents.emitTo(target, `dstu:change:${event.path}`, event);
  ctx.services.backendEvents.emitTo(target, 'dstu:change', event);
}

function sessionExport(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const format = requiredNonEmptyString(args, 'format');
  if (format !== 'markdown' && format !== 'note') {
    throw new Error('SESSION_EXPORT_INVALID_FORMAT: expected markdown or note');
  }
  const exported = prepareSessionExportWithDb(db, args);
  if (format === 'markdown') return markdownExportToToolValue(exported);

  const folderId = optionalNonEmptyString(args, 'folder_id');
  const notes = notesService(ctx);
  if (notes === null) throw new Error('SESSION_EXPORT_VFS_UNAVAILABLE');
  let note;
  try {
    note = notes.repository.createNoteInFolder({ title: exported.title, content: exported.markdown, tags: [] }, folderId);
  } catch (error) {
    throw new Error(`SESSION_EXPORT_NOTE_FAILED: ${errorText(error)}`);
  }
  const node = noteToDstuNode(note);
  emitWatchEvent(ctx, createdEvent(node.path, node));
  return {
    success: true, format: 'note', sessionId: exported.sessionId, title: note.title, range: exported.range,
    messageCount: exported.messageCount, folderId, noteId: note.id, resourceId: note.resourceId, path: node.path,
    target: { kind: 'vfs_note', folderId, noteId: note.id, resourceId: note.resourceId, path: node.path },
    reversible: true, reverseWith: 'builtin-note_delete',
  };
}

const importRepository: SessionImportRepository = {
  createSessionWithConn: (conn, session) => createSessionWithConn(conn, session),
  createMessageWithConn: (conn, message) => createMessageWithConn(conn, message),
  createBlocksBatchWithConn: (conn, blocks) =>
    createBlocksBatchWithConn(conn as DatabaseHandle, blocks as Parameters<typeof createBlocksBatchWithConn>[1]),
};

function trimmedNonEmpty(args: Args, key: string): string | null {
  const value = str(args, key)?.trim() ?? '';
  return value === '' ? null : value;
}

function sessionImport(db: DatabaseHandle, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  let raw: string;
  const content = trimmedNonEmpty(args, 'json_content');
  if (content !== null) {
    if (Array.from(content).length > MAX_SESSION_IMPORT_CONTENT_CHARS) {
      throw new Error(`SESSION_IMPORT_TOO_LARGE: json_content exceeds ${MAX_SESSION_IMPORT_CONTENT_CHARS} chars; `
        + 'stage the file and pass root_id + relative_path instead');
    }
    raw = content;
  } else {
    const rootId = trimmedNonEmpty(args, 'root_id') ?? 'temp';
    if (rootId.toLowerCase() !== 'temp') {
      throw new Error(`SESSION_IMPORT_INVALID_ROOT: only root_id=temp is accepted, got '${rootId}'`);
    }
    const relativePath = trimmedNonEmpty(args, 'relative_path');
    if (relativePath === null) {
      throw new Error('SESSION_IMPORT_MISSING_SOURCE: provide json_content, or root_id + relative_path of a staged json file');
    }
    const temp = agentOrchestrationWorkspaceRuntime().sessionRoot(ctx.services.app.dataDir, ctx.session_id, 'temp', true);
    const file = agentOrchestrationWorkspaceRuntime().resolveStagedFileInTempRoot(temp.path, relativePath);
    let size: number;
    try { size = file.size(); }
    catch (error) { throw new Error(`SESSION_IMPORT_READ_FAILED: ${errorText(error)}`); }
    if (size > MAX_SESSION_IMPORT_FILE_BYTES) {
      throw new Error(`SESSION_IMPORT_TOO_LARGE: file is ${size} bytes, limit is ${MAX_SESSION_IMPORT_FILE_BYTES} bytes`);
    }
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(file.read()); }
    catch (error) { throw new Error(`SESSION_IMPORT_READ_FAILED: ${errorText(error)}`); }
  }
  return importSessionPayload(db, importRepository, raw, optionalNonEmptyString(args, 'title'));
}

function tagAdd(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  const tag = required(args, 'tag');
  ensureNotCurrentSession(sessionId, ctx, '标签添加');
  existingSession(db, sessionId);
  addManualTagWithConn(db, sessionId, tag);
  return { success: true, sessionId, tag, message: `已为会话添加标签「${tag}」` };
}

function tagRemove(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  const tag = required(args, 'tag');
  ensureNotCurrentSession(sessionId, ctx, '标签移除');
  removeTagWithConn(db, sessionId, tag);
  return { success: true, sessionId, tag, message: `已移除标签「${tag}」` };
}

function sessionMove(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  const groupId = str(args, 'group_id');
  ensureNotCurrentSession(sessionId, ctx, '分组移动');
  if (groupId !== null) activeGroup(db, groupId);
  updateSessionGroup(db, sessionId, groupId);
  let message = '已将会话移出分组';
  if (groupId !== null) {
    let name = groupId;
    try { name = getGroupWithConn(db, groupId)?.name ?? groupId; } catch { name = groupId; }
    message = `已将会话移入分组「${name}」`;
  }
  return { success: true, sessionId, groupId, message };
}

function sessionRename(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  const title = required(args, 'title');
  ensureNotCurrentSession(sessionId, ctx, '重命名');
  renameSession(db, sessionId, title);
  return { success: true, sessionId, title, message: `已将会话重命名为「${title}」` };
}

function groupCreate(db: SqlExecutor, args: Args): Record<string, unknown> {
  const name = required(args, 'name');
  const existing = listGroupsWithConn(db, 'active', null);
  const nextSort = existing.reduce((max, group) => Math.max(max, group.sortOrder), 0) + 1;
  const now = nowRfc3339();
  const group: SessionGroup = {
    id: `group_${crypto.randomUUID()}`, name, description: str(args, 'description'), icon: str(args, 'icon'),
    color: str(args, 'color'), systemPrompt: null, defaultSkillIds: [], pinnedResourceIds: [], workspaceId: null,
    defaultRuntimeRootId: null, preferredProjectRootPath: null, sortOrder: nextSort, persistStatus: 'active',
    createdAt: now, updatedAt: now,
  };
  createGroupWithConn(db, group);
  return { success: true, groupId: group.id, name, message: `已创建分组「${name}」(${group.id})` };
}

function groupUpdate(db: SqlExecutor, args: Args): Record<string, unknown> {
  const groupId = required(args, 'group_id');
  const existing = getGroupWithConn(db, groupId);
  if (existing === null) throw new Error(`分组不存在: ${groupId}`);
  const merge = (requested: string | null, current: string | null | undefined): string | null =>
    requested === null ? current ?? null : requested.trim() === '' ? null : requested;
  const updated: SessionGroup = {
    ...existing,
    name: str(args, 'name') ?? existing.name,
    description: merge(str(args, 'description'), existing.description),
    icon: merge(str(args, 'icon'), existing.icon),
    color: merge(str(args, 'color'), existing.color),
    updatedAt: nowRfc3339(),
  };
  updateGroupWithConn(db, updated);
  return { success: true, groupId, message: `已更新分组「${updated.name}」` };
}

/** BG-4 `group_archive`: archives the group and its active sessions together. */
function groupArchive(db: DatabaseHandle, args: Args): Record<string, unknown> {
  const groupId = required(args, 'group_id');
  const existing = getGroupWithConn(db, groupId);
  if (existing === null) throw new Error(`分组不存在: ${groupId}`);
  if (existing.persistStatus === 'deleted') throw new Error(`分组已删除: ${groupId}`);
  if (existing.persistStatus === 'archived') return {
    success: true, groupId, status: 'archived', message: `分组「${existing.name}」已是归档状态`,
  };
  archiveGroupWithConn(db, groupId);
  return {
    success: true, groupId, name: existing.name, status: 'archived',
    message: `已归档分组「${existing.name}」及其活跃会话`,
  };
}

/** BG-4 `group_restore`: restores an archived group and the sessions it archived. */
function groupRestore(db: DatabaseHandle, args: Args): Record<string, unknown> {
  const groupId = required(args, 'group_id');
  const existing = getGroupWithConn(db, groupId);
  if (existing === null) throw new Error(`分组不存在: ${groupId}`);
  if (existing.persistStatus === 'deleted') throw new Error(`分组已删除，无法恢复: ${groupId}`);
  if (existing.persistStatus === 'active') return {
    success: true, groupId, status: 'active', message: `分组「${existing.name}」已是活跃状态`,
  };
  restoreGroupWithConn(db, groupId);
  return {
    success: true, groupId, name: existing.name, status: 'active',
    message: `已恢复分组「${existing.name}」及其归档会话`,
  };
}

/** BG-4 `group_delete`: soft-deletes an archived group and ungroups its sessions. */
function groupDelete(db: DatabaseHandle, args: Args): Record<string, unknown> {
  const groupId = required(args, 'group_id');
  const existing = getGroupWithConn(db, groupId);
  if (existing === null) throw new Error(`分组不存在: ${groupId}`);
  if (existing.persistStatus === 'active') {
    throw new Error('只能删除已归档的分组，请先调用 group_archive 归档');
  }
  if (existing.persistStatus === 'deleted') return {
    success: true, groupId, status: 'deleted', message: `分组「${existing.name}」已是删除状态`,
  };
  softDeleteGroupWithConn(db, groupId);
  return {
    success: true, groupId, name: existing.name, status: 'deleted',
    message: `已删除分组「${existing.name}」；组内会话保留但不再归属该分组`,
  };
}

function sessionArchive(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  ensureNotCurrentSession(sessionId, ctx, '归档');
  const archived = archiveSession(db, sessionId);
  return { success: true, sessionId, message: `已归档会话「${archived.title ?? sessionId}」` };
}

function sessionRestore(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionId = required(args, 'session_id');
  ensureNotCurrentSession(sessionId, ctx, '恢复');
  const restored = restoreSession(db, sessionId);
  return { success: true, sessionId, message: `已恢复会话「${restored.title ?? sessionId}」` };
}

function batchSessionIds(args: Args, ctx: ChatExecutionContext, confirmRequired: (count: number) => boolean,
  confirmMessage: string, verb: string): string[] {
  const sessionIds = stringArrayArg(args, 'session_ids');
  if (sessionIds === null) throw new Error('缺少必需参数: session_ids');
  if (sessionIds.length === 0) throw new Error('session_ids 不能为空');
  if (sessionIds.length > 50) throw new Error('单次批量操作不能超过 50 个会话');
  if (confirmRequired(sessionIds.length) && args.confirmed !== true) throw new Error(confirmMessage);
  if (sessionIds.includes(ctx.session_id)) throw new Error(`${verb}不能包含当前正在使用的会话`);
  return sessionIds;
}

function batchMove(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const groupId = str(args, 'group_id');
  const sessionIds = batchSessionIds(args, ctx, batchMoveConfirmationRequired,
    '批量移动超过 3 个会话时，需要用户确认并传入 confirmed=true', '批量移动');
  if (groupId !== null) activeGroup(db, groupId);
  let moved = 0;
  const errors: string[] = [];
  for (const sessionId of sessionIds) {
    try { updateSessionGroup(db, sessionId, groupId); moved += 1; }
    catch (error) { errors.push(`${sessionId}: ${errorText(error)}`); }
  }
  return { success: errors.length === 0, moved, total: sessionIds.length, errors, groupId,
    message: `已移动 ${moved}/${sessionIds.length} 个会话` };
}

function batchTag(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const sessionIds = stringArrayArg(args, 'session_ids');
  if (sessionIds === null) throw new Error('缺少必需参数: session_ids');
  const tag = required(args, 'tag');
  batchSessionIds(args, ctx, batchTagConfirmationRequired,
    '批量打标超过 5 个会话时，需要用户确认并传入 confirmed=true', '批量打标');
  let tagged = 0;
  const errors: string[] = [];
  for (const sessionId of sessionIds) {
    try { addManualTagWithConn(db, sessionId, tag); tagged += 1; }
    catch (error) { errors.push(`${sessionId}: ${errorText(error)}`); }
  }
  return { success: errors.length === 0, tagged, total: sessionIds.length, tag, errors,
    message: `已为 ${tagged}/${sessionIds.length} 个会话添加标签「${tag}」` };
}

interface BatchOp { sessionId: string; action: string; groupId: string | null; tag: string | null; title: string | null }

class AbortBatch extends Error {}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** session_executor.rs:1095–1392. */
function batchOps(db: SqlExecutor, args: Args, ctx: ChatExecutionContext): Record<string, unknown> {
  const rawOps = jsonArrayArg(args, 'operations');
  if (rawOps === null) throw new Error('缺少必需参数: operations');
  if (rawOps.length === 0) throw new Error('operations 不能为空');
  if (rawOps.length > MAX_BATCH_OPS_PER_CALL) throw new Error(`operations 过多：单次最多 ${MAX_BATCH_OPS_PER_CALL} 条`);

  const operations: BatchOp[] = [];
  const uniqueSessions = new Set<string>();
  rawOps.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`operations[${index}] 必须是对象`);
    const op = raw as Args;
    const sessionId = str(op, 'session_id')?.trim() ?? '';
    if (sessionId === '') throw new Error(`operations[${index}] 缺少必需参数: session_id`);
    const action = str(op, 'action')?.trim() ?? '';
    if (action === '') throw new Error(`operations[${index}] 缺少必需参数: action`);
    uniqueSessions.add(sessionId);
    operations.push({ sessionId, action, groupId: str(op, 'group_id'), tag: str(op, 'tag'), title: str(op, 'title') });
  });
  if (uniqueSessions.size > 50) throw new Error('单次 unified 批量操作最多涉及 50 个不同会话');
  const hasArchive = operations.some(op => op.action === 'archive');
  if (batchOpsConfirmationRequired(uniqueSessions.size, hasArchive) && args.confirmed !== true) {
    throw new Error('批量操作需要显式确认：请先征得用户同意，然后以 confirmed=true 重新调用');
  }

  const guard = (index: number, sessionId: string, label: string): void => {
    try { ensureNotCurrentSession(sessionId, ctx, label); }
    catch (error) { throw new Error(`operations[${index}]: ${errorText(error)}`); }
  };
  const nonBlank = (value: string | null): boolean => value !== null && value.trim() !== '';
  operations.forEach((op, index) => {
    switch (op.action) {
      case 'move': guard(index, op.sessionId, '分组移动'); break;
      case 'tag_add': case 'tag_remove':
        guard(index, op.sessionId, '标签操作');
        if (!nonBlank(op.tag)) throw new Error(`operations[${index}] action=${op.action} 缺少必需参数: tag`);
        break;
      case 'rename':
        guard(index, op.sessionId, '重命名');
        if (!nonBlank(op.title)) throw new Error(`operations[${index}] action=rename 缺少必需参数: title`);
        break;
      case 'archive': guard(index, op.sessionId, '归档'); break;
      case 'restore': guard(index, op.sessionId, '恢复'); break;
      default: throw new Error(`operations[${index}] 不支持的 action: ${op.action}`);
    }
  });
  const moveTarget = (op: BatchOp): string | null => {
    const trimmed = op.groupId?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  };
  const checkedGroups = new Set<string>();
  for (const op of operations) {
    const groupId = op.action === 'move' ? moveTarget(op) : null;
    if (groupId === null || checkedGroups.has(groupId)) continue;
    activeGroup(db, groupId);
    checkedGroups.add(groupId);
  }

  let applied = 0;
  let failed = 0;
  const attempted = new Map<string, number>();
  const appliedBy = new Map<string, number>();
  const failedBy = new Map<string, number>();
  const results: Record<string, unknown>[] = [];
  // Rust `?` inside an action aborts the whole call; only explicit `Err(..)` values are per-op failures.
  const fatal = <T>(work: () => T): T => {
    try { return work(); } catch (error) { throw new AbortBatch(errorText(error)); }
  };
  try {
    operations.forEach((op, index) => {
      bump(attempted, op.action);
      let outcome: { ok: string } | { err: string };
      switch (op.action) {
        case 'move': {
          const groupId = moveTarget(op);
          fatal(() => updateSessionGroup(db, op.sessionId, groupId));
          outcome = { ok: groupId === null ? '已移出分组' : `已移动到分组 ${groupId}` };
          break;
        }
        case 'tag_add':
          fatal(() => existingSession(db, op.sessionId));
          fatal(() => addManualTagWithConn(db, op.sessionId, op.tag!));
          outcome = { ok: `已添加标签 ${op.tag!}` };
          break;
        case 'tag_remove':
          fatal(() => removeTagWithConn(db, op.sessionId, op.tag!));
          outcome = { ok: `已移除标签 ${op.tag!}` };
          break;
        case 'rename':
          fatal(() => renameSession(db, op.sessionId, op.title!));
          outcome = { ok: `已重命名为 ${op.title!}` };
          break;
        case 'archive': {
          const existing = fatal(() => existingSession(db, op.sessionId));
          if (existing.persistStatus !== 'active') {
            outcome = { err: `只能归档活跃会话，当前状态: ${debugStatus(existing.persistStatus)}` };
          } else {
            fatal(() => updateSessionWithConn(db, manuallyArchiveSession(existing)));
            outcome = { ok: '已归档' };
          }
          break;
        }
        case 'restore': {
          const existing = fatal(() => existingSession(db, op.sessionId));
          if (existing.persistStatus === 'active') {
            outcome = { err: '会话已是活跃状态，无需恢复' };
          } else {
            fatal(() => ensureSessionGroupRestorable(db, existing));
            fatal(() => updateSessionWithConn(db, { ...existing, persistStatus: 'active', updatedAt: nowRfc3339() }));
            outcome = { ok: '已恢复为活跃状态' };
          }
          break;
        }
        default: outcome = { err: `不支持的 action: ${op.action}` };
      }
      if ('ok' in outcome) {
        applied += 1;
        bump(appliedBy, op.action);
        results.push({ index, sessionId: op.sessionId, action: op.action, success: true, message: outcome.ok });
      } else {
        failed += 1;
        bump(failedBy, op.action);
        results.push({ index, sessionId: op.sessionId, action: op.action, success: false, error: outcome.err });
      }
    });
  } catch (error) {
    if (error instanceof AbortBatch) throw new Error(error.message);
    throw error;
  }
  return {
    success: failed === 0, totalOperations: operations.length, totalSessions: uniqueSessions.size, applied, failed,
    actionStats: {
      attempted: Object.fromEntries(attempted), applied: Object.fromEntries(appliedBy), failed: Object.fromEntries(failedBy),
    },
    results, message: `统一批量操作完成：成功 ${applied}，失败 ${failed}`,
  };
}

function dispatch(toolName: string, call: ToolCall, ctx: ChatExecutionContext): Record<string, unknown> {
  const args = objectOf(call.arguments);
  switch (toolName) {
    case 'session_list': return executeSessionListWithDb(chatDb(ctx), call.arguments);
    case 'session_search': return sessionSearch(chatDb(ctx), args);
    case 'session_get': return sessionGet(chatDb(ctx), args);
    case 'session_get_messages': return executeSessionGetMessagesWithDb(chatDb(ctx), call.arguments);
    case 'session_export': return sessionExport(chatDb(ctx), args, ctx);
    case 'session_import': return sessionImport(chatDb(ctx), args, ctx);
    case 'group_list': return groupList(chatDb(ctx));
    case 'tag_list_all': return tagListAll(chatDb(ctx));
    case 'session_stats': return sessionStats(chatDb(ctx));
    case 'session_tag_add': return tagAdd(chatDb(ctx), args, ctx);
    case 'session_tag_remove': return tagRemove(chatDb(ctx), args, ctx);
    case 'session_move': return sessionMove(chatDb(ctx), args, ctx);
    case 'session_rename': return sessionRename(chatDb(ctx), args, ctx);
    case 'group_create': return groupCreate(chatDb(ctx), args);
    case 'group_update': return groupUpdate(chatDb(ctx), args);
    case 'group_archive': return groupArchive(chatDb(ctx), args);
    case 'group_restore': return groupRestore(chatDb(ctx), args);
    case 'group_delete': return groupDelete(chatDb(ctx), args);
    case 'session_archive': return sessionArchive(chatDb(ctx), args, ctx);
    case 'session_restore': return sessionRestore(chatDb(ctx), args, ctx);
    case 'session_batch_move': return batchMove(chatDb(ctx), args, ctx);
    case 'session_batch_tag': return batchTag(chatDb(ctx), args, ctx);
    case 'session_batch_ops': return batchOps(chatDb(ctx), args, ctx);
    default: throw new Error(`未知的会话管理工具: ${call.name}`);
  }
}

const lower = (level: 'High' | 'Medium' | 'Low'): 'high' | 'medium' | 'low' =>
  level.toLowerCase() as 'high' | 'medium' | 'low';

export class SessionToolExecutor {
  private readonly log: { info(message: string): void; warn(message: string): void };

  constructor(log: { info(message: string): void; warn(message: string): void }) { this.log = log; }

  canHandle(toolName: string): boolean { return canHandleSessionTool(toolName); }

  async execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    const toolName = stripToolNamespace(call.name);
    let output: unknown;
    let error: string | null = null;
    try { output = dispatch(toolName, call, ctx); } catch (cause) { error = errorText(cause); }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (error === null) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      this.log.info(`${LOG_PREFIX} Tool ${call.name} completed in ${durationMs}ms`);
      if (!NON_WRITE_TOOLS.has(toolName)) {
        try { ctx.services.backendEvents.emit(SESSION_MGMT_EVENT, { tool: toolName, sessionId: ctx.session_id }); }
        catch (cause) { this.log.warn(`${LOG_PREFIX} Failed to emit ${SESSION_MGMT_EVENT}: ${errorText(cause)}`); }
      }
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output,
        success: true, durationMs };
    } else {
      ctx.emitToolCallError(error);
      this.log.warn(`${LOG_PREFIX} Tool ${call.name} failed: ${error}`);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null,
        success: false, error, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.log.warn(`${LOG_PREFIX} Failed to save tool block: ${errorText(cause)}`); }
    return result;
  }

  sensitivityLevel(toolName: string): 'high' | 'medium' | 'low' { return lower(sessionSensitivityLevel(toolName)); }
  sensitivityLevelForCall(toolName: string, args: unknown): 'high' | 'medium' | 'low' {
    return lower(sessionSensitivityLevelForCall(toolName, args));
  }
  hasDynamicSensitivity(toolName: string): boolean { return hasDynamicSessionSensitivity(toolName); }
  concurrencyClass(toolName: string): ToolConcurrency {
    return READ_ONLY_TOOLS.has(stripToolNamespace(toolName)) ? 'read_only' : 'serial';
  }
  name(): string { return 'SessionToolExecutor'; }
}
