/**
 * 诊断包的 CPU 密集部分：日志脱敏与 ZIP 压缩（Rust `diagnostics.rs` 在 `spawn_blocking` 中执行）。
 * 只在 `diagnostics-worker.ts` 的 worker 线程里调用，不阻塞 Host 事件循环。
 */
import { writeZip, type ZipInputEntry } from '../util/node.ts';
import { ioMessage } from '../paths/compat.ts';
import { sanitizeDiagnosticMessageWithPlatform, sanitizeLogTextWithPlatform } from './diagnostics-sanitize-core.ts';

/** Retain error codes and operation labels; strip local paths even outside a home directory. */
export function sanitizeDiagnosticMessage(value: string): string {
  return sanitizeDiagnosticMessageWithPlatform(value, process.platform);
}

export function sanitizeLogText(input: string, detailed: boolean): string {
  return sanitizeLogTextWithPlatform(input, detailed, process.platform);
}

export interface DiagnosticsZipInput {
  readonly files: readonly { readonly name: string; readonly text: string }[];
  readonly manifestJson: string;
  readonly detailed: boolean;
}

/** 与原同步实现相同的错误前缀：脱敏失败 → `写入诊断包失败`，压缩失败 → `完成诊断包失败`。 */
export function buildDiagnosticsZip(input: DiagnosticsZipInput): Buffer {
  const zipOptions = { compression: 'deflated' as const, unixPermissions: 0o600 };
  const entries: ZipInputEntry[] = [];
  for (const file of input.files) {
    try { entries.push({ name: file.name, data: sanitizeLogText(file.text, input.detailed), options: zipOptions }); }
    catch (error) { throw new Error(`写入诊断包失败: ${ioMessage(error)}`); }
  }
  entries.push({ name: 'manifest.json', data: input.manifestJson, options: zipOptions });
  try { return writeZip(entries); }
  catch (error) { throw new Error(`完成诊断包失败: ${ioMessage(error)}`); }
}
