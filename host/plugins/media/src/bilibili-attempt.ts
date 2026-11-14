/**
 * `dstu-media/src/media/bilibili_transport/session.rs` + `native.rs`:
 * a single Bilibili attempt pinned to an exit route, account generation and
 * deadline. Native/proxy requests go through fetch; browser requests reuse the
 * paired loopback bridge.
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, ProxyAgent } from 'undici';
import type { BiliError, RequestKind, Route, RouteMode } from '../api.ts';
import { isInternalIp } from '../../../platform/net-policy/index.ts';
import type {
  BridgeCancellation, BridgeHub, BridgeHttpResponse,
} from './bilibili-bridge-hub.ts';
import {
  credentialHost, responseHeader, validateRequest, validateUrl, BiliRequestError,
} from './bilibili-policy.ts';
import type {
  BiliTransportState, RequestDiagnostic, TransportSettings,
} from './bilibili-transport.ts';
import { nextRequestId, selectRoute } from './bilibili-session.ts';
import { decodeAccount } from './bilibili-bridge-probe.ts';
import { API_LIMIT } from './bilibili-grpc.ts';
import { CancellationToken } from './handout.ts';

const REQUEST_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 60_000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0 Safari/537.36';

let authEpoch = 1;
export function invalidateAuth(): void {
  authEpoch += 1;
}
export function currentAuthEpoch(): number {
  return authEpoch;
}

export interface BiliRequest {
  kind: RequestKind;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
  maxBytes: number;
  deadlineMs: number;
  id: number;
  attemptId: string;
  cancel: CancellationToken;
}

export interface BiliResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  finalUrl: URL;
  setCookies: string[];
  header(name: string): string | null;
}

function responseOf(
  status: number,
  headers: Record<string, string>,
  body: Uint8Array,
  finalUrl: URL,
  setCookies: string[] = [],
): BiliResponse {
  return {
    status,
    headers,
    body,
    finalUrl,
    setCookies,
    header(name: string): string | null {
      const wanted = name.toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return value;
      }
      return null;
    },
  };
}

interface TransportRequest extends BiliRequest {
  route: Route;
}

interface BiliTransport {
  execute(request: TransportRequest): Promise<BiliResponse>;
}

function childToken(parent: CancellationToken): CancellationToken {
  const child = new CancellationToken();
  if (parent.isCancelled()) child.cancel();
  else void parent.cancelled().then(() => child.cancel());
  return child;
}

class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
    else this.free += 1;
  }
}

const SLOTS = new Semaphore(4);
const MEDIA_SLOTS = new Semaphore(2);

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, '', 0);
      return;
    }
    const allowed = addresses.filter(address => !isInternalIp(address.address));
    if (allowed.length === 0) {
      const failure = Object.assign(new Error('No public Bilibili address'),
        { code: 'ENOTFOUND' as const });
      callback(failure, '', 0);
      return;
    }
    if (options.all === true) callback(null, allowed);
    else callback(null, allowed[0]!.address, allowed[0]!.family);
  });
};

function validateProxy(raw: string): void {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new BiliRequestError('proxy-config', '代理地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new BiliRequestError('proxy-config', '代理需使用无内嵌凭据的 HTTP / HTTPS 地址');
  }
}

function networkError(error: unknown): BiliRequestError {
  if (error instanceof BiliRequestError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new BiliRequestError('timeout', '请求 B 站超时');
  }
  return new BiliRequestError('network', '连接 B 站失败，请检查网络或切换出口');
}

class NativeTransport implements BiliTransport {
  private readonly cookie: string | null;
  private readonly strict: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher: Agent | ProxyAgent | null;
  private readonly route: Route;

  constructor(options: {
    cookie: string | null;
    proxy: string | null;
    strict: boolean;
    fetchImpl: typeof fetch;
  }) {
    this.cookie = options.proxy === null ? options.cookie : null;
    this.strict = options.strict;
    this.fetchImpl = options.fetchImpl;
    this.route = options.proxy === null ? 'native' : 'proxy';
    if (options.proxy !== null) {
      validateProxy(options.proxy);
      this.dispatcher = new ProxyAgent(options.proxy);
    } else if (options.strict) {
      this.dispatcher = new Agent({
        connect: { lookup: publicLookup },
        connectTimeout: 4_000,
      });
    } else {
      this.dispatcher = null;
    }
  }

  async execute(request: TransportRequest): Promise<BiliResponse> {
    if (this.strict) validateRequest(request);
    const controller = new AbortController();
    let timedOut = false;
    const remaining = Math.max(request.deadlineMs - Date.now(), 0);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remaining);
    let cancelled = request.cancel.isCancelled();
    const stop = request.cancel.cancelled().then(() => {
      cancelled = true;
      controller.abort();
    });
    try {
      const response = await this.send(request, controller.signal);
      return response;
    } catch (error) {
      if (cancelled) throw new BiliRequestError('cancelled', '请求已取消');
      if (timedOut) throw new BiliRequestError('timeout', '请求 B 站超时');
      throw networkError(error);
    } finally {
      clearTimeout(timer);
      void stop;
    }
  }

  private async send(request: TransportRequest, signal: AbortSignal): Promise<BiliResponse> {
    await SLOTS.acquire();
    let mediaSlot = false;
    try {
      if (request.kind === 'media') {
        await MEDIA_SLOTS.acquire();
        mediaSlot = true;
      }
      const url = request.url;
      if (this.strict) validateUrl(url, request.kind);
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
        throw new BiliRequestError('invalid-request', '请求方式无效');
      }
      const outgoing: Record<string, string> = {
        referer: 'https://www.bilibili.com/',
        'user-agent': USER_AGENT,
      };
      for (const [name, value] of Object.entries(request.headers)) outgoing[name] = value;
      if ((!this.strict || credentialHost(url))
        && (request.kind === 'api' || request.kind === 'passport')
        && this.cookie !== null) {
        outgoing.cookie = this.cookie;
      }
      const init: RequestInit & { dispatcher?: Agent | ProxyAgent } = {
        method: request.method,
        headers: outgoing,
        body: request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : new Uint8Array(request.body),
        redirect: 'manual',
        signal,
      };
      if (this.dispatcher !== null) init.dispatcher = this.dispatcher;
      const response = await this.fetchImpl(url.toString(), init);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (responseHeader(lower)) headers[lower] = value;
      });
      const status = response.status;
      const skipBody = request.method === 'HEAD' || status < 200 || status >= 300;
      const declared = response.headers.get('content-length');
      if (!skipBody && declared !== null && /^[0-9]+$/.test(declared)
        && Number(declared) > request.maxBytes) {
        throw new BiliRequestError('response-too-large', 'B 站响应超过大小限制');
      }
      if (request.kind === 'media' && status === 200 && 'range' in request.headers
        && declared === null) {
        throw new BiliRequestError('range-unsupported', '视频服务器不支持有界分段读取');
      }
      const setCookies = request.kind === 'passport' && this.route === 'native'
        ? response.headers.getSetCookie() : [];
      if (skipBody) {
        delete headers['content-length'];
        return responseOf(status, headers, new Uint8Array(0), url, setCookies);
      }
      const body = await this.readBounded(response, request.maxBytes);
      return responseOf(status, headers, body, url, setCookies);
    } finally {
      if (mediaSlot) MEDIA_SLOTS.release();
      SLOTS.release();
    }
  }

  private async readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (response.body === null) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BiliRequestError('response-too-large', 'B 站响应超过大小限制');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  }
}

class BrowserTransport implements BiliTransport {
  private readonly hub: BridgeHub;
  private readonly connection: string;
  private readonly generation: number;

  constructor(hub: BridgeHub, connection: string, generation: number) {
    this.hub = hub;
    this.connection = connection;
    this.generation = generation;
  }

  async execute(request: TransportRequest): Promise<BiliResponse> {
    if (this.hub.status().generation !== this.generation) {
      throw new BiliRequestError('identity-changed', '浏览器桥已重新配对，请重新开始任务');
    }
    const cancellation: BridgeCancellation = {
      get isCancelled(): boolean { return request.cancel.isCancelled(); },
      whenCancelled: () => request.cancel.cancelled().then(() => 'cancelled' as const),
    };
    let response: BridgeHttpResponse;
    try {
      response = await this.hub.executeOn(this.connection, {
        id: request.id,
        attemptId: request.attemptId,
        kind: request.kind,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        maxBytes: request.maxBytes,
        deadlineMs: request.deadlineMs,
        cancel: cancellation,
      }, false);
    } catch (error) {
      if (error instanceof BiliRequestError) throw error;
      throw new BiliRequestError('bridge-request-failed',
        error instanceof Error ? error.message : String(error));
    }
    let finalUrl: URL;
    try { finalUrl = new URL(response.finalUrl); }
    catch { throw new BiliRequestError('bridge-protocol', '浏览器桥返回无效地址'); }
    return responseOf(response.status, response.headers, response.body,
      finalUrl, response.setCookies);
  }
}

export interface BiliAttemptDeps {
  state: BiliTransportState;
  hub: BridgeHub;
  nativeCookie: string | null;
  fetchImpl?: typeof fetch;
}

export class BiliAttempt {
  readonly id: string;
  readonly route: Route;
  readonly generation: number;
  readonly authEpoch: number;
  readonly bridgeGeneration: number;
  readonly connection: string | null;
  readonly expectedMid: number | null;
  readonly expectedLoggedIn: boolean;
  readonly cacheScope: string;
  private readonly deps: BiliAttemptDeps;
  private readonly transport: BiliTransport;
  private deadlineMs: number | null = null;
  private cancel = new CancellationToken();

  private constructor(
    deps: BiliAttemptDeps,
    route: Route,
    connection: string | null,
    expectedMid: number | null,
    expectedLoggedIn: boolean,
    bridgeGeneration: number,
    transport: BiliTransport,
  ) {
    this.id = crypto.randomUUID();
    this.deps = deps;
    this.route = route;
    this.connection = connection;
    this.expectedMid = expectedMid;
    this.expectedLoggedIn = expectedLoggedIn;
    this.bridgeGeneration = bridgeGeneration;
    this.generation = deps.state.generation();
    this.authEpoch = currentAuthEpoch();
    this.transport = transport;
    this.cacheScope = `${route}:${this.generation}:${this.authEpoch}:`
      + `${route === 'browser_bridge' ? bridgeGeneration : 0}`;
  }

  static async begin(deps: BiliAttemptDeps, media: boolean): Promise<BiliAttempt> {
    return BiliAttempt.beginWithSettings(deps, media, deps.state.settings());
  }

  /** `BiliAttempt::native`: the app account's own route, whatever the pairing and route settings. */
  static native(deps: BiliAttemptDeps): BiliAttempt {
    const transport = new NativeTransport({
      cookie: deps.nativeCookie,
      proxy: null,
      strict: true,
      fetchImpl: deps.fetchImpl ?? fetch,
    });
    return new BiliAttempt(deps, 'native', null, null, false, 0, transport);
  }

  private static async beginWithSettings(
    deps: BiliAttemptDeps,
    media: boolean,
    config: TransportSettings,
  ): Promise<BiliAttempt> {
    const bridge = deps.hub.status();
    const bridgeReady = bridge.parsing && (!media || bridge.media) && bridge.state === 'ready';
    const nativeCookie = deps.nativeCookie;
    const nativeFirst = nativeCookie !== null;
    const route = selectRoute(config.mode, bridgeReady, media && bridge.parsing, nativeFirst);
    const connection = route === 'browser_bridge' ? bridge.connectionId : null;
    const nativeMid = nativeCookie === null ? null : cookieMid(nativeCookie);
    const bridgeAccount = bridge.account;
    const mode = config.mode;
    if (mode === 'auto' && !nativeFirst && media && bridge.parsing && !bridge.media
      && bridgeAccount?.loggedIn === true
      && (bridgeAccount.mid !== nativeMid || nativeCookie === null)) {
      throw new BiliRequestError('route-account-mismatch',
        '浏览器桥不支持媒体读取，应用账号不同；请明确选择播放出口');
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    let transport: BiliTransport;
    if (route === 'browser_bridge') {
      if (connection === null) {
        throw new BiliRequestError('bridge-offline', '浏览器桥未就绪，请连接浏览器');
      }
      transport = new BrowserTransport(deps.hub, connection, bridge.generation);
    } else {
      transport = new NativeTransport({
        cookie: route === 'native' ? nativeCookie : null,
        proxy: route === 'proxy' ? config.proxyUrl : null,
        strict: true,
        fetchImpl,
      });
    }
    const expectedMid = route === 'browser_bridge'
      ? bridgeAccount?.mid ?? null
      : route === 'native' ? nativeMid : null;
    const expectedLoggedIn = route === 'browser_bridge'
      ? bridgeAccount?.loggedIn === true
      : route === 'native' && nativeCookie !== null;
    return new BiliAttempt(deps, route, connection, expectedMid,
      expectedLoggedIn, bridge.generation, transport);
  }

  valid(): boolean {
    if (this.generation !== this.deps.state.generation()) return false;
    if (this.authEpoch !== currentAuthEpoch()) return false;
    return this.route !== 'browser_bridge'
      || this.bridgeGeneration === this.deps.hub.status().generation;
  }

  ensureActive(): void {
    if (this.cancel.isCancelled()) {
      throw new BiliRequestError('cancelled', '任务已取消');
    }
    if (this.deadlineMs !== null && this.deadlineMs <= Date.now()) {
      throw new BiliRequestError('timeout', '任务已超时');
    }
    if (!this.valid()) {
      throw new BiliRequestError('identity-changed', 'B 站账号或出口已变化');
    }
  }

  cancelToken(): CancellationToken {
    return this.cancel;
  }

  /** `BiliAttempt::task`：设定 60s 截止并注册同 id 任务；返回 `TaskGuard` 的移除动作。 */
  task(taskId: string | null, registry: {
    register(id: string, token: CancellationToken): void;
    remove(id: string): void;
  }): () => void {
    const id = taskId ?? this.id;
    this.deadlineMs = Date.now() + TASK_TIMEOUT_MS;
    const registered = id;
    registry.register(registered, this.cancel);
    return () => registry.remove(registered);
  }

  async waitCreate(lock: AttemptLock): Promise<() => void> {
    const deadline = this.deadlineMs ?? Date.now() + TASK_TIMEOUT_MS;
    return lock.acquire(deadline, this.cancel);
  }

  async fallback(): Promise<BiliAttempt> {
    const config = this.deps.state.settings();
    if (config.mode !== 'auto') {
      throw new BiliRequestError('fixed-route', '固定出口不会自动换路');
    }
    let next = await BiliAttempt.begin(this.deps, false);
    if (next.route === this.route) {
      const bridge = this.deps.hub.status();
      let mode: RouteMode;
      if (this.route === 'browser_bridge') mode = 'native';
      else if (this.route === 'native' && bridge.state === 'ready' && bridge.parsing) {
        mode = 'browser_bridge';
      } else if (config.proxyInAuto && config.proxyUrl !== null) mode = 'proxy';
      else throw new BiliRequestError('no-compatible-route', '没有满足当前任务条件的其他出口');
      next = await BiliAttempt.beginWithSettings(this.deps, false, { ...config, mode });
    }
    if (next.expectedLoggedIn !== this.expectedLoggedIn
      || next.expectedMid !== this.expectedMid
      || (this.expectedLoggedIn && this.expectedMid === null)) {
      throw new BiliRequestError('route-account-mismatch',
        '其他出口的账号不同，请确认账号后手动重试');
    }
    next.deadlineMs = this.deadlineMs;
    next.cancel = this.cancel;
    return next;
  }

  async execute(request: Partial<BiliRequest> & Pick<BiliRequest, 'kind' | 'url'>): Promise<BiliResponse> {
    if (!this.valid()) {
      throw new BiliRequestError('identity-changed', 'B 站账号或出口已变化，请重新开始任务');
    }
    const deadline = Math.min(
      request.deadlineMs ?? Date.now() + REQUEST_TIMEOUT_MS,
      this.deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    const prepared: BiliRequest = {
      kind: request.kind,
      method: request.method ?? 'GET',
      url: request.url,
      headers: request.headers ?? {},
      body: request.body ?? new Uint8Array(0),
      maxBytes: request.maxBytes ?? API_LIMIT,
      deadlineMs: deadline,
      id: nextRequestId(),
      attemptId: this.id,
      cancel: childToken(this.cancel),
    };
    const started = Date.now();
    const host = prepared.url.hostname;
    let result: BiliResponse;
    try {
      result = await this.executeRedirects(prepared);
    } catch (error) {
      const failure = asTransportError(error, prepared, this.route);
      this.record(prepared, host, started, null, failure.payload.code, 0);
      throw failure;
    }
    this.record(prepared, host, started, result.status, null, result.body.length);
    if (!this.valid()) {
      throw new BiliRequestError('identity-changed', 'B 站账号或出口已变化，请重新开始任务');
    }
    return result;
  }

  private record(
    request: BiliRequest,
    host: string,
    started: number,
    status: number | null,
    errorCode: string | null,
    bytes: number,
  ): void {
    const diagnostic: RequestDiagnostic = {
      requestId: request.id,
      attemptId: this.id,
      route: this.route,
      stage: request.kind,
      host,
      elapsedMs: Date.now() - started,
      status,
      errorCode,
      bytes,
    };
    this.deps.state.recordDiagnostic(diagnostic);
  }

  private async executeRedirects(request: BiliRequest): Promise<BiliResponse> {
    const visited = new Set<string>();
    let current = request;
    for (let hop = 0; hop <= 5; hop += 1) {
      if (visited.has(current.url.toString())) {
        throw new BiliRequestError('redirect-loop', 'B 站请求发生循环跳转');
      }
      visited.add(current.url.toString());
      const response = await this.transport.execute({ ...current, route: this.route });
      if (response.status < 300 || response.status >= 400
        || current.kind === 'short_link' || current.method === 'POST') {
        return response;
      }
      const location = response.header('location');
      if (location === null) {
        throw new BiliRequestError('invalid-redirect', 'B 站跳转缺少地址');
      }
      let next: URL;
      try { next = new URL(location, current.url); }
      catch { throw new BiliRequestError('invalid-redirect', 'B 站跳转地址无效'); }
      current = { ...current, url: next };
    }
    throw new BiliRequestError('redirect-limit', 'B 站请求跳转次数过多');
  }

  async verifyIdentity(): Promise<void> {
    if (this.connection === null) return;
    const response = await this.execute({
      kind: 'api',
      url: new URL('https://api.bilibili.com/x/web-interface/nav'),
      maxBytes: API_LIMIT,
    });
    const account = decodeAccount({
      status: response.status,
      headers: response.headers,
      body: response.body,
      finalUrl: response.finalUrl.toString(),
      setCookies: response.setCookies,
    });
    this.deps.hub.verifyAccount(this.connection, account);
  }
}

function cookieMid(cookie: string): number | null {
  for (const part of cookie.split(';')) {
    const value = part.trim().startsWith('DedeUserID=')
      ? part.trim().slice('DedeUserID='.length) : null;
    if (value !== null && /^[0-9]+$/.test(value)) {
      const mid = Number(value);
      if (Number.isSafeInteger(mid)) return mid;
    }
  }
  return null;
}

function asTransportError(
  error: unknown,
  request: BiliRequest,
  route: Route,
): BiliRequestError {
  const failure = error instanceof BiliRequestError
    ? error
    : new BiliRequestError('network', error instanceof Error ? error.message : String(error));
  failure.payload.requestId = request.id;
  failure.payload.attemptId = request.attemptId;
  failure.payload.stage = request.kind;
  failure.payload.route = route;
  return failure;
}

/** `tokio::sync::Mutex` for the single-create gate. */
export class AttemptLock {
  private locked = false;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: BiliRequestError) => void;
    timer: NodeJS.Timeout;
  }> = [];

  async acquire(deadlineMs: number, cancel: CancellationToken): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drop(waiter);
          reject(new BiliRequestError('timeout', '导入排队超时'));
        }, Math.max(deadlineMs - Date.now(), 0)),
      };
      this.waiters.push(waiter);
      void cancel.cancelled().then(() => {
        this.drop(waiter);
        reject(new BiliRequestError('cancelled', '任务已取消'));
      });
    });
  }

  private drop(waiter: {
    resolve: (release: () => void) => void;
    reject: (error: BiliRequestError) => void;
    timer: NodeJS.Timeout;
  }): void {
    clearTimeout(waiter.timer);
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) {
        this.locked = false;
        return;
      }
      clearTimeout(next.timer);
      next.resolve(this.releaser());
    };
  }
}
