/**
 * 自定义协议注册。
 *
 * URL 形式与 Tauri `convertFileSrc` 一致：macOS/Linux 为 `<scheme>://localhost/<path>`，Windows（WebView2）为
 * `http://<scheme>.localhost/<path>`。Windows 上 main 拦截 `http` 协议中 `<scheme>.localhost` 主机的请求，并像 wry
 * 一样把 URL 改写回 `<scheme>://localhost/...` 再交给处理方；其余 http 请求原样放行。
 *
 * - `asset`：main 内实现（asset-protocol.ts）。
 * - `pdfstream` / `filestream` / `bilistream`：作为 ProtocolRequest 转给 Host，流式回传 ProtocolResponse/ProtocolChunk。
 * - `tauri`：生产模式下从 frontendDist 提供页面（`tauri://localhost` / `http://tauri.localhost`）；
 *   localStorage 迁移的空白页（`WEBVIEW_MIGRATION_PAGE_PATH`）由 main 直接给出，不回退到 index.html。
 */
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { net, protocol, type Session } from 'electron';
import { assetResponse } from './asset-protocol.ts';
import { augmentRendererCsp, injectHtmlScriptNonce, PluginUiRegistry, servePluginUiRequest } from './plugin-ui-protocol.ts';
import { CUSTOM_SCHEMES, windowsLocalhostRewrite } from './url-forms.ts';
import type { HostSupervisor } from './host.ts';
import type { PluginFileResolver } from './plugin-lock.ts';
import type { FsScope } from './scope.ts';
import type { ShellPlatform } from './tauri-config.ts';
import { WEBVIEW_MIGRATION_PAGE_HTML, WEBVIEW_MIGRATION_PAGE_PATH } from './webview-migration.ts';

const ALL_SCHEMES = CUSTOM_SCHEMES;

/** 必须在 app ready 之前调用。 */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged(
    ALL_SCHEMES.map((scheme) => ({
      scheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    })),
  );
}

function headersOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export interface ProtocolDeps {
  platform: ShellPlatform;
  host: HostSupervisor;
  assetScope: FsScope;
  assetEnabled: boolean;
  /** 页面 origin（asset 响应的 Access-Control-Allow-Origin）。 */
  windowOrigin(): string;
  frontendDist: string;
  /** `tauri.conf.json` 的 `app.security.csp`（生产页面响应附带，放行插件协议）。 */
  csp: string | null;
  /** 第三方 UI 插件清单（`plugin:ui|manifest` / `host://ui-manifest`）。 */
  pluginUi: PluginUiRegistry;
  loadUiManifest(): Promise<unknown>;
  /** 生产必传：`ds-plugin:` 文件按 `plugins.lock.json` 解析并核对 sha256（W34 锁，W06 校验）。 */
  pluginFiles?: PluginFileResolver;
  log(message: string): void;
}

async function forwardToHost(deps: ProtocolDeps, scheme: string, url: string, request: Request): Promise<Response> {
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
  return new Promise<Response>((resolve) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let headSent = false;
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        ended = true;
      },
    });
    deps.host.protocol(
      { scheme, url, method: request.method, headers: headersOf(request), ...(body !== undefined ? { body } : {}) },
      {
        head(response) {
          headSent = true;
          if (!ended && response.body.length > 0) controller?.enqueue(response.body);
          if (!ended && response.final) {
            ended = true;
            controller?.close();
          }
          const nullBody = [101, 103, 204, 205, 304].includes(response.status) || request.method === 'HEAD';
          resolve(new Response(nullBody ? null : stream, { status: response.status, headers: response.headers }));
        },
        chunk(chunk) {
          if (ended) return;
          if (chunk.body.length > 0) controller?.enqueue(chunk.body);
          if (chunk.final) {
            ended = true;
            const error = (chunk as { error?: string }).error;
            if (error !== undefined) controller?.error(new Error(error));
            else controller?.close();
          }
        },
        fail(message) {
          if (ended) return;
          ended = true;
          if (headSent) controller?.error(new Error(message));
          else resolve(new Response(message, { status: 502, headers: { 'Content-Type': 'text/plain' } }));
        },
      },
    );
  });
}

const DIST_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/vnd.microsoft.icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
};

/** tauri 协议（生产）：按路径取 dist 文件；找不到时依次尝试 `<path>/index.html`、`index.html`（Tauri AssetResolver 回退）。 */
async function serveDist(dist: string, url: string, csp: string | null): Promise<Response> {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const root = normalize(dist + sep);
  const candidates = [pathname, join(pathname, 'index.html'), '/index.html'];
  for (const candidate of candidates) {
    const file = normalize(join(root, candidate));
    if (!file.startsWith(root)) continue;
    try {
      if (!(await stat(file)).isFile()) continue;
      const ext = extname(file).toLowerCase();
      const raw = await readFile(file);
      const isHtml = ext === '.html';
      const scriptNonce = isHtml && csp !== null && csp.trim() !== '' ? randomBytes(16).toString('base64url') : undefined;
      const policy = csp === null ? '' : augmentRendererCsp(csp, scriptNonce);
      const body: BodyInit = scriptNonce ? injectHtmlScriptNonce(raw.toString('utf8'), scriptNonce) : raw;
      const headers: Record<string, string> = { 'Content-Type': DIST_MIME[ext] ?? 'application/octet-stream' };
      if (policy !== '') headers['Content-Security-Policy'] = policy;
      return new Response(body, { status: 200, headers });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error)) throw error;
    }
  }
  return new Response('', { status: 404 });
}

export function installProtocols(session: Session, deps: ProtocolDeps): void {
  const handle = async (scheme: string, url: string, request: Request): Promise<Response> => {
    if (scheme === 'asset') {
      if (!deps.assetEnabled) return new Response('', { status: 404 });
      const r = await assetResponse({ url, method: request.method, headers: headersOf(request) }, deps.assetScope, deps.windowOrigin(), deps.platform);
      if (request.method === 'HEAD' && r.body instanceof ReadableStream) await r.body.cancel();
      // TS 5.7+ 的 BodyInit 只接受普通 ArrayBuffer 上的视图；整文件字节复用同一份缓冲区。
      const payload = r.body === null || request.method === 'HEAD'
        ? null
        : r.body instanceof ReadableStream
          ? r.body
          : new Uint8Array(r.body.buffer as ArrayBuffer, r.body.byteOffset, r.body.byteLength);
      return new Response(payload, { status: r.status, headers: r.headers });
    }
    // RUST-FIX(RF-W06-plugin-lock-integrity): 生产协议处理方按锁解析并校验字节。
    if (scheme === 'ds-plugin') return servePluginUiRequest(request, deps.pluginUi, deps.loadUiManifest, deps.pluginFiles);
    if (scheme === 'tauri') {
      if (new URL(url).pathname === WEBVIEW_MIGRATION_PAGE_PATH) {
        return new Response(WEBVIEW_MIGRATION_PAGE_HTML, { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" } });
      }
      return serveDist(deps.frontendDist, url, deps.csp);
    }
    return forwardToHost(deps, scheme, url, request);
  };
  for (const scheme of ALL_SCHEMES) {
    session.protocol.handle(scheme, (request) => handle(scheme, request.url, request));
  }
  if (deps.platform === 'win32') {
    for (const httpScheme of ['http', 'https'] as const) {
      session.protocol.handle(httpScheme, (request) => {
        const rewrite = windowsLocalhostRewrite(request.url);
        if (rewrite) return handle(rewrite.scheme, rewrite.url, request);
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
      });
    }
  }
}
