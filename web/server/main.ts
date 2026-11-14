/**
 * Deep Student WebUI + PWA Server (`npm run web`).
 *
 * Mounts:
 * - In-process Desktop Host (`serveHost` + `ShellRuntime`) via `createWebHostGateway`;
 * - RFC 6455 WebSocket IPC endpoint (`/api/ws`);
 * - HTTP 206 Range custom protocol endpoints (`/api/protocol/asset`, `/api/protocol/pdfstream`, etc.);
 * - Browser file staging & export endpoints (`/api/files/stage`, `/api/files/prepare-save`, `/api/files/export`);
 * - Access-token + HttpOnly session cookie auth (`/api/auth/session` + interactive login gate);
 * - Vite dev server middleware (default) or static `dist-web/` + PWA `manifest.webmanifest` / `sw.js` (`--prod`).
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

import {
  AuthRateLimiter,
  clientAddressForRequest,
  constantTimeEquals,
  createWebAuth,
  extractBearerToken,
  isRequestAuthenticated,
  isSameOriginRequest,
  isTrustedProxyRequest,
  setSessionCookie,
  type WebAuthConfig,
} from './auth.ts';
import { createWebHostGateway, type WebHostGateway } from './gateway.ts';
import { acceptWebSocketUpgrade, rejectUpgrade } from './ws.ts';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/vnd.microsoft.icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.xml': 'application/xml; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/** iOS / Android 系统级取图器不带会话 cookie，这些 PWA 入口必须在鉴权之前放行。 */
const PUBLIC_PWA_PATHS = new Set([
  '/manifest.webmanifest',
  '/app-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
]);

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

export interface StartWebServerOptions {
  host?: string;
  port?: number;
  prod?: boolean;
  distDir?: string;
  repoRoot?: string;
  appDataDir?: string;
  token?: string | null;
  disableAuth?: boolean;
  safeMode?: boolean;
  /** 单次文件暂存上限（字节），默认 200 MiB。 */
  maxStageUploadBytes?: number;
  /** 是否信任反代写入的 `X-Forwarded-*` 头（默认只看本机回环来源）。 */
  trustProxy?: boolean;
  /** 每分钟允许的认证失败次数，超过后封禁该客户端，默认 15。 */
  maxAuthFailuresPerMinute?: number;
  log?: (message: string) => void;
}

export interface RunningWebServer {
  readonly url: string;
  readonly token: string | null;
  readonly port: number;
  readonly host: string;
  readonly gateway: WebHostGateway;
  readonly server: Server;
  close(): Promise<void>;
}

function renderLoginGateHtml(errorText = ''): string {
  const escapedError = errorText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover" />
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fdfcfb" />
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121212" />
  <title>Deep Student WebUI — Deep Student 网页工作台</title>
  <style>
    :root {
      color-scheme: dark;
      --background: 0 0% 7%;
      --foreground: 0 0% 96%;
      --card: 0 0% 9.8%;
      --card-foreground: 0 0% 96%;
      --muted-foreground: 0 0% 60%;
      --border: 0 0% 18%;
      --input: 0 0% 14%;
      --ring: 214 58% 68%;
      --destructive: 0 55% 45%;
      --status-working: 152 55% 42%;
      --button-primary-surface: hsl(0 0% 96% / 0.12);
      --button-primary-surface-hover: hsl(0 0% 96% / 0.18);
      --button-primary-fg: hsl(0 0% 96%);
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --background: 40 20% 99%;
        --foreground: 220 9% 18%;
        --card: 0 0% 99%;
        --card-foreground: 220 9% 18%;
        --muted-foreground: 220 6% 42%;
        --border: 0 0% 88%;
        --input: 0 0% 95%;
        --ring: 214 62% 50%;
        --destructive: 0 65% 51%;
        --status-working: 152 60% 36%;
        --button-primary-surface: hsl(220 9% 18% / 0.9);
        --button-primary-surface-hover: hsl(220 9% 18% / 0.82);
        --button-primary-fg: hsl(0 0% 100%);
      }
    }
    * { box-sizing: border-box; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding:
        max(24px, env(safe-area-inset-top))
        max(24px, env(safe-area-inset-right))
        max(24px, env(safe-area-inset-bottom))
        max(24px, env(safe-area-inset-left));
      overflow-y: auto;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
      -webkit-text-size-adjust: 100%;
    }
    .card {
      width: 100%;
      max-width: 380px;
      padding: 28px 24px;
      border-radius: 12px;
      background: hsl(var(--card));
      color: hsl(var(--card-foreground));
      border: 1px solid hsl(var(--border) / 0.35);
      animation: ds-gate-enter 180ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes ds-gate-enter {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none !important; }
    }
    .status-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.75rem;
      color: hsl(var(--muted-foreground));
      margin-bottom: 12px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      background: hsl(var(--status-working));
      flex-shrink: 0;
    }
    .divider {
      height: 1px;
      border: 0;
      background: hsl(var(--border) / 0.35);
      margin: 0 0 16px;
    }
    h1 { margin: 0 0 6px; font-size: 1.05rem; font-weight: 600; line-height: 1.35; }
    p { margin: 0 0 18px; font-size: 0.85rem; color: hsl(var(--muted-foreground)); line-height: 1.5; }
    .field-label {
      display: block;
      margin: 0 0 6px;
      font-size: 0.82rem;
      font-weight: 500;
      color: hsl(var(--foreground));
    }
    input {
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid hsl(var(--border) / 0.35);
      background: hsl(var(--input));
      color: hsl(var(--foreground));
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 16px;
      outline: none;
    }
    input:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }
    input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    button {
      margin-top: 14px;
      width: 100%;
      min-height: 44px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid hsl(var(--border) / 0.35);
      background: var(--button-primary-surface);
      color: var(--button-primary-fg);
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: var(--button-primary-surface-hover);
    }
    button:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .err {
      margin-top: 12px;
      font-size: 0.82rem;
      color: hsl(var(--destructive));
      line-height: 1.45;
    }
    .err:empty {
      display: none;
    }
  </style>
</head>
<body>
  <form id="ds-web-token-form" class="card" method="POST" action="/api/auth/session">
    <div class="status-header">
      <span class="status-dot" aria-hidden="true"></span>
      <span>Deep Student WebUI</span>
    </div>
    <hr class="divider" />
    <h1>Deep Student 网页工作台</h1>
    <p>输入服务端终端输出的访问令牌以连接宿主服务</p>
    <label for="ds-token-input" class="sr-only">访问令牌</label>
    <label for="ds-token-input" class="field-label" aria-hidden="true">访问令牌</label>
    <input id="ds-token-input" type="password" name="token" placeholder="访问令牌" autocomplete="current-password" autofocus required />
    <button id="ds-web-token-submit" type="submit">验证并进入</button>
    <div id="ds-web-token-error" class="err" role="alert" aria-live="polite">${escapedError}</div>
  </form>
  <script>
    (function () {
      var form = document.getElementById('ds-web-token-form');
      var btn = document.getElementById('ds-web-token-submit');
      if (!form || !btn) return;
      form.addEventListener('submit', function () {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '正在验证…';
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Session cookie 是否必须带 `Secure`：TLS 终止在反向代理时（`X-Forwarded-Proto: https`）浏览器侧就是 HTTPS。
 * 也识别直连 TLS 的 `socket.encrypted`。前端口可能携带逗号分隔列表（多级代理），取第一段。
 *
 * `X-Forwarded-Proto` 只在请求来自受信代理时采信：公网直连的客户端可以随便写这个头，
 * 采信它等于允许把 `Secure` cookie 从 HTTPS 降级拿到 HTTP 上重放。
 */
function isSecureRequest(req: IncomingMessage, trustProxy = false): boolean {
  if (isTrustedProxyRequest(req, trustProxy)) {
    const forwarded = req.headers['x-forwarded-proto'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const proto = raw?.split(',')[0]?.trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

async function readSmallTextBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

const COMPRESSIBLE_EXTS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.wasm', '.txt', '.bcmap',
  '.ttf', '.otf', '.xml', '.ico',
]);

/** 弱 ETag：大小 + mtime，内容不变时跨进程重启也稳定。 */
function staticWeakEtag(info: { size: number; mtimeMs: number }): string {
  return `W/"${info.size}-${Math.round(info.mtimeMs)}"`;
}

/** RFC 9110 §13.1.2 弱比较：`W/` 前缀不参与比较，逗号分隔的候选逐个比对。 */
function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const candidates = Array.isArray(header) ? header.join(',') : header;
  const opaque = etag.replace(/^W\//, '');
  return candidates.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//, '') === opaque;
  });
}

interface CachedStatic {
  raw: Buffer;
  gzip: Buffer | null;
  br: Buffer | null;
  mime: string;
  etag: string;
}

const gzipAsync = promisify(gzip) as (input: Buffer, options?: { level?: number }) => Promise<Buffer>;
const brotliAsync = promisify(brotliCompress) as (input: Buffer, options?: object) => Promise<Buffer>;
/** 质量 4：4 MiB 分块约 15ms，压缩率与 q11 相差不到 3%，但不卡事件循环。 */
const BROTLI_STATIC_OPTIONS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } };

/** `/assets/*`（内容哈希文件名）强缓存：有界，避免大分块把内存吃穿。 */
const IMMUTABLE_CACHE_MAX_ENTRIES = 256;
const IMMUTABLE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const immutableAssetCache = new Map<string, CachedStatic & { bytes: number }>();
let immutableCacheBytes = 0;

/** `index.html` / `sw.js` / `manifest.webmanifest` / 字体等每次都要重验的文件：避免重复读盘与重复压缩。 */
const REVALIDATED_CACHE_MAX_ENTRIES = 64;
const revalidatedStaticCache = new Map<string, CachedStatic & { mtimeMs: number; size: number }>();
// 冷启动或文件变更时，同一资源的并发请求共用读盘与两种压缩任务。
const pendingStaticAssets = new Map<string, Promise<CachedStatic | null>>();

async function compressStatic(raw: Buffer, ext: string): Promise<{ gzip: Buffer | null; br: Buffer | null }> {
  if (!COMPRESSIBLE_EXTS.has(ext) || raw.byteLength < 512) return { gzip: null, br: null };
  const [gzipResult, brotliResult] = await Promise.allSettled([
    gzipAsync(raw),
    brotliAsync(raw, BROTLI_STATIC_OPTIONS),
  ]);
  return {
    gzip:
      gzipResult.status === 'fulfilled' && gzipResult.value.byteLength < raw.byteLength
        ? gzipResult.value
        : null,
    br:
      brotliResult.status === 'fulfilled' && brotliResult.value.byteLength < raw.byteLength
        ? brotliResult.value
        : null,
  };
}

function storeImmutableAsset(file: string, asset: CachedStatic): void {
  const previous = immutableAssetCache.get(file);
  if (previous) immutableCacheBytes -= previous.bytes;
  immutableAssetCache.delete(file);
  const bytes = asset.raw.byteLength + (asset.gzip?.byteLength ?? 0) + (asset.br?.byteLength ?? 0);
  immutableAssetCache.set(file, { ...asset, bytes });
  immutableCacheBytes += bytes;
  while (
    immutableAssetCache.size > IMMUTABLE_CACHE_MAX_ENTRIES ||
    immutableCacheBytes > IMMUTABLE_CACHE_MAX_BYTES
  ) {
    const oldest = immutableAssetCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = immutableAssetCache.get(oldest);
    immutableAssetCache.delete(oldest);
    if (evicted) immutableCacheBytes -= evicted.bytes;
  }
}

function storeRevalidatedAsset(file: string, asset: CachedStatic & { mtimeMs: number; size: number }): void {
  revalidatedStaticCache.delete(file);
  revalidatedStaticCache.set(file, asset);
  while (revalidatedStaticCache.size > REVALIDATED_CACHE_MAX_ENTRIES) {
    const oldest = revalidatedStaticCache.keys().next().value;
    if (oldest === undefined) break;
    revalidatedStaticCache.delete(oldest);
  }
}

async function loadStaticAsset(file: string, kind: 'immutable' | 'revalidated'): Promise<CachedStatic | null> {
  const pending = pendingStaticAssets.get(file);
  if (pending) return pending;
  const loading = readStaticAsset(file, kind);
  pendingStaticAssets.set(file, loading);
  try {
    return await loading;
  } finally {
    pendingStaticAssets.delete(file);
  }
}

async function readStaticAsset(file: string, kind: 'immutable' | 'revalidated'): Promise<CachedStatic | null> {
  if (kind === 'immutable') {
    const cached = immutableAssetCache.get(file);
    if (cached) return cached;
  } else {
    const cached = revalidatedStaticCache.get(file);
    if (cached) {
      // 只 stat（内存缓存里已有的内容不再读盘、不再压缩），mtime/size 变了才重读。
      const cachedInfo = await stat(file).catch(() => null);
      if (cachedInfo?.isFile() && cachedInfo.mtimeMs === cached.mtimeMs && cachedInfo.size === cached.size) {
        return cached;
      }
      revalidatedStaticCache.delete(file);
    }
  }

  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return null;
  const raw = await readFile(file);
  const ext = extname(file).toLowerCase();
  const { gzip: compressed, br } = await compressStatic(raw, ext);
  const asset: CachedStatic = {
    raw,
    gzip: compressed,
    br,
    mime: STATIC_MIME[ext] ?? 'application/octet-stream',
    etag: staticWeakEtag(info),
  };
  if (kind === 'immutable') storeImmutableAsset(file, asset);
  else storeRevalidatedAsset(file, { ...asset, mtimeMs: info.mtimeMs, size: info.size });
  return asset;
}

function selectStaticEncoding(header: string | undefined, asset: CachedStatic): 'br' | 'gzip' | 'identity' | null {
  const qualities = new Map<string, number>();
  for (const item of (header ?? '').toLowerCase().split(',')) {
    const [name, ...parameters] = item.trim().split(';');
    if (!name) continue;
    const parameter = parameters.map((part) => part.trim()).find((part) => part.startsWith('q='));
    const quality = parameter === undefined ? 1 : Number(parameter.slice(2));
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const wildcard = qualities.get('*');
  const candidates: Array<['br' | 'gzip' | 'identity', number]> = [
    ['br', asset.br === null ? 0 : (qualities.get('br') ?? wildcard ?? 0)],
    ['gzip', asset.gzip === null ? 0 : (qualities.get('gzip') ?? wildcard ?? 0)],
    // 未显式指定 identity 时作为回退，而不是抢占客户端接受的压缩表示。
    ['identity', qualities.get('identity') ?? 0],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  if (candidates[0]![1] > 0) return candidates[0]![0];
  return (qualities.get('identity') ?? (wildcard === 0 ? 0 : 1)) > 0 ? 'identity' : null;
}

function sendStaticBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  asset: CachedStatic,
  cacheControl: string,
): void {
  const headers: Record<string, string> = {
    'Content-Type': asset.mime,
    'Cache-Control': cacheControl,
    ETag: asset.etag,
  };
  if (asset.gzip !== null || asset.br !== null) headers.Vary = 'Accept-Encoding';

  // 条件请求：浏览器每次启动都会重验 no-cache 的 HTML / manifest / sw.js，
  // 公网 RTT 150–250ms 下 304 比重新传整份文档省一次完整往返。
  if (matchesIfNoneMatch(req.headers['if-none-match'], asset.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const encoding = selectStaticEncoding(req.headers['accept-encoding'], asset);
  if (encoding === null) {
    res.writeHead(406, { ...headers, 'Content-Length': '0' });
    res.end();
    return;
  }
  if (asset.br !== null && encoding === 'br') {
    res.writeHead(200, {
      ...headers,
      'Content-Encoding': 'br',
      'Content-Length': String(asset.br.byteLength),
    });
    res.end(asset.br);
    return;
  }
  if (asset.gzip !== null && encoding === 'gzip') {
    res.writeHead(200, {
      ...headers,
      'Content-Encoding': 'gzip',
      'Content-Length': String(asset.gzip.byteLength),
    });
    res.end(asset.gzip);
    return;
  }
  res.writeHead(200, {
    ...headers,
    'Content-Length': String(asset.raw.byteLength),
  });
  res.end(asset.raw);
}

interface StaticServeContext {
  distDir: string;
  webPublicDir: string;
  pathname: string;
  req: IncomingMessage;
  res: ServerResponse;
  /** `/assets/*` 的 Cache-Control（令牌模式下是 `private`）。 */
  immutableCacheControl: string;
  revalidatedCacheControl: string;
  /** 本次响应会 `Set-Cookie`（`?token=` 换取会话）时，一律不落缓存。 */
  noStore: boolean;
}

async function serveStaticFromDist(ctx: StaticServeContext): Promise<void> {
  const { pathname, req, res } = ctx;
  const reqExt = extname(pathname).toLowerCase();
  const isHtml = reqExt === '.html';
  // `/assets/*` 或任何带扩展名的路径都是"文件"，找不到就是 404。
  // 回落到 `/index.html` 会把缺失的 `main-abc123.js` 以 200 + `immutable` 缓存成一份 HTML，
  // 之后一年内该 URL 永远返回 HTML —— 整站白屏且无法自愈（P0 缓存污染）。
  const isAssetRequest = pathname.startsWith('/assets/') || (reqExt !== '' && !isHtml);
  const immutableCacheControl = ctx.noStore ? 'private, no-store' : ctx.immutableCacheControl;
  const revalidatedCacheControl = ctx.noStore ? 'private, no-store' : ctx.revalidatedCacheControl;

  if (pathname === '/manifest.webmanifest' || pathname === '/sw.js') {
    const fileName = pathname.slice(1);
    for (const file of [join(ctx.distDir, fileName), join(ctx.webPublicDir, fileName)]) {
      const asset = await loadStaticAsset(file, 'revalidated');
      if (asset) {
        sendStaticBuffer(req, res, asset, revalidatedCacheControl);
        return;
      }
    }
  }

  const root = normalize(ctx.distDir + sep);
  const candidates = isAssetRequest ? [pathname] : [pathname, join(pathname, 'index.html'), '/index.html'];
  for (const candidate of candidates) {
    const file = normalize(join(root, candidate));
    if (!file.startsWith(root)) continue;
    const immutable = candidate === pathname && pathname.startsWith('/assets/');
    const asset = await loadStaticAsset(file, immutable ? 'immutable' : 'revalidated');
    if (!asset) continue;
    sendStaticBuffer(req, res, asset, immutable ? immutableCacheControl : revalidatedCacheControl);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(isAssetRequest ? 'Not Found' : 'Not Found (run `npm run build:web` before `--prod` mode)');
}

/** `decodeURIComponent` 遇到坏转义（`/%E0%A4`）会抛 `URIError`，静态文件路径不该因此 500。 */
function safeDecodePathname(rawPathname: string): string {
  try {
    return decodeURIComponent(rawPathname);
  } catch (error) {
    void error;
    return rawPathname;
  }
}

interface ParsedProtocolRequest {
  scheme: string;
  targetPath: string;
  /** 转发给自定义协议的额外查询串（`mime=video%2Fmp4` 等），不含 `path` / `token`。 */
  extraQuery: string;
}

/**
 * `/api/protocol/<scheme>/<encodedPath>?path=<encodedPath>&mime=...`
 *
 * 必须在 `decodeURIComponent` 之前切分 scheme 与目标路径：目标路径自身含 `%2F` 时，
 * 先解码会把整段拼成一个路径，`realpath` 直接找不到文件。
 */
function parseProtocolRequest(url: URL): ParsedProtocolRequest | null {
  const rawRest = url.pathname.slice('/api/protocol/'.length);
  const slashIdx = rawRest.indexOf('/');
  const rawScheme = slashIdx >= 0 ? rawRest.slice(0, slashIdx) : rawRest;
  const scheme = safeDecodePathname(rawScheme);
  const rawPathSegment = slashIdx >= 0 ? rawRest.slice(slashIdx + 1) : '';
  const rawTarget =
    url.searchParams.get('path') ?? (scheme === 'ds-plugin' ? rawPathSegment : safeDecodePathname(rawPathSegment));
  if (!scheme || !rawTarget) return null;

  const extra = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key === 'path' || key === 'token') continue;
    extra.append(key, value);
  }

  let targetPath = rawTarget;
  const queryIdx = rawTarget.indexOf('?');
  if (queryIdx >= 0) {
    const tail = rawTarget.slice(queryIdx + 1);
    // 老客户端把 `?mime=video%2Fmp4` 直接拼在 `?path=` 后面（`...?path=/x.mp4?mime=...`），
    // 于是 `?` 之后的参数成了 path 值的一部分。文件名真的带 `?` 时（Linux 允许）不拆。
    if (/^[a-zA-Z0-9_]+=/.test(tail) && !existsSync(rawTarget)) {
      targetPath = rawTarget.slice(0, queryIdx);
      for (const [key, value] of new URLSearchParams(tail)) {
        if (key === 'path' || key === 'token') continue;
        extra.append(key, value);
      }
    }
  }

  return { scheme, targetPath, extraQuery: extra.toString() };
}

export async function startWebServer(options: StartWebServerOptions = {}): Promise<RunningWebServer> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const host = options.host ?? process.env.DS_WEB_HOST ?? '127.0.0.1';
  const requestedPort = options.port ?? Number(process.env.DS_WEB_PORT ?? 1428);
  const prod = options.prod ?? process.env.DS_WEB_PROD === '1';
  const distDir = resolve(options.distDir ?? join(repoRoot, 'dist-web'));
  const webPublicDir = join(repoRoot, 'web', 'public');
  const log = options.log ?? ((msg: string) => process.stdout.write(`[dstu-web] ${msg}\n`));

  const auth: WebAuthConfig = createWebAuth({
    token: options.token ?? process.env.DS_WEB_TOKEN ?? null,
    disableAuth: options.disableAuth ?? process.env.DS_WEB_NO_AUTH === '1',
  });
  const trustProxy = options.trustProxy ?? process.env.DS_WEB_TRUST_PROXY === '1';
  const rateLimiter = new AuthRateLimiter({
    maxFailures: options.maxAuthFailuresPerMinute ?? 15,
    windowMs: 60_000,
  });
  const proxyOptions = { trustProxy };

  const httpServer = createHttpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(requestedPort, host, () => {
      httpServer.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const actualPort = addr.port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const localOrigin = `http://${displayHost}:${actualPort}`;

  const gateway = createWebHostGateway({
    repoRoot,
    appDataDir: options.appDataDir,
    localOrigin,
    debug: !prod,
    safeMode: options.safeMode,
    ...(options.maxStageUploadBytes === undefined ? {} : { maxStageUploadBytes: options.maxStageUploadBytes }),
    log,
  });

  let viteServer: Awaited<ReturnType<typeof import('vite').createServer>> | null = null;
  if (!prod) {
    const { createServer: createViteServer } = await import('vite');
    viteServer = await createViteServer({
      configFile: join(repoRoot, 'web', 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'custom',
    });
  }

  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // 基线安全头：所有响应（含 401/403/404、静态文件、API）统一带上。
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(name, value);
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${displayHost}:${actualPort}`}`);
      const pathname = safeDecodePathname(url.pathname);
      const clientAddress = clientAddressForRequest(req, proxyOptions);

      // Auth session exchange endpoint (`POST /api/auth/session`)
      if (pathname === '/api/auth/session' && req.method === 'POST') {
        if (!isSameOriginRequest(req, proxyOptions)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Cross-origin session request rejected' }));
          return;
        }
        const blockedStatus = rateLimiter.isBlocked(clientAddress);
        if (blockedStatus.blocked) {
          res.writeHead(429, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': String(blockedStatus.retryAfterSec),
          });
          res.end(JSON.stringify({ error: 'Too many failed authentication attempts', retryAfterSec: blockedStatus.retryAfterSec }));
          return;
        }
        const rawBody = await readSmallTextBody(req);
        const contentType = req.headers['content-type'] ?? '';
        let submitted = '';
        if (contentType.includes('application/json')) {
          try {
            const parsed = JSON.parse(rawBody) as { token?: unknown };
            if (typeof parsed.token === 'string') submitted = parsed.token.trim();
          } catch (error) {
            void error;
          }
        } else {
          const params = new URLSearchParams(rawBody);
          submitted = (params.get('token') ?? '').trim();
        }
        if (auth.token !== null && !constantTimeEquals(submitted, auth.token)) {
          rateLimiter.recordFailure(clientAddress);
          if (contentType.includes('application/json')) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid access token' }));
          } else {
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderLoginGateHtml('访问令牌无效，请核对后重试'));
          }
          return;
        }
        rateLimiter.reset(clientAddress);
        if (auth.token !== null) {
          setSessionCookie(res, auth.token, isSecureRequest(req, trustProxy));
        }
        if (contentType.includes('application/json')) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(303, { Location: '/' });
          res.end();
        }
        return;
      }

      const authCheck = isRequestAuthenticated(req, url, auth);
      // iOS / Android 的系统级图标与 manifest 抓取器不带 cookie，这些路径必须在鉴权之前放行，
      // 否则"添加到主屏幕"拿不到图标，装出来的 PWA 是白块。
      const isPublicPwaRequest =
        PUBLIC_PWA_PATHS.has(pathname) && (req.method === 'GET' || req.method === 'HEAD');
      if (!authCheck.authenticated && !isPublicPwaRequest) {
        // 只有真的带令牌才算一次失败尝试：首屏 `GET /` 或健康检查的匿名 401 不该触发封禁。
        const suppliedToken = url.searchParams.has('token') || extractBearerToken(req.headers.authorization) !== null;
        if (suppliedToken) {
          rateLimiter.recordFailure(clientAddress);
          const blockedStatus = rateLimiter.isBlocked(clientAddress);
          if (blockedStatus.blocked) {
            res.writeHead(429, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'Retry-After': String(blockedStatus.retryAfterSec),
            });
            res.end(JSON.stringify({ error: 'Too many failed authentication attempts', retryAfterSec: blockedStatus.retryAfterSec }));
            return;
          }
        }
        const acceptsHtml = (req.headers.accept ?? '').includes('text/html') && !pathname.startsWith('/api/');
        if (acceptsHtml) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderLoginGateHtml());
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (authCheck.viaQueryToken && auth.token !== null) {
        setSessionCookie(res, auth.token, isSecureRequest(req, trustProxy));
      }

      if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            ready: gateway.isReady(),
            version: gateway.config.version,
            pwa: true,
          }),
        );
        return;
      }

      if (url.pathname.startsWith('/api/protocol/')) {
        const parsed = parseProtocolRequest(url);
        if (!parsed) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Missing scheme or path');
          return;
        }
        await gateway.handleProtocolHttp(parsed.scheme, parsed.targetPath, req, res, parsed.extraQuery);
        return;
      }

      if (pathname === '/api/files/stage' && req.method === 'POST') {
        if (!isSameOriginRequest(req, proxyOptions)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Cross-origin upload rejected' }));
          return;
        }
        let headerName: string | null = null;
        try {
          if (typeof req.headers['x-file-name'] === 'string') headerName = decodeURIComponent(req.headers['x-file-name']);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Invalid encoded filename' }));
          return;
        }
        const fileName = url.searchParams.get('name') ?? headerName ?? 'upload.bin';
        await gateway.handleStageUpload(fileName, req, res);
        return;
      }

      if (pathname === '/api/files/prepare-save' && req.method === 'POST') {
        if (!isSameOriginRequest(req, proxyOptions)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
          return;
        }
        const bodyJson = await readSmallTextBody(req);
        await gateway.handlePrepareSave(bodyJson, res);
        return;
      }

      if (pathname === '/api/files/export' && req.method === 'GET') {
        const exportId = url.searchParams.get('exportId') ?? '';
        await gateway.handleDownloadExport(exportId, res);
        return;
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Unknown API endpoint' }));
        return;
      }

      if (viteServer) {
        if (pathname === '/' || pathname === '/index.html') {
          const template = await readFile(join(repoRoot, 'web', 'index.html'), 'utf8');
          const html = await viteServer.transformIndexHtml(url.pathname + url.search, template);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(html);
          return;
        }
        viteServer.middlewares(req, res, () => {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        });
        return;
      }

      await serveStaticFromDist({
        distDir,
        webPublicDir,
        pathname,
        req,
        res,
        // 令牌模式下静态资源是"私有"内容，不能被共享缓存（CDN / 企业代理）留存。
        immutableCacheControl:
          auth.token === null ? 'public, max-age=31536000, immutable' : 'private, max-age=31536000, immutable',
        revalidatedCacheControl: auth.token === null ? 'no-cache' : 'private, no-cache',
        // `?token=` 会在这里 `Set-Cookie`：带 `Set-Cookie` 的响应绝不能同时带长 max-age。
        noStore: authCheck.viaQueryToken && auth.token !== null,
      });
    })().catch((error: unknown) => {
      log(`HTTP handler error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end('Internal Server Error');
      }
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${displayHost}:${actualPort}`}`);
    } catch (error) {
      void error;
      rejectUpgrade(socket, 400, 'Bad Request', 'Invalid WebSocket request URL');
      return;
    }
    if (url.pathname !== '/api/ws') {
      // Allow Vite HMR upgrade in dev mode
      if (viteServer) return;
      rejectUpgrade(socket, 404, 'Not Found', 'Unknown WebSocket endpoint');
      return;
    }
    if (!isSameOriginRequest(req, proxyOptions)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'Cross-origin WebSocket rejected');
      return;
    }
    const authCheck = isRequestAuthenticated(req, url, auth);
    if (!authCheck.authenticated) {
      rejectUpgrade(socket, 401, 'Unauthorized', 'Invalid or missing access token');
      return;
    }
    const ws = acceptWebSocketUpgrade(req, socket, head);
    if (ws) {
      gateway.attachWebSocket(ws);
    }
  });

  await gateway.ready;

  const launchUrl = auth.token ? `${localOrigin}/?token=${auth.token}` : `${localOrigin}/`;
  log(`WebUI + PWA ready at ${launchUrl}`);

  return {
    url: launchUrl,
    token: auth.token,
    port: actualPort,
    host,
    gateway,
    server: httpServer,
    async close() {
      if (viteServer) {
        await viteServer.close();
      }
      const httpClosed = new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
        httpServer.closeAllConnections?.();
      });
      // HTTP close waits for upgraded sockets, which closeAllConnections deliberately skips.
      // Close the gateway's WebSockets before awaiting that callback or shutdown can deadlock.
      await gateway.shutdown();
      await httpClosed;
    },
  };
}

function readCliFlag(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (item === `--${name}`) return argv[i + 1];
    if (item.startsWith(`--${name}=`)) return item.slice(name.length + 3);
  }
  return undefined;
}

/**
 * 命令行 → `startWebServer` 选项。
 *
 * 只写入命令行显式给出的项：`prod: false` / `disableAuth: false` 会盖掉
 * `DS_WEB_PROD=1` / `DS_WEB_NO_AUTH=1`，而这两个环境变量按文档等价于对应开关。
 */
export function resolveCliStartOptions(argv: readonly string[]): {
  host?: string;
  port?: number;
  prod?: true;
  disableAuth?: true;
} {
  const host = readCliFlag(argv, 'host');
  const port = Number(readCliFlag(argv, 'port'));
  return {
    ...(host ? { host } : {}),
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    ...(argv.includes('--prod') ? { prod: true as const } : {}),
    ...(argv.includes('--no-auth') ? { disableAuth: true as const } : {}),
  };
}

const isDirectMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isDirectMain) {
  startWebServer(resolveCliStartOptions(process.argv.slice(2))).then(
    (running) => {
      const shutdown = () => {
        process.stdout.write('\n[dstu-web] Shutting down WebUI server...\n');
        void running.close().finally(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
    (error: unknown) => {
      process.stderr.write(`[dstu-web] Failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
