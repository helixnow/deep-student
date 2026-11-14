import { isIP } from 'node:net';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { CookieJar } from 'tough-cookie';

export interface ProxyConfig { url: string; basicAuth?: { username: string; password: string }; noProxy?: string }
export interface HttpClientOptions {
  proxy?: { all?: string | ProxyConfig; http?: string | ProxyConfig; https?: string | ProxyConfig } | null;
  maxRedirections?: number | null;
  connectTimeout?: number | null;
}
export type SystemProxy = (url: string) => Promise<string>;

/** `Url::port_or_known_default()`：显式端口优先，否则按协议取默认端口。 */
function knownPort(url: URL): number | null {
  if (url.port !== '') return Number(url.port);
  if (url.protocol === 'http:') return 80;
  if (url.protocol === 'https:') return 443;
  return null;
}

/** reqwest `make_referer`：https → http 不发送；否则去掉凭据与 fragment 后的来源 URL。 */
function refererFor(next: URL, previous: URL): string | null {
  if (next.protocol === 'http:' && previous.protocol === 'https:') return null;
  const referer = new URL(previous.href);
  referer.username = '';
  referer.password = '';
  referer.hash = '';
  return referer.href;
}

interface IpAddress { family: 4 | 6; value: bigint }
interface IpRule extends IpAddress { prefix: number }

/** `IpNet::from_str` / `IpAddr::from_str`：IPv4、IPv6、IPv4 内嵌 IPv6 与 CIDR。 */
function parseIpAddress(input: string): IpAddress | null {
  const family = isIP(input);
  if (family === 4) {
    return { family: 4, value: input.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n) };
  }
  if (family !== 6) return null;
  let text = input.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return { family: 6, value: groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n) };
}

function parseIpRule(entry: string): IpRule | null {
  const slash = entry.indexOf('/');
  const address = parseIpAddress(slash === -1 ? entry : entry.slice(0, slash));
  if (!address) return null;
  const bits = address.family === 4 ? 32 : 128;
  if (slash === -1) return { ...address, prefix: bits };
  const prefix = Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  return { ...address, prefix };
}

/** `DomainMatcher::contains`：忽略大小写，前导点可选，`*` 匹配全部。 */
function domainMatches(domain: string, rule: string): boolean {
  if (rule === '*') return true;
  const name = domain.toLowerCase();
  const pattern = rule.toLowerCase();
  if (pattern === name || (pattern.startsWith('.') && pattern.slice(1) === name)) return true;
  if (!name.endsWith(pattern)) return false;
  return pattern.startsWith('.') || name[name.length - pattern.length - 1] === '.';
}

/** reqwest `NoProxy::contains` (hyper-util matcher): IP/CIDR or domain suffix, not URL patterns. */
export function bypassProxy(host: string, rules: string | undefined): boolean {
  const bare = host.startsWith('[') ? host.replace(/^\[|\]$/g, '') : host;
  const address = parseIpAddress(bare);
  const entries = (rules ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (address) {
    return entries.some((entry) => {
      const rule = parseIpRule(entry);
      if (!rule || rule.family !== address.family) return false;
      const shift = BigInt((rule.family === 4 ? 32 : 128) - rule.prefix);
      return (address.value >> shift) === (rule.value >> shift);
    });
  }
  return entries.some((entry) => parseIpRule(entry) === null && domainMatches(bare, entry));
}

/** One jar per plugin instance, shared across webviews, as Http.cookies_jar in Rust. */
export class HttpClient {
  readonly jar = new CookieJar();
  readonly systemProxy: SystemProxy | undefined;
  constructor(systemProxy?: SystemProxy) { this.systemProxy = systemProxy; }

  private async dispatcher(url: URL, options: HttpClientOptions): Promise<Dispatcher> {
    const config = options.proxy;
    // Explicit reqwest proxies disable automatic proxy detection. Ordering is all -> http -> https.
    const selected = config?.all ?? (url.protocol === 'http:' ? config?.http : config?.https);
    let proxy: ProxyConfig | undefined = typeof selected === 'string' ? { url: selected } : selected;
    if (!config || !Object.values(config).some((value) => value != null)) {
      const env = process.env;
      const envUrl = url.protocol === 'https:' ? (env.https_proxy ?? env.HTTPS_PROXY) : (env.http_proxy ?? env.HTTP_PROXY);
      const automatic = envUrl ?? env.all_proxy ?? env.ALL_PROXY;
      if (automatic) proxy = { url: automatic, noProxy: env.no_proxy ?? env.NO_PROXY };
      else if (this.systemProxy) {
        const resolved = await this.systemProxy(url.href);
        // Chromium PAC returns an ordered list; DIRECT is authoritative when first.
        const first = resolved.split(';')[0]?.trim() ?? 'DIRECT';
        const match = /^(PROXY|HTTPS)\s+(.+)$/.exec(first);
        if (match) proxy = { url: `${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}` };
        else if (first !== 'DIRECT') throw new Error(`Unsupported system proxy: ${first}`);
      }
    }
    const connect = options.connectTimeout == null ? undefined : { timeout: options.connectTimeout };
    if (!proxy || bypassProxy(url.hostname, proxy.noProxy)) return new Agent({ connect });
    const parsed = new URL(proxy.url.includes('://') ? proxy.url : `http://${proxy.url}`);
    const auth = proxy.basicAuth ?? (parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } : undefined);
    parsed.username = ''; parsed.password = '';
    return new ProxyAgent({ uri: parsed.href, connect, ...(auth ? { token: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` } : {}) });
  }

  async send(url: URL, init: { method: string; headers: Headers; body?: Uint8Array; signal: AbortSignal }, options: HttpClientOptions): Promise<Response> {
    let current = new URL(url), method = init.method, body = init.body;
    const headers = new Headers(init.headers);
    const limit = options.maxRedirections ?? 10;
    const visited: string[] = [];
    for (;;) {
      headers.delete('cookie');
      const cookies = this.jar.getCookieStringSync(current.href);
      if (cookies) headers.set('cookie', cookies);
      const dispatcher = await this.dispatcher(current, options);
      let response;
      try {
        response = await undiciFetch(current, { method, headers: [...headers], ...(body ? { body } : {}), signal: init.signal, redirect: 'manual', dispatcher });
      } catch (e) { await dispatcher.destroy(); throw e; }
      for (const cookie of response.headers.getSetCookie()) this.jar.setCookieSync(cookie, current.href, { ignoreError: true });
      const location = response.headers.get('location');
      const redirect = [301, 302, 303, 307, 308].includes(response.status) && location !== null && limit !== 0;
      if (redirect) {
        visited.push(current.href);
        if (visited.length > limit) { await response.body?.cancel(); await dispatcher.close(); throw new Error('too many redirects'); }
        let next: URL;
        try { next = new URL(location, current); } catch { return this.response(response, dispatcher); }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') { await response.body?.cancel(); await dispatcher.close(); throw new Error('invalid redirect scheme'); }
        if (next.hostname !== current.hostname || knownPort(next) !== knownPort(current)) {
          for (const key of ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'www-authenticate']) headers.delete(key);
        }
        const referer = refererFor(next, current);
        if (referer === null) headers.delete('referer');
        else headers.set('referer', referer);
        if ((response.status === 301 || response.status === 302) && method === 'POST' || response.status === 303 && method !== 'HEAD') {
          method = 'GET'; body = undefined;
          for (const key of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) headers.delete(key);
        }
        await response.body?.cancel(); await dispatcher.close(); current = next;
      } else return this.response(response, dispatcher);
    }
  }

  private response(response: Awaited<ReturnType<typeof undiciFetch>>, dispatcher: Dispatcher): Response {
    const reader = response.body?.getReader();
    const body = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) { controller.close(); await dispatcher.close(); }
          else controller.enqueue(result.value);
        } catch (e) { controller.error(e); await dispatcher.destroy(); }
      },
      async cancel() { await reader.cancel(); await dispatcher.close(); },
    }) : null;
    if (!reader) void dispatcher.close();
    const out = new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] });
    Object.defineProperty(out, 'url', { value: response.url });
    return out;
  }
}
