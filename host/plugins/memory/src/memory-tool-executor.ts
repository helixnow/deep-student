/**
 * `MemoryToolExecutor` — Rust `src-tauri/src/chat_v2/tools/memory_executor.rs`
 * (`execute_search/read/write/list/update_by_id/delete` and the `execute` result mapping).
 * Smart/batch writes, curation and learner-profile bodies live in `memory-tools-curation.ts`;
 * argument parsing and routing tables stay in `memory-executor.ts`.
 */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { containsSensitivePattern } from './json.ts';
import {
  MEMORY_TOOL_NAMES, listPagination, memoryConcurrency, memorySensitivity, needsRootBootstrap,
} from './memory-executor.ts';
import * as curation from './memory-tools-curation.ts';
import { stripToolNamespace } from './paper-save.ts';
import type { MemoryServiceImpl, WriteMode } from './service.ts';

/** Memory tools with host execution bodies (all of Rust `is_memory_tool`). */
export const MEMORY_EXECUTABLE_TOOL_NAMES = MEMORY_TOOL_NAMES;

/** Rust per-tool `ctx.is_cancelled()` errors raised before `get_service`. */
const CANCELLED_BEFORE_START: Record<string, () => string> = {
  memory_batch_move: () => curation.invalidArgs('cancellation', '批量移动在开始前已取消',
    'The batch move was cancelled before it started.'),
  memory_add_relation: () => curation.invalidArgs('cancellation', '关联操作在开始前已取消',
    'The relation operation was cancelled before it started.'),
  memory_remove_relation: () => curation.invalidArgs('cancellation', '关联操作在开始前已取消',
    'The relation operation was cancelled before it started.'),
  memory_update_tags: () => curation.invalidArgs('cancellation', '标签更新在开始前已取消',
    'The tag update was cancelled before it started.'),
  memory_log_activity: () => curation.invalidArgs('cancellation', '学习活动记录在开始前已取消',
    'The activity logging was cancelled before it started.'),
  memory_export_all: () => curation.invalidArgs('cancellation', '记忆导出在开始前已取消',
    'The memory export was cancelled before it started.'),
  learner_profile_get: () => 'Learner profile get cancelled before start',
  learner_profile_update: () => 'Learner profile update cancelled before start',
};

export interface MemoryToolLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface MemoryToolDeps {
  /** `MemoryService::new(vfs_db, lance, llm)`; `null` ⇔ Rust "VFS database not available". */
  service(): MemoryServiceImpl | null;
  /** Rust `ctx.llm_manager.is_some()`. */
  llmAvailable(): boolean;
  /** Window event broadcast (`ctx.window_ref().emit`). */
  emit(event: string, payload: unknown): void;
  log: MemoryToolLog;
}

type Args = Record<string, unknown>;
type Body = (args: Args, service: MemoryServiceImpl, ctx: ExecutionContext) => Promise<unknown>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `WriteMode::from_str`. */
export function parseWriteMode(value: string, warn: (message: string) => void): WriteMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'update') return 'update';
  if (normalized === 'append') return 'append';
  if (normalized !== 'create') warn(`[Memory] Unknown WriteMode '${value}', defaulting to Create`);
  return 'create';
}

/** Races a body against the turn's cancellation (Rust `tokio::select!` with `cancel_token.cancelled()`). */
async function cancellable<T>(ctx: ExecutionContext, task: Promise<T>, message: string, log: MemoryToolLog,
  label: string): Promise<T> {
  const signal = ctx.cancellation_token;
  if (signal === null) return task;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      log.info(`[MemoryToolExecutor] Memory ${label} cancelled`);
      reject(new Error(message));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([task, cancelled]); }
  finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort); }
}

export class MemoryToolExecutor implements ToolExecutor {
  private readonly deps: MemoryToolDeps;
  private readonly bodies: Record<string, Body>;

  constructor(deps: MemoryToolDeps) {
    this.deps = deps;
    const env: curation.CurationEnv = {
      log: deps.log,
      emit: (event, payload) => deps.emit(event, payload),
      cancellable: (ctx, task, message, label) => cancellable(ctx, task, message, deps.log, label),
    };
    this.bodies = {
      memory_search: (args, service, ctx) => this.search(args, service, ctx),
      memory_read: (args, service) => this.read(args, service),
      memory_write: (args, service) => this.write(args, service),
      memory_list: async (args, service) => this.list(args, service),
      memory_update_by_id: (args, service) => this.updateById(args, service),
      memory_delete: (args, service) => this.remove(args, service),
      memory_write_smart: (args, service, ctx) => curation.writeSmart(args, service, ctx, env),
      memory_write_batch: (args, service, ctx) => curation.writeBatch(args, service, ctx),
      memory_batch_move: (args, service, ctx) => curation.batchMove(args, service, ctx, env),
      memory_add_relation: (args, service, ctx) => curation.relation(args, service, ctx, env, true),
      memory_remove_relation: (args, service, ctx) => curation.relation(args, service, ctx, env, false),
      memory_update_tags: (args, service, ctx) => curation.updateTags(args, service, ctx, env),
      memory_log_activity: (args, service) => curation.logActivity(args, service),
      memory_export_all: (args, service) => curation.exportAll(args, service),
      learner_profile_get: (_args, service) => curation.learnerProfileGet(service),
      learner_profile_update: (args, service, ctx) => curation.learnerProfileUpdate(args, service, ctx),
    };
  }

  name(): string { return 'MemoryToolExecutor'; }
  canHandle(toolName: string): boolean { return Object.hasOwn(this.bodies, stripToolNamespace(toolName)); }
  sensitivityLevel(toolName: string): ToolSensitivity { return memorySensitivity(toolName); }
  concurrencyClass(toolName: string): ToolConcurrency { return memoryConcurrency(toolName); }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    const stripped = stripToolNamespace(call.name);
    const args = call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? call.arguments as Args : {};
    let output: unknown;
    let failure: string | null = null;
    try { output = await this.dispatch(stripped, call.name, args, ctx); }
    catch (error) { failure = errorText(error); }
    const durationMs = Math.floor(performance.now() - started);
    const base = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, durationMs };
    if (failure !== null) {
      ctx.emitToolCallError(failure);
      return { ...base, output: null, success: false, error: failure };
    }
    // memory_executor.rs:2121 — a top-level `success: false` is a tool-level failure; the payload is kept.
    const record = output !== null && typeof output === 'object' && !Array.isArray(output)
      ? output as Record<string, unknown> : null;
    if (record !== null && record.success === false) {
      const message = typeof record.error === 'string' ? record.error : 'memory operation failed';
      ctx.emitToolCallError(message);
      return { ...base, output, success: false, error: message };
    }
    ctx.emitToolCallEnd({ result: output, durationMs });
    return { ...base, output, success: true };
  }

  private async dispatch(stripped: string, rawName: string, args: Args, ctx: ExecutionContext): Promise<unknown> {
    const body = this.bodies[stripped];
    if (body === undefined) throw new Error(`Unknown memory tool: ${rawName}`);
    if (ctx.isCancelled()) {
      const early = CANCELLED_BEFORE_START[stripped];
      const label = stripped.replace('memory_', '').replace('update_by_id', 'update');
      throw new Error(early === undefined ? `Memory ${label} cancelled before start` : early());
    }
    const service = this.service();
    const hint = this.ensureRootConfigured(service);
    if (hint !== null) return hint;
    return body(args, service, ctx);
  }

  /** memory_executor.rs:448 `get_service`. */
  private service(): MemoryServiceImpl {
    const service = this.deps.service();
    if (service === null) throw new Error('VFS database not available');
    if (!this.deps.llmAvailable()) throw new Error('LLM manager not available');
    return service;
  }

  /** memory_executor.rs:472 `ensure_root_configured`: failures are returned as (successful) hints. */
  private ensureRootConfigured(service: MemoryServiceImpl): Record<string, unknown> | null {
    let rootId: string | null;
    try { rootId = service.getConfig().memoryRootFolderId ?? null; }
    catch (error) { return { error: '记忆功能配置读取失败', details: errorText(error) }; }
    if (!needsRootBootstrap(rootId)) return null;
    try {
      const folderId = service.getOrCreateRootFolder();
      this.deps.log.info(`[MemoryToolExecutor] Auto-created memory root folder for first use: ${folderId}`);
      return null;
    } catch (error) {
      return {
        error: '记忆根文件夹初始化失败',
        hint: '请前往「学习资源中心 > 记忆管理」手动设置记忆根文件夹，或前往数据治理进行修复',
        details: errorText(error),
        action_required: true,
      };
    }
  }

  /** memory_executor.rs:497 `execute_search`. */
  private async search(args: Args, service: MemoryServiceImpl, ctx: ExecutionContext): Promise<unknown> {
    const query = asStr(args.query);
    if (query === null) throw new Error("Missing 'query' parameter");
    const topK = typeof args.top_k === 'number' && Number.isInteger(args.top_k) && args.top_k >= 0 ? args.top_k : 5;
    const results = await cancellable(ctx, service.searchWithRerank(query, topK, false),
      'Memory search cancelled during execution', this.deps.log, 'search');
    return {
      sources: results.map(item => ({
        title: item.noteTitle, snippet: item.chunkText, score: item.score,
        metadata: { document_id: item.noteId, memory_id: item.noteId, note_id: item.noteId,
          folder_path: item.folderPath, source_type: 'memory' },
      })),
      results,
      count: results.length,
    };
  }

  /** memory_executor.rs:568 `execute_read`. */
  private async read(args: Args, service: MemoryServiceImpl): Promise<unknown> {
    const noteId = asStr(args.note_id);
    if (noteId === null) throw new Error("Missing 'note_id' parameter");
    const note = service.read(noteId);
    if (note === null) return { found: false, note_id: noteId };
    // System notes (`__user_profile__`, `__cat_*`) stay out of usage statistics.
    if (!note.title.startsWith('__')) {
      const usedId = note.noteId;
      queueMicrotask(() => service.recordUsed([usedId]));
    }
    const tags = service.getTags(note.noteId);
    const references = tags.filter(tag => tag.startsWith('_ref:')).map(tag => tag.slice('_ref:'.length));
    let related = references;
    try { related = service.filterAlive(references); }
    catch (error) { this.deps.log.warn(`[MemoryToolExecutor] Failed to filter dangling _ref targets: ${errorText(error)}`); }
    return {
      found: true, note_id: note.noteId, title: note.title, content: note.content, folder_path: note.folderPath,
      tags, related_note_ids: related, updated_at: note.updatedAt,
    };
  }

  private afterWrite(service: MemoryServiceImpl, resourceId: string): void {
    void service.triggerImmediateIndex(resourceId);
    void service.spawnPostWriteMaintenance();
  }

  /** memory_executor.rs:659 `execute_write`. */
  private async write(args: Args, service: MemoryServiceImpl): Promise<unknown> {
    const noteId = asStr(args.note_id);
    const title = asStr(args.title);
    const content = asStr(args.content);
    const folder = asStr(args.folder);
    if (content !== null && containsSensitivePattern(content)) {
      this.auditFiltered(service, title ?? '', content, '包含敏感信息（手机号/身份证/银行卡/邮箱/密码）');
      return { success: false, error: '内容包含敏感信息，已拦截。请勿在记忆中存储个人敏感信息。' };
    }
    if (title !== null && containsSensitivePattern(title)) {
      this.auditFiltered(service, title, content ?? '', '标题包含敏感信息');
      return { success: false, error: '标题包含敏感信息，已拦截。' };
    }
    const mode = parseWriteMode(asStr(args.mode) ?? (noteId !== null ? 'update' : 'create'),
      message => this.deps.log.warn(message));
    const started = performance.now();
    let result;
    if (noteId !== null) {
      if (mode === 'append') {
        const current = service.read(noteId)?.content ?? '';
        if (content === null) throw new Error("Missing 'content' parameter");
        result = service.updateById(noteId, title, `${current}\n\n${content}`, 'tool_call');
      } else {
        if (title === null && content === null) throw new Error("Missing 'title' or 'content' parameter");
        result = service.updateById(noteId, title, content, 'tool_call');
      }
    } else {
      if (title === null) throw new Error("Missing 'title' parameter");
      if (content === null) throw new Error("Missing 'content' parameter");
      result = service.write(folder, title, content, mode);
      service.audit({
        source: 'tool_call', operation: 'write', success: true, noteId: result.noteId, title, contentPreview: content,
        folder, event: result.isNew ? 'ADD' : 'UPDATE', durationMs: Math.floor(performance.now() - started),
      });
    }
    this.afterWrite(service, result.resourceId);
    return { success: true, note_id: result.noteId, is_new: result.isNew };
  }

  /** `MemoryAuditLogger::log_filtered`. */
  private auditFiltered(service: MemoryServiceImpl, title: string, content: string, reason: string): void {
    service.audit({
      source: 'tool_call', operation: 'write_smart', success: false, title, contentPreview: content,
      event: 'FILTERED', reason, durationMs: 0,
    });
  }

  /** memory_executor.rs:844 `execute_list`. */
  private list(args: Args, service: MemoryServiceImpl): unknown {
    const folder = asStr(args.folder);
    const [limit, offset] = listPagination(args);
    const items = service.list(folder, limit + 1, offset);
    const hasMore = items.length > limit;
    if (hasMore) items.length = limit;
    return {
      items, count: items.length, limit, offset, has_more: hasMore,
      next_offset: hasMore ? offset + items.length : null,
    };
  }

  /** memory_executor.rs:904 `execute_update_by_id`. */
  private async updateById(args: Args, service: MemoryServiceImpl): Promise<unknown> {
    const noteId = asStr(args.note_id);
    if (noteId === null) throw new Error("Missing 'note_id' parameter");
    const title = asStr(args.title);
    const content = asStr(args.content);
    if (title === null && content === null) throw new Error("Missing 'title' or 'content' parameter");
    const result = service.updateById(noteId, title, content, 'tool_call');
    this.afterWrite(service, result.resourceId);
    return { success: true, note_id: result.noteId, is_new: result.isNew };
  }

  /** memory_executor.rs:986 `execute_delete`. */
  private async remove(args: Args, service: MemoryServiceImpl): Promise<unknown> {
    const noteId = asStr(args.note_id);
    if (noteId === null) throw new Error("Missing 'note_id' parameter");
    await service.delete(noteId, 'tool_call');
    void service.spawnPostWriteMaintenance();
    return { success: true, note_id: noteId };
  }
}
