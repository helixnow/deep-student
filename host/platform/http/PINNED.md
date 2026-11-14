# `ctx.http` · `destination: 'public-pinned'`

用于 URL 来自不可信内容、又必须防 DNS rebinding 的请求（`web_fetch` 等）。实现：`pinned-policy.ts`（地址判定，平台无关）、
`pinned.ts`（桌面传输）、`index.ts`（策略层接线）。测试：`tests/pinned.test.ts`。

## 语义

```ts
const response = await ctx.http.fetch(url, {
  destination: 'public-pinned',
  allowLoopback: false,      // 默认 false
  redirect: 'manual',        // 或 'follow' / 'error'
  headers, signal, timeoutMs,
});
```

1. **传输层自己解析并校验，调用方不传 IP。** 解析、校验、连接在同一处完成，调用方不可能校验了一个地址却连到另一个，也不会漏掉校验；
   移动端的原生实现（Android OkHttp `Dns`）也是“给主机名、返回地址”的形态，接口两端一致。
   - IP 字面量不解析，直接判定；主机名用系统解析（`dns.lookup(all, verbatim)`，与 `isSafeRemoteUrl` 相同）。
   - **全部**解析结果都必须允许，任何一个不允许就拒绝（失败关闭），然后钉住第一个地址。
   - 不允许：net-policy `isBlockedInternalIp`（私网、链路本地、CGNAT、元数据、ULA、组播、文档/基准网段、映射/6to4/NAT64 内嵌的内网地址等）
     以及回环；`allowLoopback: true` 只放行回环。只在用户已批准访问本机、且请求 URL 本身指向本机（回环字面量或 `localhost`）时打开。
2. **连接直连钉住的地址，不走代理。** `HTTP(S)_PROXY`、`ALL_PROXY` 和系统代理都不生效；每个请求单独的连接，不复用连接池。
3. **TLS 与 `Host` 用原主机名。** SNI、证书主机名校验、`Host` 头都来自 URL；证书按系统根证书校验（`rejectUnauthorized`）。
4. **重定向**
   - `follow`（默认）：只对 GET/HEAD，最多 10 跳；**每一跳重新解析、校验、钉住**，跨源去掉凭据头；某一跳不允许即抛错。
     其他方法遇到重定向抛 `RedirectBlocked`。
   - `manual`：原样返回 3xx，调用方自行决定是否继续；继续时对 `Location` 再发一次 `public-pinned` 请求，也就重新校验并钉住。
   - `error`：遇到重定向抛 `TypeError('unexpected redirect')`。
5. **错误**（都是 `HttpError`，继承 `TypeError`）
   - `BlockedDestination`，`reason`：`dns-failed`（消息 `DNS resolution failed for '<host>': <原因>`）、
     `no-address`（`DNS resolution returned no addresses for '<host>'`）、`blocked-address`（`address` 字段给出被拒的地址）。
   - `UnsupportedOnPlatform`：当前平台没有钉住传输。消息以 `UNSUPPORTED_ON_PLATFORM: http.destination.publicPinned is not available on <platform>`
     开头，`capability = 'http.destination.publicPinned'`、`platform` 与移动端能力清单一致。
   - 网络、TLS 失败与全局 `fetch` 相同（`TypeError`，`cause.code` 如 `ERR_TLS_CERT_ALTNAME_INVALID`）。

## 连接前检查：`checkPublicPinned`

```ts
const { address } = await ctx.http.checkPublicPinned(url, { allowLoopback });   // 不连接
```

- 与 `fetch(url, { destination: 'public-pinned', allowLoopback })` 的第 1 步完全相同（`resolvePinnedAddress`），只是不建立连接；
  通过时返回将要钉住的地址，不通过时抛同样的 `HttpError`（`InvalidUrl`、`BlockedDestination` + `reason`/`address`、`UnsupportedOnPlatform`）。
- 结果不缓存：之后的 `fetch` 仍会重新解析、校验、钉住，所以检查与连接之间的 rebinding 不会生效。
- 用途：Rust 先校验目标、再尝试别的通道（`web_fetch` 在 DeepSeek 之前，`fetch_executor.rs:936-979`）。
  替代“用已中止的 signal 发一次 `public-pinned` 请求”的写法。
- 需要钉住传输与主机名解析（`createHttpService({ pinnedTransport, resolveHost })`，`createDesktopHttp` 已接好两者）；缺一即 `UnsupportedOnPlatform`。

## `destination: 'public'` + `allowLoopback: false`

`public` 默认放行回环（与 Rust `is_safe_remote_url` 一致）。URL 来自不可信内容且不需要访问本机时传 `allowLoopback: false`：
net-policy 判定通过后，再用 `resolvePinnedAddress(url, false, resolveHost)` 解析一次，IP 字面量、`localhost` 名和解析到回环的主机名
都以 `BlockedDestination`（`reason: 'blocked-address'`）拒绝；`follow` 时每一跳重新判定，`manual` 时调用方对每一跳再发请求。
连接仍走普通传输（可经代理、不钉住），所以它挡不住 DNS rebinding；需要防 rebinding 时用 `public-pinned`。
没有主机名解析的平台（`resolveHost` 缺省）只能判断 IP 字面量与 `localhost` 名，与 `net.publicPolicy` 的移动端限制相同。

## 平台

- **桌面**：undici `Agent` 的 `connect.lookup` 只返回钉住的地址，显式 dispatcher 绕开代理。
- **移动端**：未实现，返回 `UnsupportedOnPlatform`（`mobile/src/capabilities.ts` 中为 `unsupported`）。
  - Android：OkHttp 可以做到——自定义 `Dns.lookup(hostname)` 只返回已校验的地址，证书仍按主机名校验，`Proxy.NO_PROXY` 关闭代理。
    需要原生插件，并把 `pickPinnedAddress` 的判定搬到原生侧或在 JS 侧先解析（WebView 没有 DNS 接口，仍需原生解析）。
  - iOS：`URLSession` 不能指定连接地址；要么用 `Network.framework`（`NWConnection` 直连 IP + 自行处理 TLS SNI 与校验，相当于自写 HTTP 客户端），
    要么不提供该能力。目前判定为能力缺口。

## 给 S01：`web_fetch` 迁移要点

`fetch-chat-executor.ts` 里的 `resolveAll`、`pinnedNodeGet`、`redirectAddress`、`validatePublicUrlTarget` 可以整体换成 `ctx.http`：

```ts
const loopbackOrigin = namesLoopback(url);              // 保留：只有 URL 本身指向本机才放行回环
const init = { destination: 'public-pinned', allowLoopback: loopbackOrigin, redirect: 'manual',
  headers: REQUEST_HEADERS, signal, timeoutMs } as const;
let current = parsed;
let response: Response;
try {
  response = await http.fetch(current, init);          // 首跳：解析失败 / 地址被拒都会抛 HttpError
} catch (error) {
  if (error instanceof HttpError && error.kind === 'BlockedDestination') {
    throw new Error(error.reason === 'blocked-address' ? 'Blocked: URL resolves to internal IP address' : error.message);
  }
  throw error;
}
for (let hops = 0; REDIRECT_STATUSES.has(response.status) && hops < MAX_REDIRECTS; hops++) {
  const location = response.headers.get('location');
  if (location === null) break;
  let next: URL;
  try { next = new URL(location, current); } catch { break; }
  let nextResponse: Response;
  try { nextResponse = await http.fetch(next, init); }
  catch (error) {
    if (error instanceof HttpError && (error.kind === 'BlockedDestination' || error.kind === 'InvalidUrl')) break; // reqwest attempt.stop()：返回当前 3xx
    throw error;
  }
  await response.body?.cancel();
  response = nextResponse;
  current = next;
}
```

- 最终响应来自钉住且校验过的地址，`validatePublicUrlTarget` 的地址复核可以删掉（`RF-S01-web-fetch-dns-pinning` 的保证改由传输层提供，
  测试改为断言 `ctx.http` 的行为或保留注入的假传输）。
- 响应体是标准 `ReadableStream`：`collectDownloadStreamLimited(response.body, …)` 需要接受 `ReadableStream`（它是 async iterable）。
- 测试注入：`createDesktopHttp({ env: {}, platformProxy: async () => null, pinned: { resolve } })`，`resolve(host)` 返回
  `[{ address }]`；本机测试服务器配 `allowLoopback: true`，主机名用 `.test` 证明没有再次解析。
- 工具执行器拿 `ctx.http` 的方式与其他平台服务相同（插件 `inject: ['http']` 后传入执行器依赖）。
- 移动端调用会得到 `UnsupportedOnPlatform`，`web_fetch` 在移动端应报告不可用，而不是退回到不钉住的请求。
