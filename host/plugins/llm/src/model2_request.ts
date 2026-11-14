/** model2_pipeline.rs:5328–6192: request composition before provider conversion. */
import type { ApiConfig, LlmMcpTools, UnifiedModel2StreamInput } from '../api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { rustTrim, charCount, utf8ByteLength } from '../../../platform/util/portable.ts';
import { buildModel2Messages } from './model2_messages.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { normalizeToolSchemasForMfjs, shouldApplyMfjsToolSchemaDialect } from './adapters/moonshot.ts';
import { applyReasoningConfig } from './question_authoring.ts';
import { applyGenerationParams } from './generation.ts';
import { resolveQuirks } from './provider_quirks.ts';
import { ensureOfficialDeepseekV4ReasoningPassback } from './passback.ts';
import { checkRequestInputBudget, effectiveRequestInputLimit, ensureModelAcceptsMessageModalities, COMPACTION_CHECKED_CONTEXT_KEY } from './input_guard.ts';
import { isTransientSkillMessage } from './injection.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';
import { sanitizeRequestBodyForAudit } from './audit.ts';
import { isOfficialDeepseekFlashResponses } from './deepseek_files.ts';

export interface WebSearchFallback {
  call(input: { window: UnifiedModel2StreamInput['window']; streamEvent: string; memoryEnabled: boolean | null;
    args: { query: string; top_k: number } }): Promise<{ ok: boolean; error: string | null; citations: unknown[] | null; injectText: string | null }>;
}
type ObjectValue = Record<string, JsonValue>;
function object(value: JsonValue): ObjectValue | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function text(value: JsonValue | undefined, fallback: string): string { return typeof value === 'string' ? value : fallback; }
export function readModel2Setting(settings: Pick<SettingsStore, 'get'>, key: string): string | null {
  try { return settings.get(key); } catch { return null; } // Rust get_setting(...).ok().flatten()
}
export async function buildModel2Request(config: ApiConfig, input: UnifiedModel2StreamInput,
  settings: Pick<SettingsStore, 'get'>, mcp: LlmMcpTools, webSearch: WebSearchFallback | null): Promise<ObjectValue> {
  const requestAdapter = requestAdapterForConfig(config);
  requestAdapter.validateReasoningConfig(config);
  const modality = ensureModelAcceptsMessageModalities(config, input.chatHistory);
  if (modality) throw modality;
  const quirks = resolveQuirks(config);
  logDebug('[LLM] 图片上下文策略: 仅消息级，禁用会话级回退');
  const context = input.context;
  const deepseekChat = ['chat_v2', 'chat_v2_variant'].includes(input.taskContext ?? '') && isOfficialDeepseekFlashResponses(config);
  const injections: string[] = [];
  if (Array.isArray(context.prefetched_graph_sources)) {
    const rows: string[] = [];
    for (const [index, item] of context.prefetched_graph_sources.entries()) {
      const source = object(item);
      if (!source) continue;
      let title = text(Object.hasOwn(source, 'file_name') ? source.file_name : source.title, 'Graph Insight');
      if (!rustTrim(title)) title = 'Graph Insight';
      const snippet = text(Object.hasOwn(source, 'chunk_text') ? source.chunk_text : source.snippet, '');
      if (!rustTrim(snippet)) continue;
      rows.push(`(${index + 1}) ${title}\n${snippet}`);
      if (rows.length >= 5) break;
    }
    if (rows.length) {
      const graph = `【个人图谱】\n${rows.join('\n\n')}\n\n`;
      logDebug(`[GraphInject] 已构建图谱召回注入内容，长度 ${charCount(graph)} 字符`);
      injections.push(graph);
    }
  }
  const globalToolsEnabled = !['0', 'false'].includes((readModel2Setting(settings, 'tools.enabled') ?? '').toLowerCase());
  const toolsEnabled = globalToolsEnabled && !input.disableTools;
  // Chat's disableTools disables automatic local MCP discovery; the server tools
  // use the explicit chat web-access flag, even on the text-only execution path.
  const deepseekWebAllowed = deepseekChat && input.taskContext === 'chat_v2' && globalToolsEnabled
    && context.deepseek_web_tools_disabled !== true && context.web_search_enabled === true;
  const legacyWeb = deepseekWebAllowed ? readModel2Setting(settings, 'deepseek.chat.web_tools') : null;
  const deepseekSearch = deepseekWebAllowed && (readModel2Setting(settings, 'deepseek.chat.web_search') ?? legacyWeb) === 'true';
  const deepseekReadUrl = deepseekWebAllowed && (readModel2Setting(settings, 'deepseek.chat.read_url') ?? legacyWeb) === 'true';
  const deepseekWeb = deepseekSearch || deepseekReadUrl;
  const customTools = Array.isArray(context.custom_tools) ? context.custom_tools : [];
  const hasCustom = customTools.length > 0;
  const requestHasTools = config.supportsTools && (hasCustom || !input.disableTools && toolsEnabled);
  logDebug(`[LLM] custom_tools check: has_custom_tools=${hasCustom}, count=${customTools.length}, disable_tools=${!!input.disableTools}, tools_enabled=${toolsEnabled}, supports_tools=${config.supportsTools}, request_has_tools_hint=${requestHasTools}`);
  let tools: JsonValue[] = [];
  if (hasCustom && config.supportsTools) {
    tools = structuredClone(customTools);
    logDebug(`[LLM] 使用 context 注入的自定义工具，数量: ${tools.length}`);
  }
  else if (!input.disableTools && toolsEnabled && config.supportsTools) {
    tools = await mcp.build(input.window ?? null);
    if (!tools.length) logWarn('[LLM] 工具列表为空，跳过 tool_choice 设置');
  } else if (!config.supportsTools) {
    logDebug('跳过工具注入：模型不支持函数调用 (supports_tools=false)');
    logInfo('[Fallback] 模型不支持工具调用，启动降级注入模式');
    const rows: string[] = [];
    if (Array.isArray(context.prefetched_web_search_sources)) for (const [index, item] of context.prefetched_web_search_sources.entries()) {
      const source = object(item);
      if (!source) continue;
      const title = text(Object.hasOwn(source, 'file_name') ? source.file_name : source.title, '搜索结果');
      const content = text(Object.hasOwn(source, 'chunk_text') ? source.chunk_text : source.snippet, '');
      const url = text(Object.hasOwn(source, 'document_id') ? source.document_id : source.url, '');
      if (rustTrim(content)) rows.push(`[外部搜索 ${index + 1}] ${title}\n${content}${url ? `\nURL: ${url}` : ''}`);
      if (rows.length >= 5) break;
    }
    if (rows.length) {
      logDebug(`[Fallback] 复用预取的 web_search 结果，共 ${rows.length} 条`);
      injections.push(`【外部搜索结果】\n${rows.join('\n\n')}\n\n`);
    }
    const user = input.chatHistory.findLast(message => message.role === 'user');
    if (user) {
      if (context.memory_enabled !== false) {
        try { input.sink.emit(`${input.streamEvent}_memory_sources`, { stage: 'disabled' }); }
        catch { /* boundary-allow empty-catch: model2_pipeline.rs:5997 explicitly ignores emit result without logging */ }
      }
      logDebug(context.rag_enabled !== false ? '[Fallback] Legacy RAG removed, skipping knowledge base injection' : '[Fallback] RAG 已关闭，跳过知识库注入');
      if (!rows.length && !deepseekWeb && context.web_search_enabled === true) {
        logDebug(`[Fallback] 准备调用 web_search 工具，查询: ${user.content}`);
        const result = webSearch ? await webSearch.call({ window: input.window, streamEvent: input.streamEvent,
          memoryEnabled: typeof context.memory_enabled === 'boolean' ? context.memory_enabled : null,
          args: { query: user.content, top_k: 3 } }) : { ok: false, error: '未知工具: web_search', citations: null, injectText: null };
        logDebug(`[Fallback] web_search 调用完成，ok=${result.ok}, citations数量=${result.citations?.length ?? 0}, inject_text长度=${result.injectText === null ? 0 : utf8ByteLength(result.injectText)}`);
        if (result.error !== null) logWarn(`[Fallback] web_search 返回错误: ${result.error}`);
        if (result.injectText !== null) {
          logDebug(`[Fallback] 将 web_search 注入文本加入队列，长度: ${utf8ByteLength(result.injectText)} 字符`);
          injections.push(result.injectText);
        }
        else logWarn('[Fallback] web_search 返回的 inject_text 为 None！');
      } else if (context.web_search_enabled !== true) logDebug('[Fallback] web_search 已关闭，跳过外部搜索注入');
    }
    if (!injections.length) logWarn('[Fallback] inject_texts 队列为空，没有任何内容可注入！');
  }
  if (deepseekWeb) {
    tools = tools.filter(tool => {
      const name = object(object(tool)?.function ?? null)?.name;
      // Keep the standalone Fetch function for workflows that need the full Markdown.
      const type = object(tool)?.type;
      return (!deepseekSearch || (name !== 'builtin-web_search' && name !== 'web_search'))
        && (type === undefined || type === 'function');
    });
    if (deepseekSearch) tools.push({ type: 'deepseek_web_search' });
    if (deepseekReadUrl) tools.push({ type: 'deepseek_read_url' });
  }
  const messages = buildModel2Messages(config, input.chatHistory, input.systemPromptOverride ?? null, requestHasTools, injections,
    deepseekChat && readModel2Setting(settings, 'deepseek.chat.files') === 'true');
  const body: ObjectValue = { model: config.model, messages, stream: true };
  applyReasoningConfig(body, config, input.enableThinking);
  if (tools.length) {
    if (shouldApplyMfjsToolSchemaDialect(config)) {
      const rewrites = normalizeToolSchemasForMfjs(tools);
      if (rewrites) logDebug(`[LLM] Moonshot MFJS 规范化工具 schema：${rewrites} 处改写`);
    }
    body.tools = tools;
    if (!(quirks.strip_tool_choice_on_tool_result && messages.some(message => object(message)?.role === 'tool'))) body.tool_choice = 'auto';
    else logDebug('[LLM] Qwen tool-result follow-up request: removed tool_choice per official Function Calling guidance');
  }
  applyGenerationParams(body, config, quirks);
  if (deepseekChat && readModel2Setting(settings, 'deepseek.chat.safety_check') === 'true') body.safety_check = { level: 'high' };
  ensureOfficialDeepseekV4ReasoningPassback(body, config);
  const error = checkRequestInputBudget(body, effectiveRequestInputLimit(config, input.maxInputTokensOverride), config,
    ['chat_v2', 'chat_v2_variant'].includes(input.taskContext ?? '') && context[COMPACTION_CHECKED_CONTEXT_KEY] !== true);
  if (error) throw error;
  if (!config.isReasoning && input.enableChainOfThought) logWarn(`前端为非推理模型 ${config.model} 请求了思维链。通常这由Prompt控制，而非特定API参数。`);
  const transient = input.chatHistory.filter(isTransientSkillMessage).length;
  const realLoadCalls = messages.filter(message => {
    const calls = object(message)?.tool_calls;
    return Array.isArray(calls) && calls.some(call => {
      const fn = object(call)?.function;
      return fn !== undefined && object(fn)?.name === 'load_skills';
    });
  }).length;
  if (transient || realLoadCalls) logInfo(`[LLM_AUDIT] 请求体包含 ${transient} 条瞬态技能消息，${realLoadCalls} 次真实 load_skills 调用（总消息数: ${messages.length}）`);
  logDebug('[LLM_REVIEW_DEBUG] ==> 脱敏请求体开始 <==');
  logDebug(JSON.stringify(sanitizeRequestBodyForAudit(body), null, 2));
  logDebug('[LLM_REVIEW_DEBUG] ==> 脱敏请求体结束 <==');
  return body;
}
