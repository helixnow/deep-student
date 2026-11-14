/**
 * `plugin:http|*`（tauri-plugin-http-2.5.7 `src/commands.rs`），以 Node（undici）fetch 在 main 中发请求。
 * 请求/响应都进调用方 webview 的资源表：`fetch` 只登记请求，`fetch_send` 才真正发送并返回响应头，
 * `fetch_read_body` 每次返回一块并在末尾追加 0（还有数据）或只返回 `[1]`（结束）。
 */
import { STATUS_CODES } from 'node:http';
import { scopeString, urlPatternMatches } from '../capabilities.ts';
import { invalidArgs, missingKey, ShellCommandError } from '../errors.ts';
import { raw, reqInteger, type InvokeInput } from '../args.ts';
import type { BuiltinPlugin, CommandContext, Resource } from '../runtime.ts';
import { HttpClient, type HttpClientOptions, type SystemProxy } from '../http-client.ts';

/** `concat!(CARGO_PKG_NAME, "/", CARGO_PKG_VERSION)`。 */
const HTTP_USER_AGENT = 'tauri-plugin-http/2.5.7';

const UNSAFE_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'date',
  'dnt',
  'expect',
  'host',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

function isUnsafeHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return UNSAFE_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-');
}

class RequestResource implements Resource {
  readonly controller = new AbortController();
  readonly run: (signal: AbortSignal) => Promise<Response>;
  readonly url: string;
  sent = false;
  constructor(url: string, run: (signal: AbortSignal) => Promise<Response>) {
    this.url = url;
    this.run = run;
  }
  close(): void {
    this.controller.abort();
  }
}

class ResponseResource implements Resource {
  readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  constructor(body: ReadableStream<Uint8Array> | null) {
    this.reader = body ? body.getReader() : null;
  }
  async close(): Promise<void> {
    if (this.reader) await this.reader.cancel();
  }
}

const isRequest = (r: Resource): r is RequestResource => r instanceof RequestResource;
const isResponse = (r: Resource): r is ResponseResource => r instanceof ResponseResource;

export interface HttpScope {
  allow: string[];
  deny: string[];
}

function decodeDataUrl(url: string): { mime: string; body: Uint8Array } {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(url);
  if (!m) throw new ShellCommandError('failed to process data url');
  const mime = (m[1] as string) === '' ? 'text/plain;charset=US-ASCII' : (m[1] as string);
  const payload = m[3] as string;
  try {
    const body = m[2] ? Buffer.from(decodeURIComponent(payload), 'base64') : Buffer.from(decodeURIComponent(payload), 'latin1');
    return { mime, body };
  } catch (error) {
    if (error instanceof URIError) throw new ShellCommandError('failed to decode data url into bytes');
    throw error;
  }
}

/**
 * `scope` 是全部 capability 中 http 作用域条目的并集（上界）；每次调用还要满足调用方经 ACL 解析出的
 * 作用域（`CommandContext.scope`，tauri-plugin-http 的命令作用域 ∪ 全局作用域）。
 */
export function httpPlugin(scope: HttpScope, systemProxy?: SystemProxy): BuiltinPlugin {
  const client = new HttpClient(systemProxy);
  const allowed = (url: URL, ctx: CommandContext) => {
    const call = ctx.scope ? ctx.scope() : { allow: [], deny: [] };
    const callAllow = call.allow.map((entry) => scopeString(entry, 'url')).filter((p): p is string => p !== null);
    const callDeny = call.deny.map((entry) => scopeString(entry, 'url')).filter((p): p is string => p !== null);
    return ![...scope.deny, ...callDeny].some((p) => urlPatternMatches(p, url))
      && scope.allow.some((p) => urlPatternMatches(p, url))
      && callAllow.some((p) => urlPatternMatches(p, url));
  };

  return {
    fetch: (input: InvokeInput, ctx) => {
      const config = raw(input, 'clientConfig');
      if (config === undefined) throw missingKey(input.command, 'clientConfig');
      if (config === null || typeof config !== 'object') throw invalidArgs(input.command, 'clientConfig', 'invalid type, expected struct ClientConfig');
      const c = config as {
        method?: unknown;
        url?: unknown;
        headers?: unknown;
        data?: unknown;
        connectTimeout?: unknown;
        maxRedirections?: unknown;
        proxy?: unknown;
        danger?: unknown;
      };
      if (typeof c.method !== 'string') throw invalidArgs(input.command, 'clientConfig', 'missing field `method`');
      if (typeof c.url !== 'string') throw invalidArgs(input.command, 'clientConfig', 'missing field `url`');
      let url: URL;
      try {
        url = new URL(c.url);
      } catch (error) {
        if (error instanceof TypeError) throw invalidArgs(input.command, 'clientConfig', 'relative URL without a base');
        throw error;
      }
      const method = c.method;
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)) throw new ShellCommandError('invalid HTTP method');
      const headers = new Headers();
      for (const pair of Array.isArray(c.headers) ? (c.headers as unknown[]) : []) {
        const [name, value] = pair as [string, string];
        if (isUnsafeHeader(name)) continue;
        headers.append(name, value);
      }
      const data = Array.isArray(c.data) ? Uint8Array.from(c.data as number[]) : null;
      const scheme = url.protocol.slice(0, -1);

      if (scheme === 'http' || scheme === 'https') {
        if (!allowed(url, ctx)) throw new ShellCommandError(`url not allowed on the configured scope: ${url.href}`);
        if (c.danger !== undefined && c.danger !== null) throw new ShellCommandError('dangerous settings used but are not enabled');
        if (data === null && (method === 'POST' || method === 'PUT')) headers.set('content-length', '0');
        if (headers.has('range')) headers.append('accept-encoding', 'identity');
        else headers.set('accept-encoding', 'identity');
        if (!headers.has('user-agent')) headers.append('user-agent', HTTP_USER_AGENT);
        const pageUrl = ctx.runtime.windows.get(ctx.windowLabel)?.webContents.getURL();
        if (pageUrl) {
          const page = new URL(pageUrl);
          headers.append('origin', page.protocol === 'tauri:' ? 'tauri://localhost' : page.origin);
        }
        const maxRedirections = typeof c.maxRedirections === 'number' ? c.maxRedirections : null;
        const connectTimeout = typeof c.connectTimeout === 'number' ? c.connectTimeout : null;
        const resource = new RequestResource(url.href, async (signal) => {
          return client.send(url, {
            method,
            headers,
            ...(data !== null ? { body: data } : {}),
            signal,
          }, { connectTimeout, maxRedirections, proxy: c.proxy as HttpClientOptions['proxy'] });
        });
        return ctx.runtime.addResource(ctx.webviewLabel, resource);
      }
      if (scheme === 'data') {
        const decoded = decodeDataUrl(url.href);
        const resource = new RequestResource(url.href, async () =>
          // TS 5.7+ 的 BodyInit 只接受普通 ArrayBuffer 上的视图；data URL 解码结果不需要再复制。
          new Response(new Uint8Array(decoded.body.buffer as ArrayBuffer, decoded.body.byteOffset, decoded.body.byteLength),
            { status: 200, headers: { 'content-type': decoded.mime } }),
        );
        return ctx.runtime.addResource(ctx.webviewLabel, resource);
      }
      throw new ShellCommandError(`scheme ${scheme} not supported`);
    },
    fetch_cancel: (input, ctx) => {
      const req = ctx.runtime.getResource(ctx.webviewLabel, reqInteger(input, 'rid'), isRequest);
      req.controller.abort();
      return null;
    },
    fetch_send: async (input, ctx) => {
      const rid = reqInteger(input, 'rid');
      const req = ctx.runtime.getResource(ctx.webviewLabel, rid, isRequest);
      if (req.sent || req.controller.signal.aborted) {
        ctx.runtime.takeResource(ctx.webviewLabel, rid);
        throw new ShellCommandError('Request canceled');
      }
      req.sent = true;
      let res: Response;
      try {
        res = await req.run(req.controller.signal);
      } catch (error) {
        ctx.runtime.takeResource(ctx.webviewLabel, rid);
        if (req.controller.signal.aborted) throw new ShellCommandError('Request canceled');
        throw new ShellCommandError(`error sending request for url (${req.url})`);
      }
      ctx.runtime.takeResource(ctx.webviewLabel, rid);
      // 页面退出/取消可发生在 run() 已产出响应、但 await 尚未恢复的间隙。
      // 不得把这个响应重新登记到刚刚被销毁的 webview 资源表。
      if (req.controller.signal.aborted) {
        await res.body?.cancel();
        throw new ShellCommandError('Request canceled');
      }
      const headers: Array<[string, string]> = [];
      res.headers.forEach((value, key) => {
        if (key !== 'set-cookie') headers.push([key, value]);
      });
      for (const cookie of res.headers.getSetCookie()) headers.push(['set-cookie', cookie]);
      const responseRid = ctx.runtime.addResource(ctx.webviewLabel, new ResponseResource(res.body));
      return {
        status: res.status,
        statusText: STATUS_CODES[res.status] ?? '',
        headers,
        url: res.url === '' ? req.url : res.url,
        rid: responseRid,
      };
    },
    fetch_read_body: async (input, ctx) => {
      const rid = reqInteger(input, 'rid');
      const res = ctx.runtime.getResource(ctx.webviewLabel, rid, isResponse);
      const chunk = res.reader ? await res.reader.read() : { done: true as const, value: undefined };
      if (chunk.done || chunk.value === undefined) {
        await ctx.runtime.closeResource(ctx.webviewLabel, rid);
        return Uint8Array.of(1);
      }
      const out = new Uint8Array(chunk.value.length + 1);
      out.set(chunk.value, 0);
      out[chunk.value.length] = 0;
      return out;
    },
    fetch_cancel_body: async (input, ctx) => {
      await ctx.runtime.closeResource(ctx.webviewLabel, reqInteger(input, 'rid'));
      return null;
    },
  };
}
