/**
 * 图片作答信封（image_answer）解析与体积校验（qbank_grading/image_answer.rs）。
 *
 * `user_answer = {"type":"image_answer","images":[{id,name,mime,hash}],"text":…}`。
 * 信封非法时返回 null，调用方按原文本作答处理；体积超限显式报错，绝不静默丢图。
 */
export const IMAGE_ANSWER_MIME_TYPES: readonly string[] =
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const IMAGE_ANSWER_MAX_IMAGES = 6;
export const IMAGE_ANSWER_MAX_DECODED_BYTES = 50 * 1024 * 1024;
export const IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES = 100 * 1024 * 1024;

export class ImageAnswerValidation extends Error {}

export interface ImageAnswerImage { id: string; name: string; mime: string; hash: string }
export interface ImageAnswerPayload { images: ImageAnswerImage[]; text: string }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function image(value: unknown): ImageAnswerImage | null {
  const entry = object(value);
  if (entry === null) return null;
  const { id, name, mime, hash } = entry;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof mime !== 'string'
    || typeof hash !== 'string') return null;
  if (id.trim() === '' || !IMAGE_ANSWER_MIME_TYPES.includes(mime)) return null;
  return { id, name, mime, hash };
}

export function parseImageAnswerEnvelope(raw: string): ImageAnswerPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  const shape = object(parsed);
  if (shape === null || shape.type !== 'image_answer' || !Array.isArray(shape.images)) return null;
  if (shape.images.length === 0 || shape.images.length > IMAGE_ANSWER_MAX_IMAGES) return null;
  const images: ImageAnswerImage[] = [];
  for (const rawEntry of shape.images) {
    const entry = image(rawEntry);
    if (entry === null) return null;
    images.push(entry);
  }
  let text = '';
  if (shape.text !== undefined) {
    if (shape.text === null) text = '';
    else if (typeof shape.text === 'string') text = shape.text;
    else return null;
  }
  return { images, text };
}

export function estimatedDecodedLen(base64Data: string): number {
  const payload = base64Data.includes(',') && base64Data.slice(0, base64Data.indexOf(','))
    .startsWith('data:') ? base64Data.slice(base64Data.indexOf(',') + 1) : base64Data;
  return Math.floor(payload.trim().length * 3 / 4);
}

export function validateImageSizes(images: string[]): void {
  let total = 0;
  for (const [index, image] of images.entries()) {
    const bytes = estimatedDecodedLen(image);
    if (bytes > IMAGE_ANSWER_MAX_DECODED_BYTES) {
      throw new ImageAnswerValidation(
        `答案图片第 ${index + 1} 张体积超限：约 ${(bytes / (1024 * 1024)).toFixed(1)}MB`
        + `（单张最大 ${IMAGE_ANSWER_MAX_DECODED_BYTES / (1024 * 1024)}MB），请压缩后重新上传`);
    }
    total += bytes;
  }
  if (total > IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES) {
    throw new ImageAnswerValidation(
      `答案图片总体积超限：约 ${(total / (1024 * 1024)).toFixed(1)}MB`
      + `（合计最大 ${IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES / (1024 * 1024)}MB），请减少图片数量或压缩后重试`);
  }
}
