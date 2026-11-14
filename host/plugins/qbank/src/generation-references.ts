/**
 * `qbank_generation/reference.rs::collect_references` 与
 * `question_authoring_runner.rs::load_source_bundle`（出题参考资料：按原始文件准备完整 SourceBundle）。
 *
 * 依赖的所有者服务（结构类型与发布签名一致）：
 * - L18 `pageRasterizer.rasterizePdfCancellable / rasterizeImages`，`docs.extractDocxWithImages /
 *   extractTextFromBase64`
 * - L13b `vfsRefText.extractFileTextWithStrategy`
 * - L11 `vfsRepo.files.getFile / blobs.getBlobPath / blobs.storeBlob`
 * - L15 review `prepareMediaTextForGeneration / containsMediaAnchor`
 * 不截断长正文、不按页数裁剪；读取失败进入 skipped 回传，不静默丢弃。
 */
import { fromBase64, toBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { containsMediaAnchor, prepareMediaTextForGeneration } from '../../review/api.ts';
import type { QbankGenerationRequest, SkippedReference } from '../api.ts';
import type { ReferenceBundle } from './generation-runner.ts';
import type { CropImageCodec } from './native-image.ts';
import type { QbankLogger } from './ports.ts';
import { QbankServiceError } from './question-service.ts';
import type { SourceBundle, SourcePage } from './source-bundle.ts';
import { qbankLocalRuntime } from './local-runtime.ts';

type JsonObject = { [key: string]: JsonValue };

/** L18 `PageRasterizerService` 的使用子集。 */
export interface PageRasterizerPort {
  rasterizePdfCancellable(base64Content: string, signal?: AbortSignal | null): Promise<RasterizeOutput>;
  rasterizeImages(content: string): Promise<RasterizeOutput>;
}
export interface RasterizeOutput {
  pages: { page_index: number; blob_hash: string; text_hint: string | null; width: number; height: number }[];
}
/** L18 `DocsService` 的使用子集。 */
export interface DocsPort {
  extractDocxWithImages(bytes: Uint8Array): Promise<{ text: string; images: Uint8Array[] }>;
  extractTextFromBase64(fileName: string, base64Content: string): Promise<string>;
}
/** L13b `VfsRefTextService` 的使用子集。 */
export interface RefTextPort {
  extractFileTextWithStrategy(conn: SqlExecutor, sourceId: string, fileName: string,
    base64Content: string | null): Promise<string | null>;
}

export interface ReferenceHost {
  readonly db: DatabaseHandle;
  readonly blobsDir: string;
  readonly repos: Pick<VfsReposService, 'files' | 'blobs'>;
  readonly rasterizer: PageRasterizerPort;
  readonly docs: DocsPort;
  readonly refText: RefTextPort;
  /** DOCX 内嵌图片解码取尺寸（Rust `image::load_from_memory`）。 */
  readonly nativeImage: Pick<CropImageCodec, 'decodeRgba'> | null;
  readonly log?: QbankLogger;
}

function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const wire = (error as { appError?: unknown; value?: unknown }).appError
      ?? (error as { value?: unknown }).value;
    if (wire !== null && typeof wire === 'object' && typeof (wire as { message?: unknown }).message === 'string') {
      return (wire as { message: string }).message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** 把所有者服务抛出的 CommandError(AppError) 原样转为 qbank 错误；其余按给定类型包装。 */
function rethrowAppError(error: unknown, fallback: (message: string) => ReturnType<typeof AppError.validation>): never {
  if (error instanceof QbankServiceError) throw error;
  const wire = error !== null && typeof error === 'object' ? (error as { value?: unknown }).value : undefined;
  if (wire !== null && typeof wire === 'object' && 'error_type' in (wire as object)) throw new QbankServiceError(wire);
  throw new QbankServiceError(fallback(messageOf(error)));
}

function sha256Hex(bytes: Uint8Array | string): string {
  return sha256HexSync(bytes);
}

/** Rust `extension`：小写扩展名，无扩展名时按 txt。 */
export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'txt';
  const ext = name.slice(dot + 1).toLowerCase();
  return ext === '' ? 'txt' : ext;
}

const BASE64_ALPHABET = /[A-Za-z0-9+/]/;

/** base64 crate `DecodeError` Display（STANDARD：要求规范填充）。 */
function base64Error(body: string): string | null {
  const padStart = body.replace(/=+$/, '').length;
  for (let index = 0; index < padStart; index += 1) {
    if (!BASE64_ALPHABET.test(body[index]!)) {
      return `Invalid symbol ${body.charCodeAt(index)}, offset ${index}.`;
    }
  }
  if (body.length % 4 !== 0 || body.length - padStart > 2) return 'Invalid padding';
  return null;
}

/** Rust `decode`：剥离 data URL 前缀后按 STANDARD（严格填充）解码。 */
export function decodeBase64(content: string): Uint8Array {
  const comma = content.indexOf(',');
  const body = content.startsWith('data:') && comma >= 0 ? content.slice(comma + 1) : content;
  const error = base64Error(body);
  if (error !== null) throw new QbankServiceError(AppError.validation(`源文件 base64 无效: ${error}`));
  return fromBase64(body);
}

/** image::guess_format 的扩展名映射（JPEG/WebP/GIF，其余 png）。 */
function imageExt(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  // `Buffer.from(bytes, 'latin1')` 等价：每个字节一个字符，只需要比较 ASCII 前缀。
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  return 'png';
}

function mimeOfExt(ext: string): string {
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}

function storeBlob(host: Pick<ReferenceHost, 'db' | 'blobsDir' | 'repos'>, bytes: Uint8Array, mime: string | null, ext: string | null) {
  try {
    return host.repos.blobs.storeBlob(host.db, host.blobsDir, bytes, mime, ext);
  } catch (error) {
    throw new QbankServiceError(AppError.database(messageOf(error)));
  }
}

/** 来源加载只用到的 ReferenceHost 子集（题目集导入不需要 refText）。 */
export type SourceLoaderHost = Omit<ReferenceHost, 'refText'>;

/** `question_authoring_runner.rs::ensure_active`。 */
function ensureActive(cancel: AbortSignal | null): void {
  if (cancel?.aborted === true) throw new QbankServiceError(AppError.validation('来源准备已取消'));
}

/** Rust `load_single_source_bundle`（`cancel` 对应 `load_source_bundle_cancellable` 传入的令牌）。 */
async function loadSingleSourceBundle(host: SourceLoaderHost, content: string, rawFormat: string,
  name: string, cancel: AbortSignal | null): Promise<SourceBundle> {
  ensureActive(cancel);
  const format = rawFormat.toLowerCase();
  const bundle: SourceBundle = { sources: [], pages: [], text: '', format };
  if (['pdf', 'image', 'png', 'jpg', 'jpeg', 'webp'].includes(format)) {
    let raster: RasterizeOutput;
    try {
      raster = format === 'pdf'
        ? await host.rasterizer.rasterizePdfCancellable(content, cancel)
        : await host.rasterizer.rasterizeImages(content);
    } catch (error) {
      rethrowAppError(error, AppError.internal);
    }
    bundle.pages = raster.pages.map((page): SourcePage => ({
      source_id: 's1', page: page.page_index + 1, blob_hash: page.blob_hash,
      width: page.width, height: page.height, text_hint: page.text_hint,
    }));
    bundle.sources.push({ source_id: 's1', name, format, page_count: bundle.pages.length });
    bundle.sources[0]!.content_hash = sha256Hex(bundle.pages.map(page => page.blob_hash).join('\n'));
  } else {
    const bytes = decodeBase64(content);
    if (format === 'docx') {
      let parsed: { text: string; images: Uint8Array[] };
      try {
        parsed = await host.docs.extractDocxWithImages(bytes);
      } catch (error) {
        throw new QbankServiceError(AppError.validation(`DOCX 解析失败: ${messageOf(error)}`));
      }
      bundle.text = parsed.text;
      for (const [index, imageBytes] of parsed.images.entries()) {
        const sourceId = `s1_img${index}`;
        if (host.nativeImage === null) {
          throw new QbankServiceError(AppError.configuration('图片处理能力不可用: nativeImage.decodeRgba 未提供'));
        }
        let decoded: { width: number; height: number };
        try {
          decoded = await host.nativeImage.decodeRgba(imageBytes);
        } catch (error) {
          throw new QbankServiceError(AppError.validation(
            `DOCX 图片 ${index} 无法解码，未忽略该图片: ${messageOf(error)}`));
        }
        const mime = mimeOfExt(imageExt(imageBytes));
        const blob = storeBlob(host, imageBytes, mime, null);
        bundle.sources.push({
          source_id: sourceId, name: `<<IMG:${index}>>`, format: 'image', mime, page_count: 1,
          anchor: `<<IMG:${index}>>`, blob_hash: blob.hash, content_hash: sha256Hex(imageBytes),
        });
        bundle.pages.push({ source_id: sourceId, page: 1, blob_hash: blob.hash, width: decoded.width,
          height: decoded.height, text_hint: null });
      }
    } else {
      try {
        bundle.text = await host.docs.extractTextFromBase64(`document.${format}`, content);
      } catch (error) {
        throw new QbankServiceError(AppError.validation(`文档解析失败: ${messageOf(error)}`));
      }
    }
    bundle.sources.unshift({ source_id: 's1', name, format, page_count: null, text: bundle.text });
  }
  // 每个来源描述都需要稳定身份；图片集合先规范化 JSON 数组再哈希。
  const imageList = content.trimStart().startsWith('[');
  let sourceBytes: Uint8Array;
  let sourceMime: string | null;
  let sourceExt: string;
  if (imageList) {
    let canonical: string;
    try {
      canonical = JSON.stringify(JSON.parse(content));
    } catch {
      canonical = content;
    }
    sourceBytes = utf8Encode(canonical);
    sourceMime = 'application/json';
    sourceExt = 'json';
  } else {
    sourceBytes = decodeBase64(content);
    sourceMime = null;
    sourceExt = format === 'image' ? imageExt(sourceBytes) : format;
  }
  const blob = storeBlob(host, sourceBytes, sourceMime, sourceExt);
  const first = bundle.sources[0];
  if (first !== undefined) {
    first.blob_hash = blob.hash;
    first.content_hash = sha256Hex(sourceBytes);
  }
  if (bundle.pages.length === 0 && bundle.text.trim() === '') {
    throw new QbankServiceError(AppError.validation('来源为空，无法解析题目'));
  }
  return bundle;
}

/**
 * Rust `load_source_bundle_cancellable`（含多文件 `bundle` 清单）；`cancel` 为 null 即 `load_source_bundle`。
 */
export async function loadSourceBundle(host: SourceLoaderHost, content: string, format: string,
  name: string, cancel: AbortSignal | null = null): Promise<SourceBundle> {
  ensureActive(cancel);
  if (format !== 'bundle') return loadSingleSourceBundle(host, content, format, name, cancel);
  let inputs: { name: string; format: string; content: string }[];
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.some(item => item === null || typeof item !== 'object'
      || typeof item.name !== 'string' || typeof item.format !== 'string' || typeof item.content !== 'string')) {
      throw new Error('invalid type: expected a sequence of {name, format, content}');
    }
    inputs = parsed as typeof inputs;
  } catch (error) {
    throw new QbankServiceError(AppError.validation(`多文件来源清单无效: ${messageOf(error)}`));
  }
  if (inputs.length === 0) throw new QbankServiceError(AppError.validation('来源文件列表为空'));
  const merged: SourceBundle = { sources: [], pages: [], text: '', format: 'bundle' };
  for (const [index, input] of inputs.entries()) {
    ensureActive(cancel);
    const source = await loadSingleSourceBundle(host, input.content, input.format, input.name, cancel);
    const prefix = `file${index + 1}_`;
    for (const entry of source.sources) {
      if (typeof entry.source_id === 'string') entry.source_id = `${prefix}${entry.source_id}`;
    }
    for (const page of source.pages) page.source_id = `${prefix}${page.source_id}`;
    merged.text += `\n\n<source id="${prefix}s1" name="${input.name}">\n${source.text}\n</source>\n`;
    merged.sources.push(...source.sources);
    merged.pages.push(...source.pages);
  }
  ensureActive(cancel);
  return merged;
}

type PreparedSource =
  | { kind: 'content'; name: string; format: string; base64: string }
  | { kind: 'text'; name: string; text: string };

class SourceUnavailable {
  readonly reason: string;
  readonly detail: string;
  constructor(reason: string, detail: string) {
    this.reason = reason;
    this.detail = detail;
  }
}

/** Rust `library_source`。 */
async function librarySource(host: ReferenceHost, fileId: string): Promise<PreparedSource> {
  let file;
  try {
    file = host.repos.files.getFile(host.db, fileId);
  } catch (error) {
    throw new SourceUnavailable('read_failed', messageOf(error));
  }
  if (file === null) throw new SourceUnavailable('file_not_found', fileId);

  if (file.fileType === 'audio' || file.fileType === 'video') {
    let text: string | null;
    try {
      text = await host.refText.extractFileTextWithStrategy(host.db, fileId, file.fileName, null);
    } catch (error) {
      throw new SourceUnavailable('read_failed', messageOf(error));
    }
    if (text === null) throw new SourceUnavailable('text_extract_failed', '音视频转写文本不可用');
    return { kind: 'text', name: file.fileName, text: prepareMediaTextForGeneration(host.db, fileId, text) };
  }

  const format = extension(file.fileName);
  let bytes: Uint8Array;
  if (file.blobHash !== undefined && file.blobHash !== null) {
    let blobPath: string | null;
    try {
      blobPath = host.repos.blobs.getBlobPath(host.db, host.blobsDir, file.blobHash);
    } catch (error) {
      throw new SourceUnavailable('read_failed', messageOf(error));
    }
    if (blobPath === null) throw new SourceUnavailable('read_failed', `blob 不存在: ${file.blobHash}`);
    try {
      bytes = qbankLocalRuntime().readFile(blobPath);
    } catch (error) {
      throw new SourceUnavailable('read_failed', messageOf(error));
    }
  } else if (file.extractedText !== undefined && file.extractedText !== null) {
    return { kind: 'text', name: file.fileName, text: file.extractedText };
  } else {
    throw new SourceUnavailable('read_failed', '文件没有 blob 或已提取文本');
  }
  return { kind: 'content', name: file.fileName, format, base64: toBase64(bytes) };
}

function skipped(name: string, reason: string, detail: string): SkippedReference {
  return { name, reason, detail };
}

function mergeLoaded(host: ReferenceHost, out: { bundle: SourceBundle; skipped: SkippedReference[] }, index: number,
  name: string, format: string, loaded: { ok: true; bundle: SourceBundle } | { ok: false; error: unknown }): void {
  if (!loaded.ok) {
    const message = messageOf(loaded.error);
    host.log?.warn(`[QbankGeneration] 参考文件 ${name} 准备失败: ${message}`);
    out.skipped.push(skipped(name, 'read_failed', message));
    return;
  }
  const bundle = loaded.bundle;
  const alias = `r${index + 1}`;
  const ids = new Map<string, string>();
  for (const source of bundle.sources) {
    const old = typeof source.source_id === 'string' ? source.source_id : 's1';
    const renamed = `${alias}_${old}`;
    source.source_id = renamed;
    ids.set(old, renamed);
  }
  for (const page of bundle.pages) {
    const renamed = ids.get(page.source_id);
    if (renamed !== undefined) page.source_id = renamed;
  }
  if (bundle.text.trim() !== '') {
    out.bundle.text += `\n\n===== 参考文件 r${index + 1}：${name} =====\n${bundle.text}`;
  }
  out.bundle.sources.push(...bundle.sources);
  out.bundle.pages.push(...bundle.pages);
  if (out.bundle.format === 'none') out.bundle.format = format;
  else if (out.bundle.format !== format) out.bundle.format = 'mixed';
}

function mergeText(out: { bundle: SourceBundle }, index: number, name: string, text: string): void {
  out.bundle.sources.push({
    source_id: `r${index + 1}_s1`, name, format: 'media_transcript', page_count: null,
    content_hash: sha256Hex(text),
  } satisfies JsonObject);
  out.bundle.text += `\n\n===== 参考文件 r${index + 1}：${name} =====\n${text}`;
}

async function attempt(load: () => Promise<SourceBundle>) {
  try {
    return { ok: true as const, bundle: await load() };
  } catch (error) {
    return { ok: false as const, error };
  }
}

/** Rust `collect_references`。 */
export async function collectReferences(host: ReferenceHost, request: QbankGenerationRequest): Promise<ReferenceBundle> {
  const out = {
    bundle: { sources: [], pages: [], text: '', format: 'none' } as SourceBundle,
    skipped: [] as SkippedReference[],
  };
  let index = 0;
  for (const fileId of request.reference_file_ids ?? []) {
    let prepared: PreparedSource;
    try {
      prepared = await librarySource(host, fileId);
    } catch (error) {
      if (!(error instanceof SourceUnavailable)) throw error;
      out.skipped.push(skipped(fileId, error.reason, error.detail));
      continue;
    }
    if (prepared.kind === 'content') {
      const { name, format, base64 } = prepared;
      mergeLoaded(host, out, index, name, format, await attempt(() => loadSourceBundle(host, base64, format, name)));
    } else {
      mergeText(out, index, prepared.name, prepared.text);
    }
    index += 1;
  }
  for (const upload of request.reference_files_base64 ?? []) {
    const format = extension(upload.name);
    mergeLoaded(host, out, index, upload.name, format,
      await attempt(() => loadSourceBundle(host, upload.base64, format, upload.name)));
    index += 1;
  }
  host.log?.info?.(`[QbankGeneration] 参考资料准备完成：来源 ${out.bundle.sources.length}，页图 ${out.bundle.pages.length}，跳过 ${out.skipped.length}，正文 ${Array.from(out.bundle.text).length} 字符`);
  return { bundle: out.bundle, skipped: out.skipped, hasMediaAnchors: containsMediaAnchor(out.bundle.text) };
}
