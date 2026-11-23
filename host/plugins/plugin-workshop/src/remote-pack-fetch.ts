/**
 * Safe HTTPS / GitHub Release `.dspack` & `.dstuplugin` fetcher (RFC-002 P4).
 *
 * Enforces strict SSRF and transport hygiene before handing downloaded bytes to
 * `PluginPackages.install(...)` (which performs full ZIP safety, manifest screening,
 * and K3 user consent):
 *   - Strict `https:` protocol only;
 *   - Rejects loopback, link-local, RFC1918 private IPs, and `localhost`;
 *   - Requires `.dspack` or `.dstuplugin` archive filename;
 *   - Enforces hard byte limit (32 MiB) during streaming read;
 *   - Computes SHA-256 digest for provenance & audit display.
 */
import { createHash } from 'node:crypto';

export const MAX_REMOTE_PACK_BYTES = 32 * 1024 * 1024;
const ALLOWED_ARCHIVE_EXTENSIONS = ['.dspack', '.dstuplugin'] as const;

export interface RemotePackDownloadResult {
  readonly sourceUrl: string;
  readonly archiveName: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface FetchRemotePackOptions {
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  // IPv6 loopback / unique-local / link-local
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  // IPv4 literal checks (loopback, RFC1918, link-local, 0.0.0.0)
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

export function validateRemotePackUrl(rawUrl: string): { url: URL; archiveName: string } {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('REMOTE_PACK_INVALID_URL: URL is not valid');
  }
  if (url.protocol !== 'https:') {
    throw new Error('REMOTE_PACK_HTTPS_REQUIRED: only https:// URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('REMOTE_PACK_CREDENTIALS_FORBIDDEN: embedded URL credentials are not allowed');
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`REMOTE_PACK_HOST_BLOCKED: refusing private or local host "${url.hostname}"`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const last = decodeURIComponent(segments.at(-1) ?? '');
  if (!last || !ALLOWED_ARCHIVE_EXTENSIONS.some(ext => last.toLowerCase().endsWith(ext))) {
    throw new Error('REMOTE_PACK_BAD_EXTENSION: URL must point to a .dspack or .dstuplugin file');
  }
  return { url, archiveName: last };
}

export async function fetchRemotePackArchive(
  rawUrl: string,
  options: FetchRemotePackOptions = {},
): Promise<RemotePackDownloadResult> {
  const { url, archiveName } = validateRemotePackUrl(rawUrl);
  const maxBytes = Math.min(MAX_REMOTE_PACK_BYTES, Math.max(1024, options.maxBytes ?? MAX_REMOTE_PACK_BYTES));
  const timeoutMs = Math.max(1000, Math.min(60_000, options.timeoutMs ?? 20_000));
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('REMOTE_PACK_FETCH_UNAVAILABLE: fetch implementation unavailable');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onOuterAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetchFn(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream, application/zip' },
    });
    if (!response.ok) {
      throw new Error(`REMOTE_PACK_HTTP_ERROR: HTTP ${response.status} ${response.statusText}`);
    }
    if (response.url) {
      // Re-validate final URL after redirects so open redirects cannot pivot to private hosts or http://
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || isBlockedHost(finalUrl.hostname)) {
        throw new Error(`REMOTE_PACK_REDIRECT_BLOCKED: unsafe redirect destination "${finalUrl.origin}"`);
      }
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`REMOTE_PACK_TOO_LARGE: remote archive exceeds ${maxBytes} bytes`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`REMOTE_PACK_TOO_LARGE: remote archive exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } else {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new Error(`REMOTE_PACK_TOO_LARGE: remote archive exceeds ${maxBytes} bytes`);
      }
      chunks.push(buf);
      total = buf.byteLength;
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    return {
      sourceUrl: url.toString(),
      archiveName,
      bytes,
      sha256,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
