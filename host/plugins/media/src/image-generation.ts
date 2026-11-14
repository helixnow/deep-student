/**
 * `src/chat_v2/tools/image_generation_executor.rs`: request/response shaping for
 * the built-in image generation tool (executor: `tools/image-generation-executor.ts`).
 */
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';
import { rustTrim } from './transcript.ts';

export interface ImageApiConfig {
  name: string;
  model: string;
  vendorName?: string | null;
  providerType?: string | null;
  baseUrl?: string;
  isImageGeneration?: boolean;
}

export interface ParsedImageGenerationResponse {
  b64_json: string | null;
  url: string | null;
  revised_prompt: string | null;
}

export type ImageSize = [number, number, string];

export function imageSizeForAspectRatio(aspectRatio: string): ImageSize {
  let size: [number, number];
  switch (aspectRatio) {
    case '4:3':
    case '16:9':
      size = [1536, 1024];
      break;
    case '3:4':
    case '9:16':
      size = [1024, 1536];
      break;
    default:
      size = [1024, 1024];
  }
  return [size[0], size[1], `${size[0]}x${size[1]}`];
}

export function imageSizeForSensenova(aspectRatio: string): ImageSize {
  let size: [number, number];
  switch (aspectRatio) {
    case '4:3':
      size = [2368, 1760];
      break;
    case '16:9':
      size = [2752, 1536];
      break;
    case '3:4':
      size = [1760, 2368];
      break;
    case '9:16':
      size = [1536, 2752];
      break;
    default:
      size = [2048, 2048];
  }
  return [size[0], size[1], `${size[0]}x${size[1]}`];
}

export function isSensenovaConfig(config: ImageApiConfig): boolean {
  const haystack = (`${config.vendorName ?? ''} ${config.providerType ?? ''} `
    + `${config.model} ${config.baseUrl ?? ''}`).toLowerCase();
  return haystack.includes('sensenova') || haystack.includes('sense nova');
}

export function imageSizeForConfig(config: ImageApiConfig | null, aspectRatio: string): ImageSize {
  return config !== null && isSensenovaConfig(config)
    ? imageSizeForSensenova(aspectRatio)
    : imageSizeForAspectRatio(aspectRatio);
}

export function buildImageGenerationUrl(baseUrl: string): string {
  const trimmed = rustTrim(baseUrl).replace(/\/+$/, '');
  if (trimmed === '') throw new Error('Base URL 为空');
  try { new URL(trimmed); }
  catch { throw new Error('Base URL 无效'); }
  return trimmed.endsWith('/images/generations')
    ? trimmed
    : `${trimmed}/images/generations`;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

export function extractImageApiError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (error === undefined || error === null) return null;
  let message: unknown;
  if (typeof error === 'string') message = error;
  else if (typeof error === 'object' && !Array.isArray(error)) {
    message = (error as Record<string, unknown>).message;
  }
  if (typeof message !== 'string') return null;
  return message.toLowerCase().includes('policy')
    ? `图片生成被安全策略拒绝: ${message}`
    : message;
}

export function parseImageGenerationResponse(value: unknown): ParsedImageGenerationResponse {
  const error = extractImageApiError(value);
  if (error !== null) throw new Error(error);

  const data = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).data : undefined;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error('生图响应缺少 data[0]');
  }
  const record = first as Record<string, unknown>;
  const parsed: ParsedImageGenerationResponse = {
    b64_json: nonEmptyString(record.b64_json),
    url: nonEmptyString(record.url),
    revised_prompt: nonEmptyString(record.revised_prompt ?? record.revisedPrompt),
  };
  if (parsed.b64_json === null && parsed.url === null) {
    throw new Error('生图响应缺少 b64_json 或 url');
  }
  return parsed;
}

/** Data URL 的 payload 部分按 STANDARD base64 解码。 */
export function decodeBase64ImagePayload(payload: string): Uint8Array {
  const comma = payload.indexOf(',');
  const data = (comma >= 0 && payload.slice(0, comma).startsWith('data:')
    ? payload.slice(comma + 1)
    : payload).trim();
  try { return decodeBase64Standard(data); }
  catch (error) {
    const message = error instanceof Base64DecodeError ? error.message : String(error);
    throw new Error(`解析生图 base64 失败: ${message}`);
  }
}

export function looksLikeImageGenerationModel(config: ImageApiConfig): boolean {
  const haystack = `${config.name} ${config.model} ${config.providerType ?? ''}`.toLowerCase();
  return ['gpt-image', 'dall-e', 'image', 'imagen', 'flux'].some(needle => haystack.includes(needle));
}

export function isImageGenerationConfig(config: ImageApiConfig): boolean {
  return config.isImageGeneration === true || looksLikeImageGenerationModel(config);
}
