/**
 * 移动端 `plugin:http|*` 处理（对应 `@tauri-apps/plugin-http` 的 5 个 IPC 命令：`fetch`、
 * `fetch_send`、`fetch_read_body`、`fetch_cancel`、`fetch_cancel_body`）。
 *
 * 将请求委托给主线程注入的 {@link MobileHttpFetcher}（生产环境为 `shellHttpFetch`，优先走
 * `CapacitorHttp` 绕过 WebView CORS，二进制/FormData/Web 形态回退到 `fetchWithTimeout`），
 * 使 `endpointProber` / `vendorModelService` / `deepSeekBalance` / `mcpService` 等不再触发 Host ACL 错误。
 */
import { fetchWithTimeout } from './http-fetch.ts';
import { optRecord, parseJsonArgs, reqNumber, type MobilePluginHandler } from './plugin-args.ts';

export interface MobileHttpFetchRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly timeoutMs?: number | null;
  readonly redirect?: 'follow' | 'manual' | 'error';
  readonly signal?: AbortSignal;
}

export interface MobileHttpFetchResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

export type MobileHttpFetcher = (request: MobileHttpFetchRequest) => Promise<MobileHttpFetchResponse>;

const BODY_CHUNK_BYTES = 256 * 1024;

interface PendingRequest {
  readonly controller: AbortController;
  readonly url: string;
  sent: boolean;
  readonly run: (signal: AbortSignal) => Promise<MobileHttpFetchResponse>;
}

interface PendingResponse {
  readonly body: Uint8Array;
  offset: number;
  closed: boolean;
}

function isTextContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes('json') ||
    lower.startsWith('text/') ||
    lower.includes('application/x-www-form-urlencoded') ||
    lower.includes('xml') ||
    lower.includes('javascript')
  );
}

function decodeDataUrl(url: string): MobileHttpFetchResponse {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(url);
  if (!match) throw new Error('failed to process data url');
  const mime = (match[1] ?? '') === '' ? 'text/plain;charset=US-ASCII' : match[1]!;
  const payload = match[3] ?? '';
  let body: Uint8Array;
  if (match[2]) {
    const binary = atob(decodeURIComponent(payload));
    body = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) body[i] = binary.charCodeAt(i);
  } else {
    body = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return {
    url,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': mime },
    body,
  };
}

export async function defaultWebHttpFetcher(request: MobileHttpFetchRequest): Promise<MobileHttpFetchResponse> {
  const response = await fetchWithTimeout(
    request.url,
    {
      method: request.method ?? 'GET',
      headers: request.headers,
      ...(request.body === undefined || request.body === null ? {} : { body: request.body as BodyInit }),
      ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
      ...(request.signal ? { signal: request.signal } : {}),
    },
    request.timeoutMs,
  );
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { responseHeaders[name] = value; });
  return {
    url: response.url || request.url,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/** 创建供 `MobileShell` 使用的 `plugin:http|*` 处理器。 */
export function createMobileHttpHandler(fetcher: MobileHttpFetcher = defaultWebHttpFetcher): MobilePluginHandler {
  let nextRid = 1;
  const requests = new Map<number, PendingRequest>();
  const responses = new Map<number, PendingResponse>();

  return async ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'http');

    switch (command) {
      case 'fetch': {
        const config = optRecord(args, 'clientConfig');
        if (!config) throw new Error('invalid args `clientConfig` for command `fetch`');
        const method = typeof config.method === 'string' ? config.method.trim() : '';
        const rawUrl = typeof config.url === 'string' ? config.url : '';
        if (!method) throw new Error('missing field `method` in `clientConfig`');
        if (!rawUrl) throw new Error('missing field `url` in `clientConfig`');

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          throw new Error(`invalid URL: ${rawUrl}`);
        }
        const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
        if (scheme !== 'http' && scheme !== 'https' && scheme !== 'data') {
          throw new Error(`scheme ${scheme} not supported`);
        }

        const headers: Record<string, string> = {};
        let contentType = '';
        if (Array.isArray(config.headers)) {
          for (const entry of config.headers) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const key = String(entry[0]);
            const value = String(entry[1]);
            headers[key] = value;
            if (key.toLowerCase() === 'content-type') contentType = value;
          }
        }

        let body: string | Uint8Array | undefined;
        if (Array.isArray(config.data)) {
          const bytes = Uint8Array.from(config.data as number[]);
          if (isTextContentType(contentType)) {
            try {
              body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              body = bytes;
            }
          } else {
            body = bytes;
          }
        }

        const timeoutMs = typeof config.connectTimeout === 'number' && Number.isFinite(config.connectTimeout)
          ? config.connectTimeout
          : undefined;
        const redirect = config.maxRedirections === 0 ? 'manual' as const : undefined;

        const rid = nextRid++;
        const controller = new AbortController();
        requests.set(rid, {
          controller,
          url: parsedUrl.href,
          sent: false,
          run: scheme === 'data'
            ? async () => decodeDataUrl(parsedUrl.href)
            : signal => fetcher({
                url: parsedUrl.href,
                method,
                headers,
                ...(body === undefined ? {} : { body }),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                ...(redirect === undefined ? {} : { redirect }),
                signal,
              }),
        });
        return rid;
      }

      case 'fetch_cancel': {
        const rid = reqNumber(args, 'rid', command);
        const req = requests.get(rid);
        if (req) {
          req.controller.abort();
          requests.delete(rid);
        }
        return null;
      }

      case 'fetch_send': {
        const rid = reqNumber(args, 'rid', command);
        const req = requests.get(rid);
        if (!req) throw new Error(`invalid request resource id: ${rid}`);
        if (req.sent || req.controller.signal.aborted) {
          requests.delete(rid);
          throw new Error('Request cancelled');
        }
        req.sent = true;
        let response: MobileHttpFetchResponse;
        try {
          response = await req.run(req.controller.signal);
        } catch (error) {
          requests.delete(rid);
          if (req.controller.signal.aborted) throw new Error('Request cancelled');
          throw error instanceof Error ? error : new Error(`error sending request for url (${req.url})`);
        }
        requests.delete(rid);
        if (req.controller.signal.aborted) {
          throw new Error('Request cancelled');
        }
        const responseRid = nextRid++;
        responses.set(responseRid, { body: response.body, offset: 0, closed: false });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Object.entries(response.headers),
          url: response.url || req.url,
          rid: responseRid,
        };
      }

      case 'fetch_read_body': {
        const rid = reqNumber(args, 'rid', command);
        const res = responses.get(rid);
        if (!res || res.closed) throw new Error(`invalid response resource id: ${rid}`);
        if (res.offset >= res.body.byteLength) {
          res.closed = true;
          responses.delete(rid);
          return Uint8Array.of(1);
        }
        const end = Math.min(res.offset + BODY_CHUNK_BYTES, res.body.byteLength);
        const chunk = res.body.subarray(res.offset, end);
        res.offset = end;
        const out = new Uint8Array(chunk.byteLength + 1);
        out.set(chunk, 0);
        out[chunk.byteLength] = 0;
        return out;
      }

      case 'fetch_cancel_body': {
        const rid = reqNumber(args, 'rid', command);
        const res = responses.get(rid);
        if (res) {
          res.closed = true;
          responses.delete(rid);
        }
        return null;
      }

      default:
        throw new Error(`unsupported http command "${command}"`);
    }
  };
}
