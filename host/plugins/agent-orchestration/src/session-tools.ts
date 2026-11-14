/**
 * Session management tool logic (session_executor.rs:67–124, 167–177,
 * 1508–1588, 1590–2070): tool classification, pagination validation, message
 * summaries and markdown export.
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChatMessage, ChatSession, MessageBlock, Variant } from '../../chat/api.ts';
import { chronoRfc3339, parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import {
  countSessions, getBlocks, getMessages, getSessionById, getTagsForSessions,
  listSessions, loadMessagesPage,
  type ChatBlockRecord, type ChatMessageRecord, type ChatSessionRecord, type SessionImportRepository,
} from '../repository/session-tools.ts';
import { stripToolNamespace } from './automation-tool-args.ts';

export const MAX_TOOL_FIELD_CHARS = 2_000;
export const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 200;
export const MAX_EXPORT_TITLE_CHARS = 120;
export const MAX_MESSAGE_PAGE_SIZE = 20;
export const MAX_SESSION_IMPORT_MESSAGES = 2_000;
export const MAX_SESSION_IMPORT_BLOCKS = 20_000;

export const SESSION_TOOL_NAMES = ['session_list', 'session_search', 'session_get',
  'session_get_messages', 'session_export', 'session_import', 'group_list', 'tag_list_all',
  'session_stats', 'session_tag_add', 'session_tag_remove', 'session_move', 'session_rename',
  'group_create', 'group_update', 'group_archive', 'group_restore', 'group_delete',
  'session_archive', 'session_restore', 'session_batch_move',
  'session_batch_tag', 'session_batch_ops'] as const;

const SESSION_TOOL_SET = new Set<string>(SESSION_TOOL_NAMES);

export function isSessionTool(name: string): boolean {
  return SESSION_TOOL_SET.has(name);
}

export function canHandleSessionTool(toolName: string): boolean {
  return isSessionTool(stripToolNamespace(toolName));
}

/** session_executor.rs:2295–2306. */
export function sessionSensitivityLevel(toolName: string): 'High' | 'Medium' | 'Low' {
  const bare = stripToolNamespace(toolName);
  if (bare === 'session_archive' || bare === 'group_delete') return 'High';
  if (['session_export', 'session_import', 'session_tag_add', 'session_tag_remove',
    'session_move', 'session_rename', 'session_restore', 'group_create', 'group_update',
    'group_archive', 'group_restore',
    'session_batch_tag', 'session_batch_move', 'session_batch_ops'].includes(bare)) {
    return 'Medium';
  }
  return 'Low';
}

export function hasDynamicSessionSensitivity(toolName: string): boolean {
  return stripToolNamespace(toolName) === 'session_batch_ops';
}

/** session_executor.rs:2308–2323: batch_ops escalates to High when it archives. */
export function sessionSensitivityLevelForCall(
  toolName: string, args: unknown,
): 'High' | 'Medium' | 'Low' {
  const bare = stripToolNamespace(toolName);
  const operations = objectOf(args)?.operations;
  if (bare === 'session_batch_ops' && Array.isArray(operations)
    && operations.some((operation) => objectOf(operation)?.action === 'archive')) {
    return 'High';
  }
  return sessionSensitivityLevel(toolName);
}

export function batchOpsConfirmationRequired(uniqueSessions: number, hasArchive: boolean): boolean {
  return uniqueSessions > 3 || hasArchive;
}

export function batchMoveConfirmationRequired(totalSessions: number): boolean {
  return totalSessions > 3;
}

export function batchTagConfirmationRequired(totalSessions: number): boolean {
  return totalSessions > 5;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** session_executor.rs:1488–1506. */
export function optionalNonEmptyString(args: unknown, key: string): string | null {
  const value = objectOf(args)?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`SESSION_INVALID_ARGUMENT: ${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`SESSION_INVALID_ARGUMENT: ${key} must not be empty`);
  return trimmed;
}

/** session_executor.rs:1508–1529. */
export function parseBoundedU32(
  args: unknown, key: string, defaultValue: number, min: number, max: number,
): number {
  const object = objectOf(args) ?? {};
  if (!Object.hasOwn(object, key) || object[key] === undefined) return defaultValue;
  const value = object[key];
  const parsed = typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value : null;
  if (parsed === null) throw new Error(`SESSION_INVALID_ARGUMENT: ${key} must be an integer`);
  if (parsed < min || parsed > max) {
    throw new Error(`SESSION_INVALID_ARGUMENT: ${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

/** session_executor.rs:1531–1539. */
export function parseRoleFilter(args: unknown): 'user' | 'assistant' | null {
  const role = optionalNonEmptyString(args, 'role_filter');
  if (role === null) return null;
  if (role === 'user' || role === 'assistant') return role;
  throw new Error('SESSION_INVALID_ROLE_FILTER: expected one of user or assistant');
}

/** session_executor.rs:1541–1582. */
export function normalizeDateBound(raw: string, isEnd: boolean): string {
  const trimmed = raw.trim();
  const parsed = parseRfc3339(trimmed);
  if (parsed !== null) return toRfc3339Opts(parsed.epochNanos, 'Millis', true);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day) {
      throw new Error(`SESSION_INVALID_DATE: expected YYYY-MM-DD or RFC3339, got ${trimmed}`);
    }
    if (isEnd) date.setUTCHours(23, 59, 59, 999);
    return toRfc3339Opts(BigInt(date.getTime()) * 1_000_000n, 'Millis', true);
  }
  throw new Error(`SESSION_INVALID_DATE: expected YYYY-MM-DD or RFC3339, got ${trimmed}`);
}

export function parseSearchDateRange(args: unknown): {
  dateFrom: string | null; dateTo: string | null;
} {
  const rawFrom = optionalNonEmptyString(args, 'date_from');
  const rawTo = optionalNonEmptyString(args, 'date_to');
  const dateFrom = rawFrom === null ? null : normalizeDateBound(rawFrom, false);
  const dateTo = rawTo === null ? null : normalizeDateBound(rawTo, true);
  if (dateFrom !== null && dateTo !== null && Date.parse(dateFrom) > Date.parse(dateTo)) {
    throw new Error('SESSION_INVALID_DATE_RANGE: date_from is after date_to');
  }
  return { dateFrom, dateTo };
}

export function truncateField(value: string, maxChars: number): [string, boolean] {
  const chars = [...value];
  return [chars.slice(0, maxChars).join(''), chars.length > maxChars];
}

// ---------------------------------------------------------------------------
// Message / block tool summaries (session_executor.rs:1650–1816)
// ---------------------------------------------------------------------------

export interface SessionAttachment {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  size: number;
  status: string;
  error?: string | null;
}

export interface SessionMessageVariant {
  id: string;
  blockIds: string[];
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  timestamp: number;
  blockIds: string[];
  activeVariantId?: string | null;
  variants?: SessionMessageVariant[] | null;
  attachments?: SessionAttachment[] | null;
}

export interface SessionBlock {
  id: string;
  messageId: string;
  blockIndex: number;
  blockType: string;
  status: string;
  content?: string | null;
  toolName?: string | null;
  toolOutput?: unknown;
  error?: string | null;
  citations?: unknown[] | null;
  startedAt?: number | null;
  endedAt?: number | null;
}

export function timestampIso(timestamp: number): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return toRfc3339Opts(BigInt(date.getTime()) * 1_000_000n, 'Millis', true);
}

function messageContent(blocks: readonly SessionBlock[]): string {
  return blocks
    .filter((block) => block.blockType === 'content')
    .map((block) => block.content ?? '')
    .filter((content) => content !== '')
    .join('\n');
}

/** session_executor.rs:1651–1738. */
export function toolOutputSummary(output: unknown): [string, boolean] {
  if (output === undefined) return ['Tool completed without a persisted output', false];
  if (output === null) return ['Tool returned null', false];
  if (typeof output === 'boolean' || typeof output === 'number') {
    return [`Tool returned ${String(output)}`, false];
  }
  if (typeof output === 'string') {
    const total = [...output].length;
    const [preview, truncated] = truncateField(output, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
    return [`Tool returned text (${total} characters): ${preview}`, truncated];
  }
  if (Array.isArray(output)) return [`Tool returned an array with ${output.length} items`, false];
  const object = objectOf(output);
  if (object === null) return ['Tool returned null', false];
  for (const key of ['summary', 'message', 'error']) {
    const value = object[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const total = [...value].length;
      const [preview, truncated] = truncateField(value, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
      return [`${key} (${total} characters): ${preview}`, truncated];
    }
  }
  const facts: string[] = [];
  for (const key of ['success', 'status', 'count', 'total', 'created', 'updated', 'deleted']) {
    const value = object[key];
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      facts.push(`${key}=${String(value)}`);
    }
  }
  if (facts.length > 0) return [facts.join(', '), false];
  const keys = Object.keys(object).sort().slice(0, 12);
  if (keys.length === 0) return ['Tool returned an empty object', false];
  return [`Tool returned fields: ${keys.join(', ')}`, Object.keys(object).length > keys.length];
}

export function blockToSummary(block: SessionBlock): Record<string, unknown> {
  const isToolOutput = block.toolName !== undefined && block.toolName !== null
    || block.toolOutput !== undefined
    || block.blockType === 'mcp_tool' || block.blockType === 'workbench_ops';
  let rawSummary: string;
  let sourceTruncated = false;
  if (block.blockType === 'thinking') {
    rawSummary = 'Model reasoning (hidden)';
  } else if (isToolOutput) {
    [rawSummary, sourceTruncated] = toolOutputSummary(block.toolOutput);
  } else if (block.content !== undefined && block.content !== null) {
    rawSummary = block.content;
  } else if (block.citations !== undefined && block.citations !== null) {
    rawSummary = `${block.citations.length} citations`;
  } else {
    rawSummary = `${block.blockType} block`;
  }
  const [summary, summaryTruncated] = truncateField(rawSummary, MAX_TOOL_FIELD_CHARS);
  const [error, errorTruncated] = block.error !== undefined && block.error !== null
    ? truncateField(block.error, MAX_TOOL_FIELD_CHARS) : ['', false];
  return {
    id: block.id,
    type: block.blockType,
    status: block.status,
    toolName: block.toolName ?? null,
    isToolOutput,
    summary,
    summaryTruncated: summaryTruncated || sourceTruncated,
    toolOutputTruncated: isToolOutput && sourceTruncated,
    error: error === '' ? null : error,
    errorTruncated,
    truncated: summaryTruncated || sourceTruncated || errorTruncated,
    citationCount: block.citations === undefined || block.citations === null
      ? null : block.citations.length,
    startedAt: block.startedAt ?? null,
    endedAt: block.endedAt ?? null,
  };
}

/** session_executor.rs:1773–1816. */
export function messageToToolValue(
  message: SessionMessage, blocks: readonly SessionBlock[],
): Record<string, unknown> {
  const [content, contentTruncated] = truncateField(messageContent(blocks), MAX_TOOL_FIELD_CHARS);
  const attachments = (message.attachments ?? []).map((attachment) => {
    const [name, nameTruncated] = truncateField(attachment.name, MAX_TOOL_FIELD_CHARS);
    const [error, errorTruncated] = attachment.error !== undefined && attachment.error !== null
      ? truncateField(attachment.error, MAX_TOOL_FIELD_CHARS) : ['', false];
    return {
      id: attachment.id,
      name,
      type: attachment.type,
      mimeType: attachment.mimeType,
      size: attachment.size,
      status: attachment.status,
      error: error === '' ? null : error,
      truncated: nameTruncated || errorTruncated,
    };
  });
  return {
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    timestampIso: timestampIso(message.timestamp),
    content,
    truncated: contentTruncated,
    blocks: blocks.map(blockToSummary),
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Export range / markdown (session_executor.rs:1818–2065)
// ---------------------------------------------------------------------------

export interface SessionExportRange {
  startMessageId: string | null;
  endMessageId: string | null;
}

function objectStringAlias(
  object: Record<string, unknown>, keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) continue;
    const value = object[key];
    if (value === null) return null;
    if (typeof value !== 'string') {
      throw new Error(`SESSION_INVALID_EXPORT_RANGE: ${key} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed === '') throw new Error(`SESSION_INVALID_EXPORT_RANGE: ${key} must not be empty`);
    return trimmed;
  }
  return null;
}

/** session_executor.rs:1843–1878. */
export function parseExportRange(args: unknown): SessionExportRange | null {
  const raw = objectOf(args)?.range;
  if (raw === undefined || raw === null) return null;
  const object = objectOf(raw);
  if (object === null) throw new Error('SESSION_INVALID_EXPORT_RANGE: range must be an object');
  const startMessageId = objectStringAlias(object,
    ['start_message_id', 'from_message_id', 'startMessageId', 'fromMessageId']);
  const endMessageId = objectStringAlias(object,
    ['end_message_id', 'to_message_id', 'endMessageId', 'toMessageId']);
  if (startMessageId === null && endMessageId === null) return null;
  return { startMessageId, endMessageId };
}

/** session_executor.rs:1880–1911. */
export function selectExportMessages(
  messages: readonly SessionMessage[], range: SessionExportRange | null,
): SessionMessage[] {
  if (range === null) return [...messages];
  if (messages.length === 0) return [];
  const start = range.startMessageId === null ? 0
    : messages.findIndex((message) => message.id === range.startMessageId);
  if (range.startMessageId !== null && start < 0) {
    throw new Error(`SESSION_EXPORT_RANGE_START_NOT_FOUND: ${range.startMessageId}`);
  }
  const end = range.endMessageId === null ? messages.length - 1
    : messages.findIndex((message) => message.id === range.endMessageId);
  if (range.endMessageId !== null && end < 0) {
    throw new Error(`SESSION_EXPORT_RANGE_END_NOT_FOUND: ${range.endMessageId}`);
  }
  if (start > end) {
    throw new Error('SESSION_INVALID_EXPORT_RANGE: start_message_id is after end_message_id');
  }
  return messages.slice(start, end + 1);
}

function visibleBlocks(
  message: SessionMessage, messageBlocks: readonly SessionBlock[],
): SessionBlock[] {
  const variantIds = message.activeVariantId === undefined || message.activeVariantId === null
    ? null
    : message.variants?.find((variant) => variant.id === message.activeVariantId)?.blockIds ?? null;
  const selectedIds = variantIds !== null && variantIds.length > 0 ? variantIds
    : message.blockIds.length > 0 ? message.blockIds : null;
  if (selectedIds === null) return [...messageBlocks];
  const byId = new Map(messageBlocks.map((block) => [block.id, block]));
  return selectedIds.map((id) => byId.get(id)).filter((block): block is SessionBlock => block !== undefined);
}

/** session_executor.rs:1913–1996. */
export function renderSessionMarkdown(
  title: string, sessionId: string, messages: readonly SessionMessage[],
  blocks: readonly SessionBlock[],
): string {
  const grouped = new Map<string, SessionBlock[]>();
  for (const block of blocks) {
    const list = grouped.get(block.messageId) ?? [];
    list.push(block);
    grouped.set(block.messageId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.blockIndex - b.blockIndex);

  let markdown = `# ${title}\n\n> Session: \`${sessionId}\`\n`;
  for (const message of messages) {
    const visible = visibleBlocks(message, grouped.get(message.id) ?? []);
    const role = message.role === 'user' ? 'User' : 'Assistant';
    markdown += `\n## ${role}`;
    const timestamp = timestampIso(message.timestamp);
    if (timestamp !== null) markdown += ` · ${timestamp}`;
    markdown += '\n\n';
    const content = messageContent(visible);
    if (content.trim() !== '') {
      markdown += `${content.trim()}\n`;
    } else {
      for (const block of visible.filter((entry) => entry.toolName !== undefined
        && entry.toolName !== null || entry.toolOutput !== undefined || entry.blockType === 'mcp_tool')) {
        const [summaryRaw] = toolOutputSummary(block.toolOutput);
        const [summary] = truncateField(summaryRaw, MAX_TOOL_FIELD_CHARS);
        markdown += `- Tool \`${block.toolName ?? 'unknown'}\`: ${summary}\n`;
      }
    }
    for (const attachment of message.attachments ?? []) {
      const [name] = truncateField(attachment.name, MAX_TOOL_FIELD_CHARS);
      markdown += `- Attachment: ${name} (\`${attachment.mimeType}\`)\n`;
    }
  }
  return markdown;
}

export function resolveExportTitle(
  args: unknown, sessionTitle: string | null, sessionId: string,
): string {
  const raw = optionalNonEmptyString(args, 'title')
    ?? (sessionTitle !== null && sessionTitle.trim() !== '' ? sessionTitle.trim() : null)
    ?? `Chat session ${sessionId}`;
  const singleLine = raw.split(/\s+/).filter((part) => part !== '').join(' ');
  return truncateField(singleLine, MAX_EXPORT_TITLE_CHARS)[0];
}

export interface PreparedSessionExport {
  sessionId: string;
  title: string;
  markdown: string;
  messageCount: number;
  range: unknown;
}

/** session_executor.rs:2043–2065. */
export function markdownExportToToolValue(exported: PreparedSessionExport): Record<string, unknown> {
  const totalChars = [...exported.markdown].length;
  const [markdown, truncated] = truncateField(exported.markdown, MAX_TOOL_FIELD_CHARS);
  return {
    success: true,
    format: 'markdown',
    sessionId: exported.sessionId,
    title: exported.title,
    range: exported.range,
    messageCount: exported.messageCount,
    markdown,
    totalChars,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// DB entry points (session_executor.rs:188–420, 1992–2130)
//
// Rust's `SessionToolExecutor` reads chat_v2 directly; the Host ports those
// reads here so L04 can assemble the executor around its own database handle.
// ---------------------------------------------------------------------------

const U32_MAX = 4_294_967_295;

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function requiredNonEmptyString(args: unknown, key: string): string {
  const value = objectOf(args)?.[key];
  if (typeof value !== 'string') {
    throw new Error(`SESSION_INVALID_ARGUMENT: ${key} is required`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`SESSION_INVALID_ARGUMENT: ${key} must not be empty`);
  }
  return trimmed;
}

/** session_executor.rs:1445–1456. */
function sessionToSummary(record: ChatSessionRecord): Record<string, unknown> {
  return {
    id: record.id,
    mode: record.mode,
    title: record.title,
    description: record.description,
    persistStatus: record.persistStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    groupId: record.groupId,
  };
}

function tagsForSessionsOrEmpty(
  db: SqlExecutor, sessionIds: readonly string[],
): Map<string, string[]> {
  try {
    return getTagsForSessions(db, sessionIds);
  } catch {
    // Rust `get_tags_for_sessions(..).unwrap_or_default()`: listing still succeeds
    // without tags when the tag query fails.
    return new Map<string, string[]>();
  }
}

/** session_executor.rs:188–269. */
export function executeSessionListWithDb(
  db: SqlExecutor, args: unknown,
): Record<string, unknown> {
  const object = objectOf(args) ?? {};
  const status = typeof object.status === 'string' ? object.status : null;
  const groupId = typeof object.group_id === 'string' ? object.group_id : null;
  const includeTags = object.include_tags === true;
  const requestedLimit = asNonNegativeInteger(object.limit) ?? 20;
  const limit = Math.min(20, Math.max(1, requestedLimit));
  const offset = (asNonNegativeInteger(object.offset) ?? 0) % (U32_MAX + 1);

  const sessions = listSessions(db, status, groupId, limit, offset);
  const total = countSessions(db, status, groupId);
  const tags = includeTags
    ? tagsForSessionsOrEmpty(db, sessions.map((session) => session.id))
    : new Map<string, string[]>();

  const items = sessions.map((session) => {
    const summary = sessionToSummary(session);
    if (includeTags) summary.tags = tags.get(session.id) ?? [];
    return summary;
  });

  return {
    sessions: items,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  };
}

// ---------------------------------------------------------------------------
// Row → tool value conversion (repo records carry DB column names)
// ---------------------------------------------------------------------------

function sessionVariants(value: unknown): SessionMessageVariant[] | null {
  if (!Array.isArray(value)) return null;
  const variants: SessionMessageVariant[] = [];
  for (const entry of value) {
    const object = objectOf(entry);
    if (object === null || typeof object.id !== 'string' || !Array.isArray(object.blockIds)) {
      return null;
    }
    if (!object.blockIds.every((id): id is string => typeof id === 'string')) return null;
    variants.push({ id: object.id, blockIds: object.blockIds });
  }
  return variants;
}

function sessionAttachments(value: unknown): SessionAttachment[] | null {
  if (!Array.isArray(value)) return null;
  const attachments: SessionAttachment[] = [];
  for (const entry of value) {
    const object = objectOf(entry);
    if (object === null) return null;
    const field = (key: string): string => {
      const raw = object[key];
      return typeof raw === 'string' ? raw : '';
    };
    const optionalString = (key: string): string | null => {
      const raw = object[key];
      return typeof raw === 'string' ? raw : null;
    };
    const size = object.size;
    if (typeof size !== 'number' && size !== undefined && size !== null) return null;
    attachments.push({
      id: field('id'),
      name: field('name'),
      type: field('type'),
      mimeType: field('mimeType'),
      size: typeof size === 'number' ? size : 0,
      status: typeof object.status === 'string' ? object.status : 'pending',
      error: optionalString('error'),
    });
  }
  return attachments;
}

function toSessionMessage(record: ChatMessageRecord): SessionMessage {
  return {
    id: record.id,
    role: record.role,
    timestamp: record.timestamp,
    blockIds: record.blockIds,
    activeVariantId: record.activeVariantId,
    variants: sessionVariants(record.variants),
    attachments: sessionAttachments(record.attachments),
  };
}

function toSessionBlock(record: ChatBlockRecord): SessionBlock {
  return {
    id: record.id,
    messageId: record.messageId,
    blockIndex: record.blockIndex,
    blockType: record.blockType,
    status: record.status,
    content: record.content,
    toolName: record.toolName,
    toolOutput: record.toolOutput,
    error: record.error,
    citations: Array.isArray(record.citations) ? record.citations : null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function groupBlocksByMessage(
  blocks: readonly SessionBlock[],
): Map<string, SessionBlock[]> {
  const grouped = new Map<string, SessionBlock[]>();
  for (const block of blocks) {
    const list = grouped.get(block.messageId) ?? [];
    list.push(block);
    grouped.set(block.messageId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.blockIndex - b.blockIndex);
  return grouped;
}

/** session_executor.rs:331–379. */
export function executeSessionGetMessagesWithDb(
  db: SqlExecutor, args: unknown,
): Record<string, unknown> {
  const sessionId = requiredNonEmptyString(args, 'session_id');
  const page = parseBoundedU32(args, 'page', 1, 1, U32_MAX);
  const pageSize = parseBoundedU32(args, 'page_size', MAX_MESSAGE_PAGE_SIZE, 1, MAX_MESSAGE_PAGE_SIZE);
  const roleFilter = parseRoleFilter(args);

  const session = getSessionById(db, sessionId);
  if (session === null) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);

  const { messages, blocks, total } = loadMessagesPage(db, sessionId, page, pageSize, roleFilter);
  const grouped = groupBlocksByMessage(blocks.map(toSessionBlock));
  const items = messages.map((record) => {
    const message = toSessionMessage(record);
    return messageToToolValue(message, visibleBlocks(message, grouped.get(message.id) ?? []));
  });

  const offset = (page - 1) * pageSize;
  return {
    sessionId: session.id,
    sessionTitle: session.title,
    messages: items,
    page,
    pageSize,
    roleFilter,
    total,
    hasMore: offset + items.length < total,
  };
}

/** session_executor.rs:1992–2028. */
export function prepareSessionExportWithDb(
  db: SqlExecutor, args: unknown,
): PreparedSessionExport {
  const sessionId = requiredNonEmptyString(args, 'session_id');
  const session = getSessionById(db, sessionId);
  if (session === null) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);

  const messages = getMessages(db, sessionId).map(toSessionMessage);
  const blocks = getBlocks(db, sessionId).map(toSessionBlock);
  const range = parseExportRange(args);
  const selected = selectExportMessages(messages, range);
  if (selected.length === 0) {
    throw new Error('SESSION_EXPORT_EMPTY_RANGE: no messages to export');
  }

  const title = resolveExportTitle(args, session.title, sessionId);
  const markdown = renderSessionMarkdown(title, sessionId, selected, blocks);
  return {
    sessionId,
    title,
    markdown,
    messageCount: selected.length,
    range: range === null ? null : {
      startMessageId: range.startMessageId,
      endMessageId: range.endMessageId,
    },
  };
}

// ---------------------------------------------------------------------------
// session_import (session_executor.rs:510–600, 2040–2200)
// ---------------------------------------------------------------------------

export interface ImportRemapStats {
  originalSessionId: string;
  orphanBlocks: number;
  missingBlockRefs: number;
}

export interface RemappedImport {
  session: ChatSession;
  messages: ChatMessage[];
  blocks: Array<MessageBlock & { blockIndex: number }>;
  stats: ImportRemapStats;
}

function importFormatError(detail: string): Error {
  return new Error(`SESSION_IMPORT_INVALID_FORMAT: ${detail}`);
}

function importString(
  object: Record<string, unknown>, key: string, context: string,
): string {
  const value = object[key];
  if (typeof value !== 'string') {
    throw importFormatError(`${context}: field '${key}' must be a string`);
  }
  return value;
}

function importOptionalString(
  object: Record<string, unknown>, key: string, context: string,
): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw importFormatError(`${context}: field '${key}' must be a string or null`);
  }
  return value;
}

function importStringArray(
  object: Record<string, unknown>, key: string, context: string,
): string[] {
  const value = object[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw importFormatError(`${context}: field '${key}' must be an array of strings`);
  }
  return [...value] as string[];
}

function importOptionalInteger(
  object: Record<string, unknown>, key: string, context: string,
): number | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw importFormatError(`${context}: field '${key}' must be an integer or null`);
  }
  return value;
}

function importRequiredInteger(
  object: Record<string, unknown>, key: string, context: string,
): number {
  const value = importOptionalInteger(object, key, context);
  if (value === null) throw importFormatError(`${context}: field '${key}' is required`);
  return value;
}

function parseImportedVariant(value: unknown, index: number): Variant {
  const context = `bad messages array: variants[${index}]`;
  const object = objectOf(value);
  if (object === null) throw importFormatError(`${context} must be an object`);
  return {
    id: importString(object, 'id', context),
    modelId: importString(object, 'modelId', context),
    configId: importOptionalString(object, 'configId', context),
    blockIds: importStringArray(object, 'blockIds', context),
    status: importString(object, 'status', context),
    error: importOptionalString(object, 'error', context),
    createdAt: importRequiredInteger(object, 'createdAt', context),
    usage: (object.usage ?? null) as Variant['usage'],
    meta: (object.meta ?? null) as Variant['meta'],
  };
}

function parseImportedMessage(value: unknown, index: number): ChatMessage {
  const context = `bad messages array: messages[${index}]`;
  const object = objectOf(value);
  if (object === null) throw importFormatError(`${context} must be an object`);

  const role = importString(object, 'role', context);
  if (role !== 'user' && role !== 'assistant') {
    throw importFormatError(`${context}: field 'role' must be user or assistant`);
  }

  const meta = object._meta;
  if (meta !== undefined && meta !== null && objectOf(meta) === null) {
    throw importFormatError(`${context}: field '_meta' must be an object or null`);
  }

  const attachments = object.attachments;
  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments) || attachments.some((entry) => objectOf(entry) === null)) {
      throw importFormatError(`${context}: field 'attachments' must be an array of objects or null`);
    }
  }

  const variants = object.variants;
  if (variants !== undefined && variants !== null && !Array.isArray(variants)) {
    throw importFormatError(`${context}: field 'variants' must be an array or null`);
  }

  const sharedContext = object.sharedContext;
  if (sharedContext !== undefined && sharedContext !== null && objectOf(sharedContext) === null) {
    throw importFormatError(`${context}: field 'sharedContext' must be an object or null`);
  }

  return {
    id: importString(object, 'id', context),
    sessionId: importString(object, 'sessionId', context),
    role,
    blockIds: importStringArray(object, 'blockIds', context),
    timestamp: importRequiredInteger(object, 'timestamp', context),
    persistentStableId: importOptionalString(object, 'persistentStableId', context),
    parentId: importOptionalString(object, 'parentId', context),
    supersedes: importOptionalString(object, 'supersedes', context),
    _meta: (meta ?? null) as ChatMessage['_meta'],
    attachments: (attachments ?? null) as ChatMessage['attachments'],
    activeVariantId: importOptionalString(object, 'activeVariantId', context),
    variants: Array.isArray(variants)
      ? variants.map((entry, variantIndex) => parseImportedVariant(entry, variantIndex))
      : null,
    sharedContext: (sharedContext ?? null) as ChatMessage['sharedContext'],
  };
}

function parseImportedBlock(value: unknown, index: number): MessageBlock {
  const context = `bad blocks array: blocks[${index}]`;
  const object = objectOf(value);
  if (object === null) throw importFormatError(`${context} must be an object`);

  const citations = object.citations;
  if (citations !== undefined && citations !== null && !Array.isArray(citations)) {
    throw importFormatError(`${context}: field 'citations' must be an array or null`);
  }

  return {
    id: importString(object, 'id', context),
    messageId: importString(object, 'messageId', context),
    type: importString(object, 'type', context),
    status: importString(object, 'status', context),
    content: importOptionalString(object, 'content', context),
    toolName: importOptionalString(object, 'toolName', context),
    toolInput: object.toolInput ?? null,
    toolOutput: object.toolOutput ?? null,
    citations: (citations ?? null) as MessageBlock['citations'],
    error: importOptionalString(object, 'error', context),
    startedAt: importOptionalInteger(object, 'startedAt', context),
    endedAt: importOptionalInteger(object, 'endedAt', context),
    firstChunkAt: importOptionalInteger(object, 'firstChunkAt', context),
  };
}

function parseImportedSession(value: unknown): ChatSession {
  const context = 'bad session object';
  const object = objectOf(value);
  if (object === null) throw importFormatError(`${context}: expected an object`);

  const persistStatus = importString(object, 'persistStatus', context);
  if (persistStatus !== 'active' && persistStatus !== 'archived' && persistStatus !== 'deleted') {
    throw importFormatError(`${context}: field 'persistStatus' must be active, archived or deleted`);
  }

  const titleLocked = object.titleLocked;
  if (titleLocked !== undefined && typeof titleLocked !== 'boolean') {
    throw importFormatError(`${context}: field 'titleLocked' must be a boolean`);
  }

  const tags = object.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags) || !tags.every((entry) => typeof entry === 'string')) {
      throw importFormatError(`${context}: field 'tags' must be an array of strings or null`);
    }
  }

  return {
    id: importString(object, 'id', context),
    mode: importString(object, 'mode', context),
    title: importOptionalString(object, 'title', context),
    description: importOptionalString(object, 'description', context),
    summaryHash: importOptionalString(object, 'summaryHash', context),
    titleLocked: titleLocked === true,
    persistStatus,
    createdAt: importString(object, 'createdAt', context),
    updatedAt: importString(object, 'updatedAt', context),
    metadata: object.metadata ?? null,
    groupId: importOptionalString(object, 'groupId', context),
    tagsHash: importOptionalString(object, 'tagsHash', context),
    tags: tags === undefined ? null : (tags as string[] | null),
  };
}

/** session_executor.rs:2043–2200: remap every ID; drop orphan blocks / missing refs. */
export function remapImportedSession(
  session: ChatSession,
  messages: ChatMessage[],
  blocks: MessageBlock[],
  titleOverride: string | null,
): RemappedImport {
  const originalSessionId = session.id;
  const newSessionId = `sess_${globalThis.crypto.randomUUID()}`;

  const messageIdMap = new Map<string, string>();
  for (const message of messages) messageIdMap.set(message.id, `msg_${globalThis.crypto.randomUUID()}`);
  const blockIdMap = new Map<string, string>();
  for (const block of blocks) blockIdMap.set(block.id, `blk_${globalThis.crypto.randomUUID()}`);

  let orphanBlocks = 0;
  const keptBlocks: Array<MessageBlock & { blockIndex: number }> = [];
  for (const block of blocks) {
    const newMessageId = messageIdMap.get(block.messageId);
    if (newMessageId === undefined) {
      orphanBlocks += 1;
      continue;
    }
    const newBlockId = blockIdMap.get(block.id);
    keptBlocks.push({
      ...block,
      id: newBlockId ?? block.id,
      messageId: newMessageId,
      blockIndex: 0,
    });
  }
  for (const [index, block] of keptBlocks.entries()) block.blockIndex = index;

  let missingBlockRefs = 0;
  const remappedMessages = messages.map((message) => {
    const remapIds = (ids: readonly string[]): string[] => {
      const out: string[] = [];
      for (const id of ids) {
        const mapped = blockIdMap.get(id);
        if (mapped === undefined) {
          missingBlockRefs += 1;
        } else {
          out.push(mapped);
        }
      }
      return out;
    };
    const parentId = message.parentId === undefined || message.parentId === null
      ? null : messageIdMap.get(message.parentId) ?? null;
    const supersedes = message.supersedes === undefined || message.supersedes === null
      ? null : messageIdMap.get(message.supersedes) ?? null;

    return {
      ...message,
      id: messageIdMap.get(message.id) ?? message.id,
      sessionId: newSessionId,
      persistentStableId: null,
      parentId,
      supersedes,
      blockIds: remapIds(message.blockIds),
      variants: message.variants === undefined || message.variants === null
        ? message.variants ?? null
        : message.variants.map((variant) => ({ ...variant, blockIds: remapIds(variant.blockIds) })),
    };
  });

  const metadata = objectOf(session.metadata) ?? {};
  const remappedSession: ChatSession = {
    ...session,
    id: newSessionId,
    mode: session.mode.trim() === '' ? 'chat' : session.mode,
    title: titleOverride ?? session.title,
    titleLocked: titleOverride === null ? session.titleLocked : true,
    persistStatus: 'active',
    groupId: null,
    tags: null,
    tagsHash: null,
    summaryHash: null,
    updatedAt: chronoRfc3339(),
    metadata: {
      ...metadata,
      importedFromSessionId: originalSessionId,
      importedAt: chronoRfc3339(),
    },
  };

  return {
    session: remappedSession,
    messages: remappedMessages,
    blocks: keptBlocks,
    stats: { originalSessionId, orphanBlocks, missingBlockRefs },
  };
}

/**
 * session_executor.rs:510–600.
 *
 * 解析/重映射在本函数完成；调用方开启 Rust 等价的 `BEGIN IMMEDIATE` 事务，
 * 把同一个 `SqlExecutor` 交给 L04 的所有者方法（{@link SessionImportRepository}），
 * 失败必须整体回滚。
 */
export function importSessionPayload(
  db: DatabaseHandle, repository: SessionImportRepository,
  raw: string, titleOverride: string | null,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`SESSION_IMPORT_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const root = objectOf(payload);
  const sessionValue = root === null ? undefined : root.session;
  if (sessionValue === undefined) {
    throw importFormatError("missing 'session' field (expected the JSON produced by session export)");
  }
  const messagesValue = root?.messages;
  if (messagesValue === undefined) {
    throw importFormatError("missing 'messages' field");
  }
  const blocksValue = root !== null && Object.hasOwn(root, 'blocks') ? root.blocks : [];

  const session = parseImportedSession(sessionValue);
  if (!Array.isArray(messagesValue)) {
    throw importFormatError('bad messages array: expected an array');
  }
  const messages = messagesValue.map((entry, index) => parseImportedMessage(entry, index));
  if (!Array.isArray(blocksValue)) {
    throw importFormatError('bad blocks array: expected an array');
  }
  const blocks = blocksValue.map((entry, index) => parseImportedBlock(entry, index));

  if (messages.length === 0) {
    throw new Error('SESSION_IMPORT_EMPTY: the export contains no messages');
  }
  if (messages.length > MAX_SESSION_IMPORT_MESSAGES) {
    throw new Error(`SESSION_IMPORT_TOO_LARGE: ${messages.length} messages exceeds the ${MAX_SESSION_IMPORT_MESSAGES} limit`);
  }
  if (blocks.length > MAX_SESSION_IMPORT_BLOCKS) {
    throw new Error(`SESSION_IMPORT_TOO_LARGE: ${blocks.length} blocks exceeds the ${MAX_SESSION_IMPORT_BLOCKS} limit`);
  }

  const remapped = remapImportedSession(session, messages, blocks, titleOverride);
  try {
    db.transaction((tx) => {
      repository.createSessionWithConn(tx, remapped.session);
      for (const message of remapped.messages) {
        repository.createMessageWithConn(tx, message);
      }
      repository.createBlocksBatchWithConn(tx, remapped.blocks);
    }, { behavior: 'immediate' });
  } catch (error) {
    throw new Error(`SESSION_IMPORT_DB_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    success: true,
    sessionId: remapped.session.id,
    title: remapped.session.title ?? null,
    mode: remapped.session.mode,
    importedFromSessionId: remapped.stats.originalSessionId,
    messageCount: remapped.messages.length,
    blockCount: remapped.blocks.length,
    droppedOrphanBlocks: remapped.stats.orphanBlocks,
    droppedMissingBlockRefs: remapped.stats.missingBlockRefs,
    attachmentsNote: '消息中的附件仅保留元数据引用；原始附件二进制不随 JSON 导出，跨设备导入后可能无法读取。',
    hint: '导入完成：已创建新会话（未分组、无标签），可用 session_get / session_get_messages 验证内容。',
  };
}
