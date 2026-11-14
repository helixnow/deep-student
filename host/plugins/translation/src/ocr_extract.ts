/** src/cmd/translation.rs:90–127; pending the complete file-based OCR runtime. */
import { join } from '../../../platform/util/path.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { ioMessageFor } from '../../../platform/paths/io-error.ts';
import { decodeBase64ImagePayload, type StandardBase64Decoder } from './ocr_payload.ts';

/** `ctx.files` 中 OCR 临时文件与可写目录探测用到的操作。 */
export type OcrFiles = Pick<FilesService, 'mkdir' | 'writeBytes' | 'rm'>;

/** Rust `io::Error` Display：`ctx.files` 的 `FileError` 保留底层 Node 错误（`cause`），按它复刻文案。 */
function ioText(error: unknown, platform: string): string {
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  return ioMessageFor(cause ?? error, platform);
}

export interface OcrExtractRuntime {
  /** `ctx.app.platform`: selects Rust's `io::Error` text (`<strerror> (os error N)` off win32) for file-system failures. */
  readonly platform: string;
  /** `ctx.files`; resolved only when a base64 payload needs a temporary file. */
  files(): OcrFiles;
  /** `get_writable_app_data_dir` for temporary data: the OCR temp file is regenerable, so the fallback chain is allowed. */
  getTempAppDataDir(): string | Promise<string>;
  decodeBase64Standard: StandardBase64Decoder;
  callOcrFreeTextWithFallback(imagePath: string): Promise<string>;
}

export async function ocrExtractText(runtime: OcrExtractRuntime, imagePath: string | null, imageBase64: string | null): Promise<string> {
  if (imagePath === null && imageBase64 === null) throw AppError.validation('必须提供image_path或image_base64');
  let path: string, temporary = false;
  if (imageBase64 !== null) {
    const directory = join(await runtime.getTempAppDataDir(), 'temp');
    try { await runtime.files().mkdir(directory, { recursive: true }); }
    catch (error) { throw AppError.file_system(`文件系统错误: ${ioText(error, runtime.platform)}`); }
    // mkdir intentionally precedes decoding; invalid payloads still create temp/.
    const { bytes, extension } = decodeBase64ImagePayload(imageBase64, runtime.decodeBase64Standard);
    path = join(directory, `ocr_temp_${globalThis.crypto.randomUUID()}.${extension}`);
    try { await runtime.files().writeBytes(path, bytes); }
    catch (error) { throw AppError.file_system(`文件系统错误: ${ioText(error, runtime.platform)}`); }
    temporary = true;
  } else path = imagePath!;
  try { return await runtime.callOcrFreeTextWithFallback(path); }
  finally {
    if (temporary) {
      try { await runtime.files().rm(path); }
      catch { // boundary-allow empty-catch: translation.rs:15 TempFileGuard::drop deliberately ignores remove_file errors
      }
    }
  }
}

/** dstu-storage file_manager.rs:167 `FileManager::get_writable_app_data_dir` (F3 `getTempAppDataDir`), used only when F3
 * has not published `fileManagerPaths`: primary data dir, then `dirs::data_dir()/DeepStudent`, then
 * `temp/deep_student_data` (warn when even that is not writable). The `dirs::data_dir()/DeepStudent` candidate is
 * outside the standard file roots, so it is granted for the probe (it is derived from OS dirs, not from input). */
export async function writableAppDataDir(files: OcrFiles & Pick<FilesService, 'grant'>, primary: string, osDataDir: string | null,
  log: { error(message: string): void; warn(message: string): void }, platform: string, tempDir: string): Promise<string> {
  const ensureWritable = async (dir: string): Promise<boolean> => {
    try { await files.mkdir(dir, { recursive: true }); }
    catch (error) { log.error(`⚠️ [文件系统] 创建目录失败 ${dir}: ${ioText(error, platform)}`); return false; }
    const probe = join(dir, '.write_test');
    try { await files.writeBytes(probe, new TextEncoder().encode('ok')); }
    catch (error) {
      log.error(`⚠️ [文件系统] 目录不可写 ${dir}: ${ioText(error, platform)}`);
      try { await files.rm(probe); } catch { /* boundary-allow empty-catch: Rust `let _ = remove_file` */ }
      return false;
    }
    try { await files.rm(probe); } catch { /* boundary-allow empty-catch: Rust `let _ = remove_file` */ }
    return true;
  };
  if (await ensureWritable(primary)) return primary;
  if (osDataDir !== null) {
    const candidate = join(osDataDir, 'DeepStudent');
    let grant: { revoke(): void } | null = null;
    try { grant = files.grant(candidate); } catch { /* boundary-allow empty-catch: no grant (mobile) → the probe reports the error */ }
    // The chosen fallback stays granted: later OCR temp files are written below it.
    if (await ensureWritable(candidate)) return candidate;
    grant?.revoke();
  }
  const temporary = join(tempDir, 'deep_student_data');
  if (!(await ensureWritable(temporary))) log.warn(`⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 ${temporary}`);
  return temporary;
}
