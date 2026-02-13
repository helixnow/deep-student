import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { v4 as uuidv4 } from 'uuid';

type FrontendTestResult = { success: boolean; tools_count?: number; tools?: Array<{ name: string; description?: string }>; error?: string; trace_id?: string };

function isTauriEnv(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

function isStreamChannelCompatError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return lowered.includes('fetch_read_body') && lowered.includes('streamchannel');
}

let _tauriFetchPromise: Promise<typeof fetch | undefined> | null = null;
async function getTauriFetch(): Promise<typeof fetch | undefined> {
  if (!isTauriEnv()) return undefined;
  if (_tauriFetchPromise) return _tauriFetchPromise;
  _tauriFetchPromise = (async () => {
    try {
      const mod = await import('@tauri-apps/plugin-http');
      const tauriFetch = (mod as any).fetch as typeof fetch;
      const fallbackFetch = fetch;
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await tauriFetch(input, init);
        } catch (error: unknown) {
          if (isStreamChannelCompatError(error)) {
            return await fallbackFetch(input, init);
          }
          throw error;
        }
      }) as typeof fetch;
    } catch {
      return undefined;
    }
  })();
  return _tauriFetchPromise;
}

function buildHeaders(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  if (apiKey && !headers['Authorization']) headers['Authorization'] = `Bearer ${apiKey}`;
  if (apiKey && !headers['X-API-Key']) headers['X-API-Key'] = String(apiKey);
  return headers;
}

function redactUrl(urlStr: string): string {
  try { const u = new URL(urlStr); u.search = ''; return u.toString(); } catch { return urlStr; }
}

function mapUrlForTransport(raw: string, transport: 'sse' | 'streamable_http' | 'websocket', headers: Record<string, string>): string {
  try {
    const u = new URL(raw);
    // auto path fix
    if (transport === 'sse') {
      if (u.pathname.endsWith('/mcp')) u.pathname = u.pathname.replace(/\/mcp$/, '/sse');
      else if (!u.pathname.endsWith('/sse') && /\/[a-f0-9]{10,}$/i.test(u.pathname)) u.pathname = `${u.pathname}/sse`;
    } else if (transport === 'streamable_http') {
      if (!u.pathname.endsWith('/mcp')) {
        if (u.pathname.endsWith('/sse')) u.pathname = u.pathname.replace(/\/sse$/, '/mcp');
        else if (/\/[a-f0-9]{10,}$/i.test(u.pathname)) u.pathname = `${u.pathname}/mcp`;
      }
    } else if (transport === 'websocket') {
      if (u.pathname.endsWith('/sse')) u.pathname = u.pathname.replace(/\/sse$/, '/ws');
    }

    // attach api_key to query if applicable (e.g. ModelScope)
    if ((u.hostname.endsWith('modelscope.net') || u.hostname.includes('api-inference')) && !u.searchParams.has('api_key')) {
      const key = headers['X-API-Key'] || (headers['Authorization']?.replace(/^Bearer\s+/i, ''));
      if (key) u.searchParams.set('api_key', key);
    }

    // Dev proxy to bypass CORS
    if ((import.meta as any)?.env?.DEV && !isTauriEnv() && (u.hostname === 'mcp.api-inference.modelscope.net' || u.hostname.includes('modelscope'))) {
      if (transport === 'sse') {
        return new URL('/sse-proxy' + u.pathname + u.search, window.location.origin).toString();
      }
      if (transport === 'websocket') {
        const wsUrl = new URL('/ws-proxy' + u.pathname + u.search, window.location.origin);
        wsUrl.protocol = 'ws:';
        return wsUrl.toString();
      }
      // streamable_http
      return new URL('/http-proxy' + u.pathname + u.search, window.location.origin).toString();
    }
    return u.toString();
  } catch {
    return raw;
  }
}

async function runClient(transport: any): Promise<FrontendTestResult> {
  const client = new Client({ name: 'dstu-frontend-mcp-test', version: '1.0.0' });
  const trace_id = uuidv4();
  try {
    await client.connect(transport);
    const list = await client.listTools();
    const tools = (list.tools || []).map((t: any) => ({ name: t.name, description: t.description }));
    try { await client.close(); } catch { /* noop */ }
    return { success: true, tools_count: tools.length, tools, trace_id };
  } catch (e: any) {
    try { await client.close(); } catch { /* noop */ }
    return { success: false, error: e?.message || String(e), trace_id };
  }
}

export async function testMcpSseFrontend(endpoint: string, apiKey?: string, headersInput?: Record<string, string>): Promise<FrontendTestResult> {
  const headers = buildHeaders(apiKey, headersInput);
  const mapped = mapUrlForTransport(endpoint, 'sse', headers);
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
  const tauriFetch = await getTauriFetch();
  const transportOptions: any = {
    ...(requestInit ? { requestInit } : {}),
    ...(tauriFetch ? { fetch: tauriFetch, eventSourceInit: { fetch: tauriFetch } } : {}),
  };
  const transport = new SSEClientTransport(new URL(mapped), Object.keys(transportOptions).length > 0 ? transportOptions : undefined);
  return await runClient(transport);
}

export async function testMcpHttpFrontend(endpoint: string, apiKey?: string, headersInput?: Record<string, string>): Promise<FrontendTestResult> {
  const headers = buildHeaders(apiKey, headersInput);
  const mapped = mapUrlForTransport(endpoint, 'streamable_http', headers);
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
  const tauriFetch = await getTauriFetch();
  const transportOptions: any = {
    ...(requestInit ? { requestInit } : {}),
    ...(tauriFetch ? { fetch: tauriFetch } : {}),
  };
  const transport = new StreamableHTTPClientTransport(new URL(mapped), Object.keys(transportOptions).length > 0 ? transportOptions : undefined);
  return await runClient(transport);
}

export async function testMcpWebsocketFrontend(url: string, apiKey?: string, headersInput?: Record<string, string>): Promise<FrontendTestResult> {
  const headers = buildHeaders(apiKey, headersInput);
  const mapped = mapUrlForTransport(url, 'websocket', headers);
  // Note: WebSocketClientTransport only accepts URL, headers not supported by SDK
  const transport = new WebSocketClientTransport(new URL(mapped));
  return await runClient(transport);
}
