/**
 * Access-token authentication, HttpOnly session cookie exchange, and Same-Origin CSRF check for WebUI.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_COOKIE_NAME = 'ds_web_session';

export interface WebAuthConfig {
  /** Required token; `null` disables token auth (`DS_WEB_NO_AUTH=1`). */
  token: string | null;
}

export function createWebAuth(options: { token?: string | null; disableAuth?: boolean } = {}): WebAuthConfig {
  if (options.disableAuth) {
    return { token: null };
  }
  const configured = options.token?.trim();
  if (configured && configured.length > 0) {
    return { token: configured };
  }
  return { token: randomBytes(24).toString('hex') };
}

/**
 * 定长常量时间比较：先各自哈希成 32 字节再比。
 *
 * 直接比较原文时 `timingSafeEqual` 会按长度提前返回，令牌字节长度就从耗时里泄露出去了；
 * 哈希后两侧长度恒为 32，比较不会因为原文字节长度不同而提前返回（哈希本身仍需读取输入）。
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a, 'utf8').digest();
  const hashB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(hashA, hashB);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch (error) {
      void error;
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1]!.trim() : null;
}

export function isRequestAuthenticated(req: IncomingMessage, url: URL, auth: WebAuthConfig): {
  authenticated: boolean;
  viaQueryToken: boolean;
} {
  if (auth.token === null) {
    return { authenticated: true, viaQueryToken: false };
  }
  const queryToken = url.searchParams.get('token');
  if (queryToken && constantTimeEquals(queryToken, auth.token)) {
    return { authenticated: true, viaQueryToken: true };
  }
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer && constantTimeEquals(bearer, auth.token)) {
    return { authenticated: true, viaQueryToken: false };
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken && constantTimeEquals(cookieToken, auth.token)) {
    return { authenticated: true, viaQueryToken: false };
  }
  return { authenticated: false, viaQueryToken: false };
}

export function setSessionCookie(res: ServerResponse, token: string, isSecure = false): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=2592000',
  ];
  if (isSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 是否值得信任请求里由代理写入的头（`X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Forwarded-For`）。
 *
 * 只在两种情况下信任：显式开启（`DS_WEB_TRUST_PROXY=1` 或调用方传入 `trustProxy`），
 * 或请求本身就来自本机回环（Nginx / Caddy 反代到 `127.0.0.1:1428` 的典型部署）。
 * 公网直连的请求携带这些头一律无视，避免客户端伪造 `X-Forwarded-Proto: https` 之类。
 */
export function isTrustedProxyRequest(req: IncomingMessage, trustProxy = false): boolean {
  if (trustProxy || process.env.DS_WEB_TRUST_PROXY === '1') return true;
  const remote = req.socket?.remoteAddress ?? '';
  return LOOPBACK_REMOTE_ADDRESSES.has(remote);
}

/**
 * 反代场景下 `Host` 是 `127.0.0.1:1428`，浏览器 `Origin` 却是 `https://study.example.com`：
 * 只比 `Host` 会把所有登录/上传都判成跨站。来自受信代理时再接受 `X-Forwarded-Host` 的第一个值。
 */
export function isSameOriginRequest(req: IncomingMessage, options: { trustProxy?: boolean } = {}): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch (error) {
    void error;
    return false;
  }
  const trusted = isTrustedProxyRequest(req, options.trustProxy);
  const forwardedProto = trusted ? req.headers['x-forwarded-proto'] : undefined;
  const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = (req.socket as { encrypted?: boolean }).encrypted === true ||
    rawProto?.split(',')[0]?.trim().toLowerCase() === 'https' ? 'https:' : 'http:';
  if (parsedOrigin.protocol !== protocol) return false;
  const originHost = parsedOrigin.host.toLowerCase();
  const matchesHost = (value: string): boolean => {
    try {
      return new URL(`${protocol}//${value}`).host.toLowerCase() === originHost;
    } catch {
      return false;
    }
  };
  const host = req.headers.host;
  if (typeof host === 'string' && matchesHost(host)) return true;
  if (!trusted) return false;
  const forwardedHost = req.headers['x-forwarded-host'];
  const rawForwarded = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const firstForwarded = rawForwarded?.split(',')[0]?.trim().toLowerCase();
  return firstForwarded !== undefined && firstForwarded !== '' && matchesHost(firstForwarded);
}

/** 限流用的客户端标识：只有受信代理给出的 `X-Forwarded-For` 才采信，否则一律用 socket 地址。 */
export function clientAddressForRequest(req: IncomingMessage, options: { trustProxy?: boolean } = {}): string {
  if (isTrustedProxyRequest(req, options.trustProxy)) {
    const forwardedFor = req.headers['x-forwarded-for'];
    const rawForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstForwarded = rawForwarded?.split(',')[0]?.trim();
    if (firstForwarded) return firstForwarded;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export interface AuthRateLimitStatus {
  blocked: boolean;
  /** `Retry-After` 秒数（未封禁时为 0）。 */
  retryAfterSec: number;
}

/**
 * 令牌爆破限流：滑动窗口内失败次数达到上限后封禁该客户端，直到最早一次失败滑出窗口。
 *
 * 内存有界（默认最多 2048 个客户端 key，每个 key 最多 maxFailures 个时间戳）。
 * 成功认证后由调用方 reset 清除该客户端的失败记录。
 */
export class AuthRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: { maxFailures?: number; windowMs?: number; maxKeys?: number } = {}) {
    this.maxFailures = Math.max(1, options.maxFailures ?? 10);
    this.windowMs = Math.max(1, options.windowMs ?? 60_000);
    this.maxKeys = Math.max(1, options.maxKeys ?? 2048);
  }

  isBlocked(client: string): AuthRateLimitStatus {
    const entry = this.failures.get(client);
    if (!entry) return { blocked: false, retryAfterSec: 0 };
    const now = Date.now();
    while (entry.length > 0 && now - entry[0]! >= this.windowMs) entry.shift();
    if (entry.length === 0) {
      this.failures.delete(client);
      return { blocked: false, retryAfterSec: 0 };
    }
    if (entry.length < this.maxFailures) return { blocked: false, retryAfterSec: 0 };
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((entry[0]! + this.windowMs - now) / 1000)) };
  }

  recordFailure(client: string): void {
    const now = Date.now();
    this.isBlocked(client);
    const entry = this.failures.get(client);
    if (!entry) {
      this.evictIfNeeded();
      this.failures.set(client, [now]);
      return;
    }
    if (entry.length < this.maxFailures) entry.push(now);
  }

  reset(client: string): void {
    this.failures.delete(client);
  }

  private evictIfNeeded(): void {
    while (this.failures.size >= this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) return;
      this.failures.delete(oldest);
    }
  }
}
