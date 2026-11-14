/**
 * `qbank_practice/export_bridge.rs`：前端导出试卷的请求/完成桥。
 *
 * Rust 用 `tauri::Window::emit("qbank-export-paper", ExportRequest)` 通知前端生成文件，
 * 前端完成后调用 `qbank_complete_paper_export` 把 base64 交回；Host 用同样的全局事件
 * （`ctx.backendEvents.emit`）与单次等待者表实现，120 秒超时、错误文案逐字一致。
 */
import { fromBase64, toBase64 } from '../../../platform/crypto/encoding.ts';
import * as path from '../../../platform/util/path.ts';
import type { GeneratedPaper } from '../api.ts';
import { qbankLocalRuntime } from './local-runtime.ts';

export interface PaperExportRequest {
  request_id: string;
  paper: GeneratedPaper;
  format: string;
  include_answers: boolean;
  include_explanations: boolean;
}

interface PendingExport {
  title: string;
  format: string;
  resolve: (result: { ok: true; value: string } | { ok: false; error: string }) => void;
}

export interface PaperExportHost {
  exportDir: string;
  emit(event: string, payload: unknown): void;
  log: { warn(message: string): void; info(message: string): void };
}

export class PaperExportBridge {
  private readonly pending = new Map<string, PendingExport>();

  async exportForTool(
    host: PaperExportHost,
    paper: GeneratedPaper,
    format: string,
    includeAnswers: boolean,
    includeExplanations: boolean,
  ): Promise<string> {
    const settled = await this.exportForToolResult(host, paper, format, includeAnswers, includeExplanations);
    return settled.ok ? settled.value : settled.error;
  }

  /** `export_for_tool` with Rust's `Result<String, String>` kept apart. */
  async exportForToolResult(
    host: PaperExportHost,
    paper: GeneratedPaper,
    format: string,
    includeAnswers: boolean,
    includeExplanations: boolean,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const requestId = crypto.randomUUID();
    const result = new Promise<{ ok: true; value: string } | { ok: false; error: string }>(resolve => {
      this.pending.set(requestId, { title: paper.title, format, resolve });
    });
    try {
      host.emit('qbank-export-paper', {
        request_id: requestId,
        paper,
        format,
        include_answers: includeAnswers,
        include_explanations: includeExplanations,
      });
    } catch (error) {
      this.pending.delete(requestId);
      return { ok: false, error: `Paper export surface unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ ok: false; error: string }>(resolve => {
      timer = setTimeout(
        () => resolve({ ok: false, error: 'Paper export timed out; no file was reported as created' }),
        120_000,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([result, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }

  /** `qbank_complete_paper_export`。返回 `null`（命令结果为 unit）。 */
  async complete(
    host: PaperExportHost, requestId: string, data: string | null, error: string | null,
  ): Promise<null> {
    const pending = this.pending.get(requestId);
    if (pending === undefined) throw new PaperExportExpiredError();
    this.pending.delete(requestId);
    const result = await this.writeResult(host, pending, requestId, data, error);
    pending.resolve(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error });
    return null;
  }

  private async writeResult(
    host: PaperExportHost, pending: PendingExport, requestId: string,
    data: string | null, error: string | null,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    try {
      if (error !== null) return { ok: false, error };
      const bytes = decodeBase64(data ?? '');
      if (bytes === null) return { ok: false, error: 'Invalid base64' };
      const extension = detectExtension(pending.format, bytes);
      if (extension === null) return { ok: false, error: 'Invalid generated paper file' };
      const title = sanitizeTitle(pending.title);
      const directory = path.join(host.exportDir, 'exports', 'qbank');
      await qbankLocalRuntime().mkdirpAsync(directory);
      const target = path.join(directory, `${title}-${requestId}.${extension}`);
      const temp = path.join(directory, `${title}-${requestId}.tmp`);
      await qbankLocalRuntime().writeFileAsync(temp, bytes);
      await qbankLocalRuntime().renameAsync(temp, target);
      return { ok: true, value: target };
    } catch (failure) {
      host.log.warn(`[qbank-export] 写入导出文件失败: ${failure instanceof Error ? failure.message : String(failure)}`);
      return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
    }
  }
}

export class PaperExportExpiredError extends Error {
  constructor() { super('Export request expired'); this.name = 'PaperExportExpiredError'; }
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0) return new Uint8Array();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  if (value.length % 4 !== 0) return null;
  const buffer = fromBase64(value);
  // base64 crate STANDARD rejects non-canonical padding/trailing bits; compare the
  // canonical re-encoding so junk such as "AB==" cannot silently decode.
  if (toBase64(buffer) !== value) return null;
  return buffer;
}

function detectExtension(format: string, bytes: Uint8Array): string | null {
  if (format === 'pdf' && startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (format === 'word' && startsWith(bytes, [0x50, 0x4b])) return 'docx';
  if (format === 'markdown' && bytes.length > 0) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return 'md';
    } catch {
      return null;
    }
  }
  return null;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function sanitizeTitle(title: string): string {
  let result = '';
  for (const char of title) {
    if (result.length >= 80) break;
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || '\\/:*?"<>|'.includes(char)) {
      result += '_';
    } else {
      result += char;
    }
  }
  return result;
}
