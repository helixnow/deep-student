/**
 * `question_authoring_runner.rs::attach_figures` 与 `page_rasterizer.rs::load_page_image_bytes`。
 *
 * 配图按页图 bbox（归一化 0..1）裁剪 → PNG → 存 blob → 建 VFS 文件，写入题目/材料的
 * `images`；模型给出的任何资产身份一律丢弃。blob/文件写入走所有者 vfsRepo 公开方法，
 * 解码/裁剪/编码走 F7 nativeImage（与 qbank_crop_source_image 同一能力接缝）。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { QuestionImage, VfsReposService } from '../../vfs-repos/api.ts';
import type { CropImageCodec } from './native-image.ts';
import { QbankServiceError } from './question-service.ts';
import { rawJsonNumberAsNumber } from './raw-json-number.ts';
import { asU64, coverageKey, type SourceBundle, type SourcePage } from './source-bundle.ts';
import { qbankLocalRuntime } from './local-runtime.ts';

type JsonObject = { [key: string]: JsonValue };

export interface GenerationFiguresHost {
  readonly db: DatabaseHandle;
  readonly blobsDir: string;
  readonly repos: Pick<VfsReposService, 'blobs' | 'files'>;
  readonly nativeImage: CropImageCodec | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(value: ReturnType<typeof AppError.validation>): never {
  throw new QbankServiceError(value);
}

/** Rust `load_page_image_bytes`。 */
export function loadPageImageBytes(host: GenerationFiguresHost, blobHash: string): Uint8Array {
  let blobPath: string | null;
  try {
    blobPath = host.repos.blobs.getBlobPath(host.db, host.blobsDir, blobHash);
  } catch (error) {
    fail(AppError.database(`查询 blob 路径失败: ${messageOf(error)}`));
  }
  if (blobPath === null) fail(AppError.not_found(`页面图片 blob 不存在: ${blobHash}`));
  try {
    return qbankLocalRuntime().readFile(blobPath);
  } catch (error) {
    fail(AppError.file_system(`读取页面图片失败: ${messageOf(error)}`));
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rust `attach_figures`。 */
export async function attachFigures(host: GenerationFiguresHost, raw: JsonObject, bundle: SourceBundle): Promise<void> {
  const pages = new Map<string, SourcePage>();
  for (const page of bundle.pages) pages.set(coverageKey(page.source_id, page.page), page);
  for (const field of ['questions', 'materials'] as const) {
    const items = raw[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isObject(item)) continue;
      // 不接受模型生成的资产身份。
      item.images = [];
      const images: QuestionImage[] = [];
      const figures = Array.isArray(item.figures) ? item.figures : [];
      for (const fig of figures) {
        const id = isObject(fig) && typeof fig.source_id === 'string' ? fig.source_id : '';
        const page = (isObject(fig) ? asU64(fig.page) : null) ?? 0;
        const source = pages.get(coverageKey(id, page));
        if (source === undefined) fail(AppError.validation('配图引用了无效源页'));
        const rawBbox = isObject(fig) ? fig.bbox : undefined;
        if (!Array.isArray(rawBbox)) fail(AppError.validation('配图缺少bbox'));
        // bbox 是真正需要 number 的业务边界：Value 持久化的 raw atom 在此读取数值，
        // 不把 atom 当普通对象拒绝，也不改变 generic Value 的原始 token。
        const bbox = rawBbox.map(value => typeof value === 'number' ? value : rawJsonNumberAsNumber(value) ?? Number.NaN);
        if (bbox.length !== 4 || bbox.some(x => !Number.isFinite(x) || x < 0 || x > 1)
          || bbox[0]! >= bbox[2]! || bbox[1]! >= bbox[3]!) {
          fail(AppError.validation('配图bbox无效，未忽略必要配图'));
        }
        const bytes = loadPageImageBytes(host, source.blob_hash);
        const codec = host.nativeImage;
        if (codec === null) {
          fail(AppError.configuration('图片处理能力不可用: nativeImage.cropRgba/encode 未提供（需 F7 native 合入）'));
        }
        let decoded: Awaited<ReturnType<CropImageCodec['decodeRgba']>>;
        try {
          decoded = await codec.decodeRgba(bytes);
        } catch (error) {
          fail(AppError.validation(messageOf(error)));
        }
        const w = decoded.width;
        const h = decoded.height;
        const x = Math.floor(bbox[0]! * w);
        const y = Math.floor(bbox[1]! * h);
        const right = Math.min(Math.ceil(bbox[2]! * w), w);
        const bottom = Math.min(Math.ceil(bbox[3]! * h), h);
        let png: Uint8Array;
        try {
          png = await codec.encode(codec.cropRgba(decoded, { x, y, width: right - x, height: bottom - y }),
            { format: 'png' });
        } catch (error) {
          fail(AppError.file_system(messageOf(error)));
        }
        let blob: ReturnType<VfsReposService['blobs']['storeBlob']>;
        try {
          blob = host.repos.blobs.storeBlob(host.db, host.blobsDir, png, 'image/png', 'png');
        } catch (error) {
          fail(AppError.database(messageOf(error)));
        }
        const localId = typeof item.local_id === 'string' ? item.local_id : 'question';
        const name = `figure_${localId}_p${page}.png`;
        let file: ReturnType<VfsReposService['files']['createFile']>;
        try {
          file = host.repos.files.createFile(host.db, blob.hash, name, png.length, 'image', 'image/png', blob.hash, null);
        } catch (error) {
          fail(AppError.database(messageOf(error)));
        }
        images.push({
          id: file.id, name, mime: 'image/png', hash: blob.hash,
          role: field === 'materials' ? 'material' : isObject(fig) && fig.role === 'option' ? 'option' : 'question',
        });
      }
      item.images = images as unknown as JsonValue;
    }
  }
}
