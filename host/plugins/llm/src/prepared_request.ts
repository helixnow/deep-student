/**
 * 供应商请求准备（model2_pipeline.rs PreparedProviderRequest /
 * merge_configured_provider_headers / prepare_plain_provider_request_scoped）。
 */
import { prepareRemoteImages, type LlmAdapterService, type LlmCodexAuthService, type ProviderAdapter, type ProviderRequest,
  type PreparedProviderRequest as CodexPreparedRequest } from '../../llm-providers/api.ts';
import type { ApiConfig } from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { normalizeDeepseekChatRequest } from './adapters/deepseek.ts';
import {
  VENDOR_ID, PROVIDER_TYPE, TASK_SESSION_ID, identityHeaders, isOpencodeGoConfig,
  sessionHeaderValue, userAgent,
} from './opencode_go.ts';
import { providerAcceptsPromptCacheKey, stablePromptCacheKey } from './prompt_cache.ts';
import { effectiveApiProtocolForConfig, isOpenaiCodexOAuth } from './protocol.ts';

/** 与 package.json 对齐的 DeepStudent 版本（身份头前缀）。 */
export const APP_VERSION = '0.11.0';

export interface PreparedProviderRequest {
  url: string;
  headers: [string, string][];
  body: JsonValue;
  codex: boolean;
  opencodeGo: boolean;
}

/** Async manager boundary: remote images and OAuth belong to the shared L01 runtime. */
export async function prepareProviderRequest(
  adapters: Pick<LlmAdapterService, 'prepareRemoteImages'>, codex: LlmCodexAuthService | undefined, adapter: ProviderAdapter,
  config: ApiConfig, body: JsonValue, apiKey: string | null, sessionId: string | null,
  buildErrorContext: string, agentSessionId: string | null = null,
): Promise<{ request: PreparedProviderRequest; codexRequest: CodexPreparedRequest | null }> {
  if (isOpenaiCodexOAuth(config) && codex !== undefined) {
    const request = await codex.prepareRequest(adapter,
      { ...config, effectiveApiProtocol: effectiveApiProtocolForConfig(config) }, body,
      { apiKeyOverride: apiKey, sessionId, buildErrorContext });
    return { request: { ...request, codex: true, opencodeGo: false }, codexRequest: request };
  }
  const preparedBody = await (adapters.prepareRemoteImages ?? prepareRemoteImages)(body);
  return { request: preparePlainProviderRequest(adapter, config, preparedBody, apiKey, sessionId,
    buildErrorContext, agentSessionId), codexRequest: null };
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function preparedFromProvider(request: ProviderRequest): PreparedProviderRequest {
  return {
    url: request.url,
    headers: request.headers.map(([name, value]) => [name, value]),
    body: request.body,
    codex: false,
    opencodeGo: false,
  };
}

/** 追加供应商自定义头；同名（大小写不敏感）由传输层胜出。 */
export function appendProviderHeaderIfAbsent(
  headers: [string, string][],
  name: string,
  value: string,
): void {
  if (!HEADER_NAME.test(name)) return;
  if (/[\r\n\0]/.test(value)) return;
  const lower = name.toLowerCase();
  if (headers.some(([existing]) => existing.toLowerCase() === lower)) return;
  headers.push([lower, value]);
}

export function mergeConfiguredProviderHeaders(
  request: PreparedProviderRequest,
  configuredHeaders: Record<string, string> | null | undefined,
): void {
  if (configuredHeaders === null || configuredHeaders === undefined) return;
  for (const [name, value] of Object.entries(configuredHeaders)) {
    appendProviderHeaderIfAbsent(request.headers, name, value);
  }
}

/**
 * 非 Codex-OAuth 配置的同步请求准备。OpenCode Go 只允许 Agent 对话使用，
 * 非 Agent 调用照常放行但使用任务会话标识。
 */
export function preparePlainProviderRequest(
  adapter: ProviderAdapter,
  config: ApiConfig,
  requestBody: JsonValue,
  apiKeyOverride: string | null,
  sessionId: string | null,
  buildErrorContext: string,
  agentSessionId: string | null = null,
): PreparedProviderRequest {
  void buildErrorContext;
  if (isOpenaiCodexOAuth(config)) {
    throw AppError.configuration('OpenAI Codex OAuth 请求必须经由 LLMManager 准备');
  }
  const opencodeGoSession = isOpencodeGoConfig(config)
    ? (agentSessionId === null ? null : sessionHeaderValue(agentSessionId))
      ?? (sessionId === null ? null : sessionHeaderValue(sessionId))
      ?? TASK_SESSION_ID
    : null;

  const apiKey = apiKeyOverride ?? config.apiKey;
  const providerRequest = adapter.buildRequest(config.baseUrl, apiKey, config.model, requestBody);
  const prepared = preparedFromProvider(providerRequest);
  normalizeDeepseekChatRequest(prepared.body, config);
  if (opencodeGoSession !== null) {
    for (const [name, value] of identityHeaders(opencodeGoSession, APP_VERSION)) {
      appendProviderHeaderIfAbsent(prepared.headers, name, value);
    }
    prepared.opencodeGo = true;
  }
  mergeConfiguredProviderHeaders(prepared, config.headers);

  if (providerAcceptsPromptCacheKey(config)) {
    const body = prepared.body;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const object = body as { [key: string]: JsonValue };
      if (!Object.prototype.hasOwnProperty.call(object, 'prompt_cache_key')) {
        object.prompt_cache_key = stablePromptCacheKey(sessionId);
      }
    }
  }
  return prepared;
}

/** OpenCode Go identity 常量在测试/调用方共享。 */
export { VENDOR_ID, PROVIDER_TYPE, userAgent };
