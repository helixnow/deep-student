/**
 * Generative UI — 图片来源解析（无 React）
 *
 * 方案第 4 节：
 * - resource：invoke('vfs_get_attachment_content', { attachmentId, maxBytes: 10MB }) → base64 → 字节 →
 *   魔数嗅探（仅 png / jpeg / gif / webp，拒绝 svg / pdf 等）→ Blob（由 hook 转 Blob URL，卸载 revoke）。
 *   不用 convertFileSrc。
 * - pdf-page：getPdfPageImage(resourceId, page - 1)（后端 0 基页码），校验 size ≤10MB、MIME 白名单。
 * - url：仅 https + isAllowedGenerativeImageUrl；前端不主动 fetch，交给 <img referrerPolicy="no-referrer">。
 * - 单图 ≤10MB；同一 intent 总预算 25MB（GenerativeImageBudget）；解码结果 LRU 32。
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getPdfPageImage as defaultGetPdfPageImage } from '@/api/vfsRagApi';
import { generativeImageSourceSchema, isAllowedGenerativeImageUrl, type GenerativeImageSource } from '../schema';
import { isDangerousGenerativeUrl } from '../utils/sanitizeGenerativeUrl';

/** 单图上限 10MB */
export const GENUI_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 同一 intent 图片总预算 25MB */
export const GENUI_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;
/** 解码缓存条目上限 */
export const GENUI_IMAGE_CACHE_MAX_ENTRIES = 32;
/** 解码缓存总字节上限（防 32×10MB 常驻） */
export const GENUI_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export const GENUI_IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type GenerativeImageMime = (typeof GENUI_IMAGE_MIME_WHITELIST)[number];

export type GenerativeImageFailureReason =
  | 'invalid_source'
  | 'not_found'
  | 'too_large'
  | 'unsupported_type'
  | 'load_failed'
  | 'budget_exceeded';

export type GenerativeImageResolution =
  | { ok: true; kind: 'url'; key: string; src: string }
  | { ok: true; kind: 'blob'; key: string; blob: Blob; bytes: number; mime: GenerativeImageMime }
  | { ok: false; key: string; reason: GenerativeImageFailureReason };

interface AttachmentContentResult {
  content?: string | null;
  found?: boolean;
  error?: string | null;
}

interface PdfPageImageLike {
  base64: string;
  mimeType?: string;
  size?: number;
}

export interface ResolveGenerativeImageDeps {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  getPdfPageImage: (resourceId: string, pageIndex: number) => Promise<PdfPageImageLike>;
}

const defaultDeps: ResolveGenerativeImageDeps = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  getPdfPageImage: (resourceId, pageIndex) => defaultGetPdfPageImage(resourceId, pageIndex),
};

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 来源的稳定缓存 / 预算 key */
export function generativeImageSourceKey(source: GenerativeImageSource): string {
  switch (source.kind) {
    case 'resource':
      return `resource:${source.resourceId}`;
    case 'pdf-page':
      return `pdf-page:${source.resourceId}:${source.page}`;
    case 'url':
      return `url:${source.url}`;
    default:
      return 'invalid';
  }
}

/** 魔数嗅探：只认 png / jpeg / gif / webp；其余（svg、pdf、html…）一律 null */
export function sniffGenerativeImageMime(bytes: Uint8Array): GenerativeImageMime | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/** base64 解码后的字节数（不实际解码，用于先拒超大） */
export function estimateBase64DecodedBytes(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** 允许 data URL 前缀（部分后端返回 data:…;base64,xxx） */
function stripDataUrlPrefix(base64: string): string {
  const comma = base64.startsWith('data:') ? base64.indexOf(',') : -1;
  return comma >= 0 ? base64.slice(comma + 1) : base64;
}

export function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 外链规则：仅 https、非危险 scheme、过 isAllowedGenerativeImageUrl（拒绝凭据 / localhost / IP / 单标签主机） */
export function isRenderableGenerativeImageUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  if (isDangerousGenerativeUrl(url)) return false;
  return isAllowedGenerativeImageUrl(url);
}

function bytesToResolution(
  key: string,
  base64Raw: string,
): GenerativeImageResolution {
  const base64 = stripDataUrlPrefix(base64Raw);
  if (estimateBase64DecodedBytes(base64) > GENUI_IMAGE_MAX_BYTES) {
    return { ok: false, key, reason: 'too_large' };
  }
  const bytes = decodeBase64ToBytes(base64);
  if (!bytes || bytes.length === 0) return { ok: false, key, reason: 'load_failed' };
  if (bytes.length > GENUI_IMAGE_MAX_BYTES) return { ok: false, key, reason: 'too_large' };
  const mime = sniffGenerativeImageMime(bytes);
  if (!mime) return { ok: false, key, reason: 'unsupported_type' };
  // 以嗅探结果为准，不信任后端 / 模型声明的 MIME。
  // 拷到新建的 Uint8Array（底层必为 ArrayBuffer）：新版 TS lib 不接受
  // Uint8Array<ArrayBufferLike> 作为 BlobPart（可能是 SharedArrayBuffer）。
  const blobBytes = new Uint8Array(bytes.length);
  blobBytes.set(bytes);
  const blob = new Blob([blobBytes], { type: mime });
  return { ok: true, kind: 'blob', key, blob, bytes: bytes.length, mime };
}

function looksLikeTooLarge(message: unknown): boolean {
  return typeof message === 'string' && /too large|exceed|max_bytes|超过|过大/i.test(message);
}

// ---------------------------------------------------------------------------
// LRU 缓存（只缓存成功解码的 Blob；Blob URL 由每个挂载点自建自 revoke）
// ---------------------------------------------------------------------------

type CachedBlob = Extract<GenerativeImageResolution, { kind: 'blob' }>;

const blobCache = new Map<string, CachedBlob>();
const inflight = new Map<string, Promise<GenerativeImageResolution>>();

function cacheGet(key: string): CachedBlob | undefined {
  const hit = blobCache.get(key);
  if (!hit) return undefined;
  blobCache.delete(key);
  blobCache.set(key, hit);
  return hit;
}

function cacheSet(entry: CachedBlob): void {
  blobCache.delete(entry.key);
  blobCache.set(entry.key, entry);
  let total = 0;
  for (const value of blobCache.values()) total += value.bytes;
  while (
    blobCache.size > GENUI_IMAGE_CACHE_MAX_ENTRIES ||
    (total > GENUI_IMAGE_CACHE_MAX_BYTES && blobCache.size > 1)
  ) {
    const oldestKey = blobCache.keys().next().value as string;
    total -= blobCache.get(oldestKey)?.bytes ?? 0;
    blobCache.delete(oldestKey);
  }
}

/** 测试 / 诊断：缓存键（按 LRU 顺序，最旧在前） */
export function getGenerativeImageCacheKeys(): string[] {
  return [...blobCache.keys()];
}

export function clearGenerativeImageCache(): void {
  blobCache.clear();
  inflight.clear();
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function resolveUncached(
  source: Exclude<GenerativeImageSource, { kind: 'url' }>,
  key: string,
  deps: ResolveGenerativeImageDeps,
): Promise<GenerativeImageResolution> {
  if (source.kind === 'resource') {
    let result: AttachmentContentResult | null;
    try {
      result = (await deps.invoke('vfs_get_attachment_content', {
        attachmentId: source.resourceId,
        maxBytes: GENUI_IMAGE_MAX_BYTES,
      })) as AttachmentContentResult | null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, key, reason: looksLikeTooLarge(message) ? 'too_large' : 'load_failed' };
    }
    if (!result || result.found === false || typeof result.content !== 'string' || !result.content) {
      if (looksLikeTooLarge(result?.error)) return { ok: false, key, reason: 'too_large' };
      return { ok: false, key, reason: 'not_found' };
    }
    return bytesToResolution(key, result.content);
  }

  // pdf-page：模型给 1 基页码，后端 0 基
  let page: PdfPageImageLike;
  try {
    page = await deps.getPdfPageImage(source.resourceId, source.page - 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, key, reason: looksLikeTooLarge(message) ? 'too_large' : 'load_failed' };
  }
  if (!page || typeof page.base64 !== 'string' || !page.base64) {
    return { ok: false, key, reason: 'not_found' };
  }
  if (typeof page.size === 'number' && page.size > GENUI_IMAGE_MAX_BYTES) {
    return { ok: false, key, reason: 'too_large' };
  }
  if (
    typeof page.mimeType === 'string' &&
    page.mimeType &&
    !(GENUI_IMAGE_MIME_WHITELIST as readonly string[]).includes(page.mimeType.toLowerCase())
  ) {
    return { ok: false, key, reason: 'unsupported_type' };
  }
  return bytesToResolution(key, page.base64);
}

/**
 * 解析一个图片来源。永不 throw；失败返回 { ok:false, reason }。
 * url 来源不发请求，只做规则校验。
 */
export async function resolveGenerativeImage(
  rawSource: unknown,
  deps: ResolveGenerativeImageDeps = defaultDeps,
): Promise<GenerativeImageResolution> {
  const parsed = generativeImageSourceSchema.safeParse(rawSource);
  if (!parsed.success) return { ok: false, key: 'invalid', reason: 'invalid_source' };
  const source = parsed.data;
  const key = generativeImageSourceKey(source);

  if (source.kind === 'url') {
    return isRenderableGenerativeImageUrl(source.url)
      ? { ok: true, kind: 'url', key, src: source.url }
      : { ok: false, key, reason: 'invalid_source' };
  }

  const cached = cacheGet(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = resolveUncached(source, key, deps)
    .then((resolution) => {
      if (resolution.ok && resolution.kind === 'blob') cacheSet(resolution);
      return resolution;
    })
    .catch((): GenerativeImageResolution => ({ ok: false, key, reason: 'load_failed' }))
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

// ---------------------------------------------------------------------------
// 预算（同一渲染器实例共享；同一 key 只计一次）
// ---------------------------------------------------------------------------

export class GenerativeImageBudget {
  private readonly entries = new Map<string, { bytes: number; holders: Set<string> }>();
  private usedBytes = 0;

  constructor(readonly limitBytes: number = GENUI_IMAGE_BUDGET_BYTES) {}

  get used(): number {
    return this.usedBytes;
  }

  /** 预留 bytes；同一 key 已被预留时只登记 holder，不重复计数。超预算返回 false。 */
  tryReserve(key: string, holder: string, bytes: number): boolean {
    const existing = this.entries.get(key);
    if (existing) {
      existing.holders.add(holder);
      return true;
    }
    if (this.usedBytes + bytes > this.limitBytes) return false;
    this.entries.set(key, { bytes, holders: new Set([holder]) });
    this.usedBytes += bytes;
    return true;
  }

  release(key: string, holder: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.holders.delete(holder);
    if (entry.holders.size === 0) {
      this.entries.delete(key);
      this.usedBytes -= entry.bytes;
    }
  }
}
