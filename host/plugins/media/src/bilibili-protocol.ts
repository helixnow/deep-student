/**
 * `dstu-media/src/media/bilibili_stream.rs::handle` + `handle_inner` for the
 * Host-side `bilistream` protocol.
 *
 * `main` forwards `bilistream://localhost/{fileId}` here (Windows uses
 * `http://bilistream.localhost/...` and rewrites it).  The handler keeps the
 * Rust Range semantics: 64 KiB for the first chunk, 512 KiB afterwards,
 * one stale-URL refresh, CORS for the WebView origins, and the exact error
 * messages/status codes.
 */
import type { ProtocolReply, ProtocolRequestInfo } from '../../../kernel/api.ts';
import {
  INITIAL_CHUNK_BYTES, STREAM_CHUNK_BYTES, PROTOCOL_TIMEOUT_MS,
  attemptCacheKey, fetchCandidates, parseContentRange,
  parseStreamPath, parseStreamQuery, queryU32, upstreamRange,
  type BiliAttemptLike, type PlayInfo, type Representation,
} from './bilibili-stream.ts';

const DEFAULT_CORS_ORIGIN = 'tauri://localhost';
const PROTOCOL_DEADLINE_MS = PROTOCOL_TIMEOUT_MS;

function isAllowedOrigin(origin: string): boolean {
  return origin === 'tauri://localhost'
    || origin === 'http://tauri.localhost'
    || origin === 'https://tauri.localhost'
    || origin === 'http://localhost'
    || origin === 'https://localhost'
    || origin.startsWith('http://localhost:')
    || origin.startsWith('https://localhost:')
    || origin === 'http://127.0.0.1'
    || origin === 'https://127.0.0.1'
    || origin.startsWith('http://127.0.0.1:')
    || origin.startsWith('https://127.0.0.1:');
}

function header(request: ProtocolRequestInfo, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function corsOrigin(request: ProtocolRequestInfo): string {
  const origin = header(request, 'origin');
  return origin !== null && isAllowedOrigin(origin) ? origin : DEFAULT_CORS_ORIGIN;
}

function response(
  request: ProtocolRequestInfo,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
): ProtocolReply {
  return {
    status,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin(request),
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body,
  };
}

const encoder = new TextEncoder();

function textError(request: ProtocolRequestInfo, status: number, message: string): ProtocolReply {
  return response(request, status, { 'Content-Type': 'text/plain; charset=utf-8' }, encoder.encode(message));
}

function parsePath(url: string): string | null {
  try { return new URL(url).pathname; }
  catch { return null; }
}

function parseQuery(url: string): string {
  try { return new URL(url).search.replace(/^\?/, ''); }
  catch { return ''; }
}

/** Rust `suffix.parse::<u64>().ok().filter(|n| *n > 0)`. */
function positiveU64(raw: string): number | null {
  if (!/^\+?[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export interface BiliProtocolErrorPayload {
  fileId: string;
  qn: number;
  epoch: number;
  attempt: number;
  message: string;
}

/**
 * Everything the protocol needs from L18's playback owner.  `session` reuses the
 * same `(file, qn, epoch, attempt)` attempt as `media_bilibili_stream_quality`;
 * `playInfo` is `playInfoFor` bound to the VFS database and link repositories.
 */
export interface BiliStreamProtocolOperations {
  session(key: string): Promise<BiliAttemptLike>;
  playInfo(
    fileId: string,
    qn: number,
    epoch: number,
    attempt: number,
    fresh: boolean,
  ): Promise<PlayInfo>;
  remember(key: string, info: PlayInfo): void;
  emitError(payload: BiliProtocolErrorPayload): void;
  /** Test override; production uses the Rust 24 s protocol deadline. */
  timeoutMs?: number;
}

const gates = new Map<string, Promise<void>>();
const representations = new Map<string, Representation>();

/** Test hook: clear the per-session gate/representation tables. */
export function resetBiliStreamProtocolState(): void {
  gates.clear();
  representations.clear();
}

async function withGate<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const chained = previous.then(() => gate);
  gates.set(key, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (gates.get(key) === chained) gates.delete(key);
  }
}

async function handleInner(
  request: ProtocolRequestInfo,
  operations: BiliStreamProtocolOperations,
  deadlineMs: number,
): Promise<ProtocolReply> {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return response(request, 204, {}, new Uint8Array(0));
  if (method !== 'GET' && method !== 'HEAD') {
    return textError(request, 405, 'Method Not Allowed');
  }

  const path = parsePath(request.url);
  const fileId = path === null ? null : parseStreamPath(path);
  if (fileId === null) return textError(request, 400, '无效的 B 站播放地址');

  const query = parseQuery(request.url);
  const [qn, epoch] = parseStreamQuery(query);
  const attempt = queryU32(query, 'a') ?? 0;
  const sessionKey = attemptCacheKey(fileId, qn, epoch, attempt);

  let session: BiliAttemptLike;
  try {
    session = await operations.session(sessionKey);
  } catch (error) {
    return textError(request, 502, error instanceof Error ? error.message : String(error));
  }

  return await withGate(sessionKey, async () => {
    const rangeHeader = header(request, 'range');
    let range: [number, number] | null;
    if (rangeHeader !== null && rangeHeader.startsWith('bytes=-')) {
      // Rust resolves a suffix only from a known total size; otherwise 416.
      let size: number | null = null;
      try { size = (await operations.playInfo(fileId, qn, epoch, attempt, false)).size; }
      catch { size = null; }
      const suffix = positiveU64(rangeHeader.slice('bytes=-'.length));
      if (suffix !== null && size !== null && size > 0) {
        const length = Math.min(suffix, size, STREAM_CHUNK_BYTES);
        range = [size - length, size - 1];
      } else {
        range = null;
      }
    } else {
      range = upstreamRange(rangeHeader);
    }
    if (range === null) return textError(request, 416, 'Range Not Satisfiable');

    let [start, end] = range;
    if (method === 'HEAD') end = start;
    else if (start === 0) end = Math.min(end, INITIAL_CHUNK_BYTES - 1);

    let fresh = false;
    let originalQuality: number | null = null;
    const representation = representations.get(sessionKey) ?? null;

    for (let pass = 0; pass < 2; pass += 1) {
      let info: PlayInfo;
      try {
        info = await operations.playInfo(fileId, qn, epoch, attempt, fresh);
      } catch (error) {
        return textError(request, 502, error instanceof Error ? error.message : String(error));
      }
      if (fresh && originalQuality !== null && originalQuality !== info.quality) {
        return textError(request, 502, '视频清晰度已改变，请重新开始播放');
      }
      originalQuality = info.quality;

      const [upstream, successfulUrl] = await fetchCandidates(
        session, info, start, end, deadlineMs, representation);
      if (successfulUrl !== null && successfulUrl !== info.url) {
        const previous = info.url;
        info.url = successfulUrl;
        info.backup_urls = info.backup_urls.filter(url => url !== successfulUrl);
        info.backup_urls.push(previous);
        operations.remember(sessionKey, info);
      }

      switch (upstream.kind) {
        case 'ok': {
          const parsed = upstream.contentRange === null
            ? null : parseContentRange(upstream.contentRange);
          if (parsed !== null && !representations.has(sessionKey)) {
            representations.set(sessionKey, {
              url: info.url,
              etag: upstream.etag,
              total: parsed[2],
            });
          }
          const contentType = upstream.contentType !== null
            && (upstream.contentType.startsWith('video/')
              || upstream.contentType.startsWith('audio/'))
            ? upstream.contentType
            : 'video/mp4';
          const headers: Record<string, string> = {
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType,
          };
          if (method === 'HEAD') {
            const total = parsed === null ? upstream.body.length : parsed[2];
            headers['Content-Length'] = String(total);
            return response(request, 200, headers, new Uint8Array(0));
          }
          if (upstream.contentRange !== null) headers['Content-Range'] = upstream.contentRange;
          headers['Content-Length'] = String(upstream.body.length);
          return response(request, upstream.status, headers, upstream.body);
        }
        case 'stale':
          if (!fresh) { fresh = true; break; }
          return textError(request, 502,
            `B 站视频服务器拒绝了请求（HTTP ${upstream.status}）`);
        case 'failed':
          return textError(request, 502, upstream.message);
        case 'unsatisfiable':
          return response(request, 416, { 'Content-Range': upstream.range }, new Uint8Array(0));
      }
    }
    return textError(request, 502, 'B 站视频暂时无法播放');
  });
}

/**
 * Register outside the command layer, mirroring
 * `register_asynchronous_uri_scheme_protocol("bilistream", ...)`.
 */
export function createBiliStreamProtocolHandler(
  operations: BiliStreamProtocolOperations,
): (request: ProtocolRequestInfo) => Promise<ProtocolReply> {
  return async request => {
    const started = Date.now();
    const timeoutMs = operations.timeoutMs ?? PROTOCOL_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: ProtocolReply;
    try {
      const timeout = new Promise<ProtocolReply>(resolve => {
        timer = setTimeout(() => resolve(textError(request, 504, '视频加载超时，请重试或在 B 站打开')), timeoutMs);
      });
      result = await Promise.race([
        handleInner(request, operations, started + timeoutMs)
          .catch(error => textError(request, 502,
            error instanceof Error ? error.message : String(error))),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (result.status >= 500) {
      const path = parsePath(request.url);
      const query = parseQuery(request.url);
      const [qn, epoch] = parseStreamQuery(query);
      const payload: BiliProtocolErrorPayload = {
        fileId: path === null ? '' : parseStreamPath(path) ?? '',
        qn,
        epoch,
        attempt: queryU32(query, 'a') ?? 0,
        message: new TextDecoder().decode(
          result.body instanceof Uint8Array ? result.body : new Uint8Array(0)),
      };
      try { operations.emitError(payload); }
      catch { /* boundary-allow empty-catch: error reporting must not change the protocol response */ }
    }
    return result;
  };
}
