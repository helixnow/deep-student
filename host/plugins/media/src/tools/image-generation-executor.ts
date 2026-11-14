/**
 * `src/chat_v2/tools/image_generation_executor.rs`: built-in `image_generate`.
 *
 * Resolves the assigned (or first enabled image-capable) model, calls the
 * OpenAI-compatible `/images/generations` endpoint, downloads URL results through
 * `ctx.http` as a public destination, stores the image as a VFS attachment in the "AI 生成图片" folder
 * and wraps it in an `image` context resource. Progress is reported with
 * `image_gen` block events, not `tool_call` events, exactly as in Rust.
 */
import { STATUS_CODES } from 'node:http';
import { lookup } from 'node:dns/promises';
import { nanoid } from 'nanoid';
import { HttpError, type HttpService } from '../../../../platform/http/api.ts';
import { isBlockedInternalIp } from '../../../../platform/net-policy/index.ts';
import type { ChatExecutionContext, ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import type { ApiConfig } from '../../../llm/api.ts';
import type { JsonValue, VfsFolder, VfsReposService, VfsResourceMetadata } from '../../../vfs-repos/api.ts';
import { stripToolNamespace } from '../document-processing.ts';
import {
  buildImageGenerationUrl, decodeBase64ImagePayload, extractImageApiError, imageSizeForConfig,
  isImageGenerationConfig, parseImageGenerationResponse,
} from '../image-generation.ts';
import { argumentsOf, errorText, firstPresent, type ToolLogger } from './runtime.ts';

const NAME = 'ImageGenerationExecutor';
const TOOL_NAME = 'image_generate';
const TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_FOLDER_TITLE = 'AI 生成图片';
const IMAGE_GEN = 'image_gen';
const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export type ImageGenerationContext = Pick<ChatExecutionContext,
  'message_id' | 'block_id' | 'variant_id' | 'skill_state_version' | 'round_id' | 'emitter'
  | 'vfs_db' | 'llm_manager' | 'saveToolBlock'>
  & Partial<Pick<ChatExecutionContext, 'cancellation_token'>>;

function buildRequestSignal(cancelSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!cancelSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([cancelSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (cancelSignal.aborted) { abortFrom(cancelSignal); return controller.signal; }
  if (timeoutSignal.aborted) { abortFrom(timeoutSignal); return controller.signal; }
  cancelSignal.addEventListener('abort', () => abortFrom(cancelSignal), { once: true });
  timeoutSignal.addEventListener('abort', () => abortFrom(timeoutSignal), { once: true });
  return controller.signal;
}

export interface ImageGenerationDeps {
  /** The LLM HTTP client (`llmHttp.fetch`), as Rust uses reqwest for provider calls. */
  fetch(): typeof fetch;
  /** `ctx.http`: result URLs come from the provider response, so downloads use `destination: 'public'`. */
  publicHttp(): Pick<HttpService, 'fetch'> | null;
  repos(): Pick<VfsReposService, 'attachments' | 'folders' | 'resources'>;
  /** `image::load_from_memory(..).dimensions()`; `null` when undecodable. */
  dimensions(bytes: Uint8Array): Promise<{ width: number; height: number } | null>;
  /** Resolved addresses of a host, for the SSRF guard. */
  resolveHost(host: string): Promise<string[]>;
  now(): Date;
  log: ToolLogger;
}

interface ImageGenerationArgs { prompt: string; aspectRatio: string; quality: string; purpose: string | null }
interface ImageModel { config: ApiConfig; provider: string }
interface GeneratedImage { bytes: Uint8Array; b64: string; mimeType: string; revisedPrompt: string | null }

function parseArgs(value: unknown): ImageGenerationArgs {
  const args = argumentsOf(value);
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt === '') throw new Error('图片生成需要 prompt 参数');
  const ratio = firstPresent(args.aspectRatio, args.aspect_ratio);
  const aspectRatio = typeof ratio === 'string' && ASPECT_RATIOS.includes(ratio) ? ratio : '1:1';
  const quality = typeof args.quality === 'string' && QUALITIES.includes(args.quality) ? args.quality : 'auto';
  const purpose = typeof args.purpose === 'string' && args.purpose.trim() !== '' ? args.purpose.trim() : null;
  return { prompt, aspectRatio, quality, purpose };
}

function providerLabel(config: ApiConfig): string {
  return config.vendorName ?? config.providerType ?? 'OpenAI Compatible';
}

function validateModelConfig(config: ApiConfig): void {
  if (config.baseUrl.trim() === '') throw new Error('生图模型缺少 Base URL');
  if (config.model.trim() === '') throw new Error('生图模型缺少 model 名称');
  const key = config.apiKey.trim();
  if (key === '' || [...key].every(c => c === '*')) throw new Error('生图模型缺少 API key');
  if (!config.enabled) throw new Error('生图模型未启用，或 API key 不可用');
}

/** `infer_image_mime_type` over the formats `image::guess_format` maps. */
export function inferImageMimeType(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (ascii(0, 'BM')) return 'image/bmp';
  return null;
}

function imageFileName(mimeType: string, now: Date): string {
  const extension: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  };
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `ai-generated-image-${stamp}.${extension[mimeType] ?? 'png'}`;
}

/** `shorten`: at most `maxLen` UTF-8 bytes on a char boundary, then `...`. */
function shorten(value: string, maxLen: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxLen) return value;
  let out = '';
  let size = 0;
  for (const ch of value) {
    const width = Buffer.byteLength(ch, 'utf8');
    if (size + width > maxLen) break;
    out += ch;
    size += width;
  }
  return `${out}...`;
}

/** The whole body, or `null` once it exceeds `maxBytes` (declared or streamed). */
async function readUpTo(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(next.value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** reqwest `StatusCode` Display: `"404 Not Found"`. */
function statusText(status: number): string {
  const reason = STATUS_CODES[status];
  return reason === undefined ? String(status) : `${status} ${reason}`;
}

export class ImageGenerationExecutor {
  private readonly deps: ImageGenerationDeps;

  constructor(deps: ImageGenerationDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return stripToolNamespace(toolName) === TOOL_NAME; }

  sensitivityLevel(_toolName: string): 'low' { return 'low'; }

  async execute(call: ToolCall, context: ImageGenerationContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const failure = (error: string): ToolResultInfo => ({
      toolCallId: call.id, blockId: context.block_id, toolName: call.name, input: call.arguments,
      output: null, success: false, error, durationMs: Math.trunc(performance.now() - started),
    });
    let args: ImageGenerationArgs;
    try { args = parseArgs(call.arguments); }
    catch (error) {
      const rawPrompt = call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        && typeof (call.arguments as { prompt?: unknown }).prompt === 'string'
        ? (call.arguments as { prompt: string }).prompt : '';
      this.emitStart(context, { prompt: rawPrompt, aspectRatio: '1:1', quality: 'auto', purpose: null }, '', null, call.id);
      this.emitError(context, errorText(error));
      const result = failure(errorText(error));
      this.saveIgnoringFailure(context, result);
      return result;
    }
    let model: ImageModel;
    try { model = await this.resolveModel(context); }
    catch (error) {
      this.emitStart(context, args, '', null, call.id);
      this.emitError(context, errorText(error));
      const result = failure(errorText(error));
      this.saveIgnoringFailure(context, result);
      return result;
    }

    this.emitStart(context, args, model.config.model, model.config, call.id);
    const [requestedWidth, requestedHeight] = imageSizeForConfig(model.config, args.aspectRatio);
    let result: ToolResultInfo;
    try {
      if (context.cancellation_token?.aborted) {
        throw new Error('生图请求已取消');
      }
      const generated = await this.requestImage(args, model, context.cancellation_token);
      const dimensions = await this.deps.dimensions(generated.bytes);
      const output = await this.saveToVfs(context, args, model, generated,
        dimensions?.width ?? requestedWidth, dimensions?.height ?? requestedHeight);
      this.emitEnd(context, output);
      result = {
        toolCallId: call.id, blockId: context.block_id, toolName: call.name, input: call.arguments,
        output, success: true, durationMs: Math.trunc(performance.now() - started),
      };
    } catch (error) {
      this.emitError(context, errorText(error));
      result = failure(errorText(error));
    }
    try { context.saveToolBlock(result); }
    catch (error) { this.deps.log.warn(`[${NAME}] Failed to save tool block: ${errorText(error)}`); }
    return result;
  }

  /** Rust `let _ = ctx.save_tool_block(..)` on the early-failure paths: the result stands. */
  private saveIgnoringFailure(context: ImageGenerationContext, result: ToolResultInfo): void {
    try { context.saveToolBlock(result); }
    catch (error) { this.deps.log.debug(`[${NAME}] Failed to save tool block: ${errorText(error)}`); }
  }

  private async resolveModel(context: ImageGenerationContext): Promise<ImageModel> {
    const llm = context.llm_manager;
    if (llm === null) throw new Error('LLM 管理器不可用，无法读取生图模型配置');
    let assignments;
    try { assignments = await llm.getModelAssignments(); }
    catch (error) { throw new Error(`读取模型分配失败: ${errorText(error)}`); }
    let configs: ApiConfig[];
    try { configs = await llm.getApiConfigs(); }
    catch (error) { throw new Error(`读取 API 配置失败: ${errorText(error)}`); }
    const assigned = assignments.image_generation_model_config_id;
    if (assigned != null && assigned.trim() !== '') {
      const config = configs.find(item => item.id === assigned);
      if (config === undefined) throw new Error(`已选择的生图模型不存在: ${assigned}`);
      validateModelConfig(config);
      return { config, provider: providerLabel(config) };
    }
    const config = configs.find(item => item.enabled && isImageGenerationConfig(item));
    if (config === undefined) throw new Error('未配置可用的生图模型，请先在设置中选择“生图模型”');
    validateModelConfig(config);
    return { config, provider: providerLabel(config) };
  }

  private async requestImage(
    args: ImageGenerationArgs, model: ImageModel, cancelSignal?: AbortSignal | null,
  ): Promise<GeneratedImage> {
    const [, , size] = imageSizeForConfig(model.config, args.aspectRatio);
    const endpoint = buildImageGenerationUrl(model.config.baseUrl);
    const headers = new Headers();
    try { headers.set('authorization', `Bearer ${model.config.apiKey.trim()}`); }
    catch (error) { throw new Error(`API key 头部格式无效: ${errorText(error)}`); }
    headers.set('content-type', 'application/json');
    for (const [key, value] of Object.entries(model.config.headers ?? {})) {
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower === 'content-type') continue;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
        this.deps.log.warn(`[${NAME}] Skip invalid header name: ${key}`);
        continue;
      }
      try { headers.set(key, value); }
      catch { this.deps.log.warn(`[${NAME}] Skip invalid header value: ${key}`); }
    }
    const signal = buildRequestSignal(cancelSignal, TOOL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.deps.fetch()(endpoint, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          model: model.config.model, prompt: args.prompt, size, quality: args.quality, n: 1,
        }),
      });
    } catch (error) { throw new Error(`生图请求失败: ${errorText(error)}`); }
    let body: string;
    try { body = await response.text(); }
    catch (error) { throw new Error(`读取生图响应失败: ${errorText(error)}`); }
    let value: unknown;
    try { value = JSON.parse(body); }
    catch (error) { throw new Error(`生图响应不是有效 JSON: ${errorText(error)}，body=${shorten(body, 280)}`); }
    if (!response.ok) {
      throw new Error(extractImageApiError(value) ?? `生图接口返回 HTTP ${statusText(response.status)}`);
    }
    const parsed = parseImageGenerationResponse(value);
    if (parsed.b64_json !== null) {
      const bytes = decodeBase64ImagePayload(parsed.b64_json);
      return {
        bytes, b64: Buffer.from(bytes).toString('base64'),
        mimeType: inferImageMimeType(bytes) ?? 'image/png', revisedPrompt: parsed.revised_prompt,
      };
    }
    if (parsed.url === null) throw new Error('生图响应没有 b64_json 或 url');
    return this.download(parsed.url, parsed.revised_prompt, signal);
  }

  /** `download_image_url`: http(s) only; private/metadata addresses blocked on every hop, loopback allowed. */
  private async download(url: string, revisedPrompt: string | null, signal: AbortSignal): Promise<GeneratedImage> {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch (error) { throw new Error(`生图 URL 无效: ${errorText(error)}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('生图 URL 只支持 http/https');
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
    if (host === '') throw new Error('生图 URL 缺少 host');
    let addresses: string[];
    try { addresses = await this.deps.resolveHost(host); }
    catch (error) { throw new Error(`生图 URL DNS 解析失败: ${errorText(error)}`); }
    if (addresses.length === 0 || addresses.some(address => isBlockedInternalIp(address))) {
      throw new Error('生图 URL 指向被封锁的内网地址');
    }
    const http = this.deps.publicHttp();
    if (http === null) throw new Error('下载生成图片失败: HTTP 服务不可用（需要 http）');
    let response: Response;
    try {
      // RUST-FIX(RF-W04-image-download-redirect-cap): reqwest followed up to 10 redirects without re-checking the target.
      response = await http.fetch(parsed, { method: 'GET', signal, destination: 'public' });
    } catch (error) {
      if (error instanceof HttpError && error.kind === 'BlockedDestination') throw new Error('生图 URL 指向被封锁的内网地址');
      throw new Error(`下载生成图片失败: ${errorText(error)}`);
    }
    if (!response.ok) throw new Error(`下载生成图片返回 HTTP ${statusText(response.status)}`);
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? null;
    let bytes: Uint8Array | null;
    // RUST-FIX(RF-W04-image-download-redirect-cap): Rust buffered the whole body whatever its size.
    try { bytes = await readUpTo(response, MAX_DOWNLOAD_BYTES); }
    catch (error) { throw new Error(`读取生成图片 bytes 失败: ${errorText(error)}`); }
    if (bytes === null) throw new Error(`生成图片超过 ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB 上限`);
    const mimeType = (contentType !== null && contentType.startsWith('image/') ? contentType : null)
      ?? inferImageMimeType(bytes) ?? 'image/png';
    return { bytes, b64: Buffer.from(bytes).toString('base64'), mimeType, revisedPrompt };
  }

  private ensureFolder(context: ImageGenerationContext): string {
    const database = context.vfs_db!;
    const folders = this.deps.repos().folders;
    try {
      const conn = database.getConnSafe();
      const existing = folders.listFoldersByParent(conn, null).find(folder => folder.title === DEFAULT_FOLDER_TITLE);
      if (existing !== undefined) return existing.id;
      const now = this.deps.now().getTime();
      const folder: VfsFolder = {
        id: `fld_${nanoid(10)}`, title: DEFAULT_FOLDER_TITLE, icon: 'image', color: 'blue',
        isExpanded: true, isFavorite: false, sortOrder: 0, createdAt: now, updatedAt: now,
      };
      folders.createFolder(conn, folder);
      return folder.id;
    } catch (error) { throw new Error(errorText(error)); }
  }

  private async saveToVfs(
    context: ImageGenerationContext, args: ImageGenerationArgs, model: ImageModel,
    generated: GeneratedImage, width: number, height: number,
  ): Promise<Record<string, unknown>> {
    const database = context.vfs_db;
    if (database === null) throw new Error('VFS 数据库不可用，无法保存生成图片');
    const folderId = this.ensureFolder(context);
    const now = this.deps.now();
    const fileName = imageFileName(generated.mimeType, now);
    const repos = this.deps.repos();
    let upload;
    try {
      upload = await repos.attachments.uploadWithFolderConn(database.getConnSafe(), database.blobsDir(), {
        name: fileName, mimeType: generated.mimeType, base64Content: generated.b64, type: 'image',
      }, folderId);
    } catch (error) { throw new Error(`保存生成图片到 VFS 失败: ${errorText(error)}`); }
    const refData = {
      refs: [{
        sourceId: upload.sourceId,
        resourceHash: upload.resourceHash,
        type: 'image',
        name: fileName,
        resourceId: upload.attachment.resourceId ?? null,
      }],
      totalCount: 1,
      truncated: false,
    };
    const extra: JsonValue = {
      source: 'image_generation',
      prompt: args.prompt,
      model: model.config.model,
      provider: model.provider,
      aspectRatio: args.aspectRatio,
      quality: args.quality,
      purpose: args.purpose,
      createdAt: now.toISOString(),
      revisedPrompt: generated.revisedPrompt,
      sourceId: upload.sourceId,
      attachmentHash: upload.resourceHash,
      folderId,
    };
    const metadata: VfsResourceMetadata = {
      name: fileName, title: fileName, mimeType: generated.mimeType, size: generated.bytes.length,
      source: 'image_generation', extra,
    };
    let wrapper;
    try {
      wrapper = repos.resources.createOrReuse(database.getConnSafe(), 'image', JSON.stringify(refData),
        upload.sourceId, null, metadata);
    } catch (error) { throw new Error(`创建生成图片上下文引用失败: ${errorText(error)}`); }
    return {
      imageUrl: `data:${generated.mimeType};base64,${generated.b64}`,
      sourceId: upload.sourceId,
      resourceId: wrapper.resourceId,
      resourceHash: wrapper.hash,
      attachmentHash: upload.resourceHash,
      mimeType: generated.mimeType,
      width,
      height,
      prompt: args.prompt,
      model: model.config.model,
      provider: model.provider,
      params: { aspectRatio: args.aspectRatio, quality: args.quality, purpose: args.purpose },
      revisedPrompt: generated.revisedPrompt,
      fileName,
      folderId,
    };
  }

  private emitStart(
    context: ImageGenerationContext, args: ImageGenerationArgs, model: string, config: ApiConfig | null, toolCallId?: string,
  ): void {
    const [width, height] = imageSizeForConfig(config, args.aspectRatio);
    context.emitter.emitStartWithMeta(IMAGE_GEN, context.message_id, context.block_id, {
      ...(toolCallId ? { toolCallId } : {}),
      prompt: args.prompt, width, height, model,
      params: { aspectRatio: args.aspectRatio, quality: args.quality, purpose: args.purpose },
    }, context.variant_id, context.skill_state_version, context.round_id);
  }

  private emitEnd(context: ImageGenerationContext, output: unknown): void {
    context.emitter.emitEndWithMeta(IMAGE_GEN, context.block_id, output,
      context.variant_id, context.skill_state_version, context.round_id);
  }

  private emitError(context: ImageGenerationContext, error: string): void {
    context.emitter.emitErrorWithMeta(IMAGE_GEN, context.block_id, error,
      context.variant_id, context.skill_state_version, context.round_id);
  }
}

/** Production host resolution (`(host, port).to_socket_addrs()`). */
export async function resolveHostAddresses(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map(entry => entry.address);
}
