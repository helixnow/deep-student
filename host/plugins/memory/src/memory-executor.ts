/**
 * Memory tool executor pure layer — TS mirror of
 * `src-tauri/src/chat_v2/tools/memory_executor.rs` argument parsing,
 * pagination bounds, tag normalization and sensitivity/concurrency routing.
 *
 * The `MemoryService` registration itself lives in `index.ts`.
 */
import type { MemoryListItem, MemoryReadOutput } from '../api.ts';
import { stripToolNamespace } from './paper-save.ts';
import { withLocalizedMessage } from './tool-errors.ts';

export const MEMORY_TOOL_NAMES = [
  'memory_search', 'memory_read', 'memory_write', 'memory_list',
  'memory_update_by_id', 'memory_delete', 'memory_write_smart', 'memory_write_batch',
  'memory_batch_move', 'memory_add_relation', 'memory_remove_relation',
  'memory_update_tags', 'memory_log_activity', 'memory_export_all',
  'learner_profile_get', 'learner_profile_update',
] as const;

export const MEMORY_BATCH_LIMIT = 20;
export const MEMORY_LIST_PAGE_SIZE = 20;
export const MEMORY_EXPORT_PAGE_SIZE = 20;
export const MEMORY_EXPORT_CONTENT_CHARS = 2000;
export const MEMORY_TAG_LIMIT = 50;
export const MEMORY_TAG_CHARS = 200;

export type ToolSensitivity = 'low' | 'medium' | 'high';
export type ToolConcurrency = 'read_only' | 'serial';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rust `MemoryToolExecutor::is_memory_tool` (`builtin-`/`mcp_` prefixes stripped). */
export function isMemoryTool(toolName: string): boolean {
  const stripped = stripToolNamespace(toolName);
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(stripped);
}

/** Rust `needs_root_bootstrap`: only a missing root (None) triggers the J8a claim. */
export function needsRootBootstrap(rootFolderId: string | null | undefined): boolean {
  return rootFolderId === null || rootFolderId === undefined;
}

/** Rust `invalid_args` (structured JSON error string with localized message contract). */
function invalidArgs(field: string, zhCn: string, enUs: string): string {
  return JSON.stringify(withLocalizedMessage({
    code: 'MEMORY_INVALID_ARGS', field, retryable: false,
  }, 'chat.tools.memory.invalid_args', { field }, zhCn, enUs));
}

function trimmedNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function arrayArg(args: Record<string, unknown>, key: string, alias: string): unknown[] | null {
  const value = args[key] ?? args[alias];
  return Array.isArray(value) ? value : null;
}

export type BatchMoveEntry = [string, string];

/**
 * Rust `parse_batch_move_args`: every ID needs a non-empty expected version and
 * the map must contain exactly the same number of entries.
 */
export function parseBatchMoveArgs(argsValue: unknown): BatchMoveEntry[] {
  const args = isRecord(argsValue) ? argsValue : {};
  const values = arrayArg(args, 'note_ids', 'noteIds');
  if (values === null) {
    throw new Error(invalidArgs('note_ids', 'note_ids 必须是数组', 'note_ids must be an array.'));
  }
  if (values.length === 0 || values.length > MEMORY_BATCH_LIMIT) {
    throw new Error(invalidArgs('note_ids',
      `note_ids 必须包含 1 至 ${MEMORY_BATCH_LIMIT} 个记忆 ID`,
      `note_ids must contain 1 to ${MEMORY_BATCH_LIMIT} memory IDs.`));
  }

  const seen = new Set<string>();
  const noteIds: string[] = [];
  for (const value of values) {
    const noteId = trimmedNonEmpty(value);
    if (noteId === null) {
      throw new Error(invalidArgs('note_ids', 'note_ids 只能包含非空字符串',
        'note_ids may only contain non-empty strings.'));
    }
    if (seen.has(noteId)) {
      throw new Error(invalidArgs('note_ids', `note_ids 包含重复 ID: ${noteId}`,
        `note_ids contains a duplicate ID: ${noteId}.`));
    }
    seen.add(noteId);
    noteIds.push(noteId);
  }

  const versionMap = args['expected_updated_at_by_id'] ?? args['expectedUpdatedAtById'];
  if (!isRecord(versionMap)) {
    throw new Error(invalidArgs('expected_updated_at_by_id',
      '批量移动前必须提供每条记忆的 expected_updated_at',
      'Every memory must have an expected_updated_at before a batch move.'));
  }
  if (Object.keys(versionMap).length !== noteIds.length) {
    throw new Error(invalidArgs('expected_updated_at_by_id',
      '版本映射必须与 note_ids 完全一致',
      'The version map must contain exactly the IDs in note_ids.'));
  }

  return noteIds.map(noteId => {
    const version = trimmedNonEmpty(versionMap[noteId]);
    if (version === null) {
      throw new Error(invalidArgs('expected_updated_at_by_id',
        `缺少 ${noteId} 的 expected_updated_at`,
        `expected_updated_at is missing for ${noteId}.`));
    }
    return [noteId, version];
  });
}

/** Rust `parse_tags`: non-empty strings, ≤50 entries, ≤200 chars each, order-preserving dedup. */
export function parseTags(argsValue: unknown): string[] {
  const args = isRecord(argsValue) ? argsValue : {};
  const values = args['tags'];
  if (!Array.isArray(values)) {
    throw new Error(invalidArgs('tags', 'tags 必须是数组', 'tags must be an array.'));
  }
  if (values.length > MEMORY_TAG_LIMIT) {
    throw new Error(invalidArgs('tags', `tags 最多允许 ${MEMORY_TAG_LIMIT} 项`,
      `tags may contain at most ${MEMORY_TAG_LIMIT} entries.`));
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = trimmedNonEmpty(value);
    if (tag === null) {
      throw new Error(invalidArgs('tags', 'tags 只能包含非空字符串',
        'tags may only contain non-empty strings.'));
    }
    if (Array.from(tag).length > MEMORY_TAG_CHARS) {
      throw new Error(invalidArgs('tags',
        `单个标签最多允许 ${MEMORY_TAG_CHARS} 个字符`,
        `Each tag may contain at most ${MEMORY_TAG_CHARS} characters.`));
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** `serde_json::Value::as_u64` for JSON numbers (fractions/negatives/strings are `None`). */
function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value : null;
}

const U32_MAX = 0xffffffff;

/** Rust `export_pagination` -> `[page, page_size, offset]`. */
export function exportPagination(argsValue: unknown): [number, number, number] {
  const args = isRecord(argsValue) ? argsValue : {};
  const page = asU64(args['page']) ?? 1;
  const pageSize = asU64(args['page_size'] ?? args['pageSize']) ?? MEMORY_EXPORT_PAGE_SIZE;
  if (page === 0 || pageSize < 1 || pageSize > MEMORY_EXPORT_PAGE_SIZE) {
    throw new Error(invalidArgs('page',
      `page 必须从 1 开始，page_size 必须在 1 至 ${MEMORY_EXPORT_PAGE_SIZE} 之间`,
      `page must start at 1 and page_size must be between 1 and ${MEMORY_EXPORT_PAGE_SIZE}.`));
  }
  if (page > U32_MAX) {
    throw new Error(invalidArgs('page', 'page 超出范围', 'page is out of range.'));
  }
  const offset = (page - 1) * pageSize;
  if (offset > U32_MAX) {
    throw new Error(invalidArgs('page', '分页参数超出范围', 'Pagination is out of range.'));
  }
  return [page, pageSize, offset];
}

/** Rust `list_pagination` -> `[limit, offset]`. */
export function listPagination(argsValue: unknown): [number, number] {
  const args = isRecord(argsValue) ? argsValue : {};
  const limit = asU64(args['limit']) ?? MEMORY_LIST_PAGE_SIZE;
  if (limit < 1 || limit > MEMORY_LIST_PAGE_SIZE) {
    throw new Error(invalidArgs('limit',
      `limit 必须在 1 至 ${MEMORY_LIST_PAGE_SIZE} 之间`,
      `limit must be between 1 and ${MEMORY_LIST_PAGE_SIZE}.`));
  }
  const offset = args['offset'] === undefined ? 0 : asU64(args['offset']) ?? 0;
  if (offset > U32_MAX) {
    throw new Error(invalidArgs('offset', 'offset 超出范围', 'offset is out of range.'));
  }
  return [limit, offset];
}

/** Rust `truncate_export_content`: 2000 code points plus a truncation flag. */
export function truncateExportContent(content: string): [string, boolean] {
  const chars = Array.from(content);
  const bounded = chars.slice(0, MEMORY_EXPORT_CONTENT_CHARS).join('');
  return [bounded, chars.length > MEMORY_EXPORT_CONTENT_CHARS];
}

/** Rust `sensitivity_level`. */
export function memorySensitivity(toolName: string): ToolSensitivity {
  const stripped = stripToolNamespace(toolName);
  if (stripped === 'memory_export_all') return 'high';
  if (stripped === 'memory_batch_move' || stripped === 'memory_add_relation'
    || stripped === 'memory_remove_relation' || stripped === 'memory_update_tags'
    || stripped === 'memory_log_activity' || stripped === 'memory_write'
    || stripped === 'memory_write_smart' || stripped === 'memory_write_batch'
    || stripped === 'memory_update_by_id' || stripped === 'memory_delete'
    || stripped === 'learner_profile_get' || stripped === 'learner_profile_update') {
    return 'medium';
  }
  return 'low';
}

/** Rust `concurrency_class`. */
export function memoryConcurrency(toolName: string): ToolConcurrency {
  const stripped = stripToolNamespace(toolName);
  return stripped === 'memory_search' || stripped === 'memory_read'
    || stripped === 'memory_list' || stripped === 'memory_export_all'
    ? 'read_only' : 'serial';
}

export interface MemoryExportPageItem {
  note_id: string;
  title: string;
  content: string;
  content_truncated: boolean;
  folder_path: string;
  tags: string[];
  memory_type: string;
  memory_purpose: string;
  updated_at: string;
}

export interface ExportPageService {
  list(folderPath: string | null | undefined, limit: number,
    offset: number): MemoryListItem[];
  read(noteId: string): MemoryReadOutput | null;
  getTags(noteId: string): string[];
}

/** Rust `export_page`: fetch `page_size + 1` rows to compute `has_more`. */
export function exportPage(service: ExportPageService, pageSize: number, offset: number): {
  items: MemoryExportPageItem[]; hasMore: boolean;
} {
  const listed = service.list(null, pageSize + 1, offset);
  const hasMore = listed.length > pageSize;
  const visible = hasMore ? listed.slice(0, pageSize) : listed;
  const items: MemoryExportPageItem[] = [];
  for (const item of visible) {
    const note = service.read(item.id);
    if (note === null) continue;
    const [content, contentTruncated] = truncateExportContent(note.content);
    items.push({
      note_id: note.noteId,
      title: note.title,
      content,
      content_truncated: contentTruncated,
      folder_path: note.folderPath,
      tags: service.getTags(note.noteId),
      memory_type: item.memoryType,
      memory_purpose: item.memoryPurpose,
      updated_at: note.updatedAt,
    });
  }
  return { items, hasMore };
}
