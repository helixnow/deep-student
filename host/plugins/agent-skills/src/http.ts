/**
 * HTTPS binary download with the same SSRF / size policy as
 * `FetchExecutor::download_https_bytes` (fetch_executor.rs:653–707) and its
 * redirect policy (fetch_executor.rs:574–653).
 *
 * Every hop goes through `ctx.http` with `destination: 'public-pinned'`: the transport resolves the host, checks every
 * answer and connects only to the checked address, without a proxy (Rust's client is `no_proxy` too). Redirects are
 * followed here, one pinned request per hop, so each hop gets the Rust redirect policy.
 *
 * Error text follows the Rust `format!` strings verbatim, including the
 * distinction between DNS failure, an empty DNS answer and a blocked internal
 * address. The HTTP status reason is the canonical one (`404 Not Found`), not
 * `Response.statusText`, which is empty for HTTP/2.
 */
import { HttpError, type HttpRequestInit, type HttpService } from '../../../platform/http/api.ts';
import { isLoopbackIp, parseIp } from '../../../platform/net-policy/index.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../../../platform/storage/errors.ts';
import { statusLine } from '../../../platform/util/index.ts';

export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 10;
const USER_AGENT = 'DeepStudent/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)';
const REQUEST_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
/** reqwest consults the redirect policy for these statuses only; any other 3xx is the final response. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `ctx.http` for a skill download; hosts without it cannot download skill packages. */
export function skillDownloadHttp(http: () => HttpService | null): HttpService {
  const service = http();
  if (service === null) {
    throw new Error(`${UNSUPPORTED_ON_PLATFORM_PREFIX}skill downloads need the ctx.http service, which this host does not provide`);
  }
  return service;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** fetch reports network failures as `TypeError('fetch failed')` / `TypeError('terminated')`; the socket or TLS error is the cause. */
function transportErrorText(error: unknown): string {
  return error instanceof TypeError && error.cause instanceof Error ? error.cause.message : errorMessage(error);
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/** The URL names this machine itself: a loopback literal (after WHATWG host parsing) or localhost / *.localhost. */
function namesLoopback(url: URL): boolean {
  const host = bareHost(url.hostname).toLowerCase();
  if (parseIp(host) !== null) return isLoopbackIp(host);
  return host === 'localhost' || host.endsWith('.localhost');
}

/** The Rust messages for a target refused before connecting (fetch_executor.rs:664-680). */
function refusedTarget(error: unknown): Error | null {
  if (!(error instanceof HttpError)) return null;
  if (error.kind === 'UnsupportedOnPlatform') return new Error(error.message);
  if (error.kind !== 'BlockedDestination') return null;
  return new Error(error.reason === 'blocked-address' ? 'Blocked: URL resolves to internal IP address' : error.message);
}

function statusError(url: string, status: number): Error {
  return new Error(`Download failed with HTTP ${statusLine(status)} for '${url}'`);
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * `http` is `ctx.http`. Each hop connects only to the address that passed the SSRF check, closing the
 * DNS-rebinding window between validation and connect that a resolving client would leave open.
 */
export async function downloadHttpsBytes(
  url: string,
  maxBytes: number,
  http: HttpService,
): Promise<Uint8Array> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch (error) { throw new Error(`Invalid URL '${url}': ${errorMessage(error)}`); }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only https:// URLs are supported for binary download, got: ${parsed.protocol.replace(':', '')}`);
  }
  if (!bareHost(parsed.hostname)) throw new Error('Invalid URL: no host');

  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const timedOut = `operation timed out after ${DOWNLOAD_TIMEOUT_MS}ms`;
  const failed = (error: unknown): Error =>
    new Error(`Failed to download URL '${url}': ${signal.aborted ? timedOut : transportErrorText(error)}`);
  // RUST-FIX(RF-W02-skill-download-dns-pinning): fetch_executor.rs:653-720 validates the DNS answer, then
  // lets reqwest resolve again for the connection.
  // RUST-FIX(RF-S01-skill-download-resolved-loopback-blocked): Rust exempts loopback for any name on every hop, so a
  // public name resolving to 127.0.0.1 (or a redirect into it) reached local services from the approval-free skill_scan
  const allowLoopback = namesLoopback(parsed);
  const init: HttpRequestInit = { destination: 'public-pinned', allowLoopback, redirect: 'manual', headers: REQUEST_HEADERS, signal };

  let response: Response;
  try { response = await http.fetch(parsed, init); }
  catch (error) { throw refusedTarget(error) ?? failed(error); }
  let current = parsed;
  // reqwest's `attempt.previous()` lists the URLs requested so far, the current one included.
  for (let previous = 1; REDIRECT_STATUSES.has(response.status); previous++) {
    discard(response);
    const location = response.headers.get('location');
    if (location === null || previous >= MAX_REDIRECTS) throw statusError(url, response.status);
    let next: URL;
    try { next = new URL(location, current); }
    catch { throw statusError(url, response.status); }
    if (signal.aborted) throw failed(signal.reason);
    try { response = await http.fetch(next, init); }
    catch (error) {
      // The Rust redirect policy calls `attempt.stop()` when the target has no host, does not resolve or is blocked,
      // so the 3xx itself becomes the terminal HTTP error.
      if (error instanceof HttpError && (error.kind === 'BlockedDestination' || error.kind === 'InvalidUrl')) {
        throw statusError(url, response.status);
      }
      throw failed(error);
    }
    current = next;
  }
  if (response.status < 200 || response.status >= 300) {
    discard(response);
    throw statusError(url, response.status);
  }
  return readBody(response, maxBytes, () => signal.aborted ? timedOut : null);
}

/** `collect_download_stream_limited` with the Content-Length precheck of `download_https_bytes`. */
async function readBody(response: Response, maxBytes: number, timedOut: () => string | null): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    discard(response);
    throw new Error(`Download too large (${contentLength} bytes > ${maxBytes} bytes)`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read().catch((error: unknown) => {
          throw new Error(`Failed to read download body: ${timedOut() ?? transportErrorText(error)}`);
        });
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) throw new Error(`Download exceeded size limit (${total} bytes > ${maxBytes} bytes)`);
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
