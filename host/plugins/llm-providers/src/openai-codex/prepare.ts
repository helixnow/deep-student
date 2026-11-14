/**
 * Codex OAuth request preparation and single-refresh send
 * (`model2_pipeline.rs` prepare_provider_request / install_codex_headers /
 * send_codex_request_with_single_refresh / send_codex_stream_request_with_single_refresh).
 */
import { validateHeaderValue } from './header-value.ts';
import type { JsonValue, PluginLogger, ProviderAdapter } from '../../api.ts';
import { AppError } from '../../../../platform/errors/api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { object } from '../json.ts';
import { prepareRemoteImages } from '../media/remote-image.ts';
import { CodexAuthError } from './error.ts';
import type { CodexAuthManager } from './manager.ts';
import { buildCodexRequestHeaders, prepareCodexResponsesBody } from './protocol.ts';
import { bridgeCodexNonstreamResponse, normalizeCodexErrorResponse } from './response.ts';
import type { CodexRequestAuth } from './types.ts';

export const FALLBACK_PROMPT_CACHE_KEY = 'deep-student-background';

/** Structural subset of L02 `ApiConfig` used by the Codex request path. */
export interface CodexRequestConfig {
  authMode?: string | null;
  providerType?: string | null;
  providerScope?: string | null;
  modelAdapter?: string | null;
  apiProtocol?: string | null;
  /**
   * Authoritative result of L02's `effective_api_protocol_for_config`.
   * When present it overrides the local fallback below.
   */
  effectiveApiProtocol?: string | null;
  supportsOpenaiResponses?: boolean | null;
  baseUrl: string;
  model: string;
  apiKey: string;
  headers?: Record<string, string> | null;
}

export interface CodexPrepareOptions {
  apiKeyOverride?: string | null;
  sessionId?: string | null;
  buildErrorContext?: string;
}

export interface PreparedProviderRequest {
  url: string;
  headers: [string, string][];
  body: JsonValue;
  /** `None` for non-Codex configs. */
  codex: { generation: number; sessionId: string } | null;
}

export interface CodexSendOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** App version used for the User-Agent after a 401 refresh. */
  version?: string;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isCodexOAuthConfig(config: { authMode?: string | null }): boolean {
  return config.authMode === 'openai_codex_oauth';
}

/** model2_pipeline.rs:4764 `stable_prompt_cache_key`. */
export function stablePromptCacheKey(sessionId: string | null | undefined): string {
  const trimmed = rustTrim(sessionId ?? '');
  return trimmed === '' ? FALLBACK_PROMPT_CACHE_KEY : trimmed;
}

function normalizeProtocolValue(value: string | null | undefined): string {
  // llm_manager/mod.rs:3775-3776 uses Rust White_Space (NEL yes, BOM no).
  return rustTrim(value ?? '').toLowerCase();
}

/**
 * model2_pipeline.rs:4995 `should_use_openai_responses_for_config`.
 *
 * L02 should pass the authoritative `effectiveApiProtocol`. The local fallback
 * still honours Rust's precedence: explicit chat/anthropic/google wins over
 * `supportsOpenaiResponses`/`providerType`; only then do capability/provider
 * defaults apply.
 */
export function effectiveCodexProtocol(config: CodexRequestConfig): string {
  const authoritative = normalizeProtocolValue(config.effectiveApiProtocol);
  if (authoritative !== '') return authoritative;

  const explicit = normalizeProtocolValue(config.apiProtocol);
  if (explicit === 'openai_chat_completions'
    || explicit === 'anthropic_messages'
    || explicit === 'google_generate_content') {
    return explicit;
  }

  const provider = normalizeProtocolValue(config.providerType);
  if (explicit === 'openai_responses') {
    if (provider === 'anthropic') return 'anthropic_messages';
    if (provider === 'google' || provider === 'gemini') return 'google_generate_content';
    return 'openai_responses';
  }

  if (provider === 'anthropic') return 'anthropic_messages';
  if (provider === 'google' || provider === 'gemini') return 'google_generate_content';
  if (config.supportsOpenaiResponses === true || provider === 'openai_codex') {
    return 'openai_responses';
  }
  return 'openai_chat_completions';
}

function usesOpenaiResponses(config: CodexRequestConfig): boolean {
  return effectiveCodexProtocol(config) === 'openai_responses';
}

/** model2_pipeline.rs:4069 `append_provider_header_if_absent`. */
export function appendProviderHeaderIfAbsent(
  headers: [string, string][], name: string, value: string,
  source = 'vendor-configured', warnOnConflict = true, logger?: PluginLogger,
): void {
  if (!HEADER_NAME.test(name)) {
    logger?.warn(`[LLM Headers] Ignoring invalid ${source} header name: ${name}`);
    return;
  }
  try {
    validateHeaderValue(name, value);
  } catch {
    logger?.warn(`[LLM Headers] Ignoring invalid value for ${source} header: ${name.toLowerCase()}`);
    return;
  }
  const lower = name.toLowerCase();
  if (headers.some(([existing]) => existing.toLowerCase() === lower)) {
    if (warnOnConflict) {
      logger?.warn(`[LLM Headers] Ignoring configured ${lower} because the provider transport owns it`);
    }
    return;
  }
  headers.push([lower, value]);
}

/** model2_pipeline.rs:4108 `merge_configured_provider_headers`. */
export function mergeConfiguredProviderHeaders(
  request: PreparedProviderRequest, configured: Record<string, string> | null | undefined,
  logger?: PluginLogger,
): void {
  if (configured === null || configured === undefined) return;
  for (const [name, value] of Object.entries(configured)) {
    appendProviderHeaderIfAbsent(request.headers, name, value, 'vendor-configured', true, logger);
  }
}

function codexConfigurationError(context: string, error: unknown, logger?: PluginLogger): AppError {
  const message = error instanceof Error ? error.message : String(error);
  logger?.warn('[OpenAI Codex OAuth] %s: %s', context, message);
  return AppError.configuration(
    `OpenAI Codex 登录状态不可用（${context}），请在模型设置中重新登录`,
  );
}

/** model2_pipeline.rs:4809 `install_codex_headers`. */
export function installCodexHeaders(
  request: PreparedProviderRequest, auth: CodexRequestAuth, sessionId: string, version: string,
  logger?: PluginLogger,
): void {
  const prior = request.headers;
  let generated: Record<string, string>;
  try {
    generated = buildCodexRequestHeaders(auth, sessionId, version);
  } catch (error) {
    throw codexConfigurationError('构建请求头', error, logger);
  }
  const next: [string, string][] = [];
  for (const [name, value] of Object.entries(generated)) {
    try {
      validateHeaderValue(name, value);
    } catch {
      throw codexConfigurationError('编码请求头', 'invalid header value', logger);
    }
    next.push([name.toLowerCase(), value]);
  }
  request.headers = next;
  for (const [name, value] of prior) {
    appendProviderHeaderIfAbsent(request.headers, name, value, 'pre-existing', false, logger);
  }
}

/**
 * `prepare_provider_request` Codex branch. Non-Codex configs are returned as a
 * plain prepared request (headers + remote-image preparation) but without the
 * L02-only DeepSeek/OpenCode-Go normalization; L02 should keep using its own
 * `preparePlainProviderRequest` for those configs.
 */
export async function prepareProviderRequest(
  manager: CodexAuthManager,
  adapter: ProviderAdapter,
  config: CodexRequestConfig,
  requestBody: JsonValue,
  options: CodexPrepareOptions = {},
  logger?: PluginLogger,
  version = '0.11.0',
): Promise<PreparedProviderRequest> {
  const preparedBody = await prepareRemoteImages(requestBody);
  const apiKey = options.apiKeyOverride ?? config.apiKey;
  let providerRequest: ReturnType<ProviderAdapter['buildRequest']>;
  try {
    providerRequest = adapter.buildRequest(config.baseUrl, apiKey, config.model, preparedBody);
  } catch (error) {
    const context = options.buildErrorContext ?? '构建请求失败';
    throw AppError.llm(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const prepared: PreparedProviderRequest = {
    url: providerRequest.url,
    headers: providerRequest.headers.map(([name, value]) => [name, value]),
    body: providerRequest.body,
    codex: null,
  };
  mergeConfiguredProviderHeaders(prepared, config.headers, logger);
  if (!isCodexOAuthConfig(config)) return prepared;

  if (!usesOpenaiResponses(config)) {
    throw AppError.configuration('OpenAI Codex OAuth 仅支持 OpenAI Responses 协议');
  }
  let auth: CodexRequestAuth;
  try {
    auth = await manager.requestAuth(false);
  } catch (error) {
    throw codexConfigurationError('获取访问凭据', error, logger);
  }
  const sessionId = stablePromptCacheKey(options.sessionId);
  prepared.url = manager.responsesEndpoint();
  try {
    prepared.body = prepareCodexResponsesBody(prepared.body);
  } catch (error) {
    throw codexConfigurationError('准备 Responses 请求', error, logger);
  }
  const body = object(prepared.body);
  if (body !== undefined && !Object.hasOwn(body, 'prompt_cache_key')) body.prompt_cache_key = sessionId;
  installCodexHeaders(prepared, auth, sessionId, version, logger);
  prepared.codex = { generation: auth.generation(), sessionId };
  return prepared;
}

/**
 * `send_codex_stream_request_with_single_refresh`: stream primitive.
 * Each POST gets its own timeout signal; a token refresh between attempts is
 * not charged against either POST's timeout (model2_pipeline.rs:5055-5059).
 */
export async function sendCodexStreamRequestWithSingleRefresh(
  manager: CodexAuthManager,
  request: PreparedProviderRequest,
  options: CodexSendOptions = {},
  logger?: PluginLogger,
): Promise<Response> {
  if (request.codex === null) {
    throw AppError.configuration('OpenAI Codex 请求缺少 OAuth 上下文');
  }
  const fetchImpl = options.fetch ?? fetch;
  let refreshed = false;
  for (;;) {
    const signal = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw AppError.network(
        `OpenAI Codex 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    response = await normalizeCodexErrorResponse(response, logger);
    if (response.status === 401) {
      if (!refreshed) {
        let auth: CodexRequestAuth;
        try {
          auth = await manager.refreshAfterUnauthorized(request.codex.generation);
        } catch (error) {
          throw codexConfigurationError('刷新访问凭据', error, logger);
        }
        installCodexHeaders(
          request, auth, request.codex.sessionId, options.version ?? '0.11.0', logger,
        );
        request.codex = { generation: auth.generation(), sessionId: request.codex.sessionId };
        refreshed = true;
        continue;
      }
      await manager.markReauthenticationRequired(request.codex.generation);
      throw AppError.configuration('OpenAI Codex 授权已失效，请在模型设置中重新登录');
    }
    if (response.status === 403) {
      throw AppError.configuration('OpenAI Codex 账号无权执行此请求');
    }
    return response;
  }
}

/**
 * `send_codex_request_with_single_refresh`: non-stream entry.
 * Rust always bridges a successful SSE response to canonical Responses JSON
 * (`bridge_codex_nonstream_response`), so the service method of the same name
 * owns that conversion rather than leaving it to each caller.
 */
export async function sendCodexRequestWithSingleRefresh(
  manager: CodexAuthManager,
  request: PreparedProviderRequest,
  options: CodexSendOptions = {},
  logger?: PluginLogger,
): Promise<Response> {
  const response = await sendCodexStreamRequestWithSingleRefresh(manager, request, options, logger);
  return bridgeCodexNonstreamResponse(response, logger);
}
