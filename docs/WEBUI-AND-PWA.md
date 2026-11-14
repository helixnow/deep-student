# WebUI 与 PWA

浏览器宿主形态说明：同一份前端应用（`src/`）通过一条与桌面一致的 IPC 桥运行在浏览器里，后端仍是有状态的 Host
（`host/`），只是从 Electron 的 `utilityProcess` 换成 Node HTTP/WebSocket 服务或浏览器 Worker。本文记录分层、
运行方式、安全模型，以及两种 PWA 形态的落地情况与实际差距。

相关规格：插件后端见 [plugins/ARCHITECTURE.md](./plugins/ARCHITECTURE.md)，前端插件化见
[plugins/FRONTEND.md](./plugins/FRONTEND.md)。

## 1. 架构分层

```
src/（前端应用，零业务侵入）        视图、插件内核、feature，不感知自己在浏览器还是 Electron
web/client/bootstrap.ts             浏览器外壳：installTauriBridge 绑定传输层
WebSocket /api/ws 或 MessagePort  两种传输，装着同一套 RendererToMain / MainToRenderer 协议
web/server/gateway.ts               服务端：serveHost + ShellRuntime + 资源协议 + 文件暂存
host/ + electron/shell/             原样的 Host 与外壳运行时
```

| 层 | 位置 | 职责 |
|---|---|---|
| 应用 | `src/` | 不变。`src/` 内没有任何指向 `web/` 的 import |
| 引导 | `web/client/entry.ts` | `bootstrapWebClient()`（同 tick 内同步装好桥）后**立即并行**发起 `import('virtual:dstu-web-app-entry')`，两者同时进行（不 await 握手，也不使用 top-level await） |
| 入口替换 | `web/vite.config.ts` | 虚拟模块 `dstu-web-app-entry` 展开为 `src/main.tsx`，因此不需要改 `src/main.tsx` |
| 桥接 | `web/client/bootstrap.ts` | `installTauriBridge(transport, init, window)`（`electron/preload/bridge.ts`），与 Electron 渲染进程同一个桥 |
| 传输 | `web/server/ws.ts`、`web/shared/wire.ts`、`web/server/gateway.ts` | WebSocket 多标签页复用；纯 JSON 走文本帧，二进制走 `[u32be 头长度][UTF-8 JSON 头][原始字节]` 帧 |
| 宿主 | `web/server/gateway.ts` | `serveHost`（`host/kernel/connection.ts`）+ `ShellRuntime`（`electron/shell/runtime.ts`），注册 event / path / app / resources / fs / http / notification / updater / global-shortcut / process |
| 资源 | `web/server/main.ts` | `/api/protocol/<scheme>?path=…` 走 `assetResponse`（`electron/shell/asset-protocol.ts`）；`/api/files/stage`、`/api/files/prepare-save`、`/api/files/export` |

引导顺序与几个必须知道的替换点：

1. `bootstrapWebClient()` 先写 `window.__DS_PLATFORM__ = { kind, os }`：`kind` 在 `ios` / `android` 的
   userAgent 上默认 `mobile`，其余 `desktop`，`?shell=mobile` / `?shell=desktop` 可覆盖；`os` 由 userAgent
   判断。同时写 `window.__DS_WEBUI__ = true`——`src/` 判断「是否跑在 WebUI」只读这个标记，WebUI 里
   iOS Safari / Android Chrome 同样走 HTTP 206 的 `pdfstream` / `filestream` 流式读取与浏览器下载，
   不退回整文件 base64。随后同步装好 `__TAURI_INTERNALS__` 与 Tauri 桥，再异步鉴权 + 连接 `/api/ws`。
   应用入口的 chunk 下载与这段握手并行：连接前发出的 invoke 由 `bootstrap.ts` 的 `outboundQueue`
   排队，socket `open` 时立刻冲刷，因此不影响命令时序；公网 RTT 150–250ms 下省掉一整段入口下载等待。
2. `convertFileSrc` 被预装的 `__TAURI_INTERNALS__` Proxy 改写到 `/api/protocol/<scheme>?path=<绝对路径>`，
   `electron/preload/bridge.ts` 不改。
3. 浏览器没有的窗口、对话框、剪贴板、`opener` 命令在客户端本地应答（`plugin:window|*`、`plugin:dialog|*`、
   `plugin:clipboard-manager|*`、`plugin:opener|*`）；`browser.*` 系列在 WebUI 里直接抛错
   （`embedded native browser surface … is unavailable in WebUI mode`）。
4. 原生拖拽被替换为 HTML5 拖放：文件先 `POST /api/files/stage` 落到服务端暂存目录，再补发
   `tauri://drag-enter / drag-over / drag-drop`，所以 `UnifiedDragDropZone` 在桌面与浏览器里行为一致。
5. 多个浏览器标签页各自开一条 WebSocket，服务端把它们多路复用到同一个逻辑窗口 `main`
   （`gateway.ts` 的 `tabs` 表），`window.listWindows` 永远只有一个窗口。
6. 构建配置与桌面共用 `src/platform/chunk-strategy.ts`（分包）与 `src/platform/official-plugins.ts`
   （官方 UI 插件表），区别只在入口与产物目录。WebUI 额外开启两项分包（桌面构建不传这两个选项，
   `manualChunks` 与 `scripts/plugins/chunk-graph.mjs` 的黄金图保持 100% 不变）：延迟语言包按语言合并，
   应用壳按层归成 `app-main` / `workbench-core` / `chat-core`（见 §5）。构建收尾还会把构建指纹写进
   `dist-web/sw.js` 的 `__DS_WEB_BUILD_HASH__` 占位符（见 §4.1）。

## 2. 开发与生产运行

| 命令 | 行为 |
|---|---|
| `npm run web` | 开发模式：同进程内挂 Vite（middleware 模式，HMR 复用同一个 HTTP 服务），默认 `http://127.0.0.1:1428` |
| `npm run build:web` | 构建产物到 `dist-web/`（`vite build --config web/vite.config.ts`，先写 `dist-web.next` 再整目录切换，构建期间线上实例仍服务上一版） |
| `npm run web:prod` | 生产模式：静态服务 `dist-web/`，`/manifest.webmanifest` 与 `/sw.js` 从 `dist-web/` 或 `web/public/` 取 |
| `node web/server/main.ts --port 8080 --host 0.0.0.0` | 追加参数覆盖监听地址（另有 `--prod`、`--no-auth`） |

启动成功会打印 `WebUI + PWA ready at http://<host>:<port>/?token=<token>`。首次访问用带 `token` 的地址，
服务端把它换成会话 Cookie，客户端随后从地址栏抹掉该参数（`stripUrlAuthToken`）。

环境变量（`web/server/main.ts`、`web/server/gateway.ts`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DS_WEB_HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` / `::` 时启动日志里的地址改用 `127.0.0.1` |
| `DS_WEB_PORT` | `1428` | 监听端口 |
| `DS_WEB_PROD` | 未设置 | `1` 等价于 `--prod` |
| `DS_WEB_TOKEN` | 随机生成 | 访问令牌，未设置时 `randomBytes(24).toString('hex')`（48 位十六进制） |
| `DS_WEB_NO_AUTH` | 未设置 | `1` 关闭令牌校验（等价 `--no-auth`），仅限可信本机环境 |
| `DS_APP_DATA_DIR` | 按 tauri identifier 解析 | 应用数据目录；暂存与导出目录建在它下面 |
| `DS_MIGRATIONS_DIR` | `src-tauri/migrations` | Host 存储插件读取的迁移目录 |
| `DS_HOST_PROFILE` | 由 `resolveHostProfile` 决定 | Host profile 覆盖 |
| `DS_WEB_TRUST_PROXY` | 未设置 | `1` 时无条件采信反向代理写入的 `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Forwarded-For`；未设置时只对回环来源采信（见 §3.2） |

服务端与桥接自测：`npx vitest run -c vitest.host.config.ts web/tests/`（56 个用例，覆盖真实 Host RPC、
SQLite、二进制 `Uint8Array` IPC 与 `installTauriBridge` 链路，以及鉴权限流、`Secure` Cookie 判定、
压缩协商、静态缓存与 404 语义）。

## 3. 安全模型

### 3.1 访问令牌与会话 Cookie

- 令牌来源：`DS_WEB_TOKEN`；未设置时每次启动随机生成并打印在终端。比对用 `timingSafeEqual` 常量时间。
- 三种携带方式都接受：`?token=` 查询参数、`Authorization: Bearer …`、会话 Cookie。
- Cookie 由 `POST /api/auth/session` 下发（也支持表单登录页）：`ds_web_session=<token>; Path=/; HttpOnly;
  SameSite=Strict; Max-Age=2592000`（30 天）。`Secure` 由 `isSecureRequest` 自动判定：请求是 HTTPS，或
  来自**受信代理**且 `X-Forwarded-Proto: https` 时带上 `Secure`；明文 HTTP 直连则不带（否则浏览器会
  直接丢弃这个 Cookie，本机明文部署会永远登录不上）。
- 令牌爆破限流（`AuthRateLimiter`）：服务端默认同一客户端 60 秒内失败 15 次后封禁到最早一次失败滑出窗口，响应带
  `Retry-After`；内存有界（最多 2048 个 key，每个 key 最多 15 个时间戳），成功登录后清除失败记录，
  封禁期间即使提交正确令牌也返回 429。客户端标识只在受信代理时才用 `X-Forwarded-For`，否则一律用 socket 地址。
- 未认证时：页面请求返回 401 与内联登录页（`Cache-Control: no-store`），`/api/*` 返回 JSON
  `{"error":"Unauthorized"}`。除 `/api/auth/session` 与下列 PWA 安装入口外，所有路径都在校验之后
  （含 `/`、`/sw.js`）。放行的只有 `manifest.webmanifest`、`app-icon.png`、`icon-192.png`、
  `icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png`、`favicon.ico`——iOS Safari 与
  Android Chrome 的系统级「添加到主屏幕」抓取器不带 Cookie，不提前放行就装不上。
- 基线安全头（所有响应，含 401/403/404）：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: SAMEORIGIN`。
- `/api/ws` 的 `Upgrade` 单独校验：先同源，再鉴权，失败分别 403 / 401。

### 3.2 同源校验

`isSameOriginRequest` 比较 `Origin` 的 host 与 `Host` 头；没有 `Origin` 头视为同源。该检查用在
`POST /api/auth/session`、`POST /api/files/stage`、`POST /api/files/prepare-save` 与 `/api/ws`
的升级请求上，其余请求依赖会话 Cookie。

反向代理部署（Nginx / Caddy / Traefik）因此有三条要求：`Host` 必须是对外域名（否则同源判定失败返回
403），`/api/ws` 的 `Upgrade` 必须透传，`Range` 头必须透传（否则视频、PDF 与音频退化为整文件下载）。

代理改写 `Host` 时需要额外配置 `DS_WEB_TRUST_PROXY=1`：这时 `isSameOriginRequest` 会接受
`X-Forwarded-Host` 的第一个值，`isSecureRequest` 会接受 `X-Forwarded-Proto: https`（Cookie 因此带
`Secure`），限流也会改用 `X-Forwarded-For`。未设置该变量时，这些头只有来自回环地址才采信——公网直连
的客户端可以随便写它们，无条件采信等于让对方伪造「HTTPS」并把所有人算成同一个 IP。

### 3.3 路径隔离

- `FsScope`（`fs` 插件运行时）与 `assetScope`（资源协议）分别由 `deriveScopes(src-tauri/capabilities)` 和
  `tauri.conf.json` 的 `assetScope.allow/deny` 派生，`userDataDir` 参与解析；二者是两份独立白名单。
- 暂存与导出目录 `<appDataDir>/web-staging`、`<appDataDir>/web-exports` 同时加入两份白名单。
- 上传：单文件上限 `200 MB`（`MAX_STAGE_UPLOAD_BYTES`），文件名经 `sanitizeUploadFileName` 归一化后以 `wx` 写入。
- 导出：`prepare-save` 生成 30 分钟有效的 `exportId`，下载前再校验路径仍落在 `web-exports` 下。
- 拖放落地的每个路径逐个 `allowFile`，其余路径仍被拒绝。

### 3.4 HTTP 206 Range 分片

`/api/protocol/<scheme>?path=<绝对路径>` 复用 `assetResponse`：

| 情形 | 响应 |
|---|---|
| 单区间 | `206`，带 `Content-Range: bytes <start>-<end>/<len>`、`Content-Length`、`Accept-Ranges: bytes`；单区间上限 `MAX_LEN = 1000 KiB` |
| 多区间 | `200` + `Content-Type: multipart/byteranges; boundary=…` |
| 区间段数超过 `MAX_RANGES = 64` 或不可满足 | `416`，带 `Content-Range: bytes */<len>` |
| 非 `GET`/`HEAD` | `405` |

MIME 由文件头 8 KiB 嗅探（`MIME_READ_LIMIT`），不依赖扩展名；超过 8 KiB 的文件走流式响应体，句柄交给流关闭。

### 3.5 静态资源的压缩、缓存与 404

`web/server/main.ts` 的静态文件通道（`dist-web/` 与 `public/`）：

| 项目 | 行为 |
|---|---|
| 压缩 | 可压缩扩展名（含 `.js` `.css` `.json` `.webmanifest` `.svg` `.wasm` `.bcmap` `.ttf` `.otf`，`.ttf` 是 PDF.js 标准字体）且大于 512 字节时，异步同时产出 `br`（Brotli 质量 4）与 `gzip`，按 `Accept-Encoding` 择优下发；压缩在 `node:zlib` 的线程池里跑，不占事件循环 |
| 缓存 | `/assets/*`（文件名带内容哈希）强缓存，LRU 有界：最多 256 个条目 / 128 MiB；`index.html`、`sw.js`、`manifest.webmanifest`、字体等需重验的文件单独一份 64 条目缓存（带 size + mtime） |
| 重验 | 提供弱 `ETag`（大小 + mtime）与 `If-None-Match` 比较，命中返回 `304`；`index.html` / `sw.js` / `manifest.webmanifest` 用 `no-cache` |
| 缺失文件 | 带扩展名的路径找不到就是 `404` + `Cache-Control: no-store`——错误页永不被浏览器或 Service Worker 缓存住 |

## 4. 两种 PWA 形态

### 4.1 已落地：Remote-Host App-Shell PWA

Host 留在 Node 侧（本机或内网服务器），浏览器只缓存应用壳。可以用 `web/server/main.ts` 直接提供服务，也放在
反向代理后面。

`web/public/manifest.webmanifest`：`id` / `start_url` / `scope` 均为 `/`，`display: standalone`，
`display_override` 为 `["standalone", "minimal-ui"]`，`theme_color` 与 `background_color` 均为 `#121212`，
`categories` 为 education / productivity / books。图标是标准三件套 `192x192`、`512x512` 与
`icon-maskable-512.png`（`purpose: maskable`），另保留 `app-icon.png`（1024）。`shortcuts` 声明了三条
（新建对话 `/?shortcut=chat`、资源库 `/?shortcut=library`、复习 `/?shortcut=review`），
`file_handlers` 声明了 PDF / Markdown / apkg。系统里双击这些文件时由 `launchQueue`（`bootstrap.ts` 的
`installPwaSupport`）接住：`FileSystemFileHandle.getFile()` → `POST /api/files/stage` 落到服务端暂存目录 →
补发 `tauri://drag-drop`，与 HTML5 拖放走同一条导入管线。

`web/public/sw.js`（缓存名 `ds-webui-shell-v1-<build hash>`，构建期注入）：

| 请求 | 策略 |
|---|---|
| 非 `GET`、带 `Range` 头、跨源 | 不拦截 |
| `/api/*`、`/@vite`、`/@fs/`、`/src/`、`/node_modules/` 等开发路径 | 直接放行 |
| `/assets/`（内容哈希产物） | Cache-First（只缓存 `200` 且非 `text/html` 的响应） |
| `/cmaps/`、`/standard_fonts/`、`/wasm/`、`/fonts/`、`/pdf.worker.min.mjs` | Stale-While-Revalidate：先给缓存，后台换新 |
| 导航请求与 `APP_SHELL_URLS` | Network-First，失败回退缓存，导航回退 `'/'`，最后是无网络占位页 |

只缓存「`200` 且非 HTML」是硬要求：登录闸门与错误页一旦进缓存，应用就会彻底打不开。

构建指纹：`web/vite.config.ts` 的 `writeBundle` 在拷完 `manifest.webmanifest` / `sw.js` 之后，用
`dist-web/index.html` 内容 + `dist-web/assets/` 排序后的文件名算 12 位 SHA-256，替换 `sw.js` 里的
`__DS_WEB_BUILD_HASH__`。缓存名因此随产物变化，`activate` 时自动删掉旧版本缓存；`sw.js` 本身带
`no-cache`，浏览器每次启动都会重验，新 worker 装上后由界面提示「刷新启用」（`SKIP_WAITING` +
`controllerchange`）才接管，不会在看文档的中途换掉页面。

注册时机：只在生产构建或地址带 `?pwa=1` 时注册（`installPwaSupport`），作用域 `/`。安装时预缓存
`/`、`/manifest.webmanifest`、`/boot.css`、`/boot-theme.js`、`/error-filter.js`、各尺寸图标与 logo；
激活时删除其他版本的缓存并 `clients.claim()`。`beforeinstallprompt` 仍然 `preventDefault()`，但界面右下角
给出自己的「安装到桌面 / 暂不」胶囊（关闭后写 localStorage 不再提示），否则这个事件被吞掉、用户再也装不了。

安装条件：

- 浏览器只在安全上下文提供 Service Worker，即 `https://` 或 `http://localhost`；内网 IP 的明文 HTTP 不能安装。
- 除登录接口与 §3.1 列出的 manifest / 图标外，其余路径都需要会话 Cookie；`web/index.html` 的 manifest
  链接带 `crossorigin="use-credentials"`，页面本身仍需先登录。
- 离线时只有壳可用：`/api/*` 与带 `Range` 的请求都不缓存，Host RPC 与文件流不可用。

### 4.2 可扩展：Local-Worker 全离线 PWA

复用移动端已经在跑的 Local-Worker 装配（`mobile/src/worker/host-worker.ts`），把 Host 放进浏览器 Worker，
存储落到 OPFS，从而去掉 Node 服务：

1. 主线程建 `MessageChannel`，`worker.postMessage({ kind: 'dstu-connect', port }, [port])`
   （`mobile/src/shell/host-supervisor.ts`）。
2. Worker 用这条 port 跑 `serveHost`（`host/kernel/connection.ts`），契约是构建期打入的 `bundledContracts`，
   插件来自 `host/profiles/mobile.json` 的静态条目，壳提供 `sqliteRuntime` 服务。
3. SQLite 用 `@sqlite.org/sqlite-wasm` 的 `opfs-sahpool` VFS：`name: 'dstu-opfs'`、
   `directory: '.deep-student'`、`initialCapacity: 32`；pool 被别的 Worker 占用时重试 7 次（累计 9.5 秒），
   仍失败则各库按“被锁定”打开并记录 `poolError`（`mobile/src/worker/sqlite-runtime.ts`）。
4. 迁移 SQL 来自 `src-tauri/migrations/{vfs,chat_v2,mistakes,llm_usage}/*.sql`，以 `?raw` 原样注入，与桌面同源。
5. 同一来源只能有一个 Worker 持有 OPFS 同步访问句柄，所以全离线形态必须让 Host 独占一个专用 Worker。

这条路径与 WebUI 的差别主要在传输层与外壳：`src/` 不变，`installTauriBridge` 的 transport 换成 MessagePort，
不再需要 `web/server/*`。当前阻断项是可移植性，实测数据：

```
node scripts/portability/scan.mjs --profile host/profiles/mobile.json
profile host/profiles/mobile.json: 33 module(s), 7 reach Node-specific dependencies at runtime   （退出码 1）
```

26 个模块通过，7 个失败，全部追到同一批 Node 专有依赖：

| 失败模块 | 触达的 Node 专有依赖 |
|---|---|
| `dstu.agent-orchestration`、`dstu.agent-skills`、`dstu.chat`、`dstu.chat-pipeline`、`dstu.sync`、`dstu.sync-providers`、`dstu.vfs` | `host/plugins/sync-providers/src/v5_{framed_pack,index_and_checkpoint,keyring}.ts` 的 `node:crypto` 与全局 `Buffer`；`host/plugins/sync/src/{dspair2,fractional-index,run-sync,v5-runtime-bridge,version-vector}.ts` 的 `node:crypto` / `node:buffer` 与 `Buffer` |

全量（桌面插件）基线，供对照：

```
node scripts/portability/scan.mjs
portability: 29 plugins, 1745 production files; 1597 (91.52%) without Node-specific imports,
1578 (90.43%) runtime-portable; effort ≈ 37.24 person-days
```

也就是说，OPFS 存储与 Worker 装配已经可用，剩下的是 `host/plugins/sync`、`host/plugins/sync-providers`
把 `node:crypto` 与 `Buffer` 换成 WebCrypto 与 `Uint8Array`，再为壳补上浏览器侧的 `files` / `net` 实现。
7 个失败同源，命中文件只有上表列出的 8 个，没有别的 Node 依赖混在里面。

## 5. 公网（WAN）路径上的延迟优化

局域网里几乎感觉不到的往返，在公网 RTT 150–250ms 下会直接变成首屏与打开页面时的等待。这一段是三层各自做的事。

### 5.1 首屏与页面 chunk 图（`src/platform/chunk-strategy.ts`）

WebUI 构建给 `createManualChunks` 传两个桌面构建不传的选项
（`groupLocaleChunks`、`groupWebAppShell`），桌面 `manualChunks` 的行为与
`scripts/plugins/chunk-graph.mjs` 的黄金图 100% 不变：

| 分组 | 内容 | 为什么 |
|---|---|---|
| `locales-zh-CN` / `locales-en-US` | `src/i18n.ts` 里 `import.meta.glob` 的延迟语言包（`common` / `sidebar` 除外） | 92 个 JSON → 2 个 chunk，切换语言不再几十个请求 |
| `app-main` | `src/main.tsx` 的静态闭包，含 WebUI 只做一次静态转发的虚拟入口 `virtual:dstu-web-app-entry` | `import('virtual:dstu-web-app-entry')` 直接命中 `app-main.js`，首屏不再被匿名共享 chunk 挡在前面 |
| `workbench-core` | `WorkbenchDesktop.tsx` 静态闭包，去掉 `app-main` / `vendor-*` / `ui-boot` | 桌面是默认首页，原先闭包里约 120 个共享小 chunk（大量 zustand `create()` 副作用模块）要排 20 轮 RTT；归组后这些共享模块并成 1 个 `workbench-core`，剩下的请求都是本来就必需的 vendor chunk |
| `chat-core` | `ChatV2Page` 静态闭包，再去掉整块 workbench 闭包 | 打开聊天同样只多 1 个请求；WorkbenchDesktop 里点开聊天时 `workbench-core` 已加载 |

同一份源码的 A/B 构建实测（`node --max-old-space-size=8192 vite build`，产物约 890 个 chunk）：

| 指标 | 改前 | 改后 |
|---|---|---|
| 挂载默认桌面（WorkbenchDesktop）的请求数 | 121 | 12 |
| 其中 <5 KB 的小 chunk | 47 | 2 |
| 挂载默认桌面下载量 | 5.27 MiB | 4.15 MiB |
| 桌面已挂载后打开聊天的请求数 | 与桌面混在同一批共享 chunk 里 | 1（`chat-core` 93 KB） |
| 首屏（入口 + 应用壳 + 依赖）请求数 | 8 | 7 |
| 首屏下载量 | 5.02 MiB | 5.17 MiB |
| 首屏应用 chunk | 匿名 `workshop-*.js` 3.68 MB（`experimentalMinChunkSize` 拼出来的） | 命名 `app-main-*.js` 4.55 MB |

`app-main` 比原来的匿名块大，是因为 Rollup 的函数式 `manualChunks` 会把被点名模块的**全部**
静态依赖（包括在应用壳里被 tree-shake、只有懒加载页面才用到的那部分）一起卷进同一 chunk——
实测约 870 KB。不点名更糟：`workbench-core` / `chat-core` 的隐式拉取会把应用壳模块吞进那
2.4 MB 的桌面 chunk，首屏就要静态 import 它。真正的首屏瘦身需要动 `src/main.tsx` 的静态闭包
（例如 `src/app/pluginWorkshop.ts` 直接 import 整个 `@/features/plugin-workshop` barrel，
把聊天卡片渲染链带进了应用壳），不属于构建配置的范围。

归组是「按静态闭包整块认领」，因此 chunk 之间的静态 import 是严格 DAG：
`vendor-*` ← `entry` ← `{app-main, ui-boot}` ← `workbench-core` ← `chat-core`（箭头表示「被 import」，
即 `chat-core` 可以静态 import `workbench-core`，反之永不发生）。
每个分组都排除三类模块，保证不会有反向边：被 vendor 分组模块所引用的（`vendorReach`）、
`ui-boot` 自己的、以及另一层已经在用的。`computeWebAppShellGroups` 里还有一层固定点剪枝
（与 `computeStartupBootGroup` 同一套判据）作兜底，任何越界模块会被踢出分组、退回 Rollup 默认安置，
而不是产出一个成环的 chunk 图；真出现环时 `failOnCircularChunk` 直接把构建判失败。

`web/vite.config.ts` 的两处取舍（都来自实测）：

- 不再设置 `experimentalMinChunkSize`：它会把 `src/main.tsx` 的动态入口并进一个大共享 chunk
  （连带 `vendor-katex` 708 KB、`vendor-markdown-shared` 400 KB 一起进首屏），还会让应用 chunk
  反向静态 import 入口 chunk。请求数问题改由上面的显式分组解决。
- 不加 `onlyExplicitManualChunks`：它让手动 chunk 只装点名模块，漏掉的模块变成自动 chunk 后同时
  被 vendor chunk 与应用壳引用，实测直接成环、构建失败
  （`vendor-i18n -> ReviewQuestionsView -> app-main -> vendor-i18n`）。

### 5.2 传输层（`web/server/ws.ts`、`web/client/bootstrap.ts`）

| 机制 | 行为 |
|---|---|
| 压缩 | 协商 RFC 7692 `permessage-deflate`（`server_no_context_takeover; client_no_context_takeover`）；文本帧 ≥ 256 字节才压（ACK / `listen` 这类小帧压缩后更大） |
| 心跳 | 服务端每 25 秒发 PING，连续两个周期没有任何入站帧就判定对端消失并销毁连接（手机锁屏、NAT 超时由 TCP keepalive 30s 与心跳一起兜底） |
| 断线语义 | socket 断开时，所有已发出未收到结果的 `invoke` 立即以错误结束——不再出现 `await invoke(...)` 永久挂起、界面卡在加载态 |
| 重连 | 指数退避 `500ms × 1.8^n`（带 0.85–1.15 抖动），界面显示重连横幅；第 2 次失败后开始探测登录态（Cookie 过期时提示重新登录），恢复后显示「已重新连接」 |
| 只读调用合并 | 启动期十几处组件同时发的只读 RPC（`get_setting`、`get_api_configurations`、`chat_v2_list_sessions` 等 11 个命令）合并成一次主帧 + 多个等结果的调用方，再加一份极短 TTL 读缓存；任何可能写入的调用都会清空该缓存，保证写后读立即可见 |

实测背景：首屏曾出现 55 次 `get_setting`、3 次 `get_api_configurations`（每次 106.8 KB），
全是同 key 的重复往返。

### 5.3 Chromium WAN/PWA 验收（2026-11-11）

Chromium 148.0.7778.96，无浏览器缓存的新 context；CDP 设置 HTTP 延迟 150 ms、
下行 20 Mbps、上行 5 Mbps，并为 Service Worker target 单独启用相同设置。
观察窗口为导航开始至应用壳可见后 5 秒，字节数汇总页面与 Service Worker 的
`Network.loadingFinished.encodedDataLength`，不含 WebSocket 载荷。
这是 CDP 网络模拟，不等同于给 WebSocket TCP 链路施加真实 WAN 延迟。

改前为 `6576c9559` 的前端构建、HTTP 与 WS 服务代码；两版复用当前 Host 网关和同一份本地数据，
避免混用两份 Host 模块导致 ACL/类型身份不一致。该对比验证启动传输与分包，
不用于衡量网关本身的性能。改后构建缓存名为 `ds-webui-shell-v1-b450c3d13959`。

| 指标 | 改前 | 改后 |
|---|---:|---:|
| 冷启动 DOMContentLoaded | 380 ms | 353 ms |
| 冷启动应用壳可见 | 8377 ms | 5271 ms |
| 冷启动页面 HTTP 请求（含 SW 命中） | 184 | 57 |
| 冷启动实际 HTTP 请求（含 SW 后台请求，排除缓存命中） | 192 | 68 |
| 冷启动编码网络字节 | 4533913 | 3832663 |
| 冷启动 WS 发 / 收帧 | 170 / 226 | 175 / 232 |
| 热重载应用壳可见（SW 已接管） | 2127 ms | 2286 ms |
| 热重载实际 HTTP 请求 | 6 | 6 |
| 热重载编码网络字节 | 1396 | 1949 |
| 热重载 WS 发 / 收帧 | 174 / 228 | 173 / 228 |
| 控制台错误 / 页面错误 | 0 / 0 | 0 / 0 |

冷启动改善，热重载本次没有改善；单次样本不据此宣称稳定加速比例。
改后页面收到 54 个 `Content-Encoding: br` 响应，WebSocket 握手确认
`permessage-deflate; server_no_context_takeover; client_no_context_takeover`。
Chromium 真实 RPC 传回 42889 字符，与发送的路径数组拼接结果逐字相等，小响应也成功。
裸帧测试覆盖小/空压缩消息、BFINAL=0/1、压缩分片中穿插 PING、混合压缩/未压缩消息、
解压输出上限、RSV1 非法位置及心跳超时。

iPhone Safari UA（实际引擎仍为 Chromium，非真机 Safari）打开真实 PDF / MP4 文件：
PDF 正文渲染成功并观察到 `pdfstream` 的 `206 bytes 458752-464615/464616`；
MP4 的 `filestream/<encodedPath>?mime=video%2Fmp4` 返回 `206 bytes 0-3406/3407`，
播放器 `readyState=4`。预览期间没有 `read_file_bytes` / `vfs_get_attachment_content` 整文件 WS 读取。
独立的 `Range: bytes=0-15` 请求也分别返回正确 MIME、16 字节与 206。
缺失 `/assets/NonExistent.js` 从改前的 `200 + immutable` 变为 `404 + no-store`。

验收命令：`npm run build:web`、`npm run typecheck:native`、
`node scripts/check-frontend-layers.mjs`、`npx vitest run src/platform/__tests__/`（35 项）、
`npx vitest run -c vitest.host.config.ts web/tests/`（56 项），以及平台/上传/导出/媒体/PDF 加载单测（38 项），均通过。

## 6. 相关文件

| 文件 | 内容 |
|---|---|
| `web/server/main.ts` | HTTP 服务、鉴权、静态资源（压缩 / 缓存 / 404）、Vite 中间件、CLI 与环境变量 |
| `web/server/auth.ts` | 令牌、会话 Cookie（含 `Secure` 判定）、同源判定、爆破限流 |
| `web/server/gateway.ts` | Host 装配、多标签页复用、资源协议、文件暂存与导出 |
| `web/server/ws.ts` | RFC 6455 握手与帧、RFC 7692 deflate、心跳 |
| `web/shared/wire.ts` | WebSocket 编解码（文本帧 + 二进制帧） |
| `web/client/bootstrap.ts` | 浏览器外壳、`installTauriBridge`、拖放、只读合并、重连、PWA 注册与安装/更新提示 |
| `web/public/manifest.webmanifest`、`web/public/sw.js` | PWA 清单与缓存策略（`sw.js` 里的构建指纹由构建期注入） |
| `web/vite.config.ts` | WebUI 构建配置（入口替换、WebUI 分包、构建指纹注入、官方插件表） |
| `src/platform/chunk-strategy.ts` | 桌面与 WebUI 共用的 vendor / `ui-boot` / 语言包 / 应用壳分包规则 |
| `mobile/src/worker/host-worker.ts`、`mobile/src/worker/sqlite-runtime.ts` | Local-Worker 与 OPFS SQLite |
| `scripts/portability/scan.mjs` | 可移植性扫描（含 `--profile host/profiles/mobile.json`） |
