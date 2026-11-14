/**
 * `src/commands.rs::qbank_crop_source_image`：从源图片裁剪区域，保存为新 blob，
 * 追加到题目的 images。
 *
 * Rust 语义：blob 路径查询 → 读取文件 → `image` 解码为 RGBA8 → 相对坐标裁剪
 * （四舍五入、边界收敛）→ PNG 编码 → 存 blob → 建 VFS 文件 → 读题目追加图片
 * → 更新题目。错误文案逐条保持 Rust 原文。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { QbankLogger } from './ports.ts';
import type { QuestionImage, VfsReposService } from '../../vfs-repos/api.ts';
import { QbankServiceError } from './question-service.ts';
import type { CropImageCodec } from './native-image.ts';

export interface CropSourceImageRequest {
  question_id: string;
  blob_hash: string;
  crop_x: number;
  crop_y: number;
  crop_width: number;
  crop_height: number;
}

export interface CropSourceImageHost {
  readonly db: DatabaseHandle;
  readonly blobsDir: string;
  readonly repos: VfsReposService;
  /** F7 `nativeImage` 的 crop/encode 能力；main 未合入时由命令层显式报配置错误。 */
  readonly nativeImage: CropImageCodec | null;
  /** `ctx.files`（桌面与移动端 profile 都装配）；`FileError.message` 即 Rust io::Error 的 Display。 */
  readonly files: Pick<FilesService, 'readBytes'> | null;
  readonly log?: QbankLogger;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}

function configuration(message: string): never {
  throw new QbankServiceError(AppError.configuration(message));
}

function database(message: string): never {
  throw new QbankServiceError(AppError.database(message));
}

function fileSystem(message: string): never {
  throw new QbankServiceError(AppError.file_system(message));
}

function notFound(message: string): never {
  throw new QbankServiceError(AppError.not_found(message));
}

export async function cropSourceImage(host: CropSourceImageHost,
  request: CropSourceImageRequest): Promise<QuestionImage> {
  const { db, repos } = host;

  let blobPath: string | null;
  try {
    blobPath = repos.blobs.getBlobPath(db, host.blobsDir, request.blob_hash);
  } catch (error) {
    database(`获取 Blob 路径失败: ${messageOf(error)}`);
  }
  if (blobPath === null) notFound('源图片 Blob 不存在');

  const files = host.files;
  if (files === null) configuration('文件服务不可用: files 未提供');
  let imageData: Uint8Array;
  try {
    imageData = await files.readBytes(blobPath);
  } catch (error) {
    fileSystem(`读取源图片失败: ${messageOf(error)}`);
  }

  const imageCodec = host.nativeImage;
  if (imageCodec === null) {
    configuration('图片处理能力不可用: nativeImage.cropRgba/encode 未提供（需 F7 native 合入）');
  }

  let decoded: { width: number; height: number; rgba: Uint8Array };
  try {
    decoded = await imageCodec.decodeRgba(imageData);
  } catch (error) {
    validation(`图片解码失败: ${messageOf(error)}`);
  }
  if (decoded.width === 0 || decoded.height === 0) {
    validation('图片解码失败: The image dimensions could not be determined');
  }
  if (decoded.rgba.length < decoded.width * decoded.height * 4) {
    validation('图片解码失败: The image dimensions could not be determined');
  }

  const cropX = Math.min(Math.max(0, Math.round(request.crop_x * decoded.width)), decoded.width - 1);
  const cropY = Math.min(Math.max(0, Math.round(request.crop_y * decoded.height)), decoded.height - 1);
  const cropW = Math.min(Math.max(1, Math.round(request.crop_width * decoded.width)), decoded.width - cropX);
  const cropH = Math.min(Math.max(1, Math.round(request.crop_height * decoded.height)), decoded.height - cropY);

  let png: Uint8Array;
  try {
    const cropped = imageCodec.cropRgba(decoded, { x: cropX, y: cropY, width: cropW, height: cropH });
    png = await imageCodec.encode(cropped, { format: 'png' });
  } catch (error) {
    validation(`裁剪图片编码失败: ${messageOf(error)}`);
  }

  let blob: ReturnType<VfsReposService['blobs']['storeBlob']>;
  try {
    blob = repos.blobs.storeBlob(db, host.blobsDir, png, 'image/png', 'png');
  } catch (error) {
    database(`保存裁剪图片失败: ${messageOf(error)}`);
  }

  const fileName = `crop_${blob.hash.slice(0, 8)}.png`;
  let file: ReturnType<VfsReposService['files']['createFile']>;
  try {
    file = repos.files.createFile(db, blob.hash, fileName, png.length, 'image',
      'image/png', blob.hash, null);
  } catch (error) {
    database(`创建 VFS 文件条目失败: ${messageOf(error)}`);
  }

  const questionImage: QuestionImage = {
    id: file.id,
    name: fileName,
    mime: 'image/png',
    hash: blob.hash,
    role: 'question',
  };

  let images: QuestionImage[];
  try {
    const question = repos.questions.getQuestion(db, request.question_id);
    if (question === null) notFound('题目不存在');
    images = [...question.images, questionImage];
  } catch (error) {
    if (error instanceof QbankServiceError) throw error;
    database(`获取题目失败: ${messageOf(error)}`);
  }

  try {
    repos.questions.updateQuestion(db, request.question_id, { images });
  } catch (error) {
    database(`更新题目图片失败: ${messageOf(error)}`);
  }

  host.log?.info?.(`[QBank] 裁剪图片已添加到题目 ${request.question_id}: `
    + `file_id=${file.id}, blob=${blob.hash}`);
  return questionImage;
}
