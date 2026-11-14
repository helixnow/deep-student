/**
 * `qbank_grading/pipeline.rs::guess_image_mime` 与 `image_answer.rs::fetch_image_answer_contents`。
 *
 * 图片作答信封只保存附件 ID；评判前必须把内容取回。任一附件缺失即显式报错，
 * 绝不静默降级为空白文本评判。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { AppError as AppErrorValue } from '../../../platform/errors/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { decodeBase64Standard } from '../../../platform/util/portable.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { QuestionImage, QuestionMaterial } from '../api.ts';
import type { GradingImage } from './grading-context.ts';
import { estimatedDecodedLen, type ImageAnswerPayload } from './image-answer.ts';

const IMAGE_ANSWER_MAX_DECODED_BYTES = 50 * 1024 * 1024;
const IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES = 100 * 1024 * 1024;

/** 与 `essay_grading::guess_image_mime` 同语义：data URI 声明优先，否则看魔数，兜底 JPEG。 */
export function guessImageMime(base64Data: string): string {
  if (base64Data.startsWith('data:')) {
    const declared = base64Data.slice(5).split(/[;,]/, 1)[0] ?? '';
    switch (declared) {
      case 'image/png': return 'image/png';
      case 'image/jpeg':
      case 'image/jpg': return 'image/jpeg';
      case 'image/webp': return 'image/webp';
      case 'image/gif': return 'image/gif';
      default: break;
    }
  }
  const comma = base64Data.indexOf(',');
  const payload = comma >= 0 && base64Data.slice(0, comma).startsWith('data:')
    ? base64Data.slice(comma + 1) : base64Data;
  const bytes = decodeBase64Standard(payload.slice(0, 24)).bytes;
  if (bytes === undefined) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(bytes, 'RIFF') && bytes.length >= 12 && startsWithAscii(bytes.subarray(8), 'WEBP')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function startsWithAscii(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) if (bytes[index] !== magic.charCodeAt(index)) return false;
  return true;
}

export interface ImageAnswerSourceHost {
  db: DatabaseHandle;
  blobsDir: string;
  vfsRepo: VfsReposService;
}

function validateImageSizes(images: string[]): void {
  let total = 0;
  for (const [index, image] of images.entries()) {
    const bytes = estimatedDecodedLen(image);
    if (bytes > IMAGE_ANSWER_MAX_DECODED_BYTES) {
      throw new AppErrorLike(AppError.validation(
        `答案图片第 ${index + 1} 张体积超限：约 ${(bytes / (1024 * 1024)).toFixed(1)}MB`
        + `（单张最大 ${IMAGE_ANSWER_MAX_DECODED_BYTES / (1024 * 1024)}MB），请压缩后重新上传`));
    }
    total += bytes;
  }
  if (total > IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES) {
    throw new AppErrorLike(AppError.validation(
      `答案图片总体积超限：约 ${(total / (1024 * 1024)).toFixed(1)}MB`
      + `（合计最大 ${IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES / (1024 * 1024)}MB），请减少图片数量或压缩后重试`));
  }
}

/** 服务层错误包装，让上层 `withDatabase` 原样透传 AppError。 */
export class AppErrorLike extends Error {
  readonly appError: AppErrorValue;
  constructor(appError: AppErrorValue) {
    super(appError.message);
    this.name = 'AppErrorLike';
    this.appError = appError;
  }
}

export function fetchImageAnswerContents(
  host: ImageAnswerSourceHost, payload: ImageAnswerPayload,
): string[] {
  const contents: string[] = [];
  for (const image of payload.images) {
    let content: string | null;
    try {
      content = host.vfsRepo.attachments.getContentBounded(
        host.db, host.blobsDir, image.id, IMAGE_ANSWER_MAX_DECODED_BYTES);
    } catch (error) {
      throw new AppErrorLike(AppError.database(
        `读取答案图片失败（附件 ${image.id}）：${error instanceof Error ? error.message : String(error)}`));
    }
    if (content === null) {
      throw new AppErrorLike(AppError.not_found(
        `答案图片不存在或尚未同步到本机（附件 ${image.id}），无法评判。请重新上传该图片。`));
    }
    contents.push(content);
  }
  validateImageSizes(contents);
  return contents;
}

function materialLabel(material: QuestionMaterial): string {
  const trimmed = material.content.trim();
  return trimmed === '' ? material.id : [...trimmed].slice(0, 20).join('');
}

function imageRoleLabel(image: QuestionImage): string {
  const role = image.role?.trim();
  switch (role) {
    case 'material': return '材料配图';
    case 'option': return '选项配图';
    case 'answer': return '答案区配图';
    case 'question': return '题干配图';
    default:
      return role === undefined || role === '' ? '题干配图' : `配图（${role}）`;
  }
}

/** `context.rs:260 fetch_context_images`：材料图在前、题干图在后；缺图显式报错。 */
export function fetchContextImages(
  host: ImageAnswerSourceHost, materials: readonly QuestionMaterial[],
  questionImages: readonly QuestionImage[],
): GradingImage[] {
  const refs: Array<[string, QuestionImage]> = [];
  for (const material of materials) {
    const label = materialLabel(material);
    for (const image of material.images) refs.push([`材料「${label}」配图`, image]);
  }
  for (const image of questionImages) refs.push([imageRoleLabel(image), image]);

  const images: GradingImage[] = [];
  for (const [label, image] of refs) {
    let base64: string | null;
    try {
      base64 = host.vfsRepo.attachments.getContentBounded(
        host.db, host.blobsDir, image.id, IMAGE_ANSWER_MAX_DECODED_BYTES);
    } catch (error) {
      throw new AppErrorLike(AppError.database(
        `读取题目/材料配图失败（附件 ${image.id}）：${error instanceof Error ? error.message : String(error)}`));
    }
    if (base64 === null) {
      throw new AppErrorLike(AppError.not_found(
        `题目/材料配图缺失或尚未同步到本机（${image.name}，附件 ${image.id}），无法判分。请重新上传该图片或补齐材料。`));
    }
    images.push({
      base64,
      mime: image.mime.trim() === '' ? 'image/jpeg' : image.mime,
      label,
    });
  }
  return images;
}
