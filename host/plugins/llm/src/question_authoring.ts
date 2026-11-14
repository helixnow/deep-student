/**
 * 题目结构化解析请求（移植 `dstu-llm/src/llm_manager/question_authoring.rs`）。
 *
 * 经 llmStreaming.singleShotCompletion（真实 provider 适配器/Codex 共享认证）发送一次性流式补全，要求模型返回完整 JSON 对象；
 * 仅在错误明确指向 JSON 参数不受支持时才降级重试一次，并把不兼容记入
 * 进程内缓存（900 秒）。不搜索 JSON 子串、不修复截断响应。
 */
import type { ApiConfig } from '../api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { effectiveMaxTokens } from './generation.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { mapReasoningLevelForConfig } from './reasoning_level_map.ts';
import type { LlmStreamingService } from '../api.ts';
import { defaultSingleShotOptions, type SingleShotCompletion, type SingleShotOptions } from './single_shot_stream.ts';
import { logInfo } from './logging.ts';
import { removeKey } from './json_map.ts';

export type JsonObject = { [key: string]: JsonValue };

export interface QuestionJsonCompletion {
  content: string;
  finishReason: string | null;
  usage: JsonValue;
  jsonMode: boolean;
}

export interface QuestionAuthoringDeps {
  /** Rust manager.single_shot_completion (question_authoring.rs:193). */
  streaming: LlmStreamingService;
  decryptApiKey(apiKey: string): Promise<string>;
  /** 兼容缓存时钟；测试可注入固定时间。 */
  now?(): number;
}

const JSON_UNSUPPORTED = new Map<string, number>();
const JSON_UNSUPPORTED_TTL_MS = 900_000;

function nowMs(deps: QuestionAuthoringDeps): number {
  return deps.now?.() ?? Date.now();
}

/** 清空 JSON 参数兼容缓存（测试隔离用）。 */
export function resetQuestionAuthoringCompatibilityCache(): void {
  JSON_UNSUPPORTED.clear();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 只剥离完整的传输包装（```json / ``` 围栏）。绝不搜索 JSON 子串或修复、
 * 截断不完整的模型响应。
 */
export function completeJsonPayload(content: string): string {
  let text = content.trim().replace(/^\uFEFF+/, '').trim();
  const fenced = text.startsWith('```json\n')
    ? text.slice('```json\n'.length)
    : text.startsWith('```\n') ? text.slice('```\n'.length) : null;
  if (fenced !== null) {
    text = fenced.endsWith('```') ? fenced.slice(0, -'```'.length).trim() : text;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('expected a JSON object');
  }
  return text;
}

interface ErrorShape {
  message: string;
  details?: JsonValue;
}

function errorShape(error: unknown): ErrorShape {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { message?: unknown; details?: unknown };
    if (typeof candidate.message === 'string') {
      return { message: candidate.message, details: candidate.details as JsonValue };
    }
  }
  return { message: String(error) };
}

function valueText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 仅当错误明确指向参数不受支持时才禁用 JSON 模式。 */
export function rejectsJsonMode(error: ErrorShape): boolean {
  const details = error.details;
  if (details === null || details === undefined || typeof details !== 'object' || Array.isArray(details)) {
    return false;
  }
  const record = details as { [key: string]: JsonValue };
  const status = record.status;
  if (status !== 400 && status !== 422) return false;

  const message = `${error.message} ${valueText(record.body)}`.toLowerCase();
  const parameter = [
    'response_format',
    'json_object',
    'responsemime',
    'response_mime',
    'output_config',
    'text.format',
  ].some((word) => message.includes(word));
  const unsupported = [
    'unsupported',
    'not supported',
    'not support',
    'unknown parameter',
    'unrecognized',
    'not permitted',
    'not allowed',
    'invalid parameter',
    '不支持',
  ].some((word) => message.includes(word));
  return parameter && unsupported;
}

/** 兼容性缓存键：同一配置/协议/额外请求体共享 JSON 模式降级结论。 */
export function compatibilityKey(config: ApiConfig): string {
  return [
    config.id,
    config.baseUrl,
    config.model,
    config.apiProtocol ?? 'none',
    config.modelAdapter,
    config.extraBody === null || config.extraBody === undefined ? 'none' : JSON.stringify(config.extraBody),
  ].join('|');
}

/**
 * `LLMManager::apply_reasoning_config`（mod.rs:4871）的等价实现：先按适配器
 * 移除采样参数，再做档位映射，最后交给适配器写入推理字段与通用参数。
 */
export function applyReasoningConfig(
  body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
): void {
  const adapter = requestAdapterForConfig(config);
  if (adapter.shouldRemoveSamplingParams(config)) {
    removeKey(body, 'temperature');
    removeKey(body, 'top_p');
    removeKey(body, 'presence_penalty');
    removeKey(body, 'frequency_penalty');
    removeKey(body, 'logprobs');
  }
  const mapped = mapReasoningLevelForConfig(config);
  const effective = mapped ?? config;
  if (adapter.applyReasoningConfig(body, effective, enableThinking)) return;
  adapter.applyCommonParams(body, effective);
}

function outputContract(system: string): string {
  return 'END OF SOURCE DATA. The following is the output contract, not document content.\n'
    + 'Return exactly one complete JSON object. Do not render a Markdown question list, a report, or code fences.\n'
    + 'The first non-whitespace character must be { and the last must be }.\n'
    + 'Apply the following task instructions to ALL original evidence above; never summarize or discard source pages:\n'
    + `${system}`;
}

/**
 * 构造题目解析请求体。专用输出契约同时出现在 system 与最后一个 source page
 * 之后，避免推理模型中转忽略 JSON 模式后按最后一页的自然语言作答。
 */
export function requestBody(
  config: ApiConfig, system: string, content: JsonValue, jsonMode: boolean,
): JsonObject {
  const contract = outputContract(system);
  let messageContent: JsonValue;
  if (Array.isArray(content)) {
    messageContent = [...content, { type: 'text', text: contract }];
  } else if (typeof content === 'string') {
    messageContent = `${content}\n\n${contract}`;
  } else {
    messageContent = content;
  }

  const body: JsonObject = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: messageContent },
    ],
    temperature: config.temperature,
    max_tokens: effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit),
  };
  if (config.topPOverride !== null && config.topPOverride !== undefined) {
    body.top_p = config.topPOverride;
  }
  if (config.frequencyPenaltyOverride !== null && config.frequencyPenaltyOverride !== undefined) {
    body.frequency_penalty = config.frequencyPenaltyOverride;
  }
  if (config.presencePenaltyOverride !== null && config.presencePenaltyOverride !== undefined) {
    body.presence_penalty = config.presencePenaltyOverride;
  }
  if (jsonMode) body.response_format = { type: 'json_object' };
  applyReasoningConfig(body, config, null);
  if (!jsonMode) removeKey(body, 'response_format');
  return body;
}

/** 执行一次题目 JSON 解析；显式 JSON 被拒时用同样输入重试一次。 */
export async function runQuestionJson(
  deps: QuestionAuthoringDeps,
  config: ApiConfig,
  systemPrompt: string,
  userContent: JsonValue,
  cancel: AbortSignal | null = null,
): Promise<QuestionJsonCompletion> {
  const key = compatibilityKey(config);
  const timestamp = nowMs(deps);
  for (const [cachedKey, cachedAt] of JSON_UNSUPPORTED) {
    if (timestamp - cachedAt >= JSON_UNSUPPORTED_TTL_MS) JSON_UNSUPPORTED.delete(cachedKey);
  }
  let jsonMode = !JSON_UNSUPPORTED.has(key);
  const apiKey = await deps.decryptApiKey(config.apiKey);
  const opts: SingleShotOptions = { ...defaultSingleShotOptions(`题目文档解析(${config.model})`), maxRetries: 0 };
  if (cancel !== null) opts.cancel = cancel;
  // Transport memory bound derived from configured output, not an extra token limit.
  opts.maxStreamBytes = Math.max(
    effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit) * 2048,
    32 * 1024 * 1024,
  );

  for (;;) {
    const body = requestBody(config, systemPrompt, userContent, jsonMode);
    let completion: SingleShotCompletion;
    try {
      completion = await deps.streaming.singleShotCompletion(config, body as JsonValue, apiKey, null,
        '题目解析请求构建失败', opts, null);
    } catch (error) {
      if (jsonMode && rejectsJsonMode(errorShape(error))) {
        jsonMode = false;
        JSON_UNSUPPORTED.set(key, nowMs(deps));
        logInfo(`[QuestionAuthoring] ${config.model} rejects JSON mode; retrying complete input once`);
        continue;
      }
      throw error;
    }

    if (
      completion.aborted
      || completion.interrupted !== null
      || (completion.finishReason !== null
        && ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS'].includes(completion.finishReason))
    ) {
      throw AppError.with_details(
        'LLM',
        '题目解析结果被截断，未创建正式题目。请调整所选模型的输出/上下文配置后重试。',
        {
          code: 'INCOMPLETE_OUTPUT',
          finish_reason: completion.finishReason,
          raw_response: completion.content,
        },
      );
    }

    let content: string;
    try {
      content = completeJsonPayload(completion.content);
    } catch (error) {
      throw AppError.with_details(
        'LLM',
        `题目解析未返回完整 JSON 对象: ${messageOf(error)}`,
        {
          code: 'INVALID_JSON',
          raw_response: completion.content,
          model: config.model,
          json_mode: jsonMode,
          finish_reason: completion.finishReason,
          reasoning_bytes: completion.reasoningBytes,
          usage: completion.usage,
        },
      );
    }

    return {
      content,
      finishReason: completion.finishReason,
      usage: completion.usage ?? null,
      jsonMode,
    };
  }
}
