/**
 * `dstu-media/src/voice_input.rs`: the managed-ASR HTTP client shared by voice
 * input and media transcription (`transcribe_with_endpoint`,
 * `build_transcriptions_form`, `post_asr_chat_input_audio`,
 * `map_transcribe_http_error`).
 *
 * Endpoint resolution (LLM assignments / API-config table / secure store) needs
 * L02 and F4 and stays unmigrated; callers pass a resolved {@link AsrEndpoint}.
 */
import { AppError, errorDisplay, type AppErrorType } from '../../../platform/errors/api.ts';
import type { LLMManager } from '../../llm/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  CallerType, UsageRecordBuilder, insertUsage,
} from '../../../platform/storage/llm-usage.ts';
import {
  AsrConfigError, AsrEndpoint, DEFAULT_PROVIDER_ID, cleanAsrText, chatAsrLanguage,
  parseChatTranscript,
} from './asr.ts';
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';
import { rustTrim } from './transcript.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';

export interface VoiceInputTranscribeRequest {
  audioBase64: string;
  mimeType: string;
  providerId?: string | null;
  model?: string | null;
  configId?: string | null;
  language?: string | null;
  prompt?: string | null;
  durationMs?: number | null;
}

export interface VoiceInputTranscribeResponse {
  text: string;
  language: string | null;
  durationMs: number | null;
  providerId: string;
  model: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
}

/** Rust `if let Ok(...)` / `.ok()`：读取失败按“没有值”处理。 */
async function bestEffort<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); }
  catch { return null; }
}

/** `resolve_asr_api_key` 的 F4 分支：两个键按顺序读取，错误视为缺失。 */
export interface AsrSecretSource {
  getSecret(key: string): Promise<string | null>;
}

export async function resolveSiliconflowKey(source: AsrSecretSource): Promise<string | null> {
  for (const key of ['builtin-siliconflow.api_key', 'siliconflow.api_key']) {
    const value = await bestEffort(() => source.getSecret(key));
    if (value !== null && rustTrim(value) !== '') return value;
  }
  return null;
}

/** `AsrConfigError::into_app_error`：settings-required 为 Configuration，其余 Validation。 */
export function configErrorToVoiceInput(error: AsrConfigError): VoiceInputError {
  return voiceInputError(error.code === 'settings-required' ? 'Configuration' : 'Validation',
    error.code, error.message);
}

/** `resolve_asr_endpoint`：已分配且启用的模型优先，否则回退 SiliconFlow 默认端点。 */
export async function resolveAsrEndpoint(
  llm: Pick<LLMManager, 'getModelAssignments' | 'getApiConfigs'> | null,
  key: string | null,
): Promise<AsrEndpoint> {
  const resolveKey = () => key;
  if (llm !== null) {
    const assignments = await bestEffort(() => llm.getModelAssignments());
    const assigned = assignments?.voice_input_asr_model_config_id ?? null;
    if (assigned !== null && rustTrim(assigned) !== '') {
      const configs = await bestEffort(() => llm.getApiConfigs());
      const cfg = configs?.find(item => item.id === assigned
        && item.enabled && rustTrim(item.model) !== '');
      if (cfg !== undefined) return AsrEndpoint.fromApiConfig(cfg, resolveKey);
    }
  }
  return AsrEndpoint.siliconflowDefault(resolveKey, null);
}

/**
 * `resolve_request_endpoint`：configId 精确取配置；只给 SiliconFlow 模型名
 * 走默认端点；两者都没给则跟随 ASR 槽位。
 */
export async function resolveRequestEndpoint(
  request: VoiceInputTranscribeRequest,
  llm: Pick<LLMManager, 'getModelAssignments' | 'getApiConfigs'> | null,
  key: string | null,
): Promise<AsrEndpoint> {
  const requestedProvider = nonEmpty(request.providerId);
  const requestedModel = nonEmpty(request.model);
  const configId = nonEmpty(request.configId);
  const resolveKey = () => key;

  if (configId !== null) {
    const provider = requestedProvider ?? DEFAULT_PROVIDER_ID;
    const model = requestedModel ?? '';
    if (llm === null) {
      throw new AsrConfigError('model-config-missing',
        '读取模型配置失败: 模型服务不可用', provider, model);
    }
    let configs;
    try { configs = await llm.getApiConfigs(); }
    catch (error) {
      throw new AsrConfigError('model-config-missing',
        `读取模型配置失败: ${errorDisplay(error)}`, provider, model);
    }
    const cfg = configs.find(item => item.id === configId);
    if (cfg === undefined) {
      throw new AsrConfigError('model-config-missing',
        `语音识别模型配置不存在: ${configId}`, provider, model);
    }
    if (!cfg.enabled) {
      throw new AsrConfigError('model-disabled',
        `语音识别模型 ${cfg.model} 已停用`, provider, cfg.model);
    }
    return AsrEndpoint.fromApiConfig(cfg, resolveKey);
  }

  if (requestedProvider === null && requestedModel === null) {
    return resolveAsrEndpoint(llm, key);
  }

  const provider = requestedProvider ?? DEFAULT_PROVIDER_ID;
  if (provider.toLowerCase() !== DEFAULT_PROVIDER_ID) {
    throw new AsrConfigError('provider-unavailable',
      `Voice input provider ${provider} needs a model configuration (configId)`,
      provider, requestedModel ?? '');
  }
  return AsrEndpoint.siliconflowDefault(resolveKey, requestedModel);
}

/** One managed ASR call, mirroring `record_voice_input_usage` inputs. */
export interface VoiceInputUsage {
  providerId: string;
  model: string;
  configId: string | null;
  latencyMs: number;
  success: boolean;
  errorMessage: string | null;
}

export type VoiceInputUsageRecorder = (usage: VoiceInputUsage) => void;

/**
 * `record_asr_usage(caller, ...)`: ASR endpoints do not report token usage, so
 * 0/0 is a local placeholder and the token source must stay `heuristic`
 * (otherwise the schema default `api` would fake a measurement).
 */
export function recordAsrUsage(
  conn: SqlExecutor,
  caller: typeof CallerType.VoiceInput | typeof CallerType.MediaTranscription,
  usage: VoiceInputUsage,
): void {
  const builder = new UsageRecordBuilder(caller, usage.model, 0, 0)
    .withProviderId(usage.providerId)
    .withTokenSource('heuristic')
    .withDuration(Math.max(0, Math.floor(usage.latencyMs)));

  const configId = usage.configId === null ? '' : usage.configId.trim();
  if (configId !== '') builder.withConfigId(configId);
  if (!usage.success) builder.withError(usage.errorMessage ?? 'Unknown error');

  insertUsage(conn, builder.build());
}

/** `record_voice_input_usage`. */
export function recordVoiceInputUsage(conn: SqlExecutor, usage: VoiceInputUsage): void {
  recordAsrUsage(conn, CallerType.VoiceInput, usage);
}

/** `voice_input_transcribe_with_services`：解析端点 → HTTP 转写 → 记录用量/映射错误。 */
export async function transcribeVoiceInput(
  request: VoiceInputTranscribeRequest,
  llm: Pick<LLMManager, 'getModelAssignments' | 'getApiConfigs'> | null,
  key: string | null,
  fetcher: AsrFetch,
  recordUsage: VoiceInputUsageRecorder | null = null,
): Promise<VoiceInputTranscribeResponse> {
  const started = performance.now();
  const elapsed = (): number => Math.max(0, Math.floor(performance.now() - started));

  let endpoint: AsrEndpoint;
  try {
    endpoint = await resolveRequestEndpoint(request, llm, key);
  } catch (error) {
    if (error instanceof AsrConfigError) {
      recordUsage?.({
        providerId: error.providerId,
        model: error.model,
        configId: request.configId ?? null,
        latencyMs: elapsed(),
        success: false,
        errorMessage: error.message,
      });
      throw configErrorToVoiceInput(error);
    }
    throw error;
  }

  try {
    const result = await transcribeWithEndpoint(endpoint, request, fetcher);
    recordUsage?.({
      providerId: endpoint.providerId,
      model: endpoint.model,
      configId: endpoint.configId,
      latencyMs: elapsed(),
      success: true,
      errorMessage: null,
    });
    return result;
  } catch (error) {
    recordUsage?.({
      providerId: endpoint.providerId,
      model: endpoint.model,
      configId: endpoint.configId,
      latencyMs: elapsed(),
      success: false,
      errorMessage: error instanceof VoiceInputError
        ? error.appError.message
        : error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Rust `AppError::new(type, json!({"code","message"}).to_string())`：`message` 就是
 * 结构化 payload 字符串，`appError` 保留完整 IPC 形状供命令层包装。
 */
export class VoiceInputError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'VoiceInputError';
    this.appError = appError;
  }
  get errorType(): AppErrorType { return this.appError.error_type; }
}

function voiceInputError(
  errorType: AppErrorType,
  code: string,
  message: string,
): VoiceInputError {
  return new VoiceInputError(AppError.new(errorType, JSON.stringify({ code, message })));
}

export function resolveAudioExtension(mimeType: string): string {
  switch (rustTrim(mimeType).toLowerCase()) {
    case 'audio/webm':
    case 'audio/webm;codecs=opus':
      return 'webm';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/ogg':
    case 'audio/ogg;codecs=opus':
    case 'audio/ogg; codecs=opus':
      return 'ogg';
    case 'audio/flac':
      return 'flac';
    default:
      return 'webm';
  }
}

function decodeAudioPayload(audioBase64: string): Uint8Array {
  try { return decodeBase64Standard(audioBase64); }
  catch (error) {
    const detail = error instanceof Base64DecodeError ? error.message : String(error);
    throw voiceInputError('Validation', 'invalid-audio', `Invalid audio payload: ${detail}`);
  }
}

export interface AsrHttpRequest {
  url: string;
  headers: Array<[string, string]>;
  body: BodyInit;
}

/** 构建 `/audio/transcriptions` multipart 请求（字段顺序与 Rust 一致）。 */
export function buildTranscriptionsRequest(
  endpoint: AsrEndpoint,
  request: VoiceInputTranscribeRequest,
  audioBytes: Uint8Array,
): AsrHttpRequest {
  const extension = resolveAudioExtension(request.mimeType);
  const form = new FormData();
  const deepseek = endpoint.protocol === 'deepseek_asr';
  if (!deepseek) form.append('model', endpoint.model);
  const mime = rustTrim(request.mimeType) === '' ? 'application/octet-stream'
    : rustTrim(request.mimeType);
  // TS 5.7+ 的 BlobPart 只接受普通 ArrayBuffer 上的视图；这里给出同一份缓冲区的视图，不复制音频。
  const bytes = new Uint8Array(audioBytes.buffer as ArrayBuffer, audioBytes.byteOffset, audioBytes.byteLength);
  form.append('file', new Blob([bytes], { type: mime }), `voice-input.${extension}`);
  const language = nonEmpty(request.language);
  if (!deepseek && language !== null) form.append('language', language);
  const prompt = nonEmpty(request.prompt);
  if (!deepseek && prompt !== null) form.append('prompt', prompt);
  return {
    url: endpoint.transcriptionUrl(),
    headers: [['authorization', `Bearer ${endpoint.apiKey}`], ...endpoint.headers],
    body: form,
  };
}

/** `chat/completions` 的 `input_audio` 请求体（百炼 qwen3-asr-flash）。 */
export function buildChatInputAudioBody(
  endpoint: AsrEndpoint,
  audio: Uint8Array,
  mimeType: string,
  language: string | null | undefined,
): Record<string, unknown> {
  const baseMime = mimeType.split(';')[0]?.trim() ?? '';
  const mime = baseMime === '' ? 'audio/wav' : baseMime;
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: [{
      role: 'user',
      content: [{
        type: 'input_audio',
        input_audio: { data: `data:${mime};base64,${toBase64(audio)}` },
      }],
    }],
    stream: false,
  };
  const primary = chatAsrLanguage(language);
  if (primary !== null) body.asr_options = { language: primary };
  return body;
}

/** 构建 `/chat/completions` + `input_audio` 请求（百炼 qwen3-asr-flash）。 */
export function buildChatInputAudioRequest(
  endpoint: AsrEndpoint,
  request: VoiceInputTranscribeRequest,
  audioBytes: Uint8Array,
): AsrHttpRequest {
  return {
    url: endpoint.url('chat/completions'),
    headers: [
      ['authorization', `Bearer ${endpoint.apiKey}`],
      ['content-type', 'application/json'],
      ...endpoint.headers,
    ],
    body: JSON.stringify(buildChatInputAudioBody(
      endpoint, audioBytes, request.mimeType, request.language)),
  };
}

/** `parse_retry_after`：秒数（上限 600）或 RFC 2822 日期，返回秒数。 */
export function parseRetryAfterSeconds(value: string): number | null {
  const trimmed = rustTrim(value);
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.min(seconds, 600);
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  const deltaMs = when - Date.now();
  return Math.min(Math.max(deltaMs, 0), 600_000) / 1000;
}

export type AsrHttpOutcome =
  | { ok: true; body: string }
  | { ok: false; timeout: boolean; message: string }
  | { ok: false; status: number; body: string; retryAfterSeconds: number | null };

/** 宿主 HTTP 客户端（生产为 `llmHttp`：reqwest 等价的代理/重定向语义，且 LLM 回放可拦截）。 */
export type AsrFetch = typeof fetch;

export async function sendAsrRequest(
  fetcher: AsrFetch,
  request: AsrHttpRequest,
  timeoutMs = 90_000,
): Promise<AsrHttpOutcome> {
  let response: Response;
  try {
    response = await fetcher(request.url, {
      method: 'POST',
      headers: Object.fromEntries(request.headers),
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    return {
      ok: false,
      timeout: name === 'AbortError' || name === 'TimeoutError',
      message: `ASR request failed: ${(error as Error).message}`,
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const retryAfter = response.headers.get('retry-after');
    return {
      ok: false,
      status: response.status,
      body: body.slice(0, 500),
      retryAfterSeconds: retryAfter === null ? null : parseRetryAfterSeconds(retryAfter),
    };
  }
  try {
    return { ok: true, body: await response.text() };
  } catch (error) {
    return {
      ok: false,
      timeout: (error as Error).name === 'AbortError',
      message: `ASR response read failed: ${(error as Error).message}`,
    };
  }
}

function mapTranscribeHttpError(endpoint: AsrEndpoint, outcome: AsrHttpOutcome): VoiceInputError {
  if (outcome.ok) throw new Error('mapTranscribeHttpError called with a success');
  if ('status' in outcome) {
    const code = outcome.status === 401 || outcome.status === 403 ? 'auth-failed'
      : outcome.status === 429 ? 'rate-limited' : 'transcription-failed';
    const message = code === 'auth-failed'
      ? `Voice input authentication failed. Check the ${endpoint.providerName} API key.`
      : code === 'rate-limited'
        ? `Voice input is being rate limited by ${endpoint.providerName}.`
        : 'Voice input transcription failed.';
    return voiceInputError('LLM', code,
      `${message} HTTP ${outcome.status} ${outcome.body}`);
  }
  return voiceInputError('Network', outcome.timeout ? 'timeout' : 'network-failed',
    `Voice input request failed: ${outcome.message}`);
}

function invalidTranscriptionResponse(endpoint: AsrEndpoint, detail: string): VoiceInputError {
  return voiceInputError('Validation', 'transcription-failed',
    `Invalid ${endpoint.providerName} transcription response: ${detail}`);
}

interface TranscriptionResponse {
  text: string | null;
  language: string | null;
}

function parseTranscriptionResponse(body: string): TranscriptionResponse {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (error) { throw new Error(`Invalid ASR response: ${(error as Error).message}`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid ASR response: expected an object');
  }
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : null;
  const language = typeof record.language === 'string' ? record.language : null;
  return { text, language };
}

/**
 * `transcribe_with_endpoint`：按 endpoint 协议发起请求并映射错误。
 * 配置解析失败不在这里处理（需要 L02 的 ApiConfig/密钥存储）。
 */
export async function transcribeWithEndpoint(
  endpoint: AsrEndpoint,
  request: VoiceInputTranscribeRequest,
  fetcher: AsrFetch,
): Promise<VoiceInputTranscribeResponse> {
  const audioBytes = decodeAudioPayload(request.audioBase64);
  if (endpoint.protocol === 'deepseek_asr') {
    if (audioBytes.byteLength > 8 * 1024 * 1024 || (request.durationMs ?? 0) > 120_000) {
      throw voiceInputError('Validation', 'invalid-audio', 'DeepSeek accepts audio up to 120 seconds and 8 MiB.');
    }
    if (!['wav', 'ogg'].includes(resolveAudioExtension(request.mimeType))) {
      throw voiceInputError('Validation', 'invalid-audio', 'DeepSeek requires 16-bit PCM WAV or Ogg Opus.');
    }
  }

  let text: string;
  let language: string | null;
  if (endpoint.protocol !== 'chat_input_audio') {
    const outcome = await sendAsrRequest(fetcher, buildTranscriptionsRequest(endpoint, request, audioBytes));
    if (!outcome.ok) throw mapTranscribeHttpError(endpoint, outcome);
    let payload: TranscriptionResponse;
    try { payload = parseTranscriptionResponse(outcome.body); }
    catch (error) { throw invalidTranscriptionResponse(endpoint, (error as Error).message); }
    text = cleanAsrText(payload.text ?? '');
    language = payload.language;
  } else {
    const outcome = await sendAsrRequest(fetcher, buildChatInputAudioRequest(endpoint, request, audioBytes));
    if (!outcome.ok) throw mapTranscribeHttpError(endpoint, outcome);
    try {
      const parsed = parseChatTranscript(outcome.body);
      text = parsed[0];
      language = parsed[1];
    } catch (error) {
      throw invalidTranscriptionResponse(endpoint, (error as Error).message);
    }
  }

  if (text === '') {
    throw voiceInputError('Validation', 'empty-transcript',
      `${endpoint.providerName} returned an empty transcript.`);
  }

  return {
    text,
    language,
    durationMs: request.durationMs ?? null,
    providerId: endpoint.providerId,
    model: endpoint.model,
  };
}
