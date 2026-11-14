// chat_v2/tools/canvas_executor.rs: tool routing, backend read/write branches,
// OCC payloads, ACR delegation envelope and the AgentOp envelope assembled for
// the frontend editor. Frontend ACK/result callbacks live in
// repository/canvas-edits.ts; the chat registry is owned by L04.
import { noteRepository } from '../repository/notes.ts';
import { listNotesMeta } from '../repository/notes-manager.ts';
import { notesLog } from '../repository/log.ts';
import { NoteDatabaseError, NoteDocumentError } from '../repository/errors.ts';
import {
  executeAgentToolWithLifecycle,
  type AgentToolCall, type AgentToolResultInfo, type ExecutionContext,
} from '../../../kernel/agent-api.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { charCount, rustTrim, rustTrimEnd, takeChars } from '../../../platform/util/index.ts';
import type {
  AcrBridgeLogger, BridgeEventBus, WorkbenchGateEnvironment,
} from '../../agent-skills/api.ts';
import { notesAgentBridge } from './agent-bridge.ts';
import { replaceContent } from './canvas-commands.ts';
import type { CanvasNativeRegex } from './canvas-commands.ts';

export const canvasToolNames = {
  NOTE_READ: 'note_read',
  NOTE_APPEND: 'note_append',
  NOTE_REPLACE: 'note_replace',
  NOTE_SET: 'note_set',
  NOTE_LIST: 'note_list',
  NOTE_SEARCH: 'note_search',
  NOTE_CREATE: 'note_create',
  NOTE_DELETE: 'note_delete',
  NOTE_UPDATE_TAGS: 'note_update_tags',
} as const;

export type CanvasToolSensitivity = 'low' | 'medium' | 'high';

/** dstu-core/tool_names.rs::strip_tool_namespace. */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

export const stripCanvasBuiltinPrefix = stripToolNamespace;

export function isCanvasTool(toolName: string): boolean {
  return Object.values(canvasToolNames).includes(
    stripCanvasBuiltinPrefix(toolName) as (typeof canvasToolNames)[keyof typeof canvasToolNames],
  );
}

/** clean/dirty/hot delegate to the frontend; frozen/closed/disabled/unknown fail closed. */
export function shouldDelegateFrontend(probeState: string): boolean {
  return probeState === 'clean' || probeState === 'dirty' || probeState === 'hot';
}

/** Backend fallback is only safe when no live editor can hold unsaved changes. */
export function isSafeBackendFallbackState(probeState: string): boolean {
  return probeState === 'closed' || probeState === 'disabled';
}

export function isDestructiveNoteTool(toolName: string): boolean {
  return toolName === canvasToolNames.NOTE_REPLACE || toolName === canvasToolNames.NOTE_SET;
}

export function isNoteWriteTool(toolName: string): boolean {
  return toolName === canvasToolNames.NOTE_APPEND
    || toolName === canvasToolNames.NOTE_REPLACE
    || toolName === canvasToolNames.NOTE_SET;
}

export function canvasSensitivityLevel(toolName: string): CanvasToolSensitivity {
  const stripped = stripCanvasBuiltinPrefix(toolName);
  if (stripped === canvasToolNames.NOTE_SET || stripped === canvasToolNames.NOTE_REPLACE) return 'high';
  if (stripped === canvasToolNames.NOTE_CREATE
    || stripped === canvasToolNames.NOTE_APPEND
    || stripped === canvasToolNames.NOTE_DELETE
    || stripped === canvasToolNames.NOTE_UPDATE_TAGS) return 'medium';
  return 'low';
}

export function managesCanvasCancellation(toolName: string): boolean {
  const stripped = stripCanvasBuiltinPrefix(toolName);
  return stripped === canvasToolNames.NOTE_APPEND
    || stripped === canvasToolNames.NOTE_REPLACE
    || stripped === canvasToolNames.NOTE_SET;
}

export function extractProbeState(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const state = (data as { state?: unknown }).state;
  return typeof state === 'string' ? state : null;
}

/**
 * Rust `ExecutionContext::try_window()`; the kernel context does not expose
 * the calling window yet (L04 publishes it). Reading it structurally lets the
 * production ACR path light up as soon as that field lands without changing
 * this executor again.
 */
export function executionWindow(ctx: ExecutionContext): WindowRef | null {
  const candidate = ctx as ExecutionContext & { tryWindow?: () => WindowRef | null };
  if (typeof candidate.tryWindow !== 'function') return null;
  return candidate.tryWindow();
}

/** ACR transport required for frontend delegation; absent means backend-only. */
export interface CanvasAcrPort {
  events: BridgeEventBus;
  /**
   * Per-call transport for window-targeted response/progress listeners. Rust
   * calls `ctx.window_ref()` for every bridge invocation; when supplied this
   * factory takes precedence over `events`. Returning null means the calling
   * window is unknown, so frontend delegation must fail instead of falling
   * back to an app-level broadcast.
   */
  eventsForCall?: (ctx: ExecutionContext) => BridgeEventBus | null;
  /** Rust `resolve_workbench_gates`; null/undefined means the gate is unavailable. */
  gates: () => WorkbenchGateEnvironment | null | undefined;
  logger?: AcrBridgeLogger;
  uuid?: () => string;
  drainMs?: number;
}

export interface CanvasToolExecutorPorts {
  conn: () => SqlExecutor;
  acr?: CanvasAcrPort | null;
  /** Context `nativeRegex`; resolved per call so profiles can replace the engine. */
  nativeRegex?: () => CanvasNativeRegex | undefined;
}

const READ_TRUNCATE_CHARS = 2_000;
const PREVIEW_CHARS = 200;
const ADDED_CONTENT_CHARS = 300;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SEARCH_PAGE_SIZE = 10;
const MAX_CANVAS_PAGE_SIZE = 20;
const MAX_SEARCH_FANOUT = 201;
const BACKEND_FALLBACK_MESSAGE = '笔记未打开/桌面未就绪，已直接写入数据';
const FRONTEND_DELEGATE_MESSAGE = '已在前端实时应用';

function toolArgs(value: unknown): Args {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Args : {};
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof NoteDocumentError && error.kind === 'conflict';
}

function toolErrorText(error: unknown): string {
  // CommandError wraps a structured IPC value; Rust returns its Display message.
  const value = (error as { value?: unknown } | null)?.value;
  if (value !== null && typeof value === 'object'
    && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value : fallback;
}

function canvasPageSize(args: Args, fallback: number): number {
  const raw = args.page_size ?? args.limit;
  const value = typeof raw === 'number' && Number.isSafeInteger(raw)
    ? Math.min(Math.max(raw, 1), MAX_CANVAS_PAGE_SIZE) : fallback;
  return value;
}

function stringArrayArg(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[] : undefined;
}

function noteNodePath(noteId: string): string {
  // vfs path_parser.rs::build_simple_resource_path.
  return `/${noteId}`;
}

function noteWatchNode(note: import('../api.ts').VfsNote): Record<string, unknown> {
  return {
    id: note.id,
    path: noteNodePath(note.id),
    name: note.title,
    type: 'note',
    createdAt: parseRfc3339(note.createdAt)?.millis ?? 0,
    updatedAt: parseRfc3339(note.updatedAt)?.millis ?? 0,
    resourceId: note.resourceId,
    sourceId: note.id,
    previewType: 'markdown',
    metadata: {
      isFavorite: note.isFavorite,
      tags: note.tags,
      props: note.props ?? {},
    },
  };
}

function emitDstuWatch(ctx: ExecutionContext, event: Record<string, unknown>): void {
  const path = typeof event.path === 'string' ? event.path : '';
  try {
    ctx.host.emit(`dstu:change:${path}`, event);
    ctx.host.emit('dstu:change', event);
  } catch (error) {
    notesLog.warn(`[CanvasToolExecutor] Failed to emit dstu:change: ${toolErrorText(error)}`);
  }
}

function emitNoteUpdatedWatch(ctx: ExecutionContext, noteId: string, conn: SqlExecutor): void {
  const note = noteRepository.getNote(noteId, conn);
  if (note === null) {
    notesLog.warn(`[CanvasToolExecutor] skip dstu:change: note not found after write (note_id=${noteId})`);
    return;
  }
  emitDstuWatch(ctx, { type: 'updated', path: noteNodePath(note.id), node: noteWatchNode(note) });
}

function emitNoteDeletedWatch(ctx: ExecutionContext, noteId: string): void {
  emitDstuWatch(ctx, { type: 'deleted', path: noteNodePath(noteId) });
}

function verifyNoteRevision(conn: SqlExecutor, noteId: string, expected: string): void {
  const note = noteRepository.getNote(noteId, conn);
  if (note === null) throw new Error('笔记不存在或已被删除');
  if (note.updatedAt !== expected) throw new Error(noteRevisionConflict(expected, note.updatedAt));
}

function requireExpectedRevision(args: Args, reason: string): string {
  const expected = expectedNoteRevision(args);
  if (expected === null) throw new Error(noteOccRequired(reason));
  return expected;
}

function cancelledReceipt(noteId: string, message: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'cancelled',
    mode: 'frontend',
    applied: 0,
    totalOps: 1,
    entityIds: [noteId],
    done: [],
    undone: [message],
    message,
    ...extra,
  };
}

export interface CanvasAIEditRequestPayload {
  requestId: string;
  noteId: string;
  operation: 'append' | 'replace' | 'set';
  content?: string;
  search?: string;
  replace?: string;
  isRegex?: boolean;
  section?: string;
}

/**
 * `CanvasAIEditRequest` (canvas_executor.rs:69-91) shape for the legacy
 * `canvas:ai-edit-request` path. The ACR write path uses `apply_ops` instead.
 */
export function buildCanvasAIEditRequest(
  toolName: string,
  requestId: string,
  noteId: string,
  args: Args,
): CanvasAIEditRequestPayload {
  const stripped = stripCanvasBuiltinPrefix(toolName);
  if (stripped === canvasToolNames.NOTE_APPEND) {
    const payload: CanvasAIEditRequestPayload = { requestId, noteId, operation: 'append' };
    const content = stringArg(args, 'content');
    if (content !== null) payload.content = content;
    const section = stringArg(args, 'section');
    if (section !== null) payload.section = section;
    return payload;
  }
  if (stripped === canvasToolNames.NOTE_REPLACE) {
    const payload: CanvasAIEditRequestPayload = { requestId, noteId, operation: 'replace' };
    const search = stringArg(args, 'search');
    if (search !== null) payload.search = search;
    const replace = stringArg(args, 'replace');
    if (replace !== null) payload.replace = replace;
    const flag = args.is_regex ?? args.isRegex;
    if (typeof flag === 'boolean') payload.isRegex = flag;
    return payload;
  }
  if (stripped === canvasToolNames.NOTE_SET) {
    const payload: CanvasAIEditRequestPayload = { requestId, noteId, operation: 'set' };
    const content = stringArg(args, 'content');
    if (content !== null) payload.content = content;
    return payload;
  }
  throw new Error(`未知的 Canvas 写入工具: ${toolName}`);
}

/** Tool executor for `note_*` (chat_v2/tools/canvas_executor.rs). */
export class CanvasToolExecutor {
  private readonly ports: CanvasToolExecutorPorts | null;

  constructor(ports?: CanvasToolExecutorPorts) {
    this.ports = ports ?? null;
  }

  canHandle(toolName: string): boolean {
    return isCanvasTool(toolName);
  }

  sensitivityLevel(toolName: string): CanvasToolSensitivity {
    return canvasSensitivityLevel(toolName);
  }

  managesCancellation(toolName: string): boolean {
    return managesCanvasCancellation(toolName);
  }

  name(): string {
    return 'CanvasToolExecutor';
  }

  async execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo> {
    return executeAgentToolWithLifecycle(call, ctx, () => this.run(call, toolArgs(call.arguments), ctx), {
      omitEmptyBlockId: true,
      formatError: error => {
        const message = toolErrorText(error);
        notesLog.warn(`[CanvasToolExecutor] Tool ${call.name} failed: ${message}`);
        return message;
      },
      warn: message => notesLog.warn(`[CanvasToolExecutor] ${message}`),
    });
  }

  private requirePorts(): CanvasToolExecutorPorts {
    if (this.ports === null) throw new Error('Canvas 工具不可用：NotesManager 未初始化');
    return this.ports;
  }

  private async run(call: AgentToolCall, args: Args, ctx: ExecutionContext): Promise<unknown> {
    const ports = this.requirePorts();
    const stripped = stripCanvasBuiltinPrefix(call.name);
    const noNoteIdRequired = stripped === canvasToolNames.NOTE_LIST
      || stripped === canvasToolNames.NOTE_SEARCH
      || stripped === canvasToolNames.NOTE_CREATE;
    const noteId = noNoteIdRequired ? '' : (stringArg(args, 'noteId')
      ?? stringArg(args, 'note_id')
      ?? ctx.request.canvasNoteId
      ?? '');
    if (!noNoteIdRequired && noteId.length === 0) {
      throw new Error('Canvas 工具缺少必需参数: noteId（请确保已选择笔记或在工具参数中指定）');
    }
    switch (stripped) {
      case canvasToolNames.NOTE_READ: return this.read(ports, noteId, args);
      case canvasToolNames.NOTE_LIST: return this.list(ports, args);
      case canvasToolNames.NOTE_SEARCH: return this.search(ports, args);
      case canvasToolNames.NOTE_CREATE: return this.create(ports, args, ctx);
      case canvasToolNames.NOTE_DELETE: return this.remove(ports, noteId, args, ctx);
      case canvasToolNames.NOTE_UPDATE_TAGS: return this.updateTags(ports, noteId, args, ctx);
      case canvasToolNames.NOTE_APPEND:
      case canvasToolNames.NOTE_REPLACE:
      case canvasToolNames.NOTE_SET:
        return this.writeWithAcr(ports, call, stripped, noteId, args, ctx);
      default:
        throw new Error(`未知的 Canvas 工具: ${call.name}`);
    }
  }

  private read(ports: CanvasToolExecutorPorts, noteId: string, args: Args): Record<string, unknown> {
    const found = noteRepository.getNoteWithContent(noteId, ports.conn());
    if (found === null) throw new Error('笔记不存在或已被删除');
    const [note, body] = found;
    const section = stringArg(args, 'section');
    let content: string;
    if (section !== null) {
      const extracted = readMarkdownSection(body, section);
      if (extracted === null) throw new Error(`章节 '${section}' 未找到`);
      content = extracted;
    } else {
      content = body;
    }
    const wordCount = charCount(content);
    return {
      noteId,
      content: takeChars(content, READ_TRUNCATE_CHARS),
      wordCount,
      truncated: wordCount > READ_TRUNCATE_CHARS,
      isSection: section !== null,
      updatedAt: note.updatedAt,
      updated_at: note.updatedAt,
    };
  }

  private list(ports: CanvasToolExecutorPorts, args: Args): Record<string, unknown> {
    const conn = ports.conn();
    const page = positiveInteger(args.page, 1);
    const pageSize = canvasPageSize(args, DEFAULT_PAGE_SIZE);
    const tags = stringArrayArg(args.tags);
    const favoritesOnly = (args.favoritesOnly ?? args.favorites_only) === true;
    const rawFolder = args.folderId ?? args.folder_id;
    const folderId = typeof rawFolder === 'string' && rawFolder.length > 0 ? rawFolder : undefined;
    const notes = folderId !== undefined
      ? noteRepository.listNotesByFolder(folderId === 'root' ? null : folderId, 0xFFFF_FFFF, 0, conn)
        .map((note) => ({
          id: note.id, title: note.title, tags: note.tags,
          isFavorite: note.isFavorite, updatedAt: note.updatedAt,
        }))
      : listNotesMeta(conn).map((note) => ({
        id: note.id, title: note.title, tags: note.tags,
        isFavorite: note.is_favorite, updatedAt: note.updated_at,
      }));
    const filtered = notes.filter((note) => {
      if (favoritesOnly && !note.isFavorite) return false;
      if (tags !== undefined && !tags.every((tag) => note.tags.includes(tag))) return false;
      return true;
    });
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const pageItems = start < total ? filtered.slice(start, end) : [];
    const notesWithPaths = pageItems.map((note) => ({ ...note, ...this.notePath(conn, note.id) }));
    return { notes: notesWithPaths, total, page, pageSize, hasMore: end < total };
  }

  /**
   * Path enrichment for `note_list` / `note_search`: every summary carries a
   * DSTU path whose last segment is the note ID, so the Agent can pass it
   * straight to `dstu_rename` / `dstu_move`.
   */
  private notePath(conn: ReturnType<CanvasToolExecutorPorts['conn']>, noteId: string):
  { path: string; folderId: string | null } {
    let location: ReturnType<typeof noteRepository.getNoteLocation>;
    try { location = noteRepository.getNoteLocation(noteId, conn); }
    catch { location = null; }
    if (location === null) return { path: `/${noteId}`, folderId: null };
    const folderPath = location.folderPath === '' || location.folderPath === '/'
      ? '' : location.folderPath.replace(/^\/+|\/+$/g, '');
    return {
      path: folderPath === '' ? `/${noteId}` : `/${folderPath}/${noteId}`,
      folderId: location.folderId ?? null,
    };
  }

  /**
   * Rust `canvas_executor.rs::execute_search` calls `notes_manager.search_notes_lance`,
   * but in VFS mode that function short-circuits to `search_notes_vfs`
   * (`notes_manager.rs:618-632`), which delegates to
   * `VfsNoteRepo::search_notes_with_snippets` (`notes_manager.rs:717-737`):
   * FTS5 bm25 ranking first, LIKE fallback on an FTS error. The Host uses the
   * same repository method; it is not a Lance-to-FTS algorithm substitution.
   *
   * Preserved branches: `page`, `page_size`/`limit` clamp 1..20 (default 10),
   * `search_limit = page*page_size+1` capped at 201, `folder_id` filtering via
   * folder membership, snippet truncation to 2,000 chars, and repository
   * errors surfacing as "搜索笔记失败: …".
   */
  private search(ports: CanvasToolExecutorPorts, args: Args): Record<string, unknown> {
    const rawQuery = args.query;
    if (typeof rawQuery !== 'string') throw new Error('缺少必需参数: query');
    if (rustTrim(rawQuery).length === 0) throw new Error('搜索关键词不能为空');
    const conn = ports.conn();
    const page = positiveInteger(args.page, 1);
    const pageSize = canvasPageSize(args, DEFAULT_SEARCH_PAGE_SIZE);
    const searchLimit = Math.min(page * pageSize + 1, MAX_SEARCH_FANOUT);
    const rawFolder = args.folder_id ?? args.folderId;
    const folderId = typeof rawFolder === 'string' && rawFolder.length > 0 ? rawFolder : undefined;
    let hits;
    try {
      hits = noteRepository.searchNotesWithSnippets(rawQuery, searchLimit, conn);
    } catch (error) {
      throw new Error(`搜索笔记失败: ${toolErrorText(error)}`);
    }
    const filtered = hits.filter(([note]) => {
      if (folderId === undefined) return true;
      const location = noteRepository.getNoteLocation(note.id, conn);
      return location !== null && location.folderId === folderId;
    });
    const items = filtered.map(([, snippet]) => {
      const text = snippet ?? '';
      const [bounded, truncated] = takeChars(text, READ_TRUNCATE_CHARS);
      return { id: '', title: '', snippet: bounded, truncated };
    });
    // Fill id/title from the paired note without re-reading the repository.
    for (let index = 0; index < items.length; index += 1) {
      const [note] = filtered[index] as [import('../api.ts').VfsNote, string | null];
      (items[index] as { id: string }).id = note.id;
      (items[index] as { title: string }).title = note.title;
    }
    const totalExact = items.length < searchLimit;
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, items.length);
    const pageItems = start < items.length ? items.slice(start, end) : [];
    const resultsWithPaths = pageItems.map((item) => ({ ...item, ...this.notePath(conn, item.id) }));
    return {
      results: resultsWithPaths,
      count: resultsWithPaths.length,
      page,
      pageSize,
      hasMore: end < items.length,
      total: items.length,
      totalExact,
    };
  }

  private create(
    ports: CanvasToolExecutorPorts,
    args: Args,
    ctx: ExecutionContext,
  ): Record<string, unknown> {
    const rawTitle = args.title;
    if (typeof rawTitle !== 'string') throw new Error('缺少必需参数: title');
    if (rustTrim(rawTitle).length === 0) throw new Error('笔记标题不能为空');
    const content = stringArg(args, 'content') ?? '';
    const tags = stringArrayArg(args.tags) ?? [];
    const rawFolder = args.folder_id ?? args.folderId;
    const folderId = typeof rawFolder === 'string' && rustTrim(rawFolder).length > 0
      ? rustTrim(rawFolder) : null;
    const origin = {
      kind: 'chat',
      sessionId: ctx.ids.sessionId,
      messageId: ctx.ids.messageId,
    };
    const { payload, noteId } = createNoteInVfs(
      ports.conn(), rawTitle, content, tags, folderId, origin);
    emitNoteUpdatedWatch(ctx, noteId, ports.conn());
    return payload;
  }

  private remove(
    ports: CanvasToolExecutorPorts,
    noteId: string,
    args: Args,
    ctx: ExecutionContext,
  ): Record<string, unknown> {
    const expected = requireExpectedRevision(
      args, '软删除笔记前必须提供 note_read 返回的 expected_updated_at');
    const conn = ports.conn();
    const note = noteRepository.getNote(noteId, conn);
    if (note === null) throw new Error(`笔记不存在: ${noteId}`);
    noteRepository.deleteNoteIfVersion(noteId, expected, conn);
    emitNoteDeletedWatch(ctx, noteId);
    return {
      success: true,
      noteId,
      path: noteNodePath(noteId),
      softDeleted: true,
      reversible: true,
      restoreWith: 'builtin-dstu_restore',
    };
  }

  private updateTags(
    ports: CanvasToolExecutorPorts,
    noteId: string,
    args: Args,
    ctx: ExecutionContext,
  ): Record<string, unknown> {
    const expected = requireExpectedRevision(
      args, '更新笔记标签前必须提供 note_read 返回的 expected_updated_at');
    const rawTags = args.tags;
    if (!Array.isArray(rawTags) || !rawTags.every((tag) => typeof tag === 'string')) {
      throw new Error('tags 必须是字符串数组');
    }
    const tags = rawTags as string[];
    if (tags.some((tag) => rustTrim(tag).length === 0)) {
      throw new Error('tags 不允许包含空字符串');
    }
    const conn = ports.conn();
    const previous = noteRepository.getNote(noteId, conn);
    if (previous === null) throw new Error(`笔记不存在: ${noteId}`);
    const updated = noteRepository.updateNote(noteId, { tags, expectedUpdatedAt: expected }, conn);
    emitNoteUpdatedWatch(ctx, updated.id, conn);
    return {
      success: true,
      noteId: updated.id,
      tags: updated.tags,
      previousTags: previous.tags,
      updatedAt: updated.updatedAt,
      reversible: true,
    };
  }

  private async writeWithAcr(
    ports: CanvasToolExecutorPorts,
    call: AgentToolCall,
    stripped: string,
    noteId: string,
    args: Args,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const receipt = await this.tryFrontendDelegate(ports, call, stripped, noteId, args, ctx);
    if (receipt !== null) return receipt;
    const output = await this.writeBackend(ports, stripped, noteId, args, ctx);
    return { ...output, message: BACKEND_FALLBACK_MESSAGE, mode: 'backend' };
  }

  private async writeBackend(
    ports: CanvasToolExecutorPorts,
    stripped: string,
    noteId: string,
    args: Args,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const expected = requireExpectedRevision(
      args, '笔记后端 read-modify-write 缺少 expected_updated_at');
    const conn = ports.conn();
    const before = noteRepository.getNoteWithContent(noteId, conn);
    if (before === null) throw new Error('读取笔记失败: 笔记不存在或已被删除');
    const [beforeNote, beforeContent] = before;
    if (stripped === canvasToolNames.NOTE_APPEND) {
      const content = stringArg(args, 'content');
      if (content === null) throw new Error('缺少必需参数: content');
      const section = stringArg(args, 'section');
      const after = appendMarkdownContent(beforeContent, content, section);
      let updated;
      try {
        updated = noteRepository.updateNote(noteId, { content: after, expectedUpdatedAt: expected }, conn);
      } catch (error) {
        throw new Error(noteCasError('追加内容 CAS 失败', toolErrorText(error), isRevisionConflict(error)));
      }
      emitNoteUpdatedWatch(ctx, noteId, conn);
      return {
        noteId,
        success: true,
        affectedCount: charCount(content),
        backendExecuted: true,
        beforePreview: takeChars(beforeContent, PREVIEW_CHARS),
        afterPreview: takeChars(after, PREVIEW_CHARS),
        addedContent: takeChars(content, ADDED_CONTENT_CHARS),
        updatedAt: updated.updatedAt,
      };
    }
    if (stripped === canvasToolNames.NOTE_SET) {
      const content = stringArg(args, 'content');
      if (content === null) throw new Error('缺少必需参数: content');
      let updated;
      try {
        updated = noteRepository.updateNote(noteId, { content, expectedUpdatedAt: expected }, conn);
      } catch (error) {
        throw new Error(noteCasError('设置内容 CAS 失败', toolErrorText(error), isRevisionConflict(error)));
      }
      emitNoteUpdatedWatch(ctx, noteId, conn);
      return {
        noteId,
        success: true,
        wordCount: charCount(content),
        backendExecuted: true,
        beforePreview: takeChars(beforeContent, PREVIEW_CHARS),
        afterPreview: takeChars(content, PREVIEW_CHARS),
        updatedAt: updated.updatedAt,
      };
    }
    if (stripped === canvasToolNames.NOTE_REPLACE) {
      const search = stringArg(args, 'search');
      if (search === null) throw new Error('缺少必需参数: search');
      if (search.length === 0) throw new Error('搜索模式不能为空');
      const replacement = stringArg(args, 'replace');
      if (replacement === null) throw new Error('缺少必需参数: replace');
      const flag = args.isRegex ?? args.is_regex;
      const isRegex = typeof flag === 'boolean' ? flag : false;
      let replaced;
      try {
        replaced = await replaceContent(
          beforeContent, search, replacement, isRegex, ports.nativeRegex?.(),
        );
      } catch (error) {
        throw new Error(toolErrorText(error));
      }
      if (replaced.count === 0) throw new Error('未找到要替换的内容');
      let updated;
      try {
        updated = noteRepository.updateNote(
          noteId, { content: replaced.next, expectedUpdatedAt: expected }, conn);
      } catch (error) {
        throw new Error(noteCasError('替换内容 CAS 失败', toolErrorText(error), isRevisionConflict(error)));
      }
      emitNoteUpdatedWatch(ctx, noteId, conn);
      return {
        noteId,
        success: true,
        replaceCount: replaced.count,
        backendExecuted: true,
        newWordCount: charCount(replaced.next),
        searchPattern: search,
        replaceWith: replacement,
        beforePreview: takeChars(beforeContent, PREVIEW_CHARS),
        afterPreview: takeChars(replaced.next, PREVIEW_CHARS),
        updatedAt: updated.updatedAt,
      };
    }
    throw new Error(`未知的写入操作: ${stripped}`);
  }

  /** R1-03: probe → frontend apply_ops; null means the backend path may run. */
  private async tryFrontendDelegate(
    ports: CanvasToolExecutorPorts,
    call: AgentToolCall,
    stripped: string,
    noteId: string,
    args: Args,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown> | null> {
    const expected = requireExpectedRevision(args, '笔记写入缺少 expected_updated_at');
    const acr = ports.acr;
    if (acr === null || acr === undefined) return null;
    const conn = ports.conn();
    verifyNoteRevision(conn, noteId, expected);

    const gates = acr.gates();
    let enabled: boolean;
    try {
      enabled = notesAgentBridge().isWorkbenchAgentDelegationEnabled(gates);
    } catch (error) {
      throw new Error(destructiveProbeUnavailable(
        `ACR 闸门状态不可用: ${toolErrorText(error)}`));
    }
    if (!enabled) {
      notesLog.debug('[CanvasToolExecutor] ACR dual gate disabled; use OCC backend data plane');
      return null;
    }

    const events = acr.eventsForCall === undefined ? acr.events : acr.eventsForCall(ctx);
    if (events === null) {
      throw new Error(destructiveProbeUnavailable(
        'ACR 前端委托缺少发起工具调用的窗口（ExecutionContext.window_ref）'));
    }
    const bridgeCtx = {
      sessionId: ctx.ids.sessionId,
      toolCallId: call.id,
      events,
      cancel: ctx.cancel,
      logger: acr.logger,
      ...(acr.uuid === undefined ? {} : { uuid: acr.uuid }),
      ...(acr.drainMs === undefined ? {} : { drainMs: acr.drainMs }),
    };
    const target = { typeId: 'note', resourceId: noteId };

    let probe;
    try {
      probe = await notesAgentBridge().acrBridgeCall(
        bridgeCtx, 'probe', { target }, notesAgentBridge().probeTimeoutMs);
    } catch (error) {
      const message = toolErrorText(error);
      if (notesAgentBridge().isBridgeCancelled(message)) {
        return cancelledReceipt(noteId, '用户取消；未写入。请根据 done/undone 继续，勿原样重试。');
      }
      throw new Error(destructiveProbeUnavailable(`笔记写入的 probe 失败: ${message}`));
    }
    if (!probe.ok) {
      throw new Error(destructiveProbeUnavailable(
        `笔记写入的 probe 被拒绝: ${probe.error ?? '未知错误'}`));
    }
    const probeData = (probe.data ?? null) as Record<string, unknown> | null;
    const probeState = extractProbeState(probeData);
    if (probeState === null) {
      throw new Error(destructiveProbeUnavailable('笔记写入的 probe 回执缺少有效 state'));
    }
    const rawWindowId = probeData?.windowId;
    const windowId = typeof rawWindowId === 'string' && rustTrim(rawWindowId).length > 0
      ? rawWindowId : null;
    if (!shouldDelegateFrontend(probeState)) {
      notesLog.info(`[CanvasToolExecutor] ACR probe state=${probeState}, fallback backend`);
      if (!isSafeBackendFallbackState(probeState)) {
        throw new Error(destructiveProbeUnavailable(
          `probe state=${probeState} 未证明编辑器可安全回落`));
      }
      return null;
    }
    if (windowId === null) {
      throw new Error(destructiveProbeUnavailable('probe 声称可前端委托，但未返回精确 windowId'));
    }
    if (ctx.isCancelled()) {
      return cancelledReceipt(
        noteId, '用户在提交写入前取消；未改动笔记，不可自动重试。', { retryable: false });
    }
    // Probe/feature-gate I/O may take long enough for another writer to advance the note.
    verifyNoteRevision(conn, noteId, expected);

    const { op, destructive } = buildNoteAgentOp(stripped, args);
    const opLabel = typeof op.label === 'string' ? op.label : 'note op';
    const ops = [op];
    const applyTimeout = notesAgentBridge().applyOpsTimeoutMs(1, 'normal');
    let applied;
    try {
      applied = await notesAgentBridge().acrBridgeCall(bridgeCtx, 'apply_ops', {
        target: { typeId: 'note', resourceId: noteId, windowId },
        ops,
        pacing: 'normal',
        destructive,
      }, applyTimeout);
    } catch (error) {
      const message = toolErrorText(error);
      notesLog.warn(`[CanvasToolExecutor] ACR apply_ops bridge error; no backend fallback: ${message}`);
      return notesAgentBridge().uncertainApplyReceipt([noteId], [opLabel], message);
    }
    if (!applied.ok) {
      const error = applied.error ?? 'ACR apply_ops returned ok=false';
      notesLog.warn(`[CanvasToolExecutor] ACR apply_ops ok=false; no backend fallback: ${error}`);
      try {
        const parsed = JSON.parse(error) as unknown;
        if (parsed !== null && typeof parsed === 'object'
          && (parsed as { code?: unknown }).code !== undefined) {
          throw new Error(error);
        }
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message === error) throw parseError;
      }
      return notesAgentBridge().uncertainApplyReceipt([noteId], [opLabel], error);
    }
    const receipt = applied.data;
    if (receipt === null || receipt === undefined) {
      return notesAgentBridge().uncertainApplyReceipt([noteId], [opLabel], 'ACR apply_ops returned no receipt');
    }
    if (!notesAgentBridge().isValidApplyReceipt(receipt)) {
      return notesAgentBridge().uncertainApplyReceipt([noteId], [opLabel], 'ACR apply_ops returned malformed receipt');
    }
    const output = receipt as Record<string, unknown>;
    if (output.message === undefined) output.message = FRONTEND_DELEGATE_MESSAGE;
    if (output.mode === undefined) output.mode = 'frontend';
    output.noteId = noteId;
    output.frontendDelegated = true;
    output.probeState = probeState;
    notesLog.info(
      `[CanvasToolExecutor] ACR frontend apply_ops returned: note_id=${noteId}, probe=${probeState}, status=${String(output.status)}`,
    );
    return output;
  }
}

type Args = Record<string, unknown>;

function stringArg(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function optionalSection(args: Args): string | null {
  const value = stringArg(args, 'section');
  return value !== null && rustTrim(value).length > 0 ? value : null;
}

/** Rust str::lines(): split on LF, strip one trailing CR, no trailing empty item. */
function rustLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function markdownHeadingLevel(line: string): number | null {
  const trimmed = rustTrim(line);
  let level = 0;
  while (level < trimmed.length && trimmed[level] === '#') level += 1;
  if (level === 0 || level > 6) return null;
  const rest = trimmed.slice(level);
  return rest.length === 0 || rest.startsWith(' ') ? level : null;
}

function markdownSectionBounds(content: string, sectionTitle: string): [number, number] | null {
  const lines = rustLines(content);
  const wanted = rustTrim(sectionTitle).toLowerCase();
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = rustTrim((lines[index] as string));
    const current = markdownHeadingLevel(trimmed);
    if (current === null) continue;
    const title = rustTrim(trimmed.replace(/^#+/, '')).toLowerCase();
    if (title === wanted || trimmed.toLowerCase() === wanted) {
      start = index;
      level = current;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = markdownHeadingLevel(lines[index] as string);
    if (next !== null && next <= level) {
      end = index;
      break;
    }
  }
  return [start, end];
}

export function readMarkdownSection(content: string, sectionTitle: string): string | null {
  const lines = rustLines(content);
  const bounds = markdownSectionBounds(content, sectionTitle);
  if (bounds === null) return null;
  const [start, end] = bounds;
  return rustTrim(lines.slice(start + 1, end).join('\n'));
}

export function appendMarkdownContent(
  content: string,
  appendContent: string,
  section?: string | null,
): string {
  const sectionTitle = section !== undefined && section !== null && rustTrim(section).length > 0
    ? section : null;
  if (sectionTitle !== null) {
    const lines = rustLines(content);
    const bounds = markdownSectionBounds(content, sectionTitle);
    if (bounds === null) throw new Error(`章节 '${sectionTitle}' 未找到`);
    const end = bounds[1];
    return [
      ...lines.slice(0, end),
      '',
      appendContent,
      ...lines.slice(end),
    ].join('\n');
  }
  return rustTrim(content).length === 0 ? appendContent : `${rustTrimEnd(content)}\n\n${appendContent}`;
}

export function expectedNoteRevision(args: Args): string | null {
  const raw = args.expected_updated_at ?? args.expectedUpdatedAt;
  if (typeof raw !== 'string') return null;
  const trimmed = rustTrim(raw);
  return trimmed.length === 0 ? null : trimmed;
}

export function noteOccRequired(reason: string): string {
  return JSON.stringify({
    code: 'NOTE_OCC_REQUIRED',
    message: reason,
    hint: '先读取笔记的 updated_at，再以 expected_updated_at 重新提交；不得无条件覆写',
    retryable: false,
  });
}

export function noteRevisionConflict(expected: string, actual: string): string {
  return JSON.stringify({
    code: 'NOTE_CONFLICT',
    message: '笔记版本与 expected_updated_at 不一致',
    expectedUpdatedAt: expected,
    actualUpdatedAt: actual,
    hint: '重新调用 note_read，基于最新内容与 updatedAt 重新规划',
    retryable: false,
  });
}

export function noteCasError(operation: string, error: string, conflictOverride?: boolean): string {
  const conflict = conflictOverride ?? error.toLowerCase().includes('conflict');
  return JSON.stringify({
    code: conflict ? 'NOTE_CONFLICT' : 'NOTE_WRITE_FAILED',
    message: `${operation}: ${error}`,
    hint: conflict
      ? '笔记已发生变化；重新读取内容与 updated_at，基于新版本重新规划'
      : '写入未完成；检查笔记存储状态后再决定是否重试',
    retryable: false,
  });
}

export function destructiveProbeUnavailable(reason: string): string {
  return JSON.stringify({
    code: 'WORKBENCH_UNAVAILABLE',
    message: reason,
    hint: '无法确认编辑器是否存在未保存内容；重新 probe，或在明确 closed/disabled 后携带 expected_updated_at 走后端 CAS',
    retryable: false,
  });
}

export function withLocalizedMessage(
  payload: Record<string, unknown>,
  messageKey: string,
  messageParams: Record<string, unknown>,
  zhCn: string,
  enUs: string,
): Record<string, unknown> {
  return {
    ...payload,
    messageKey,
    messageParams,
    messageFallback: { 'zh-CN': zhCn, 'en-US': enUs },
    message: `${zhCn} / ${enUs}`,
  };
}

export function noteCreateError(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof NoteDatabaseError && reason.startsWith('Folder not found: ')) {
    const folderId = reason.slice('Folder not found: '.length);
    return JSON.stringify(withLocalizedMessage(
      { code: 'NOTE_FOLDER_NOT_FOUND', retryable: false },
      'chat.tools.canvas.note_create.folder_not_found',
      { folderId },
      `目标文件夹不存在：${folderId}`,
      `Target folder does not exist: ${folderId}`,
    ));
  }
  return JSON.stringify(withLocalizedMessage(
    { code: 'NOTE_CREATE_FAILED', retryable: false },
    'chat.tools.canvas.note_create.failed',
    { reason },
    `创建笔记失败：${reason}`,
    `Failed to create note: ${reason}`,
  ));
}

export const NOTE_ORIGIN_PROP_KEY = '_origin';

/** `note_create` backend path: create in the requested folder, then record the origin. */
export function createNoteInVfs(
  conn: SqlExecutor,
  title: string,
  content: string,
  tags: readonly string[],
  folderId: string | null,
  origin: unknown | null,
): { payload: Record<string, unknown>; noteId: string } {
  let noteId: string;
  let noteTitle: string;
  try {
    const note = noteRepository.createNoteInFolder(
      { title, content, tags: [...tags] }, folderId, conn);
    noteId = note.id;
    noteTitle = note.title;
  } catch (error) {
    throw new Error(noteCreateError(error));
  }
  if (origin !== null && origin !== undefined) {
    // Origin recording must never fail note creation; the note already exists.
    try {
      noteRepository.updateNoteMetadata(noteId, {
        props: { [NOTE_ORIGIN_PROP_KEY]: JSON.stringify(origin) },
      }, conn);
    } catch (error) {
      notesLog.warnError(`[CanvasToolExecutor] Failed to record note origin for ${noteId}`, error);
    }
  }
  return {
    payload: {
      noteId,
      title: noteTitle,
      wordCount: charCount(content),
      folderId,
      success: true,
    },
    noteId,
  };
}

export interface NoteAgentOp {
  kind: 'note_insert' | 'note_replace' | 'note_set';
  anchor: { position: 'end' | 'afterHeading'; heading?: string };
  payload: Record<string, unknown>;
  destructive: boolean;
  label: string;
}

/** DESIGN §5.2: note_append afterHeading/end; replace/set全文 with optional heading. */
export function buildNoteAgentOp(toolName: string, args: Args): { op: NoteAgentOp; destructive: boolean } {
  const section = optionalSection(args);
  const anchorFor = (position: 'end' | 'afterHeading'): NoteAgentOp['anchor'] => {
    const anchor: NoteAgentOp['anchor'] = { position };
    if (section !== null) anchor.heading = section;
    return anchor;
  };
  if (toolName === canvasToolNames.NOTE_APPEND) {
    const content = stringArg(args, 'content');
    if (content === null) throw new Error('缺少必需参数: content');
    if (content.length === 0) throw new Error('缺少必需参数: content（内容不能为空）');
    const label = section !== null
      ? `追加内容到章节「${section}」`
      : '追加内容到笔记末尾';
    return {
      op: {
        kind: 'note_insert',
        anchor: section !== null && rustTrim(section).length > 0
          ? { position: 'afterHeading', heading: section }
          : { position: 'end' },
        payload: { content },
        destructive: false,
        label,
      },
      destructive: false,
    };
  }
  if (toolName === canvasToolNames.NOTE_REPLACE) {
    const search = stringArg(args, 'search');
    if (search === null) throw new Error('缺少必需参数: search');
    if (search.length === 0) throw new Error('搜索模式不能为空');
    const replace = stringArg(args, 'replace');
    if (replace === null) throw new Error('缺少必需参数: replace');
    const flag = args.isRegex ?? args.is_regex;
    const isRegex = typeof flag === 'boolean' ? flag : false;
    return {
      op: {
        kind: 'note_replace',
        anchor: anchorFor('end'),
        payload: { search, replace, isRegex },
        destructive: true,
        label: `替换笔记内容（模式长度 ${charCount(search)}）`,
      },
      destructive: true,
    };
  }
  if (toolName === canvasToolNames.NOTE_SET) {
    const content = stringArg(args, 'content');
    if (content === null) throw new Error('缺少必需参数: content');
    return {
      op: {
        kind: 'note_set',
        anchor: anchorFor('end'),
        payload: { content },
        destructive: true,
        label: '设置笔记完整内容',
      },
      destructive: true,
    };
  }
  throw new Error(`未知的写入操作: ${toolName}`);
}
