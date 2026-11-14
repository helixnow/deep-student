/** Non-streaming unified model-2 exit: model2_pipeline.rs:7559–7952 (call_unified_model_2[_with_config]). */
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { rustDebugString } from '../../../kernel/api.ts';
import { statusLine, utf8ByteLength } from '../../../platform/util/portable.ts';
import { LATEX_OUTPUT_BRIEF, type LlmAdapterService, type LlmCodexAuthService } from '../../llm-providers/api.ts';
import type { ApiConfig, LLMManager, LlmUnifiedModel2, Model2HistoryMessage, StandardModel2Output } from '../api.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { applyReasoningConfig } from './question_authoring.ts';
import { applyGenerationParams } from './generation.ts';
import { resolveQuirks } from './provider_quirks.ts';
import { ensureOfficialDeepseekV4ReasoningPassback } from './passback.ts';
import {
  chatMessagesRequireMultimodal, checkRequestInputBudget, effectiveRequestInputLimit, ensureModelAcceptsMessageModalities,
} from './input_guard.ts';
import { mergeConsecutiveUserMessagesRespectingTransients, transientUserContentsForMerge } from './injection.ts';
import { detectImageFormatFromBase64 } from './image_format.ts';
import { prepareProviderRequest, type PreparedProviderRequest } from './prepared_request.ts';
import { normalizeNonstreamResponseToOpenaiForConfig } from './mod_compat.ts';
import { runWithFailover, tagEstablishFailure } from './routing.ts';
import { adapterFor } from './raw_prompt_service.ts';
import { logLlmRequestAudit, type DebugPersistConfig } from './audit_log.ts';
import { estimateTokens } from './tokens.ts';
import { logDebug, logError, logInfo } from './logging.ts';

type JsonObject = { [key: string]: JsonValue };

/** get_fallback_prompt("model2"); the subject argument is deprecated and ignored. */
const MODEL2_SUBJECT_PROMPT = `你是一个教学专家。请仔细分析这道错题，提供详细的解题思路和知识点讲解。\n\n${LATEX_OUTPUT_BRIEF}`;

/** serde_json 1.0.149 `impl Debug for Value` (preserve_order + arbitrary_precision). */
function debugValue(value: JsonValue): string {
  if (value === null) return 'Null';
  if (typeof value === 'boolean') return `Bool(${value})`;
  if (typeof value === 'number') return `Number(${value})`;
  if (typeof value === 'string') return `String(${rustDebugString(value)})`;
  if (Array.isArray(value)) return `Array ${debugList(value)}`;
  return `Object {${Object.entries(value).map(([key, item]) => `${rustDebugString(key)}: ${debugValue(item)}`).join(', ')}}`;
}

function debugList(values: readonly JsonValue[]): string {
  return `[${values.map(debugValue).join(', ')}]`;
}

function contextString(context: Record<string, JsonValue>, key: string): string {
  const value = Object.hasOwn(context, key) ? context[key] : undefined;
  return typeof value === 'string' ? value : '';
}

export function unifiedModel2SystemContent(context: Record<string, JsonValue>, taskContext: string | null): string {
  const subjectPrompt = taskContext === null ? MODEL2_SUBJECT_PROMPT : `${MODEL2_SUBJECT_PROMPT}\n\n任务上下文: ${taskContext}`;
  const tags = Object.hasOwn(context, 'tags') && Array.isArray(context.tags) ? context.tags : [];
  return `${subjectPrompt}\n\n题目信息:\nOCR文本: ${contextString(context, 'ocr_text')}\n标签: ${debugList(tags)}`
    + `\n题目类型: ${contextString(context, 'mistake_type')}\n用户原问题: ${contextString(context, 'user_question')}`;
}

function historyMessage(config: ApiConfig, message: Model2HistoryMessage): JsonObject {
  if (message.role === 'user') {
    if (config.isMultimodal && message.multimodal_content?.length) {
      return { role: 'user', content: message.multimodal_content.map((part): JsonValue => part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.base64}` } }) };
    }
    if (config.isMultimodal && message.image_base64?.length) {
      return { role: 'user', content: [{ type: 'text', text: message.content }, ...message.image_base64.map((image): JsonValue =>
        ({ type: 'image_url', image_url: { url: `data:image/${detectImageFormatFromBase64(image)};base64,${image}` } }))] };
    }
    return { role: 'user', content: message.content };
  }
  if (message.role === 'assistant') {
    const call = message.tool_call;
    if (call == null) return { role: 'assistant', content: message.content };
    return { role: 'assistant', content: message.content, tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.tool_name, arguments: JSON.stringify(call.args_json) } }] };
  }
  if (message.role === 'tool') {
    return message.tool_result == null ? { role: 'assistant', content: message.content }
      : { role: 'tool', tool_call_id: message.tool_result.call_id, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function assistantToolCalls(message: JsonObject | undefined): JsonValue[] | null {
  const calls = message?.role === 'assistant' ? message.tool_calls : undefined;
  return Array.isArray(calls) && calls.length > 0 ? calls : null;
}

/** LLMManager::merge_consecutive_assistant_tool_calls (mod.rs:5248), on request messages. */
export function mergeConsecutiveAssistantToolCalls(messages: JsonObject[]): void {
  if (messages.length < 2) return;
  const merged: JsonObject[] = [];
  for (const message of messages) {
    const current = assistantToolCalls(message);
    const previous = assistantToolCalls(merged.at(-1));
    if (current === null || previous === null) {
      merged.push(message);
      continue;
    }
    previous.push(...current);
    logDebug(`[LLMManager] C2fix: Merged consecutive assistant tool_calls (+${current.length} calls, total=${previous.length})`);
  }
  messages.splice(0, messages.length, ...merged);
}

export function buildUnifiedModel2Messages(config: ApiConfig, context: Record<string, JsonValue>,
  history: readonly Model2HistoryMessage[], taskContext: string | null): JsonObject[] {
  const messages: JsonObject[] = [];
  const system = unifiedModel2SystemContent(context, taskContext);
  // Reasoning models get no system role; with history the prompt is dropped (images_base64 is always None here).
  if (!config.isReasoning) messages.push({ role: 'system', content: system });
  else if (history.length === 0) messages.push({ role: 'user', content: system });
  for (const message of history) messages.push(historyMessage(config, message));
  mergeConsecutiveAssistantToolCalls(messages);
  mergeConsecutiveUserMessagesRespectingTransients(messages, transientUserContentsForMerge([...history]));
  return messages;
}

export interface UnifiedModel2Runtime {
  manager: Pick<LLMManager, 'selectModelFor' | 'getModel2Config' | 'getFailoverPolicy' | 'getApiConfigs'>;
  candidateApiKeysFor(config: ApiConfig): Promise<string[]>;
  adapters: LlmAdapterService;
  codex: LlmCodexAuthService | undefined;
  fetch: typeof fetch;
  debugPersistConfig(): DebugPersistConfig | null;
  sleep?(milliseconds: number): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportHeaders(request: PreparedProviderRequest, config: ApiConfig): [string, string][] {
  const headers = new Headers({ Accept: 'application/json', 'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
  for (const [key, value] of request.headers) headers.set(key, value);
  let base: URL | null;
  try { base = new URL(config.baseUrl); } catch { base = null; } // Rust `if let Ok(parsed_url)`
  if (base !== null && (base.protocol === 'http:' || base.protocol === 'https:') && base.hostname !== '') {
    headers.set('Origin', `${base.protocol}//${base.hostname}`);
    headers.set('Referer', `${base.protocol}//${base.hostname}/`);
  }
  return [...headers];
}

function routedTask(taskContext: string | null): string {
  if (taskContext === null) return 'default';
  if (taskContext.includes('planner')) return 'review';
  if (taskContext === 'tag_generation' || taskContext.includes('tag')) return 'tag_generation';
  return 'default';
}

export function createUnifiedModel2(runtime: UnifiedModel2Runtime): LlmUnifiedModel2['callUnifiedModel2'] {
  /** call_unified_model_2_with_config: a single attempt; establish retries are not used on this exit. */
  async function attempt(config: ApiConfig, context: Record<string, JsonValue>, history: readonly Model2HistoryMessage[],
    subject: string, enableChainOfThought: boolean, imagePaths: string[] | null, taskContext: string | null,
    maxInputTokensOverride: number | null): Promise<StandardModel2Output> {
    const modality = ensureModelAcceptsMessageModalities(config, [...history]);
    if (modality !== null) throw modality;
    const quirks = resolveQuirks(config);
    logInfo(`调用统一模型二接口: 科目=${subject}, 思维链=${enableChainOfThought}, 图片数量=${imagePaths?.length ?? 0}, model=${config.model}`);
    const body: JsonObject = { model: config.model, messages: buildUnifiedModel2Messages(config, context, history, taskContext),
      stream: false };
    requestAdapterForConfig(config).validateReasoningConfig(config);
    applyReasoningConfig(body, config, null);
    applyGenerationParams(body, config, quirks);
    ensureOfficialDeepseekV4ReasoningPassback(body, config);
    const budget = checkRequestInputBudget(body, effectiveRequestInputLimit(config, maxInputTokensOverride), config, false);
    if (budget !== null) throw budget;

    const { request, codexRequest } = await prepareProviderRequest(runtime.adapters, runtime.codex,
      adapterFor(runtime.adapters, config), config, body, null, 'analysis', '聊天请求构建失败');
    logLlmRequestAudit('CHAT_V2_STREAM', request.url, config.model, body, runtime.debugPersistConfig());

    let response: Response;
    if (codexRequest !== null && runtime.codex !== undefined) {
      response = await runtime.codex.sendWithSingleRefresh(codexRequest, { fetch: runtime.fetch });
    } else {
      try {
        response = await runtime.fetch(request.url, { method: 'POST', headers: transportHeaders(request, config),
          body: JSON.stringify(request.body) });
      } catch (error) {
        throw tagEstablishFailure(AppError.network(`模型二API请求失败: ${messageOf(error)}`), null);
      }
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const message = `模型二API请求失败: ${statusLine(response.status)} - ${errorText}`;
      logError(`模型二API请求失败(非流式): ${message}`);
      throw tagEstablishFailure(AppError.llm(message), response.status);
    }
    let text: string;
    try { text = await response.text(); } catch (error) { throw AppError.llm(`读取模型二响应失败: ${messageOf(error)}`); }
    let json: JsonValue;
    try { json = JSON.parse(text) as JsonValue; } catch (error) { throw AppError.llm(`解析模型二响应失败: ${messageOf(error)}`); }
    const normalized = normalizeNonstreamResponseToOpenaiForConfig(config, json);
    const object = normalized as { choices?: { message?: { content?: unknown } }[] } | null;
    const content = object?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw AppError.llm('无法解析模型二API响应');
    const details: JsonValue = enableChainOfThought
      ? { full_response: content, enabled: true, is_reasoning_model: config.isReasoning, model_adapter: config.modelAdapter }
      : null;
    logDebug(`[model2_non_stream] bytes_out=${utf8ByteLength(text)}, approx_tokens_out=${estimateTokens(content)}`);
    return { assistant_message: content, raw_response: JSON.stringify(normalized), chain_of_thought_details: details,
      cancelled: false };
  }

  return async (context, chatHistory, subject, enableChainOfThought, imagePaths, taskContext, maxInputTokensOverride) => {
    const task = routedTask(taskContext);
    const routed = await runtime.manager.selectModelFor(task).then(([config]) => config, () => null);
    // Rust `unwrap_or(get_model2_config().await?)` evaluates the fallback eagerly: a model2 failure rejects
    // even when routing succeeded.
    const model2 = await runtime.manager.getModel2Config();
    return runWithFailover({
      getFailoverPolicy: () => runtime.manager.getFailoverPolicy(),
      getApiConfigs: () => runtime.manager.getApiConfigs(),
      candidateApiKeysFor: config => runtime.candidateApiKeysFor(config),
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
    }, { task, scenario: 'BackgroundTask', userPinned: false, attemptsHandle429Internally: false,
      requiredIsMultimodal: chatMessagesRequireMultimodal([...chatHistory]) || (imagePaths?.length ?? 0) > 0 ? true : null,
    }, routed ?? model2, config => attempt(config, context, chatHistory, subject, enableChainOfThought, imagePaths,
      taskContext, maxInputTokensOverride));
  };
}
