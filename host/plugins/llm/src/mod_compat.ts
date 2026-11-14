/**
 * `dstu-llm/src/llm_manager/mod.rs` 兼容层（端到端可复用的纯函数）。
 *
 * 这里集中放置 Rust 侧 `LLMManager` 的下列无状态逻辑，供尚未依赖 manager
 * 实例的调用方与迁移测试复用：
 * - `prepare_frontend_mcp_tool_for_legacy_api` + `canonical_tools` 名称编码；
 * - `build_provider_adapter`（按 `effective_api_protocol_for_config` 选传输）；
 * - `normalize_nonstream_response_to_openai`；
 * - `infer_capability_overrides_from_registry`；
 * - `question_parsing_request_body`。
 */
import type { ApiConfig } from '../api.ts';
import { decodeBase64Url, encodeBase64Url } from '../../llm-providers/api.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import {
  convertAnthropicResponseToOpenai, convertGeminiNonstreamResponseToOpenai,
  normalizeOpenaiNonstreamResponse,
} from '../../llm-providers/api.ts';
import { effectiveMaxTokens } from './generation.ts';
import { MODEL_CAPABILITY_REGISTRY_DOCUMENT } from './data/model_capability_registry.ts';
import { applyReasoningConfig, type JsonObject } from './question_authoring.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';

// ---------------------------------------------------------------------------
// canonical_tools（dstu-core/src/canonical_tools.rs）
// ---------------------------------------------------------------------------

export const CANONICAL_TOOL_NAME_PREFIX = 'ds_tool_';

/** `is_openai_compatible_tool_name`：非空且只含 ASCII 字母数字/_/-。 */
export function isOpenAiCompatibleToolName(name: string): boolean {
  return name !== '' && /^[A-Za-z0-9_-]+$/.test(name);
}

/** `encode_tool_name_for_api`：合法名称原样保留，其余做 base64url 无损编码。 */
export function encodeToolNameForApi(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (isOpenAiCompatibleToolName(trimmed) && !trimmed.startsWith(CANONICAL_TOOL_NAME_PREFIX)) {
    return trimmed;
  }
  return `${CANONICAL_TOOL_NAME_PREFIX}${encodeBase64Url(encodeUtf8(trimmed))}`;
}

/** `decode_tool_name_from_api`：非编码名称原样返回，编码名称还原原文。 */
export function decodeToolNameFromApi(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (!trimmed.startsWith(CANONICAL_TOOL_NAME_PREFIX)) return trimmed;

  const encoded = trimmed.slice(CANONICAL_TOOL_NAME_PREFIX.length);
  // Rust URL_SAFE_NO_PAD 拒绝外来字符表与不可能的编码长度。
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(decodeBase64Url(encoded));
  } catch { // boundary-allow empty-catch: Rust URL_SAFE_NO_PAD 解码 `.ok()?` 失败返回 None，不记录日志
    return null;
  }
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `normalize_function_parameters`：非对象参数回落为 `{type:'object',properties:{}}`。 */
function normalizeFunctionParameters(parameters: JsonValue | undefined): JsonObject {
  const schema: JsonObject = isJsonObject(parameters)
    ? { ...parameters }
    : { type: 'object', properties: {} };
  if (!Object.hasOwn(schema, 'type')) schema.type = 'object';
  if (!Object.hasOwn(schema, 'properties')) schema.properties = {};
  return schema;
}

/** `build_openai_function_tool_schema`：工具清单里下发给 API 的 function schema。 */
export function buildOpenAiFunctionToolSchema(
  apiName: string,
  description: string | null | undefined,
  parameters: JsonValue | undefined,
): JsonObject {
  return {
    type: 'function',
    function: {
      name: apiName,
      description: description ?? '',
      parameters: normalizeFunctionParameters(parameters),
    },
  };
}

/** 前端桥接工具（`FrontendMcpTool`）的最小字段集。 */
export interface FrontendMcpTool {
  name: string;
  description?: string | null;
  inputSchema?: JsonValue;
}

export interface PreparedExternalTool {
  bridgeName: string;
  internalToolName: string;
  apiName: string;
  schema: JsonObject;
}

/**
 * `LLMManager::prepare_frontend_mcp_tool_for_legacy_api`：
 * `CanonicalExternalToolConfig { internal_prefix: None, preserve_prefix: None,
 * api_name_prefix, include_server_suffix: false, api_name_source: BridgeName }`。
 */
export function prepareFrontendMcpToolForLegacyApi(
  mcpTool: FrontendMcpTool,
  apiNamePrefix: string | null | undefined,
): PreparedExternalTool | null {
  const bridgeName = mcpTool.name.trim();
  if (bridgeName === '') return null;

  const internalToolName = bridgeName;
  const apiBaseName = apiNamePrefix === null || apiNamePrefix === undefined
    ? bridgeName
    : `${apiNamePrefix}${bridgeName}`;
  const apiName = encodeToolNameForApi(apiBaseName);
  if (apiName === null) return null;

  return {
    bridgeName,
    internalToolName,
    apiName,
    schema: buildOpenAiFunctionToolSchema(apiName, mcpTool.description, mcpTool.inputSchema),
  };
}

// ---------------------------------------------------------------------------
// build_provider_adapter（mod.rs:4166）
// ---------------------------------------------------------------------------

/**
 * 按生效协议选择供应商传输适配器。与 `provider_adapter.ts` 的包装不同，
 * 这里保留 Rust 的判定顺序：先看 `effective_api_protocol_for_config`，只有
 * OpenAI 兼容传输才用 OpenAI 协议构造请求。
 */
export { providerAdapterForConfig as buildProviderAdapterForConfig } from './provider_adapter.ts';

// ---------------------------------------------------------------------------
// normalize_nonstream_response_to_openai（mod.rs:4194）
// ---------------------------------------------------------------------------

function geminiSafetyMessage(response: JsonValue): string | null {
  const record = isJsonObject(response) ? response : null;
  const promptFeedback = record !== null ? record.promptFeedback : undefined;
  if (isJsonObject(promptFeedback)) {
    const blockReason = promptFeedback.blockReason;
    if (typeof blockReason === 'string') {
      return `Gemini安全阻断: ${JSON.stringify({
        type: 'safety_error',
        reason: blockReason,
        details: promptFeedback,
      })}`;
    }
  }

  const candidates = record !== null ? record.candidates : undefined;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!isJsonObject(candidate)) continue;
      if (candidate.finishReason !== 'SAFETY') continue;
      return `Gemini安全阻断: ${JSON.stringify({
        type: 'safety_error',
        reason: 'SAFETY',
        details: candidate,
      })}`;
    }
  }
  return null;
}

function convertResponsesToOpenaiResponse(response: JsonValue): JsonValue {
  const record = isJsonObject(response) ? response : null;
  const status = record !== null && typeof record.status === 'string' ? record.status : null;
  const error = record !== null ? record.error : undefined;
  if ((error !== undefined && error !== null)
    || status === 'failed' || status === 'cancelled' || status === 'canceled') {
    const errorRecord = isJsonObject(error) ? error : null;
    const rawCode = errorRecord !== null ? (errorRecord.code ?? errorRecord.type) : undefined;
    const code = typeof rawCode === 'string' ? rawCode : 'response_failed';
    throw AppError.llm(`Responses 请求失败: ${code}`);
  }

  const textSegments: string[] = [];
  const output = record !== null ? record.output : undefined;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isJsonObject(item) || !Array.isArray(item.content)) continue;
      for (const entry of item.content) {
        if (!isJsonObject(entry)) continue;
        const entryType = typeof entry.type === 'string' ? entry.type : '';
        if (entryType === 'refusal') throw AppError.llm('模型拒绝了该请求');
        if (entryType === 'output_text' || entryType === 'text') {
          if (typeof entry.text === 'string' && entry.text !== '') textSegments.push(entry.text);
        }
      }
    }
  }
  if (textSegments.length === 0 && record !== null && typeof record.output_text === 'string'
    && record.output_text !== '') {
    textSegments.push(record.output_text);
  }
  if (textSegments.length === 0 && status === 'incomplete') {
    throw AppError.llm('Responses 请求未能完成');
  }

  return {
    choices: [{ message: { content: textSegments.join('') } }],
    usage: record !== null ? (record.usage ?? null) : null,
  };
}

function convertAnthropicToOpenaiResponse(config: ApiConfig, response: JsonValue): JsonValue {
  const record = isJsonObject(response) ? response : null;
  const stopDetails = record !== null && isJsonObject(record.stop_details) ? record.stop_details : null;
  const rawCategory = stopDetails !== null ? stopDetails.category : undefined;
  const refusalCategory = typeof rawCategory === 'string' && rawCategory !== '' && rawCategory !== 'none'
    ? rawCategory : null;
  if ((record !== null && record.stop_reason === 'refusal') || refusalCategory !== null) {
    const suffix = refusalCategory === null ? '' : `: ${refusalCategory}`;
    throw AppError.llm(`模型拒绝了该请求${suffix}`);
  }
  const converted = convertAnthropicResponseToOpenai(response, config.model);
  if (converted === undefined) throw AppError.llm('解析Anthropic响应失败');
  return converted;
}

/**
 * `normalize_nonstream_response_to_openai`：把供应商原生非流式响应归一为
 * OpenAI Chat Completions 形状；原生协议下先做安全/拒绝判定。
 */
export function normalizeNonstreamResponseToOpenaiForConfig(
  config: ApiConfig,
  responseJson: JsonValue,
): JsonValue {
  switch (effectiveApiProtocolForConfig(config)) {
    case 'google_generate_content': {
      const safety = geminiSafetyMessage(responseJson);
      if (safety !== null) throw AppError.llm(safety);
      return convertGeminiNonstreamResponseToOpenai(responseJson, config.model);
    }
    case 'anthropic_messages':
      return convertAnthropicToOpenaiResponse(config, responseJson);
    case 'openai_responses':
      return convertResponsesToOpenaiResponse(responseJson);
    default:
      return normalizeOpenaiNonstreamResponse(responseJson);
  }
}

// ---------------------------------------------------------------------------
// 模型能力注册表推断（mod.rs:4474-4573）
// ---------------------------------------------------------------------------

export interface RegistryCapabilityOverrides {
  isMultimodal: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
}

interface RegistryCapabilities {
  vision?: boolean;
  function_calling?: boolean;
  reasoning?: boolean;
  max_context_tokens?: number | null;
}

interface RegistryModelRecord {
  model_id: string;
  provider_scope?: string | null;
  provider_model_id?: string | null;
  alias_of?: string | null;
  capabilities: RegistryCapabilities;
}

interface RegistrySeriesRecord {
  models: RegistryModelRecord[];
}

interface RegistryDocument {
  records: RegistrySeriesRecord[];
}

const MODEL_CAPABILITY_REGISTRY: readonly RegistryModelRecord[] = (
  MODEL_CAPABILITY_REGISTRY_DOCUMENT as unknown as RegistryDocument
).records.flatMap((record: RegistrySeriesRecord) => record.models);

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProviderScope(value: string | null | undefined): string | null {
  const scope = (value ?? '').trim().toLowerCase();
  return scope === '' ? null : scope;
}

function splitModelName(value: string): string[] {
  return normalizeModelId(value).split(/[/:\\]/);
}

function baseModelId(value: string): string {
  const parts = splitModelName(value);
  return parts[parts.length - 1] ?? '';
}

function matchesFullModelId(input: string, candidate: string | null | undefined): boolean {
  if (candidate === null || candidate === undefined) return false;
  const normalized = normalizeModelId(candidate);
  return input === normalized || input.endsWith(`/${normalized}`) || input.endsWith(`:${normalized}`);
}

function registryRecordScore(
  modelId: string,
  providerScope: string | null | undefined,
  record: RegistryModelRecord,
): number {
  const normalizedInput = normalizeModelId(modelId);
  if (normalizedInput === '') return -1;

  const baseId = baseModelId(modelId);
  const requestedScope = normalizeProviderScope(providerScope);
  const recordScope = normalizeProviderScope(record.provider_scope);

  let score: number;
  if (matchesFullModelId(normalizedInput, record.provider_model_id)) score = 500;
  else if (matchesFullModelId(normalizedInput, record.model_id)) score = 450;
  else if (matchesFullModelId(normalizedInput, record.alias_of)) score = 430;
  else if (record.provider_model_id !== null && record.provider_model_id !== undefined
    && baseModelId(record.provider_model_id) === baseId) score = 320;
  else if (baseModelId(record.model_id) === baseId) score = 300;
  else if (record.alias_of !== null && record.alias_of !== undefined
    && baseModelId(record.alias_of) === baseId) score = 280;
  else score = -1;

  if (score < 0) return score;

  if (requestedScope !== null) {
    if (recordScope === requestedScope) score += 40;
    else if (recordScope === null) score += 10;
  } else if (recordScope === null) {
    score += 20;
  }
  return score;
}

/**
 * `infer_capability_overrides_from_registry`：仅查静态能力注册表，不合并内置
 * 目录。`capabilities.ts` 的 `resolve_capability_overrides` 是合并后的结果，
 * 需要注册表单独结论时用这里。
 */
export function inferCapabilityOverridesFromRegistry(
  modelId: string,
  providerScope: string | null | undefined,
): RegistryCapabilityOverrides | null {
  let bestRecord: RegistryModelRecord | null = null;
  let bestScore = -1;
  for (const record of MODEL_CAPABILITY_REGISTRY) {
    const score = registryRecordScore(modelId, providerScope, record);
    if (score > bestScore) {
      bestScore = score;
      bestRecord = record;
    }
  }
  if (bestRecord === null) return null;
  return {
    isMultimodal: bestRecord.capabilities.vision === true,
    supportsTools: bestRecord.capabilities.function_calling === true,
    supportsReasoning: bestRecord.capabilities.reasoning === true,
    contextWindow: bestRecord.capabilities.max_context_tokens ?? null,
  };
}

// ---------------------------------------------------------------------------
// question_parsing_request_body（mod.rs:8741）
// ---------------------------------------------------------------------------

const QUESTION_PARSING_SYSTEM_PROMPT =
  '你是一个专业的题目解析助手。请准确识别文档中的题目，并按指定格式输出。';

/** `LLMManager::question_parsing_request_body`：解析题目的一次性请求体。 */
export function questionParsingRequestBody(apiConfig: ApiConfig, prompt: string): JsonObject {
  const body: JsonObject = {
    model: apiConfig.model,
    messages: [
      { role: 'system', content: QUESTION_PARSING_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: effectiveMaxTokens(apiConfig.maxOutputTokens, apiConfig.maxTokensLimit),
  };
  applyReasoningConfig(body, apiConfig, null);
  return body;
}
