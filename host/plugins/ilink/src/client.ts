/**
 * Rust: src/plugins/ilink_bot/client.rs (WeChat ClawBot protocol). HTTP is performed with
 * the Host runtime's global fetch; the timeout/error split mirrors reqwest's
 * `is_timeout() && !is_connect()` rule so connection failures never look like empty polls.
 */
import { AppError } from '../../../kernel/error-model.ts';
import type { PluginJsonValue as JsonValue } from '../../../kernel/plugin-types.ts';
import { decodeIlink } from './decode.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { statusLine } from '../../../platform/util/http-status.ts';
import { toBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CHANNEL_VERSION = '1.0.0';
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const SESSION_EXPIRED = -14;
export type IlinkInteger = number | bigint;

export interface IlinkCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
}

export function emptyCredentials(): IlinkCredentials {
  return { token: '', baseUrl: '', accountId: '', userId: '', getUpdatesBuf: '', contextTokens: {} };
}

export interface QrcodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QrcodeStatusResponse {
  status: string;
  bot_token?: string | null;
  ilink_bot_id?: string | null;
  ilink_user_id?: string | null;
  baseurl?: string | null;
}

export interface WeixinMessage {
  seq?: IlinkInteger | null;
  message_id?: IlinkInteger | null;
  from_user_id?: string | null;
  to_user_id?: string | null;
  client_id?: string | null;
  create_time_ms?: IlinkInteger | null;
  session_id?: string | null;
  message_type?: number | null;
  message_state?: number | null;
  context_token?: string | null;
  item_list?: MessageItem[];
}

export interface MessageItem {
  type?: number | null;
  text_item?: TextItem | null;
}

export interface TextItem {
  text?: string | null;
}

export interface GetUpdatesResponse {
  ret?: IlinkInteger | null;
  errcode?: IlinkInteger | null;
  errmsg?: string | null;
  msgs: WeixinMessage[];
  get_updates_buf?: string | null;
  longpolling_timeout_ms?: IlinkInteger | null;
}

export function randomWechatUin(): string {
  const [value] = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return toBase64(utf8Encode(String(value)));
}

export function isApiError(ret: IlinkInteger | null | undefined, errcode: IlinkInteger | null | undefined): boolean {
  return (ret !== null && ret !== undefined && ret !== 0 && ret !== 0n) || (errcode !== null && errcode !== undefined && errcode !== 0 && errcode !== 0n);
}

export function isSessionExpired(ret: IlinkInteger | null | undefined, errcode: IlinkInteger | null | undefined): boolean {
  return ret === SESSION_EXPIRED || errcode === SESSION_EXPIRED || ret === -14n || errcode === -14n;
}

export function extractText(msg: WeixinMessage): string {
  return (msg.item_list ?? [])
    .map((item) => item.text_item?.text)
    .filter((text): text is string => text !== null && text !== undefined)
    .join('\n');
}

/** Split long outbound text into chunks of at most `limit` Unicode code points. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length === 0) return [];
  const chars = Array.from(text);
  if (limit === 0 || chars.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += limit) chunks.push(chars.slice(i, i + limit).join(''));
  return chunks;
}

/** Keep each emitted fenced-code fragment independently renderable, including wrappers in the limit. */
export function chunkMarkdownSafeText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid_message_limit');
  if (!text) return [];
  type Fence = { marker: string; info: string };
  const chars = Array.from(text);
  const boundaries: { start: number; end: number; after: Fence | null }[] = [];
  let active: Fence | null = null, lineOffset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const match = /^ {0,3}(`{3,})([^\r\n]*)\r?\n?$/.exec(line);
    const end = lineOffset + Array.from(line).length;
    if (match && (!active || (match[1]!.length >= active.marker.length && !match[2]!.trim()))) {
      active = active ? null : { marker: match[1]!, info: match[2]! };
      boundaries.push({ start: lineOffset, end, after: active });
    }
    lineOffset = end;
  }
  const fenceAt = (offset: number): Fence | null => {
    let fence: Fence | null = null;
    for (const boundary of boundaries) {
      if (boundary.end > offset) break;
      fence = boundary.after;
    }
    return fence;
  };
  const chunks: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    const before = fenceAt(offset);
    const prefix = before ? `${before.marker}${before.info}\n` : '';
    let end = Math.min(chars.length, offset + limit - Array.from(prefix).length);
    let body = '', suffix = '';
    while (end > offset) {
      const boundary = boundaries.find(item => item.start < end && end < item.end);
      if (boundary) { end = boundary.start; continue; }
      const after = fenceAt(end);
      body = chars.slice(offset, end).join('');
      suffix = after ? `${body.endsWith('\n') ? '' : '\n'}${after.marker}` : '';
      const excess = Array.from(prefix + body + suffix).length - limit;
      if (excess <= 0) break;
      end -= excess;
    }
    // A limit smaller than an opening fence + closing wrapper cannot preserve Markdown.
    if (end <= offset) throw new RangeError('message_limit_too_small_for_code_fence');
    chunks.push(prefix + body + suffix);
    offset = end;
  }
  return chunks;
}

/** One-based failure attempt; server Retry-After is a floor, not capped by maxMs. */
export function computeEqualJitterBackoffMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 60_000,
  retryAfterMs = 0,
  randomFn: () => number = Math.random,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(1023, Math.max(0, attempt - 1)));
  return Math.max(retryAfterMs, Math.round(cap * (0.5 + randomFn() * 0.5)));
}

export interface IlinkFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface IlinkClientOptions {
  fetch?: IlinkFetch;
  now?: () => number;
  uuid?: () => string;
}

function base(creds: IlinkCredentials): string {
  if (rustTrim(creds.baseUrl).length === 0) return DEFAULT_BASE_URL;
  // Rust: `creds.base_url.trim_end_matches('/')` — it does not trim other whitespace.
  return creds.baseUrl.replace(/\/+$/, '');
}

/** `http::StatusCode` Display is `"<code> <canonical reason>"` (http 0.2.12 status.rs:216-224). */
function statusText(response: Response): string {
  return statusLine(response.status);
}

function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([timeout, external]);
}

/** `urlencoding::encode`: RFC 3986 unreserved set only (`!'()*` are escaped too). */
function urlencode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function errorName(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && (current as { code: unknown }).code === code) return true;
    current = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * reqwest's `{e}` keeps the OS/transport message, so append the Node cause chain instead of
 * printing the opaque `fetch failed` wrapper alone.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'object' && 'message' in current) {
      const message = (current as { message: unknown }).message;
      if (typeof message === 'string' && message.length > 0 && !parts.includes(message)) parts.push(message);
      current = (current as { cause?: unknown }).cause;
    } else {
      const text = String(current);
      if (!parts.includes(text)) parts.push(text);
      break;
    }
  }
  return parts.length > 0 ? parts.join(': ') : String(error);
}

/** Connection-phase timeouts are `is_connect()` in reqwest and must not become an idle poll. */
function isIdleLongPollTimeout(error: unknown): boolean {
  return errorName(error) === 'TimeoutError' && !hasErrorCode(error, 'UND_ERR_CONNECT_TIMEOUT');
}

// ------------------------------------------------------------------ client

const MAX_TIMER_MS = 2_147_483_647;

export class IlinkClient {
  private readonly request: IlinkFetch;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(options: IlinkClientOptions = {}) {
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  }

  async getBotQrcode(signal?: AbortSignal): Promise<QrcodeResponse> {
    const url = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
    let response: Response;
    try {
      response = await this.request(url, { signal: requestSignal(60_000, signal) });
    } catch (error) {
      throw AppError.network(`get_bot_qrcode 失败: ${errorText(error)}`);
    }
    if (!response.ok) throw AppError.network(`get_bot_qrcode HTTP ${statusText(response)}`);
    try {
      return decodeIlink(await response.text(), 'qrcode');
    } catch (error) {
      throw AppError.validation(`解析二维码响应失败: error decoding response body: ${errorText(error)}`);
    }
  }

  async getQrcodeStatus(qrcode: string, signal?: AbortSignal): Promise<QrcodeStatusResponse> {
    const url = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${urlencode(qrcode)}`;
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { 'iLink-App-ClientVersion': '1' },
        signal: requestSignal(40_000, signal),
      });
    } catch (error) {
      throw AppError.network(`get_qrcode_status 失败: ${errorText(error)}`);
    }
    if (!response.ok) throw AppError.network(`get_qrcode_status HTTP ${statusText(response)}`);
    try {
      return decodeIlink(await response.text(), 'status');
    } catch (error) {
      throw AppError.validation(`解析扫码状态失败: error decoding response body: ${errorText(error)}`);
    }
  }

  /**
   * `http::HeaderValue::from_str` accepts visible ASCII plus HTAB (http 0.2.12
   * header/value.rs:143-172); anything else is a validation error before any HTTP call.
   */
  private authHeaders(token: string): Record<string, string> {
    const headerValue = (value: string, name: string): string => {
      if (!/^[\t\x20-\x7e]*$/.test(value)) throw AppError.validation(`${name} 无效: failed to parse header value`);
      return value;
    };
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: headerValue(`Bearer ${token}`, 'Authorization'),
      'x-wechat-uin': headerValue(randomWechatUin(), 'X-WECHAT-UIN'),
    };
  }

  async getUpdates(creds: IlinkCredentials, timeoutMs: IlinkInteger, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    const url = `${base(creds)}/ilink/bot/getupdates`;
    const body = JSON.stringify({
      get_updates_buf: creds.getUpdatesBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const timeout = typeof timeoutMs === 'bigint'
      ? Number(timeoutMs > BigInt(MAX_TIMER_MS - 5_000) ? BigInt(MAX_TIMER_MS) : (timeoutMs + 5_000n < 40_000n ? 40_000n : timeoutMs + 5_000n))
      : Math.min(Math.max(timeoutMs + 5_000, 40_000), MAX_TIMER_MS);
    // Rust resolves headers with `?` before `send`, so an invalid token is a validation
    // error rather than a transport error.
    const headers = this.authHeaders(creds.token);
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers,
        body,
        signal: requestSignal(timeout, signal),
      });
    } catch (error) {
      if (isIdleLongPollTimeout(error)) {
        return {
          ret: 0,
          errcode: null,
          errmsg: null,
          msgs: [],
          get_updates_buf: creds.getUpdatesBuf,
          longpolling_timeout_ms: timeoutMs,
        };
      }
      throw AppError.network(`getupdates 失败: ${errorText(error)}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw AppError.network(`getupdates HTTP ${statusText(response)}: ${text}`);
    }
    try {
      return decodeIlink(await response.text(), 'updates');
    } catch (error) {
      throw AppError.validation(`解析 getupdates 失败: error decoding response body: ${errorText(error)}`);
    }
  }

  async sendText(creds: IlinkCredentials, toUserId: string, contextToken: string, text: string): Promise<JsonValue> {
    const url = `${base(creds)}/ilink/bot/sendmessage`;
    const clientId = `dstu-${this.now()}-${this.uuid().slice(0, 8)}`;
    const body = JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const headers = this.authHeaders(creds.token);
    let response: Response;
    try {
      // reqwest's client-level timeout (client.rs:154-159) applies to sendmessage too.
      response = await this.request(url, { method: 'POST', headers, body, signal: requestSignal(60_000) });
    } catch (error) {
      throw AppError.network(`sendmessage 失败: ${errorText(error)}`);
    }
    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw AppError.network(`sendmessage HTTP ${statusText(response)}: ${responseText}`);
    }
    let reply: ReturnType<typeof decodeIlink>;
    try {
      reply = decodeIlink(await response.text(), 'reply');
    } catch (error) {
      throw AppError.validation(`解析 sendmessage 失败: error decoding response body: ${errorText(error)}`);
    }
    const { value, ret, errcode } = reply;
    if (isSessionExpired(ret, errcode)) throw AppError.configuration('session expired (-14)');
    if (isApiError(ret, errcode)) throw AppError.network(`sendmessage 业务错误: ${reply.display}`);
    return value;
  }
}
