import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from '../../../platform/util/path.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';

/**
 * Rust `AppState` session maps (src/commands.rs:699-709). The upload-driven
 * session (`init_pdf_ocr_session`) and backend session (`start_pdf_ocr_backend`) that
 * populate these maps require pdfium plus L02's OCR model configuration.
 * The control commands operate on the exact same map semantics.
 */
export class PdfOcrControlState {
  cancellations = new Map<string, { send(value: boolean): void }>();
  pauses = new Map<string, { send(value: boolean): void }>();
  skipPages = new Map<string, Set<number>>();

  cancel(sessionId: string): boolean {
    const sender = this.cancellations.get(sessionId);
    if (sender === undefined) return false;
    this.cancellations.delete(sessionId);
    sender.send(true);
    return true;
  }

  pause(sessionId: string): boolean {
    const sender = this.pauses.get(sessionId);
    if (sender === undefined) return false;
    sender.send(true);
    return true;
  }

  resume(sessionId: string): boolean {
    const sender = this.pauses.get(sessionId);
    if (sender === undefined) return false;
    sender.send(false);
    return true;
  }

  skip(sessionId: string, pageIndex: number): boolean {
    let set = this.skipPages.get(sessionId);
    if (set === undefined) { set = new Set(); this.skipPages.set(sessionId, set); }
    set.add(pageIndex);
    return true;
  }
}

/** `tempAppDataDir` is F3 `getTempAppDataDir()`, not the base data dir. */
export function pdfOcrTempDir(tempAppDataDir: string): string {
  return join(tempAppDataDir, 'pdf_ocr_temp');
}

export async function getPdfOcrTempDir(tempAppDataDir: string): Promise<string> {
  const dir = pdfOcrTempDir(tempAppDataDir);
  try { await mkdir(dir, { recursive: true }); }
  catch (error) { throw new CommandError(AppError.file_system(`创建临时目录失败: ${(error as Error).message}`)); }
  return dir;
}

export async function savePdfToTemp(tempAppDataDir: string, pdfBase64: string, fileName: string): Promise<string> {
  const dir = pdfOcrTempDir(tempAppDataDir);
  try { await mkdir(dir, { recursive: true }); }
  catch (error) { throw new CommandError(AppError.file_system(`创建临时目录失败: ${(error as Error).message}`)); }

  const comma = pdfBase64.indexOf(',');
  const data = pdfBase64.startsWith('data:') && comma >= 0 ? pdfBase64.slice(comma + 1) : pdfBase64;
  let bytes: Uint8Array;
  try { bytes = decodeBase64Standard(data); }
  catch (error) {
    const message = error instanceof Base64DecodeError ? error.message : String(error);
    throw new CommandError(AppError.validation(`Base64 解码失败: ${message}`));
  }
  const filePath = join(dir, `${randomUUID()}_${fileName}`);
  try { await writeFile(filePath, bytes); }
  catch (error) { throw new CommandError(AppError.file_system(`保存 PDF 文件失败: ${(error as Error).message}`)); }
  return filePath;
}

export function pdfHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
