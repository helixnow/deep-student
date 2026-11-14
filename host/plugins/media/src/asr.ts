/**
 * `dstu-media/src/voice_input.rs` + `src/media/asr.rs`: ASR model detection,
 * endpoint shaping, transcript cleaning, verbose-json bounds and the AIMD
 * concurrency controller. The HTTP transport and managed-config resolution
 * need L02 services and stay unmigrated.
 */
import type { ApiConfig } from '../../llm/api.ts';
import { rustTrim } from './transcript.ts';

export type AsrProtocol = 'transcriptions' | 'chat_input_audio' | 'deepseek_asr';

function isDeepseekAsr(baseUrl: string, model: string): boolean {
  if (model !== 'deepseek-asr') return false;
  try { return new URL(baseUrl).origin === 'https://api.deepseek.com'; }
  catch { return false; }
}

export const DEFAULT_PROVIDER_ID = 'siliconflow';
export const DEFAULT_SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';
/** 未分配 ASR 模型时的默认转写模型（硅基流动托管的开源 Qwen3-ASR） */
export const DEFAULT_SILICONFLOW_MODEL = 'Qwen/Qwen3-ASR-1.7B';
/** 硅基流动已下架、由默认模型接替的 ASR 模型 */
const RETIRED_SILICONFLOW_ASR_MODELS = ['TeleAI/TeleSpeechASR'];

const ASR_NAME_SEPARATORS = /[\p{White_Space}/_.:-]/u;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
}

/** 剥离「网关 slug_」前缀（与前端 `modelIdPrefix.ts::stripGatewayPrefix` 同一规则） */
export function stripGatewayPrefix(modelId: string): string {
  const trimmed = rustTrim(modelId);
  const slash = trimmed.lastIndexOf('/');
  const segment = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const idx = segment.indexOf('_');
  if (idx < 0 || idx === 0) return segment;
  const prefix = segment.slice(0, idx);
  const rest = segment.slice(idx + 1);
  if (!prefix.includes('-') || !(rest.includes('-') || rest.includes('.')) || !/[A-Za-z]/.test(rest)) {
    return segment;
  }
  return rest;
}

function tokenTailOk(rest: string): boolean {
  if (rest === '') return true;
  const first = String.fromCodePoint(rest.codePointAt(0)!);
  if (ASR_NAME_SEPARATORS.test(first) || /[0-9]/.test(first)) return true;
  if (first === 'v') {
    const next = rest.slice(first.length);
    return next !== '' && /[0-9]/.test(String.fromCodePoint(next.codePointAt(0)!));
  }
  return false;
}

function leadingSep(lower: string, index: number): boolean {
  const before = lower.slice(0, index);
  if (before === '') return true;
  const last = [...before].at(-1)!;
  return ASR_NAME_SEPARATORS.test(last);
}

export function isAsrModelName(name: string): boolean {
  const lower = asciiLower(rustTrim(name));
  if (lower === '') return false;
  const normalized = lower.replace(/[_/]/g, '-');
  if (lower.includes('tts')
    || normalized.includes('text-to-speech')
    || normalized.includes('speech-synthesis')
    || normalized.includes('speech-generation')) {
    return false;
  }
  let asr = false;
  for (let i = lower.indexOf('asr'); i >= 0; i = lower.indexOf('asr', i + 3)) {
    if (tokenTailOk(lower.slice(i + 3))) { asr = true; break; }
  }
  let stt = false;
  for (let i = lower.indexOf('stt'); i >= 0; i = lower.indexOf('stt', i + 3)) {
    if (leadingSep(lower, i) && tokenTailOk(lower.slice(i + 3))) { stt = true; break; }
  }
  let scribe = false;
  for (let i = lower.indexOf('scribe'); i >= 0; i = lower.indexOf('scribe', i + 6)) {
    if (!leadingSep(lower, i)) continue;
    const rest = lower.slice(i + 6);
    if (rest === '' || ASR_NAME_SEPARATORS.test(String.fromCodePoint(rest.codePointAt(0)!))) {
      scribe = true;
      break;
    }
  }
  return asr || stt || scribe
    || ['transcrib', 'whisper', 'sensevoice', 'paraformer'].some(needle => lower.includes(needle))
    || normalized.includes('speech-to-text');
}

/** 模型（ID 或显示名）是否是 ASR 模型；模型 ID 先剥网关前缀 */
export function isAsrModel(model: string, displayName: string): boolean {
  return isAsrModelName(stripGatewayPrefix(model)) || isAsrModelName(displayName);
}

/** 供应商是否提供 OpenAI 兼容的 ASR 接口（Anthropic / Gemini 原生 / Codex 账号没有） */
export function asrProviderSupported(providerId?: string | null, apiProtocol?: string | null): boolean {
  const provider = providerId === null || providerId === undefined ? null : asciiLower(rustTrim(providerId));
  if (provider === 'anthropic' || provider === 'gemini' || provider === 'google'
    || provider === 'openai_codex') {
    return false;
  }
  const protocol = apiProtocol === null || apiProtocol === undefined ? null : rustTrim(apiProtocol);
  return protocol !== 'anthropic_messages' && protocol !== 'google_generate_content';
}

/** 按模型名判定接口形态；只提供实时流 / 异步文件转写接口的模型抛错 */
export function asrProtocolForModel(model: string): AsrProtocol {
  const name = asciiLower(stripGatewayPrefix(model));
  let unsupported: string | null = null;
  if (name.includes('realtime') || name.includes('streaming')) unsupported = '实时流式（WebSocket）';
  else if (name.includes('filetrans')) unsupported = '异步文件转写';
  if (unsupported !== null) {
    throw new AsrConfigError('provider-unavailable',
      `${rustTrim(model)} 只提供${unsupported}接口，应用内转写需要普通 HTTP 识别接口（如 qwen3-asr-flash、Qwen/Qwen3-ASR-1.7B）`);
  }
  return name.includes('qwen3-asr-flash') ? 'chat_input_audio' : 'transcriptions';
}

export class AsrConfigError extends Error {
  readonly code: string;
  readonly providerId: string;
  readonly model: string;
  constructor(code: string, message: string, providerId = '', model = '') {
    super(message);
    this.name = 'AsrConfigError';
    this.code = code;
    this.providerId = providerId;
    this.model = model;
  }
}

/** 一次受管 ASR 调用的目标：用分配模型所属供应商自己的 base_url / key */
export class AsrEndpoint {
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly configId: string | null;
  readonly headers: Array<[string, string]>;
  readonly protocol: AsrProtocol;

  constructor(
    providerId: string, providerName: string, baseUrl: string, apiKey: string,
    model: string, configId: string | null,
  ) {
    const trimmed = rustTrim(model);
    let protocol: AsrProtocol;
    try { protocol = isDeepseekAsr(baseUrl, trimmed) ? 'deepseek_asr' : asrProtocolForModel(trimmed); }
    catch (error) {
      throw new AsrConfigError('provider-unavailable', (error as Error).message, providerId, trimmed);
    }
    this.providerId = providerId;
    this.providerName = providerName;
    this.baseUrl = rustTrim(baseUrl);
    this.apiKey = rustTrim(apiKey);
    this.model = trimmed;
    this.configId = configId;
    this.headers = [];
    this.protocol = protocol;
  }

  url(path: string): string {
    let base = this.baseUrl.replace(/\/+$/, '');
    if (base.endsWith('/audio/transcriptions')) base = base.slice(0, -'/audio/transcriptions'.length);
    else if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
    return `${base}/${path}`;
  }

  transcriptionUrl(): string {
    return this.protocol === 'deepseek_asr'
      ? 'https://api.deepseek.com/v1/tools/asr' : this.url('audio/transcriptions');
  }

  /**
   * `AsrEndpoint::siliconflow_default`：用户 SiliconFlow Key 优先；缺失时抛
   * settings-required（与 Rust 文案一致）。
   */
  static siliconflowDefault(
    resolveSiliconflowKey: () => string | null,
    model: string | null = null,
  ): AsrEndpoint {
    const trimmed = model === null ? '' : rustTrim(model);
    const chosen = trimmed === '' ? DEFAULT_SILICONFLOW_MODEL : trimmed;
    let key: string | null;
    try { key = resolveSiliconflowKey(); }
    catch { key = null; }
    const apiKey = key === null ? '' : rustTrim(key);
    if (apiKey === '') {
      throw new AsrConfigError('settings-required',
        '未配置语音识别：请在「设置 → 模型分配」选择语音识别（ASR）模型，或填写 SiliconFlow API Key 使用默认模型',
        DEFAULT_PROVIDER_ID, chosen);
    }
    return new AsrEndpoint(DEFAULT_PROVIDER_ID, 'SiliconFlow', DEFAULT_SILICONFLOW_BASE_URL,
      apiKey, chosen, null);
  }

  /**
   * `AsrEndpoint::from_api_config`：已分配的模型使用它自己供应商的
   * base_url / key / 透传 headers。`resolveSiliconflowKey` 对应 Rust 里从
   * 数据库读取 SiliconFlow Key 的 best-effort 分支。
   */
  static fromApiConfig(
    cfg: ApiConfig,
    resolveSiliconflowKey: () => string | null = () => null,
  ): AsrEndpoint {
    const providerId = configProviderId(cfg);
    const isSiliconflow = providerId === DEFAULT_PROVIDER_ID
      || cfg.baseUrl.includes('siliconflow');
    const trimmedModel = rustTrim(cfg.model);
    const model = isSiliconflow && RETIRED_SILICONFLOW_ASR_MODELS.includes(trimmedModel)
      ? DEFAULT_SILICONFLOW_MODEL
      : trimmedModel;
    if (!isDeepseekAsr(cfg.baseUrl, model) && !asrProviderSupported(providerId, cfg.apiProtocol)) {
      const vendorName = cfg.vendorName === null ? null : rustTrim(cfg.vendorName);
      const display = vendorName === null || vendorName === '' ? providerId : vendorName;
      throw new AsrConfigError('provider-unavailable',
        `供应商 ${display} 没有 OpenAI 兼容的语音识别接口，请改选其它供应商的 ASR 模型`,
        providerId, model);
    }
    let apiKey: string;
    if (!isMaskedSecret(cfg.apiKey)) {
      apiKey = rustTrim(cfg.apiKey);
    } else if (isSiliconflow) {
      let key: string | null;
      try { key = resolveSiliconflowKey(); }
      catch { key = null; }
      apiKey = key === null ? '' : rustTrim(key);
    } else {
      apiKey = '';
    }
    if (apiKey === '') {
      throw new AsrConfigError('settings-required',
        `语音识别模型 ${model} 所属供应商缺少 API Key，请先在「设置 → 模型服务」填写`,
        providerId, model);
    }
    const baseUrl = rustTrim(cfg.baseUrl) === '' && isSiliconflow
      ? DEFAULT_SILICONFLOW_BASE_URL
      : rustTrim(cfg.baseUrl);
    if (baseUrl === '') {
      throw new AsrConfigError('settings-required',
        `语音识别模型 ${model} 所属供应商缺少 Base URL`, providerId, model);
    }
    const vendorName = cfg.vendorName === null ? '' : rustTrim(cfg.vendorName);
    const endpoint = new AsrEndpoint(providerId, vendorName === '' ? providerId : vendorName,
      baseUrl, apiKey, model, cfg.id);
    endpoint.headers.push(...passthroughHeaders(cfg.headers));
    return endpoint;
  }
}

/** Rust `config_provider_id`：provider_scope → provider_type → "custom"。 */
export function configProviderId(cfg: Pick<ApiConfig, 'providerScope' | 'providerType'>): string {
  const raw = cfg.providerScope ?? cfg.providerType;
  if (raw === null) return 'custom';
  const provider = asciiLower(rustTrim(raw));
  return provider === '' ? 'custom' : provider;
}

function isMaskedSecret(value: string): boolean {
  const trimmed = rustTrim(value);
  return trimmed === '' || /^\*+$/.test(trimmed);
}

function validHeaderName(name: string): boolean {
  return HEADER_NAME.test(name);
}

function validHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff)) continue;
    return false;
  }
  return true;
}

/** Rust `passthrough_headers`：丢弃 Authorization/content-type 与非法 header。 */
export function passthroughHeaders(
  headers: Record<string, string> | null,
): Array<[string, string]> {
  if (headers === null) return [];
  const result: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = asciiLower(name);
    if (lower === 'authorization' || lower === 'content-type') continue;
    if (!validHeaderName(name) || !validHeaderValue(value)) continue;
    result.push([name, value]);
  }
  return result;
}

export type AsrHttpError =
  | { kind: 'transport'; timeout: boolean; message: string }
  | { kind: 'status'; status: number; retryAfterSeconds: number | null; body: string };

/** `impl Display for AsrHttpError`. */
export function formatAsrHttpError(error: AsrHttpError): string {
  return error.kind === 'transport' ? error.message : `HTTP ${error.status} ${error.body}`;
}

export type AsrFailureClass =
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'retryable' }
  | { kind: 'segment_fatal' }
  | { kind: 'job_fatal'; code: 'auth-failed' | 'model-unavailable' };

export function classifyFailure(error: AsrHttpError): AsrFailureClass {
  if (error.kind === 'transport') return { kind: 'retryable' };
  const status = error.status;
  if (status === 429) return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds };
  if (status === 401 || status === 403) return { kind: 'job_fatal', code: 'auth-failed' };
  if (status === 404) return { kind: 'job_fatal', code: 'model-unavailable' };
  if (status === 408 || (status >= 500 && status <= 599)) return { kind: 'retryable' };
  return { kind: 'segment_fatal' };
}

export const AIMD_INITIAL = 2;
export const AIMD_MIN = 1;
export const AIMD_MAX = 8;
export const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 5;

/** AIMD 并发控制器 */
export class Aimd {
  private limitValue: number;
  private readonly min: number;
  private readonly max: number;
  private streak = 0;
  private cooldownUntil: number | null = null;

  constructor(initial: number, min: number, max: number) {
    this.min = Math.max(min, 1);
    this.max = Math.max(max, this.min);
    this.limitValue = Math.min(Math.max(initial, this.min), this.max);
  }

  limit(): number { return this.limitValue; }

  /** 加性增：连续成功次数达到当前并发数时 +1 */
  onSuccess(): void {
    this.streak += 1;
    if (this.streak >= this.limitValue) {
      this.limitValue = Math.min(this.limitValue + 1, this.max);
      this.streak = 0;
    }
  }

  /** 乘性减：429 并发减半，冷却 Retry-After（缺省 5 s） */
  onRateLimited(nowMs: number, retryAfterSeconds?: number | null): void {
    this.limitValue = Math.max(Math.trunc(this.limitValue / 2), this.min);
    this.streak = 0;
    const until = nowMs + (retryAfterSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS) * 1000;
    this.cooldownUntil = this.cooldownUntil !== null && this.cooldownUntil > until ? this.cooldownUntil : until;
  }

  /** 其它失败：只打断连续成功 */
  onFailure(): void { this.streak = 0; }

  /** 冷却中则返回冷却结束时刻 */
  coolingUntil(nowMs: number): number | null {
    return this.cooldownUntil !== null && this.cooldownUntil > nowMs ? this.cooldownUntil : null;
  }
}

export interface AsrClipResult {
  text: string;
  speechBoundsMs: [number, number] | null;
}

/** 只有 whisper 系模型确定支持 `verbose_json`（句级时间戳） */
export function modelSupportsVerboseJson(model: string): boolean {
  return asciiLower(model).includes('whisper');
}

function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function parseTranscriptionBody(body: string): AsrClipResult {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch (error) { throw new Error(`Invalid ASR response: ${(error as Error).message}`); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid ASR response: expected an object');
  }
  const record = parsed as { text?: unknown; segments?: unknown };
  if (record.text !== undefined && record.text !== null && typeof record.text !== 'string') {
    throw new Error('Invalid ASR response: text must be a string');
  }
  const text = cleanAsrText((record.text as string | undefined | null) ?? '');
  let speechBoundsMs: [number, number] | null = null;
  if (record.segments !== undefined && record.segments !== null) {
    if (!Array.isArray(record.segments)) throw new Error('Invalid ASR response: segments must be an array');
    const starts: number[] = [];
    const ends: number[] = [];
    for (const segment of record.segments) {
      if (typeof segment !== 'object' || segment === null) {
        throw new Error('Invalid ASR response: invalid segment');
      }
      const { start, end } = segment as { start?: unknown; end?: unknown };
      if (start !== undefined && start !== null) {
        if (typeof start !== 'number') throw new Error('Invalid ASR response: invalid segment start');
        starts.push(start);
      }
      if (end !== undefined && end !== null) {
        if (typeof end !== 'number') throw new Error('Invalid ASR response: invalid segment end');
        ends.push(end);
      }
    }
    const start = starts.length > 0 ? Math.min(...starts) : Infinity;
    const end = ends.length > 0 ? Math.max(...ends) : -Infinity;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      speechBoundsMs = [roundHalfAway(start * 1000), roundHalfAway(end * 1000)];
    }
  }
  return { text, speechBoundsMs };
}

/** 去掉 Qwen3-ASR 原始输出里的 `language Chinese<asr_text>` 前缀 */
export function cleanAsrText(text: string): string {
  const MARKER = '<asr_text>';
  const trimmed = rustTrim(text);
  const idx = trimmed.indexOf(MARKER);
  if (idx >= 0 && (idx === 0 || trimmed.slice(0, idx).trimStart().startsWith('language'))) {
    return rustTrim(trimmed.slice(idx + MARKER.length));
  }
  return trimmed;
}

/** `asr_options.language` 只认主语言码（zh / en / yue …） */
export function chatAsrLanguage(language?: string | null): string | null {
  const value = nonEmpty(language);
  if (value === null) return null;
  const primary = asciiLower(value.split(/[-_]/)[0] ?? '');
  return primary !== '' && primary !== 'auto' ? primary : null;
}

/** 解析 chat 形态的识别结果：`choices[0].message.content`（字符串或 text 片段数组） */
export function parseChatTranscript(body: string): [string, string | null] {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (error) { throw new Error(`Invalid ASR response: ${(error as Error).message}`); }
  const choices = (value as { choices?: unknown } | null)?.choices;
  const message = Array.isArray(choices)
    ? (choices[0] as { message?: unknown } | undefined)?.message
    : undefined;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    throw new Error('Invalid ASR response: missing choices[0].message');
  }
  const record = message as { content?: unknown; annotations?: unknown };
  let text: string;
  if (typeof record.content === 'string') text = record.content;
  else if (Array.isArray(record.content)) {
    text = record.content
      .map(part => (typeof part === 'object' && part !== null
        ? (part as { text?: unknown }).text : undefined))
      .filter((part): part is string => typeof part === 'string')
      .join('');
  } else {
    throw new Error('Invalid ASR response: missing message content');
  }
  let language: string | null = null;
  if (Array.isArray(record.annotations)) {
    for (const item of record.annotations) {
      const value = typeof item === 'object' && item !== null
        ? (item as { language?: unknown }).language : undefined;
      if (typeof value === 'string') { language = value; break; }
    }
  }
  return [cleanAsrText(text), language];
}
