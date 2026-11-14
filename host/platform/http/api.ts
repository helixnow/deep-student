/**
 * `ctx.http`：fetch 风格的 HTTP 客户端，统一走 Host 的代理与网络策略（W14）。
 *
 * - `fetch` 保持 WHATWG fetch 语义：返回标准 `Response`；网络失败、超时、中止的错误与全局 `fetch`
 *   相同（`TypeError` / `TimeoutError` / `AbortError`），迁移时把 `fetch(url, init)` 换成
 *   `ctx.http.fetch(url, init)` 即可，现有错误判断不用改；
 * - 代理：桌面实现复用 llm 插件 `http_proxy.ts` 的同一份逻辑（`HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY`，
 *   环境变量全空时读取 macOS/Windows 系统代理及其例外列表），不另写一套；
 * - 网络策略：`destination: 'public'` 按 net-policy `isSafeRemoteUrl` 拒绝私网、链路本地、云元数据地址
 *   （回环默认放行，`allowLoopback: false` 时也拒绝），每一跳重定向重新判定；
 * - 只接受 http/https。接口不出现 undici `Dispatcher`、Node `Buffer` / `IncomingMessage` 等类型；
 * - 内容编码：请求默认带 `accept-encoding: identity`（与未开 gzip 特性的 reqwest 一样不要压缩）。服务端仍回
 *   `content-encoding: gzip` / `deflate` / `br` 时，正文是**解码后**的字节（undici 没有关掉解码的开关），`content-length`
 *   头保持服务端给的编码后长度：按 `content-length` 核对正文长度的调用方要先看 `content-encoding`。`fetchBytes` 的
 *   `maxBytes` 按解码后的字节计。以后的移动端传输层要给出同样的结果（Android `HttpURLConnection` 在调用方自己设了
 *   `Accept-Encoding` 时不再透明解压）。
 *
 * 移动端实现方案见 host/platform/API.md「http」。
 */

export type HttpHeaders = Headers | Readonly<Record<string, string>> | ReadonlyArray<readonly [string, string]>;

/** 请求体：与 fetch 的 `BodyInit` 中可移植的部分一致。流式请求体在移动端原生 HTTP 上会被整体缓冲。 */
export type HttpBody = string | Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | ReadableStream<Uint8Array>;

/**
 * - `any`（默认）：任意 http/https 目标——用户配置的服务、局域网 Ollama/WebDAV、本机 MCP 桥；
 * - `public`：URL 来自不可信内容（模型输出、网页/文档中的链接、远程图片）时必须使用；
 * - `public-pinned`：同 `public` 的用途，但连接钉在已校验的 IP 上，并且不走任何代理（见 PINNED.md）。传输层
 *   自己解析主机名，全部地址都必须是公网地址（回环、私网、链路本地、元数据一律拒绝，`allowLoopback` 除外），
 *   然后直连第一个地址；TLS SNI、证书校验与 `Host` 头仍用原主机名。DNS rebinding 无法让连接落到别处。
 *   只有桌面实现；其他平台以 `HttpError('UnsupportedOnPlatform')` 拒绝。
 */
export type HttpDestination = 'any' | 'public' | 'public-pinned';

export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: HttpHeaders;
  readonly body?: HttpBody | null;
  readonly signal?: AbortSignal;
  /** 默认 `follow`：最多 10 跳（reqwest `Policy::limited(10)`），跨源时去掉凭据头。 */
  readonly redirect?: 'follow' | 'manual' | 'error';
  /**
   * 整个请求（含读取响应体）的超时毫秒数；默认 300 000（与 LLM 客户端 / reqwest 配置一致）。超时以 `TimeoutError` 拒绝。
   * `null`：不设总超时（reqwest 客户端没有 `.timeout()`），只受 `signal` 约束，由调用方自己做空闲看门狗。
   * 与 reqwest 一样没有单独的响应头 / 响应体读超时：等响应头、响应体两块之间的空闲都只受总超时和 `signal` 约束。
   */
  readonly timeoutMs?: number | null;
  /**
   * 默认 `any`。`public` / `public-pinned` 下 `follow` 只用于 GET/HEAD；其他方法遇到重定向抛 `RedirectBlocked`。
   * `public-pinned` + `follow` 每一跳都重新解析、校验并钉住；`manual` 时由调用方逐跳再发请求。
   */
  readonly destination?: HttpDestination;
  /**
   * 是否允许回环地址（私网、链路本地等始终拒绝）。`any` 下不起作用。
   * - `public-pinned`：默认 false。只应在用户已批准访问本机、且请求 URL 本身指向本机（回环字面量或 `localhost`）时打开。
   * - `public`：默认 true（与 Rust `is_safe_remote_url` 一致）。传 false 时，IP 字面量、`localhost` 名以及解析到回环的
   *   主机名都以 `BlockedDestination`（`reason: 'blocked-address'`）拒绝，每一跳重定向重新判定。没有主机名解析的平台
   *   只能判断 IP 字面量与 `localhost` 名（能力清单 `net.publicPolicy`）。
   */
  readonly allowLoopback?: boolean;
}

export interface HttpCheckOptions {
  /** 同 `HttpRequestInit.allowLoopback` 在 `public-pinned` 下的含义，默认 false。 */
  readonly allowLoopback?: boolean;
}

export interface HttpBytesInit extends HttpRequestInit {
  /** 响应体字节上限；超过抛 `HttpError('TooLarge')`（先看 Content-Length，读取中再复核）。 */
  readonly maxBytes?: number;
}

/** `fetchBytes` 的结果：一次性读完的响应，移动端原生 HTTP 天然就是这种形态。 */
export interface HttpBytesResponse {
  /** 跟随重定向后的最终 URL。 */
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  /** 名称小写；同名多值按 fetch `Headers.get` 以 `, ` 合并。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

/**
 * 策略层拒绝请求时抛出。继承 `TypeError`：对只认 fetch 网络错误的旧代码，表现和请求失败一样。
 * - `InvalidUrl`：无法解析，或不是 http/https；
 * - `BlockedDestination`：`public` / `public-pinned` 下目标是私网/链路本地/元数据地址（或不允许的回环），或 DNS 解析失败；
 * - `RedirectBlocked`：`public` 下非 GET/HEAD 请求遇到重定向，或重定向超过 10 跳；
 * - `TooLarge`：响应体超过 `maxBytes`；
 * - `UnsupportedOnPlatform`：当前平台没有该能力（`public-pinned` 目前只有桌面）。消息以
 *   `UNSUPPORTED_ON_PLATFORM: ` 开头，`capability` / `platform` 字段与平台能力清单一致。
 */
export type HttpErrorKind = 'InvalidUrl' | 'BlockedDestination' | 'RedirectBlocked' | 'TooLarge' | 'UnsupportedOnPlatform';

/**
 * `public-pinned` 下 `BlockedDestination` 的细分原因：
 * - `dns-failed`：解析失败；`no-address`：解析结果为空；
 * - `blocked-address`：某个解析结果（或 IP 字面量）不是允许的地址，`address` 给出该地址。
 */
export type HttpBlockReason = 'dns-failed' | 'no-address' | 'blocked-address';

export interface HttpErrorDetails {
  readonly reason?: HttpBlockReason;
  readonly address?: string;
  readonly capability?: string;
  readonly platform?: string;
  readonly cause?: unknown;
}

export class HttpError extends TypeError {
  override name = 'HttpError';
  readonly kind: HttpErrorKind;
  readonly url: string;
  readonly reason?: HttpBlockReason;
  readonly address?: string;
  readonly capability?: string;
  readonly platform?: string;
  constructor(kind: HttpErrorKind, url: string, message: string, details: HttpErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.url = url;
    if (details.reason !== undefined) this.reason = details.reason;
    if (details.address !== undefined) this.address = details.address;
    if (details.capability !== undefined) this.capability = details.capability;
    if (details.platform !== undefined) this.platform = details.platform;
  }
}

export interface HttpService {
  fetch(input: string | URL, init?: HttpRequestInit): Promise<Response>;
  fetchBytes(input: string | URL, init?: HttpBytesInit): Promise<HttpBytesResponse>;
  /** `destination: 'public'` 使用的判定（net-policy `isSafeRemoteUrl`：只允许 http/https，解析出的任一地址被封锁即 false）。 */
  isPublicUrl(url: string): Promise<boolean>;
  /**
   * `public-pinned` 的连接前检查：按同样的规则解析并校验 URL 主机（IP 字面量不解析），不建立连接，通过时返回将要钉住的地址。
   * 不通过时抛与 `fetch(url, { destination: 'public-pinned' })` 相同的 `HttpError`：`InvalidUrl`、`BlockedDestination`
   * （`reason` / `address`）、`UnsupportedOnPlatform`（没有钉住传输的平台）。检查结果不缓存，之后的 `fetch` 会重新解析并校验。
   */
  checkPublicPinned(input: string | URL, options?: HttpCheckOptions): Promise<{ readonly address: string }>;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** W14：统一代理与网络策略的 HTTP 客户端。 */
    http: HttpService;
  }
}
