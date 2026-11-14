/**
 * `dstu-vision/src/figure_extractor.rs` — Stage 4: 按 VLM bbox 从页面图片裁切配图，
 * 存为 VFS Blob + 文件并生成 `QuestionImage`；以及 `page_rasterizer.rs:443 load_page_image_bytes`。
 *
 * 裁切/尺寸走 F7 `nativeImage`（`cropFigure` = `VlmGroundingService::crop_figure_from_page`），
 * blob/文件写入走 L11 `vfsRepo.blobs.storeBlob` / `vfsRepo.files.createFile`。
 * Rust 的 `extract_figures` 不返回错误：每张配图的失败只记日志并跳过。
 */
import fs from 'node:fs';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { QuestionImage, VfsReposService } from '../../vfs-repos/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { MergedQuestion, PageSlice, QuestionWithFigures } from '../api.ts';

export const MIN_FIGURE_SIZE = 30;

export type { QuestionWithFigures };

export interface FigureStoreDeps {
  conn(): SqlExecutor;
  blobsDir(): string;
  repos(): Pick<VfsReposService, 'blobs' | 'files'>;
}

export interface FigureExtractorDeps extends FigureStoreDeps {
  image(): NativeImage;
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void };
}

const messageOf = (error: unknown): string => {
  if (error instanceof CommandError) return (error.value as { message?: string }).message ?? String(error);
  if (error !== null && typeof error === 'object' && 'error_type' in error && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : String(error);
};

/** `page_rasterizer::load_page_image_bytes`. Errors: `CommandError(AppError)`. */
export function loadPageImageBytes(deps: FigureStoreDeps, blobHash: string): Uint8Array {
  let blobPath: string | null;
  try { blobPath = deps.repos().blobs.getBlobPath(deps.conn(), deps.blobsDir(), blobHash); }
  catch (error) { throw new CommandError(AppError.database(`查询 blob 路径失败: ${messageOf(error)}`)); }
  if (blobPath === null) throw new CommandError(AppError.not_found(`页面图片 blob 不存在: ${blobHash}`));
  try { return fs.readFileSync(blobPath); }
  catch (error) { throw new CommandError(AppError.file_system(`读取页面图片失败: ${messageOf(error)}`)); }
}

/** `sanitize_label`: `char::is_alphanumeric() || '_'`，最多 20 个字符。 */
export function sanitizeLabel(label: string): string {
  return Array.from(label).filter(c => /^[\p{Alphabetic}\p{N}_]$/u.test(c)).slice(0, 20).join('');
}

/** `store_figure`. */
function storeFigure(deps: FigureStoreDeps, imageBytes: Uint8Array, figLabel: string, pageIdx: number): QuestionImage {
  let hash: string;
  try {
    hash = deps.repos().blobs.storeBlob(deps.conn(), deps.blobsDir(), imageBytes, 'image/png', 'png').hash;
  } catch (error) { throw new CommandError(AppError.database(`配图 Blob 存储失败: ${messageOf(error)}`)); }

  const fileName = `fig_p${pageIdx}_${sanitizeLabel(figLabel)}.png`;
  let fileId: string;
  try {
    fileId = deps.repos().files.createFile(deps.conn(), hash, fileName, imageBytes.length, 'image',
      'image/png', hash, null).id;
  } catch (error) { throw new CommandError(AppError.database(`创建配图 VFS 文件失败: ${messageOf(error)}`)); }

  return { id: fileId, name: fileName, mime: 'image/png', hash, role: 'question' };
}

/** `extract_figures`. */
export async function extractFigures(
  mergedQuestions: MergedQuestion[],
  pages: readonly PageSlice[],
  deps: FigureExtractorDeps,
): Promise<QuestionWithFigures[]> {
  const results: QuestionWithFigures[] = [];
  let totalExtracted = 0;
  let totalSkipped = 0;
  // 缓存已加载的页面图片；加载失败不入缓存（下一张同页配图会重试读取）。
  const pageImageCache = new Map<number, Uint8Array>();

  for (const mq of mergedQuestions) {
    const images: QuestionImage[] = [];
    for (const [pageIdx, figure] of mq.figures_with_page) {
      const page = pages[pageIdx];
      if (page === undefined) {
        deps.log.warn(`[FigureExtractor] 页面索引 ${pageIdx} 超出范围，跳过配图 '${figure.fig_label}'`);
        totalSkipped += 1;
        continue;
      }

      let pageBytes = pageImageCache.get(pageIdx);
      if (pageBytes === undefined) {
        try { pageBytes = loadPageImageBytes(deps, page.blob_hash); }
        catch (error) {
          deps.log.warn(`[FigureExtractor] 加载页面 ${pageIdx + 1} 图片失败: ${messageOf(error)}`);
          totalSkipped += 1;
          continue;
        }
        pageImageCache.set(pageIdx, pageBytes);
      }

      let croppedBytes: Uint8Array;
      try { croppedBytes = await deps.image().cropFigure(pageBytes, figure.bbox); }
      catch (error) {
        deps.log.debug(`[FigureExtractor] 裁切失败 (页面${pageIdx + 1}, '${figure.fig_label}'): ${messageOf(error)}`);
        totalSkipped += 1;
        continue;
      }

      // 仅读图片头获取尺寸；读取失败时不做尺寸过滤（Rust `.ok()`）。
      let dims: { width: number; height: number } | null = null;
      try { dims = await deps.image().dimensions(croppedBytes); } catch { dims = null; }
      if (dims !== null && (dims.width < MIN_FIGURE_SIZE || dims.height < MIN_FIGURE_SIZE)) {
        deps.log.debug(`[FigureExtractor] 配图太小 (${dims.width}x${dims.height})，跳过: '${figure.fig_label}'`);
        totalSkipped += 1;
        continue;
      }

      try {
        images.push(storeFigure(deps, croppedBytes, figure.fig_label, pageIdx));
        totalExtracted += 1;
      } catch (error) {
        deps.log.warn(`[FigureExtractor] 存储配图失败 (页面${pageIdx + 1}, '${figure.fig_label}'): ${messageOf(error)}`);
        totalSkipped += 1;
      }
    }
    results.push({ merged: mq, images });
  }

  deps.log.info(`[FigureExtractor] 完成: 提取 ${totalExtracted} 张配图, 跳过 ${totalSkipped} 张`);
  return results;
}
