/**
 * `dstu-vision/src/vlm_grounding_service.rs`: request-body shaping, UTF-8
 * truncation, DOCX stream budget, image-budget guards and image-index
 * remapping. JPEG re-encoding for oversized images needs F7 native image
 * support; the VLM command itself also needs L02.
 */
import { decodeBase64Standard } from './base64.ts';
import { decodeUtf8Lossy, encodeUtf8 } from '../../../platform/util/portable.ts';

export const DOCX_VLM_MAX_IMAGE_BYTES = 1_500_000;
export const DOCX_VLM_MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;
export const DOCX_VLM_MAX_SOURCE_PIXELS = 64_000_000;
export const DOCX_VLM_MAX_DIMENSION = 1_600;
export const DOCX_VLM_MAX_IMAGES = 36;
export const DOCX_VLM_MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const DOCX_VLM_STREAM_IDLE_TIMEOUT_SECS = 120;
export const DOCX_VLM_MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

export interface VlmApiConfig {
  model: string;
  maxOutputTokens: number;
  maxTokensLimit: number | null;
}

/** `llm_manager::effective_max_tokens`（dstu-llm/src/llm_manager/mod.rs:4082） */
export function effectiveMaxTokens(maxOutputTokens: number, maxTokensLimit: number | null): number {
  return maxTokensLimit === null ? maxOutputTokens : Math.min(maxOutputTokens, maxTokensLimit);
}

export function buildVlmRequestBody(
  config: VlmApiConfig,
  messages: readonly unknown[],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.1,
    max_tokens: effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit),
  };
  if (stream) body.stream = true;
  return body;
}

/** 按字节上限截断字符串，并保证落在 UTF-8 字符边界上。 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = encodeUtf8(s);
  if (bytes.length <= maxBytes) return s;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return decodeUtf8Lossy(bytes.subarray(0, end));
}

/** 累计 SSE 原始字节；溢出或超过 16MB 硬上限时失败。 */
export function accountDocxVlmStreamBytes(total: number, incoming: number): number {
  const next = total + incoming;
  if (!Number.isSafeInteger(next) || next > DOCX_VLM_MAX_STREAM_BYTES) {
    throw new Error(`VLM DOCX 流式响应超过 ${DOCX_VLM_MAX_STREAM_BYTES / (1024 * 1024)}MB 安全上限`);
  }
  return next;
}

export interface VlmExtractedOption {
  key: string;
  content: string;
}

export interface VlmExtractedQuestion {
  content: string;
  question_type: string;
  options: VlmExtractedOption[];
  answer: string;
  explanation: string;
  image_indices: number[];
  difficulty: string;
  tags: string[];
}

/** 已准备图片的顺序 → 原始图片下标；越界项被丢弃（vlm_grounding_service.rs:286）。 */
export interface PreparedDocxImage {
  dataUrl: string;
  sourceIndex: number;
  byteLen: number;
}

export interface PreparedDocxImages {
  images: PreparedDocxImage[];
  rejected: Array<[number, string]>;
  omittedByCount: number;
  totalBytes: number;
}

function pngSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50
    || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function jpegSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunk === 'VP8X') {
    const u24le = (offset: number): number =>
      bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    return [1 + u24le(24), 1 + u24le(27)];
  }
  if (chunk === 'VP8 ') {
    return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
  return null;
}

/** `detect_image_format` + `Reader::into_dimensions` 的头部尺寸解析。 */
function imageDimensions(bytes: Uint8Array): [number, number] | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

/**
 * `prepare_docx_image`：校验 data URL / Base64 / 尺寸预算。小图无需重编码时原样
 * 返回；需要缩放或重压缩的图片依赖原生图片编解码（F7），显式失败而不是放行
 * 未确认大小的内容。
 */
export function prepareDocxImage(dataUrl: string, sourceIndex: number): PreparedDocxImage {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('缺少 data URL 分隔符');
  const header = dataUrl.slice(0, comma);
  if (!header.startsWith('data:image/') || !header.includes(';base64')) {
    throw new Error('不是受支持的 base64 图片 data URL');
  }
  const payload = dataUrl.slice(comma + 1).trim();
  const upperBound = Math.floor((payload.length + 3) / 4) * 3;
  if (!Number.isSafeInteger(upperBound)) throw new Error('base64 长度溢出');
  if (upperBound > DOCX_VLM_MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`源图片可能超过 ${DOCX_VLM_MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)}MB 上限`);
  }
  let bytes: Uint8Array;
  try { bytes = decodeBase64Standard(payload); }
  catch (error) {
    throw new Error(`base64 解码失败: ${(error as Error).message}`);
  }
  if (bytes.length === 0) throw new Error('图片内容为空');
  if (bytes.length > DOCX_VLM_MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`源图片超过 ${DOCX_VLM_MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)}MB 上限`);
  }
  const dimensions = imageDimensions(bytes);
  if (dimensions === null) throw new Error('无法识别图片格式');
  const [width, height] = dimensions;
  const pixels = width * height;
  if (width === 0 || height === 0 || pixels > DOCX_VLM_MAX_SOURCE_PIXELS) {
    throw new Error(`图片尺寸 ${width}x${height} 超出安全上限`);
  }
  if (bytes.length <= DOCX_VLM_MAX_IMAGE_BYTES
    && width <= DOCX_VLM_MAX_DIMENSION && height <= DOCX_VLM_MAX_DIMENSION) {
    return { dataUrl, sourceIndex, byteLen: bytes.length };
  }
  throw new Error('图片压缩需要原生图片编解码（F7）');
}

/** `prepare_docx_images`：逐张准备并执行整批字节预算。 */
export function prepareDocxImages(
  candidateUrls: readonly string[],
  totalInputCount: number,
): PreparedDocxImages {
  const prepared: PreparedDocxImages = {
    images: [],
    rejected: [],
    omittedByCount: Math.max(0, totalInputCount - candidateUrls.length),
    totalBytes: 0,
  };
  candidateUrls.forEach((dataUrl, sourceIndex) => {
    let image: PreparedDocxImage;
    try { image = prepareDocxImage(dataUrl, sourceIndex); }
    catch (error) {
      prepared.rejected.push([sourceIndex, (error as Error).message]);
      return;
    }
    const nextTotal = prepared.totalBytes + image.byteLen;
    if (!Number.isSafeInteger(nextTotal)) {
      prepared.rejected.push([sourceIndex, '图片总字节数溢出']);
      return;
    }
    if (nextTotal > DOCX_VLM_MAX_TOTAL_IMAGE_BYTES) {
      prepared.rejected.push([sourceIndex,
        `加入后超过整批 ${DOCX_VLM_MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)}MB 图片预算`]);
      return;
    }
    prepared.totalBytes = nextTotal;
    prepared.images.push(image);
  });
  return prepared;
}

export function remapDocxQuestionImageIndices(
  question: VlmExtractedQuestion,
  sourceIndices: readonly number[],
): void {
  question.image_indices = question.image_indices
    .map(index => sourceIndices[index])
    .filter((value): value is number => value !== undefined);
}
