/** roster.rs:54 `FetchExecutor` (`web_fetch`, fetch_executor.rs:574-1587) on the chat ExecutionContext. */
import type { CryptoService } from '../../../../platform/crypto/api.ts';
import { createWebCrypto } from '../../../../platform/crypto/web.ts';
import { FileError, type FilesService } from '../../../../platform/files/api.ts';
import { HttpError, type HttpRequestInit, type HttpService } from '../../../../platform/http/api.ts';
import { OfficeParsingError, type NativeOffice } from '../../../../platform/native/office/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import { isLoopbackIp, parseIp } from '../../../../platform/net-policy/index.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../../../../platform/storage/errors.ts';
import { canonicalReason } from '../../../../platform/util/index.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { FetchLike } from '../http.ts';
import {
  DEEPSEEK_API_KEY_SETTING, DEEPSEEK_FETCH_ENABLED_SETTING, DEEPSEEK_FETCH_ENDPOINT, DEFAULT_MAX_LENGTH, DEFAULT_START_INDEX,
  DEFAULT_USER_AGENT, MAX_BINARY_LENGTH, MAX_CONTENT_LENGTH, MAX_REDIRECTS, REQUEST_TIMEOUT_SECS, FetchExecutor,
  binaryHeaderFamilyMatches, cleanHtmlContent, cleanMarkdownContent, collectDownloadStreamLimited, tryExtractMainContent, decodeBytesWithCharset, deepseekFetchSettingEnabled,
  deepseekFetchSuccessResult, describeDeepseekFetchFailure, filenameFromHeadersOrUrl, htmlToMarkdownText, looksLikeHtml,
  paginateContent, parseDeepseekFetchResponse, shouldUseDeepseekFetch, sniffBinaryKind, type BinaryKind,
  readResponseExcerpt,
} from './fetch-executor.ts';
import {
  TaskObjectHandleBuilder, derivedEdge, hashTransformParams, managedLocator, withParamsHash,
} from './task-objects.ts';

export interface FetchChatToolDeps {
  settings(): SettingsStore | null;
  /** `artifact_root(app, session_id, true)`. */
  artifactRoot(sessionId: string): string;
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void };
  /** `ctx.http`: page requests go `public-pinned` (resolve, check every answer, connect to the checked address, no proxy). */
  http(): HttpService | null;
  /** `ctx.files`: binary downloads are written under the session artifact root. */
  files(): FilesService | null;
  /** `ctx.crypto`; without it the Web implementation (byte-identical digests) is used. */
  crypto?(): CryptoService | null;
  /** DeepSeek client; defaults to `ctx.http` with `destination: 'any'` (default proxy environment, as Rust's `deepseek_client`). */
  deepseekFetch?: FetchLike;
  /** `nativeOffice` (html2text 0.16.7, the crate Rust converts with); without it the TS approximation runs. */
  office?(): Pick<NativeOffice, 'extractText'> | null;
  timeoutMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_HEADERS = {
  'user-agent': DEFAULT_USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** fetch reports every network failure as `TypeError('fetch failed')`; the socket or TLS error is its cause. */
const transportErrorText = (error: unknown): string =>
  error instanceof TypeError && error.cause instanceof Error ? error.cause.message : errorText(error);
const bareHost = (hostname: string): string => hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
const scheme = (url: URL): string => url.protocol.replace(/:$/, '');
/** `path.extname` on a bare file name. */
const extname = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 || name === '..' ? '' : name.slice(dot);
};
/** A URL that names this machine itself: a loopback literal (after WHATWG host parsing) or localhost / *.localhost. */
export function namesLoopback(raw: string): boolean {
  let host: string;
  try { host = bareHost(new URL(raw).hostname).toLowerCase(); } catch { return false; }
  if (parseIp(host) !== null) return isLoopbackIp(host);
  return host === 'localhost' || host.endsWith('.localhost');
}

/** The Rust messages for a target refused before connecting (fetch_executor.rs:936-951). */
function refusedTarget(error: unknown): Error | null {
  if (!(error instanceof HttpError)) return null;
  if (error.kind === 'UnsupportedOnPlatform') return new Error(error.message);
  if (error.kind !== 'BlockedDestination') return null;
  return new Error(error.reason === 'blocked-address' ? 'Blocked: URL resolves to internal IP address' : error.message);
}

/** Releasing the reader cancels the stream, so stopping early (excerpt, size cap) closes the connection. */
async function* chunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
const discard = (response: Response): void => { void response.body?.cancel().catch(() => undefined); };

class Cancelled extends Error {}

export class FetchChatToolExecutor implements ToolExecutor {
  private readonly helpers = new FetchExecutor();
  private readonly deps: FetchChatToolDeps;
  constructor(deps: FetchChatToolDeps) {
    this.deps = deps;
  }

  name(): string { return this.helpers.name(); }
  canHandle(toolName: string): boolean { return this.helpers.canHandle(toolName); }
  sensitivityLevel(toolName: string): 'low' { return this.helpers.sensitivityLevel(toolName); }
  // RUST-FIX(RF-S01-web-fetch-loopback-approval): Rust lets the approval-free web_fetch read local services on 127.0.0.1/::1
  sensitivityLevelForCall(toolName: string, args: unknown): 'low' | 'high' {
    const url = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).url : undefined;
    return typeof url === 'string' && namesLoopback(url) ? 'high' : this.sensitivityLevel(toolName);
  }
  hasDynamicSensitivity(_toolName: string): boolean { return true; }
  concurrencyClass(toolName: string): 'read_only' { return this.helpers.concurrencyClass(toolName); }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = Date.now();
    const short = call.name.startsWith('builtin-') ? call.name.slice(8) : call.name.startsWith('mcp_') ? call.name.slice(4) : call.name;
    this.deps.log.debug(`[FetchExecutor] Executing builtin tool: ${short} (full: ${call.name})`);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let failure: string | null = null;
    try {
      if (short !== 'web_fetch') throw new Error(`Unknown fetch tool: ${short}`);
      output = await this.executeFetch(call, ctx);
    } catch (error) { failure = errorText(error); }
    const durationMs = Date.now() - started;
    let result: ToolResultInfo;
    if (failure === null) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(failure);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: failure, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { this.deps.log.warn(`[FetchExecutor] Failed to save tool block: ${errorText(error)}`); }
    return result;
  }

  private http(): HttpService {
    const http = this.deps.http();
    if (http === null) throw new Error(`${UNSUPPORTED_ON_PLATFORM_PREFIX}web_fetch needs the ctx.http service, which this host does not provide`);
    return http;
  }

  /**
   * Rust resolves and checks the target before trying DeepSeek (fetch_executor.rs:936-979). `checkPublicPinned` is the
   * `public-pinned` resolution and check without the connection; the local fetch afterwards resolves and checks again.
   * Rust's check is only the resolution and the address test, so any other failure of it reads as a failed resolution.
   */
  private async checkTarget(http: HttpService, url: URL, loopbackOrigin: boolean): Promise<void> {
    try {
      await http.checkPublicPinned(url, { allowLoopback: loopbackOrigin });
    } catch (error) {
      throw refusedTarget(error) ?? new Error(`DNS resolution failed for '${bareHost(url.hostname)}': ${errorText(error)}`);
    }
  }

  private async executeFetch(call: ToolCall, ctx: ExecutionContext): Promise<unknown> {
    if (ctx.isCancelled()) throw new Error('Fetch cancelled before start');
    const args = typeof call.arguments === 'object' && call.arguments !== null ? call.arguments as Record<string, unknown> : {};
    const url = args.url;
    if (typeof url !== 'string') throw new Error("Missing 'url' parameter");
    const u64 = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
    const maxLength = Math.max(Math.min(u64(args.max_length) ?? DEFAULT_MAX_LENGTH, MAX_CONTENT_LENGTH), 1);
    const startIndex = u64(args.start_index) ?? DEFAULT_START_INDEX;
    const raw = typeof args.raw === 'boolean' ? args.raw : false;
    this.deps.log.debug(`[FetchExecutor] Fetching URL: ${url}, max_length=${maxLength}, start_index=${startIndex}, raw=${raw}`);

    let parsed: URL;
    try { parsed = new URL(url); }
    catch (error) { throw new Error(`Invalid URL '${url}': ${errorText(error)}`); }
    if (scheme(parsed) !== 'http' && scheme(parsed) !== 'https') {
      throw new Error(`Only HTTP and HTTPS URLs are supported, got: ${scheme(parsed)}`);
    }
    if (bareHost(parsed.hostname) === '') throw new Error('Invalid URL: no host');
    const http = this.http();
    // RUST-FIX(RF-S01-web-fetch-resolved-loopback-blocked): Rust exempts loopback for any name, so a public-looking name resolving to 127.0.0.1 reached local services without approval
    const loopbackOrigin = namesLoopback(url);
    // RUST-FIX(RF-S01-web-fetch-dns-pinning): Rust re-resolves in validate_public_url_target and reqwest re-resolves to connect, so a rebinding DNS answer passes the check and connects elsewhere
    const pinned = { destination: 'public-pinned', allowLoopback: loopbackOrigin, redirect: 'manual' } as const;

    const started = Date.now();
    const deepseek = await this.tryDeepseek(ctx, http, url, parsed, loopbackOrigin, startIndex, maxLength, started);
    if (deepseek !== null) return deepseek;

    if (ctx.isCancelled()) throw new Error('Fetch cancelled before HTTP request');
    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? REQUEST_TIMEOUT_SECS * 1000);
    const cancel = ctx.cancellation_token;
    const signal = cancel === null ? timeout : AbortSignal.any([timeout, cancel]);
    const init: HttpRequestInit = { ...pinned, headers: REQUEST_HEADERS, signal };
    const failed = (error: unknown): Error => {
      if (cancel?.aborted) {
        this.deps.log.info(`[FetchExecutor] HTTP request cancelled for URL: ${url}`);
        return new Error('Fetch cancelled during HTTP request');
      }
      return new Error(`Failed to fetch URL '${url}': ${transportErrorText(error)}`);
    };

    let current = parsed;
    let response: Response;
    try { response = await http.fetch(current, init); }
    catch (error) { throw refusedTarget(error) ?? failed(error); }
    // reqwest's `attempt.previous()` already holds the original URL on the first redirect, so `len() >= 10` follows 9.
    for (let previous = 1; ; previous++) {
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || location === null || previous >= MAX_REDIRECTS) break;
      let next: URL;
      try { next = new URL(location, current); } catch { break; }
      let nextResponse: Response;
      try { nextResponse = await http.fetch(next, init); }
      catch (error) {
        // The reqwest redirect policy: `attempt.stop()` (keep the 3xx) when the target does not resolve or is refused.
        if (error instanceof HttpError && (error.kind === 'BlockedDestination' || error.kind === 'InvalidUrl')) break;
        discard(response);
        throw failed(error);
      }
      discard(response);
      response = nextResponse;
      current = next;
    }

    const finalUrl = current;
    const contentType = response.headers.get('content-type') ?? 'unknown';

    if (response.status < 200 || response.status >= 300) {
      let excerpt = '';
      try { excerpt = await readResponseExcerpt(chunks(response.body), response.headers.get('content-type')); } catch { excerpt = ''; }
      discard(response);
      let message = `HTTP request failed with status ${response.status}: ${canonicalReason(response.status) ?? 'Unknown'}`;
      if (excerpt !== '') message += `\nResponse body (excerpt): ${excerpt}`;
      throw new Error(message);
    }
    if (ctx.isCancelled()) { discard(response); throw new Error('Fetch cancelled before reading response'); }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BINARY_LENGTH) {
      discard(response);
      throw new Error(`Response too large: ${declaredLength} bytes (max ${MAX_BINARY_LENGTH} bytes)`);
    }

    let bytes: Uint8Array;
    try { bytes = await collectDownloadStreamLimited(chunks(response.body), MAX_BINARY_LENGTH, 0); }
    catch (error) {
      if (cancel?.aborted) {
        this.deps.log.info(`[FetchExecutor] Response body read cancelled for URL: ${url}`);
        throw new Error('Fetch cancelled while reading response');
      }
      throw error;
    }

    const declaredMime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    const declaresBinary = declaredMime === 'application/octet-stream' || declaredMime === 'binary/octet-stream'
      || declaredMime === 'application/pdf'
      || declaredMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || declaredMime.startsWith('image/') || declaredMime.startsWith('audio/') || declaredMime.startsWith('video/');
    let kind = sniffBinaryKind(bytes);
    if (kind !== undefined) {
      if (kind.extension === 'mp4' && declaredMime.startsWith('audio/')) kind = { mime: 'audio/mp4', extension: 'm4a' };
      else if (kind.extension === 'webm' && declaredMime.startsWith('audio/')) kind = { mime: 'audio/webm', extension: 'webm' };
      if (!binaryHeaderFamilyMatches(contentType, kind)) {
        throw new Error(`Binary MIME/magic mismatch: header '${contentType}' does not match detected '${kind.mime}'`);
      }
      return this.materializeBinary(ctx, url, finalUrl, response.headers, bytes, kind);
    }
    if (declaresBinary) {
      throw new Error(`Unsupported or invalid binary response: declared MIME '${contentType}' did not match a supported file signature`);
    }
    if (bytes.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Response too large: ${bytes.length} bytes (max ${MAX_CONTENT_LENGTH} bytes)`);
    }

    const [rawContent, charset] = decodeBytesWithCharset(bytes, contentType);
    this.deps.log.debug(`[FetchExecutor] Charset detected: ${charset} for URL: ${url}`);
    const isHtmlByHeader = contentType.includes('text/html') || contentType.includes('application/xhtml');
    let content: string;
    if (raw) content = rawContent;
    else if (isHtmlByHeader) content = await this.htmlToMarkdown(rawContent);
    else if (contentType.includes('application/json')) content = formatJson(rawContent);
    else content = looksLikeHtml(rawContent) ? await this.htmlToMarkdown(rawContent) : rawContent;

    const totalLength = Array.from(content).length;
    const durationMs = Date.now() - started;
    const page = paginateContent(content, startIndex, maxLength);
    const returnedLength = Array.from(page.content).length;
    this.deps.log.debug(`[FetchExecutor] Fetch completed: url=${url}, total_len=${totalLength}, returned_len=${returnedLength}, has_more=${page.hasMore}, ${durationMs}ms`);
    return {
      success: true, url, finalUrl: finalUrl.href, redirected: url !== finalUrl.href, finalDomain: finalUrl.hostname,
      content: page.content, contentType, totalLength, startIndex, returnedLength, hasMore: page.hasMore,
      nextStartIndex: page.hasMore ? startIndex + maxLength : null, durationMs,
    };
  }

  /** Optional DeepSeek Fetch; any failure except cancellation falls back to the local fetch. */
  /** `html_to_markdown` (fetch_executor.rs:1378): main content, clean_html, html2text at 80 columns (failure keeps the cleaned HTML), clean_markdown. */
  private async htmlToMarkdown(html: string): Promise<string> {
    const office = this.deps.office?.() ?? null;
    if (office === null) return htmlToMarkdownText(html);
    const cleaned = cleanHtmlContent(tryExtractMainContent(html) ?? html);
    let text: string;
    try {
      text = await office.extractText('page.html', new TextEncoder().encode(cleaned));
    } catch (error) {
      if (!(error instanceof OfficeParsingError)) throw error;
      this.deps.log.warn(`[FetchExecutor] HTML 转文本失败，回退清理后内容: ${error.detail.replace(/^HTML 转文本失败: /u, '')}`);
      text = cleaned;
    }
    return cleanMarkdownContent(text);
  }

  private async tryDeepseek(ctx: ExecutionContext, http: HttpService, url: string, parsed: URL, loopbackOrigin: boolean,
    startIndex: number, maxLength: number, started: number): Promise<unknown | null> {
    const settings = this.deps.settings();
    let flag: string | null = null;
    try { flag = settings?.get(DEEPSEEK_FETCH_ENABLED_SETTING) ?? null; } catch { flag = null; }
    const enabled = deepseekFetchSettingEnabled(flag);
    let apiKey: string | null = null;
    if (enabled && settings !== null) {
      try { apiKey = (await settings.getSecret(DEEPSEEK_API_KEY_SETTING))?.trim() || null; } catch { apiKey = null; }
      if (apiKey === null) {
        try { apiKey = (await settings.getSecret('builtin-deepseek.api_key'))?.trim() || null; } catch { apiKey = null; }
      }
    }
    if (!shouldUseDeepseekFetch(enabled, apiKey, url) || apiKey === null) return null;
    await this.checkTarget(http, parsed, loopbackOrigin);
    try {
      const content = await this.deepseekMarkdown(ctx, http, url, apiKey);
      const durationMs = Date.now() - started;
      this.deps.log.debug(`[FetchExecutor] DeepSeek fetch succeeded: url=${url}, content_len=${Array.from(content).length}, ${durationMs}ms`);
      return deepseekFetchSuccessResult({ url, host: parsed.hostname, content, startIndex, maxLength, durationMs });
    } catch (error) {
      if (error instanceof Cancelled || ctx.isCancelled()) throw new Error('Fetch cancelled during DeepSeek fetch');
      this.deps.log.warn(`[FetchExecutor] DeepSeek fetch failed for URL ${url}: ${errorText(error)} — falling back to local fetch`);
      return null;
    }
  }

  private async deepseekMarkdown(ctx: ExecutionContext, http: HttpService, url: string, apiKey: string): Promise<string> {
    if (ctx.isCancelled()) throw new Cancelled('Fetch cancelled before DeepSeek fetch');
    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? REQUEST_TIMEOUT_SECS * 1000);
    const cancel = ctx.cancellation_token;
    const signal = cancel === null ? timeout : AbortSignal.any([timeout, cancel]);
    const cancelled = () => {
      this.deps.log.info(`[FetchExecutor] DeepSeek fetch cancelled for URL: ${url}`);
      return new Cancelled('Fetch cancelled during DeepSeek fetch');
    };
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const request = JSON.stringify({ url });
    let response: Response;
    try {
      response = this.deps.deepseekFetch === undefined
        ? await http.fetch(DEEPSEEK_FETCH_ENDPOINT, { method: 'POST', signal, headers, body: request })
        : await this.deps.deepseekFetch(DEEPSEEK_FETCH_ENDPOINT, { method: 'POST', signal, headers, body: request });
    } catch (error) {
      if (cancel?.aborted) throw cancelled();
      throw new Error(`DeepSeek Fetch request failed: ${errorText(error)}`);
    }
    let bodyText: string;
    try { bodyText = await response.text(); }
    catch (error) {
      if (cancel?.aborted) throw cancelled();
      throw new Error(`DeepSeek Fetch response read failed: ${errorText(error)}`);
    }
    if (!response.ok) throw new Error(describeDeepseekFetchFailure(response.status, Array.from(bodyText).slice(0, 300).join('')));
    let body: unknown;
    try { body = JSON.parse(bodyText); }
    catch (error) { throw new Error(`DeepSeek Fetch response parse failed: ${errorText(error)}`); }
    const [title, content] = parseDeepseekFetchResponse(body);
    this.deps.log.debug(`[FetchExecutor] DeepSeek fetch ok: url=${url}, title=${title === null ? 'None' : `Some(${JSON.stringify(title)})`}, content_len=${Array.from(content).length}`);
    return content;
  }

  private async materializeBinary(ctx: ExecutionContext, originalUrl: string, finalUrl: URL, headers: Headers,
    bytes: Uint8Array, kind: BinaryKind): Promise<Record<string, unknown>> {
    const files = this.deps.files();
    if (files === null) throw new Error(`${UNSUPPORTED_ON_PLATFORM_PREFIX}web_fetch binary downloads need the ctx.files service, which this host does not provide`);
    const crypto = this.deps.crypto?.() ?? createWebCrypto();
    // The scope confines every operation to the session root through symbolic links (Rust: canonicalize + starts_with).
    const root = files.scope(this.deps.artifactRoot(ctx.session_id));
    const escapes = (error: unknown): boolean => error instanceof FileError && error.kind === 'OutsideRoots';
    try { await root.mkdir('web-fetch'); }
    catch (error) {
      if (escapes(error)) throw new Error('Web fetch artifact directory escapes session root');
      throw new Error(`Failed to create web-fetch artifact directory: ${errorText(error)}`);
    }

    const requestedName = filenameFromHeadersOrUrl(headers, finalUrl.href, kind);
    const sha256 = crypto.toHex(crypto.digestSync('SHA-256', bytes));
    const extension = extname(requestedName);
    const stem = (extension === '' ? requestedName : requestedName.slice(0, -extension.length)) || 'download';
    const displayName = `${stem}-${sha256.slice(0, 12)}.${kind.extension}`;
    const relativePath = `web-fetch/${displayName}`;
    try { await root.writeBytes(relativePath, bytes, { exclusive: true }); }
    catch (error) {
      if (escapes(error)) throw new Error('Web fetch artifact directory escapes session root');
      if (!(error instanceof FileError && error.kind === 'AlreadyExists')) throw new Error(`Failed to create web-fetch artifact: ${errorText(error)}`);
      let existing: Uint8Array;
      try { existing = await root.readBytes(relativePath); }
      catch (readError) { throw new Error(`Failed to read existing web-fetch artifact: ${errorText(readError)}`); }
      if (crypto.toHex(crypto.digestSync('SHA-256', existing)) !== sha256) throw new Error('Web fetch artifact hash collision');
    }
    const handle = new TaskObjectHandleBuilder(`web-fetch:${sha256}`, 'file', displayName, 'url_download')
      .sourceUri(finalUrl.href)
      .server(finalUrl.hostname || undefined)
      .tool('web_fetch')
      .derivedEdge(withParamsHash(derivedEdge(originalUrl, 'fetch.binary'),
        hashTransformParams({ url: originalUrl, final_url: finalUrl.href, requested_name: requestedName })))
      .mediaType(kind.mime)
      .sizeBytes(bytes.length)
      .sha256(sha256)
      .locator(managedLocator('artifacts', relativePath))
      .providerRef({ provider: 'web', externalId: finalUrl.href,
        ...(finalUrl.hostname === '' ? {} : { containerId: finalUrl.hostname }) })
      .capabilities({ readable: true, materializable: true, writable: false, shareable: false, sendable: true, deletable: true })
      .build();
    return {
      success: true, kind: 'external_file', url: originalUrl, finalUrl: finalUrl.href, redirected: originalUrl !== finalUrl.href,
      finalDomain: finalUrl.hostname, content: null, contentType: kind.mime, originalName: requestedName, rootId: 'artifacts',
      relativePath, locator: `runtime://artifacts/${relativePath}`, sha256, sizeBytes: bytes.length, objectHandle: handle,
      hasMore: false, nextStartIndex: null,
    };
  }
}

/** `serde_json::to_string_pretty` round trip; unparsable input is returned unchanged. */
function formatJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}
