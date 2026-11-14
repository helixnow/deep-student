/** builtin_retrieval_executor.rs:126-928,1127-1249,2065-2089. */
import type { Context } from '@deepseek-ai/cordis';
import type { ExecutionContext, SourceInfo, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { MemorySearchResult } from '../../../memory/api.ts';
import type { QueryModality, RetrievalRouteFailure, UnifiedRetrievalRequest, UnifiedRetrievalResponse } from '../../../vfs-index/api.ts';
import type { SearchInput, SearchResult, ToolConfig } from '../../../mcp/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import type {} from '../../../mcp/api.ts';
import type {} from '../../../chat-pipeline/api.ts';
import type {} from '../../../../platform/settings/api.ts';
import { stripToolNamespace } from '../../../agent-skills/portable.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { ensure_localized_error, with_localized_message, type JsonValue } from '../../../../platform/errors/api.ts';
import { mediaCitation } from '../media-index.ts';
import { expandSessionRagFolderScopeWithConn, memoryNoteResourceIdsWithConn } from '../../repository/retrieval-tools.ts';
import { applyScoreThresholds, buildNumberedSources, dedupKbAgainstMemory, objectOf, plannedSearchScope,
  scopeFolderIds, selectRerankerKind, shouldRouteToUnifiedSearch, stringOf } from './retrieval-sources.ts';
import { skippedRerank, textRerankSources, vlRerankSources, type RetrievalRerankerPort } from './retrieval-rerank.ts';
import { toolVfsRepos } from './tool-services.ts';

/** Retained request type; runtime now imports the published F4 functions directly. */
export interface RetrievalToolArgsPort {
  ensureLocalizedError(raw: string, code: string, messageKey: string, zh: string, en: string): string;
  withLocalizedMessage(payload: Record<string, unknown>, messageKey: string, params: unknown, zh: string, en: string): Record<string, unknown>;
}
export interface CompressedRetrievalMemory { noteId: string | null; noteTitle: string; folderPath: string; chunkText: string; score: number; sourceNoteIds: string[] }
export interface MemoryRetrievalPort {
  getRootFolderId(): string | null;
  search(query: string, topK: number, signal: AbortSignal | null): Promise<MemorySearchResult[]>;
  compress(query: string, results: MemorySearchResult[]): Promise<CompressedRetrievalMemory[]>;
}
/** Owner must cancel in-flight work on signal, matching tokio::select dropping the search future. */
export interface CancellableRetrievalPort {
  search(request: UnifiedRetrievalRequest, signal: AbortSignal | null): Promise<UnifiedRetrievalResponse>;
  searchMultimodal(request: UnifiedRetrievalRequest, signal: AbortSignal | null): Promise<UnifiedRetrievalResponse>;
}
export interface CancellableWebSearchPort {
  loadConfig(settings: SettingsStore | null): Promise<ToolConfig>;
  doSearch(config: ToolConfig, request: SearchInput, signal: AbortSignal | null): Promise<SearchResult>;
}
export interface ChatRetrievalScopePort {
  loadSessionRagScope(database: NonNullable<ExecutionContext['chat_v2_db']>, sessionId: string): string[] | null;
}
export interface RetrievalToolDeps { reranker: RetrievalRerankerPort; memory: MemoryRetrievalPort; scope: ChatRetrievalScopePort }
export type RetrievalToolContext = Pick<ExecutionContext, 'session_id' | 'message_id' | 'block_id' | 'variant_id' |
  'chat_v2_db' | 'services' | 'emitter' | 'isCancelled' | 'cancellation_token' | 'rag_top_k' | 'rag_enable_reranking' | 'memory_enabled'>;
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const fail = (message: string): never => { throw new Error(message); };
const elapsed = (start: number) => Math.floor(performance.now() - start);
const uint = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64 ? value : null;
const first = (args: Record<string, unknown>, a: string, b: string): unknown => Object.hasOwn(args, a) ? args[a] : args[b];
export function localizedRetrievalFailure(error: string): string {
  return ensure_localized_error(error, 'RETRIEVAL_OPERATION_FAILED', 'chat.tools.retrieval.error', '检索操作失败', 'The retrieval operation failed.');
}
async function cancellable<T>(operation: () => Promise<T>, signal: AbortSignal | null, message: string, onCancel?: () => void): Promise<T> {
  if (signal === null) return operation();
  if (signal.aborted) { onCancel?.(); return fail(message); }
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => { onCancel?.(); reject(new Error(message)); };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/** Rust registers one executor for all four tools; the host may split it by available services. */
export class BuiltinRetrievalExecutor implements ToolExecutor {
  /** Planned-search services; null for a web_search-only registration. */
  readonly deps: RetrievalToolDeps | null;
  readonly web: boolean;
  constructor(deps: RetrievalToolDeps | null, web = true) { this.deps = deps; this.web = web; }
  name(): string { return 'BuiltinRetrievalExecutor'; }
  canHandle(name: string): boolean {
    const tool = stripToolNamespace(name);
    if (tool === 'web_search') return this.web;
    return this.deps !== null && ['rag_search', 'multimodal_search', 'unified_search'].includes(tool);
  }
  private planned(): RetrievalToolDeps { return this.deps ?? fail('planned retrieval services not available'); }
  sensitivityLevel(_name: string): 'low' { return 'low'; }
  concurrencyClass(_name: string): 'read_only' { return 'read_only'; }

  applySessionScope(ctx: RetrievalToolContext, model: string[] | null): string[] | null {
    const database = ctx.services.get('vfsDatabase');
    if (ctx.chat_v2_db === null || !database) return model;
    const scope = this.planned().scope.loadSessionRagScope(ctx.chat_v2_db, ctx.session_id);
    if (scope === null) return model;
    const expanded = expandSessionRagFolderScopeWithConn(
      database.getConnSafe(),
      toolVfsRepos(ctx.services),
      scope,
    );
    return scopeFolderIds(expanded, model);
  }
  memoryResourceIds(ctx: Context): Set<string> {
    try {
      const root = this.planned().memory.getRootFolderId();
      const database = ctx.get('vfsDatabase');
      if (root === null || database === undefined) return new Set();
      const folders = toolVfsRepos(ctx).folders.getFolderIdsRecursive(database.getConnSafe(), root);
      return memoryNoteResourceIdsWithConn(database.getConnSafe(), folders);
    } catch { return new Set(); }
  }
  async memorySources(query: string, topK: number, ctx: RetrievalToolContext): Promise<[SourceInfo[], RetrievalRouteFailure | null]> {
    const count = Math.min(10, Math.max(3, Math.floor(topK / 2)));
    let results: MemorySearchResult[];
    const cancelled = 'memory route cancelled during unified search';
    try {
      results = await cancellable(() => this.planned().memory.search(query, count, ctx.cancellation_token), ctx.cancellation_token, cancelled,
        () => ctx.services.logger.info('[BuiltinRetrievalExecutor] memory route cancelled during unified search'));
    } catch (error) {
      if (ctx.cancellation_token?.aborted && detail(error) === cancelled) return [[], null];
      ctx.services.logger.warn('[BuiltinRetrievalExecutor] Unified memory route failed: %s', detail(error));
      return [[], { routeId: 'memory:unified', profileId: null, dimension: null, error: detail(error), timedOut: false, queryDerivation: null }];
    }
    const compressed = await this.planned().memory.compress(query, results);
    const sources: SourceInfo[] = compressed.map(row => ({ title: row.noteTitle, url: null, snippet: row.chunkText, score: Math.fround(row.score),
      metadata: { sourceType: 'memory', noteId: row.noteId, folderPath: row.folderPath,
        ...(row.sourceNoteIds.length === 0 ? {} : { sourceNoteIds: row.sourceNoteIds }) } }));
    ctx.services.logger.debug('[BuiltinRetrievalExecutor] Memory route in unified search: %d results (compressed)', results.length);
    return [sources, null];
  }
  async executePlanned(
    call: ToolCall, ctx: RetrievalToolContext, toolName: string, onStarted?: (kind: 'rag' | 'web_search' | null) => void,
  ): Promise<Record<string, unknown>> {
    if (ctx.isCancelled()) return fail('Unified retrieval cancelled before start');
    const args = objectOf(call.arguments);
    const str = (...keys: string[]) => {
      for (const key of keys) { const value = stringOf(args[key]); if (value !== null && rustTrim(value) !== '') return rustTrim(value); }
      return null;
    };
    const vec = (...keys: string[]): string[] | null => {
      for (const key of keys) { const value = args[key]; if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string'); }
      return null;
    };
    const query = str('queryText', 'query_text', 'query'), image = str('queryImageBase64', 'query_image_base64'), mime = str('queryImageMediaType', 'query_image_media_type');
    const explicitMode = str('queryMode', 'query_mode')?.replace(/[A-Z]/g, ch => ch.toLowerCase());
    if (explicitMode !== undefined && !['text', 'image', 'mixed'].includes(explicitMode)) return fail(`Unsupported queryMode: ${explicitMode}`);
    const mode: QueryModality = explicitMode as QueryModality | undefined ?? (image !== null ? query !== null ? 'mixed' : 'image' : 'text');
    const folderIds = this.applySessionScope(ctx, vec('folder_ids', 'folderIds'));
    const resourceIds = vec('resource_ids', 'resourceIds'), resourceTypes = vec('resource_types', 'resourceTypes');
    const topK = Math.min(toolName === 'unified_search' ? 30 : 100, Math.max(1, uint(first(args, 'top_k', 'topK')) ?? ctx.rag_top_k ?? 10));
    const maxPerResource = uint(first(args, 'max_per_resource', 'maxPerResource')) ?? 0;
    const rawRerank = first(args, 'enable_reranking', 'enableReranking');
    const enableRerank = typeof rawRerank === 'boolean' ? rawRerank : ctx.rag_enable_reranking ?? true;
    ctx.emitter.emitStart('rag', ctx.message_id, ctx.block_id, {
      toolCallId: call.id, query, queryMode: mode, hasQueryImage: image !== null,
      folderIds, resourceIds, resourceTypes, source: toolName,
    }, null);
    onStarted?.('rag');
    const start = performance.now();
    if (!ctx.services.get('vfsDatabase')) return fail('VFS database not available');
    if (!ctx.services.get('llm')) return fail('LLM manager not available');
    const request = { queryText: query, queryImageBase64: image, queryImageMediaType: mime, queryModality: mode, topK, folderIds, resourceIds, resourceTypes };
    const multimodal = plannedSearchScope(toolName) === 'multimodal_only';
    const retrieval = ctx.services.get('retrievalCancellable') as CancellableRetrievalPort;
    const response = await cancellable(() => multimodal ? retrieval.searchMultimodal(request, ctx.cancellation_token) : retrieval.search(request, ctx.cancellation_token),
      ctx.cancellation_token, multimodal ? 'Multimodal retrieval cancelled during execution' : 'Unified retrieval cancelled during execution');
    const failures = [...response.result.failures];
    let normalizedCount = 0;
    let sources: SourceInfo[] = response.result.hits.map(fused => {
      // Value::get picks the first existing key even if its value is null.
      const raw = Object.hasOwn(fused, 'normalizedScore') ? fused.normalizedScore : fused.rerankScore;
      const normalized = typeof raw === 'number' ? raw : null;
      if (normalized !== null) normalizedCount++;
      const hit = fused.hit;
      const sourceType = hit.blobHash !== null || fused.provenance.some(p => p.routeKind === 'multimodal_image' || p.routeKind === 'multimodal_text') ? 'multimodal_search' : 'text_search';
      const meta: Record<string, unknown> = { resourceType: hit.resourceType, resourceId: hit.identity.resourceId,
        sourceId: hit.sourceId, chunkIndex: hit.identity.chunkIndex, pageIndex: hit.identity.pageIndex,
        blobHash: hit.blobHash, folderId: hit.folderId, sourceType, imageUrl: hit.imageUrl,
        imageCitation: hit.imageUrl === null ? null : `![Page ${(hit.identity.pageIndex ?? 0) + 1}](${hit.imageUrl})`,
        rrfScore: fused.rrfScore, normalizedScore: normalized, retrievalProvenance: fused.provenance };
      if (hit.identity.timeRange != null) { meta.timeRange = hit.identity.timeRange; meta.mediaCitation = mediaCitation(hit.sourceId ?? hit.identity.resourceId, hit.identity.timeRange.startMs); }
      return { title: hit.title, url: hit.imageUrl, snippet: hit.text, score: Math.fround(normalized ?? fused.rrfScore), metadata: meta };
    });
    const normalized = response.result.hits.length > 0 && normalizedCount === response.result.hits.length;
    const includeMemory = toolName === 'unified_search' && ctx.memory_enabled && query !== null;
    if (includeMemory || sources.length > 0) {
      const excluded = this.memoryResourceIds(ctx.services);
      if (excluded.size > 0) sources = sources.filter(source => { const id = stringOf(objectOf(source.metadata).resourceId); return id === null || !excluded.has(id); });
    }
    const requested = enableRerank && sources.length > 0;
    let applied = false;
    if (requested) {
      const kind = selectRerankerKind(mode, sources);
      const outcome = kind === 'text'
        ? query === null ? skippedRerank(sources, topK) : await textRerankSources(query, sources, topK, this.planned().reranker, ctx.services.logger)
        : await vlRerankSources(query, image, mime, sources, topK, this.planned().reranker, ctx.services);
      sources = outcome.sources; applied = outcome.applied;
      if (outcome.failure !== null) failures.push({ routeId: `rerank:${kind}`, profileId: null, dimension: null, error: outcome.failure, timedOut: false, queryDerivation: null });
    } else sources = sources.slice(0, topK);
    sources = applyScoreThresholds(sources, applied || normalized ? .3 : null, .5);
    if (maxPerResource > 0) {
      const counts = new Map<string, number>();
      sources = sources.filter(source => {
        const id = stringOf(objectOf(source.metadata).resourceId) ?? '', count = counts.get(id) ?? 0;
        if (count >= maxPerResource) return false;
        counts.set(id, count + 1); return true;
      });
    }
    if (includeMemory) {
      const [memory, failure] = await this.memorySources(query!, topK, ctx);
      if (failure !== null) failures.push(failure);
      if (memory.length > 0) {
        sources = dedupKbAgainstMemory(sources, memory, ctx.services.logger);
        const reserved = Math.min(memory.length, 3, topK), kbSlots = Math.max(0, topK - reserved), kbActual = Math.min(sources.length, kbSlots);
        sources = [...sources.slice(0, kbActual), ...memory.slice(0, Math.min(reserved + Math.max(0, kbSlots - kbActual), memory.length, topK))];
      }
    }
    const numbered = buildNumberedSources(sources, ctx.services.chatPipeline.citationLedgerForReply(ctx.session_id, ctx.message_id, ctx.variant_id));
    const durationMs = elapsed(start), rerank = { requested, applied };
    const shared = { sources: numbered, count: sources.length, durationMs, source: toolName, routeFailures: failures, rerank,
      retrievalPlan: response.plan, capabilitySnapshot: response.capabilitySnapshot };
    ctx.emitter.emitEnd('rag', ctx.block_id, { ...shared, queryMode: mode }, null);
    onStarted?.(null);
    ctx.services.logger.debug("[BuiltinRetrievalExecutor] Planned search '%s' completed: %d sources in %dms (rerank_applied=%s)", toolName, sources.length, durationMs, applied);
    const zh = includeMemory
      ? '在被支撑句子后紧跟 [知识库-N]/[图片-N]/[记忆-N]（编号本次回复内全局一致，重复检索到的同一来源编号不变）。页面图片用 [知识库-N:图片]/[图片-N:图片]。读全文用 readResourceId→builtin-resource_read，读完整记忆用 noteId→builtin-memory_read（压缩摘要条目 noteId 为 null，改用 sourceNoteIds 中的真实 ID）。禁止输出 URL、文件路径或 Markdown 图片。'
      : '在被支撑句子后紧跟 [知识库-N]/[图片-N]（编号本次回复内全局一致，重复检索到的同一来源编号不变）。页面图片用 [知识库-N:图片]/[图片-N:图片]。读全文用 readResourceId→builtin-resource_read。禁止输出 URL、文件路径或 Markdown 图片。';
    const en = includeMemory
      ? 'Append [知识库-N], [图片-N], or [记忆-N] right after each supported claim; N is stable across searches within this reply. Use [知识库-N:图片]/[图片-N:图片] to render page images. Read full docs via readResourceId with builtin-resource_read; full memories via noteId with builtin-memory_read (compressed memory entries have a null noteId; use the real IDs in sourceNoteIds instead). Never output URLs, file paths, or Markdown images.'
      : 'Append [知识库-N] or [图片-N] right after each supported claim; N is stable across searches within this reply. Use [知识库-N:图片]/[图片-N:图片] to render page images. Read full docs via readResourceId with builtin-resource_read. Never output URLs, file paths, or Markdown images.';
    const mediaGuide = sources.some(source => Object.hasOwn(objectOf(source.metadata), 'mediaCitation'))
      ? ' 音视频命中用其 mediaCitation（[媒体@id:mm:ss]）标注时间点 / Cite media hits with their mediaCitation.' : '';
    return with_localized_message({ success: true, ...shared, citationGuide: `${zh} / ${en}${mediaGuide}` } as unknown as JsonValue,
      'chat.tools.retrieval.unified_citation_guide', { sourceTypes: includeMemory ? ['knowledge', 'image', 'memory'] : ['knowledge', 'image'] }, zh, en);
  }
  async executeWeb(
    call: ToolCall, ctx: RetrievalToolContext, onStarted?: (kind: 'rag' | 'web_search' | null) => void,
  ): Promise<Record<string, unknown>> {
    if (ctx.isCancelled()) return fail('Web search cancelled before start');
    const args = objectOf(call.arguments), query = stringOf(args.query);
    if (query === null) return fail("Missing 'query' parameter");
    let engine = stringOf(args.engine);
    const topK = uint(args.top_k) ?? 5;
    const web = ctx.services.get('webSearch') as CancellableWebSearchPort;
    // Rust loads env/file config and applies DB overrides before the start event.
    const config = await web.loadConfig(ctx.services.get('settings') ?? null);
    let selected: string[] = [];
    try {
      const raw = ctx.services.get('settings')?.get('session.selected_search_engines');
      if (raw != null) { selected = raw.split(',').map(rustTrim).filter(s => s !== ''); ctx.services.logger.debug('[BuiltinRetrievalExecutor] User selected engines: %o', selected); }
    } catch {
      // Rust `if let Ok(Some(...))` ignores a setting read failure.
      selected = [];
    }
    if (engine === null && selected.length > 0) { engine = selected[0]!; ctx.services.logger.info('[BuiltinRetrievalExecutor] Using user-selected engine: %s', engine); }
    ctx.emitter.emitStart('web_search', ctx.message_id, ctx.block_id, { toolCallId: call.id, query, engine }, null);
    onStarted?.('web_search');
    const start = performance.now();
    const input = { query, top_k: topK, engine, site: null, time_range: null, start: null, force_engine: null };
    if (ctx.isCancelled()) return fail('Web search cancelled before search');
    const signal = ctx.cancellation_token ?? new AbortController().signal;
    const result = await cancellable(() => web.doSearch(config, input, signal), ctx.cancellation_token, 'Web search cancelled during execution',
      () => ctx.services.logger.info('[BuiltinRetrievalExecutor] Web search cancelled'));
    const durationMs = elapsed(start);
    if (!result.ok) {
      const error = result.error === undefined ? 'Web search failed' : typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      onStarted?.(null);
      ctx.emitter.emitError('web_search', ctx.block_id, error, null); return fail(error);
    }
    const sources = (result.citations ?? []).map((source, index) => ({ index: index + 1, citationTag: `[搜索-${index + 1}]`, typeIndex: index + 1,
      title: source.fileName, url: source.documentId, snippet: source.chunkText, score: Math.fround(source.score), source_type: 'web_search' }));
    ctx.emitter.emitEnd('web_search', ctx.block_id, { sources, count: sources.length, durationMs }, null);
    onStarted?.(null);
    ctx.services.logger.debug('[BuiltinRetrievalExecutor] Web search completed: %d sources in %dms', sources.length, durationMs);
    const zh = '回答时请使用 [搜索-N] 格式引用对应来源，如 [搜索-1]、[搜索-2] 等。引用标记应紧跟在引用内容之后。';
    const en = 'Cite each matching source as [搜索-N], such as [搜索-1] or [搜索-2], immediately after the supported claim.';
    return with_localized_message({ success: true, sources, count: sources.length, durationMs, citationGuide: `${zh} / ${en}` },
      'chat.tools.retrieval.web_citation_guide', { sourceType: 'web' }, zh, en);
  }
  executeMemory(ctx: RetrievalToolContext): Record<string, unknown> {
    ctx.services.logger.warn('[BuiltinRetrievalExecutor] memory_search is deprecated, use builtin-memory_search instead');
    const result = with_localized_message({ deprecated: true }, 'chat.tools.retrieval.memory_search_deprecated',
      { replacementTool: 'builtin-memory_search' }, '请使用 builtin-memory_search 工具（由 MemoryToolExecutor 处理）', 'Use builtin-memory_search instead; it is handled by MemoryToolExecutor.');
    ctx.emitter.emitEnd('memory', ctx.block_id, result, null);
    return { ...result, success: false, errorCode: 'RETRIEVAL_TOOL_DEPRECATED', error: result.message };
  }
  async execute(call: ToolCall, ctx: RetrievalToolContext): Promise<ToolResultInfo> {
    const start = performance.now(), name = stripToolNamespace(call.name);
    ctx.services.logger.debug('[BuiltinRetrievalExecutor] Executing builtin tool: %s (full: %s)', name, call.name);
    let activeBlockKind: 'rag' | 'web_search' | null = null;
    const setStarted = (kind: 'rag' | 'web_search' | null) => { activeBlockKind = kind; };
    try {
      const output = shouldRouteToUnifiedSearch(name) ? await this.executePlanned(call, ctx, name, setStarted)
        : name === 'web_search' ? await this.executeWeb(call, ctx, setStarted) : name === 'memory_search' ? this.executeMemory(ctx) : fail(`Unknown builtin tool: ${name}`);
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs: elapsed(start) };
    } catch (error) {
      const durationMs = elapsed(start);
      const localized = localizedRetrievalFailure(detail(error));
      if (activeBlockKind !== null) {
        ctx.emitter.emitError(activeBlockKind, ctx.block_id, localized, null);
      }
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null, success: false,
        error: localized, durationMs };
    }
  }
}
