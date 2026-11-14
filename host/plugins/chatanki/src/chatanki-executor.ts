// Rust: src/chat_v2/tools/chatanki_executor.rs 的执行编排。
// 当前覆盖 chatanki_analyze；其余工具随测试移植逐步增补。
import type {
  ChatAnkiRefResolver, ChatAnkiRoutePlanner, ChatAnkiToolExecutor, ContextRef,
  CustomAnkiTemplate, ToolCall, ToolConcurrency, ToolExecutionContext, ToolResultInfo,
  ToolSensitivity, VfsContextRefData, VfsResourceRef,
} from '../api.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { parseChatAnkiExportArgs, parseChatAnkiListTemplatesArgs } from './executor-args.ts';
import { chatankiReviewStatsOutput, parseChatAnkiReviewStatsArgs } from './review-payloads.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import { executeChatAnkiTransform } from './transform-executor.ts';
import {
  buildAnalyzeOutput, buildRoutePlanPrompt, buildSingleRefDataFromContextRef,
  CHATANKI_TEMPLATE_SELECTION_RULE, chatankiHasDynamicSensitivity,
  chatankiSensitivityForCall, humanizeChatAnkiError,
  parseRoutePlanResponse, resolveRouteDecision, ROUTE_PLAN_SAMPLE_PER_REF_CHARS,
  ROUTE_PLAN_SAMPLE_TOTAL_CHARS, selectChatankiTemplatePage, type ChatAnkiRoute,
  type RoutePlan,
} from './executor-helpers.ts';
import {
  deserializeSerdeStruct, serdeOption, serdeString, serdeVec, type SerdeStructField,
} from './serde-struct.ts';
import { rustTrim, rustTrimEnd } from '../../../platform/util/text.ts';

// ============================================================================
// chatanki_analyze (chatanki_executor.rs:5555–5690)
// ============================================================================

export interface ChatAnkiAnalyzeArgs {
  content: string | null;
  goal: string | null;
  route: string | null;
  resourceId: string | null;
  resourceIds: string[] | null;
}

const ANALYZE_FIELDS: readonly SerdeStructField[] = [
  { name: 'content', option: true, read: serdeOption(serdeString) },
  { name: 'goal', option: true, read: serdeOption(serdeString) },
  { name: 'route', option: true, read: serdeOption(serdeString) },
  { name: 'resourceId', option: true, read: serdeOption(serdeString) },
  { name: 'resourceIds', option: true, read: serdeOption(serdeVec(serdeString)) },
];

/**
 * `serde_json::from_value::<ChatAnkiAnalyzeArgs>` (chatanki_executor.rs:1680–1693,5575):
 * `rename_all = "camelCase"` (the `resourceId(s)` aliases equal the renamed
 * names, so snake_case keys are unknown and ignored).
 */
export function parseChatAnkiAnalyzeArgs(raw: unknown): ChatAnkiAnalyzeArgs {
  const [content, goal, route, resourceId, resourceIds] = deserializeSerdeStruct(
    raw, 'ChatAnkiAnalyzeArgs', ANALYZE_FIELDS, false,
  );
  return {
    content: (content ?? null) as string | null,
    goal: (goal ?? null) as string | null,
    route: (route ?? null) as string | null,
    resourceId: (resourceId ?? null) as string | null,
    resourceIds: (resourceIds ?? null) as string[] | null,
  };
}

export function parseChatAnkiRoute(raw: string): ChatAnkiRoute | null {
  return raw === 'simple_text' || raw === 'vlm_light' || raw === 'vlm_full' ? raw : null;
}

const EMPTY_REF_DATA: VfsContextRefData = { refs: [], truncated: false, totalCount: 0 };
export const ANALYZE_METRICS_MAX_CHARS = 200_000;

function safeTruncateChars(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

/** Session snapshot first, VFS fallback; unresolved ids become a fail-open warning. */
export function resolveAnalyzeRefData(
  ctx: ToolExecutionContext, requestedIds: readonly string[], warnings: unknown[],
): VfsContextRefData | null {
  let contextRefs: ContextRef[] = [];
  const resolver: ChatAnkiRefResolver | null = ctx.refs ?? null;
  if (resolver !== null) {
    try { contextRefs = resolver.resolveSessionRefs(ctx.sessionId, requestedIds); }
    catch (caught) { ctx.warn(`[chatanki_analyze] resolve session refs failed: ${errorText(caught)}`); }
  }
  const unresolved: string[] = [];
  for (const id of requestedIds) {
    if (contextRefs.some((ref) => ref.resourceId === id)) continue;
    if (resolver === null) { unresolved.push(id); continue; }
    try {
      const contextRef = resolver.resolveVfsRef(id);
      if (contextRef === null) unresolved.push(id);
      else contextRefs.push(contextRef);
    } catch (caught) {
      ctx.warn(`[chatanki_analyze] resolve ref '${id}' failed: ${errorText(caught)}`);
      unresolved.push(id);
    }
  }
  if (unresolved.length > 0) {
    warnings.push({
      code: 'analyze_refs_unresolved',
      message: `以下资源未能解析为引用元数据，本次分析退化为纯文本启发式：${unresolved.join(', ')}`,
      unresolvedIds: unresolved,
    });
  }
  if (contextRefs.length === 0) return null;
  const merged: VfsContextRefData = { refs: [], truncated: false, totalCount: 0 };
  for (const contextRef of contextRefs) {
    const data = buildSingleRefDataFromContextRef(contextRef);
    if (data === null) continue;
    merged.totalCount += data.refs.length;
    merged.refs.push(...data.refs);
  }
  return merged.refs.length === 0 ? null : merged;
}

/** Ref text appended to analyze metrics; mirrors file text / image skip / other snippet. */
export function collectRefTextForMetrics(
  content: string, refData: VfsContextRefData,
  refText: ChatAnkiRefResolver['refText'] | null,
): string {
  let out = rustTrim(content);
  for (const ref of refData.refs) {
    const remaining = ANALYZE_METRICS_MAX_CHARS - [...out].length;
    if (remaining <= 0) break;
    let text: string | null = null;
    try { text = refText === null ? null : refText(ref, remaining); }
    catch { text = null; }
    if (text === null || rustTrim(text).length === 0) continue;
    if (out.length > 0) out += '\n\n';
    out += safeTruncateChars(rustTrim(text), remaining);
  }
  return out;
}

/**
 * chatanki_executor.rs:9198–9255: bounded route-plan sample. Images are skipped
 * (their dimensions are metadata, not extracted text); files use extracted text
 * and other refs use the snapshot snippet.
 */
export function sampleRefTextForRouting(
  content: string, refData: VfsContextRefData,
  refText: ChatAnkiRefResolver['refText'] | null,
): string {
  let out = '';
  let remaining = ROUTE_PLAN_SAMPLE_TOTAL_CHARS;
  const pushSample = (label: string, text: string): void => {
    const trimmed = rustTrim(text);
    if (trimmed.length === 0 || remaining === 0) return;
    const sampled = safeTruncateChars(
      trimmed, Math.min(ROUTE_PLAN_SAMPLE_PER_REF_CHARS, remaining),
    );
    remaining -= [...sampled].length;
    out += `[${label}]\n${sampled}\n\n`;
  };

  if (rustTrim(content).length > 0) pushSample('用户输入文本', content);
  for (const ref of refData.refs) {
    if (remaining === 0) break;
    if (ref.type === 'image') continue;
    let text: string | null;
    if (ref.type === 'file') {
      try { text = refText === null ? null : refText(ref, ROUTE_PLAN_SAMPLE_PER_REF_CHARS); }
      catch { text = null; }
    } else {
      text = ref.snippet ?? null;
    }
    if (text !== null) pushSample(ref.name, text);
  }
  return rustTrimEnd(out);
}

/**
 * chatanki_executor.rs:9647–9705: Planner-slot routing call. Failures and
 * unparseable responses warn and return null, letting the deterministic
 * heuristic decide; they never fail the analyze tool by themselves.
 */
export async function planChatAnkiRoute(
  planner: ChatAnkiRoutePlanner, goal: string, refData: VfsContextRefData,
  textSample: string, warn: (message: string) => void,
  info: (message: string) => void = () => undefined,
): Promise<RoutePlan | null> {
  const prompt = buildRoutePlanPrompt(goal, refData, textSample);
  let response: string;
  try {
    response = await planner.callAnkiRoutedRawPrompt('chatanki.plan_route', prompt);
  } catch (caught) {
    warn(`[chatanki] plan_route LLM 调用失败，回退启发式路由: ${errorText(caught)}`);
    return null;
  }
  const plan = parseRoutePlanResponse(response);
  if (plan === null) {
    warn('[chatanki] plan_route 响应解析失败，回退启发式路由: '
      + safeTruncateChars(response, 200));
    return null;
  }
  // chatanki_executor.rs:9701–9710: 成功计划记 info 日志。
  info(`[chatanki] plan_route: route=${plan.route} confidence=${plan.confidence.toFixed(2)}`
    + ` glossaryMode=${debugOption(plan.glossaryMode)} reason=${debugOption(plan.reason)}`);
  return plan;
}

function debugOption(value: boolean | string | null): string {
  if (value === null) return 'None';
  return typeof value === 'boolean' ? `Some(${value})` : `Some(${JSON.stringify(value)})`;
}

export async function executeChatAnkiAnalyze(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ChatAnkiAnalyzeArgs;
  try { args = parseChatAnkiAnalyzeArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_analyze arguments: ${errorText(caught)}`);
  }

  const rawRoute = (args.route == null ? undefined : rustTrim(args.route));
  let forcedRoute: ChatAnkiRoute | null = null;
  if (rawRoute !== undefined && rawRoute.length > 0) {
    forcedRoute = parseChatAnkiRoute(rawRoute);
    if (forcedRoute === null) {
      return finishFailure(call, ctx, startedAt,
        `Invalid route '${rawRoute}': expected simple_text | vlm_light | vlm_full`);
    }
  }

  const content = args.content ?? '';
  const requestedIds: string[] = [];
  const pushId = (rawId: string | null): void => {
    const id = (rawId == null ? undefined : rustTrim(rawId)) ?? '';
    if (id.length > 0 && !requestedIds.includes(id)) requestedIds.push(id);
  };
  pushId(args.resourceId);
  for (const id of args.resourceIds ?? []) pushId(id);

  if (rustTrim(content).length === 0 && requestedIds.length === 0) {
    return finishFailure(call, ctx, startedAt, 'content or resourceIds is required');
  }

  const warnings: unknown[] = [];
  const refData = requestedIds.length > 0
    ? resolveAnalyzeRefData(ctx, requestedIds, warnings)
    : null;
  let decision: ReturnType<typeof resolveRouteDecision>;
  if (forcedRoute !== null) {
    decision = resolveRouteDecision(forcedRoute, null, refData ?? EMPTY_REF_DATA);
  } else if (refData !== null && refData.refs.length > 0) {
    const planner = ctx.llmPlanner ?? null;
    if (planner === null) {
      if (ctx.llmManagerPresent === true) {
        // A live LLM manager exists but does not publish L02's routed-prompt
        // seam. This is a wiring error, not Rust's `llm_manager=None` fallback.
        return finishFailure(call, ctx, startedAt,
          'chatanki_analyze requires the L02 route planner (llm.callAnkiRoutedRawPrompt); '
          + 'the LLM manager is present but does not expose it');
      }
      // Rust chatanki_executor.rs:5628–5646: `ctx.llm_manager == None` becomes
      // `plan = None`, and `resolve_route_decision` then uses the heuristic.
      decision = resolveRouteDecision(null, null, refData);
    } else {
      const sample = sampleRefTextForRouting(
        content, refData, ctx.refs?.refText ?? null,
      );
      const plan = await planChatAnkiRoute(
        planner, args.goal ?? '', refData, sample, ctx.warn, ctx.info ?? (() => undefined),
      );
      decision = resolveRouteDecision(null, plan, refData);
    }
  } else {
    // 纯文本（无图元数据）：与 PipelineInput::Content 分支同语义 → simple_text。
    decision = resolveRouteDecision(null, null, EMPTY_REF_DATA);
  }
  const metricsText = refData === null || refData.refs.length === 0
    ? content
    : collectRefTextForMetrics(content, refData, ctx.refs?.refText ?? null);
  const output = buildAnalyzeOutput(args.goal, metricsText, refData, decision, warnings);
  return finishSuccess(call, ctx, startedAt, output);
}

// ============================================================================
// chatanki_list_templates (chatanki_executor.rs:5684–5803)
// ============================================================================

export async function executeChatAnkiListTemplates(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args;
  try { args = parseChatAnkiListTemplatesArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_list_templates arguments: ${errorText(caught)}`);
  }

  // The hosted chain reads the same template rows through L16 `anki.templates`.
  const db = ctx.mainDb ?? ctx.ankiDb ?? null;
  const service = ctx.templates ?? null;
  const store = db !== null
    ? { list: () => db.getAllCustomTemplates(), importBuiltins: () => { db.importBuiltinTemplatesIfEmpty(); } }
    : service !== null
      ? { list: () => service.list(), importBuiltins: () => { service.importBuiltinTemplatesIfEmpty(); } }
      : null;
  if (store === null) return finishFailure(call, ctx, startedAt, 'Database not available');

  const activeOnly = args.activeOnly ?? true;
  const query = rustTrim((args.category ?? '')).toLowerCase();
  const page = Math.max(args.page ?? 1, 1);
  const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), 50);

  let templates: CustomAnkiTemplate[];
  try { templates = store.list(); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, `Failed to list templates: ${errorText(caught)}`);
  }
  if (templates.length === 0) {
    try {
      store.importBuiltins();
      try { templates = store.list(); }
      catch { templates = []; }
    } catch (caught) {
      ctx.warn(`[ChatAnkiToolExecutor] auto-import builtin templates failed: ${errorText(caught)}`);
    }
  }

  const { total, items } = selectChatankiTemplatePage(templates, query, activeOnly, page, pageSize);
  const output = {
    status: 'ok',
    activeOnly,
    query: query.length === 0 ? null : query,
    total,
    page,
    pageSize,
    count: items.length,
    selectionRule: CHATANKI_TEMPLATE_SELECTION_RULE,
    templates: items,
  };
  return finishSuccess(call, ctx, startedAt, output);
}

// ============================================================================
// chatanki_export (chatanki_executor.rs:5797–6136; JSON path)
// ============================================================================

export function resolveDeckAndNoteType(
  ctx: ToolExecutionContext, deckName: string | null, noteType: string | null,
): [string, string] {
  const trim = (value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = rustTrim(value);
    return trimmed.length === 0 ? null : trimmed;
  };
  const deck = trim(deckName);
  const note = trim(noteType);
  if (deck !== null || note !== null) {
    return [deck ?? 'Default', note ?? 'Basic'];
  }
  // `main_db.or(anki_db).get_setting(..).ok().flatten()`; the hosted chain reads the same
  // settings table through `ctx.settings`.
  const db = ctx.mainDb ?? ctx.ankiDb ?? null;
  const store = db?.getSetting !== undefined ? db : ctx.settings ?? null;
  const setting = (key: string): string | null => {
    try { return store?.getSetting?.(key) ?? null; }
    catch { return null; }
  };
  const deckSetting = setting('anki_connect_default_deck');
  const noteSetting = setting('anki_connect_default_model');
  return [
    deckSetting !== null && rustTrim(deckSetting).length > 0 ? deckSetting : 'Default',
    noteSetting !== null && rustTrim(noteSetting).length > 0 ? noteSetting : 'Basic',
  ];
}

export async function executeChatAnkiExport(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let request;
  try { request = parseChatAnkiExportArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_export arguments: ${errorText(caught)}`);
  }

  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, 'Anki database not available');

  let cards;
  let documentId: string | null = null;
  let libraryCardIds: string[] | null = null;
  if (request.selector.kind === 'document') {
    documentId = request.selector.documentId;
    let snapshot;
    try { snapshot = repo.getCardsForDocumentForSession(documentId, ctx.sessionId); }
    catch (caught) {
      return finishFailure(call, ctx, startedAt,
        `Failed to load cards for document: ${errorText(caught)}`);
    }
    if (snapshot === null) {
      return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.statusNotFound');
    }
    cards = snapshot.filter((card) => !card.is_error_card);
  } else {
    libraryCardIds = [...request.selector.cardIds];
    try { cards = repo.getLibraryCardsByIds(libraryCardIds); }
    catch (caught) {
      return finishFailure(call, ctx, startedAt,
        `Failed to load library cards: ${errorText(caught)}`);
    }
  }
  if (cards.length === 0) {
    return finishFailure(call, ctx, startedAt,
      'No cards to export (all cards are empty or error cards)');
  }
  const cardsCount = cards.length;
  const [deckName, noteType] = resolveDeckAndNoteType(
    ctx, request.deckName, request.noteType,
  );

  if (request.format !== 'json') {
    return finishFailure(call, ctx, startedAt,
      'APKG export requires the L16 apkg exporter service; use format=json until it is published');
  }
  const suggested = rustTrim((request.suggestedName ?? '')).length > 0
    ? (request.suggestedName as string)
    : `${deckName.replace(/[/\\]/g, '_')}_chatanki_cards.json`;
  const sink = ctx.exportSink ?? null;
  if (sink === null) return finishFailure(call, ctx, startedAt, 'JSON export service unavailable');
  let path: string;
  try { path = await sink.saveJsonFile(JSON.stringify(cards, null, 2), suggested); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const output: Record<string, unknown> = {
    status: 'ok',
    format: 'json',
    path,
    deckName,
    noteType,
    cardsCount,
  };
  if (documentId !== null) {
    output.documentId = documentId;
    output.hiddenOverLimitCount = ctx.hiddenOverLimitCount?.(ctx.sessionId, documentId) ?? 0;
  }
  if (libraryCardIds !== null) output.libraryCardIds = libraryCardIds;
  return finishSuccess(call, ctx, startedAt, output);
}

// ============================================================================
// chatanki_review_stats (chatanki_executor.rs:3402–3447)
// ============================================================================

export async function executeChatAnkiReviewStats(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  try { parseChatAnkiReviewStatsArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_review_stats arguments: ${errorText(caught)}`);
  }
  const service = ctx.reviewStats ?? null;
  if (service === null) {
    return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.databaseUnavailable');
  }
  let stats;
  try { stats = service.getStats(); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }
  return finishSuccess(call, ctx, startedAt, chatankiReviewStatsOutput(stats));
}

// ============================================================================
// chatanki_check_anki_connect (chatanki_executor.rs:2139–2170)
// ============================================================================

export async function executeChatAnkiCheckAnkiConnect(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  const service = ctx.ankiConnect ?? null;
  let available = false;
  let error: string | null = null;
  if (service === null) {
    // Rust 直接调用 free function；宿主缺服务时按探测失败的最接近形状返回。
    error = 'AnkiConnect service unavailable';
  } else {
    try { available = await service.checkAnkiConnectAvailability(); }
    catch (caught) {
      available = false;
      error = errorText(caught);
    }
  }
  return finishSuccess(call, ctx, startedAt, { status: 'ok', available, error });
}

// ============================================================================
// Executor (incremental surface; only implemented tools are advertised)
// ============================================================================

export class ChatAnkiExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return CHATANKI_IMPLEMENTED_TOOLS.has(stripToolNamespace(toolName));
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  sensitivityLevelForCall(toolName: string, args: unknown): ToolSensitivity {
    return chatankiSensitivityForCall(
      toolName,
      args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown> : {},
    );
  }
  hasDynamicSensitivity(toolName: string): boolean {
    return chatankiHasDynamicSensitivity(toolName);
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiToolExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    // chatanki_executor.rs:1873–1883: info log, then start event for every tool.
    beginChatAnkiToolCall(call, ctx);
    switch (stripToolNamespace(call.name)) {
      case 'chatanki_analyze':
        return executeChatAnkiAnalyze(call, ctx);
      case 'chatanki_list_templates':
        return executeChatAnkiListTemplates(call, ctx);
      case 'chatanki_export':
        return executeChatAnkiExport(call, ctx);
      case 'chatanki_transform':
        return executeChatAnkiTransform(call, ctx);
      case 'chatanki_review_stats':
        return executeChatAnkiReviewStats(call, ctx);
      case 'chatanki_check_anki_connect':
        return executeChatAnkiCheckAnkiConnect(call, ctx);
      default:
        throw new Error(`Unsupported chatanki tool: ${stripToolNamespace(call.name)}`);
    }
  }
}

const CHATANKI_IMPLEMENTED_TOOLS = new Set([
  'chatanki_analyze', 'chatanki_list_templates', 'chatanki_export', 'chatanki_transform',
  'chatanki_review_stats', 'chatanki_check_anki_connect',
]);
