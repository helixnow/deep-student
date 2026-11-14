/**
 * `dstu-media/src/media/bilibili_auth.rs`: cookie/session helpers plus the
 * passport/API reads used by QR login (`AuthClient::qr_poll` / `nav`).
 *
 * Secure-store persistence (F4) and the exit/logout command stay with the
 * account layer; QR PNG rendering uses the kernel's `dstu-util::qr` port.
 */
import { encodeUtf8 } from '../../../platform/util/portable.ts';
import type { BiliAttempt, BiliRequest, BiliResponse } from './bilibili-attempt.ts';

export const SESSION_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5'] as const;

export interface NavData {
  isLogin: boolean;
  mid: number | null;
  uname: string | null;
  face: string | null;
  vipStatus: number;
}

export interface StoredSession {
  cookie: string;
  mid: number | null;
  uname: string | null;
  face: string | null;
  vip: boolean;
  savedAt: number;
}

export function cookieValue(cookie: string, name: string): string | null {
  for (const pair of cookie.split(';')) {
    const eq = pair.trim().indexOf('=');
    if (eq < 0) continue;
    if (pair.trim().slice(0, eq).trim() === name) return pair.trim().slice(eq + 1).trim();
  }
  return null;
}

export function cookieHasSession(cookie: string): boolean {
  const value = cookieValue(cookie, 'SESSDATA');
  return value !== null && value !== '';
}

/** 从 `Set-Cookie` 头里取会话 Cookie，拼成请求用的 `a=1; b=2`；没有 SESSDATA 返回 null */
export function sessionCookieFromSetCookie(headers: readonly string[]): string | null {
  const pairs: Array<[string, string]> = [];
  for (const header of headers) {
    const first = header.split(';')[0] ?? '';
    const eq = first.trim().indexOf('=');
    if (eq < 0) continue;
    const name = first.trim().slice(0, eq).trim();
    const value = first.trim().slice(eq + 1).trim();
    if (value === '' || !(SESSION_COOKIE_NAMES as readonly string[]).includes(name)) continue;
    const existing = pairs.findIndex(([n]) => n === name);
    if (existing >= 0) pairs.splice(existing, 1);
    pairs.push([name, value]);
  }
  const cookie = pairs.map(([n, v]) => `${n}=${v}`).join('; ');
  return cookieHasSession(cookie) ? cookie : null;
}

/** 兜底：poll 成功时 `data.url` 的查询串里也带着同样的会话字段 */
export function sessionCookieFromUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return null; }
  const values = SESSION_COOKIE_NAMES
    .map(name => {
      const value = parsed.searchParams.get(name);
      return value === null ? null : `${name}=${value}`;
    })
    .filter((pair): pair is string => pair !== null && !pair.endsWith('='));
  const cookie = values.join('; ');
  return cookieHasSession(cookie) ? cookie : null;
}

export function isValidQrcodeKey(key: string): boolean {
  return /^[A-Za-z0-9]{16,64}$/.test(key);
}

export function pollState(code: number): 'success' | 'waiting' | 'scanned' | 'expired' | null {
  switch (code) {
    case 0: return 'success';
    case 86101: return 'waiting';
    case 86090: return 'scanned';
    case 86038: return 'expired';
    default: return null;
  }
}

/** B 站头像只认 https 的 B 站图床 */
export function sanitizeFace(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { return null; }
  const host = url.hostname.replace(/[A-Z]/g, c => c.toLowerCase());
  const okHost = host === 'hdslb.com' || host.endsWith('.hdslb.com');
  if (!okHost) return null;
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.protocol === 'https:' ? url.toString() : null;
}

export function sessionWithProfile(cookie: string, nav: NavData | null, nowMs: number): StoredSession {
  const profile: NavData = nav ?? { isLogin: false, mid: null, uname: null, face: null, vipStatus: 0 };
  const cookieMid = cookieValue(cookie, 'DedeUserID');
  let mid = profile.mid;
  if (mid === null && cookieMid !== null && /^\+?[0-9]+$/.test(cookieMid)) {
    const parsed = Number(cookieMid);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER) mid = parsed;
  }
  return {
    mid,
    uname: profile.uname !== null && profile.uname.trim() !== '' ? profile.uname : null,
    face: profile.face === null ? null : sanitizeFace(profile.face),
    vip: profile.vipStatus === 1,
    cookie,
    savedAt: nowMs,
  };
}

export type NavResult =
  | { kind: 'logged_in'; data: NavData }
  | { kind: 'expired' };

interface AuthEnvelope<T> {
  code: number;
  message: string;
  data: T | null;
}

interface QrPollData {
  code: number;
  url: string;
}

interface QrGenerateData {
  url: string;
  qrcode_key: string;
}

/** `BiliAttempt::native(cookie)`: every auth request gets its own native attempt. */
export type NativeAttempt = (cookie: string | null) => Pick<BiliAttempt, 'execute'>;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `serde_json::from_slice::<Envelope<T>>`; any failure is the same fixed message. */
function parseEnvelope<T>(body: Uint8Array): AuthEnvelope<T> {
  let value: unknown;
  try { value = JSON.parse(STRICT_UTF8.decode(body)); }
  catch { throw new Error('B 站账号响应格式无效'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('B 站账号响应格式无效');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'number') throw new Error('B 站账号响应格式无效');
  return {
    code: record.code,
    message: typeof record.message === 'string' ? record.message : '',
    data: record.data === undefined || record.data === null
      ? null : record.data as T,
  };
}

/** QR 登录用的 passport/API 客户端（不做设置存储与二维码渲染）。 */
export class AuthClient {
  readonly passportBase: string;
  readonly apiBase: string;
  private readonly attempt: NativeAttempt;

  constructor(passportBase: string, apiBase: string, attempt: NativeAttempt) {
    this.passportBase = passportBase.replace(/\/+$/, '');
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.attempt = attempt;
  }

  /**
   * `AuthClient::send`: transport errors keep only their Display; anything but 200 is refused.
   * `execute` defaults to the 15 s request deadline and the `API_LIMIT` body cap, as `BiliRequest::get` does.
   */
  private async send(
    request: Partial<BiliRequest> & Pick<BiliRequest, 'kind' | 'url'>,
    cookie: string | null,
  ): Promise<BiliResponse> {
    let response: BiliResponse;
    try { response = await this.attempt(cookie).execute(request); }
    catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
    if (response.status !== 200) throw new Error(`B 站账号接口返回 HTTP ${response.status}`);
    return response;
  }

  /** `AuthClient::qr_generate`：返回扫码地址与 `qrcode_key`。 */
  async qrGenerate(): Promise<{ qrcodeKey: string; url: string }> {
    const url = new URL(`${this.passportBase}/x/passport-login/web/qrcode/generate?source=main-fe-header`);
    const response = await this.send({ kind: 'passport', url }, null);
    const body = parseEnvelope<QrGenerateData>(response.body);
    if (body.code !== 0 || body.data === null || !isValidQrcodeKey(body.data.qrcode_key)) {
      throw new Error(`获取登录二维码失败（${body.code}：${body.message}）`);
    }
    return { qrcodeKey: body.data.qrcode_key, url: body.data.url };
  }

  /** 查询扫码状态；成功后返回会话 Cookie（`SESSDATA=…; bili_jct=…`）。 */
  async qrPoll(key: string): Promise<{ state: string; cookie: string | null }> {
    const url = new URL(`${this.passportBase}/x/passport-login/web/qrcode/poll`);
    url.searchParams.append('qrcode_key', key);
    const response = await this.send({ kind: 'passport', url }, null);
    const body = parseEnvelope<QrPollData>(response.body);
    if (body.code !== 0 || body.data === null) {
      throw new Error(`查询扫码状态失败（${body.code}：${body.message}）`);
    }
    const state = pollState(body.data.code);
    if (state === null) {
      throw new Error(`B 站返回了未知的扫码状态 ${body.data.code}`);
    }
    if (state !== 'success') return { state, cookie: null };
    const cookie = sessionCookieFromSetCookie(response.setCookies)
      ?? sessionCookieFromUrl(body.data.url);
    if (cookie === null) {
      throw new Error('B 站确认了登录，但没有返回会话信息，请重试');
    }
    return { state, cookie };
  }

  /** 校验会话；`-101` 或 `isLogin=false` 判定为已失效。 */
  async nav(cookie: string): Promise<NavResult> {
    const url = new URL(`${this.apiBase}/x/web-interface/nav`);
    const response = await this.send({ kind: 'api', url }, cookie);
    const body = parseEnvelope<Record<string, unknown>>(response.body);
    if (body.code === 0) {
      const data = body.data ?? {};
      const nav: NavData = {
        isLogin: data.isLogin === true,
        mid: typeof data.mid === 'number' ? data.mid : null,
        uname: typeof data.uname === 'string' ? data.uname : null,
        face: typeof data.face === 'string' ? data.face : null,
        vipStatus: typeof data.vipStatus === 'number' ? data.vipStatus : 0,
      };
      return nav.isLogin ? { kind: 'logged_in', data: nav } : { kind: 'expired' };
    }
    if (body.code === -101) return { kind: 'expired' };
    throw new Error(`查询 B 站账号失败（${body.code}：${body.message}）`);
  }

  /** `AuthClient::exit`：尽力让服务端会话失效；所有失败都被忽略。 */
  async exit(cookie: string): Promise<void> {
    const csrf = cookieValue(cookie, 'bili_jct');
    if (csrf === null) return;
    try {
      await this.send({
        kind: 'passport',
        url: new URL(`${this.passportBase}/login/exit/v2`),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: encodeUtf8(new URLSearchParams({ biliCSRF: csrf }).toString()),
      }, cookie);
    } catch {
      // Rust `exit` 只记录 info 日志；网络失败或非 200 都不改变 logout 的结果。
      return;
    }
  }
}
