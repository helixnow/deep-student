/** File, image and document-parsing commands (`src/commands.rs`, `crates/dstu-media/src/cmd/media.rs`). */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError, isAppErrorValue } from '../../../platform/errors/api.ts';
import type { NativeHeic } from '../../../platform/native/heic/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { DocsService } from '../api.ts';
import { CompressImageError, compressImage } from './compress-image.ts';
import { parseDocumentFromBase64, parseDocumentFromPath } from './document-commands.ts';
import { recentDocumentTasks } from './document-tasks.ts';
import { ImageBase64Error, getImageAsBase64 } from './image-base64.ts';
import { testPdfiumStatus } from './pdfium-status.ts';
import type { MediaPluginDeps } from './plugin-deps.ts';
import { VfsBlobPathError, getFileBlobPath } from './vfs-blob-path.ts';

export interface FileCommandDeps {
  docs: DocsService;
  plugin: MediaPluginDeps;
}

export function registerFileCommands(ctx: Context, { docs, plugin }: FileCommandDeps): void {
  ctx.commands.register<Commands['vfs_get_file_blob_path']['args'], string | null>('vfs_get_file_blob_path',
    ({ id }) => {
      try { return getFileBlobPath(ctx.get('vfsDatabase') as VfsDatabase | undefined, id); }
      catch (error) {
        if (error instanceof VfsBlobPathError) throw new CommandError(error.appError);
        throw error;
      }
    });
  ctx.commands.register<Commands['get_image_as_base64']['args'], string>('get_image_as_base64',
    async ({ relativePath }) => {
      try { return await getImageAsBase64(ctx.paths.appDataDir, relativePath); }
      catch (error) {
        if (error instanceof ImageBase64Error) throw new CommandError(error.appError);
        throw error;
      }
    });
  /**
   * `heic_decoder.rs::convert_heic_to_jpeg` (78-140): raw IPC body in, raw JPEG
   * out on Android. The Electron Host is desktop-only, so F7 `nativeHeic`
   * validates the body and preserves Rust's `HEIC_UNSUPPORTED_PLATFORM` error;
   * libheif must not turn this into a desktop success path.
   */
  ctx.commands.register<Commands['convert_heic_to_jpeg']['args'],
    Commands['convert_heic_to_jpeg']['result']>('convert_heic_to_jpeg',
    (_args, call) => {
      const service = ctx.get('nativeHeic') as NativeHeic | undefined;
      if (service === undefined) {
        throw new CommandError(AppError.configuration(
          'HEIC 原生解码服务未提供：需要 F7 nativeHeic'));
      }
      try { return service.convertToJpeg(call.payload); }
      catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(AppError.unknown(
          error instanceof Error ? error.message : String(error)));
      }
    });
  ctx.commands.register<Commands['get_recent_document_tasks']['args'],
    Commands['get_recent_document_tasks']['result']>('get_recent_document_tasks',
    ({ limit }) => {
      try { return recentDocumentTasks(ctx.storage.database('mistakes'), limit ?? 20); }
      catch (error) {
        throw new CommandError(AppError.database(
          `获取最近文档任务失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  ctx.commands.register<Commands['test_pdfium_status']['args'],
    Commands['test_pdfium_status']['result']>('test_pdfium_status',
    () => testPdfiumStatus(
      (ctx.get('nativePdfium') as NativePdfium | undefined) ?? null,
      process.execPath));
  // crates/dstu-media/src/cmd/media.rs:54-149: Result<_, String> → plain string errors.
  ctx.commands.register<Commands['compress_image']['args'],
    Commands['compress_image']['result']>('compress_image', async args => {
      try { return await compressImage(plugin.nativeImage, args); }
      catch (error) {
        if (error instanceof CompressImageError) throw new CommandError(error.message);
        if (error instanceof CommandError && isAppErrorValue(error.value)) throw new CommandError(error.value.message);
        throw error;
      }
    });
  // src/commands.rs:4093-4148: string errors, info/debug/error logs (spawn_blocking → async docs service).
  const documentLog = ctx.logger('media.docs');
  ctx.commands.register<Commands['parse_document_from_path']['args'], string>('parse_document_from_path',
    ({ filePath }) => parseDocumentFromPath(docs, filePath, documentLog));
  ctx.commands.register<Commands['parse_document_from_base64']['args'], string>('parse_document_from_base64',
    ({ fileName, base64Content }) => parseDocumentFromBase64(docs, fileName, base64Content, documentLog));
}
