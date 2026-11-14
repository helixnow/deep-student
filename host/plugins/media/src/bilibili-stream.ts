/**
 * `dstu-media/src/media/bilibili_stream.rs`: pure logic of the `bilistream://`
 * protocol. Range forwarding, the CDN allow-list, quality negotiation and the
 * signed-URL cache are migrated here; `bilibili-protocol.ts` registers the Host
 * handler with F2's protocol registry.
 */
import type { BiliLinkDescriptor, QualityOption, RequestKind } from '../api.ts';
import { MediaError } from './errors.ts';
import { BiliRequestError, validateUrl } from './bilibili-policy.ts';
import { ERR_REQUEST, ERR_UNAVAILABLE } from './bilibili-links.ts';
import { API_LIMIT } from './bilibili-grpc.ts';
import type { BiliAttempt } from './bilibili-attempt.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export const STREAM_CHUNK_BYTES = 512 * 1024;
export const PLAY_SOURCE_TTL_SECONDS = 50 * 60;
export const PLAY_CACHE_MAX_ENTRIES = 32;
export const PROTOCOL_TIMEOUT_MS = 24_000;
export const DEFAULT_QN = 80;
export const MP4_QUALITIES: readonly number[] = [6, 16, 32, 64, 80];

const CDN_HOST_SUFFIXES = ['.bilivideo.com', '.bilivideo.cn', '.akamaized.net', '.szbdyd.com', '.hdslb.com'];

export interface PlayUrlSegment {
  url: string;
  size?: number | null;
  backup_url?: string[] | null;
}

export interface PlayUrlData {
  format?: string | null;
  durl: PlayUrlSegment[];
  quality?: number | null;
  accept_quality: number[];
  accept_description: string[];
}

export interface PlayInfo {
  url: string;
  backup_urls: string[];
  size: number | null;
  quality: number;
  options: QualityOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transportFailure(error: unknown): MediaError {
  if (error instanceof MediaError) return error;
  if (error instanceof BiliRequestError) {
    return new MediaError('Bilibili', error.message, error.payload.code);
  }
  return new MediaError('Transport', error instanceof Error ? error.message : String(error));
}

/** `serde` defaults for the playurl response body (`PlayUrlData`). */
export function parsePlayUrlData(value: unknown): PlayUrlData {
  if (!isRecord(value)) throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
  const format = value.format;
  if (format !== undefined && format !== null && typeof format !== 'string') {
    throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
  }
  const durlRaw = value.durl;
  if (durlRaw !== undefined && !Array.isArray(durlRaw)) {
    throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
  }
  const durl: PlayUrlSegment[] = (Array.isArray(durlRaw) ? durlRaw : []).map((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.url !== 'string') {
      throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
    }
    const size = raw.size;
    const backup = raw.backup_url;
    if (size !== undefined && size !== null && typeof size !== 'number') {
      throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
    }
    if (backup !== undefined && backup !== null
      && (!Array.isArray(backup) || backup.some(item => typeof item !== 'string'))) {
      throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
    }
    return { url: raw.url, size: size as number | null | undefined, backup_url: backup as string[] | null | undefined };
  });
  const quality = value.quality;
  if (quality !== undefined && quality !== null && typeof quality !== 'number') {
    throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
  }
  const acceptQuality = value.accept_quality;
  if (acceptQuality !== undefined
    && (!Array.isArray(acceptQuality) || acceptQuality.some(qn => typeof qn !== 'number'))) {
    throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
  }
  const acceptDescription = value.accept_description;
  if (acceptDescription !== undefined
    && (!Array.isArray(acceptDescription) || acceptDescription.some(d => typeof d !== 'string'))) {
    throw new MediaError('InvalidInput', 'B 站播放地址响应格式无效');
  }
  return {
    format: format as string | null | undefined,
    durl,
    quality: quality as number | null | undefined,
    accept_quality: (acceptQuality ?? []) as number[],
    accept_description: (acceptDescription ?? []) as string[],
  };
}

interface PlaySource { info: PlayInfo; expiresAt: number }

const PLAY_CACHE = new Map<string, PlaySource>();

/** 请求路径 → 条目 id（`/file_xxx`，可能被百分号编码） */
export function parseStreamPath(path: string): string | null {
  const first = path.replace(/^\/+/, '').split('/')[0] ?? '';
  let decoded: string;
  try { decoded = decodeURIComponent(first); }
  catch { return null; }
  const valid = (decoded.startsWith('file_') || decoded.startsWith('att_'))
    && utf8ByteLength(decoded) <= 64
    && /^[A-Za-z0-9_-]+$/.test(decoded);
  return valid ? decoded : null;
}

export function queryU32(query: string | null | undefined, name: string): number | null {
  for (const pair of (query ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== name) continue;
    const raw = pair.slice(eq + 1);
    if (!/^\+?[0-9]+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value <= 0xffff_ffff ? value : null;
  }
  return null;
}

/** 请求的清晰度；缺省 / 不在 MP4 白名单时用 DEFAULT_QN */
export function normalizeQn(qn: number | null | undefined): number {
  return qn !== null && qn !== undefined && MP4_QUALITIES.includes(qn) ? qn : DEFAULT_QN;
}

/** 播放地址的 `(qn, 账号代次)`：`?qn=64&e=1`。 */
export function parseStreamQuery(query?: string | null): [number, number] {
  const qn = queryU32(query, 'qn');
  const epoch = queryU32(query, 'e');
  return [normalizeQn(qn), epoch ?? 0];
}

export function cacheKey(fileId: string, qn: number, epoch: number): string {
  return `${fileId}@${qn}@${epoch}`;
}

export function attemptCacheKey(fileId: string, qn: number, epoch: number, attempt: number): string {
  return `${cacheKey(fileId, qn, epoch)}@${attempt}`;
}

/** F2 `convertFileSrc` forms for the Host's `bilistream` handler. */
export function biliStreamUrl(
  platform: 'darwin' | 'win32' | 'linux',
  fileId: string,
  qn: number,
  epoch: number,
  attempt: number,
): string {
  const query = `qn=${qn}&e=${epoch}&a=${attempt}`;
  const path = encodeURIComponent(fileId);
  return platform === 'win32'
    ? `http://bilistream.localhost/${path}?${query}`
    : `bilistream://localhost/${path}?${query}`;
}

export function fallbackQualityLabel(qn: number): string {
  switch (qn) {
    case 6: return '240P';
    case 16: return '360P';
    case 32: return '480P';
    case 64: return '720P';
    case 80: return '1080P';
    default: return `qn ${qn}`;
  }
}

/** `accept_quality` / `accept_description` → MP4 能播的清晰度（高 → 低，去重） */
export function mp4QualityOptions(data: PlayUrlData): QualityOption[] {
  const options: QualityOption[] = [];
  data.accept_quality.forEach((qn, i) => {
    const label = data.accept_description[i];
    options.push({ qn, label: label ?? '' });
  });
  if (data.quality !== null && data.quality !== undefined) options.push({ qn: data.quality, label: '' });
  const filtered = options
    .filter(option => MP4_QUALITIES.includes(option.qn))
    .map(option => ({
      qn: option.qn,
      label: option.label.trim() !== '' ? option.label.trim() : fallbackQualityLabel(option.qn),
    }));
  filtered.sort((a, b) => b.qn - a.qn);
  const seen = new Set<number>();
  return filtered.filter(option => seen.has(option.qn) ? false : (seen.add(option.qn), true));
}

export function parsePlayInfo(data: PlayUrlData, requestedQn: number): PlayInfo {
  if (data.format !== null && data.format !== undefined && !data.format.startsWith('mp4')) {
    throw new MediaError('InvalidInput', 'B 站没有返回单文件 MP4 视频');
  }
  const urls = pickPlayUrls(data);
  const url = urls.shift()!;
  const size = data.durl[0]!.size;
  return {
    url,
    backup_urls: urls,
    size: size !== null && size !== undefined && size > 0 ? size : null,
    quality: data.quality ?? requestedQn,
    options: mp4QualityOptions(data),
  };
}

/** 本地回环流服务允许的 Web 来源（Tauri 与本地开发服务器）。 */
export const ALLOWED_WEB_ORIGINS: readonly string[] = [
  'tauri://localhost', 'http://127.0.0.1:1422', 'http://localhost:1422',
];

export function allowedOrigin(origin: string): boolean {
  return ALLOWED_WEB_ORIGINS.includes(origin);
}

/** `linux.rs:78`：只接受 `127.0.0.1:<port>`，未带 Origin 视为同源。 */
export function localRequest(
  headers: { host?: string | undefined; origin?: string | undefined },
  port: number,
): boolean {
  if (headers.host !== `127.0.0.1:${port}`) return false;
  return headers.origin === undefined || allowedOrigin(headers.origin);
}

/**
 * `linux.rs:114`（`range_bounds`）：按已取到的总长度解析请求 Range。
 * 与 {@link upstreamRange} 不同，这里返回的是响应片段的绝对区间（尾随范围
 * 转成 `[total-suffix, total-1]`）。
 */
export function rangeBounds(
  value: string | null | undefined,
  total: number,
): [number, number] | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const last = total - 1;
  if (value === null || value === undefined) return [0, last];
  const trimmed = value.trim();
  if (!trimmed.startsWith('bytes=')) return null;
  const spec = trimmed.slice('bytes='.length);
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const firstRaw = spec.slice(0, dash);
  const endRaw = spec.slice(dash + 1);
  if (firstRaw === '') {
    if (!/^\+?[0-9]+$/.test(endRaw)) return null;
    const suffix = Math.min(Number(endRaw), total);
    return suffix > 0 ? [total - suffix, last] : null;
  }
  if (!/^\+?[0-9]+$/.test(firstRaw)) return null;
  const first = Number(firstRaw);
  if (!Number.isSafeInteger(first)) return null;
  let end = last;
  if (endRaw !== '') {
    if (!/^\+?[0-9]+$/.test(endRaw)) return null;
    const parsed = Number(endRaw);
    if (!Number.isSafeInteger(parsed)) return null;
    end = Math.min(parsed, last);
  }
  return first <= end ? [first, end] : null;
}

/** `Range` 头 → 要向 CDN 请求的 `(start, end)`（含端点），每次最多 STREAM_CHUNK_BYTES。 */
export function upstreamRange(range: string | null | undefined): [number, number] | null {
  if (range === null || range === undefined) return [0, STREAM_CHUNK_BYTES - 1];
  const trimmed = range.trim();
  if (!trimmed.startsWith('bytes=')) return null;
  const spec = trimmed.slice('bytes='.length);
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const startRaw = spec.slice(0, dash).trim();
  if (!/^\+?[0-9]+$/.test(startRaw)) return null;
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start)) return null;
  const maxEnd = start + STREAM_CHUNK_BYTES - 1;
  if (!Number.isSafeInteger(maxEnd)) return null;
  const endRaw = spec.slice(dash + 1).trim();
  let end: number;
  if (endRaw === '') end = maxEnd;
  else {
    if (!/^\+?[0-9]+$/.test(endRaw)) return null;
    const parsed = Number(endRaw);
    if (!Number.isSafeInteger(parsed)) return null;
    end = Math.min(parsed, maxEnd);
  }
  return end >= start ? [start, end] : null;
}

export function isCdnUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); }
  catch { return false; }
  try { validateUrl(url, 'media'); }
  catch { return false; }
  const host = url.hostname.replace(/[A-Z]/g, c => c.toLowerCase());
  return CDN_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/** 只接受单文件 MP4；主地址不在 CDN 白名单时用备用地址（http 升级为 https） */
export function pickPlayUrls(data: PlayUrlData): string[] {
  if (data.durl.length !== 1) {
    throw new MediaError('InvalidInput',
      `B 站给出的是 ${data.durl.length} 段的旧格式视频，无法在应用内直接播放`);
  }
  const segment = data.durl[0]!;
  const candidates = [segment.url, ...(segment.backup_url ?? [])].map(url =>
    url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url);
  const urls: string[] = [];
  for (const url of candidates.filter(isCdnUrl)) {
    if (!urls.includes(url)) urls.push(url);
    if (urls.length === 3) break;
  }
  if (urls.length === 0) throw new MediaError('InvalidInput', 'B 站返回的视频地址不在 B 站 CDN 上');
  return urls;
}

export function pickPlayUrl(data: PlayUrlData): string { return pickPlayUrls(data)[0]!; }

// ============================================================================
// 取地址 / 转发 Range
// ============================================================================

/** 与 `PROTOCOL_TIMEOUT` 同一个上限：协议处理必须在 24s 内结束。 */
export const INITIAL_CHUNK_BYTES = 64 * 1024;

export interface BiliHttpResponse {
  status: number;
  header(name: string): string | null;
  body: Uint8Array;
}

export interface BiliHttpRequest {
  url: string;
  headers: Record<string, string>;
  /** 绝对时刻（epoch ms），超过即中止请求。 */
  deadlineMs: number;
  method?: string;
  body?: Uint8Array;
  maxBytes?: number;
  /** 出口策略用它区分短链 / API / 字幕 / 媒体 / 封面；测试直连可省略。 */
  kind?: RequestKind;
}

/** `BiliAttempt::execute` 的最小形态：协议路径只需要 GET + 绝对截止时刻。 */
export interface BiliAttemptLike {
  execute(request: BiliHttpRequest): Promise<BiliHttpResponse>;
}

/** 一次 CDN Range 请求的结果；对应 Rust 的 `Upstream`。 */
export type Upstream =
  | {
    kind: 'ok';
    status: number;
    contentRange: string | null;
    contentType: string | null;
    etag: string | null;
    body: Uint8Array;
  }
  | { kind: 'stale'; status: number }
  | { kind: 'unsatisfiable'; range: string }
  | { kind: 'failed'; message: string };

export interface BiliStreamClientOptions {
  /** B 站会话 Cookie（`SESSDATA=…; bili_jct=…`），游客为 null。 */
  cookie?: string | null;
  fetchImpl?: typeof fetch;
  /** 接口/媒体请求的默认截止时刻增量。 */
  timeoutMs?: number;
  /** 生产环境开启出口策略校验；测试客户端指向本地 HTTP 服务时关闭。 */
  strictHosts?: boolean;
  /** 生产出口（native / proxy / browser_bridge）；缺省时使用本类的直连测试客户端。 */
  attempt?: BiliAttempt;
}

/**
 * 按 `maxBytes` 读取响应体：先看 `Content-Length`，有 `body` 时逐块累加，
 * 一超限立刻取消流并抛错，避免上游忽略 `Range` 时把整个视频先 `arrayBuffer()` 进内存。
 */
async function readLimitedBody(response: Response, maxBytes: number | undefined): Promise<Uint8Array> {
  const tooLarge = () => new MediaError('Bilibili', 'B 站响应超过大小限制',
    'bilibili-response-too-large');
  if (maxBytes !== undefined) {
    const declared = response.headers.get('content-length');
    const length = declared === null ? null : Number(declared);
    if (length !== null && Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.length > maxBytes) throw tooLarge();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* boundary-allow empty-catch: cancel 已释放锁 */ }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * 直连 B 站 passport/api/CDN 的 HTTP 客户端（`BiliClient::get_api` 的取地址部分）。
 *
 * Rust 的 `BiliAttempt` 还负责出口策略、账号代次与重试；这里只保留协议处理所需
 * 的 GET + 绝对截止时刻，调用方仍可注入自己的实现。
 */
export class BiliStreamClient implements BiliAttemptLike {
  readonly apiBase: string;
  readonly strictHosts: boolean;
  readonly attempt: BiliAttempt | null;
  protected readonly timeoutMs: number;
  private readonly cookie: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(apiBase: string, options: BiliStreamClientOptions = {}) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.cookie = options.cookie ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PROTOCOL_TIMEOUT_MS;
    this.strictHosts = options.strictHosts ?? true;
    this.attempt = options.attempt ?? null;
  }

  async execute(request: BiliHttpRequest): Promise<BiliHttpResponse> {
    if (this.attempt !== null) {
      try {
        const response = await this.attempt.execute({
          kind: request.kind ?? 'api',
          url: new URL(request.url),
          method: request.method ?? 'GET',
          headers: request.headers,
          body: request.body ?? new Uint8Array(0),
          maxBytes: request.maxBytes ?? API_LIMIT,
          deadlineMs: request.deadlineMs,
        });
        return {
          status: response.status,
          header: name => response.header(name),
          body: response.body,
        };
      } catch (error) {
        throw transportFailure(error);
      }
    }
    const controller = new AbortController();
    const remaining = Math.max(request.deadlineMs - Date.now(), 0);
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method ?? 'GET',
        body: request.body === undefined ? undefined : new Uint8Array(request.body),
        headers: {
          // BiliAttempt 对 api / 媒体 / 字幕请求统一带视频页 Referer。
          referer: 'https://www.bilibili.com/',
          ...request.headers,
        },
        signal: controller.signal,
        // Rust 侧 `redirect::Policy::none()`：跳转必须显式处理，不能被静默跟随。
        redirect: 'manual',
      });
      const body = await readLimitedBody(response, request.maxBytes);
      return {
        status: response.status,
        header: name => response.headers.get(name),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `BiliClient::get_api`：B 站信封（`{code,message,data}`）→ data。 */
  async getApi<T>(path: string, query: ReadonlyArray<readonly [string, string]>): Promise<T | null> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const headers: Record<string, string> = {};
    if (this.cookie !== null && this.attempt === null) headers.cookie = this.cookie;
    const response = await this.execute({
      url: url.toString(),
      headers,
      deadlineMs: Date.now() + this.timeoutMs,
      maxBytes: API_LIMIT,
      kind: 'api',
    });
    if (response.status === 412 || response.status === 429) {
      throw new MediaError('Bilibili', 'B 站暂时拦截了请求（风控），请过几分钟再试',
        ERR_REQUEST);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MediaError('Bilibili', `B 站接口返回 HTTP ${response.status}`, ERR_REQUEST);
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
    catch {
      throw new MediaError('Bilibili', 'B 站接口返回了未知格式（可能为验证页面）',
        'bilibili-protocol');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)
      || typeof (body as Record<string, unknown>).code !== 'number') {
      throw new MediaError('Bilibili', 'B 站接口返回了未知格式（可能为验证页面）',
        'bilibili-protocol');
    }
    const envelope = body as { code: number; message?: unknown; data?: unknown };
    const message = typeof envelope.message === 'string' ? envelope.message : '';
    switch (envelope.code) {
      case 0:
        return (envelope.data ?? null) as T | null;
      case -404:
      case -403:
      case 62002:
      case 62004:
      case 62005:
      case 62012:
        throw new MediaError('Bilibili',
          `视频不存在或当前不可见（B 站返回 ${envelope.code}：${message}）`, ERR_UNAVAILABLE);
      case -412:
      case -352:
        throw new MediaError('Bilibili', 'B 站暂时拦截了请求（风控），请过几分钟再试',
          ERR_REQUEST);
      case -101:
        throw new MediaError('Bilibili', '当前出口需要登录 B 站', 'bilibili-login-required');
      default:
        throw new MediaError('Bilibili',
          `B 站接口返回错误 ${envelope.code}：${message}`, ERR_REQUEST);
    }
  }
}

function isMediaError(error: unknown, code: string): boolean {
  return error instanceof MediaError && error.code === code;
}

/** `parse_content_range`：`bytes 0-3/16` → `[0, 3, 16]`。 */
export function parseContentRange(value: string): [number, number, number] | null {
  if (!value.startsWith('bytes ')) return null;
  const slash = value.indexOf('/');
  if (slash < 0) return null;
  const range = value.slice('bytes '.length, slash);
  const dash = range.indexOf('-');
  if (dash < 0) return null;
  const start = range.slice(0, dash);
  const end = range.slice(dash + 1);
  const total = value.slice(slash + 1);
  if (!/^\+?[0-9]+$/.test(start) || !/^\+?[0-9]+$/.test(end) || !/^\+?[0-9]+$/.test(total)) {
    return null;
  }
  const first = Number(start);
  const last = Number(end);
  const size = Number(total);
  if (![first, last, size].every(Number.isSafeInteger)) return null;
  return first <= last && last < size ? [first, last, size] : null;
}

/** `fetch_range`：带 Range 请求 CDN；状态/区间/长度任一不符都判失败。 */
export async function fetchRange(
  client: BiliAttemptLike,
  url: string,
  start: number,
  end: number,
  validator: string | null,
  deadlineMs: number,
): Promise<Upstream> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { kind: 'failed', message: '视频地址无效' }; }
  const headers: Record<string, string> = {
    range: `bytes=${start}-${end}`,
  };
  if (validator !== null) headers['if-range'] = validator;
  let response: BiliHttpResponse;
  try {
    response = await client.execute({
      url: parsed.toString(),
      headers,
      deadlineMs,
      maxBytes: end - start + 1,
      kind: 'media',
    });
  } catch (error) {
    return { kind: 'failed', message: (error as Error).message };
  }
  const status = response.status;
  if (status === 403 || status === 404 || status === 410) return { kind: 'stale', status };
  if (status === 416) {
    return { kind: 'unsatisfiable', range: response.header('content-range') ?? 'bytes */*' };
  }
  if (status !== 200 && status !== 206) {
    return { kind: 'failed', message: `B 站视频服务器返回 HTTP ${status}` };
  }
  const contentRange = response.header('content-range');
  const contentType = response.header('content-type');
  const rawEtag = response.header('etag');
  const etag = rawEtag !== null && !rawEtag.startsWith('W/')
    && rawEtag.startsWith('"') && rawEtag.endsWith('"') ? rawEtag : null;
  let last: number;
  let total: number;
  if (status === 206) {
    const range = contentRange === null ? null : parseContentRange(contentRange);
    if (range === null || range[0] !== start || range[1] > end) {
      return { kind: 'failed', message: 'B 站视频服务器返回了无效的视频区间' };
    }
    [, last, total] = range;
  } else {
    // 200 可能包含整个视频：绝不为模拟 Range 而整体缓冲。
    const contentLength = response.header('content-length');
    const declared = contentLength !== null && /^[0-9]+$/.test(contentLength)
      ? Number(contentLength) : null;
    if (declared === null || start !== 0 || declared <= 0 || declared > end + 1) {
      return { kind: 'failed', message: 'B 站视频服务器不支持分段读取，请重试其他节点' };
    }
    last = declared - 1;
    total = declared;
  }
  const expected = last - start + 1;
  if (response.body.length !== expected) {
    return { kind: 'failed', message: '视频数据不完整，请重试' };
  }
  return {
    kind: 'ok',
    status: 206,
    contentRange: `bytes ${start}-${last}/${total}`,
    contentType,
    etag,
    body: response.body,
  };
}

export interface Representation {
  url: string;
  etag: string | null;
  total: number;
}

/** `fetch_candidates`：主地址失败后按顺序尝试备用节点，返回命中的地址。 */
export async function fetchCandidates(
  client: BiliAttemptLike,
  info: PlayInfo,
  start: number,
  end: number,
  deadlineMs = Date.now() + PROTOCOL_TIMEOUT_MS,
  representation: Representation | null = null,
): Promise<[Upstream, string | null]> {
  let last: Upstream = { kind: 'failed', message: '没有可用的视频节点' };
  let staleStatus: number | null = null;
  for (const url of [info.url, ...info.backup_urls]) {
    if (representation !== null && representation.etag === null && representation.url !== url) {
      continue;
    }
    let result = await fetchRange(client, url, start, end, representation?.etag ?? null, deadlineMs);
    if (result.kind === 'ok') {
      const total = result.contentRange === null
        ? null : parseContentRange(result.contentRange)?.[2] ?? null;
      if ((info.size !== null && total !== info.size)
        || (representation !== null
          && (total !== representation.total
            || (representation.etag !== null && result.etag !== representation.etag)))) {
        result = { kind: 'failed', message: '视频源大小已改变，请重新开始播放' };
      }
    }
    if (result.kind === 'ok' || result.kind === 'unsatisfiable') return [result, url];
    if (result.kind === 'stale') staleStatus = result.status;
    last = result;
  }
  return [staleStatus === null ? last : { kind: 'stale', status: staleStatus }, null];
}

async function requestPlayInfo(
  client: BiliStreamClient,
  descriptor: Pick<BiliLinkDescriptor, 'bvid' | 'cid'>,
  qn: number,
  html5: boolean,
): Promise<PlayInfo> {
  const query: Array<[string, string]> = [
    ['bvid', descriptor.bvid],
    ['cid', String(descriptor.cid)],
    ['qn', String(qn)],
    ['fnval', '1'],
    ['fnver', '0'],
    ['fourk', '0'],
    ['high_quality', '1'],
  ];
  if (html5) query.push(['platform', 'html5']);
  const data = await client.getApi<unknown>('/x/player/playurl', query);
  if (data === null) throw new MediaError('InvalidInput', 'B 站没有返回播放地址');
  return parsePlayInfo(parsePlayUrlData(data), qn);
}

/**
 * `resolve_play_info`：先按 html5 平台取单文件地址；当响应声称支持请求的清晰度、
 * 实际却降档时，再用标准 MP4 请求在同一账号上复核一次。
 */
export async function resolvePlayInfo(
  client: BiliStreamClient,
  descriptor: Pick<BiliLinkDescriptor, 'bvid' | 'cid'>,
  qn: number,
): Promise<PlayInfo> {
  let info = await requestPlayInfo(client, descriptor, qn, true);
  if (info.quality < qn && info.options.some(option => option.qn === qn)) {
    try {
      const standard = await requestPlayInfo(client, descriptor, qn, false);
      if (standard.quality > info.quality && standard.quality <= qn) info = standard;
    } catch (error) {
      for (const code of [
        'bilibili-login-required', 'bilibili-request-failed',
        'bilibili-video-unavailable', 'bilibili-identity-changed',
      ]) {
        if (isMediaError(error, code)) throw error;
      }
      // 标准 MP4 复核失败不影响 html5 已拿到的可播地址。
    }
  }
  return info;
}

/** 签名地址的 deadline 决定缓存时长，最长 50 分钟。 */
export function sourceTtlSeconds(url: string, nowSeconds = Math.floor(Date.now() / 1000)): number {
  let deadline: number | null = null;
  try {
    const value = new URL(url).searchParams.get('deadline');
    if (value !== null && /^[0-9]+$/.test(value)) deadline = Number(value);
  } catch { deadline = null; }
  if (deadline === null) return PLAY_SOURCE_TTL_SECONDS;
  return Math.min(Math.max(deadline - (nowSeconds + 30), 0), PLAY_SOURCE_TTL_SECONDS);
}

export function cachedSource(key: string): PlayInfo | null {
  const source = PLAY_CACHE.get(key);
  if (source === undefined || Date.now() >= source.expiresAt) return null;
  return source.info;
}

/** `play_info_for` 的旧值比较读的是原始缓存项（即使已过期），用于发现视频源变化。 */
export function staleSource(key: string): PlayInfo | null {
  return PLAY_CACHE.get(key)?.info ?? null;
}

export function rememberSource(key: string, info: PlayInfo, nowMs = Date.now()): void {
  for (const [k, source] of PLAY_CACHE) if (nowMs >= source.expiresAt) PLAY_CACHE.delete(k);
  if (PLAY_CACHE.size >= PLAY_CACHE_MAX_ENTRIES) PLAY_CACHE.clear();
  PLAY_CACHE.set(key, { info, expiresAt: nowMs + sourceTtlSeconds(info.url) * 1000 });
}

export function forgetSource(key: string): void { PLAY_CACHE.delete(key); }
