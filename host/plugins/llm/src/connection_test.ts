/** 设置页「测试连接」探测基础设施（commands.rs:2225–2920 / 3321–3730）。 */
import { AppError } from '../../../platform/errors/api.ts';
import { canonicalReason } from '../../../platform/util/portable.ts';
import { redactSensitiveText } from '../../../platform/log/redact.ts';
import type { ApiConfig, VendorConfig } from '../api.ts';
import type { ConnectionTestOutcome, TestApiConnectionCommandArgs } from '../../../../contracts/ipc/generated/L02-llm-manager.ts';
import {
  AUTH_MODE_NONE, AUTH_MODE_OPENAI_CODEX_OAUTH, effectiveApiProtocolForConfig,
} from './protocol.ts';
import { apiOriginsMatch, type LlmConfigStore } from './config_store.ts';
import { resolveQuirks } from './provider_quirks.ts';
import { applyGenerationParams } from './generation.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { looksLikeImageGenerationModelId } from './capabilities.ts';
import {
  vendorModelHeaders, vendorModelsEndpoint, type VendorModelsKind,
} from './vendor_models.ts';
import {
  AnthropicAdapter, OpenAIAdapter, OpenAIResponsesAdapter, buildGeminiRequest,
  type LlmCodexAuthService,
} from '../../llm-providers/api.ts';
import { logError, logInfo } from './logging.ts';

export type ProbeVerdict =
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'failure'; category: string; message: string };

export interface ProbeDeps {
  fetch: typeof fetch;
  now: () => number;
  getSecret: (key: string) => Promise<string | null>;
  store: LlmConfigStore;
  codex?: LlmCodexAuthService;
}

export type ConnectionTestRequest = TestApiConnectionCommandArgs;

const CATEGORY_AUTH = '认证失败：API 密钥无效、已过期或权限不足';

/** Rust `StatusCode` 的 Display：`401 Unauthorized`。 */
export function httpStatusDisplay(status: number): string {
  const reason = canonicalReason(status);
  return reason === null ? String(status) : `${status} ${reason}`;
}

export function truncateProviderErrorDetail(detail: string): string {
  return Array.from(detail).slice(0, 2048).join('');
}

export function classifyProbeHttpFailure(
  status: number, body: string,
): { category: string; message: string } {
  const detail = truncateProviderErrorDetail(redactSensitiveText(body));
  let category: string;
  let summary: string;
  if (status === 401 || status === 403) [category, summary] = ['auth', CATEGORY_AUTH];
  else if (status === 402) [category, summary] = ['billing', '账户余额不足或需要订阅'];
  else if (status === 404) [category, summary] = ['model_not_found', '未找到该模型（模型名错误或端点路径不正确）'];
  else if (status === 408 || status === 504) [category, summary] = ['timeout', '供应商网关超时'];
  else if (status === 429) [category, summary] = ['rate_limit', '触发供应商速率限制，请稍后重试'];
  else if (status === 400) [category, summary] = ['bad_request', '请求被拒绝（模型名或参数与该供应商不兼容）'];
  else if (status >= 500 && status <= 599) [category, summary] = ['server', '供应商服务异常，请稍后重试'];
  else [category, summary] = ['other', '请求失败'];
  const message = detail === ''
    ? `${summary}（HTTP ${httpStatusDisplay(status)}）`
    : `${summary}（HTTP ${httpStatusDisplay(status)}）：${detail}`;
  return { category, message };
}

const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'ETIMEDOUT', 'EPROTO', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** 近似 reqwest `Error::is_connect`：fetch 的网络/证书类失败（FetchError.cause）。 */
function isConnectFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)) return true;
  }
  return /fetch failed|connect|certificate|CERT_|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message);
}

export function classifyProbeTransportError(
  error: unknown,
): { category: string; message: string } {
  const sanitized = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { category: 'timeout', message: `请求超时：${sanitized}` };
  }
  if (isConnectFailure(error)) {
    return {
      category: 'network',
      message: `无法连接到供应商端点（检查地址/网络/证书）：${sanitized}`,
    };
  }
  return { category: 'network', message: `网络请求失败：${sanitized}` };
}

function errorDetail(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(value);
}

export function judgeSsePayload(payload: string): ProbeVerdict | null {
  const trimmed = payload.trim();
  if (trimmed === '') return null;
  if (trimmed === '[DONE]') return { kind: 'success' };
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { // boundary-allow empty-catch: Rust `.ok()?` 用解析结果判定，不记录日志
    return null;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const errorValue = (value as { error?: unknown }).error;
    if (errorValue !== undefined && errorValue !== null) {
      return {
        kind: 'failure', category: 'provider_error',
        message: `供应商返回错误：${truncateProviderErrorDetail(errorDetail(errorValue))}`,
      };
    }
  }
  return { kind: 'success' };
}

function jsonFailure(value: unknown): { kind: 'failure'; category: string; message: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const errorValue = (value as { error?: unknown }).error;
  if (errorValue === undefined || errorValue === null) return null;
  return {
    kind: 'failure', category: 'provider_error',
    message: `供应商返回错误：${truncateProviderErrorDetail(errorDetail(errorValue))}`,
  };
}

export function inspectProbeBuffer(buffer: Uint8Array, eof: boolean): ProbeVerdict {
  const text = new TextDecoder('utf-8').decode(buffer);
  const trimmed = text.trimStart();
  if (trimmed === '') {
    return eof
      ? { kind: 'failure', category: 'format', message: '供应商返回了空响应' }
      : { kind: 'pending' };
  }
  if (trimmed.startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { // boundary-allow empty-catch: Rust `match serde_json::from_str` 用解析结果分支，不记录日志
      return eof
        ? { kind: 'failure', category: 'format', message: '响应不是有效的 JSON/SSE（网关可能不支持该协议）' }
        : { kind: 'pending' };
    }
    return jsonFailure(value) ?? { kind: 'success' };
  }
  if (trimmed.startsWith('<')) {
    return {
      kind: 'failure', category: 'format',
      message: '端点返回了 HTML 页面（通常是网关/代理错误页或地址填错）',
    };
  }

  let rest = text;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end === -1) {
      if (eof) {
        for (const line of rest.split('\n')) {
          if (line.startsWith('data:')) {
            const verdict = judgeSsePayload(line.slice('data:'.length));
            if (verdict !== null) return verdict;
          }
        }
        return { kind: 'failure', category: 'format', message: '流式响应结束但未收到任何数据事件' };
      }
      return { kind: 'pending' };
    }
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let payload = '';
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      if (payload !== '') payload += '\n';
      payload += line.slice('data:'.length).replace(/^ +/, '');
    }
    const verdict = judgeSsePayload(payload);
    if (verdict !== null) return verdict;
  }
}

export function looksLikeAsrModelId(model: string): boolean {
  const lower = model.toLowerCase();
  for (const excluded of [
    'tts', 'text-to-speech', 'text_to_speech', 'speech-synthesis', 'speech_synthesis',
    'speech-generation', 'speech_generation',
  ]) {
    if (lower.includes(excluded)) return false;
  }
  const isSep = (character: string): boolean => ' \t/_.:-'.includes(character);
  const chars = Array.from(lower);
  const endsToken = (position: number): boolean => {
    const character = chars[position];
    if (character === undefined) return true;
    if (character === 'v') return /^\d$/.test(chars[position + 1] ?? '');
    return isSep(character) || /^\d$/.test(character);
  };
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    if (chars[index] === 'a' && chars[index + 1] === 's' && chars[index + 2] === 'r'
      && endsToken(index + 3)) return true;
  }
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    if (chars[index] === 's' && chars[index + 1] === 't' && chars[index + 2] === 't') {
      const prevOk = index === 0 || isSep(chars[index - 1]!);
      if (prevOk && endsToken(index + 3)) return true;
    }
  }
  for (const signal of [
    'transcrib', 'whisper', 'sensevoice', 'paraformer', 'speech-to-text',
    'speech_to_text', 'speech/to/text',
  ]) {
    if (lower.includes(signal)) return true;
  }
  for (let index = 0; index + 6 <= chars.length; index += 1) {
    if (chars.slice(index, index + 6).join('') !== 'scribe') continue;
    if (!(index === 0 || isSep(chars[index - 1]!))) continue;
    let cursor = index + 6;
    if (chars[cursor] === '-' || chars[cursor] === '_') {
      cursor += 1;
      if (chars[cursor] === 'v') cursor += 1;
      const digitsStart = cursor;
      while (/^\d$/.test(chars[cursor] ?? '')) cursor += 1;
      if (cursor === digitsStart) continue;
    }
    if (endsToken(cursor)) return true;
  }
  return false;
}

export type TestModelKind = 'chat' | 'embedding' | 'reranker' | 'image_generation' | 'asr';

export function resolveTestModelKind(config: ApiConfig): TestModelKind {
  if (config.isEmbedding) return 'embedding';
  if (config.isReranker) return 'reranker';
  if (config.isImageGeneration) return 'image_generation';
  const lower = config.model.toLowerCase();
  if (lower.includes('rerank')) return 'reranker';
  if (lower.includes('embedding') || lower.includes('bge-') || lower.includes('embed')) return 'embedding';
  if (looksLikeImageGenerationModelId(config.model)) return 'image_generation';
  if (looksLikeAsrModelId(config.model)) return 'asr';
  return 'chat';
}

/** 1 秒 16 kHz 单声道 WAV 探活音（确定性低幅音）。 */
export function buildAsrProbeWav(): Uint8Array {
  const sampleCount = 16_000;
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = ((index % 160) - 80) * 10;
    view.setInt16(44 + index * 2, sample, true);
  }
  return bytes;
}

export function buildChatProbeBody(config: ApiConfig): { [key: string]: unknown } {
  const probe: ApiConfig = { ...config, maxOutputTokens: 32 };
  const quirks = resolveQuirks(probe);
  const body: { [key: string]: unknown } = {
    model: probe.model,
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  };
  requestAdapterForConfig(probe).applyReasoningConfig(body, probe, false);
  applyGenerationParams(body, probe, quirks);
  return body;
}

async function withTimeout<T>(
  timeoutMs: number, timeoutMessage: string, operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error
      && controller.signal.reason.message === 'timeout') {
      const seconds = Math.ceil(timeoutMs / 1000);
      throw Object.assign(new Error(timeoutMessage.replace('{seconds}', String(seconds))), {
        probeCategory: 'timeout',
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function probeError(category: string, message: string): Error & { probeCategory: string } {
  return Object.assign(new Error(message), { probeCategory: category });
}

function isProbeError(error: unknown): error is Error & { probeCategory: string } {
  return error instanceof Error && typeof (error as { probeCategory?: unknown }).probeCategory === 'string';
}

export async function runChatProbe(
  deps: Pick<ProbeDeps, 'fetch'>, url: string,
  headers: readonly [string, string][], body: unknown, timeoutMs: number,
): Promise<void> {
  await withTimeout(timeoutMs, '等待供应商响应超过 {seconds} 秒', async (signal) => {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: 'POST',
        headers: Object.fromEntries(headers),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isProbeError(error)) throw error;
      const classified = classifyProbeTransportError(error);
      throw probeError(classified.category, classified.message);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const classified = classifyProbeHttpFailure(response.status, text);
      throw probeError(classified.category, classified.message);
    }
    if (response.body === null) {
      const text = await response.text();
      const verdict = inspectProbeBuffer(new TextEncoder().encode(text), true);
      if (verdict.kind === 'failure') throw probeError(verdict.category, verdict.message);
      if (verdict.kind === 'pending') {
        throw probeError('format', '流式响应结束但未收到有效事件');
      }
      return;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
      const buffer = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      const verdict = inspectProbeBuffer(buffer, false);
      if (verdict.kind === 'success') { await reader.cancel().catch(() => undefined); return; }
      if (verdict.kind === 'failure') { await reader.cancel().catch(() => undefined);
        throw probeError(verdict.category, verdict.message); }
      if (length > 64 * 1024) {
        await reader.cancel().catch(() => undefined);
        throw probeError('format', '响应过长且无可解析的数据事件');
      }
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    const verdict = inspectProbeBuffer(buffer, true);
    if (verdict.kind === 'success') return;
    if (verdict.kind === 'failure') throw probeError(verdict.category, verdict.message);
    throw probeError('format', '流式响应结束但未收到有效事件');
  });
}

export async function runJsonProbe(
  deps: Pick<ProbeDeps, 'fetch'>, url: string, apiKey: string,
  extraHeaders: Record<string, string> | null, body: unknown, timeoutMs: number,
): Promise<void> {
  await withTimeout(timeoutMs, '等待供应商响应超过 {seconds} 秒', async (signal) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', Accept: 'application/json',
    };
    if (apiKey.trim() !== '') headers.Authorization = `Bearer ${apiKey.trim()}`;
    if (extraHeaders !== null) Object.assign(headers, extraHeaders);
    let response: Response;
    try {
      response = await deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (isProbeError(error)) throw error;
      const classified = classifyProbeTransportError(error);
      throw probeError(classified.category, classified.message);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const classified = classifyProbeHttpFailure(response.status, text);
      throw probeError(classified.category, classified.message);
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { // boundary-allow empty-catch: Rust `let Ok(value) = serde_json::from_str else` 用解析结果分支，不记录日志
      throw probeError('format', `响应不是有效 JSON：${truncateProviderErrorDetail(text)}`);
    }
    const failure = jsonFailure(value);
    if (failure !== null) {
      throw probeError(failure.category, `供应商返回错误：${truncateProviderErrorDetail(text)}`);
    }
  });
}

export async function runAsrProbe(
  deps: Pick<ProbeDeps, 'fetch'>, config: ApiConfig, timeoutMs: number,
): Promise<string | null> {
  return withTimeout(timeoutMs, '等待供应商响应超过 {seconds} 秒', async (signal) => {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
    const form = new FormData();
    const wav = buildAsrProbeWav();
    // TS 5.7+ 的 BlobPart 只接受普通 ArrayBuffer 上的视图；这里不复制探测音频。
    form.append('file', new Blob([new Uint8Array(wav.buffer as ArrayBuffer, wav.byteOffset, wav.byteLength)], { type: 'audio/wav' }), 'probe.wav');
    form.append('model', config.model);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.apiKey.trim() !== '') headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    let response: Response;
    try {
      response = await deps.fetch(url, { method: 'POST', headers, body: form, signal });
    } catch (error) {
      if (isProbeError(error)) throw error;
      const classified = classifyProbeTransportError(error);
      throw probeError(classified.category, classified.message);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const classified = classifyProbeHttpFailure(response.status, text);
      throw probeError(classified.category, classified.message);
    }
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const errorValue = (value as { error?: unknown }).error;
        if (errorValue !== undefined && errorValue !== null) {
          throw probeError(
            'provider_error', `供应商返回错误：${truncateProviderErrorDetail(text)}`,
          );
        }
      }
    } catch (error) {
      if (isProbeError(error)) throw error;
      // 非 JSON 200 响应按成功处理（与 Rust `if let Ok(value)` 一致）。
    }
    return null;
  });
}

function modelIdsFromCatalog(value: unknown, kind: VendorModelsKind): Set<string> {
  const ids = new Set<string>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ids;
  if (kind === 'gemini') {
    const models = (value as { models?: unknown }).models;
    if (Array.isArray(models)) {
      for (const item of models) {
        if (typeof item !== 'object' || item === null) continue;
        const name = (item as { name?: unknown }).name;
        if (typeof name === 'string') ids.add(name.startsWith('models/') ? name.slice(7) : name);
      }
    }
  } else {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item !== 'object' || item === null) continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return ids;
}

export async function runCatalogProbe(
  deps: Pick<ProbeDeps, 'fetch'>, config: ApiConfig, timeoutMs: number,
): Promise<string | null> {
  const vendorShim: VendorConfig = {
    id: 'connection-test', name: 'connection test',
    providerType: config.providerType ?? '', authMode: config.authMode,
    apiProtocol: config.apiProtocol, supportsOpenaiResponses: config.supportsOpenaiResponses,
    baseUrl: config.baseUrl, apiKey: config.apiKey, headers: config.headers ?? {},
    apiKeys: [], notes: '', websiteUrl: '', isBuiltin: false, isReadOnly: false,
    rateLimitPerMinute: null, defaultTimeoutMs: null, maxTokensLimit: null, sortOrder: null,
  };
  const endpoint = vendorModelsEndpoint(
    config.baseUrl, vendorShim.providerType, config.apiProtocol,
  );
  const kind = endpoint.kind;
  const headers = vendorModelHeaders(vendorShim, kind);
  return withTimeout(timeoutMs, '获取模型清单超过 {seconds} 秒', async (signal) => {
    let response: Response;
    try {
      response = await deps.fetch(endpoint.url.href, {
        method: 'GET', headers: Object.fromEntries(headers), signal,
      });
    } catch (error) {
      if (isProbeError(error)) throw error;
      const classified = classifyProbeTransportError(error);
      throw probeError(classified.category, classified.message);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const classified = classifyProbeHttpFailure(response.status, text);
      throw probeError(classified.category, classified.message);
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { // boundary-allow empty-catch: Rust `let Ok(value) = serde_json::from_str else` 用解析结果分支，不记录日志
      throw probeError('format', '模型清单响应不是有效 JSON（端点可能不支持 /models）');
    }
    const ids = modelIdsFromCatalog(value, kind);
    if (ids.size === 0) {
      return '端点可达，但模型清单为空或该端点不实现 /models，模型将在实际使用时验证';
    }
    const lower = config.model.toLowerCase();
    if ([...ids].some((id) => id.toLowerCase() === lower)) return null;
    return `端点可达且密钥有效，但模型清单中未找到「${config.model}」（可能是隐藏/未列出模型）`;
  });
}

function isOpenaiCodexOauthTest(
  persistedVendor: VendorConfig | null, providerType: string | null | undefined,
  authMode: string | null | undefined,
): boolean {
  const effectiveProvider = persistedVendor?.providerType ?? providerType ?? '';
  const effectiveAuth = persistedVendor?.authMode ?? authMode ?? '';
  return effectiveProvider.toLowerCase() === 'openai_codex'
    && effectiveAuth.toLowerCase() === AUTH_MODE_OPENAI_CODEX_OAUTH;
}

function isPlaceholderKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed === '' || trimmed === '***' || Array.from(trimmed).every((character) => character === '*');
}

async function resolveEffectiveApiKey(
  request: ConnectionTestRequest, persistedVendor: VendorConfig | null,
  isCodexOauth: boolean, usesNoAuth: boolean, getSecret: ProbeDeps['getSecret'],
): Promise<string> {
  const trimmed = request.apiKey.trim();
  if (isCodexOauth || usesNoAuth) return '';
  if (!isPlaceholderKey(trimmed)) return trimmed;

  if (persistedVendor !== null) {
    const candidates = [persistedVendor.apiKey, ...persistedVendor.apiKeys];
    const found = candidates.map((value) => value.trim()).find((value) => !isPlaceholderKey(value));
    if (found !== undefined) return found;
  }
  const vendorId = request.vendorId ?? null;
  if (vendorId === null) throw AppError.validation('请先输入 API 密钥');
  const secretKey = `${vendorId}.api_key`;
  const key = await getSecret(secretKey);
  if (key !== null && key !== '') return key;
  if (vendorId.includes('siliconflow')) {
    const legacy = await getSecret('siliconflow.api_key');
    if (legacy !== null && legacy !== '') return legacy;
  }
  throw AppError.validation('API 密钥未配置，请先配置 API 密钥');
}

function applyConfigOverrides(config: ApiConfig, request: ConnectionTestRequest): void {
  if (request.providerScope !== undefined && request.providerScope !== null) config.providerScope = request.providerScope;
  if (request.apiProtocol !== undefined && request.apiProtocol !== null) config.apiProtocol = request.apiProtocol;
  if (request.supportsOpenaiResponses !== undefined && request.supportsOpenaiResponses !== null) {
    config.supportsOpenaiResponses = request.supportsOpenaiResponses;
  }
  if (request.modelAdapter !== undefined && request.modelAdapter !== null) config.modelAdapter = request.modelAdapter;
  if (request.isEmbedding !== undefined && request.isEmbedding !== null) config.isEmbedding = request.isEmbedding;
  if (request.isReranker !== undefined && request.isReranker !== null) config.isReranker = request.isReranker;
  if (request.isImageGeneration !== undefined && request.isImageGeneration !== null) config.isImageGeneration = request.isImageGeneration;
  if (request.isReasoning !== undefined && request.isReasoning !== null) config.isReasoning = request.isReasoning;
  if (request.supportsReasoning !== undefined && request.supportsReasoning !== null) config.supportsReasoning = request.supportsReasoning;
  if (request.enableThinking !== undefined) config.enableThinking = request.enableThinking;
  if (request.thinkingBudget !== undefined && request.thinkingBudget !== null) config.thinkingBudget = request.thinkingBudget;
  if (request.includeThoughts !== undefined && request.includeThoughts !== null) config.includeThoughts = request.includeThoughts;
  if (request.reasoningEffort !== undefined) config.reasoningEffort = request.reasoningEffort;
  if (request.reasoningMode !== undefined) config.reasoningMode = request.reasoningMode;
  if (request.maxOutputTokens !== undefined && request.maxOutputTokens !== null) config.maxOutputTokens = request.maxOutputTokens;
  if (request.maxTokensLimit !== undefined && request.maxTokensLimit !== null) config.maxTokensLimit = request.maxTokensLimit;
  if (request.geminiApiVersion !== undefined && request.geminiApiVersion !== null) config.geminiApiVersion = request.geminiApiVersion;
}

function clampTimeout(value: number | null, fallback: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value ?? fallback));
}

export async function testApiConnection(
  request: ConnectionTestRequest, deps: ProbeDeps,
): Promise<ConnectionTestOutcome> {
  const started = deps.now();
  const latency = (): number => Math.max(0, deps.now() - started);

  const persistedVendor = request.vendorId !== undefined && request.vendorId !== null
    ? await deps.store.vendorConfigForRuntime(request.vendorId) : null;
  const effectiveProviderType = persistedVendor?.providerType ?? request.providerType ?? null;
  const effectiveAuthMode = persistedVendor?.authMode ?? request.authMode ?? null;
  const isCodexOauth = isOpenaiCodexOauthTest(
    persistedVendor, request.providerType, request.authMode,
  );
  const usesNoAuth = (effectiveAuthMode ?? '').toLowerCase() === AUTH_MODE_NONE;

  if (persistedVendor !== null && !apiOriginsMatch(persistedVendor.baseUrl, request.apiBase)) {
    throw AppError.validation('连接测试地址与已保存供应商不同源；请先保存新地址并重新输入凭据');
  }

  const effectiveApiKey = await resolveEffectiveApiKey(
    request, persistedVendor, isCodexOauth, usesNoAuth, deps.getSecret,
  );
  const modelId = request.model ?? 'gpt-4o-mini';
  const savedRuntime = request.vendorId !== undefined && request.vendorId !== null
    ? await deps.store.runtimeConfigForVendorModel(request.vendorId, modelId) : null;
  const config: ApiConfig = savedRuntime ?? {
    resolvedAdapterId: null, id: 'connection-test', name: 'API connection test',
    vendorId: null, vendorName: null, providerType: null, providerScope: null,
    authMode: null, apiProtocol: null, supportsOpenaiResponses: null, apiKey: '',
    baseUrl: '', model: '', isMultimodal: false, isReasoning: false, isEmbedding: false,
    isReranker: false, isImageGeneration: false, enabled: false, modelAdapter: 'general',
    maxOutputTokens: 8192, temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1',
    isBuiltin: false, isReadOnly: false, reasoningEffort: null, reasoningMode: null,
    thinkingEnabled: false, thinkingBudget: null, includeThoughts: false, minP: null,
    topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null,
  };
  config.vendorId = request.vendorId ?? null;
  config.providerType = effectiveProviderType ?? config.providerType;
  config.authMode = effectiveAuthMode ?? config.authMode;
  config.apiKey = effectiveApiKey;
  config.baseUrl = request.apiBase;
  config.model = modelId;
  applyConfigOverrides(config, request);
  const configuredHeaders = persistedVendor !== null
    && Object.keys(persistedVendor.headers).length > 0 ? persistedVendor.headers : null;
  if (configuredHeaders !== null || (request.headers !== undefined && request.headers !== null)) {
    config.headers = configuredHeaders ?? request.headers ?? null;
  }

  if (isCodexOauth) {
    if (deps.codex === undefined) throw AppError.configuration('OpenAI Codex 请求缺少 OAuth 上下文');
    config.apiProtocol = 'openai_responses'; config.supportsOpenaiResponses = true; config.apiKey = '';
    if (config.modelAdapter === '' || config.modelAdapter === 'general') config.modelAdapter = 'openai';
    const prepared = await deps.codex.prepareRequest(new OpenAIResponsesAdapter(),
      { ...config, effectiveApiProtocol: effectiveApiProtocolForConfig(config) }, buildChatProbeBody(config) as import('../../llm-providers/api.ts').JsonValue,
      { buildErrorContext: 'Codex 连接测试请求构建失败' });
    const response = await deps.codex.sendWithSingleRefresh(prepared, { timeoutMs: 60_000, fetch: deps.fetch });
    if (response.ok) { logInfo('[API测试] Codex OAuth 连接成功'); return { ok: true, latencyMs: latency() }; }
    const errorText = await response.text().catch(() => '');
    logError(`[API测试] Codex OAuth 连接失败: ${httpStatusDisplay(response.status)} - ${errorText}`);
    const failure = classifyProbeHttpFailure(response.status, errorText);
    return { ok: false, latencyMs: latency(), category: failure.category, message: `Codex 连接测试失败 - ${failure.message}` };
  }

  if (effectiveProviderType?.toLowerCase() === 'opencode_go'
    || config.providerType?.toLowerCase() === 'opencode_go') {
    const { OpenCodeGoUsageError, fetchUsage } = await import('./opencode_go.ts');
    try {
      await fetchUsage(config.apiKey, '0.0.0', deps.fetch);
      return { ok: true, latencyMs: latency() };
    } catch (error) {
      if (error instanceof OpenCodeGoUsageError) {
        return { ok: false, latencyMs: latency(), category: error.category, message: error.message };
      }
      return { ok: false, latencyMs: latency(), category: 'network', message: String(error) };
    }
  }

  const vendorTimeout = persistedVendor?.defaultTimeoutMs ?? null;
  const kind = resolveTestModelKind(config);
  try {
    let warning: string | null = null;
    if (kind === 'chat') {
      const timeout = clampTimeout(vendorTimeout, 45_000, 5_000, 120_000);
      const body = buildChatProbeBody(config);
      const requestBuilt = buildProbeRequest(config, body);
      await runChatProbe(deps, requestBuilt.url, requestBuilt.headers, requestBuilt.body, timeout);
    } else if (kind === 'embedding') {
      const timeout = clampTimeout(vendorTimeout, 30_000, 5_000, 120_000);
      await runJsonProbe(
        deps, `${config.baseUrl.replace(/\/+$/, '')}/embeddings`, config.apiKey, null,
        { model: config.model, input: ['连接测试'], encoding_format: 'float' }, timeout,
      );
    } else if (kind === 'reranker') {
      const timeout = clampTimeout(vendorTimeout, 30_000, 5_000, 120_000);
      await runJsonProbe(
        deps, `${config.baseUrl.replace(/\/+$/, '')}/rerank`, config.apiKey, null,
        {
          model: config.model, query: '连接测试', documents: ['测试文档1', '测试文档2'],
          top_k: 2, return_documents: true,
        }, timeout,
      );
    } else if (kind === 'image_generation') {
      const timeout = clampTimeout(vendorTimeout, 10_000, 5_000, 60_000);
      warning = await runCatalogProbe(deps, config, timeout);
    } else {
      const timeout = clampTimeout(vendorTimeout, 30_000, 5_000, 120_000);
      warning = await runAsrProbe(deps, config, timeout);
    }
    return warning === null
      ? { ok: true, latencyMs: latency() }
      : { ok: true, latencyMs: latency(), warning };
  } catch (error) {
    if (isProbeError(error)) {
      return { ok: false, latencyMs: latency(), category: error.probeCategory, message: error.message };
    }
    throw error;
  }
}

interface BuiltProbeRequest {
  url: string;
  headers: [string, string][];
  body: unknown;
}

/** Request shaping equivalent to `prepare_provider_request` for probe purposes. */
export function buildProbeRequest(
  config: ApiConfig, body: { [key: string]: unknown },
): BuiltProbeRequest {
  const protocol = effectiveApiProtocolForConfig(config);
  if (protocol === 'anthropic_messages') {
    return new AnthropicAdapter().buildRequest(
      config.baseUrl, config.apiKey, config.model, body as never,
    ) as BuiltProbeRequest;
  }
  if (protocol === 'google_generate_content') {
    return buildGeminiRequest(
      config.baseUrl, config.apiKey, config.model, body as never,
    ) as BuiltProbeRequest;
  }
  if (protocol === 'openai_responses') {
    return new OpenAIResponsesAdapter().buildRequest(
      config.baseUrl, config.apiKey, config.model, body as never,
    ) as BuiltProbeRequest;
  }
  return new OpenAIAdapter().buildRequest(
    config.baseUrl, config.apiKey, config.model, body as never,
  ) as BuiltProbeRequest;
}
