/**
 * `ds-plugin://<插件 id>/<相对路径>`：向渲染进程提供第三方插件的静态 UI 模块
 * （`docs/plugins/FRONTEND.md` §3，F0b）。
 *
 * - 清单来自 Host 的 `plugin:ui|manifest`（返回 `UiManifestEntry[]`）与 `host://ui-manifest`
 *   事件（载荷同数组）；`file` 是 UI 模块绝对路径，本模块以 `dirname(file)` 为根提供文件。
 * - 只提供允许的静态扩展名；JS/MJS 的 MIME 必须是 `text/javascript`（作为 ESM 加载）。
 * - 路径规范化 + realpath 校验，拒绝根目录之外的路径与目录穿越；清单一变，旧插件 id 立即失效。
 * - 所有响应 `Cache-Control: no-store`；`ds-plugin:` 已注册为 standard/secure/corsEnabled 协议。
 *
 * 与 Electron `protocol.handle` 解耦，便于在 Node 下直接测试（`electron/tests/plugin-ui-protocol.test.ts`）。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PluginFileResolver } from './plugin-lock.ts';
import { sha256Hex } from './plugin-lock.ts';

export interface UiManifestEntry {
  id: string;
  /** UI 模块绝对路径（Host 已相对插件模块解析）。 */
  file: string;
  version?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/** Host `plugin:ui|manifest` 的返回值校验：必须是 `{ id, file(绝对路径), version? }[]`。 */
export function parseUiManifest(raw: unknown): UiManifestEntry[] {
  if (!Array.isArray(raw)) throw new Error('UI manifest must be an array of { id, file } entries');
  const byId = new Map<string, UiManifestEntry>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('UI manifest entry must be an object');
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    const file = record.file;
    if (typeof id !== 'string' || id === '') throw new Error('UI manifest entry id must be a non-empty string');
    if (typeof file !== 'string' || file === '' || !isAbsolute(file)) {
      throw new Error(`UI manifest entry "${id}" file must be an absolute path`);
    }
    const version = record.version;
    if (version !== undefined && typeof version !== 'string') {
      throw new Error(`UI manifest entry "${id}" version must be a string`);
    }
    byId.set(id, { id, file, ...(version !== undefined ? { version } : {}) });
  }
  return [...byId.values()];
}

/** 当前 UI 引导清单；事件/命令更新时整体替换，旧插件 id 与旧根目录立即失效。 */
export class PluginUiRegistry {
  readonly safeMode: boolean;
  private entries = new Map<string, UiManifestEntry>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(safeMode = false) {
    this.safeMode = safeMode;
  }

  update(raw: unknown): void {
    const next = new Map<string, UiManifestEntry>();
    for (const entry of parseUiManifest(raw)) next.set(entry.id, entry);
    this.entries = next;
    this.loaded = true;
  }

  get(id: string): UiManifestEntry | undefined {
    return this.entries.get(id);
  }

  /** 首次协议请求时惰性拉取清单；成功后不再调用，直到 `update`/`invalidate`。 */
  async ensureLoaded(load: () => Promise<unknown>): Promise<void> {
    if (this.loaded) return;
    if (this.loading === null) {
      this.loading = load()
        .then((raw) => {
          this.update(raw);
        })
        .finally(() => {
          this.loading = null;
        });
    }
    await this.loading;
  }

  /** Host 重启等场景下丢弃缓存，下次请求重新拉取。 */
  invalidate(): void {
    this.entries = new Map();
    this.loaded = false;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
}

function textResponse(status: number, message: string, extra?: Record<string, string>): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/plain; charset=utf-8',
      ...extra,
    },
  });
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function servePluginUiRequest(
  request: Request,
  registry: PluginUiRegistry,
  loadManifest: () => Promise<unknown>,
  /** 生产必传：按 `plugins.lock.json` 解析并核对实际返回字节；缺省仅供不涉及锁的单元测试。 */
  resolver?: PluginFileResolver,
): Promise<Response> {
  // RUST-FIX(RF-W06-safe-mode): 安全模式不提供任何社区 UI 模块。
  if (registry.safeMode) return textResponse(403, 'community plugin UI disabled in safe mode');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse(405, `method ${request.method} is not allowed`, { Allow: 'GET, HEAD' });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    return textResponse(400, `invalid ds-plugin URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (url.protocol !== 'ds-plugin:') return textResponse(400, 'expected a ds-plugin: URL');

  let id: string;
  let decodedPath: string;
  try {
    id = decodeURIComponent(url.hostname);
    decodedPath = decodeURIComponent(url.pathname);
  } catch (error) {
    return textResponse(400, `invalid ds-plugin URL encoding: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (id === '') return textResponse(400, 'ds-plugin URL is missing the plugin id');
  if (!decodedPath.startsWith('/') || decodedPath === '/' || decodedPath.includes('\0')) {
    return textResponse(400, 'ds-plugin URL is missing a file path');
  }

  const relativePath = decodedPath.slice(1);
  const extension = extname(relativePath).toLowerCase();
  const mime = MIME_BY_EXT[extension];
  if (mime === undefined) {
    return textResponse(415, `unsupported plugin UI asset type: ${extension === '' ? '(none)' : extension}`);
  }

  try {
    await registry.ensureLoaded(loadManifest);
  } catch (error) {
    return textResponse(503, `UI manifest unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = registry.get(id);
  if (entry === undefined) return textResponse(404, `plugin UI not found: ${id}`);

  let root: string;
  let target: string;
  let expectedSha256: string | null = null;
  if (resolver === undefined) {
    root = dirname(entry.file);
    target = resolve(root, relativePath);
    if (!contained(root, target)) return textResponse(403, 'plugin UI path escapes the plugin directory');
  } else {
    let locked;
    try {
      locked = await resolver.resolve(id, relativePath, entry.file);
    } catch (error) {
      const status = typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 500;
      return textResponse(status, error instanceof Error ? error.message : String(error));
    }
    root = locked.root;
    target = locked.file;
    expectedSha256 = locked.sha256;
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(target);
  } catch {
    return textResponse(404, `plugin UI file not found: ${relativePath}`);
  }
  if (!contained(realRoot, realTarget)) return textResponse(403, 'plugin UI path escapes the plugin directory');

  let size: number;
  try {
    const info = await stat(realTarget);
    if (!info.isFile()) return textResponse(404, `plugin UI file not found: ${relativePath}`);
    size = info.size;
  } catch {
    return textResponse(404, `plugin UI file not found: ${relativePath}`);
  }

  let body: Uint8Array;
  try {
    body = await readFile(realTarget);
  } catch (error) {
    return textResponse(500, `failed to read plugin UI file: ${error instanceof Error ? error.message : String(error)}`);
  }

  // RUST-FIX(RF-W06-plugin-lock-integrity): 核对实际返回字节，锁里没有或对不上就拒绝。
  if (expectedSha256 !== null && sha256Hex(body) !== expectedSha256) {
    // 篡改即拒：锁里登记的是这次实际读到的字节，而不是目录布局。
    return textResponse(403, `plugin file does not match plugins.lock.json: ${id}/${relativePath}`);
  }

  const headers: Record<string, string> = {
    ...corsHeaders(),
    'Content-Type': mime,
    'Content-Length': String(request.method === 'HEAD' ? size : body.byteLength),
  };
  // TS 5.7+ 的 BodyInit 只接受普通 ArrayBuffer 上的视图；这里直接转发读到的字节，不复制。
  const payload = request.method === 'HEAD' ? null
    : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  return new Response(payload, { status: 200, headers });
}

/**
 * 在渲染进程 CSP 中放行 `ds-plugin:` 与 `blob:`（共享依赖 import map 使用 blob URL）。
 * `script-src` / `script-src-elem` 需要两者；若提供 `scriptNonce`，同步追加 `'nonce-...'`
 * 以允许 `shared.ts` 在严格禁用 `'unsafe-inline'` 的生产策略下动态注入 `<script type="importmap">`。
 */
export function augmentRendererCsp(csp: string, scriptNonce?: string): string {
  const trimmed = csp.trim();
  if (trimmed === '') return csp;
  const nonceToken = scriptNonce && /^[A-Za-z0-9_-]+=*$/.test(scriptNonce) ? `'nonce-${scriptNonce}'` : null;
  const trailingSemicolon = trimmed.endsWith(';');
  const directives = trimmed.split(';').map((part) => part.trim()).filter((part) => part !== '');
  const schemeDirectives = new Set([
    'default-src', 'script-src', 'script-src-elem', 'style-src', 'style-src-elem',
    'img-src', 'font-src', 'connect-src', 'media-src', 'worker-src',
  ]);
  let hasScriptDirective = false;
  const out = directives.map((directive) => {
    const parts = directive.split(/\s+/);
    const name = (parts[0] ?? '').toLowerCase();
    if (!schemeDirectives.has(name)) return directive;
    const values = parts.slice(1);
    if (!values.includes('ds-plugin:')) values.push('ds-plugin:');
    if (name === 'script-src' || name === 'script-src-elem') {
      hasScriptDirective = true;
      if (!values.includes('blob:')) values.push('blob:');
      if (nonceToken && !values.includes(nonceToken)) values.push(nonceToken);
    }
    return [parts[0], ...values].join(' ');
  });
  if (!hasScriptDirective) {
    out.push(nonceToken ? `script-src 'self' ds-plugin: blob: ${nonceToken}` : "script-src 'self' ds-plugin: blob:");
  }
  return `${out.join('; ')}${trailingSemicolon ? ';' : ''}`;
}

/** 向生产 HTML `<head>` 注入当次响应的 `ds-csp-nonce` meta 标签。 */
export function injectHtmlScriptNonce(html: string, scriptNonce: string): string {
  if (!/^[A-Za-z0-9_-]+=*$/.test(scriptNonce)) return html;
  const meta = `<meta name="ds-csp-nonce" content="${scriptNonce}" />`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n    ${meta}`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `    ${meta}\n  </head>`);
  }
  return `${meta}\n${html}`;
}
